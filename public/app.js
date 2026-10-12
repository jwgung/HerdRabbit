import { combinedTerminalKey, keyboardTerminalKey } from "./key-combinations.js?v=1.2.18";
import { MAX_TEXT_PREVIEW_BYTES, previewFor } from "./file-preview.js?v=1.2.18";
const selectedKeyModifiers = new Set();
let modifierPaneId = null;
let keySendBusy = false;
import {
  HISTORY_PAGE_LINES,
  agentCompletionIdentity,
  agentStatus,
  agentStatusIcon,
  detectTouchInput,
  displayRecordLabel,
  displayTabLabel,
  browseDiffSummary,
  diffBrowseListing,
  flattenTree,
  formatTransferSize,
  inputKeyAction,
  insertNewlineAtSelection,
  insertPathAtSelection,
  uploadSummary,
  paneStartDirectory,
  paneServerId,
  parentDirectory,
  loginMethodPresentation,
  nearTerminalBottom,
  terminalShowsOlderScreen,
  nextInputHistory,
  shouldBrowseInputHistory,
  preferredLoginMethod,
  nextHistoryLineLimit,
  outputPollingDecision,
  outputTextForUpdate,
  paneShortcutTarget,
  selectedPaneIdForSnapshot,
  waitsForRemotePane,
  keepsVanishedRemotePane,
  shouldRenderTerminalUpdate,
  sidebarPresentation,
  terminalOutputForEnvironment,
  terminalPinchDirection,
  visibleAgentStatus,
  openRenames,
  clearedTabLabel,
  aiAccountNotice,
  passkeyDetails,
  sortAiAccounts,
  aiAccountsToSave,
  aiLoginSessionId,
  aiRestartHint,
  isAiLoginWorkspace,
  paneKeepsInputHistory,
} from "./ui-model.js?v=1.2.18";
import { ansiToSegments } from "./ansi.js?v=1.2.18";
import {
  clampNavigatorWidth,
  readBrowsePath,
  readFileServer,
  writeFileServer,
  readNavigatorTab,
  readNavigatorWidth,
  writeBrowsePath,
  writeNavigatorTab,
  writeNavigatorWidth,
} from "./browse-preference.js?v=1.2.18";
import { linkTerminalSegments } from "./terminal-links.js?v=1.2.18";
import { attachDirectTerminalInput } from "./direct-terminal-input.js?v=1.2.18";
import { terminalConnection } from "./terminal-connection.js?v=1.2.18";
import { createAttachedTerminal } from "./xterm-terminal.js?v=1.2.18";
import * as xterm from "./vendor/xterm.mjs?v=1.2.18";
import {
  readPanePreference,
  writePanePreference,
} from "./pane-preference.js?v=1.2.18";
import {
  readCollapsedGroupIds,
  readCollapsedWorkspaceIds,
  writeCollapsedGroupIds,
  writeCollapsedWorkspaceIds,
} from "./workspace-preference.js?v=1.2.18";
import {
  adjustedTerminalFontSize,
  readTerminalFontSize,
  writeTerminalFontSize,
} from "./terminal-preference.js?v=1.2.18";
import {
  readAcknowledgedCompletions,
  writeAcknowledgedCompletions,
} from "./completion-preference.js?v=1.2.18";
import { readAlertSound, writeAlertSound } from "./alert-preference.js?v=1.2.18";
import {
  readInputHistories,
  writeInputHistories,
} from "./input-history-preference.js?v=1.2.18";
import {
  clearLaunchToken,
  readLaunchToken,
  writeLaunchToken,
} from "./launch-session.js?v=1.2.18";
import {
  applicationServerKeyBytes,
  pushButtonPresentation,
} from "./push-notifications.js?v=1.2.18";

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const panePreferenceStorage = browserStorage();
let lastLoginMethod;
try { lastLoginMethod = panePreferenceStorage?.getItem("herdr:last-login-method"); } catch {}

function rememberLoginMethod(method) {
  lastLoginMethod = method;
  try { panePreferenceStorage?.setItem("herdr:last-login-method", method); } catch {}
}

function currentLoginMethod() {
  return preferredLoginMethod({
    lastMethod: lastLoginMethod, touchInput: usesTouchInputEnvironment(),
    passkeyAvailable: state.passkeyAvailable && supportsPasskeys(),
  });
}
const launchSessionStorage = browserSessionStorage();
const notificationPanePreference = new URL(window.location.href).searchParams.get("pane");
let pendingNotificationPaneId = null;
let pendingNotificationSince = 0;
// How long a link to another server's pane waits for that server's panes to load.
const PENDING_REMOTE_PANE_MS = 20_000;
const pageOpenedAt = Date.now();
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
appAlert.addEventListener("click", () => {
  hideAppAlert();
  if (appAlertUrl) acceptNotificationTarget(appAlertUrl);
});

function showAppAlert({ title, body, url }) {
  document.querySelector("#app-alert-title").textContent = typeof title === "string" ? title : "HerdRabbit";
  document.querySelector("#app-alert-body").textContent = typeof body === "string" ? body : "";
  appAlertUrl = typeof url === "string" ? url : null;
  appAlert.hidden = false;
  clearTimeout(appAlertTimer);
  appAlertTimer = setTimeout(hideAppAlert, 8_000);
  if (readAlertSound(panePreferenceStorage)) playAlertSound();
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
const initialPanePreference =
  typeof notificationPanePreference === "string" &&
  notificationPanePreference.length > 0 &&
  notificationPanePreference.length <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(notificationPanePreference)
    ? notificationPanePreference
    : readPanePreference(panePreferenceStorage);
const initialCollapsedGroupIds = readCollapsedGroupIds(
  (() => { try { return window.localStorage; } catch { return null; } })(),
);
const initialCollapsedWorkspaceIds = readCollapsedWorkspaceIds(
  panePreferenceStorage,
);
const initialTerminalFontSize = readTerminalFontSize(panePreferenceStorage);
const initialAcknowledgedCompletions = readAcknowledgedCompletions(
  panePreferenceStorage,
);
const initialInputHistories = readInputHistories(panePreferenceStorage);
document.documentElement.style.setProperty(
  "--terminal-font-size",
  `${initialTerminalFontSize}px`,
);

const elements = {
  shell: document.querySelector(".shell"),
  navigator: document.querySelector("#navigator"),
  navigatorContent: document.querySelector("#navigator-content"),
  createProject: document.querySelector("#create-project"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  sidebarScrim: document.querySelector("#sidebar-scrim"),
  mobileSidebarOpen: document.querySelector("#mobile-sidebar-open"),
  workspaceList: document.querySelector("#workspace-list"),
  paneContext: document.querySelector("#pane-context"),
  paneTitle: document.querySelector("#pane-title"),
  notificationToggle: document.querySelector("#notification-toggle"),
  themeToggle: document.querySelector("#theme-toggle"),
  historyStatus: document.querySelector("#history-status"),
  terminalPanel: document.querySelector(".terminal-panel"),
  terminalOutput: document.querySelector("#terminal-output"),
  terminalLive: document.querySelector("#terminal-live"),
  terminalXterm: document.querySelector("#terminal-xterm"),
  terminalHeld: document.querySelector("#terminal-held"),
  quickKeys: document.querySelector(".quick-keys"),
  inputForm: document.querySelector("#input-form"),
  terminalInput: document.querySelector("#terminal-input"),
  actionFeedback: document.querySelector("#action-feedback"),
  projectDialog: document.querySelector("#project-dialog"),
  projectCreateForm: document.querySelector("#project-create-form"),
  projectName: document.querySelector("#project-name"),
  projectSessionContext: document.querySelector("#project-session-context"),
  projectDialogCancel: document.querySelector("#project-dialog-cancel"),
  projectDialogFeedback: document.querySelector("#project-dialog-feedback"),
  loginScreen: document.querySelector("#login-screen"),
  loginForm: document.querySelector("#login-form"),
  loginInstruction: document.querySelector("#login-instruction"),
  loginPassword: document.querySelector("#login-password"),
  loginPasswordLabel: document.querySelector("#login-password-label"),
  loginSubmit: document.querySelector(".login-submit"),
  loginFeedback: document.querySelector("#login-feedback"),
  passkeyLogin: document.querySelector("#passkey-login"),
  passkeyDialog: document.querySelector("#passkey-dialog"),
  passkeyRegister: document.querySelector("#passkey-register"),
  passkeyDialogCancel: document.querySelector("#passkey-dialog-cancel"),
  passkeyDialogFeedback: document.querySelector("#passkey-dialog-feedback"),
  passkeyDialogPassword: document.querySelector("#passkey-dialog-password"),
  passkeyDialogPasswordField: document.querySelector("#passkey-dialog-password-field"),
  attachButton: document.querySelector("#attach-button"),
  transferDialog: document.querySelector("#transfer-dialog"),
  transferFile: document.querySelector("#transfer-file"),
  transferUpload: document.querySelector("#transfer-upload"),
  transferClose: document.querySelector("#transfer-close"),
  transferDialogFeedback: document.querySelector("#transfer-dialog-feedback"),
  transferDrop: document.querySelector("#transfer-drop"),
  transferDropLabel: document.querySelector("#transfer-drop-label"),
  uploadsList: document.querySelector("#uploads-list"),
  navigator: document.querySelector("#navigator"),
  navigatorResizer: document.querySelector("#navigator-resizer"),
  navigatorTabs: document.querySelectorAll(".navigator-tab"),
  tabSessions: document.querySelector("#tab-sessions"),
  tabFiles: document.querySelector("#tab-files"),
  filePanel: document.querySelector("#file-panel"),
  filePath: document.querySelector("#file-path"),
  fileSuggestions: document.querySelector("#file-suggestions"),
  fileRefresh: document.querySelector("#file-refresh"),
  fileUp: document.querySelector("#file-up"),
  fileUploads: document.querySelector("#file-uploads"),
  fileServer: document.querySelector("#file-server"),
  browseTree: document.querySelector("#file-tree"),
  browseFeedback: document.querySelector("#file-feedback"),
};

const state = {
  csrfToken: "",
  pollIntervalMs: 1_000,
  snapshot: null,
  selectedPaneId: initialPanePreference,
  preferredPaneId: initialPanePreference,
  snapshotBusy: false,
  outputRequests: new Set(),
  lastOutputRequestAt: 0,
  outputLineLimits: new Map(),
  outputRevisions: new Map(),
  outputHasMore: new Map(),
  historyRequested: new Set(),
  historyErrors: new Map(),
  historyLoadingPaneId: null,
  desktopSidebarCollapsed: false,
  mobileSidebarOpen: false,
  renderedPaneId: null,
  renderedOutput: null,
  terminalPointerActive: false,
  terminalFollow: true,
  remoteHistoryPanes: new Set(),
  remoteLiveRequests: new Set(),
  terminalScrollSettlesAt: 0,
  terminalUserScrollAt: 0,
  outputBurstUntil: 0,
  outputRefreshQueued: false,
  inputHistoryByPane: initialInputHistories,
  inputHistoryCursor: null,
  inputHistoryDraft: "",
  collapsedWorkspaceIds: initialCollapsedWorkspaceIds,
  collapsedGroupIds: initialCollapsedGroupIds,
  editingWorkspaceId: null,
  editingServerId: null,
  editingTabId: null,
  mutationBusy: false,
  openActionMenuId: null,
  createProjectSessionId: null,
  terminalFontSize: initialTerminalFontSize,
  authenticated: false,
  pollingStarted: false,
  connection: { kind: "pending", text: "Connecting" },
  acknowledgedCompletions: initialAcknowledgedCompletions,
  launchToken: readLaunchToken(launchSessionStorage),
  pushPublicKey: null,
  pushSubscription: null,
  pushBusy: false,
  authRequired: false,
  passkeyAvailable: false,
  passkeyBusy: false,
  sessionsBusy: false,
  passkeyAutoStarted: false,
};

const desktopMedia = window.matchMedia("(min-width: 761px)");
const primaryTouchMedia = window.matchMedia("(pointer: coarse) and (hover: none)");
const anyCoarsePointerMedia = window.matchMedia("(any-pointer: coarse)");
const anyHoverMedia = window.matchMedia("(any-hover: hover)");
const compactInputMedia = window.matchMedia("(max-width: 1024px)");
let sidebarAnimationTimer;
let terminalFontWheelDelta = 0;
let terminalPinchDistance = null;
let terminalInputResizeTimer = null;

const COMPOSER_RESIZE_DELAY_MS = 300;
// Matches the #terminal-output line-height in styles.css.
const TERMINAL_LINE_HEIGHT_RATIO = 1.55;
// How long after the last scroll event the view is left alone. Momentum
// scrolling keeps firing scroll events after the finger is already gone.
const TERMINAL_SCROLL_SETTLE_MS = 350;
// A scroll event counts as the reader's only if a gesture just produced it.
// Momentum keeps scrolling after the finger lifts, and an on-screen keyboard
// resizes the viewport, which scrolls the terminal without anyone asking.
const TERMINAL_USER_SCROLL_WINDOW_MS = 1_000;
const OUTPUT_SUBMISSION_BURST_MS = 3_000;
const OUTPUT_SUBMISSION_RETRY_MS = 250;
// Check deadlines often enough to honor the 300ms post-submission cadence.
const OUTPUT_POLL_TICK_MS = 100;

function usesTouchInputEnvironment() {
  return detectTouchInput({
    primaryTouch: primaryTouchMedia.matches,
    anyCoarsePointer: anyCoarsePointerMedia.matches,
    anyHover: anyHoverMedia.matches,
    maxTouchPoints: navigator.maxTouchPoints,
    compactViewport: compactInputMedia.matches,
  });
}

function clearSidebarAnimationState() {
  window.clearTimeout(sidebarAnimationTimer);
  document.body.classList.remove("sidebar-animating");
}

function markSidebarAnimating() {
  window.clearTimeout(sidebarAnimationTimer);
  document.body.classList.add("sidebar-animating");
  sidebarAnimationTimer = window.setTimeout(clearSidebarAnimationState, 400);
}

function syncSidebar() {
  const presentation = sidebarPresentation({
    isDesktop: desktopMedia.matches,
    desktopCollapsed: state.desktopSidebarCollapsed,
    mobileOpen: state.mobileSidebarOpen,
  });
  document.body.classList.toggle("sidebar-collapsed", presentation.collapsed);
  document.body.classList.toggle(
    "sidebar-open",
    !desktopMedia.matches && presentation.open,
  );
  elements.navigator.inert = presentation.navigatorInert;
  elements.sidebarToggle.setAttribute("aria-expanded", String(presentation.toggleExpanded));
  elements.sidebarToggle.setAttribute("aria-label", presentation.toggleLabel);
  elements.sidebarToggle.title = presentation.toggleLabel;
  elements.mobileSidebarOpen.setAttribute("aria-expanded", String(presentation.open));
}

async function dismissDeliveredNotifications() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (typeof registration.getNotifications !== "function") return;
    for (const notification of await registration.getNotifications()) {
      notification.close();
    }
  } catch {
    // Tidying notifications is best effort and never blocks the app.
  }
}

function showLogin() {
  terminalStream.pause();
  state.authenticated = false;
  document.body.classList.remove("auth-pending", "auth-ready");
  document.body.classList.add("auth-required");
  elements.shell.inert = true;
  elements.loginScreen.hidden = false;
  renderLoginMethods();
  // Let the revealed login screen participate in layout before requesting IME
  // focus, as in the original password login flow.
  window.requestAnimationFrame(() => {
    if (!elements.loginScreen.contains(document.activeElement)) focusLoginMethod();
  });
  startAutomaticPasskeyLogin();
}

function focusLoginMethod() {
  if (state.authenticated || elements.loginScreen.hidden || state.passkeyBusy) return;
  if (currentLoginMethod() === "passkey") {
    elements.passkeyLogin.focus({ preventScroll: true });
  } else {
    focusLoginPassword();
  }
}

function restoreLoginFocus() {
  if (document.hidden || state.authenticated || elements.loginScreen.hidden) return;
  const active = document.activeElement;
  // Preserve the user's chosen control; restore only missing login focus.
  if ((active === elements.loginPassword && currentLoginMethod() === "password") ||
      !elements.loginScreen.contains(active)) {
    focusLoginMethod();
  }
  startAutomaticPasskeyLogin();
}

function startAutomaticPasskeyLogin() {
  if (document.hidden || state.authenticated || elements.loginScreen.hidden ||
      currentLoginMethod() !== "passkey" ||
      state.passkeyAutoStarted || state.passkeyBusy ||
      !state.passkeyAvailable || !supportsPasskeys()) return;
  state.passkeyAutoStarted = true;
  void startPasskeyLogin();
}

function focusLoginPassword() {
  if (state.authenticated || elements.loginScreen.hidden || elements.loginPassword.disabled) return;
  elements.loginPassword.focus();
  // Android may focus the DOM input without opening its software keyboard.
  // Keyboard display still depends on browser policy and user activation.
  if (usesTouchInputEnvironment()) {
    try { navigator.virtualKeyboard?.show(); } catch { /* Native input remains usable. */ }
  }
}

function focusComposer() {
  if (!desktopMedia.matches || usesTouchInputEnvironment() ||
      !state.authenticated || elements.terminalInput.disabled) return;
  elements.terminalInput.focus({ preventScroll: true });
}

function showApplication() {
  state.authenticated = true;
  document.body.classList.remove("auth-pending", "auth-required");
  document.body.classList.add("auth-ready");
  elements.shell.inert = false;
  elements.loginScreen.hidden = true;
  elements.loginFeedback.textContent = "";
}

function supportsPasskeys() {
  try {
    return window.isSecureContext &&
      window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn?.() === true;
  } catch {
    return false;
  }
}

async function completePasskeyLogin(ceremony, credential) {
  // Ignore a result if another login path already established the session.
  if (state.authenticated) return;
  const login = await api("/api/auth/passkeys/login/verify", {
    method: "POST",
    csrf: false,
    body: { attemptId: ceremony.attemptId, credential },
  });
  state.launchToken = writeLaunchToken(launchSessionStorage, login.launchToken);
  rememberLoginMethod("passkey");
  state.passkeyAvailable = true;
  elements.loginPassword.value = "";
  await initializeApplication();
}

function renderLoginMethods() {
  const presentation = loginMethodPresentation({
    passkeyAvailable: state.passkeyAvailable,
    passkeySupported: supportsPasskeys(),
  });
  elements.passkeyLogin.hidden = !presentation.passkeyVisible;
  elements.passkeyLogin.disabled = state.passkeyBusy;
  elements.passkeyLogin.classList.toggle("primary-button", presentation.passkeyPrimary);
  elements.passkeyLogin.classList.toggle("secondary-button", !presentation.passkeyPrimary);
  elements.loginSubmit.classList.toggle("primary-button", presentation.passwordPrimary);
  elements.loginSubmit.classList.toggle("secondary-button", !presentation.passwordPrimary);
  elements.loginInstruction.textContent = presentation.instruction;
  elements.loginPasswordLabel.textContent = presentation.passwordLabel;
  return presentation;
}

function setLoginBusy(busy) {
  state.passkeyBusy = busy;
  elements.loginPassword.disabled = busy;
  elements.loginSubmit.disabled = busy;
  renderLoginMethods();
}

function passkeyErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "The passkey request was canceled or timed out.";
  }
  return error?.message || "The passkey request failed.";
}

// Adding or removing a passkey needs the password; asking for it before
// anything else keeps the device prompt from opening for a request the server
// will refuse.
function enteredPassword(input, feedback) {
  if (input.value) return input.value;
  feedback.textContent = "Enter your password first.";
  feedback.dataset.error = "true";
  input.focus();
  return null;
}

function offerPasskeyRegistration() {
  if (!supportsPasskeys() || state.passkeyAvailable || elements.passkeyDialog.open) return;
  elements.passkeyDialogFeedback.textContent = "";
  elements.passkeyDialogFeedback.dataset.error = "false";
  elements.passkeyDialogPassword.value = "";
  // Offered right after a password sign-in, which the server still counts as
  // fresh; the field only appears if it no longer does.
  elements.passkeyDialogPasswordField.hidden = true;
  elements.passkeyDialog.showModal();
}

// The password goes with the request that starts the ceremony; the server
// checks it before it hands out a challenge.
async function registerPasskey(password) {
  const ceremony = await api("/api/auth/passkeys/register/options", {
    method: "POST",
    body: { password },
  });
  const credential = await window.SimpleWebAuthnBrowser.startRegistration({
    optionsJSON: ceremony.options,
  });
  await api("/api/auth/passkeys/register/verify", {
    method: "POST",
    body: { attemptId: ceremony.attemptId, credential },
  });
  state.passkeyAvailable = true;
}

function closeMobileSidebar({ restoreFocus = false } = {}) {
  if (desktopMedia.matches || !state.mobileSidebarOpen) return;
  state.mobileSidebarOpen = false;
  syncSidebar();
  if (restoreFocus) elements.mobileSidebarOpen.focus();
}

// This machine's row carries whether this page can reach HerdRabbit at all --
// what a separate footer dot used to say. A linked machine's row keeps saying
// only whether HerdRabbit reaches it.
function serverConnection(server) {
  if (server.id === "local" && state.connection.kind === "error") {
    return { online: false, error: true, text: state.connection.text };
  }
  return { online: server.available === true, error: false, text: server.status };
}

function setConnection(kind, text) {
  state.connection = { kind, text };
  // The row is updated in place: a rename in progress holds off a full redraw.
  const heading = document.querySelector('.server-heading[data-server-id="local"]');
  if (!heading) return;
  const local = snapshotRecords().servers.find((item) => item.id === "local") ??
    { id: "local", available: kind === "online", status: text };
  const connection = serverConnection(local);
  heading.classList.toggle("is-online", connection.online);
  heading.classList.toggle("is-error", connection.error);
  heading.title = `${heading.dataset.serverName}: ${connection.text}`;
  heading.setAttribute("aria-label", heading.title);
}

function setFeedback(text, isError = false) {
  elements.actionFeedback.textContent = text;
  elements.actionFeedback.dataset.error = String(isError);
}

function syncThemeButton() {
  const currentTheme = window.herdrTheme?.current() || "dark";
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  const label = nextTheme === "light" ? "Switch to light mode" : "Switch to dark mode";
  elements.themeToggle.dataset.nextTheme = nextTheme;
  elements.themeToggle.setAttribute("aria-label", label);
  elements.themeToggle.title = label;
}

function supportsPushNotifications() {
  return Boolean(
    state.pushPublicKey &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window,
  );
}

function renderNotificationButton() {
  const supported = supportsPushNotifications();
  const presentation = pushButtonPresentation({
    supported,
    permission: supported ? Notification.permission : "default",
    subscribed: state.pushSubscription !== null,
    busy: state.pushBusy,
  });
  elements.notificationToggle.hidden = presentation.hidden;
  elements.notificationToggle.disabled = presentation.disabled;
  elements.notificationToggle.dataset.state = presentation.state;
  elements.notificationToggle.setAttribute(
    "aria-pressed",
    String(presentation.pressed),
  );
  elements.notificationToggle.setAttribute("aria-label", presentation.label);
  elements.notificationToggle.title = presentation.label;
}

async function serviceWorkerRegistration() {
  if (!supportsPushNotifications()) return null;
  return navigator.serviceWorker.ready;
}

async function syncPushSubscription() {
  renderNotificationButton();
  const registration = await serviceWorkerRegistration();
  if (!registration) return;
  state.pushSubscription = await registration.pushManager.getSubscription();
  renderNotificationButton();
  if (state.pushSubscription && Notification.permission === "granted") {
    await api("/api/push/subscriptions", {
      method: "POST",
      body: { subscription: state.pushSubscription },
    });
  }
}

async function togglePushNotifications() {
  if (state.pushBusy || !supportsPushNotifications()) return;
  state.pushBusy = true;
  renderNotificationButton();
  setFeedback("");
  try {
    const registration = await serviceWorkerRegistration();
    if (!registration) return;
    const existing = state.pushSubscription ||
      await registration.pushManager.getSubscription();
    if (existing) {
      await api("/api/push/subscriptions", {
        method: "DELETE",
        body: { endpoint: existing.endpoint },
      });
      await existing.unsubscribe();
      state.pushSubscription = null;
      return;
    }

    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") return;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKeyBytes(state.pushPublicKey),
    });
    try {
      await api("/api/push/subscriptions", {
        method: "POST",
        body: { subscription },
      });
      state.pushSubscription = subscription;
    } catch (error) {
      await subscription.unsubscribe().catch(() => {});
      throw error;
    }
  } catch (error) {
    setFeedback(`Couldn't update notifications: ${error.message}`, true);
  } finally {
    state.pushBusy = false;
    renderNotificationButton();
  }
}

function adjustTerminalFont(direction) {
  applyTerminalFontSize(adjustedTerminalFontSize(state.terminalFontSize, direction));
}

function applyTerminalFontSize(nextSize) {
  state.terminalFontSize = nextSize;
  document.documentElement.style.setProperty(
    "--terminal-font-size",
    `${nextSize}px`,
  );
  writeTerminalFontSize(panePreferenceStorage, nextSize);
  resizeTerminalInput();
  attachedTerminal.setFontSize(nextSize);
}

function supportsNativeTerminalInputSizing() {
  return typeof CSS !== "undefined" &&
    CSS.supports?.("field-sizing", "content") === true;
}

function resizeTerminalInput() {
  const input = elements.terminalInput;
  if (supportsNativeTerminalInputSizing()) {
    input.style.removeProperty("height");
    input.style.removeProperty("overflow-y");
    return;
  }
  input.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(input).maxHeight);
  const contentHeight = input.scrollHeight;
  const nextHeight = Number.isFinite(maxHeight)
    ? Math.min(contentHeight, maxHeight)
    : contentHeight;
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = contentHeight > nextHeight ? "auto" : "hidden";
}

function scheduleTerminalInputResize() {
  if (supportsNativeTerminalInputSizing()) return;
  window.clearTimeout(terminalInputResizeTimer);
  terminalInputResizeTimer = window.setTimeout(() => {
    terminalInputResizeTimer = null;
    resizeTerminalInput();
  }, COMPOSER_RESIZE_DELAY_MS);
}

function touchDistance(touches) {
  if (touches.length !== 2) return null;
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
}

function resetInputHistoryNavigation() {
  state.inputHistoryCursor = null;
  state.inputHistoryDraft = "";
}

function rememberSentInput(paneId, text) {
  const history = state.inputHistoryByPane.get(paneId) || [];
  if (history.at(-1) !== text) history.push(text);
  if (history.length > 100) history.splice(0, history.length - 100);
  state.inputHistoryByPane.delete(paneId);
  state.inputHistoryByPane.set(paneId, history);
  writeInputHistories(panePreferenceStorage, state.inputHistoryByPane);
  resetInputHistoryNavigation();
}

class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(path, options = {}) {
  const { body, csrf = true, ...fetchOptions } = options;
  const headers = new Headers(options.headers);
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (csrf && fetchOptions.method && fetchOptions.method !== "GET") {
    headers.set("X-Herdr-CSRF", state.csrfToken);
  }
  if (state.launchToken) {
    headers.set("X-Herdr-Launch-Token", state.launchToken);
  }

  const response = await fetch(path, {
    ...fetchOptions,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new ApiError(payload?.error?.message || `HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
    });
    if (error.code === "authentication_required") {
      state.launchToken = clearLaunchToken(launchSessionStorage);
      showLogin();
    }
    throw error;
  }
  return payload;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function idOf(record, ...keys) {
  for (const key of keys) {
    if (typeof record?.[key] === "string") {
      return record[key];
    }
  }
  return "";
}

function snapshotRecords() {
  const snapshot = state.snapshot || {};
  return {
    servers: array(snapshot.servers),
    herdrSessions: array(snapshot.herdr_sessions),
    workspaces: array(snapshot.workspaces),
    tabs: array(snapshot.tabs),
    panes: array(snapshot.panes),
    agents: array(snapshot.agents),
  };
}

function selectedHerdrSession() {
  const { herdrSessions, panes } = snapshotRecords();
  if (herdrSessions.length === 0) {
    return { session_id: null, name: "default", running: true, available: true };
  }
  const selectedPane = panes.find(
    (pane) => idOf(pane, "pane_id", "id") === state.selectedPaneId,
  );
  const selectedSessionId = idOf(
    selectedPane,
    "herdr_session_id",
    "herdrSessionId",
  );
  return herdrSessions.find(
    (session) => idOf(session, "session_id", "id") === selectedSessionId &&
      session.running === true && session.available === true,
  ) || herdrSessions.find(
    (session) => session.default === true && session.running === true &&
      session.available === true,
  ) || herdrSessions.find(
    (session) => session.running === true && session.available === true,
  ) || null;
}

function syncCreateProjectAvailability() {
  elements.createProject.disabled = selectedHerdrSession() === null;
}

function agentForPane(paneId) {
  return snapshotRecords().agents.find(
    (agent) => idOf(agent, "pane_id", "paneId") === paneId,
  );
}

function visibleStatusForPane(paneId, agent, pane) {
  return visibleAgentStatus(
    agent,
    pane,
    state.acknowledgedCompletions.get(paneId) || null,
  );
}

function acknowledgePaneCompletion(paneId) {
  const pane = snapshotRecords().panes.find(
    (item) => idOf(item, "pane_id", "id") === paneId,
  );
  const agent = agentForPane(paneId);
  if (agentStatus(agent, pane) !== "done") return;
  const identity = agentCompletionIdentity(agent, pane);
  if (!identity || state.acknowledgedCompletions.get(paneId) === identity) return;
  state.acknowledgedCompletions.set(paneId, identity);
  writeAcknowledgedCompletions(
    panePreferenceStorage,
    state.acknowledgedCompletions,
  );
}

function pruneAcknowledgedCompletions() {
  const { panes } = snapshotRecords();
  const liveDonePanes = new Set();
  for (const pane of panes) {
    const paneId = idOf(pane, "pane_id", "id");
    if (agentStatus(agentForPane(paneId), pane) === "done") {
      liveDonePanes.add(paneId);
    }
  }
  let changed = false;
  for (const paneId of state.acknowledgedCompletions.keys()) {
    if (!liveDonePanes.has(paneId)) {
      state.acknowledgedCompletions.delete(paneId);
      changed = true;
    }
  }
  if (changed) {
    writeAcknowledgedCompletions(
      panePreferenceStorage,
      state.acknowledgedCompletions,
    );
  }
}

function createElement(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createIcon(paths, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  for (const pathData of array(paths)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

function workspaceActionButton({ className = "", label, paths, type = "button" }) {
  const button = createElement("button", {
    className: `workspace-action ${className}`.trim(),
  });
  button.type = type;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(createIcon(paths));
  return button;
}

// The top layer has no anchor of its own, so the menu is measured against the
// button that opened it and nudged back inside the viewport.
function placeFloatingMenu(popover, summary) {
  popover.showPopover();
  const anchor = summary.getBoundingClientRect();
  const menu = popover.getBoundingClientRect();
  const left = Math.min(Math.max(8, anchor.right - menu.width), window.innerWidth - menu.width - 8);
  const below = anchor.bottom + 4;
  const top = below + menu.height > window.innerHeight - 8
    ? Math.max(8, anchor.top - menu.height - 4)
    : below;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function sidebarActionMenu({ id, label, actions, className = "", escapesOverflow = false }) {
  const details = createElement("details", {
    className: `sidebar-action-menu ${className}`.trim(),
  });
  details.dataset.menuId = id;
  details.open = state.openActionMenuId === id;
  const summary = createElement("summary", { className: "workspace-action" });
  summary.setAttribute("aria-label", label);
  summary.title = label;
  summary.append(createIcon(["M6 12h.01M12 12h.01M18 12h.01"], "more-icon"));
  const popover = createElement("div", {
    className: "sidebar-action-popover",
  });
  popover.setAttribute("role", "menu");
  // A list that scrolls clips whatever is positioned inside it, and the uploads
  // list is one. The top layer is outside every such box, so the menu opens
  // over the dialog instead of being cut off at the row.
  if (escapesOverflow) {
    popover.setAttribute("popover", "auto");
    popover.classList.add("is-floating");
    popover.addEventListener("toggle", (event) => {
      // Clicking away closes the popover without telling the details element.
      if (event.newState === "closed" && details.open) details.open = false;
    });
  }

  for (const action of actions) {
    const button = createElement("button", {
      className: `sidebar-action-item ${action.danger ? "is-danger" : ""}`.trim(),
    });
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.append(
      createIcon(action.paths),
      createElement("span", { text: action.label }),
    );
    button.addEventListener("click", () => {
      details.open = false;
      state.openActionMenuId = null;
      action.onSelect(button);
    });
    popover.append(button);
  }

  details.addEventListener("toggle", () => {
    if (details.open) {
      state.openActionMenuId = id;
      // Document-wide: the sidebar is no longer the only place with menus.
      for (const other of document.querySelectorAll(".sidebar-action-menu[open]")) {
        if (other !== details) other.open = false;
      }
      if (escapesOverflow) placeFloatingMenu(popover, summary);
    } else {
      if (escapesOverflow && popover.matches(":popover-open")) popover.hidePopover();
      if (state.openActionMenuId === id) state.openActionMenuId = null;
    }
  });
  details.append(summary, popover);
  return details;
}

function paneBelongsToWorkspace(pane, workspaceId) {
  if (idOf(pane, "workspace_id", "workspaceId") === workspaceId) return true;
  const tabId = idOf(pane, "tab_id", "tabId");
  return snapshotRecords().tabs.some(
    (tab) =>
      idOf(tab, "tab_id", "id") === tabId &&
      idOf(tab, "workspace_id", "workspaceId") === workspaceId,
  );
}

function adoptMutationSnapshot(snapshot, preferredPaneId = null) {
  const previousPaneId = state.selectedPaneId;
  state.snapshot = snapshot || {};
  if (preferredPaneId) {
    if (previousPaneId !== preferredPaneId) collapseTerminalHistory(previousPaneId);
    state.selectedPaneId = preferredPaneId;
    state.preferredPaneId = preferredPaneId;
  }
  choosePane();
  syncCreateProjectAvailability();
  renderNavigation();
  const selected = selectedRecords();
  renderPaneHeading(selected.pane, selected.tab, selected.workspace);
  renderHistoryStatus();
  if (previousPaneId !== state.selectedPaneId) {
    showTerminalMessage(
      state.selectedPaneId ? "Loading output…" : "No open sessions.",
    );
  }
  void refreshOutput();
}

async function createShellSession(workspaceId, button) {
  if (state.mutationBusy) return;
  state.mutationBusy = true;
  button.disabled = true;
  const previousPaneIds = new Set(
    snapshotRecords().panes.map((pane) => idOf(pane, "pane_id", "id")),
  );
  setFeedback("");
  try {
    const payload = await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/tabs`,
      { method: "POST", body: {} },
    );
    state.snapshot = payload.snapshot || {};
    const newPane = snapshotRecords().panes.find(
      (pane) =>
        !previousPaneIds.has(idOf(pane, "pane_id", "id")) &&
        paneBelongsToWorkspace(pane, workspaceId),
    );
    state.collapsedWorkspaceIds.delete(workspaceId);
    writeCollapsedWorkspaceIds(panePreferenceStorage, state.collapsedWorkspaceIds);
    adoptMutationSnapshot(
      state.snapshot,
      newPane ? idOf(newPane, "pane_id", "id") : null,
    );
    closeMobileSidebar();
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
    button.disabled = false;
  }
}

async function closeSession(tab, label, button) {
  const tabId = idOf(tab, "tab_id", "id");
  const workspaceId = idOf(tab, "workspace_id", "workspaceId");
  if (
    !tabId ||
    state.mutationBusy ||
    !window.confirm(`Close session “${label}”? This will also stop any running processes.`)
  ) return;
  state.mutationBusy = true;
  button.disabled = true;
  setFeedback("");
  try {
    const payload = await api(`/api/tabs/${encodeURIComponent(tabId)}/close`, {
      method: "POST",
      body: { confirmed: true },
    });
    state.snapshot = payload.snapshot || {};
    const fallbackPane = snapshotRecords().panes.find((pane) =>
      paneBelongsToWorkspace(pane, workspaceId),
    );
    adoptMutationSnapshot(
      state.snapshot,
      fallbackPane ? idOf(fallbackPane, "pane_id", "id") : null,
    );
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
    button.disabled = false;
  }
}

async function closeProject(workspaceId, workspaceLabel, button) {
  if (
    state.mutationBusy ||
    !window.confirm(`Close project “${workspaceLabel}”? This will close all of its sessions and stop any running processes.`)
  ) return;
  state.mutationBusy = true;
  button.disabled = true;
  setFeedback("");
  try {
    const payload = await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/close`,
      { method: "POST", body: { confirmed: true } },
    );
    state.collapsedWorkspaceIds.delete(workspaceId);
    writeCollapsedWorkspaceIds(panePreferenceStorage, state.collapsedWorkspaceIds);
    adoptMutationSnapshot(payload.snapshot);
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
    button.disabled = false;
  }
}

function stopWorkspaceRename() {
  state.editingWorkspaceId = null;
  setFeedback("");
  renderNavigation();
}

// Three things in the sidebar can be renamed, and a rename is the same
// interaction each time: type, Enter or the check to keep it, Esc or the cross
// to drop it, controls locked while it is in flight. Written out three times
// the copies drifted -- the newest one lost Esc and kept a stale validity
// message -- so they share one form and can only drift together.
function renameForm({ value, label, placeholder = "", maxLength, invalidMessage, allowEmpty = false, onCancel, onSubmit }) {
  const form = createElement("form", { className: "workspace-rename-form" });
  const input = createElement("input", { className: "workspace-rename-input" });
  input.type = "text";
  input.value = value;
  input.maxLength = maxLength;
  input.required = !allowEmpty;
  if (placeholder) input.placeholder = placeholder;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => input.setCustomValidity(""));
  const saveButton = workspaceActionButton({
    className: "workspace-rename-save",
    label: `Save ${label}`,
    paths: ["M5 12l4 4L19 6"],
    type: "submit",
  });
  const cancelButton = workspaceActionButton({
    className: "workspace-rename-cancel",
    label: "Cancel rename",
    paths: ["M6 6l12 12M18 6 6 18"],
  });
  const controls = [input, saveButton, cancelButton];
  cancelButton.addEventListener("click", onCancel);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const next = input.value.trim();
    if (!next && !allowEmpty) {
      input.setCustomValidity(invalidMessage);
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    for (const control of controls) control.disabled = true;
    setFeedback("");
    try {
      await onSubmit(next);
    } catch (error) {
      for (const control of controls) control.disabled = false;
      setFeedback(error.message, true);
      input.focus();
    }
  });
  form.append(input, saveButton, cancelButton);
  window.requestAnimationFrame(() => { input.focus(); input.select(); });
  return form;
}

function workspaceHeading(group, workspace, workspaceLabel, children) {
  const workspaceId = idOf(workspace, "workspace_id", "id");
  const collapsed = state.collapsedWorkspaceIds.has(workspaceId);
  const editing = state.editingWorkspaceId === workspaceId;
  const heading = createElement("div", {
    className: `workspace-heading${editing ? " is-editing" : ""}`,
  });
  const collapseButton = workspaceActionButton({
    className: "workspace-collapse",
    label: collapsed ? `Expand ${workspaceLabel}` : `Collapse ${workspaceLabel}`,
    paths: ["M9 18l6-6-6-6"],
  });
  collapseButton.setAttribute("aria-expanded", String(!collapsed));
  collapseButton.setAttribute("aria-controls", children.id);
  collapseButton.addEventListener("click", () => {
    if (state.collapsedWorkspaceIds.has(workspaceId)) {
      state.collapsedWorkspaceIds.delete(workspaceId);
    } else {
      state.collapsedWorkspaceIds.add(workspaceId);
    }
    const isNowCollapsed = state.collapsedWorkspaceIds.has(workspaceId);
    group.classList.toggle("is-collapsed", isNowCollapsed);
    children.inert = isNowCollapsed;
    children.setAttribute("aria-hidden", String(isNowCollapsed));
    collapseButton.setAttribute("aria-expanded", String(!isNowCollapsed));
    const nextLabel = isNowCollapsed
      ? `Expand ${workspaceLabel}`
      : `Collapse ${workspaceLabel}`;
    collapseButton.setAttribute("aria-label", nextLabel);
    collapseButton.title = nextLabel;
    writeCollapsedWorkspaceIds(
      panePreferenceStorage,
      state.collapsedWorkspaceIds,
    );
  });
  heading.append(collapseButton);

  if (editing) {
    heading.append(renameForm({
      value: workspaceLabel,
      label: `${workspaceLabel} project name`,
      maxLength: 120,
      invalidMessage: "Enter a project name.",
      onCancel: stopWorkspaceRename,
      onSubmit: async (label) => {
        await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
          method: "POST",
          body: { label },
        });
        const currentWorkspace = snapshotRecords().workspaces.find(
          (item) => idOf(item, "workspace_id", "id") === workspaceId,
        );
        if (currentWorkspace) currentWorkspace.label = label;
        state.editingWorkspaceId = null;
        renderNavigation();
        const selected = selectedRecords();
        renderPaneHeading(selected.pane, selected.tab, selected.workspace);
      },
    }));
  } else {
    heading.append(createElement("h3", { text: workspaceLabel }));
    heading.append(sidebarActionMenu({
      id: `workspace-${workspaceId}`,
      label: `More actions for ${workspaceLabel}`,
      actions: [
        {
          label: "Rename",
          paths: [
            "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z",
            "M14.5 7.5l3 3",
          ],
          onSelect: () => {
            state.editingWorkspaceId = workspaceId;
            setFeedback("");
            renderNavigation();
          },
        },
        {
          label: "New session",
          paths: ["M12 5v14M5 12h14"],
          onSelect: (button) => void createShellSession(workspaceId, button),
        },
        {
          label: "Close project",
          paths: ["M6 6l12 12M18 6 6 18"],
          danger: true,
          onSelect: (button) => void closeProject(
            workspaceId,
            workspaceLabel,
            button,
          ),
        },
      ],
    }));
  }
  return heading;
}

function paneButton(pane, tab, workspace, { namesSession = false } = {}) {
  const paneId = idOf(pane, "pane_id", "id");
  const agent = agentForPane(paneId);
  const currentAgentStatus = visibleStatusForPane(paneId, agent, pane);
  const workspaceLabel = displayRecordLabel(workspace, "Project");
  const tabLabel = displayTabLabel(tab);
  const agentLabel = displayRecordLabel(agent, displayRecordLabel(pane, "Terminal"));
  // Once a session has a name, that name is what it is; the agent running in it
  // is a detail that changes under you, so it steps back next to the status.
  const sessionName = namesSession ? tabLabel : "";
  const button = createElement("button", { className: "pane-button" });
  button.type = "button";
  button.dataset.paneId = paneId;
  button.dataset.status = currentAgentStatus;
  button.setAttribute("aria-pressed", String(paneId === state.selectedPaneId));

  button.setAttribute(
    "aria-label",
    `${agentLabel}, ${currentAgentStatus}, ${[workspaceLabel, tabLabel].filter(Boolean).join(" / ")}`,
  );
  button.title = `${agentStatusIcon(currentAgentStatus)} ${[sessionName, agentLabel].filter(Boolean).join(" · ")} · ${currentAgentStatus}`;

  const marker = createElement("span", {
    className: `agent-marker state-${currentAgentStatus}`,
    text: agentStatusIcon(currentAgentStatus),
  });
  marker.setAttribute("aria-hidden", "true");
  button.append(marker);

  const copy = createElement("span", { className: "pane-copy" });
  // The marker beside this already says the status, and the button says it
  // again in its border and glow. Spelling it out was a third telling.
  copy.append(createElement("strong", {
    className: sessionName ? "" : "pane-agent",
    text: sessionName || agentLabel,
  }));
  if (sessionName) copy.append(createElement("small", { className: "pane-agent", text: agentLabel }));
  button.append(copy);

  button.addEventListener("click", () => {
    if (state.selectedPaneId !== paneId) {
      resetInputHistoryNavigation();
      collapseTerminalHistory(state.selectedPaneId);
      state.terminalFollow = true;
    }
    state.selectedPaneId = paneId;
    state.preferredPaneId = paneId;
    writePanePreference(panePreferenceStorage, paneId);
    acknowledgePaneCompletion(paneId);
    setFeedback("");
    renderNavigation();
    renderPaneHeading(pane, tab, workspace);
    renderHistoryStatus();
    showTerminalMessage("Loading output…");
    void refreshOutput();
    closeMobileSidebar();
    focusComposer();
  });

  return button;
}

// Server and session headings fold the same way project headings do, so a
// sidebar with several machines can be narrowed down to the one in use.
function attachGroupCollapse(group, heading, body, groupId, label) {
  const collapsed = state.collapsedGroupIds.has(groupId);
  const button = workspaceActionButton({
    className: "group-collapse",
    label: `${collapsed ? "Expand" : "Collapse"} ${label}`,
    paths: ["M9 18l6-6-6-6"],
  });
  button.setAttribute("aria-expanded", String(!collapsed));
  group.classList.toggle("is-collapsed", collapsed);
  body.inert = collapsed;
  body.setAttribute("aria-hidden", String(collapsed));

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.collapsedGroupIds.has(groupId)) state.collapsedGroupIds.delete(groupId);
    else state.collapsedGroupIds.add(groupId);
    const now = state.collapsedGroupIds.has(groupId);
    group.classList.toggle("is-collapsed", now);
    body.inert = now;
    body.setAttribute("aria-hidden", String(now));
    button.setAttribute("aria-expanded", String(!now));
    const next = `${now ? "Expand" : "Collapse"} ${label}`;
    button.setAttribute("aria-label", next);
    button.title = next;
    writeCollapsedGroupIds(panePreferenceStorage, state.collapsedGroupIds);
  });
  heading.prepend(button);
}

function serverRenameForm(server) {
  return renameForm({
    value: server.name,
    label: `${server.name} machine name`,
    // Herdr's machine names are held to 60 characters by the server.
    maxLength: server.transport === "machine" ? 60 : 80,
    invalidMessage: "Enter a name.",
    onCancel: () => { state.editingServerId = null; renderNavigation(); },
    onSubmit: async (name) => {
      if (server.transport === "machine") {
        await api(`/api/machines/${server.id}`, { method: "PUT", body: { label: name } });
        state.editingServerId = null;
        await refreshSnapshot();
        return;
      }
      // The address is not edited here, so it has to be carried over unchanged.
      const profile = savedServers.find((item) => item.id === server.id);
      await api(`/api/servers/${server.id}`, {
        method: "PUT",
        body: { name, address: profile?.address ?? "" },
      });
      state.editingServerId = null;
      await loadServers();
      await refreshSnapshot();
    },
  });
}

const serverDetailsDialog = document.querySelector("#server-details-dialog");
document.querySelector("#server-details-close")
  .addEventListener("click", () => serverDetailsDialog.close());

function herdrVersionText(server) {
  if (!server.herdr_version) return "Unknown";
  return server.herdr_supported === false
    ? `${server.herdr_version} (update to ${server.herdr_min_version} or newer)`
    : server.herdr_version;
}

function showServerDetails(server) {
  const sessions = snapshotRecords().herdrSessions.filter((item) => item.server_id === server.id);
  // A pane record carries no server of its own; its id is where the server is.
  const panes = snapshotRecords().panes.filter((item) => paneServerId(item.pane_id) === server.id);
  // A machine is shown by the name Tailscale knows it by, not by an address.
  const rows = [
    ...(server.machine ? [["Machine", server.machine]] : []),
    ["HerdRabbit", server.version || "Unknown"],
    ["Herdr", herdrVersionText(server)],
    ["Status", server.available ? "Connected" : server.status || "Offline"],
    ["Herdr sessions", String(sessions.length)],
    ["Panes", String(panes.length)],
  ];
  const list = document.querySelector("#server-details");
  list.replaceChildren();
  for (const [term, value] of rows) {
    list.append(createElement("dt", { text: term }), createElement("dd", { text: value }));
  }
  document.querySelector("#server-details-title").textContent = server.name;
  serverDetailsDialog.showModal();
}

// Signed-in devices. Each is named by its browser and dates; the list never
// carries a token. Signing out needs no password: it only takes access away.
const sessionsDialog = document.querySelector("#sessions-dialog");
const sessionsList = document.querySelector("#sessions-list");
const sessionsFeedback = document.querySelector("#sessions-feedback");
document.querySelector("#sessions-close").addEventListener("click", () => sessionsDialog.close());
document.querySelector("#sessions-end-all").addEventListener("click", () => {
  if (!window.confirm("Sign out every browser, this one included?")) return;
  void sessionsAction(async () => {
    await api("/api/auth/sessions/end-all", { method: "POST", body: {} });
    sessionsDialog.close();
    signedOut();
  });
});

function setSessionsFeedback(text, isError = false) {
  sessionsFeedback.textContent = text;
  sessionsFeedback.dataset.error = String(isError);
}

async function sessionsAction(work) {
  if (state.sessionsBusy) return;
  state.sessionsBusy = true;
  const controls = sessionsDialog.querySelectorAll("button");
  controls.forEach((control) => { control.disabled = true; });
  try {
    await work();
  } catch (error) {
    if (error.code !== "authentication_required") setSessionsFeedback(error.message, true);
  } finally {
    state.sessionsBusy = false;
    controls.forEach((control) => { control.disabled = false; });
  }
}

function sessionRow(session) {
  const row = createElement("li", { className: "passkey-row" });
  const identity = createElement("div", { className: "passkey-identity" });
  identity.append(createElement("strong", { text: session.current ? `${session.agent} (this device)` : session.agent }));
  identity.append(createElement("small", {
    text: `Signed in ${passkeyDate(session.createdAt * 1000)} · last used ${passkeyDate(session.lastUsedAt * 1000)}`,
  }));
  const end = createElement("button", { className: "secondary-button passkey-remove", text: "Sign out" });
  end.type = "button";
  end.addEventListener("click", () => void sessionsAction(async () => {
    if (session.current) {
      await api("/api/auth/logout", { method: "POST", body: {} });
      sessionsDialog.close();
      signedOut();
      return;
    }
    await api("/api/auth/sessions/end", { method: "POST", body: { id: session.id } });
    setSessionsFeedback(`Signed out ${session.agent}.`);
    await loadSessions();
  }));
  row.append(identity, end);
  return row;
}

async function loadSessions() {
  const { sessions } = await api("/api/auth/sessions");
  const items = array(sessions);
  sessionsList.replaceChildren(...(items.length > 0
    ? items.map(sessionRow)
    : [createElement("li", { className: "passkey-empty", text: "Only sign-ins made since this list started are shown." })]));
}

async function showSessions() {
  setSessionsFeedback("");
  sessionsList.replaceChildren();
  sessionsDialog.showModal();
  await sessionsAction(loadSessions);
}

// Even when the server cannot be told, this window forgets its launch token,
// so it is signed out here either way.
async function signOut() {
  await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
  signedOut();
}

function signedOut() {
  state.launchToken = clearLaunchToken(launchSessionStorage);
  showLogin();
}

// Passkeys. The server lists each one by name, dates and a handle; credential
// IDs and public keys never leave it.
const passkeysDialog = document.querySelector("#passkeys-dialog");
const passkeysList = document.querySelector("#passkeys-list");
const passkeysFeedback = document.querySelector("#passkeys-feedback");
// Adding or removing asks for the password in a window of its own, opened by
// the button that needs it, so no password field sits under the list.
const passkeyPasswordDialog = document.querySelector("#passkey-password-dialog");
const passkeyPasswordForm = document.querySelector("#passkey-password-form");
const passkeyPasswordInput = document.querySelector("#passkey-password-input");
const passkeyPasswordFeedback = document.querySelector("#passkey-password-feedback");
const passkeyPasswordConfirm = document.querySelector("#passkey-password-confirm");
let passkeyPasswordRun = null;

function setPasskeysFeedback(text, isError = false) {
  passkeysFeedback.textContent = text;
  passkeysFeedback.dataset.error = String(isError);
}

function passkeyDate(value) {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function passkeysAction(work) {
  if (state.passkeyBusy) return;
  state.passkeyBusy = true;
  const controls = passkeysDialog.querySelectorAll("button, input");
  controls.forEach((control) => { control.disabled = true; });
  try {
    await work();
  } catch (error) {
    setPasskeysFeedback(passkeyErrorMessage(error), true);
  } finally {
    state.passkeyBusy = false;
    controls.forEach((control) => { control.disabled = false; });
    renderLoginMethods();
  }
}


function passkeyRow(passkey) {
  const row = createElement("li", { className: "passkey-row" });
  const identity = createElement("div", { className: "passkey-identity" });
  identity.append(createElement("strong", { text: passkey.label || "Passkey" }));
  const details = passkeyDetails(passkey, passkeyDate);
  if (details) identity.append(createElement("small", { text: details }));
  const remove = createElement("button", { className: "secondary-button passkey-remove", text: "Remove" });
  remove.type = "button";
  remove.addEventListener("click", () => removePasskey(passkey));
  row.append(identity, remove);
  return row;
}

async function loadPasskeys() {
  const { passkeys } = await api("/api/auth/passkeys");
  const items = array(passkeys);
  state.passkeyAvailable = items.length > 0;
  passkeysList.replaceChildren(...(items.length > 0
    ? items.map(passkeyRow)
    : [createElement("li", { className: "passkey-empty", text: "No passkeys yet. Sign-in uses the password only." })]));
}

async function showPasskeys() {
  document.querySelector("#passkeys-add").hidden = !supportsPasskeys();
  setPasskeysFeedback("");
  passkeysList.replaceChildren();
  passkeysDialog.showModal();
  await passkeysAction(loadPasskeys);
}

// The window stays open while the change runs, so a wrong password is said
// there and can be typed again; it closes once the change is done. Reloading
// the list comes after that, so a failed reload never asks to redo a change
// that already happened.
function askPasskeyPassword({ title, text, confirmLabel, run, done }) {
  document.querySelector("#passkey-password-title").textContent = title;
  document.querySelector("#passkey-password-text").textContent = text;
  passkeyPasswordConfirm.textContent = confirmLabel;
  passkeyPasswordInput.value = "";
  passkeyPasswordFeedback.textContent = "";
  passkeyPasswordFeedback.dataset.error = "false";
  passkeyPasswordRun = { run, done };
  passkeyPasswordDialog.showModal();
}

passkeyPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.passkeyBusy || !passkeyPasswordRun) return;
  const password = enteredPassword(passkeyPasswordInput, passkeyPasswordFeedback);
  if (!password) return;
  state.passkeyBusy = true;
  const controls = [...passkeyPasswordDialog.querySelectorAll("button, input"), ...passkeysDialog.querySelectorAll("button")];
  controls.forEach((control) => { control.disabled = true; });
  passkeyPasswordFeedback.dataset.error = "false";
  const { run, done } = passkeyPasswordRun;
  let changed = false;
  try {
    await run(password);
    changed = true;
    passkeyPasswordDialog.close();
  } catch (error) {
    passkeyPasswordFeedback.textContent = passkeyErrorMessage(error);
    passkeyPasswordFeedback.dataset.error = "true";
  } finally {
    state.passkeyBusy = false;
    controls.forEach((control) => { control.disabled = false; });
    renderLoginMethods();
    if (passkeyPasswordDialog.open) passkeyPasswordInput.select();
  }
  if (changed) void passkeysAction(done);
});
document.querySelector("#passkey-password-cancel").addEventListener("click", () => {
  if (!state.passkeyBusy) passkeyPasswordDialog.close();
});
passkeyPasswordDialog.addEventListener("cancel", (event) => { if (state.passkeyBusy) event.preventDefault(); });
passkeyPasswordDialog.addEventListener("close", () => {
  passkeyPasswordInput.value = "";
  passkeyPasswordRun = null;
});

function removePasskey(passkey) {
  const name = passkey.label || "this passkey";
  askPasskeyPassword({
    title: "Remove passkey",
    text: `${name} can no longer sign in to this HerdRabbit, and every other signed-in device has to sign in again.`,
    confirmLabel: "Remove",
    run: async (password) => {
      const result = await api("/api/auth/passkeys/remove", {
        method: "POST",
        body: { handle: passkey.handle, password },
      });
      // Removing signed every session out; the server sent this window a new one.
      state.launchToken = writeLaunchToken(launchSessionStorage, result.launchToken);
    },
    done: async () => {
      await loadPasskeys();
      setPasskeysFeedback(`Removed ${name}.`);
    },
  });
}

document.querySelector("#passkeys-add").addEventListener("click", () => {
  if (!supportsPasskeys()) return;
  askPasskeyPassword({
    title: "Add passkey",
    text: "After the password, follow the prompt on your device.",
    confirmLabel: "Continue",
    run: async (password) => {
      passkeyPasswordFeedback.textContent = "Follow the prompt on your device…";
      await registerPasskey(password);
    },
    done: async () => {
      await loadPasskeys();
      setPasskeysFeedback("Passkey added.");
    },
  });
});
document.querySelector("#passkeys-close").addEventListener("click", () => {
  if (!state.passkeyBusy) passkeysDialog.close();
});
// Escape would close the dialog under a ceremony still running.
passkeysDialog.addEventListener("cancel", (event) => { if (state.passkeyBusy) event.preventDefault(); });

// AI accounts. The server says whose account each saved sign-in is and never
// hands over a credential; this dialog only asks it to save, sign in, switch
// or remove.
const aiAccountsDialog = document.querySelector("#ai-accounts-dialog");
const aiAccountsList = document.querySelector("#ai-accounts-list");
const aiAccountsFeedback = document.querySelector("#ai-accounts-feedback");
const aiAccountsLogin = document.querySelector("#ai-accounts-login");
// highlight names the account a sign-in just saved, marked until the dialog closes.
const aiAccounts = { server: null, busy: false, highlight: null };
// A sign-in outlives the dialog: it closes so the terminal can be used. The
// sign-in directory gains its credential files the moment the CLI is signed in,
// and finishing is what checks for them, so asking every few seconds saves the
// account without anyone pressing anything.
const pendingAiLogins = new Map();
// A list fetched a moment before a sign-in was saved still names it; these are
// never taken up again from such a list.
const finishedAiLogins = new Set();
const AI_LOGIN_CHECK_MS = 3_000;
const AI_LOGIN_GIVE_UP_MS = 20 * 60_000;

function setAiAccountsFeedback(text, isError = false) {
  aiAccountsFeedback.textContent = text;
  aiAccountsFeedback.dataset.error = String(isError);
}

async function aiAccountsAction(work) {
  if (aiAccounts.busy) return;
  aiAccounts.busy = true;
  aiAccountsDialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await work();
  } catch (error) {
    setAiAccountsFeedback(error.message, true);
  } finally {
    aiAccounts.busy = false;
    aiAccountsDialog.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

function aiButton(text, onClick, className = "secondary-button") {
  const button = createElement("button", { className, text });
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

// One row per account: its email, and what can be done with it. In use needs
// nothing; any other account has one menu holding Switch and Remove.
function aiAccountRow(cli, account) {
  const added = Boolean(account.id) && account.id === aiAccounts.highlight;
  const row = createElement("li", { className: `ai-account-row${account.active ? " is-active" : ""}${added ? " is-new" : ""}` });
  const identity = createElement("div", { className: "ai-account-identity" });
  identity.append(createElement("strong", { text: account.email || "Unknown account" }));
  if (added) identity.append(createElement("small", { className: "is-new", text: "Just added" }));
  const notice = aiAccountNotice(account);
  if (notice) identity.append(createElement("small", { className: "is-expiring", text: notice }));
  const box = createElement("div", { className: "ai-account-actions" });
  if (account.active) {
    box.append(createElement("span", { className: "ai-account-state", text: "In use" }));
  } else if (cli.supported && account.id) {
    box.append(sidebarActionMenu({
      id: `ai-account-${account.id}`,
      label: `Actions for ${account.email || "this account"}`,
      escapesOverflow: true,
      actions: [
        {
          label: "Switch",
          paths: ["M7 7h11l-3-3", "M17 17H6l3 3"],
          onSelect: () => void aiAccountsAction(() => switchAiAccount(cli, account, false)),
        },
        {
          label: "Remove",
          paths: ["M6 6l12 12M18 6 6 18"],
          danger: true,
          onSelect: () => removeAiAccount(cli, account),
        },
      ],
    }));
  }
  row.append(identity, box);
  return row;
}

function renderAiAccounts(clis) {
  aiAccountsList.replaceChildren();
  for (const cli of clis) {
    const section = createElement("section", { className: "ai-cli" });
    section.append(createElement("h3", { text: cli.label }));
    if (cli.reason) {
      const note = createElement("p", { className: "dialog-feedback", text: cli.reason });
      note.dataset.error = String(!cli.supported);
      section.append(note);
    }
    const rows = createElement("ul", { className: "ai-account-rows" });
    const accounts = array(cli.accounts);
    // Saved on open, so this only shows when saving was not possible.
    if (cli.current && !accounts.some((account) => account.active)) accounts.unshift(cli.current);
    for (const account of sortAiAccounts(accounts)) rows.append(aiAccountRow(cli, account));
    if (cli.supported) {
      const add = createElement("li", { className: "ai-account-add-row" });
      add.append(aiButton("+ Add account", () => void aiAccountsAction(() => startAiLogin(cli)), "ai-account-add"));
      rows.append(add);
    }
    if (rows.children.length > 0) section.append(rows);
    aiAccountsList.append(section);
  }
}

async function loadAiAccounts() {
  const server = aiAccounts.server;
  const list = () => api(`/api/ai-accounts?server=${encodeURIComponent(server.id)}`);
  let payload = await list();
  const unsaved = aiAccountsToSave(array(payload.clis));
  if (unsaved.length > 0) {
    for (const cli of unsaved) {
      await api("/api/ai-accounts/current", { method: "POST", body: { server: server.id, cli } });
    }
    payload = await list();
  }
  settleAiLogins(server, array(payload.clis));
  renderAiLogin();
  renderAiAccounts(array(payload.clis));
  setAiAccountsFeedback("");
}

// The server's list is what is true about sign-ins. A wait it no longer lists
// was saved or cancelled elsewhere, so it ends here too; one it still lists and
// this page is not waiting on is taken up.
function settleAiLogins(server, clis) {
  const open = new Set(clis.flatMap((cli) => array(cli.logins)));
  const pending = pendingAiLogins.get(server.id);
  if (pending && !open.has(pending.loginId)) {
    window.clearInterval(pending.timer);
    pendingAiLogins.delete(server.id);
  }
  adoptAiLogins(server, clis);
}

// The server keeps which sign-ins are still open, so a page that reloaded while
// one was waiting takes the wait back up instead of losing it. The sign-in's
// project carries the first characters of its id, which is how it is found to
// be closed again when the account is saved.
function adoptAiLogins(server, clis) {
  if (pendingAiLogins.has(server.id)) return;
  for (const cli of clis) {
    const loginId = array(cli.logins).find((id) => !finishedAiLogins.has(id));
    if (!loginId) continue;
    const tag = `(${loginId.slice(6, 14)})`;
    const workspace = snapshotRecords().workspaces.find((item) => isAiLoginWorkspace(item) &&
      (item.server_id ?? "local") === server.id && String(item.label).endsWith(tag));
    const login = { cli: cli.id, label: cli.label, loginId, workspaceId: workspace?.workspace_id, timer: null };
    pendingAiLogins.set(server.id, login);
    watchAiLogin(server, login);
    return;
  }
}

// On a fresh page, an open sign-in project means a wait was cut short by the
// reload; its server is asked which sign-ins are still open.
async function resumeAiLogins() {
  const serverIds = new Set(snapshotRecords().workspaces.filter(isAiLoginWorkspace)
    .map((workspace) => workspace.server_id ?? "local"));
  for (const serverId of serverIds) {
    if (pendingAiLogins.has(serverId)) continue;
    const server = snapshotRecords().servers.find((item) => item.id === serverId) ?? { id: serverId, name: serverId };
    try {
      const payload = await api(`/api/ai-accounts?server=${encodeURIComponent(serverId)}`);
      adoptAiLogins(server, array(payload.clis));
    } catch {
      // Opening AI accounts for that server asks again.
    }
  }
}

function renderAiLogin() {
  const login = aiAccounts.server ? pendingAiLogins.get(aiAccounts.server.id) : null;
  aiAccountsLogin.hidden = !login;
  if (!login) return;
  const codexHint = login.cli === "codex" ? " Device code sign-in must be on in ChatGPT settings." : "";
  document.querySelector("#ai-accounts-login-text").textContent =
    `Waiting for ${login.label} to be signed in in the “AI login” terminal. It is saved as soon as you are.${codexHint}`;
}

// Asks the server to finish the sign-in until it can. "Not yet" is the answer
// while the terminal is still waiting; any other refusal ends the wait.
function watchAiLogin(server, login) {
  const startedAt = Date.now();
  let checking = false;
  const stop = () => {
    window.clearInterval(login.timer);
    if (pendingAiLogins.get(server.id) === login) pendingAiLogins.delete(server.id);
    if (aiAccounts.server?.id === server.id) renderAiLogin();
  };
  login.timer = window.setInterval(() => {
    if (checking) return;
    if (Date.now() - startedAt > AI_LOGIN_GIVE_UP_MS) {
      stop();
      setFeedback(`Stopped waiting for the ${login.label} sign-in. Add the account again to retry.`, true);
      return;
    }
    checking = true;
    void api(`/api/ai-accounts/logins/${login.loginId}/finish`, {
      method: "POST",
      body: { server: server.id, cli: login.cli, workspaceId: login.workspaceId },
    }).then(async (payload) => {
      finishedAiLogins.add(login.loginId);
      stop();
      if (payload.snapshot) adoptMutationSnapshot(payload.snapshot);
      const saved = `Saved ${payload.account.email} for ${login.label}.`;
      setFeedback(saved);
      // The sign-in's terminal has just closed under the person using it, so the
      // account list comes back to show what was saved -- unless something else
      // is open over the page, which it would push aside.
      const elsewhere = [...document.querySelectorAll("dialog[open]")].some((dialog) => dialog !== aiAccountsDialog) ||
        (aiAccountsDialog.open && aiAccounts.server?.id !== server.id);
      if (elsewhere) return;
      aiAccounts.highlight = payload.account.id;
      if (aiAccountsDialog.open) await aiAccountsAction(loadAiAccounts);
      else await showAiAccounts(snapshotRecords().servers.find((item) => item.id === server.id) ?? server);
      if (aiAccountsFeedback.dataset.error !== "true") setAiAccountsFeedback(saved);
    }, (error) => {
      if (error.code === "login_incomplete") return;
      stop();
      if (error.code !== "login_not_found") setFeedback(error.message, true);
    }).finally(() => { checking = false; });
  }, AI_LOGIN_CHECK_MS);
}

function showAiAccounts(server) {
  aiAccounts.server = server;
  aiAccountsList.replaceChildren();
  document.querySelector("#ai-accounts-title").textContent = `AI accounts · ${server.name}`;
  renderAiLogin();
  setAiAccountsFeedback("Loading accounts…");
  aiAccountsDialog.showModal();
  return aiAccountsAction(loadAiAccounts);
}

async function startAiLogin(cli) {
  const server = aiAccounts.server;
  if (pendingAiLogins.has(server.id)) {
    renderAiLogin();
    throw new Error("A sign-in is already open. Finish it in its terminal or cancel it.");
  }
  const herdrSessionId = aiLoginSessionId(server.id, snapshotRecords().herdrSessions);
  if (!herdrSessionId) throw new Error(`${server.name} has no running Herdr session to sign in from.`);
  const payload = await api("/api/ai-accounts/logins", {
    method: "POST",
    body: { server: server.id, cli: cli.id, herdrSessionId },
  });
  const login = { cli: cli.id, label: cli.label, loginId: payload.loginId, workspaceId: payload.workspaceId, timer: null };
  pendingAiLogins.set(server.id, login);
  watchAiLogin(server, login);
  adoptMutationSnapshot(payload.snapshot || state.snapshot, payload.paneId);
  aiAccountsDialog.close();
  closeMobileSidebar();
  setFeedback(`Sign in to ${cli.label} in this terminal. The account is saved as soon as you are signed in.`);
}

async function cancelAiLogin() {
  const server = aiAccounts.server;
  const login = pendingAiLogins.get(server.id);
  if (!login) return;
  window.clearInterval(login.timer);
  pendingAiLogins.delete(server.id);
  renderAiLogin();
  try {
    const payload = await api(`/api/ai-accounts/logins/${login.loginId}/cancel`, {
      method: "POST",
      body: { server: server.id, cli: login.cli, workspaceId: login.workspaceId },
    });
    if (payload.snapshot) adoptMutationSnapshot(payload.snapshot);
  } catch (error) {
    if (error.code !== "login_not_found") throw error;
  }
  await loadAiAccounts();
  setAiAccountsFeedback("Sign-in cancelled.");
}

async function switchAiAccount(cli, account, confirmRunning = false) {
  try {
    await api("/api/ai-accounts/switch", {
      method: "POST",
      body: { server: aiAccounts.server.id, cli: cli.id, account: account.id, confirmRunning },
    });
  } catch (error) {
    if (error.code !== "agents_running" || confirmRunning) throw error;
    // Asked apart from the list, like every other confirmation here, so the
    // warning cannot be read past on the way to the next account.
    const panes = array(error.details?.panes).map((pane) => `• ${pane.label || pane.paneId}`);
    if (!window.confirm([
      `${cli.label} is running on ${aiAccounts.server.name}. These keep the old account until restarted:`,
      ...panes,
      "",
      "Switch anyway?",
    ].join("\n"))) {
      setAiAccountsFeedback("");
      return;
    }
    await switchAiAccount(cli, account, true);
    return;
  }
  await loadAiAccounts();
  setAiAccountsFeedback(`Now using ${account.email}. Restart with ${aiRestartHint(cli.id)}.`);
}

function removeAiAccount(cli, account) {
  if (!window.confirm(`Remove ${account.email} from ${cli.label} on ${aiAccounts.server.name}? Using it here again needs a new sign-in.`)) return;
  void aiAccountsAction(async () => {
    await api("/api/ai-accounts/remove", {
      method: "POST",
      body: { server: aiAccounts.server.id, cli: cli.id, account: account.id },
    });
    await loadAiAccounts();
    setAiAccountsFeedback(`Removed ${account.email}.`);
  });
}

document.querySelector("#ai-accounts-close").addEventListener("click", () => aiAccountsDialog.close());
aiAccountsDialog.addEventListener("close", () => { aiAccounts.highlight = null; });
document.querySelector("#ai-accounts-login-cancel")
  .addEventListener("click", () => void aiAccountsAction(cancelAiLogin));

function serverActionMenu(server) {
  const actions = [
    {
      label: "Details",
      paths: ["M12 8h.01", "M11 12h1v4h1", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
      onSelect: () => showServerDetails(server),
    },
    // A Herdr SSH machine has no account switching yet.
    ...(server.transport === "machine" ? [] : [{
      label: "AI accounts",
      paths: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 20a8 8 0 0 1 16 0"],
      onSelect: () => showAiAccounts(server),
    }]),
  ];
  // Sign-in belongs to the HerdRabbit the browser is talking to; a linked
  // machine has none.
  // Removing needs no WebAuthn, so a browser without it still gets the list:
  // that is how a lost device's passkey is taken off from another one.
  if (server.id === "local" && state.authRequired) {
    actions.push({
      label: "Passkeys",
      paths: ["M8 15a4 4 0 1 1 3.9-5H21v3h-2v2h-3v-2h-4.1A4 4 0 0 1 8 15Z", "M8 11h.01"],
      onSelect: () => void showPasskeys(),
    }, {
      label: "Signed-in devices",
      paths: ["M4 5h16v10H4z", "M8 19h8", "M12 15v4"],
      onSelect: () => void showSessions(),
    }, {
      label: "Sign out",
      paths: ["M15 12H4", "M8 8l-4 4 4 4", "M12 4h7v16h-7"],
      onSelect: () => void signOut(),
    });
  }
  if (server.id === "local" && state.pushSubscription !== null) {
    actions.push({
      label: "Send test notification",
      paths: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10 21h4"],
      onSelect: () => void api("/api/push/test", { method: "POST", body: {} })
        .then(() => setFeedback("Test notification sent."))
        .catch((error) => setFeedback(`Could not send a test notification: ${error.message}`, true)),
    });
  }
  if (server.id === "local") {
    const on = readAlertSound(panePreferenceStorage);
    actions.push({
      label: on ? "Turn alert sound off" : "Turn alert sound on",
      paths: on ? ["M11 5 6 9H2v6h4l5 4V5Z", "M15.5 8.5a5 5 0 0 1 0 7"] : ["M11 5 6 9H2v6h4l5 4V5Z", "M22 9l-6 6", "M16 9l6 6"],
      onSelect: () => { writeAlertSound(panePreferenceStorage, !on); renderNavigation(); },
    });
  }
  // This machine is not a connection: there is nothing to rename or drop.
  if (server.id === "local") {
    return sidebarActionMenu({
      id: `server-${server.id}`,
      label: `More actions for ${server.name}`,
      className: "server-action-menu",
      actions,
    });
  }
  // Herdr's own SSH machines are managed with `herdr machine`, so Herdr's TUI
  // shows the same list.
  if (server.transport === "machine") {
    const machineAction = (method, path, prompt) => () => {
      if (prompt && !window.confirm(prompt)) return;
      void api(path, { method, body: method === "DELETE" ? undefined : {} })
        .then(() => refreshSnapshot())
        .catch((error) => setFeedback(error.message, true));
    };
    actions.push(
      {
        label: "Rename",
        paths: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z", "M14.5 7.5l3 3"],
        onSelect: () => { state.editingServerId = server.id; renderNavigation(); },
      },
      server.enabled === false ? {
        label: "Turn on",
        paths: ["M12 3v9", "M6.3 7.3a8 8 0 1 0 11.4 0"],
        onSelect: machineAction("POST", `/api/machines/${server.id}/enable`),
      } : {
        label: "Turn off",
        paths: ["M12 3v9", "M6.3 7.3a8 8 0 1 0 11.4 0"],
        onSelect: machineAction("POST", `/api/machines/${server.id}/disable`,
          `Turn off “${server.name}”? It stays listed here, and Turn on connects it again.`),
      },
      {
        label: "Remove",
        paths: ["M6 6l12 12M18 6 6 18"],
        danger: true,
        onSelect: machineAction("DELETE", `/api/machines/${server.id}`,
          `Remove “${server.name}” from Herdr's machines? Its sessions keep running there.`),
      },
    );
    return sidebarActionMenu({
      id: `server-${server.id}`,
      label: `More actions for ${server.name}`,
      className: "server-action-menu",
      actions,
    });
  }
  // A machine that moved to another port leaves its entry pointing at the old
  // one, offline for good. The tailnet address says they are the same machine,
  // so looking again can answer an entry that cannot connect.
  if (!server.available) {
    actions.push({
      label: "Find new address",
      paths: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 4v5h-5"],
      onSelect: () => void (async () => {
        try {
          setFeedback(`Looking for ${server.name}…`);
          const found = await api("/api/servers/discover", { method: "POST", body: {} });
          const host = new URL(server.address).hostname;
          const moved = array(found.candidates).find((candidate) =>
            candidate.state === "ready" && candidate.address !== server.address &&
            new URL(candidate.address).hostname === host);
          if (!moved) {
            setFeedback(`${server.name} is not answering anywhere on ${host}.`, true);
            return;
          }
          await api(`/api/servers/${server.id}`, {
            method: "PUT", body: { name: server.name, address: moved.address },
          });
          await loadServers();
          await refreshSnapshot();
          setFeedback(`${server.name} now points at ${moved.address}.`);
        } catch (error) {
          setFeedback(error.message, true);
        }
      })(),
    });
  }
  actions.push(
    {
      label: "Rename",
      paths: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z", "M14.5 7.5l3 3"],
      onSelect: () => { state.editingServerId = server.id; renderNavigation(); },
    },
    {
      label: "Disconnect",
      paths: ["M6 6l12 12M18 6 6 18"],
      danger: true,
      onSelect: () => {
        if (!window.confirm(`Disconnect “${server.name}”? Its sessions keep running.`)) return;
        void (async () => {
          try {
            await api(`/api/servers/${server.id}`, { method: "DELETE" });
            await loadServers();
            await refreshSnapshot();
          } catch (error) {
            setFeedback(error.message, true);
          }
        })();
      },
    },
  );
  return sidebarActionMenu({
    id: `server-${server.id}`,
    label: `More actions for ${server.name}`,
    className: "server-action-menu",
    actions,
  });
}

// A session shows the agent that happens to be running in it, which is not a
// name: it changes under you and two of them read alike. A tab starts out
// numbered, and the number is hidden, so this is the only way to give one.
function tabRenameForm(tab, tabId, tabLabel) {
  // Emptying the field is how a name is taken back off: the session goes back
  // to showing the agent, which is what it showed before it was named.
  const cleared = clearedTabLabel(tab);
  return renameForm({
    value: tabLabel,
    label: "Session name",
    placeholder: cleared === null ? "Session name" : "Session name — empty to clear",
    maxLength: 120,
    invalidMessage: "Enter a session name.",
    allowEmpty: cleared !== null,
    onCancel: () => { state.editingTabId = null; renderNavigation(); },
    onSubmit: async (typed) => {
      const label = typed || cleared;
      await api(`/api/tabs/${encodeURIComponent(tabId)}/rename`, {
        method: "POST",
        body: { label },
      });
      tab.label = label;
      state.editingTabId = null;
      renderNavigation();
      const selected = selectedRecords();
      renderPaneHeading(selected.pane, selected.tab, selected.workspace);
    },
  });
}

// Every redraw of the sidebar asks this, because every redraw would otherwise
// throw away a name being typed. It also clears a rename whose record is gone,
// so a closed session cannot leave the sidebar frozen on its form.
function renameIsOpen() {
  const open = openRenames(
    {
      workspaceId: state.editingWorkspaceId,
      tabId: state.editingTabId,
      serverId: state.editingServerId,
    },
    snapshotRecords(),
  );
  state.editingWorkspaceId = open.workspaceId;
  state.editingTabId = open.tabId;
  state.editingServerId = open.serverId;
  return open.any;
}

function renderNavigation() {
  const { servers, herdrSessions, workspaces, tabs, panes } = snapshotRecords();
  elements.workspaceList.replaceChildren();
  // Shown even for this machine alone: its row is where the machine is managed,
  // AI accounts included.
  const showServers = servers.length > 0;
  const serverGroups = new Map();
  if (showServers) {
    for (const server of servers) {
      const group = createElement("section", { className: "server-group" });
      const editingServer = state.editingServerId === server.id;
      const connection = serverConnection(server);
      const heading = createElement("div", {
        className: `server-heading${connection.online ? " is-online" : ""}${connection.error ? " is-error" : ""}${editingServer ? " is-editing" : ""}`,
      });
      heading.dataset.serverId = server.id;
      heading.dataset.serverName = server.name;
      heading.title = `${server.name}: ${connection.text}`;
      heading.setAttribute("aria-label", heading.title);
      heading.append(createIcon(["M4 5h16v11H4z", "M9 20h6", "M12 16v4"], "server-icon"));
      if (editingServer) heading.append(serverRenameForm(server));
      else {
        heading.append(createElement("strong", { text: server.name }));
        // The dot already says "connected", in the one colour the sidebar uses
        // for it. Words are kept for the states the colour cannot tell apart.
        if (!server.available) {
          heading.append(createElement("small", {
            text: server.status === "Connecting" ? "Connecting" : "Offline",
          }));
        }
        // A server is managed where it is seen. The dialog is for adding one.
        heading.append(serverActionMenu(server));
      }
      group.append(heading);
      const body = createElement("div", { className: "server-body" });
      if (!server.available || !herdrSessions.some((session) => session.server_id === server.id)) {
        body.append(createElement("p", { className: "server-empty", text: server.available ? "No Herdr sessions. Start Herdr on this server." : server.status }));
      }
      group.append(body);
      attachGroupCollapse(group, heading, body, `server:${server.id}`, server.name);
      serverGroups.set(server.id, body);
      elements.workspaceList.append(group);
    }
  }
  // A session heading earns its place only when there is something to tell
  // apart: more than one session on a server, or one that is not running. With
  // servers shown, the server heading already says which machine this is.
  const sessionsPerServer = new Map();
  for (const session of herdrSessions) {
    const id = session.server_id || "local";
    sessionsPerServer.set(id, (sessionsPerServer.get(id) || 0) + 1);
  }
  const showHerdrSessionGroups = [...sessionsPerServer.values()].some((count) => count > 1) ||
    herdrSessions.some((session) => session.available !== true);

  const appendWorkspace = (parent, workspace) => {
    const workspaceId = idOf(workspace, "workspace_id", "id");
    const group = createElement("section", { className: "workspace-group" });
    const workspaceLabel = displayRecordLabel(workspace, "Project");
    const workspaceTabs = tabs.filter(
      (tab) => idOf(tab, "workspace_id", "workspaceId") === workspaceId,
    );
    const workspaceTabIds = new Set(
      workspaceTabs.map((tab) => idOf(tab, "tab_id", "id")),
    );
    const hasCompletion = panes.some((pane) => {
      if (!workspaceTabIds.has(idOf(pane, "tab_id", "tabId"))) return false;
      const paneId = idOf(pane, "pane_id", "id");
      return visibleStatusForPane(paneId, agentForPane(paneId), pane) === "done";
    });
    const hasRequest = panes.some((pane) => {
      if (!workspaceTabIds.has(idOf(pane, "tab_id", "tabId"))) return false;
      const paneId = idOf(pane, "pane_id", "id");
      return visibleStatusForPane(paneId, agentForPane(paneId), pane) === "blocked";
    });
    const children = createElement("div", { className: "workspace-children" });
    children.id = `workspace-${workspaceId}-children`;
    const childrenInner = createElement("div", {
      className: "workspace-children-inner",
    });
    const collapsed = state.collapsedWorkspaceIds.has(workspaceId);
    group.classList.toggle("is-collapsed", collapsed);
    group.dataset.hasCompletion = String(hasCompletion);
    group.dataset.hasRequest = String(hasRequest);
    children.inert = collapsed;
    children.setAttribute("aria-hidden", String(collapsed));
    group.append(workspaceHeading(group, workspace, workspaceLabel, children));

    for (const tab of workspaceTabs) {
      const tabId = idOf(tab, "tab_id", "id");
      const tabGroup = createElement("div", { className: "tab-group" });
      const tabLabel = displayTabLabel(tab);
      const editingTab = state.editingTabId === tabId;
      const tabPanes = panes.filter((pane) => idOf(pane, "tab_id", "tabId") === tabId);
      // With one pane the pane is the session, so its name belongs in the
      // button. With several the name covers the group, and repeating it on
      // every button would say the same thing three times.
      const namesSession = Boolean(tabLabel) && tabPanes.length === 1;
      const tabHeading = createElement("div", {
        className: `tab-heading${editingTab ? " is-editing" : ""}`,
      });
      // An unnamed session has no heading to rename in, so renaming makes one.
      if (editingTab) tabHeading.append(tabRenameForm(tab, tabId, tabLabel));
      else if (tabLabel && !namesSession) {
        tabHeading.append(createElement("p", { className: "tab-label", text: tabLabel }));
      }
      if (tabHeading.childElementCount > 0) tabGroup.append(tabHeading);

      const sessionRow = createElement("div", { className: "session-row" });
      const sessionPanes = createElement("div", { className: "session-panes" });
      for (const pane of tabPanes) {
        sessionPanes.append(paneButton(pane, tab, workspace, { namesSession }));
      }
      const sessionLabel =
        tabLabel ||
        displayRecordLabel(agentForPane(idOf(tabPanes[0], "pane_id", "id")), "Session");
      const sessionMenu = sidebarActionMenu({
        id: `tab-${tabId}`,
        label: `More actions for ${sessionLabel}`,
        className: "session-action-menu",
        actions: [
          {
            label: "Rename",
            paths: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z", "M14.5 7.5l3 3"],
            onSelect: () => {
              state.editingTabId = tabId;
              setFeedback("");
              renderNavigation();
            },
          },
          {
            label: "Close session",
            paths: ["M6 6l12 12M18 6 6 18"],
            danger: true,
            onSelect: (button) => void closeSession(
              tab,
              sessionLabel,
              button,
            ),
          },
        ],
      });
      sessionRow.append(sessionPanes, sessionMenu);
      tabGroup.append(sessionRow);
      childrenInner.append(tabGroup);
    }
    children.append(childrenInner);
    group.append(children);
    parent.append(group);
  };

  if (!showHerdrSessionGroups && workspaces.length === 0) {
    const empty = createElement("p", {
      className: "empty-state",
      text: "No open projects.",
    });
    elements.workspaceList.append(empty);
    return;
  }

  if (showHerdrSessionGroups) {
    for (const session of herdrSessions) {
      const sessionId = idOf(session, "session_id", "id");
      const sessionGroup = createElement("section", {
        className: "herdr-session-group",
      });
      const sessionHeading = createElement("div", {
        className: "herdr-session-heading",
      });
      const status = session.available === true
        ? "Running"
        : session.running === true ? "Connection failed" : "Stopped";
      const statusDot = createElement("span", {
        className: `herdr-session-dot${
          session.available === true
            ? " is-online"
            : session.running === true ? " is-error" : ""
        }`,
      });
      statusDot.setAttribute("aria-hidden", "true");
      sessionHeading.setAttribute("aria-label", `Herdr ${session.name}, ${status}`);
      sessionHeading.title = status;
      sessionHeading.append(
        statusDot,
        createElement("strong", { text: session.name }),
        createElement("small", { text: status }),
      );
      sessionGroup.append(sessionHeading);
      const sessionBody = createElement("div", { className: "herdr-session-body" });

      const sessionWorkspaces = workspaces.filter(
        (workspace) => idOf(
          workspace,
          "herdr_session_id",
          "herdrSessionId",
        ) === sessionId,
      );
      if (sessionWorkspaces.length === 0) {
        sessionBody.append(createElement("p", {
          className: "herdr-session-empty",
          text: session.available === true ? "No open projects" : status,
        }));
      } else {
        for (const workspace of sessionWorkspaces) {
          appendWorkspace(sessionBody, workspace);
        }
      }
      sessionGroup.append(sessionBody);
      attachGroupCollapse(
        sessionGroup,
        sessionHeading,
        sessionBody,
        `session:${sessionId}`,
        displayRecordLabel(session, "Herdr session"),
      );
      (serverGroups.get(session.server_id) || elements.workspaceList).append(sessionGroup);
    }
    return;
  }

  // Without session headings the projects still belong to a machine, so they go
  // inside that server's body. Appending them to the list itself would leave
  // them as siblings of the server heading, which then collapses over nothing.
  for (const workspace of workspaces) {
    appendWorkspace(serverGroups.get(workspace.server_id) || elements.workspaceList, workspace);
  }
}

function renderPaneHeading(pane, tab, workspace) {
  renderTerminalLive();
  syncAttachAvailability();
  if (modifierPaneId !== state.selectedPaneId) clearKeyModifiers();
  if (!pane) {
    elements.paneContext.textContent = "Select a pane";
    elements.paneTitle.textContent = "Terminal";
    return;
  }

  const paneId = idOf(pane, "pane_id", "id");
  const agent = agentForPane(paneId);
  const workspaceLabel = displayRecordLabel(workspace, "Project");
  const tabLabel = displayTabLabel(tab);

  const sessionName = typeof pane.herdr_session_name === "string"
    ? pane.herdr_session_name
    : "";
  const herdrSessions = snapshotRecords().herdrSessions;
  const showSessionName = herdrSessions.length > 1 ||
    (herdrSessions.length === 1 && herdrSessions[0].available !== true);
  elements.paneContext.textContent = [
    snapshotRecords().servers.length > 1 ? pane.server_name : "",
    showSessionName ? sessionName : "",
    workspaceLabel,
    tabLabel,
  ].filter(Boolean).join(" / ");
  elements.paneTitle.textContent = displayRecordLabel(
    agent,
    displayRecordLabel(pane, "Terminal"),
  );
}

// An agent names files as it works -- "wrote src/api.mjs", "see ./docs/plan.md"
// -- and on a phone the only way to look at one was to go find it in the tree.
// A named file that this app can show becomes a link to it.
//
// Relative names are resolved against the pane's own directory, because that is
// what the agent writing them meant. `~` is not resolved: that home belongs to
// the machine the pane runs on, and guessing it would open the wrong file or
// none. A path that cannot be resolved is left as plain text rather than
// offered as a link that fails when pressed.
function resolveTerminalPath(raw) {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("~")) return null;
  const pane = selectedRecords().pane;
  const base = pane?.foreground_cwd || pane?.cwd;
  if (typeof base !== "string" || !base.startsWith("/")) return null;
  // `..` and `.` survive as they are: the machine that opens this resolves it.
  return `${base.replace(/\/+$/u, "")}/${raw.replace(/^\.\//u, "")}`;
}

function isViewableTerminalPath(raw) {
  return previewFor(raw.split("/").pop()) !== null && resolveTerminalPath(raw) !== null;
}

function openTerminalPath(raw) {
  const resolved = resolveTerminalPath(raw);
  if (!resolved) return;
  const name = resolved.split("/").pop();
  void viewFile(resolved, name, paneServerId(state.selectedPaneId) || "local");
}

function terminalPathLink(raw) {
  const link = createElement("a", { className: "terminal-link terminal-path" });
  link.href = "#";
  link.title = `View ${raw}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openTerminalPath(raw);
  });
  return link;
}

function renderAnsiOutput(value) {
  const fragment = document.createDocumentFragment();
  const visibleOutput = terminalOutputForEnvironment(value, {
    touchInput: usesTouchInputEnvironment(),
  });
  let linkElement = null;
  let linkStart = null;
  const segments = linkTerminalSegments(ansiToSegments(visibleOutput), {
    isViewablePath: isViewableTerminalPath,
  });
  for (const segment of segments) {
    const linked = segment.href || segment.path;
    if (linked && segment.linkStart !== linkStart) {
      if (segment.href) {
        linkElement = document.createElement("a");
        linkElement.href = segment.href;
        linkElement.target = "_blank";
        linkElement.rel = "noopener noreferrer";
        linkElement.className = "terminal-link";
        linkElement.title = segment.href;
      } else {
        linkElement = terminalPathLink(segment.path);
      }
      linkStart = segment.linkStart;
      fragment.append(linkElement);
    } else if (!linked) {
      linkElement = null;
      linkStart = null;
    }
    const parent = linkElement || fragment;
    const hasStyle =
      segment.bold ||
      segment.dim ||
      segment.italic ||
      segment.underline ||
      segment.inverse ||
      segment.foreground ||
      segment.background;
    if (!hasStyle) {
      parent.append(document.createTextNode(segment.text));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = segment.text;
    span.classList.toggle("ansi-bold", segment.bold);
    span.classList.toggle("ansi-dim", segment.dim);
    span.classList.toggle("ansi-italic", segment.italic);
    span.classList.toggle("ansi-underline", segment.underline);
    let foreground = segment.foreground;
    let background = segment.background;
    if (segment.inverse) {
      [foreground, background] = [
        background || "var(--terminal-bg)",
        foreground || "var(--terminal-text)",
      ];
    }
    if (foreground) {
      span.classList.add("ansi-foreground");
      span.style.setProperty("--ansi-foreground", foreground);
    }
    if (background) {
      span.classList.add("ansi-background");
      span.style.setProperty("--ansi-background", background);
    }
    parent.append(span);
  }
  elements.terminalOutput.replaceChildren(fragment);
}

function showTerminalMessage(message) {
  elements.terminalOutput.textContent = message;
  state.renderedPaneId = null;
  state.renderedOutput = null;
}

function terminalHasSelection() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return (
    elements.terminalOutput.contains(selection.anchorNode) ||
    elements.terminalOutput.contains(selection.focusNode)
  );
}

function selectedRecords() {
  const { workspaces, tabs, panes } = snapshotRecords();
  const pane = panes.find((item) => idOf(item, "pane_id", "id") === state.selectedPaneId);
  const tabId = idOf(pane, "tab_id", "tabId");
  const tab = tabs.find((item) => idOf(item, "tab_id", "id") === tabId);
  const workspaceId = idOf(tab, "workspace_id", "workspaceId") || idOf(pane, "workspace_id");
  const workspace = workspaces.find(
    (item) => idOf(item, "workspace_id", "id") === workspaceId,
  );
  return { pane, tab, workspace };
}

function selectedAgentStatus() {
  const { pane } = selectedRecords();
  return agentStatus(agentForPane(state.selectedPaneId), pane);
}

function choosePane() {
  const { herdrSessions, panes } = snapshotRecords();
  if (pendingNotificationPaneId && panes.some(
    (pane) => idOf(pane, "pane_id", "id") === pendingNotificationPaneId,
  )) {
    if (state.selectedPaneId !== pendingNotificationPaneId) {
      resetInputHistoryNavigation();
      collapseTerminalHistory(state.selectedPaneId);
      state.terminalFollow = true;
    }
    state.selectedPaneId = pendingNotificationPaneId;
    pendingNotificationPaneId = null;
    writePanePreference(panePreferenceStorage, state.selectedPaneId);
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete("pane");
    window.history.replaceState(null, "", currentUrl);
    closeMobileSidebar();
  }
  // A link to another server's pane arrives before that server's panes have
  // loaded: wait for them rather than open some other pane in its place.
  // The page opening on such a pane (from its address or the last visit) waits the same way.
  const awaited = pendingNotificationPaneId ?? (state.selectedPaneId ? null : state.preferredPaneId);
  const awaitedSince = pendingNotificationPaneId ? pendingNotificationSince : pageOpenedAt;
  if (waitsForRemotePane(
    awaited, panes, snapshotRecords().servers, Date.now() - awaitedSince, PENDING_REMOTE_PANE_MS,
    state.snapshot?.servers_pending,
  )) return;
  if (awaited?.includes("!") && !panes.some((pane) => idOf(pane, "pane_id", "id") === awaited)) {
    if (awaited === pendingNotificationPaneId) pendingNotificationPaneId = null;
    // Given up on: a reload must not wait for it all over again.
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("pane") === awaited) {
      currentUrl.searchParams.delete("pane");
      window.history.replaceState(null, "", currentUrl);
    }
  }
  if (keepsVanishedRemotePane(state.selectedPaneId, panes, snapshotRecords().servers)) return;
  const defaultHerdrSessionId = idOf(
    herdrSessions.find((session) => session.default === true),
    "session_id",
    "id",
  ) || null;
  const nextPaneId = selectedPaneIdForSnapshot(
    panes,
    state.selectedPaneId || state.preferredPaneId,
    defaultHerdrSessionId,
  );
  if (state.selectedPaneId !== nextPaneId) {
    resetInputHistoryNavigation();
    collapseTerminalHistory(state.selectedPaneId);
    state.terminalFollow = true;
  }
  state.selectedPaneId = nextPaneId;
  if (nextPaneId) {
    state.preferredPaneId = nextPaneId;
    writePanePreference(panePreferenceStorage, nextPaneId);
  }
}

const liveStatusUpdates = new Map();
let liveStatusSequence = 0;

function applyLiveStatus(event) {
  const records = snapshotRecords();
  for (const record of [...records.panes, ...records.agents]) {
    if (idOf(record, "pane_id", "id") === event.pane_id) record.agent_status = event.agent_status;
  }
}

function receiveLiveStatus(event) {
  if (!["idle", "working", "blocked", "done", "unknown"].includes(event.agent_status)) return;
  if (!snapshotRecords().panes.some(pane => idOf(pane, "pane_id", "id") === event.pane_id)) return;
  liveStatusUpdates.set(event.pane_id, { ...event, sequence: ++liveStatusSequence });
  applyLiveStatus(event);
  pruneAcknowledgedCompletions();
  if (state.selectedPaneId) acknowledgePaneCompletion(state.selectedPaneId);
  if (!renameIsOpen()) renderNavigation();
  const selected = selectedRecords();
  renderPaneHeading(selected.pane, selected.tab, selected.workspace);
}

async function refreshSnapshot() {
  if (!state.authenticated) return;
  if (state.snapshotBusy || state.mutationBusy || document.hidden) return;
  state.snapshotBusy = true;
  const previousPaneId = state.selectedPaneId;
  const previousStatus = selectedAgentStatus();
  try {
    await restoreNotificationTarget();
    const statusAtRequest = liveStatusSequence;
    const payload = await api("/api/snapshot");
    const previouslyAcknowledged = new Set(snapshotRecords().panes.filter(pane => {
      const id = idOf(pane, "pane_id", "id");
      return state.acknowledgedCompletions.get(id) === agentCompletionIdentity(agentForPane(id), pane);
    }).map(pane => idOf(pane, "pane_id", "id")));
    state.snapshot = payload.snapshot || {};
    const records = snapshotRecords();
    const paneIds = records.panes.map(pane => idOf(pane, "pane_id", "id"));
    for (const [paneId, event] of liveStatusUpdates) {
      const pane = records.panes.find(pane => idOf(pane, "pane_id", "id") === paneId);
      if (!pane) { liveStatusUpdates.delete(paneId); continue; }
      const agent = agentForPane(paneId);
      if (agentStatus(agent, pane) === event.agent_status && event.sequence <= statusAtRequest) {
        liveStatusUpdates.delete(paneId);
        if (event.agent_status === "done" && previouslyAcknowledged.has(paneId)) {
          state.acknowledgedCompletions.set(paneId, agentCompletionIdentity(agent, pane));
        }
      } else applyLiveStatus(event); // A slow HTTP response must not undo a newer event.
    }
    terminalStream.watchStatuses(paneIds);
    choosePane();
    pruneAcknowledgedCompletions();
    if (state.selectedPaneId) acknowledgePaneCompletion(state.selectedPaneId);
    syncCreateProjectAvailability();
    if (!renameIsOpen()) renderNavigation();
    const selected = selectedRecords();
    renderPaneHeading(selected.pane, selected.tab, selected.workspace);
    setConnection("online", "Connected");
    const polling = outputPollingDecision({
      baseIntervalMs: state.pollIntervalMs,
      previousStatus,
      currentStatus: selectedAgentStatus(),
    });
    if (previousPaneId !== state.selectedPaneId || polling.refreshNow || notificationRelayTarget) {
      void refreshOutput();
    }
  } catch (error) {
    setConnection("error", error.message);
  } finally {
    state.snapshotBusy = false;
  }
}

function renderHistoryStatus() {
  const paneId = state.selectedPaneId;
  if (!paneId) {
    elements.historyStatus.textContent = "";
    return;
  }
  if (state.historyLoadingPaneId === paneId) {
    elements.historyStatus.textContent = "Loading history…";
    return;
  }
  const error = state.historyErrors.get(paneId);
  if (error) {
    elements.historyStatus.textContent = `Could not load history: ${error}`;
    return;
  }
  if (state.outputHasMore.get(paneId) === true) {
    elements.historyStatus.textContent = "";
    return;
  }
  elements.historyStatus.textContent = state.historyRequested.has(paneId)
    ? "Beginning of history."
    : "";
}

async function refreshOutput({ loadOlder = false, streamPayload = null } = {}) {
  if (!state.authenticated || document.hidden || !state.selectedPaneId) return;
  // A pane that attaches draws itself from herdr's stream; the rest of this is
  // the screen-text view, for panes that cannot. A screen-text frame that was
  // already on its way when the pane attached is dropped here.
  if (!loadOlder && attachedTerminal.show(state.selectedPaneId)) {
    terminalStream.unwatch();
    showAttachedView(true);
    return;
  }
  showAttachedView(false);
  if (!loadOlder && !streamPayload) {
    const lines = state.outputLineLimits.get(state.selectedPaneId) || HISTORY_PAGE_LINES;
    terminalStream.select(state.selectedPaneId, lines);
    streamPayload = terminalStream.latest(state.selectedPaneId, lines);
    if (!streamPayload) return;
  }
  if (state.outputRequests.has(state.selectedPaneId)) {
    // Run once the in-flight request finishes instead of dropping this one.
    // Otherwise the immediate refresh after sending input is simply lost and
    // the echo waits for the next scheduled poll.
    if (!loadOlder) state.outputRefreshQueued = true;
    return;
  }
  state.outputRequests.add(state.selectedPaneId);
  state.lastOutputRequestAt = Date.now();
  const requestedPaneId = state.selectedPaneId;
  const currentLineLimit =
    state.outputLineLimits.get(requestedPaneId) || HISTORY_PAGE_LINES;
  const requestedLineLimit = loadOlder
    ? nextHistoryLineLimit(currentLineLimit)
    : currentLineLimit;
  if (loadOlder && requestedLineLimit === currentLineLimit) {
    state.outputHasMore.set(requestedPaneId, false);
    state.historyRequested.add(requestedPaneId);
    state.outputRequests.delete(requestedPaneId);
    renderHistoryStatus();
    return;
  }
  if (loadOlder) {
    state.historyLoadingPaneId = requestedPaneId;
    state.historyErrors.delete(requestedPaneId);
    renderHistoryStatus();
  }
  try {
    const previousRevision =
      state.renderedPaneId === requestedPaneId &&
      typeof state.renderedOutput === "string"
        ? state.outputRevisions.get(requestedPaneId)
        : null;
    const query = new URLSearchParams({ lines: String(requestedLineLimit) });
    const selectedAgent = agentForPane(requestedPaneId);
    const selectedPane = selectedRecords().pane;
    if (previousRevision) query.set("since", previousRevision);
    const payload = streamPayload || await api(
      `/api/panes/${encodeURIComponent(requestedPaneId)}/output?${query}`,
    );
    if (requestedPaneId === state.selectedPaneId) {
      if (!payload.update && payload.output === undefined) return;
      const update = payload.update
        ? payload
        : { ...payload, update: "replace" };
      const nextRawOutput = outputTextForUpdate(state.renderedOutput, update);
      if (nextRawOutput === null) {
        state.outputRevisions.delete(requestedPaneId);
        return;
      }
      if (String(selectedAgent?.agent || selectedPane?.agent || "").toLowerCase() === "claude" &&
          terminalShowsOlderScreen(nextRawOutput)) {
        state.remoteHistoryPanes.add(requestedPaneId);
      } else {
        state.remoteHistoryPanes.delete(requestedPaneId);
      }
      renderTerminalLive();
      state.outputLineLimits.set(
        requestedPaneId,
        Number(payload.requestedLines) || requestedLineLimit,
      );
      state.outputHasMore.set(requestedPaneId, payload.hasMore === true);
      state.historyErrors.delete(requestedPaneId);
      if (loadOlder) state.historyRequested.add(requestedPaneId);
      const shouldRender = shouldRenderTerminalUpdate({
        renderedPaneId: state.renderedPaneId,
        nextPaneId: requestedPaneId,
        renderedOutput: state.renderedOutput,
        nextOutput: nextRawOutput,
        hasSelection: terminalHasSelection(),
        pointerActive: state.terminalPointerActive,
        scrolling: Date.now() < state.terminalScrollSettlesAt,
        // A rolling output window drops old rows as new ones arrive. Keep the
        // displayed conversation still until the reader returns to the bottom.
        readingHistory: !state.terminalFollow,
        // Except when the reader asked for those older rows themselves.
        readerRequested: loadOlder,
      });
      if (shouldRender) {
        // Read the position immediately before replacing the DOM. Reading it
        // before the request would restore wherever the view was a network
        // round trip ago, undoing any scrolling done while it was in flight.
        const previousScrollHeight = elements.terminalOutput.scrollHeight;
        const previousScrollTop = elements.terminalOutput.scrollTop;
        renderAnsiOutput(nextRawOutput || "(No output)");
        state.renderedPaneId = requestedPaneId;
        state.renderedOutput = nextRawOutput;
        if (typeof payload.revision === "string") {
          state.outputRevisions.set(requestedPaneId, payload.revision);
        }
        if (loadOlder) {
          const addedHeight = elements.terminalOutput.scrollHeight - previousScrollHeight;
          elements.terminalOutput.scrollTop = previousScrollTop + Math.max(0, addedHeight);
        } else if (state.terminalFollow) {
          elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
        } else {
          // replaceChildren empties the node list, which clamps scrollTop to 0.
          // Without this the view jumps to the top on every poll.
          elements.terminalOutput.scrollTop = previousScrollTop;
        }
      } else if (
        state.renderedPaneId === requestedPaneId &&
        state.renderedOutput === nextRawOutput &&
        typeof payload.revision === "string"
      ) {
        state.outputRevisions.set(requestedPaneId, payload.revision);
      }
    }
  } catch (error) {
    if (requestedPaneId === state.selectedPaneId) {
      if (loadOlder) {
        state.historyErrors.set(requestedPaneId, error.message);
      } else if (
        state.renderedPaneId === requestedPaneId &&
        typeof state.renderedOutput === "string"
      ) {
        // A single failed poll must not blank a terminal that is already on
        // screen; the next poll recovers it.
        setConnection("error", error.message);
      } else if (!state.terminalPointerActive && !terminalHasSelection()) {
        showTerminalMessage(`Could not read output: ${error.message}`);
      }
    }
  } finally {
    void completeNotificationRelay();
    state.outputRequests.delete(requestedPaneId);
    if (state.historyLoadingPaneId === requestedPaneId) {
      state.historyLoadingPaneId = null;
    }
    if (requestedPaneId === state.selectedPaneId) renderHistoryStatus();
    if (state.outputRefreshQueued) {
      state.outputRefreshQueued = false;
      void refreshOutput();
    }
  }
}

function refreshOutputOnSchedule() {
  const polling = outputPollingDecision({
    baseIntervalMs: state.pollIntervalMs,
    currentStatus: selectedAgentStatus(),
    recentSubmission: Date.now() < state.outputBurstUntil,
    connection: navigator.connection || navigator.mozConnection || navigator.webkitConnection,
  });
  if (Date.now() - state.lastOutputRequestAt < polling.intervalMs) return;
  void refreshOutput();
}

async function sendText(text, paneId = state.selectedPaneId) {
  if (!paneId) throw new Error("Select a pane first.");
  return terminalStream.send({ paneId, text, submit: true });
}

async function sendKeys(keys, paneId = state.selectedPaneId) {
  if (!paneId) throw new Error("Select a pane first.");
  await terminalStream.send({ paneId, keys });
}

function refreshAfterSubmission() {
  state.outputBurstUntil = Date.now() + OUTPUT_SUBMISSION_BURST_MS;
  state.terminalFollow = true;
  state.terminalScrollSettlesAt = 0;
  elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
  renderTerminalLive();
  void refreshOutput();
  window.setTimeout(() => void refreshOutput(), OUTPUT_SUBMISSION_RETRY_MS);
  if (elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
    window.setTimeout(() => void refreshBrowseFolder({ silent: true }), OUTPUT_SUBMISSION_RETRY_MS);
  }
}

function streamPayloadIsCurrent(payload) {
  return payload.paneId === state.selectedPaneId && payload.requestedLines ===
    (state.outputLineLimits.get(state.selectedPaneId) || HISTORY_PAGE_LINES);
}

// Stream updates can arrive faster than a large terminal renders. Draw only the
// newest one per frame so keystrokes do not queue behind stale renders.
let pendingStreamPayload = null;
function scheduleStreamRender(payload) {
  const scheduled = pendingStreamPayload !== null;
  pendingStreamPayload = payload;
  if (scheduled) return;
  window.requestAnimationFrame(() => {
    const next = pendingStreamPayload;
    pendingStreamPayload = null;
    if (streamPayloadIsCurrent(next)) void refreshOutput({ streamPayload: next });
  });
}

const terminalStream = terminalConnection({
  credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
  onOutput: payload => {
    if (streamPayloadIsCurrent(payload)) {
      setConnection("online", "Connected");
      scheduleStreamRender(payload);
    }
  },
  onDisconnect: error => {
    liveStatusUpdates.clear();
    if (state.authenticated && !document.hidden) {
      directTerminalInput.stop(error);
      setConnection("error", error.message);
    }
  },
  onAuthenticationRequired: () => showLogin(),
  onStatus: receiveLiveStatus,
  onStatusesReady: () => void refreshSnapshot(),
  onStatusesUnavailable: () => liveStatusUpdates.clear(),
});

const attachedTerminal = createAttachedTerminal({
  host: elements.terminalXterm,
  connection: terminalStream,
  xterm,
  fontSize: state.terminalFontSize,
  onFallback: (paneId) => {
    if (paneId !== state.selectedPaneId) return;
    showAttachedView(false);
    void refreshOutput();
  },
  onStateChange: ({ paneId, held, dropped }) => {
    if (paneId !== state.selectedPaneId) return;
    elements.terminalHeld.hidden = !held;
    if (dropped) setFeedback("Typing did not reach the terminal while it reconnected. Check the screen before typing again.", true);
  },
  isViewablePath: isViewableTerminalPath,
  onPath: openTerminalPath,
  onFontSizeChange: applyTerminalFontSize,
  onRetry: (paneId) => { if (paneId === state.selectedPaneId) void refreshOutput(); },
  onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
});

function showAttachedView(attached) {
  elements.terminalOutput.hidden = attached;
  elements.terminalXterm.hidden = !attached;
  if (!attached) elements.terminalHeld.hidden = true;
  elements.historyStatus.hidden = attached;
  renderTerminalLive();
}

document.querySelector("#terminal-take-over").addEventListener("click", () => attachedTerminal.takeOver());

const directTerminalInput = attachDirectTerminalInput({
  output: elements.terminalOutput,
  input: document.querySelector("#terminal-direct-input"),
  composer: elements.terminalInput,
  stage: document.querySelector(".terminal-stage"),
  indicator: document.querySelector("#terminal-input-indicator"),
  getPaneId: () => state.authenticated ? state.selectedPaneId : null,
  getModifiers: () => [...selectedKeyModifiers],
  clearModifiers: clearKeyModifiers,
  send: item => terminalStream.send(item, { waitForAck: false }),
  onSent: ({ paneId }) => {
    if (paneId === state.selectedPaneId) refreshAfterSubmission();
  },
  onError: (error) => setFeedback(`Direct input stopped: ${error.message}. Check the terminal before clicking to resume.`, true),
  onFiles: (files) => acceptDroppedFiles(files, setFeedback),
});

elements.inputForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.terminalInput.value;
  const paneId = state.selectedPaneId;
  const submitButton = elements.inputForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setFeedback("Sending…");
  try {
    await directTerminalInput.idle();
    if (text) {
      const sent = await sendText(text, paneId);
      // An answer to a password prompt is never kept.
      if (!sent?.secret && paneKeepsInputHistory(paneId, snapshotRecords())) rememberSentInput(paneId, text);
    } else {
      await sendKeys(["enter"], paneId);
    }
    elements.terminalInput.value = "";
    window.clearTimeout(terminalInputResizeTimer);
    terminalInputResizeTimer = null;
    resizeTerminalInput();
    setFeedback("");
    refreshAfterSubmission();
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

elements.terminalInput.addEventListener("keydown", (event) => {
  if (
    !event.isComposing &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    selectedKeyModifiers.size === 0 &&
    (event.key === "ArrowUp" || event.key === "ArrowDown")
  ) {
    if (!shouldBrowseInputHistory({
      key: event.key, value: elements.terminalInput.value,
      selectionStart: elements.terminalInput.selectionStart,
      selectionEnd: elements.terminalInput.selectionEnd,
    })) return;
    const next = nextInputHistory({
      history: state.inputHistoryByPane.get(state.selectedPaneId) || [],
      cursor: state.inputHistoryCursor,
      draft: state.inputHistoryDraft,
      currentValue: elements.terminalInput.value,
      direction: event.key === "ArrowUp" ? "previous" : "next",
    });
    if (next.handled) {
      event.preventDefault();
      state.inputHistoryCursor = next.cursor;
      state.inputHistoryDraft = next.draft;
      elements.terminalInput.value = next.value;
      elements.terminalInput.setSelectionRange(next.value.length, next.value.length);
      resizeTerminalInput();
    }
    return;
  }

  const action = inputKeyAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    usesTouchInput: usesTouchInputEnvironment(),
  });
  if (action === "submit") {
    event.preventDefault();
    elements.inputForm.querySelector('button[type="submit"]').click();
  } else if (action === "newline") {
    event.preventDefault();
    const next = insertNewlineAtSelection(
      elements.terminalInput.value,
      elements.terminalInput.selectionStart,
      elements.terminalInput.selectionEnd,
    );
    elements.terminalInput.value = next.value;
    elements.terminalInput.setSelectionRange(next.caret, next.caret);
    elements.terminalInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
});

elements.terminalInput.addEventListener("input", () => {
  if (usesTouchInputEnvironment()) {
    resizeTerminalInput();
  } else {
    scheduleTerminalInputResize();
  }
  if (state.inputHistoryCursor !== null) resetInputHistoryNavigation();
});

elements.terminalInput.addEventListener("blur", () => {
  void refreshOutput();
});

window.addEventListener("resize", resizeTerminalInput);

function renderKeyModifiers() {
  for (const button of elements.quickKeys.querySelectorAll("[data-modifier]")) {
    button.setAttribute("aria-pressed", String(selectedKeyModifiers.has(button.dataset.modifier)));
  }
}

function clearKeyModifiers() {
  selectedKeyModifiers.clear();
  modifierPaneId = null;
  renderKeyModifiers();
}

async function sendCommandKey(key) {
  if (key && directTerminalInput.isActive()) {
    directTerminalInput.key(key);
    return;
  }
  if (!key || keySendBusy || !state.authenticated || !state.selectedPaneId) return;
  keySendBusy = true;
  const paneId = state.selectedPaneId;
  clearKeyModifiers();
  setFeedback(`Sending ${key}…`);
  try {
    await directTerminalInput.idle();
    await sendKeys([key], paneId);
    refreshAfterSubmission();
    setFeedback("");
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    keySendBusy = false;
  }
}

// Keep the composer focused when using the screen keyboard with a mouse.
elements.quickKeys.addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});

elements.quickKeys.addEventListener("click", (event) => {
  if (!state.authenticated || !state.selectedPaneId || keySendBusy) return;
  const modifier = event.target.closest("button[data-modifier]");
  if (modifier) {
    const key = modifier.dataset.modifier;
    if (selectedKeyModifiers.has(key)) selectedKeyModifiers.delete(key);
    else selectedKeyModifiers.add(key);
    modifierPaneId = state.selectedPaneId;
    renderKeyModifiers();
    if (directTerminalInput.isActive()) directTerminalInput.focus();
    else focusComposer();
    return;
  }
  const button = event.target.closest("button[data-key]");
  if (!button) return;
  const modifiers = [...selectedKeyModifiers];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  void sendCommandKey(combinedTerminalKey(button.dataset.key, modifiers));
});

// Only intercept the terminal area: login fields and other dialogs retain
// their normal shortcuts. Without a selected modifier, the composer does too.
elements.terminalPanel.addEventListener("keydown", (event) => {
  if (!state.authenticated || !state.selectedPaneId) return;
  if (directTerminalInput.ownsEvent(event)) return;
  // A physical copy shortcut belongs to the browser while text is selected.
  if ((event.ctrlKey || event.metaKey) && !event.altKey &&
      event.key.toLowerCase() === "c" && window.getSelection()?.toString()) return;
  const directTerminalChord = event.target === elements.terminalOutput && (event.ctrlKey || event.altKey);
  if (selectedKeyModifiers.size === 0 && !directTerminalChord) return;
  const key = keyboardTerminalKey(event, [...selectedKeyModifiers]);
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) void sendCommandKey(key);
}, { capture: true });

// Mobile keyboards may emit beforeinput without a usable keydown event.
elements.terminalInput.addEventListener("beforeinput", (event) => {
  if (!selectedKeyModifiers.size || event.isComposing || event.inputType !== "insertText") return;
  if (typeof event.data !== "string" || event.data.length !== 1) return;
  const key = keyboardTerminalKey({ key: event.data }, [...selectedKeyModifiers]);
  if (!key || !event.cancelable) return;
  event.preventDefault();
  void sendCommandKey(key);
});

window.addEventListener("blur", clearKeyModifiers);

elements.createProject.addEventListener("click", () => {
  document.querySelector("#add-menu").open = false;
  if (state.mutationBusy) return;
  const herdrSession = selectedHerdrSession();
  if (!herdrSession) return;
  state.createProjectSessionId = idOf(herdrSession, "session_id", "id") || null;
  const select = document.querySelector("#project-server-session");
  select.replaceChildren();
  for (const session of snapshotRecords().herdrSessions.filter((item) => item.running && item.available)) {
    const option = createElement("option", { text: `${session.server_name || "Local"} / ${session.name}` });
    option.value = idOf(session, "session_id", "id");
    select.append(option);
  }
  select.value = state.createProjectSessionId || "";
  select.disabled = select.options.length < 2;
  elements.projectSessionContext.textContent = snapshotRecords().herdrSessions.length > 1
    ? `A default shell will open in Herdr session “${herdrSession.name}”.`
    : "A default shell will open.";
  elements.projectDialogFeedback.textContent = "";
  elements.projectDialogFeedback.dataset.error = "false";
  elements.projectDialog.showModal();
  window.requestAnimationFrame(() => elements.projectName.focus());
});

elements.projectDialogCancel.addEventListener("click", () => {
  if (!state.mutationBusy) elements.projectDialog.close();
});

elements.projectDialog.addEventListener("close", () => {
  state.createProjectSessionId = null;
  elements.projectCreateForm.reset();
  elements.projectDialogFeedback.textContent = "";
});

elements.projectCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.mutationBusy) return;
  state.createProjectSessionId = document.querySelector("#project-server-session").value || state.createProjectSessionId;
  const label = elements.projectName.value.trim();
  if (!label) {
    elements.projectName.setCustomValidity("Enter a project name.");
    elements.projectName.reportValidity();
    return;
  }
  elements.projectName.setCustomValidity("");
  state.mutationBusy = true;
  const submitButton = elements.projectCreateForm.querySelector('button[type="submit"]');
  elements.projectName.disabled = true;
  elements.projectDialogCancel.disabled = true;
  submitButton.disabled = true;
  elements.projectDialogFeedback.textContent = "Creating project…";
  elements.projectDialogFeedback.dataset.error = "false";
  const previousPaneIds = new Set(
    snapshotRecords().panes.map((pane) => idOf(pane, "pane_id", "id")),
  );
  try {
    const payload = await api("/api/workspaces", {
      method: "POST",
      body: {
        label,
        ...(state.createProjectSessionId
          ? { herdrSessionId: state.createProjectSessionId }
          : {}),
      },
    });
    state.snapshot = payload.snapshot || {};
    const newPane = snapshotRecords().panes.find(
      (pane) => !previousPaneIds.has(idOf(pane, "pane_id", "id")) &&
        (!state.createProjectSessionId || pane.herdr_session_id === state.createProjectSessionId),
    );
    adoptMutationSnapshot(
      state.snapshot,
      newPane ? idOf(newPane, "pane_id", "id") : null,
    );
    elements.projectDialog.close();
    closeMobileSidebar();
  } catch (error) {
    elements.projectDialogFeedback.textContent = error.message;
    elements.projectDialogFeedback.dataset.error = "true";
  } finally {
    state.mutationBusy = false;
    elements.projectName.disabled = false;
    elements.projectDialogCancel.disabled = false;
    submitButton.disabled = false;
  }
});

elements.projectName.addEventListener("input", () => {
  elements.projectName.setCustomValidity("");
});

const TRANSFER_MAX_BYTES = 50 * 1024 * 1024;

function setTransferFeedback(text, isError = false) {
  elements.transferDialogFeedback.textContent = text;
  elements.transferDialogFeedback.dataset.error = String(isError);
}

function setBrowseFeedback(text, isError = false) {
  elements.browseFeedback.textContent = text;
  elements.browseFeedback.dataset.error = String(isError);
}

function sessionServerId() {
  return paneServerId(state.selectedPaneId) || "local";
}

// Browsing and uploading use the same machine: picking one in the Files tab is
// how you say where files go.
function uploadServerId() {
  return browseState.server;
}

function serverLabel(id) {
  if (id === "local") return "this machine";
  const server = array(state.snapshot?.servers).find((item) => item.id === id);
  return server?.name || "another machine";
}

function syncAttachAvailability() {
  elements.attachButton.disabled = !state.selectedPaneId;
  // Where a file lands is not obvious once it can differ from the session in
  // front of you, so the control says it rather than leaving it to be found out.
  elements.attachButton.title = `Upload a file to ${serverLabel(uploadServerId())}`;
}

// The session gate wants a launch token header, which a plain link cannot send,
// so every transfer goes through fetch with the same credentials as api().
function transferHeaders(extra = {}) {
  const headers = new Headers(extra);
  if (state.launchToken) headers.set("X-Herdr-Launch-Token", state.launchToken);
  return headers;
}

async function transferRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: transferHeaders(options.headers),
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new ApiError(payload?.error?.message || `HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
    });
    if (error.code === "authentication_required") {
      state.launchToken = clearLaunchToken(launchSessionStorage);
      showLogin();
    }
    throw error;
  }
  return response;
}

function insertTransferPath(path) {
  const input = elements.terminalInput;
  const { value, caret } = insertPathAtSelection(
    input.value,
    input.selectionStart,
    input.selectionEnd,
    path,
  );
  input.value = value;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// The download route trades the launch token header for a one-time ticket, so a
// plain link works and the browser streams the file itself instead of holding
// the whole thing in memory as a blob.

// Looking at a file is the thing a browser is already good at, and downloading
// one to a phone just to read two lines of a log is not. What may be shown and
// as what is decided in file-preview.js, which the server consults with the
// same code before it will hand over a type at all.
const viewerDialog = document.querySelector("#viewer-dialog");
const viewerBody = document.querySelector("#viewer-body");
const viewerFeedback = document.querySelector("#viewer-feedback");
let viewerDownload = null;

function setViewerFeedback(message, isError = false) {
  viewerFeedback.textContent = message;
  viewerFeedback.dataset.error = String(isError);
}

function closeViewer() {
  // A <video> left with a src keeps its connection and its buffer alive after
  // the dialog is gone, so the element goes rather than just being hidden.
  viewerBody.replaceChildren();
  viewerDialog.close();
}

document.querySelector("#viewer-close").addEventListener("click", closeViewer);
viewerDialog.addEventListener("close", () => viewerBody.replaceChildren());
document.querySelector("#viewer-download").addEventListener("click", () => {
  if (viewerDownload) void downloadPath(viewerDownload.path, viewerDownload.name, viewerDownload.server);
});

async function viewTicket(filePath, server, view) {
  const response = await transferRequest("/api/browse/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": state.csrfToken },
    body: JSON.stringify({ path: filePath, server, ...(view ? { view: true } : {}) }),
  });
  return (await response.json()).ticket;
}

// Text and HTML both arrive this way: as the same opaque bytes a download
// gets, never as a type the server named. What is done with them afterwards is
// this side's business, and neither route lets the file pick.
async function readFileText(filePath, server) {
  const ticket = await viewTicket(filePath, server, false);
  const response = await fetch(`/api/browse/download/${ticket}`);
  if (!response.ok) throw new Error(`Could not read the file (${response.status}).`);
  const text = await response.text();
  if (text.length > MAX_TEXT_PREVIEW_BYTES) throw new Error("That file is too long to show here.");
  return text;
}

function viewerText(text) {
  return createElement("pre", { className: "viewer-text", text });
}

// The sandbox is on the response, not on this element. Putting it here as well
// would give the frame an opaque origin before the fetch, and a same-origin
// body guarded by Cross-Origin-Resource-Policy will not load into one -- the
// PDF simply never appears. The response says `sandbox` either way, and says
// it to anyone who opens the URL rather than only to this frame.
function viewerFrame(className, title, ticket) {
  const frame = createElement("iframe", { className });
  frame.setAttribute("title", title);
  frame.src = `/api/browse/download/${ticket}`;
  return frame;
}

function viewerMedia(kind, type, name, ticket) {
  if (kind === "document") return viewerFrame("viewer-document", name, ticket);
  const element = createElement(kind === "image" ? "img" : kind);
  element.className = `viewer-${kind}`;
  if (kind === "image") element.alt = name;
  else {
    element.controls = true;
    element.preload = "metadata";
  }
  element.addEventListener("error", () => setViewerFeedback("This file could not be shown here.", true));
  element.src = `/api/browse/download/${ticket}`;
  return element;
}

function canView(name, size) {
  return previewFor(name, size) !== null;
}

const viewerSourceButton = document.querySelector("#viewer-source");
let viewerSource = null;

// A PDF opens in a tab rather than in the dialog. Framing one is the part that
// browsers disagree about -- Android Chrome draws nothing in a frame, iOS
// Safari draws the first page -- while a tab is not framing at all and works
// everywhere, at the full height a page-shaped document was written for. It
// also means the response needs no exception to this app's framing rules,
// because there is no frame.
function openInTab(url) {
  const link = createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

viewerSourceButton.addEventListener("click", () => {
  if (!viewerSource) return;
  void (async () => {
    viewerSourceButton.disabled = true;
    try {
      if (viewerSource.showing === "source") {
        viewerBody.replaceChildren(await viewerSource.rendered());
        viewerSource.showing = "rendered";
        viewerSourceButton.textContent = "Source";
      } else {
        viewerSource.text ??= await readFileText(viewerSource.path, viewerSource.server);
        viewerBody.replaceChildren(viewerText(viewerSource.text));
        viewerSource.showing = "source";
        viewerSourceButton.textContent = "Rendered";
      }
      setViewerFeedback("");
    } catch (error) {
      setViewerFeedback(error.message, true);
    } finally {
      viewerSourceButton.disabled = false;
    }
  })();
});

async function viewFile(filePath, name, server, size = null) {
  const preview = previewFor(name, size);
  if (!preview) return;
  // Nothing to open a dialog around: the tab is the viewer.
  if (preview.kind === "pdf") {
    try {
      openInTab(`/api/browse/download/${await viewTicket(filePath, server, true)}`);
    } catch (error) {
      setBrowseFeedback(error.message, true);
    }
    return;
  }
  viewerDownload = { path: filePath, name, server };
  viewerSource = null;
  viewerSourceButton.hidden = true;
  viewerSourceButton.textContent = "Source";
  document.querySelector("#viewer-title").textContent = name;
  document.querySelector("#viewer-context").textContent = serverLabel(server) || "";
  viewerBody.replaceChildren();
  setViewerFeedback("Opening…");
  viewerDialog.showModal();
  try {
    const element = preview.kind === "text"
      ? viewerText(await readFileText(filePath, server))
      : viewerMedia(preview.kind, preview.type, name, await viewTicket(filePath, server, true));
    viewerBody.replaceChildren(element);
    // Markup is worth both readings, and which one is wanted is not ours to
    // guess: the drawing is the default, the source is one press away.
    if (preview.source) {
      viewerSource = {
        path: filePath,
        server,
        showing: "rendered",
        text: null,
        rendered: async () =>
          viewerMedia(preview.kind, preview.type, name, await viewTicket(filePath, server, true)),
      };
      viewerSourceButton.hidden = false;
    }
    setViewerFeedback("");
  } catch (error) {
    setViewerFeedback(error.message, true);
  }
}

async function downloadPath(filePath, label, server = browseState.server) {
  setBrowseFeedback(`Downloading ${label}…`);
  try {
    const { ticket } = await transferRequest("/api/browse/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Herdr-CSRF": state.csrfToken },
      body: JSON.stringify({ path: filePath, server }),
    }).then((response) => response.json());

    const link = createElement("a");
    link.href = `/api/browse/download/${ticket}`;
    link.download = label;
    document.body.append(link);
    link.click();
    link.remove();
    setBrowseFeedback("");
  } catch (error) {
    setBrowseFeedback(error.message, true);
  }
}

// A pasted screenshot arrives as a blob with no useful name, so it gets one
// that says when it came from.
function droppedFileName(file) {
  if (file.name && file.name !== "image.png" && file.name !== "blob") return file.name;
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const extension = (file.type.split("/")[1] || "bin").replace(/[^a-z0-9]/giu, "");
  return `pasted-${stamp}.${extension}`;
}

// One path for every way files can arrive: the picker, a drop, or a paste. They
// go up one at a time, in the order given, so their paths land in the composer in
// that order; one that fails is reported and the rest still go.
async function uploadFiles(files, { report = setFeedback } = {}) {
  const list = [...(files || [])].filter((file) => file instanceof File);
  if (list.length === 0) return [];
  if (!state.selectedPaneId) {
    report("Select a session first.", true);
    return [];
  }

  const target = uploadServerId();
  // Inserting a path the session cannot open would read as a broken upload
  // rather than a deliberate one.
  const insert = target === sessionServerId();
  const saved = [];
  const failed = [];
  state.mutationBusy = true;
  try {
    for (const [index, file] of list.entries()) {
      const name = droppedFileName(file);
      report(list.length > 1 ? `Uploading ${index + 1} of ${list.length}: ${name}…` : `Uploading ${name}…`);
      if (file.size > TRANSFER_MAX_BYTES) {
        failed.push({ name, reason: `larger than ${formatTransferSize(TRANSFER_MAX_BYTES)}` });
        continue;
      }
      try {
        const response = await transferRequest(
          `/api/files/${encodeURIComponent(name)}?server=${encodeURIComponent(target)}`,
          {
            method: "POST",
            // File.type would otherwise set a media type the upload route rejects.
            headers: { "Content-Type": "application/octet-stream", "X-Herdr-CSRF": state.csrfToken },
            body: file,
          },
        );
        const { file: stored } = await response.json();
        if (insert) insertTransferPath(stored.path);
        saved.push(stored);
      } catch (error) {
        failed.push({ name, reason: error.message.replace(/\.$/u, "") });
      }
    }
  } finally {
    state.mutationBusy = false;
  }
  report(uploadSummary({
    saved: saved.map((stored) => stored.name),
    failed,
    elsewhere: insert ? null : serverLabel(target),
  }), failed.length > 0);
  if (elements.transferDialog.open) void refreshUploadsList();
  if (elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
    void refreshBrowseFolder({ silent: true });
  }
  return saved;
}

async function uploadFromDialog() {
  const files = [...(elements.transferFile.files || [])];
  if (files.length === 0) {
    setTransferFeedback("Choose a file first.", true);
    return;
  }
  const controls = elements.transferDialog.querySelectorAll("button, input");
  for (const control of controls) control.disabled = true;
  const saved = await uploadFiles(files, { report: setTransferFeedback });
  for (const control of controls) control.disabled = false;
  // Left open when one failed, so what failed stays on screen.
  if (saved.length === files.length) elements.transferDialog.close();
}

function showChosenFile() {
  const files = [...(elements.transferFile.files || [])];
  const size = formatTransferSize(files.reduce((total, file) => total + file.size, 0));
  elements.transferDropLabel.textContent = files.length === 0
    ? "Choose files, or drop them here"
    : `${files.length === 1 ? files[0].name : `${files.length} files`} · ${size}`;
}

// Drops and pastes are accepted wherever they land in the app, so a screenshot
// can go straight from the clipboard to the composer without opening anything.
function acceptDroppedFiles(list, report, onUploaded) {
  const files = [...(list || [])].filter((item) => item instanceof File);
  if (files.length === 0) return false;
  void uploadFiles(files, { report }).then((saved) => {
    if (saved.length === files.length) onUploaded?.(saved);
  });
  return true;
}

function attachDropZone(element, { report, onDragState, onUploaded } = {}) {
  let depth = 0;
  const setActive = (active) => onDragState?.(active);
  element.addEventListener("dragenter", (event) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    depth += 1;
    setActive(true);
  });
  element.addEventListener("dragover", (event) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  element.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) setActive(false);
  });
  element.addEventListener("drop", (event) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    depth = 0;
    setActive(false);
    acceptDroppedFiles(event.dataTransfer.files, report ?? setFeedback, onUploaded);
  });
}

function uploadsRow(file) {
  const row = createElement("div", { className: "uploads-row" });
  const copy = createElement("div", { className: "transfer-copy" });
  copy.append(createElement("div", { className: "transfer-name", text: file.name }));
  copy.append(createElement("div", {
    className: "transfer-meta",
    text: `${formatTransferSize(file.size)} · ${new Date(file.modifiedAt).toLocaleString()}`,
  }));

  // Four buttons per row was most of the row, and every one of them was an icon
  // a reader had to decode. They move behind one menu that names them. The menu
  // is not wrapped in .transfer-row-actions: that class squares off whatever
  // button it contains, which is right for icons and wrong for a list of names.
  const actions = sidebarActionMenu({
    id: `upload-${file.name}`,
    label: `Actions for ${file.name}`,
    className: "uploads-action-menu",
    escapesOverflow: true,
    actions: [
      ...(canView(file.name, file.size) ? [{
        label: "View",
        paths: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
        onSelect: () => void viewFile(file.path, file.name, uploadServerId(), file.size),
      }] : []),
      {
        label: "Insert path",
        paths: ["M12 5v14M5 12h14"],
        onSelect: () => {
          insertTransferPath(file.path);
          elements.transferDialog.close();
        },
      },
      {
        label: "Copy path",
        paths: ["M9 9h9v11H9z", "M6 15H5V4h9v1"],
        onSelect: () => void copyUploadPath(file.path),
      },
      {
        label: "Download",
        paths: ["M12 4v11m-4-4 4 4 4-4", "M5 20h14"],
        onSelect: () => void downloadPath(file.path, file.name, uploadServerId()),
      },
      {
        label: "Delete",
        paths: ["M5 7h14", "M10 7V4h4v3", "M7 7l1 13h8l1-13"],
        danger: true,
        onSelect: () => void deleteUpload(file.name),
      },
    ],
  });

  row.append(copy, actions);
  return row;
}

async function copyUploadPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    setTransferFeedback("Path copied.");
  } catch {
    setTransferFeedback("Copying needs a secure connection (HTTPS).", true);
  }
}

async function deleteUpload(name) {
  if (!window.confirm(`Delete “${name}”?`)) return;
  setTransferFeedback(`Deleting ${name}…`);
  try {
    await transferRequest(
      `/api/files/${encodeURIComponent(name)}?server=${encodeURIComponent(uploadServerId())}`,
      { method: "DELETE", headers: { "X-Herdr-CSRF": state.csrfToken } },
    );
    setTransferFeedback("");
    await refreshUploadsList();
    if (elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
      void refreshBrowseFolder({ silent: true });
    }
  } catch (error) {
    setTransferFeedback(error.message, true);
  }
}

function describeUploadTarget() {
  const target = uploadServerId();
  const context = document.querySelector("#transfer-dialog-context");
  if (!context) return;
  context.textContent = target === sessionServerId()
    ? `Stored on ${serverLabel(target)}, path inserted into the composer.`
    : `Stored on ${serverLabel(target)}. The selected session runs elsewhere, so the path is not inserted.`;
}

async function refreshUploadsList() {
  describeUploadTarget();
  try {
    const server = encodeURIComponent(uploadServerId());
    const { files } = await transferRequest(`/api/files?server=${server}`)
      .then((response) => response.json());
    elements.uploadsList.replaceChildren();
    if (!array(files).length) {
      elements.uploadsList.append(
        createElement("p", { className: "transfer-empty", text: "Nothing uploaded yet." }),
      );
      return;
    }
    for (const file of files) elements.uploadsList.append(uploadsRow(file));
  } catch (error) {
    setTransferFeedback(error.message, true);
  }
}

function openUploadsDialog() {
  if (elements.transferDialog.open) return;
  setTransferFeedback("");
  elements.transferDialog.showModal();
  void refreshUploadsList();
}

elements.attachButton.addEventListener("click", () => {
  if (elements.attachButton.disabled) return;
  openUploadsDialog();
});

elements.transferUpload.addEventListener("click", () => void uploadFromDialog());

elements.transferDrop.addEventListener("click", () => elements.transferFile.click());

elements.transferFile.addEventListener("change", showChosenFile);

attachDropZone(elements.transferDialog, {
  report: setTransferFeedback,
  onDragState: (active) => elements.transferDrop.classList.toggle("is-dragging", active),
  onUploaded: () => elements.transferDialog.close(),
});

// The terminal panel covers the output, the key bar, and the composer, which is
// the whole area a person would aim a file at.
attachDropZone(elements.terminalPanel, {
  onDragState: (active) => elements.terminalPanel.classList.toggle("is-dropping", active),
});

// A screenshot pasted into the composer is uploaded instead of being ignored;
// ordinary text still pastes normally.
elements.terminalInput.addEventListener("paste", (event) => {
  if (acceptDroppedFiles(event.clipboardData?.files, setFeedback)) event.preventDefault();
});

elements.transferClose.addEventListener("click", () => {
  if (!state.mutationBusy) elements.transferDialog.close();
});

elements.transferDialog.addEventListener("cancel", (event) => {
  if (state.mutationBusy) event.preventDefault();
});

elements.transferDialog.addEventListener("close", () => {
  elements.transferFile.value = "";
  showChosenFile();
  setTransferFeedback("");
});

// Only folders that were opened have been fetched, so the tree keeps a listing
// per visited path rather than one nested structure.
const browseState = {
  // null means "follow the session being viewed", which is where an upload
  // used to go. Picking a machine in the Files tab pins it for both browsing
  // and uploads, and the choice survives a reload.
  pinnedServer: null,
  get server() { return this.pinnedServer ?? sessionServerId(); },
  set server(value) { this.pinnedServer = value; },
  root: null,
  uploads: null,
  loaded: new Map(),
  expanded: new Set(),
  selected: null,
  busy: false,
  addedPaths: new Set(),
  clearDiffTimer: null,
};

const FOLDER_ICON = ["M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"];
const FILE_ICON = ["M7 3h7l5 5v13H7z", "M14 3v5h5"];
const IMAGE_ICON = ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"];
const CODE_ICON = ["M9 8l-4 4 4 4", "M15 8l4 4-4 4"];
const DATA_ICON = ["M12 6c4 0 7-.9 7-2v12c0 1.1-3 2-7 2s-7-.9-7-2V4c0 1.1 3 2 7 2Z", "M5 4c0 1.1 3 2 7 2s7-.9 7-2"];
const ARCHIVE_ICON = ["M4 7h16v13H4z", "M4 7l2-3h12l2 3", "M12 11v3"];

const ICONS_BY_EXTENSION = new Map(Object.entries({
  png: IMAGE_ICON, jpg: IMAGE_ICON, jpeg: IMAGE_ICON, gif: IMAGE_ICON,
  webp: IMAGE_ICON, svg: IMAGE_ICON, avif: IMAGE_ICON, bmp: IMAGE_ICON, ico: IMAGE_ICON,
  js: CODE_ICON, mjs: CODE_ICON, cjs: CODE_ICON, ts: CODE_ICON, tsx: CODE_ICON,
  jsx: CODE_ICON, py: CODE_ICON, rb: CODE_ICON, go: CODE_ICON, rs: CODE_ICON,
  java: CODE_ICON, c: CODE_ICON, h: CODE_ICON, cpp: CODE_ICON, sh: CODE_ICON,
  css: CODE_ICON, html: CODE_ICON, vue: CODE_ICON, php: CODE_ICON, sql: CODE_ICON,
  json: DATA_ICON, yaml: DATA_ICON, yml: DATA_ICON, toml: DATA_ICON,
  csv: DATA_ICON, xml: DATA_ICON, db: DATA_ICON, sqlite: DATA_ICON,
  zip: ARCHIVE_ICON, gz: ARCHIVE_ICON, tar: ARCHIVE_ICON, tgz: ARCHIVE_ICON,
  bz2: ARCHIVE_ICON, xz: ARCHIVE_ICON, rar: ARCHIVE_ICON, "7z": ARCHIVE_ICON,
}));

function entryIcon(entry) {
  if (entry.kind === "directory") return FOLDER_ICON;
  const dot = entry.name.lastIndexOf(".");
  const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  return ICONS_BY_EXTENSION.get(extension) || FILE_ICON;
}

function browseActionButton({ label, paths, danger = false, run }) {
  const button = createElement("button", {
    className: `secondary-button ${danger ? "is-danger" : ""}`.trim(),
  });
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(createIcon(paths));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

function browseRow({ entry, depth, expanded }) {
  const row = createElement("div", { className: "transfer-row browse-row" });
  row.style.setProperty("--depth", String(depth));
  row.dataset.path = entry.path;
  if (browseState.addedPaths?.has(entry.path)) {
    row.classList.add("is-added");
  } else if (entry.removed) {
    row.classList.add("is-removed");
  }

  const lead = createElement("div", { className: "browse-lead" });
  // One guide per level, drawn in the DOM so the lines line up with the rows
  // above and below rather than being faked with padding.
  for (let level = 0; level < depth; level += 1) {
    lead.append(createElement("span", { className: "browse-indent" }));
  }
  if (entry.kind === "directory" && !entry.broken && !entry.removed) {
    const twisty = createElement("button", { className: "browse-twisty" });
    twisty.type = "button";
    twisty.dataset.name = entry.name;
    setBrowseTwisty(twisty, expanded);
    twisty.append(createIcon(["M9 6l6 6-6 6"]));
    twisty.addEventListener("click", (event) => {
      // The row toggles too, so without this the chevron would fire twice and
      // land back where it started.
      event.stopPropagation();
      void toggleBrowseFolder(entry.path);
    });
    lead.append(twisty);
  } else {
    lead.append(createElement("span", { className: "browse-twisty-gap" }));
  }

  lead.append(createIcon(entryIcon(entry), "browse-icon"));

  // One line per entry: the name carries the row, the size sits at the end, and
  // the full timestamp waits in the tooltip rather than wrapping the row.
  const copy = createElement("div", { className: "transfer-copy" });
  const name = createElement("div", { className: "transfer-name", text: entry.name });
  if (entry.symlink) name.append(createElement("span", { className: "transfer-tag", text: "link" }));
  copy.append(name);
  lead.append(copy);
  if (entry.removed) {
    row.title = `${entry.name} (removed)`;
  } else if (entry.modifiedAt) {
    const size = entry.kind === "directory" ? "" : `${formatTransferSize(entry.size ?? 0)} · `;
    row.title = `${entry.name}\n${size}${new Date(entry.modifiedAt).toLocaleString()}`;
  }

  if (entry.broken) {
    lead.append(createElement("span", { className: "transfer-meta", text: "broken" }));
  }

  const actions = createElement("div", { className: "transfer-row-actions" });
  if (!entry.removed) {
    // Expanding shows a folder in place; this re-roots the tree there, so a deep
    // path stops costing a column of indentation.
    if (entry.kind === "directory" && !entry.broken) {
      actions.append(browseActionButton({
        label: `Open ${entry.name} as the root`,
        paths: ["M4 12h13", "M13 7l5 5-5 5", "M20 5v14"],
        run: () => void loadBrowseFolder(entry.path),
      }));
    }
    if (entry.kind === "file" && entry.readable !== false) {
      // Reading a log or checking a screenshot is most of what a file in this
      // tree is opened for, and downloading it to a phone to do that is a detour.
      if (canView(entry.name, entry.size)) {
        actions.append(browseActionButton({
          label: `View ${entry.name}`,
          paths: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
          run: () => void viewFile(entry.path, entry.name, browseState.server, entry.size),
        }));
      }
      actions.append(browseActionButton({
        label: `Download ${entry.name}`,
        paths: ["M12 4v11m-4-4 4 4 4-4", "M5 20h14"],
        run: () => void downloadPath(entry.path, entry.name),
      }));
    }

    // Clicking the row selects it, and clicking a folder opens it -- the way an
    // editor sidebar behaves, rather than making people hit the small chevron.
    row.dataset.selected = String(browseState.selected === entry.path);
    row.addEventListener("click", () => {
      browseState.selected = entry.path;
      for (const other of elements.browseTree.querySelectorAll(".browse-row")) {
        other.dataset.selected = "false";
      }
      row.dataset.selected = "true";
      if (entry.kind === "directory" && !entry.broken) void toggleBrowseFolder(entry.path);
    });
  }

  row.append(lead, actions);
  return row;
}

// Folds as long as a project does in Sessions, which is what the CSS animates.
const BROWSE_FOLD_MS = 180;

function setBrowseTwisty(twisty, expanded) {
  twisty.setAttribute("aria-expanded", String(expanded));
  twisty.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${twisty.dataset.name}`);
}

// An open folder's rows sit in their own wrapper, right after the folder's row,
// so a folder opens and closes on its own -- sliding, as a project does --
// instead of the whole tree being drawn again.
function browseChildren() {
  const children = createElement("div", { className: "browse-children" });
  const inner = createElement("div", { className: "browse-children-inner" });
  children.append(inner);
  return { children, inner };
}

function appendBrowseRows(container, rows) {
  const open = [{ depth: -1, container }];
  for (const row of rows) {
    while (open.at(-1).depth >= row.depth) open.pop();
    const parent = open.at(-1).container;
    parent.append(browseRow(row));
    if (row.expanded && row.entry.kind === "directory") {
      const { children, inner } = browseChildren();
      parent.append(children);
      open.push({ depth: row.depth, container: inner });
    }
  }
}

function browseRowElement(path) {
  return [...elements.browseTree.querySelectorAll(".browse-row")].find((row) => row.dataset.path === path) || null;
}

function renderBrowseTree() {
  if (document.activeElement !== elements.filePath) {
    elements.filePath.value = browseState.root || "";
  }
  elements.fileUp.disabled = !parentDirectory(browseState.root);
  elements.fileUploads.disabled = !browseState.uploads || browseState.root === browseState.uploads;

  const rows = flattenTree(browseState.root, browseState.loaded, browseState.expanded);

  elements.browseTree.replaceChildren();
  if (rows.length === 0) {
    elements.browseTree.append(createElement("p", {
      className: "transfer-empty",
      text: "This folder is empty.",
    }));
    return;
  }
  appendBrowseRows(elements.browseTree, rows);
}

async function fetchListing(target, { prefix = "" } = {}) {
  const parts = [`server=${encodeURIComponent(browseState.server)}`];
  // A remote listing with no path starts at that server's home.
  if (target) parts.push(`path=${encodeURIComponent(target)}`);
  if (prefix !== "") parts.push(`prefix=${encodeURIComponent(prefix)}`);
  return transferRequest(`/api/browse?${parts.join("&")}`).then((response) => response.json());
}

async function toggleBrowseFolder(path) {
  if (browseState.expanded.has(path)) {
    browseState.expanded.delete(path);
    const row = browseRowElement(path);
    const children = row?.nextElementSibling?.classList.contains("browse-children") ? row.nextElementSibling : null;
    if (!children) {
      renderBrowseTree();
      return;
    }
    setBrowseTwisty(row.querySelector(".browse-twisty"), false);
    children.inert = true;
    children.classList.add("is-collapsed");
    // Dropped once folded, unless the folder was opened again meanwhile.
    window.setTimeout(() => {
      if (children.classList.contains("is-collapsed")) children.remove();
    }, BROWSE_FOLD_MS);
    return;
  }
  if (!browseState.loaded.has(path)) {
    setBrowseFeedback("Loading…");
    try {
      const listing = await fetchListing(path);
      browseState.loaded.set(listing.path, listing);
      setBrowseFeedback(listing.truncated ? `Showing the first ${listing.entries.length} of ${listing.total}.` : "");
    } catch (error) {
      setBrowseFeedback(error.message, true);
      return;
    }
  }
  browseState.expanded.add(path);
  // Looked up after the listing arrives: the tree may have been drawn again
  // while it loaded.
  const row = browseRowElement(path);
  if (!row) {
    renderBrowseTree();
    return;
  }
  setBrowseTwisty(row.querySelector(".browse-twisty"), true);
  const folding = row.nextElementSibling?.classList.contains("browse-children") ? row.nextElementSibling : null;
  const { children, inner } = folding ? { children: folding, inner: folding.firstElementChild } : browseChildren();
  if (!folding) {
    children.classList.add("is-collapsed");
    const depth = Number(row.style.getPropertyValue("--depth")) + 1;
    appendBrowseRows(inner, flattenTree(path, browseState.loaded, browseState.expanded, depth));
    row.after(children);
    // Laid out folded first, so opening is a change the transition can run.
    children.getBoundingClientRect();
  }
  children.inert = false;
  children.classList.remove("is-collapsed");
}

async function loadBrowseFolder(target, { refresh = false } = {}) {
  if (browseState.busy) return;
  browseState.busy = true;
  window.clearTimeout(browseState.clearDiffTimer);
  browseState.clearDiffTimer = null;
  browseState.addedPaths.clear();
  setBrowseFeedback("Loading…");
  try {
    const listing = await fetchListing(target);
    if (!refresh) browseState.expanded.clear();
    browseState.loaded.clear();
    browseState.loaded.set(listing.path, listing);
    browseState.root = listing.path;
    writeBrowsePath(browsePathStorage, listing.path, browseState.server);
    renderBrowseTree();
    setBrowseFeedback(listing.truncated ? `Showing the first ${listing.entries.length} of ${listing.total}.` : "");
  } catch (error) {
    setBrowseFeedback(error.message, true);
  } finally {
    browseState.busy = false;
  }
}

const BROWSE_AUTO_REFRESH_MS = 1_500;
const BROWSE_DIFF_CLEAR_MS = 4_000;

async function checkBrowseChanges(targets) {
  const targetEtags = {};
  for (const path of targets) {
    const listing = browseState.loaded.get(path);
    if (listing?.etag) targetEtags[path] = listing.etag;
  }
  if (Object.keys(targetEtags).length !== targets.length) {
    return targets;
  }
  const parts = [`server=${encodeURIComponent(browseState.server)}`];
  parts.push(`targets=${encodeURIComponent(JSON.stringify(targetEtags))}`);
  const result = await transferRequest(`/api/browse/check?${parts.join("&")}`)
    .then((r) => r.json())
    .catch(() => ({ changed: targets }));
  return Array.isArray(result?.changed) ? result.changed : targets;
}

async function refreshBrowseFolder({ silent = false } = {}) {
  if (browseState.busy || !browseState.root) return;
  browseState.busy = true;
  if (!silent) elements.fileRefresh?.classList.add("is-busy");

  try {
    const targets = [
      browseState.root,
      ...[...browseState.expanded].filter((path) => browseState.loaded.has(path) && path !== browseState.root),
    ];

    let pathsToFetch = targets;

    if (silent) {
      const changed = await checkBrowseChanges(targets);
      if (changed.length === 0) {
        return;
      }
      pathsToFetch = targets.filter((path) => changed.includes(path));
    }

    const results = await Promise.allSettled(pathsToFetch.map((path) => fetchListing(path)));

    let totalAdded = 0;
    let totalRemoved = 0;
    let anyChanged = false;

    for (let i = 0; i < pathsToFetch.length; i += 1) {
      const targetPath = pathsToFetch[i];
      const result = results[i];

      if (result.status !== "fulfilled") {
        if (targetPath !== browseState.root) {
          browseState.expanded.delete(targetPath);
          browseState.loaded.delete(targetPath);
          anyChanged = true;
        }
        continue;
      }

      const newListing = result.value;
      const oldListing = browseState.loaded.get(targetPath);

      const { listing: diffedListing, added, removed } = diffBrowseListing(oldListing, newListing);

      for (const entry of added) {
        browseState.addedPaths.add(entry.path);
        totalAdded += 1;
        anyChanged = true;
      }

      for (const entry of removed) {
        browseState.addedPaths.delete(entry.path);
        if (browseState.selected === entry.path) browseState.selected = null;
        totalRemoved += 1;
        anyChanged = true;
      }

      const newPaths = new Set((newListing.entries || []).map((entry) => entry.path));
      for (const path of browseState.addedPaths) {
        if (parentDirectory(path) === targetPath && !newPaths.has(path)) {
          browseState.addedPaths.delete(path);
        }
      }

      if (
        !oldListing ||
        diffedListing.entries.length !== oldListing.entries.length ||
        diffedListing.entries.some((entry, idx) => {
          const old = oldListing.entries[idx];
          return (
            !old ||
            old.path !== entry.path ||
            Boolean(old.removed) !== Boolean(entry.removed) ||
            old.size !== entry.size ||
            old.modifiedAt !== entry.modifiedAt
          );
        })
      ) {
        anyChanged = true;
      }

      browseState.loaded.set(targetPath, diffedListing);
    }

    if (anyChanged) {
      renderBrowseTree();
    }

    const summary = browseDiffSummary(totalAdded, totalRemoved);

    if (summary) {
      setBrowseFeedback(summary);
      window.clearTimeout(browseState.clearDiffTimer);
      browseState.clearDiffTimer = window.setTimeout(() => {
        browseState.clearDiffTimer = null;
        browseState.addedPaths.clear();
        for (const [path, listing] of browseState.loaded.entries()) {
          const cleaned = listing.entries.filter((entry) => !entry.removed);
          if (cleaned.length !== listing.entries.length) {
            browseState.loaded.set(path, { ...listing, entries: cleaned });
          }
        }
        renderBrowseTree();
        const rootListing = browseState.loaded.get(browseState.root);
        setBrowseFeedback(
          rootListing?.truncated ? `Showing the first ${rootListing.entries.length} of ${rootListing.total}.` : ""
        );
      }, BROWSE_DIFF_CLEAR_MS);
    } else if (!silent) {
      if (browseState.addedPaths.size > 0 || [...browseState.loaded.values()].some((l) => l.entries.some((e) => e.removed))) {
        browseState.addedPaths.clear();
        for (const [path, listing] of browseState.loaded.entries()) {
          const cleaned = listing.entries.filter((entry) => !entry.removed);
          if (cleaned.length !== listing.entries.length) {
            browseState.loaded.set(path, { ...listing, entries: cleaned });
          }
        }
        renderBrowseTree();
      }
      const rootListing = browseState.loaded.get(browseState.root);
      setBrowseFeedback(
        rootListing?.truncated
          ? `Showing the first ${rootListing.entries.length} of ${rootListing.total}.`
          : "Folder is up to date."
      );
    }
  } catch (error) {
    if (!silent) {
      setBrowseFeedback(error.message, true);
    }
  } finally {
    browseState.busy = false;
    elements.fileRefresh?.classList.remove("is-busy");
  }
}


const browsePathStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

async function ensureUploadsPath() {
  if (browseState.uploads !== null) return browseState.uploads;
  const server = encodeURIComponent(browseState.server);
  const { directory } = await transferRequest(`/api/files?server=${server}`)
    .then((response) => response.json())
    .catch(() => ({ directory: null }));
  browseState.uploads = directory || null;
  return browseState.uploads;
}

// Files opens where browsing last stopped; the uploads folder is the fallback on a
// first visit because it is the one folder this app is certain exists.
// The snapshot already carries every configured server with its reachability,
// including ones Herdr could not answer on. Reading the session records instead
// would drop exactly those, and files may still be reachable over SFTP when
// Herdr itself is missing.
function refreshServerChoices() {
  const options = [
    { id: "local", name: "This machine" },
    // Every linked server answers for its own files, and a Herdr SSH machine
    // through its SSH connection. One that is turned off has none to offer.
    ...array(state.snapshot?.servers)
      .filter((server) => server.id !== "local" && server.enabled !== false)
      .map((server) => ({ id: server.id, name: server.name || server.id })),
  ];
  elements.fileServer.replaceChildren();
  for (const option of options) {
    const node = createElement("option", { text: option.name });
    node.value = option.id;
    elements.fileServer.append(node);
  }
  // A server that was removed falls back to this machine.
  // A pinned machine that is gone falls back to following the session again --
  // but only once a snapshot has actually said which servers exist. Before that
  // the list is just this machine, and clearing here would drop the choice on
  // every reload.
  const known = array(state.snapshot?.servers);
  if (known.length > 0 && browseState.pinnedServer !== null &&
      !options.some((option) => option.id === browseState.pinnedServer)) {
    browseState.pinnedServer = null;
    writeFileServer(browsePathStorage, null);
  }
  elements.fileServer.value = browseState.server;
  elements.fileServer.hidden = options.length < 2;
}

async function openFilePanel() {
  if (browseState.root) {
    await refreshBrowseFolder({ silent: true });
    return;
  }
  refreshServerChoices();
  const remembered = readBrowsePath(browsePathStorage, browseState.server);
  const uploads = await ensureUploadsPath();
  await loadBrowseFolder(remembered || uploads || "/");
}

elements.fileServer.addEventListener("change", () => {
  browseState.server = elements.fileServer.value;
  writeFileServer(browsePathStorage, browseState.server);
  syncAttachAvailability();
  browseState.uploads = null;
  browseState.root = null;
  window.clearTimeout(browseState.clearDiffTimer);
  browseState.clearDiffTimer = null;
  browseState.addedPaths.clear();
  browseState.loaded.clear();
  browseState.expanded.clear();
  completion.entries = [];
  // An empty target asks the server where its home is.
  void loadBrowseFolder(readBrowsePath(browsePathStorage, browseState.server) || "");
});

function showNavigatorTab(tab) {
  const files = tab === "files";
  elements.tabSessions.setAttribute("aria-selected", String(!files));
  elements.tabFiles.setAttribute("aria-selected", String(files));
  elements.workspaceList.hidden = files;
  elements.filePanel.hidden = !files;
  writeNavigatorTab(browsePathStorage, tab);
  if (files) {
    if (browseState.root) void refreshBrowseFolder({ silent: true });
    else void openFilePanel();
  }
}

for (const tab of elements.navigatorTabs) {
  tab.addEventListener("click", () => showNavigatorTab(tab === elements.tabFiles ? "files" : "sessions"));
}

// A file tree needs more room than a session list, so the sidebar is draggable
// and remembers the width. On a phone the sidebar is a full-width overlay and
// the handle does nothing, so it is hidden there by CSS.
function applyNavigatorWidth(width) {
  const clamped = clampNavigatorWidth(width);
  // Set on the root so the shell grid narrows the terminal by the same amount
  // the sidebar gains, instead of the two overlapping.
  document.documentElement.style.setProperty("--navigator-width", `${clamped}px`);
  elements.navigatorResizer.setAttribute("aria-valuenow", String(clamped));
  return clamped;
}

let navigatorWidth = applyNavigatorWidth(readNavigatorWidth(browsePathStorage));

elements.navigatorResizer.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = navigatorWidth;
  elements.navigatorResizer.setPointerCapture(event.pointerId);
  document.body.classList.add("is-resizing-sidebar");

  const move = (moveEvent) => {
    navigatorWidth = applyNavigatorWidth(startWidth + (moveEvent.clientX - startX));
  };
  const stop = () => {
    elements.navigatorResizer.removeEventListener("pointermove", move);
    elements.navigatorResizer.removeEventListener("pointerup", stop);
    elements.navigatorResizer.removeEventListener("pointercancel", stop);
    document.body.classList.remove("is-resizing-sidebar");
    writeNavigatorWidth(browsePathStorage, navigatorWidth);
  };
  elements.navigatorResizer.addEventListener("pointermove", move);
  elements.navigatorResizer.addEventListener("pointerup", stop);
  elements.navigatorResizer.addEventListener("pointercancel", stop);
});

elements.navigatorResizer.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 40 : 12;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  navigatorWidth = applyNavigatorWidth(navigatorWidth + (event.key === "ArrowRight" ? step : -step));
  writeNavigatorWidth(browsePathStorage, navigatorWidth);
});

elements.fileRefresh?.addEventListener("click", () => {
  if (browseState.root) void refreshBrowseFolder({ silent: false });
  else void openFilePanel();
});

elements.fileUp.addEventListener("click", () => {
  const parent = parentDirectory(browseState.root);
  if (parent) void loadBrowseFolder(parent);
});

// The uploads folder gets its own dialog rather than sending the tree there:
// it is a short list you act on, not somewhere to browse.
elements.fileUploads.addEventListener("click", () => openUploadsDialog());

window.setInterval(() => {
  if (
    elements.filePanel &&
    !elements.filePanel.hidden &&
    !document.hidden &&
    browseState.root &&
    !browseState.busy &&
    document.activeElement !== elements.filePath
  ) {
    void refreshBrowseFolder({ silent: true });
  }
}, BROWSE_AUTO_REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
    void refreshBrowseFolder({ silent: true });
  }
});

const completion = { entries: [], active: -1, timer: null };

function hideSuggestions() {
  // Cancel the pending lookup too, or it reopens the list a moment later.
  window.clearTimeout(completion.timer);
  completion.active = -1;
  elements.fileSuggestions.hidden = true;
  elements.fileSuggestions.replaceChildren();
  elements.filePath.setAttribute("aria-expanded", "false");
}

function applySuggestion(value) {
  elements.filePath.value = value;
  hideSuggestions();
  void loadBrowseFolder(value);
}

function renderSuggestions(matches) {
  elements.fileSuggestions.replaceChildren();
  if (matches.length === 0) {
    hideSuggestions();
    return;
  }
  matches.forEach((entry, index) => {
    const item = createElement("li", { className: "file-suggestion" });
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === completion.active));
    item.append(createElement("span", { text: entry.name }));
    item.addEventListener("mousedown", (event) => {
      // mousedown beats the input losing focus and closing the list first.
      event.preventDefault();
      applySuggestion(entry.path);
    });
    elements.fileSuggestions.append(item);
  });
  elements.fileSuggestions.hidden = false;
  elements.filePath.setAttribute("aria-expanded", "true");
}

async function updateCompletion() {
  const typed = elements.filePath.value;
  if (!typed.startsWith("/")) {
    hideSuggestions();
    return;
  }
  const cut = typed.lastIndexOf("/");
  const folder = cut === 0 ? "/" : typed.slice(0, cut);
  const prefix = typed.slice(cut + 1).toLowerCase();

  // The server does the prefix match: a folder like /tmp can hold thousands of
  // entries, and filtering here would only see whatever survived the limit.
  try {
    const listing = await fetchListing(folder, { prefix });
    // Typing moves on while the request is in flight; a reply the caret has
    // already left behind would otherwise replace the newer list.
    if (elements.filePath.value !== typed) return;
    completion.entries = listing.entries.filter((entry) => entry.kind === "directory");
  } catch {
    if (elements.filePath.value !== typed) return;
    completion.entries = [];
  }
  completion.active = -1;
  renderSuggestions(completion.entries.slice(0, 12));
}

elements.filePath.addEventListener("input", () => {
  // A short wait keeps a fast typist from firing one listing per keystroke.
  window.clearTimeout(completion.timer);
  completion.timer = window.setTimeout(() => void updateCompletion(), 150);
});

elements.filePath.addEventListener("keydown", (event) => {
  const items = [...elements.fileSuggestions.children];
  if (event.key === "Escape" && !elements.fileSuggestions.hidden) {
    event.preventDefault();
    hideSuggestions();
    return;
  }
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length > 0) {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    completion.active = (completion.active + step + items.length) % items.length;
    items.forEach((item, index) => item.setAttribute("aria-selected", String(index === completion.active)));
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const chosen = items[completion.active];
    if (chosen) {
      const match = completion.entries.find((entry) => entry.name === chosen.textContent);
      applySuggestion(match ? match.path : elements.filePath.value);
      return;
    }
    hideSuggestions();
    void loadBrowseFolder(elements.filePath.value);
  }
});

elements.filePath.addEventListener("blur", () => window.setTimeout(hideSuggestions, 120));

elements.themeToggle.addEventListener("click", () => {
  const currentTheme = window.herdrTheme?.current() || "dark";
  window.herdrTheme?.set(currentTheme === "dark" ? "light" : "dark");
});

elements.notificationToggle.addEventListener("click", () => {
  void togglePushNotifications();
});

window.addEventListener("herdr-theme-change", syncThemeButton);

elements.sidebarToggle.addEventListener("click", () => {
  markSidebarAnimating();
  if (desktopMedia.matches) {
    state.desktopSidebarCollapsed = !state.desktopSidebarCollapsed;
  } else {
    state.mobileSidebarOpen = false;
  }
  syncSidebar();
  if (!desktopMedia.matches) elements.mobileSidebarOpen.focus();
});

elements.navigator.addEventListener("transitionend", (event) => {
  if (event.target === elements.navigator && event.propertyName === "transform") {
    clearSidebarAnimationState();
  }
});

elements.mobileSidebarOpen.addEventListener("click", () => {
  state.mobileSidebarOpen = true;
  syncSidebar();
  elements.sidebarToggle.focus();
});

elements.sidebarScrim.addEventListener("click", () => {
  closeMobileSidebar({ restoreFocus: true });
});

elements.terminalPanel.addEventListener("wheel", (event) => {
  if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
  event.preventDefault();
  if (
    terminalFontWheelDelta !== 0 &&
    Math.sign(terminalFontWheelDelta) !== Math.sign(event.deltaY)
  ) {
    terminalFontWheelDelta = 0;
  }
  terminalFontWheelDelta += event.deltaY;
  if (Math.abs(terminalFontWheelDelta) < 40) return;
  adjustTerminalFont(terminalFontWheelDelta < 0 ? "larger" : "smaller");
  terminalFontWheelDelta = 0;
// Caught on the way down: the attached terminal stops a wheel once a program
// there turns on mouse reports.
}, { passive: false, capture: true });

elements.terminalOutput.addEventListener("touchstart", (event) => {
  const distance = touchDistance(event.touches);
  if (distance === null) {
    terminalPinchDistance = null;
    return;
  }
  event.preventDefault();
  terminalPinchDistance = distance;
}, { passive: false });

elements.terminalOutput.addEventListener("touchmove", (event) => {
  const distance = touchDistance(event.touches);
  if (distance === null) {
    terminalPinchDistance = null;
    return;
  }
  event.preventDefault();
  const direction = terminalPinchDirection(terminalPinchDistance, distance);
  if (!direction) return;
  adjustTerminalFont(direction);
  terminalPinchDistance = distance;
}, { passive: false });

function finishTerminalPinch(event) {
  if (event.touches.length < 2) terminalPinchDistance = null;
}

elements.terminalOutput.addEventListener("touchend", finishTerminalPinch);
elements.terminalOutput.addEventListener("touchcancel", finishTerminalPinch);

function activatePaneShortcut(event) {
  if (!state.authenticated || document.querySelector("dialog[open]")) return false;
  const paneButtons = Array.from(
    elements.workspaceList.querySelectorAll(".pane-button"),
  );
  const targetPaneId = paneShortcutTarget({
    key: event.key,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    paneIds: paneButtons.map((button) => button.dataset.paneId),
    currentPaneId: state.selectedPaneId,
  });
  if (!targetPaneId) return false;

  const targetButton = paneButtons.find(
    (button) => button.dataset.paneId === targetPaneId,
  );
  if (!targetButton) return false;
  event.preventDefault();
  targetButton.click();
  return true;
}

document.addEventListener("keydown", (event) => {
  if (activatePaneShortcut(event)) return;
  if (event.key !== "Escape") return;
  document.querySelector("#add-menu").open = false;
  state.openActionMenuId = null;
  for (const menu of elements.workspaceList.querySelectorAll(
    ".sidebar-action-menu[open]",
  )) menu.open = false;
  closeMobileSidebar({ restoreFocus: true });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#add-menu")) document.querySelector("#add-menu").open = false;
  if (event.target.closest(".sidebar-action-menu")) return;
  state.openActionMenuId = null;
  for (const menu of elements.workspaceList.querySelectorAll(
    ".sidebar-action-menu[open]",
  )) menu.open = false;
});

desktopMedia.addEventListener("change", () => {
  state.mobileSidebarOpen = false;
  syncSidebar();
});

function renderTerminalLive() {
  elements.terminalLive.hidden = !state.selectedPaneId || !elements.terminalXterm.hidden ||
    (state.terminalFollow && !state.remoteHistoryPanes.has(state.selectedPaneId));
  elements.terminalLive.disabled = state.remoteLiveRequests.has(state.selectedPaneId);
}

// Older history is for reading. Kept after the reader is back at the bottom
// or has moved to another pane, every stream update re-renders all of it and
// typing stalls behind that.
function collapseTerminalHistory(paneId) {
  if ((state.outputLineLimits.get(paneId) || HISTORY_PAGE_LINES) <= HISTORY_PAGE_LINES) return false;
  state.outputLineLimits.delete(paneId);
  state.outputHasMore.delete(paneId);
  state.historyRequested.delete(paneId);
  return true;
}

async function returnTerminalToLive() {
  const paneId = state.selectedPaneId;
  if (!state.authenticated || !paneId || state.remoteLiveRequests.has(paneId)) return;
  if (collapseTerminalHistory(paneId)) void refreshOutput();
  if (!state.remoteHistoryPanes.has(paneId)) {
    if (!state.terminalFollow) refreshAfterSubmission();
    return;
  }
  state.remoteLiveRequests.add(paneId);
  state.terminalFollow = true;
  state.terminalScrollSettlesAt = 0;
  renderTerminalLive();
  try {
    await api(`/api/panes/${encodeURIComponent(paneId)}/keys`, {
      method: "POST", body: { keys: ["ctrl+end"] },
    });
    state.remoteHistoryPanes.delete(paneId);
    if (state.selectedPaneId === paneId) refreshAfterSubmission();
  } catch (error) {
    if (state.selectedPaneId === paneId) setFeedback(error.message, true);
  } finally {
    state.remoteLiveRequests.delete(paneId);
    renderTerminalLive();
  }
}

function terminalAtBottom() {
  return nearTerminalBottom({
    scrollTop: elements.terminalOutput.scrollTop,
    scrollHeight: elements.terminalOutput.scrollHeight,
    clientHeight: elements.terminalOutput.clientHeight,
  });
}

elements.terminalLive.addEventListener("click", () => void returnTerminalToLive());
elements.terminalOutput.addEventListener("wheel", (event) => {
  if (event.deltaY > 0 && !event.ctrlKey && terminalAtBottom()) void returnTerminalToLive();
}, { passive: true });
let terminalTouchY = null;
elements.terminalOutput.addEventListener("touchstart", (event) => {
  terminalTouchY = event.touches.length === 1 ? event.touches[0].clientY : null;
}, { passive: true });
elements.terminalOutput.addEventListener("touchmove", (event) => {
  if (event.touches.length !== 1) { terminalTouchY = null; return; }
  const nextY = event.touches[0].clientY;
  if (terminalTouchY !== null && nextY < terminalTouchY - 8 && terminalAtBottom()) void returnTerminalToLive();
  if (terminalTouchY === null || nextY > terminalTouchY) terminalTouchY = nextY;
}, { passive: true });

function markTerminalUserScroll() {
  state.terminalUserScrollAt = Date.now();
}

for (const gesture of ["wheel", "touchmove"]) {
  elements.terminalOutput.addEventListener(gesture, markTerminalUserScroll, {
    passive: true,
  });
}

let previousTerminalScrollTop = 0;
elements.terminalOutput.addEventListener("scroll", () => {
  const scrollingDown = elements.terminalOutput.scrollTop > previousTerminalScrollTop;
  previousTerminalScrollTop = elements.terminalOutput.scrollTop;
  const readerDriven = state.terminalPointerActive ||
    Date.now() - state.terminalUserScrollAt < TERMINAL_USER_SCROLL_WINDOW_MS;
  if (readerDriven) {
    state.terminalFollow = nearTerminalBottom({
      scrollTop: elements.terminalOutput.scrollTop,
      scrollHeight: elements.terminalOutput.scrollHeight,
      clientHeight: elements.terminalOutput.clientHeight,
      lineHeight: state.terminalFontSize * TERMINAL_LINE_HEIGHT_RATIO,
    });
    renderTerminalLive();
    if (scrollingDown && state.terminalFollow) void returnTerminalToLive();
    // While the view follows the bottom the scrolling is ours, not the
    // reader's, and re-rendering there is what keeps output visible.
    if (!state.terminalFollow) {
      state.terminalScrollSettlesAt = Date.now() + TERMINAL_SCROLL_SETTLE_MS;
    }
  }
  if (
    elements.terminalOutput.scrollTop <= 24 &&
    state.outputHasMore.get(state.selectedPaneId) === true
  ) {
    void refreshOutput({ loadOlder: true });
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) terminalStream.pause();
  if (document.hidden || !state.authenticated) return;
  void dismissDeliveredNotifications();
  if (pendingNotificationPaneId) void refreshSnapshot();
  void refreshOutput();
});

elements.terminalOutput.addEventListener("pointerdown", () => {
  state.terminalPointerActive = true;
});

window.addEventListener("pointerup", () => {
  state.terminalPointerActive = false;
});

window.addEventListener("pointercancel", () => {
  state.terminalPointerActive = false;
});

elements.loginScreen.addEventListener("click", (event) => {
  if (event.target.closest("button, a, input, label")) return;
  focusLoginPassword();
});

window.addEventListener("focus", restoreLoginFocus);
window.addEventListener("pageshow", restoreLoginFocus);

elements.loginPassword.addEventListener("input", () => {
  if (elements.loginPassword.value) rememberLoginMethod("password");
});

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  rememberLoginMethod("password");
  setLoginBusy(true);
  elements.loginFeedback.textContent = "Signing in…";
  elements.loginFeedback.dataset.error = "false";
  try {
    const login = await api("/api/auth/login", {
      method: "POST",
      csrf: false,
      body: { password: elements.loginPassword.value },
    });
    state.launchToken = writeLaunchToken(
      launchSessionStorage,
      login.launchToken,
    );
    state.passkeyAvailable = login.passkeyAvailable === true;
    const shouldOfferRegistration = !state.passkeyAvailable && supportsPasskeys();
    elements.loginPassword.value = "";
    await initializeApplication();
    if (shouldOfferRegistration) offerPasskeyRegistration();
  } catch (error) {
    elements.loginFeedback.textContent = error.message;
    elements.loginFeedback.dataset.error = "true";
  } finally {
    setLoginBusy(false);
    if (elements.loginFeedback.dataset.error === "true") {
      elements.loginPassword.focus();
      elements.loginPassword.select();
    }
  }
});

async function startPasskeyLogin() {
  if (state.passkeyBusy || state.authenticated || !state.passkeyAvailable || !supportsPasskeys()) return;
  setLoginBusy(true);
  elements.loginFeedback.textContent = "Verifying passkey…";
  elements.loginFeedback.dataset.error = "false";
  try {
    const ceremony = await api("/api/auth/passkeys/login/options", {
      method: "POST",
      csrf: false,
      body: {},
    });
    const credential = await window.SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: ceremony.options,
    });
    await completePasskeyLogin(ceremony, credential);
  } catch (error) {
    elements.loginFeedback.textContent = passkeyErrorMessage(error);
    elements.loginFeedback.dataset.error = "true";
  } finally {
    setLoginBusy(false);
    if (document.activeElement === document.body) focusLoginMethod();
  }
}

elements.passkeyLogin.addEventListener("click", () => {
  rememberLoginMethod("passkey");
  void startPasskeyLogin();
});
document.addEventListener("visibilitychange", restoreLoginFocus);

elements.passkeyDialogCancel.addEventListener("click", () => {
  if (!state.passkeyBusy) elements.passkeyDialog.close();
});

elements.passkeyDialog.addEventListener("cancel", (event) => {
  if (state.passkeyBusy) event.preventDefault();
});
elements.passkeyDialog.addEventListener("close", () => {
  elements.passkeyDialogPassword.value = "";
});

elements.passkeyRegister.addEventListener("click", async () => {
  if (state.passkeyBusy || !supportsPasskeys()) return;
  let password;
  if (!elements.passkeyDialogPasswordField.hidden) {
    password = enteredPassword(elements.passkeyDialogPassword, elements.passkeyDialogFeedback);
    if (!password) return;
  }
  state.passkeyBusy = true;
  elements.passkeyRegister.disabled = true;
  elements.passkeyDialogCancel.disabled = true;
  elements.passkeyDialogFeedback.textContent = "Follow the prompt on your device…";
  elements.passkeyDialogFeedback.dataset.error = "false";
  try {
    await registerPasskey(password);
    elements.passkeyDialog.close();
  } catch (error) {
    elements.passkeyDialogFeedback.textContent = passkeyErrorMessage(error);
    elements.passkeyDialogFeedback.dataset.error = "true";
    if (error.code === "invalid_password" && elements.passkeyDialogPasswordField.hidden) {
      elements.passkeyDialogPasswordField.hidden = false;
      elements.passkeyDialogFeedback.textContent = "Enter your password to register a passkey.";
      requestAnimationFrame(() => elements.passkeyDialogPassword.focus());
    }
  } finally {
    state.passkeyBusy = false;
    elements.passkeyRegister.disabled = false;
    elements.passkeyDialogCancel.disabled = false;
    renderLoginMethods();
  }
});

async function initializeApplication() {
  document.querySelector("#manage-servers").disabled = false;
  const bootstrap = await api("/api/bootstrap");
  state.csrfToken = bootstrap.csrfToken;
  state.pollIntervalMs = bootstrap.pollIntervalMs || state.pollIntervalMs;
  state.pushPublicKey = typeof bootstrap.pushPublicKey === "string"
    ? bootstrap.pushPublicKey
    : null;
  document.querySelector("#add-machine").hidden = bootstrap.machines !== true;
  showApplication();
  browseState.pinnedServer = readFileServer(browsePathStorage);
  showNavigatorTab(readNavigatorTab(browsePathStorage));
  await refreshSnapshot();
  void resumeAiLogins();
  await refreshOutput();
  if (notificationPanePreference) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("pane");
    window.history.replaceState(null, "", cleanUrl);
  }
  void syncPushSubscription().catch(() => renderNotificationButton());
  void dismissDeliveredNotifications();
  focusComposer();
  if (!state.pollingStarted) {
    state.pollingStarted = true;
    window.setInterval(() => void refreshSnapshot(), state.pollIntervalMs * 2);
    window.setInterval(refreshOutputOnSchedule, Math.min(state.pollIntervalMs, OUTPUT_POLL_TICK_MS));
  }
}

const serversDialog = document.querySelector("#servers-dialog");
const serverForm = document.querySelector("#server-form");
const serverFeedback = document.querySelector("#server-feedback");
let editingServer = null;
let serverBusy = false;


// A server is only worth saving once it has actually answered, so Save stays
// closed until a test succeeds and reopens only for the settings that passed.
const serverSubmitButton = serverForm.querySelector('button[type="submit"]');
let verifiedServerSettings = null;

function serverFormValues() {
  return Object.fromEntries(new FormData(serverForm));
}

function serverFormFingerprint() {
  return JSON.stringify(serverFormValues());
}

function syncServerSubmitState() {
  const verified = verifiedServerSettings !== null && verifiedServerSettings === serverFormFingerprint();
  serverSubmitButton.disabled = !verified;
  serverSubmitButton.title = verified ? "" : "Test the connection first";
}

serverForm.addEventListener("input", syncServerSubmitState);
serverForm.addEventListener("change", syncServerSubmitState);

function resetServerForm(profile = null) {
  editingServer = profile?.id || null;
  serverForm.reset();
  if (profile) for (const name of ["name", "address"]) {
    serverForm.elements.namedItem(name).value = profile[name] ?? "";
  }
  chosenBlock.hidden = profile === null;
  chosenAddress.textContent = profile?.address ?? "";
  serverFeedback.textContent = "";
  serverFeedback.dataset.error = "false";
  serverForm.querySelector('button[type="submit"]').textContent = profile ? "Save changes" : "Save";
  // Switching to another server drops whatever the last test proved.
  verifiedServerSettings = null;
  syncServerSubmitState();
}

async function serverAction(action) {
  if (serverBusy) return;
  serverBusy = true;
  serversDialog.querySelectorAll("button, input, select").forEach((element) => { element.disabled = true; });
  serverFeedback.textContent = "Connecting…";
  serverFeedback.dataset.error = "false";
  try { await action(); }
  catch (error) { serverFeedback.textContent = error.message; serverFeedback.dataset.error = "true"; }
  finally {
    serverBusy = false;
    serversDialog.querySelectorAll("button, input, select").forEach((element) => { element.disabled = false; });
    // The blanket re-enable above would otherwise hand Save back untested.
    syncServerSubmitState();
  }
}

let savedServers = [];

async function loadServers() {
  savedServers = (await api("/api/servers")).profiles;
}

const machineDialog = document.querySelector("#machine-dialog");
const machineFeedback = document.querySelector("#machine-feedback");
document.querySelector("#add-machine").addEventListener("click", () => {
  document.querySelector("#add-menu").open = false;
  document.querySelector("#machine-form").reset();
  machineFeedback.textContent = "";
  machineFeedback.dataset.error = "false";
  machineDialog.showModal();
});
document.querySelector("#machine-cancel").addEventListener("click", () => machineDialog.close());
document.querySelector("#machine-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const controls = form.querySelectorAll("button, input");
  controls.forEach((control) => { control.disabled = true; });
  machineFeedback.dataset.error = "false";
  // Setting Herdr up there can take a while on a first connection.
  machineFeedback.textContent = "Connecting and setting up Herdr there…";
  try {
    await api("/api/machines", { method: "POST", body: {
      target: form.elements.target.value.trim(), label: form.elements.label.value.trim(),
    } });
    machineDialog.close();
    await refreshSnapshot();
  } catch (error) {
    machineFeedback.textContent = error.message;
    machineFeedback.dataset.error = "true";
  } finally {
    controls.forEach((control) => { control.disabled = false; });
  }
});

document.querySelector("#manage-servers").addEventListener("click", () => {
  document.querySelector("#add-menu").open = false;
  resetServerForm();
  serversDialog.showModal();
  void serverAction(async () => { await loadServers(); serverFeedback.textContent = ""; });
  void lookForServers();
});

// Typing a tailnet address is a poor way to answer "which machine": the hub can
// list them, and it can say which ones are actually ready to be added.
const candidateList = document.querySelector("#server-candidates");
const setupHint = document.querySelector("#server-setup-hint");
const restSummary = document.querySelector("#server-rest");

const chosenBlock = document.querySelector("#server-chosen");
const chosenAddress = document.querySelector("#server-chosen-address");

// A machine is picked, never typed. The address comes from the tailnet, so the
// only thing left to decide is what to call it here.
function chooseCandidate(candidate) {
  serverForm.elements.namedItem("name").value = candidate?.name ?? "";
  serverForm.elements.namedItem("address").value = candidate?.address ?? "";
  chosenBlock.hidden = candidate === null;
  chosenAddress.textContent = candidate ? candidate.address : "";
  for (const row of candidateList.querySelectorAll(".server-candidate")) {
    row.classList.toggle("is-chosen", row.dataset.address === candidate?.address);
  }
  syncServerSubmitState();
  if (candidate) serverFeedback.textContent = "Test it to save.";
}

const CANDIDATE_LABELS = {
  ready: "Ready",
  added: "Added",
  refused: "Refuses this hub",
  incompatible: "Other version",
  absent: "No HerdRabbit",
  offline: "Offline",
};

// A leaf tells its hub where it is, so anything addable is here without being
// hunted for. What the scan still earns its keep for is the machine that runs
// HerdRabbit and will not take this hub -- it points at another one, so it
// never announces itself here, and only a probe can say so.
const CANDIDATE_ORDER = ["ready", "refused", "incompatible", "added"];
const NOTHING_TO_DO = new Set(["absent", "offline"]);

function candidateRow(candidate) {
  const row = createElement("button", { className: `server-candidate is-${candidate.state}` });
  row.type = "button";
  // Only a ready machine can be filled in; the rest are shown so the reason is
  // visible rather than the machine simply being missing.
  row.disabled = candidate.state !== "ready";
  row.dataset.address = candidate.address;
  row.title = candidate.reason || candidate.address;
  // The same shape the sidebar uses for a server: a dot for whether it is
  // there, the name, then where it is. A dialog that looks like a different
  // application is one more thing to read.
  const dot = createElement("span", { className: "server-candidate-dot" });
  dot.setAttribute("aria-hidden", "true");
  const identity = createElement("span", { className: "server-candidate-identity" });
  let where = candidate.address;
  try {
    const url = new URL(candidate.address);
    where = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch { /* an address we cannot parse is shown as it came */ }
  identity.append(
    createElement("strong", { text: candidate.name }),
    createElement("small", { text: where }),
  );
  row.append(dot, identity, createElement("small", {
    className: "server-candidate-state",
    text: CANDIDATE_LABELS[candidate.state] || candidate.state,
  }));
  row.addEventListener("click", () => chooseCandidate(candidate));
  return row;
}

function renderCandidates(found) {
  candidateList.replaceChildren();
  restSummary.textContent = "";
  if (!found.available) {
    setupHint.textContent = "Tailscale is not running, so machines cannot be listed.";
    return;
  }
  setupHint.textContent = found.self?.address
    ? `New machine? Install it as a leaf of ${found.self.address}`
    : "";
  if (found.candidates.length === 0) {
    candidateList.append(createElement("p", { className: "dialog-feedback", text: "No other machines here." }));
    return;
  }

  const ordered = [...found.candidates].sort((first, second) =>
    CANDIDATE_ORDER.indexOf(first.state) - CANDIDATE_ORDER.indexOf(second.state));
  const actionable = ordered.filter((candidate) => !NOTHING_TO_DO.has(candidate.state));
  const rest = ordered.filter((candidate) => NOTHING_TO_DO.has(candidate.state));

  for (const candidate of actionable) candidateList.append(candidateRow(candidate));
  if (actionable.length === 0) {
    candidateList.append(createElement("p", {
      className: "dialog-feedback",
      text: "Nothing ready to add yet.",
    }));
  }
  // Counted, not listed, and outside the scrolling list -- inside it the count
  // sat below the fold, which is the one place it could not do its job.
  // Some are switched off and some have no HerdRabbit; either way there is
  // nothing to connect to, and saying which would need a row each.
  restSummary.textContent = rest.length === 0
    ? ""
    : `${rest.length} other ${rest.length === 1 ? "machine" : "machines"} with nothing to connect to.`;
}

async function lookForServers() {
  candidateList.replaceChildren(createElement("p", { className: "dialog-feedback", text: "Looking…" }));
  setupHint.textContent = "";
  try {
    renderCandidates(await api("/api/servers/discover", { method: "POST", body: {} }));
  } catch (error) {
    candidateList.replaceChildren();
    setupHint.textContent = error.message;
  }
}

document.querySelector("#server-refresh").addEventListener("click", () => { void lookForServers(); });
document.querySelector("#server-close").addEventListener("click", () => { if (!serverBusy) serversDialog.close(); });
serversDialog.addEventListener("cancel", (event) => { if (serverBusy) event.preventDefault(); });
serversDialog.addEventListener("close", () => { serverForm.elements.namedItem("password").value = ""; });
document.querySelector("#server-test").addEventListener("click", () => {
  if (!serverForm.reportValidity()) return;
  const profile = serverFormValues();
  const tested = serverFormFingerprint();
  void serverAction(async () => {
    const result = await api("/api/servers/test", { method: "POST", body: profile });
    verifiedServerSettings = tested;
    syncServerSubmitState();
    const reached = result.version ? `Connected to HerdRabbit ${result.version}.` : "Connected.";
    serverFeedback.textContent = `${reached} ${result.sessions} Herdr sessions, ${result.panes} panes. You can save now.`;
  });
});
serverForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (serverSubmitButton.disabled) return;
  const profile = serverFormValues();
  void serverAction(async () => {
    await api(editingServer ? `/api/servers/${editingServer}` : "/api/servers", {
      method: editingServer ? "PUT" : "POST", body: profile,
    });
    resetServerForm();
    await loadServers();
    await refreshSnapshot();
    serverFeedback.textContent = "Saved. Connection status appears in the sidebar.";
  });
});

async function start() {
  if ("BroadcastChannel" in window) {
    notificationRelayChannel = new BroadcastChannel("herdr-notification-navigation");
    notificationRelayChannel.onmessage = ({ data }) => {
      if (data?.type === "notification-target") receiveNotificationRelay(data);
    };
  }
  if (window.launchQueue?.setConsumer) {
    window.launchQueue.setConsumer((launch) => {
      if (launch.targetURL) acceptNotificationTarget(launch.targetURL);
    });
  }
  syncThemeButton();
  renderNotificationButton();
  syncSidebar();
  resizeTerminalInput();
  if ("serviceWorker" in navigator) {
    // Update the existing scope explicitly: the page and notification handler
    // must advance together, even when the browser retains the old script URL.
    void navigator.serviceWorker.register("/sw.js?revision=notification-routing-4", {
      scope: "/", updateViaCache: "none",
    }).then((registration) => {
      registration.waiting?.postMessage({ type: "activate-worker" });
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed") installing.postMessage({ type: "activate-worker" });
      });
    }).catch(() => {});
  }
  try {
    const authStatus = await api("/api/auth/status", { csrf: false });
    state.passkeyAvailable = authStatus.passkeyAvailable === true;
    state.authRequired = authStatus.required === true;
    if (authStatus.required && !authStatus.authenticated) {
      showLogin();
      return;
    }
    await initializeApplication();
  } catch (error) {
    if (error.code === "authentication_required") return;
    document.body.classList.remove("auth-pending", "auth-required");
    document.body.classList.add("auth-ready");
    elements.shell.inert = false;
    setConnection("error", error.message);
    showTerminalMessage(`Could not initialize: ${error.message}`);
  }
}

void start();
