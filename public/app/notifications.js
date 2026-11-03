import { attachSwipeDismiss } from "../swipe-dismiss.js?v=1.4.27";

// Opening the pane a notification names, from a tap on the notification, a
// message from the service worker, another window, or the in-app alert shown
// while the page is in front. `state` is the page's own object; `refreshSnapshot`
// and `shownGrid` are called through, so they may be defined after this is made.
export function createNotifications({ state, refreshSnapshot, shownGrid }) {
  let pendingNotificationPaneId = null;
  let pendingNotificationSince = 0;
  const notificationNavigationCache = "herdr-notification-navigation-v1";
  let notificationRelayTarget = null;
  let notificationRelayCompletedId = null;
  let notificationRelayChannel = null;

  function receiveNotificationRelay(target) {
    if (!target || typeof target.id !== "string" || !Number.isFinite(target.expiresAt) || target.expiresAt < Date.now()) return false;
    if (target.id === notificationRelayCompletedId || target.id === notificationRelayTarget?.id) return true;
    notificationRelayTarget = target;
    if (!acceptNotificationTarget(target.url)) { notificationRelayTarget = null; return false; }
    return true;
  }

  async function requestNotificationWorker(message) {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) return null;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const finish = (result) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(result); };
      const timer = setTimeout(() => finish(null), 800);
      channel.port1.onmessage = (event) => finish(event.data);
      try { worker.postMessage(message, [channel.port2]); } catch { finish(null); }
    });
  }

  async function restoreNotificationTarget() {
    const response = await requestNotificationWorker({ type: "read-notification-target" });
    if (response && !response.unavailable) {
      if (response.target) receiveNotificationRelay(response.target);
      return;
    }
    if (!("caches" in window)) return;
    try {
      const cache = await caches.open(notificationNavigationCache);
      const [pending, applied] = await Promise.all([cache.match("/pending"), cache.match("/applied")]);
      if (!pending) return;
      const target = await pending.json();
      if (applied && (await applied.json()).id === target.id) return;
      receiveNotificationRelay(target);
    } catch { /* Direct messages and the launch URL remain available. */ }
  }

  async function completeNotificationRelay() {
    const target = notificationRelayTarget;
    if (!target || document.hidden || state.renderedPaneId !== state.selectedPaneId ||
        new URL(target.url, location.href).searchParams.get("pane") !== state.selectedPaneId) return;
    // In a grid the pane's cell must be on screen, not hidden by another's zoom.
    if (state.renderedGrid && !shownGrid()?.showsPane(state.selectedPaneId)) return;
    notificationRelayTarget = null;
    notificationRelayCompletedId = target.id;
    notificationRelayChannel?.postMessage({ type: "notification-target-applied", id: target.id, visible: true });
    const response = await requestNotificationWorker({ type: "complete-notification-target", id: target.id });
    if (response?.applied) return;
    try {
      const cache = await caches.open(notificationNavigationCache);
      await cache.put("/applied", new Response(JSON.stringify({ id: target.id })));
    } catch { /* Acknowledgement still reached the active worker. */ }
  }
  function acceptNotificationTarget(value) {
    let target;
    try { target = new URL(value, window.location.href); } catch { return false; }
    if (target.origin !== window.location.origin) return false;
    const paneId = target.searchParams.get("pane");
    if (!paneId || paneId.length > 512 || /[\u0000-\u001f\u007f]/u.test(paneId)) return false;
    // Persist the target before acknowledging delivery, so a reload or Android
    // activity restoration cannot discard a switch awaiting its snapshot.
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("pane", paneId);
    window.history.replaceState(null, "", currentUrl);
    pendingNotificationPaneId = paneId;
    pendingNotificationSince = Date.now();
    void refreshSnapshot();
    return true;
  }

  const appAlert = document.querySelector("#app-alert");
  let appAlertTimer = null;
  let appAlertUrl = null;
  const appAlertSwipe = attachSwipeDismiss(appAlert, {
    onDismiss: hideAppAlert,
    reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  appAlert.addEventListener("click", () => {
    if (appAlertSwipe.consumedClick()) return;
    hideAppAlert();
    if (appAlertUrl) acceptNotificationTarget(appAlertUrl);
  });

  function showAppAlert({ title, body, url }) {
    document.querySelector("#app-alert-title").textContent = typeof title === "string" ? title : "HerdRabbit";
    document.querySelector("#app-alert-body").textContent = typeof body === "string" ? body : "";
    appAlertUrl = typeof url === "string" ? url : null;
    appAlertSwipe.reset();
    appAlert.hidden = false;
    clearTimeout(appAlertTimer);
    appAlertTimer = setTimeout(hideAppAlert, 8_000);
    playAlertSound();
  }

  function hideAppAlert() {
    clearTimeout(appAlertTimer);
    appAlert.hidden = true;
  }

  // Two short tones. A page the person has not touched yet may not play sound;
  // then the alert is only seen.
  let alertAudio = null;
  function playAlertSound() {
    try {
      alertAudio ??= new AudioContext();
      if (alertAudio.state === "suspended") void alertAudio.resume().catch(() => {});
      const start = alertAudio.currentTime;
      // A5 then D6, each about a seventh of a second.
      for (const [offset, frequency] of [[0, 880], [0.16, 1175]]) {
        const tone = alertAudio.createOscillator();
        const gain = alertAudio.createGain();
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.15, start + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.14);
        tone.connect(gain).connect(alertAudio.destination);
        tone.start(start + offset);
        tone.stop(start + offset + 0.15);
      }
    } catch {
      // No audio is not worth interrupting anything for.
    }
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "query-viewing-pane") {
        const inFront = state.authenticated && !document.hidden;
        if (inFront && state.selectedPaneId !== event.data.paneId) showAppAlert(event.data);
        event.ports?.[0]?.postMessage({ viewing: inFront });
        return;
      }
      if (event.data?.type !== "open-notification-pane") return;
      event.ports?.[0]?.postMessage({ accepted: event.data.target
        ? receiveNotificationRelay(event.data.target) : acceptNotificationTarget(event.data.url) });
    });
  }

  return {
    acceptNotificationTarget, receiveNotificationRelay, completeNotificationRelay, restoreNotificationTarget, showAppAlert,
    // The pane a notification asked for, waiting for a snapshot that has it.
    get pendingPaneId() { return pendingNotificationPaneId; },
    set pendingPaneId(value) { pendingNotificationPaneId = value; },
    get pendingSince() { return pendingNotificationSince; },
    // The relayed target not yet shown on screen.
    get relayTarget() { return notificationRelayTarget; },
    // Where other windows hear that a target was applied (set in start()).
    get relayChannel() { return notificationRelayChannel; },
    set relayChannel(value) { notificationRelayChannel = value; },
  };
}
