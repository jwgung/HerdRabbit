import { combinedTerminalKey, keyboardTerminalKey } from "./key-combinations.js?v=1.2.71";
import { MAX_TEXT_PREVIEW_BYTES, previewFor } from "./file-preview.js?v=1.2.71";
import { isFileName, isFolderPath, trimTrailingSlashes } from "./path-links.js?v=1.2.71";
import { createUpdatePanel } from "./app-update.js?v=1.2.71";
const selectedKeyModifiers = new Set();
let modifierPaneId = null;
let keySendBusy = false;
// The selected pane's agent and status, for the Chat lens's Stop button.
let stopTarget = { paneId: null, agent: null, status: null };
import {
  HISTORY_PAGE_LINES,
  agentCompletionIdentity,
  agentStatus,
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
  nextInputHistory,
  shouldBrowseInputHistory,
  preferredLoginMethod,
  outputPollingDecision,
  outputTextForUpdate,
  paneShortcutTarget,
  selectedPaneIdForSnapshot,
  waitsForRemotePane,
  keepsVanishedRemotePane,
  sidebarPresentation,
  visibleAgentStatus,
  paneAgentKind,
  agentStatusIcon,
  agentStatusLabel,
  paneDisplayTitle,
  paneSubtitle,
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
  legacyMachinesNotice,
} from "./ui-model.js?v=1.2.71";
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
} from "./browse-preference.js?v=1.2.71";
import { terminalConnection } from "./terminal-connection.js?v=1.2.71";
import { terminalStatus, terminalStatusParts } from "./terminal-status.js?v=1.2.71";
import { createAttachedTerminal } from "./xterm-terminal.js?v=1.2.71";
import { createTerminalFind, isFindShortcut } from "./terminal-find.js?v=1.2.71";
import { createChatLens } from "./chat/chat-view.js?v=1.2.71";
import { createChatFind } from "./chat/chat-find.js?v=1.2.71";
import { createPromptDock } from "./chat/prompt-card.js?v=1.2.71";
import {
  adjustedChatFontSize,
  chatScale,
  pinchedChatFontSize,
  readChatFontSize,
  writeChatFontSize,
} from "./chat-font-preference.js?v=1.2.71";
import { chatAgent } from "./lens-preference.js?v=1.2.71";
import { composerEscapeStops, sendButtonMode as sendButtonModeFor, showsStop } from "./chat/chat-activity.js?v=1.2.71";
import * as xterm from "./vendor/xterm.mjs?v=1.2.71";
import {
  readPanePreference,
  writePanePreference,
} from "./pane-preference.js?v=1.2.71";
import {
  readCollapsedGroupIds,
  readCollapsedWorkspaceIds,
  writeCollapsedGroupIds,
  writeCollapsedWorkspaceIds,
} from "./workspace-preference.js?v=1.2.71";
import {
  adjustedTerminalFontSize,
  readTerminalFontSize,
  writeTerminalFontSize,
} from "./terminal-preference.js?v=1.2.71";
import {
  readAcknowledgedCompletions,
  writeAcknowledgedCompletions,
} from "./completion-preference.js?v=1.2.71";
import { attachSwipeDismiss } from "./swipe-dismiss.js?v=1.2.71";
import {
  attachSidebarDrag,
  dropScope,
  followMovedPane,
  movedTabSnapshot,
  movedWorkspaceSnapshot,
  tabMoveRequest,
  workspaceMoveRequest,
} from "./sidebar-drag.js?v=1.2.71";
import { renamePaneKeys } from "./pane-rename.js?v=1.2.71";
import { renamePaneLenses } from "./lens-preference.js?v=1.2.71";
import {
  readInputHistories,
  writeInputHistories,
} from "./input-history-preference.js?v=1.2.71";
import { atFilesSource } from "./composer-at-files.js?v=1.2.71";
import { createComposerPopup } from "./composer-popup.js?v=1.2.71";
import { slashCommandsSource } from "./composer-slash.js?v=1.2.71";
import { createComposerDrafts, draftScreenIsSecret, draftScreenShowsPrompt } from "./composer-draft-preference.js?v=1.2.71";
import {
  DEFAULT_KEY_BAR_ITEMS,
  KEY_BAR_ITEMS_MAX,
  KEY_BAR_KEYS,
  KEY_BAR_MODIFIERS,
  addKeyBarItem,
  customKeyBarItem,
  keyBarItemId,
  keyBarItemKey,
  keyBarItemLabel,
  moveKeyBarItem,
  readKeyBarItems,
  removeKeyBarItem,
  resetKeyBarItems,
  writeKeyBarItems,
} from "./key-bar-preference.js?v=1.2.71";
import {
  clearLaunchToken,
  readLaunchToken,
  writeLaunchToken,
} from "./launch-session.js?v=1.2.71";
import {
  applicationServerKeyBytes,
  pushButtonPresentation,
} from "./push-notifications.js?v=1.2.71";

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
// A draft is not stored unless the screen is known to be this pane's current
// one and is not asking for a password: anything else fails closed.
const composerDrafts = createComposerDrafts(panePreferenceStorage, Date.now,
  (paneId) => draftScreenIsSecret(paneId, draftPaneId, attachedTerminal.screenText(8)),
  (paneId) => draftScreenShowsPrompt(paneId, draftPaneId, attachedTerminal.screenText(8)));
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
  // The key bar's editor lives with the other settings at the foot of the sidebar.
  navigatorFooter: document.querySelector(".navigator-footer"),
  workspaceList: document.querySelector("#workspace-list"),
  paneContext: document.querySelector("#pane-context"),
  paneTitle: document.querySelector("#pane-title"),
  terminalPanel: document.querySelector(".terminal-panel"),
  terminalMessage: document.querySelector("#terminal-message"),
  terminalXterm: document.querySelector("#terminal-xterm"),
  terminalHeld: document.querySelector("#terminal-held"),
  terminalStatus: document.querySelector("#terminal-status"),
  terminalStatusText: document.querySelector("#terminal-status-text"),
  terminalStatusCountdown: document.querySelector("#terminal-status-countdown"),
  terminalReconnect: document.querySelector("#terminal-reconnect"),
  terminalStage: document.querySelector(".terminal-stage"),
  chatHost: document.querySelector("#chat-host"),
  promptDock: document.querySelector("#prompt-dock"),
  lensSwitch: document.querySelector("#lens-switch"),
  lensChat: document.querySelector("#lens-chat"),
  lensTerminal: document.querySelector("#lens-terminal"),
  quickKeys: document.querySelector(".quick-keys"),
  inputForm: document.querySelector("#input-form"),
  sendButton: document.querySelector("#input-form .send-button"),
  terminalInput: document.querySelector("#terminal-input"),
  composerFiles: document.querySelector("#composer-files"),
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
  // From /api/bootstrap: the most one file may be, or null for no limit.
  maxTransferBytes: null,
  snapshot: null,
  selectedPaneId: initialPanePreference,
  preferredPaneId: initialPanePreference,
  snapshotBusy: false,
  lastOutputRequestAt: 0,
  desktopSidebarCollapsed: false,
  mobileSidebarOpen: false,
  // The pane on screen, attached or mirrored, and a mirrored pane's text.
  renderedPaneId: null,
  mirrored: null,
  outputBurstUntil: 0,
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
  // The pane whose terminal was let go while its chat stayed on screen.
  terminalParked: null,
  // This PC's own Connect PC port, { address, allowed }, or null when closed.
  connectPc: null,
};

// The list above the composer: `@` file references (names in the pane's
// folder) and, at the start of the text, the `/` commands of the pane's
// agent. Its keys come first in the composer's keydown, so a row picked with
// Enter is never also sent.
const composerPopup = createComposerPopup({
  input: elements.terminalInput,
  listElement: elements.composerFiles,
  sources: [
    atFilesSource({
      context: () => {
        const paneId = state.selectedPaneId;
        if (!paneId) return null;
        const pane = selectedRecords().pane;
        const cwd = pane?.foreground_cwd || pane?.cwd;
        if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
        return { server: paneServerId(paneId) || "local", cwd };
      },
      // The Files tab's own request, for the pane's machine instead of the tab's.
      fetchListing: (server, path, prefix) => fetchListing(path, { prefix, server }),
    }),
    slashCommandsSource({
      context: () => {
        const paneId = state.selectedPaneId;
        if (!paneId) return null;
        const pane = selectedRecords().pane;
        return { paneId, agent: chatAgent(pane, agentForPane(paneId)), cwd: pane?.foreground_cwd || pane?.cwd || null };
      },
      fetchCommands: (paneId) => api(`/api/panes/${encodeURIComponent(paneId)}/commands`),
    }),
  ],
});

// Dragging in the sidebar: what was dropped shows where it landed at once,
// and goes back with a word if Herdr refuses.
let navigationRedrawHeld = false;
const sidebarDrag = attachSidebarDrag(elements.workspaceList, {
  canStart: () => !state.mutationBusy && !renameIsOpen() &&
    !document.body.classList.contains("sidebar-collapsed"),
  onEnd: () => { if (navigationRedrawHeld) renderNavigation(); },
  onDropTab: (drop) => void moveSidebarItem(
    tabMoveRequest(state.snapshot, drop),
    (request) => `/api/tabs/${encodeURIComponent(request.tabId)}/move`,
    () => movedTabSnapshot(state.snapshot, drop),
  ),
  onDropWorkspace: (drop) => void moveSidebarItem(
    workspaceMoveRequest(state.snapshot, drop),
    (request) => `/api/workspaces/${encodeURIComponent(request.workspaceId)}/move`,
    () => movedWorkspaceSnapshot(state.snapshot, drop),
  ),
});

const desktopMedia = window.matchMedia("(min-width: 761px)");
const primaryTouchMedia = window.matchMedia("(pointer: coarse) and (hover: none)");
const anyCoarsePointerMedia = window.matchMedia("(any-pointer: coarse)");
const anyHoverMedia = window.matchMedia("(any-hover: hover)");
const compactInputMedia = window.matchMedia("(max-width: 1024px)");
let sidebarAnimationTimer;
let terminalFontWheelDelta = 0;
let terminalInputResizeTimer = null;

const COMPOSER_RESIZE_DELAY_MS = 300;
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
  forgetComposerDrafts();
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

const SUN_ICON = [
  "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
  "M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
];
const MOON_ICON = ["M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z"];
const BELL_ICON = ["M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8Z", "M10 20h4"];
const KEYBOARD_ICON = ["M2.5 6h19v12h-19z", "M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M6 12.5h.01M18 12.5h.01M8.5 15h7"];
const PASSKEY_ICON = ["M8 15a4 4 0 1 1 3.9-5H21v3h-2v2h-3v-2h-4.1A4 4 0 0 1 8 15Z", "M8 11h.01"];
const DEVICES_ICON = ["M4 5h16v10H4z", "M8 19h8", "M12 15v4"];
const UPDATE_ICON = ["M12 3v12", "M7 10l5 5 5-5", "M5 20h14"];
const GEAR_ICON = [
  "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
];

// The ⚙ menu at the foot of the sidebar: what belongs to this browser rather
// than to a machine. Its items are built once and updated in place, so the
// menu can stay open while the theme or the permission changes under it.
const settingsMenu = {
  details: null,
  themeLabel: "Switch to light mode",
  themeIcon: SUN_ICON,
  push: null,
  // In-app update: whether the Update item shows, and whether some PC has a
  // newer version (a dot on the ⚙ button).
  update: { visible: false, available: false },
};

function buildSettingsMenu() {
  settingsMenu.details = sidebarActionMenu({
    id: "settings",
    label: "Settings",
    className: "settings-menu",
    summaryClass: "settings-button",
    icon: GEAR_ICON,
    // Any class but the default `more-icon`, whose thick stroke is for dots.
    iconClass: "settings-icon",
    // The menu opens upward from the footer; the top layer keeps it from being
    // cut off by the sidebar.
    escapesOverflow: true,
    actions: [
      { key: "notifications", label: "Notifications", paths: BELL_ICON, onSelect: () => void togglePushNotifications() },
      { key: "theme", label: "Theme", paths: SUN_ICON, onSelect: () => window.herdrTheme?.set(window.herdrTheme.current() === "dark" ? "light" : "dark") },
      {
        key: "keys",
        label: "Edit keys",
        paths: KEYBOARD_ICON,
        onSelect: () => {
          // on a phone the editor takes the screen; the sidebar it was opened from steps aside
          if (!desktopMedia.matches) closeMobileSidebar();
          openKeyBarDialog();
        },
      },
      { key: "update", label: "Update", paths: UPDATE_ICON, onSelect: () => updatePanel.open() },
      { separator: true, key: "separator" },
      {
        key: "passkeys",
        label: "Passkeys",
        paths: PASSKEY_ICON,
        onSelect: () => void showPasskeys(),
      },
      {
        key: "sessions",
        label: "Signed-in devices",
        paths: DEVICES_ICON,
        onSelect: () => void showSessions(),
      },
    ],
  });
  elements.navigatorFooter.append(settingsMenu.details);
  syncSettingsMenu();
}

function syncSettingsMenu() {
  const menu = settingsMenu.details;
  if (!menu) return;
  const item = (key) => menu.querySelector(`[data-action="${key}"]`);
  const setLabel = (button, text, icon) => {
    button.querySelector("span").textContent = text;
    if (icon) button.querySelector("svg").replaceWith(createIcon(icon));
  };
  const push = settingsMenu.push;
  const notifications = item("notifications");
  notifications.hidden = !push || push.hidden;
  if (push && !push.hidden) {
    const status = push.state === "enabled" ? "On" : push.state === "denied" ? "Blocked" : "Off";
    setLabel(notifications, `Notifications: ${status}`);
    notifications.disabled = push.disabled;
    notifications.title = push.label;
    notifications.setAttribute("aria-label", push.label);
  }
  const theme = item("theme");
  setLabel(theme, settingsMenu.themeLabel, settingsMenu.themeIcon);
  const update = item("update");
  update.hidden = !settingsMenu.update.visible;
  setLabel(update, settingsMenu.update.available ? "Update available" : "Update");
  update.classList.toggle("has-update", settingsMenu.update.available);
  const summary = menu.querySelector("summary");
  summary.classList.toggle("has-update", settingsMenu.update.available);
  summary.setAttribute("aria-label", settingsMenu.update.available ? "Settings (update available)" : "Settings");
  // Sign-in belongs to the HerdRabbit the browser is talking to; a linked
  // machine has none. Removing needs no WebAuthn, so a browser without it still
  // gets the list: that is how a lost device's passkey is taken off elsewhere.
  for (const key of ["passkeys", "sessions"]) item(key).hidden = !state.authRequired;
  menu.querySelector('[role="separator"]').hidden = !state.authRequired;
}

// The PCs the Update window lists: this one, then each connected PC.
const updatePanel = createUpdatePanel({
  api,
  dialog: document.querySelector("#update-dialog"),
  list: document.querySelector("#update-list"),
  feedback: document.querySelector("#update-feedback"),
  checkButton: document.querySelector("#update-check"),
  servers: () => {
    const listed = snapshotRecords().servers;
    const local = listed.find((server) => server.id === "local");
    return [
      { id: "local", name: local?.machine ? `This PC (${local.machine})` : "This PC" },
      ...listed.filter((server) => server.transport === "link").map((server) => ({ id: server.id, name: server.name || server.id })),
    ];
  },
  onChange: (available) => {
    settingsMenu.update = { visible: updatePanel.visible(), available };
    syncSettingsMenu();
  },
});
document.querySelector("#update-close").addEventListener("click", () => document.querySelector("#update-dialog").close());

function syncThemeItem() {
  const currentTheme = window.herdrTheme?.current() || "dark";
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  const label = nextTheme === "light" ? "Switch to light mode" : "Switch to dark mode";
  settingsMenu.themeLabel = label;
  settingsMenu.themeIcon = nextTheme === "light" ? SUN_ICON : MOON_ICON;
  syncSettingsMenu();
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

function renderNotificationItem() {
  const supported = supportsPushNotifications();
  const presentation = pushButtonPresentation({
    supported,
    permission: supported ? Notification.permission : "default",
    subscribed: state.pushSubscription !== null,
    busy: state.pushBusy,
  });
  settingsMenu.push = presentation;
  syncSettingsMenu();
}

async function serviceWorkerRegistration() {
  if (!supportsPushNotifications()) return null;
  return navigator.serviceWorker.ready;
}

async function syncPushSubscription() {
  renderNotificationItem();
  const registration = await serviceWorkerRegistration();
  if (!registration) return;
  state.pushSubscription = await registration.pushManager.getSubscription();
  renderNotificationItem();
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
  renderNotificationItem();
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
    renderNotificationItem();
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

function resetInputHistoryNavigation() {
  state.inputHistoryCursor = null;
  state.inputHistoryDraft = "";
}

// Each pane keeps the message typed but not sent. The textarea shows the
// selected pane's; switching panes saves it and brings the other pane's back.
// A draft is dropped before it is sent, and a text the server calls
// a password answer is never stored.
let draftPaneId = null;
let draftSaveTimer = null;
const draftBlocked = new Set(); // panes whose composer text must not be stored
const draftHeld = new Set(); // panes with a message on its way

// While history is browsed the box shows an old message; the draft is the text
// typed before browsing began.
function composerDraftText() {
  return state.inputHistoryCursor !== null ? state.inputHistoryDraft : elements.terminalInput.value;
}

function saveComposerDraft() {
  window.clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  const paneId = draftPaneId;
  if (!paneId || draftHeld.has(paneId)) return;
  if (draftBlocked.has(paneId)) {
    composerDrafts.clear(paneId);
    return;
  }
  composerDrafts.set(paneId, composerDraftText());
}

function scheduleComposerDraftSave() {
  if (!draftPaneId) return;
  window.clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(saveComposerDraft, 300);
}

// Called whenever the selected pane may have changed; does nothing when it has not.
function syncComposerDraft() {
  const paneId = state.selectedPaneId || null;
  if (paneId === draftPaneId) return;
  saveComposerDraft();
  const leaving = draftPaneId;
  draftBlocked.delete(leaving);
  draftPaneId = paneId;
  if (paneId) draftBlocked.delete(paneId);
  resetInputHistoryNavigation();
  const text = paneId ? composerDrafts.get(paneId) : "";
  composerPopup.close();
  if (elements.terminalInput.value !== text) {
    elements.terminalInput.value = text;
    resizeTerminalInput();
  }
}

// The message is about to go: nothing of it stays stored, so a closed page
// mid-send leaves no copy. A failed send puts the draft back.
function holdComposerDraft(paneId) {
  window.clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  draftHeld.add(paneId);
  composerDrafts.clear(paneId);
}

function releaseComposerDraft(paneId, { sent, text, secret = false }) {
  draftHeld.delete(paneId);
  if (sent) {
    // A password answer keeps its pane blocked until the composer is cleared or left.
    if (secret && draftPaneId === paneId && elements.terminalInput.value !== "") draftBlocked.add(paneId);
    else draftBlocked.delete(paneId);
    return;
  }
  if (draftPaneId === paneId) saveComposerDraft();
  // The pane was left while the message was on its way and it did not go: its
  // screen is not on show to be checked, so the text stays in memory only.
  else if (!draftBlocked.has(paneId) && !composerDrafts.get(paneId)) composerDrafts.set(paneId, text, { memoryOnly: true });
}

window.addEventListener("pagehide", saveComposerDraft);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveComposerDraft();
});

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

// The Herdr session a new project opens in: the selected pane's, else its
// machine's default, else this machine's, else any running one.
function newProjectHerdrSession() {
  const { herdrSessions, panes } = snapshotRecords();
  const selectedPane = panes.find((pane) => idOf(pane, "pane_id", "id") === state.selectedPaneId);
  const servers = [selectedPane?.server_id || "local", "local"];
  for (const serverId of servers) {
    const session = herdrSessionForServer(serverId);
    if (session) return session;
  }
  return herdrSessions.find((session) => session.running === true && session.available === true) || null;
}

function syncCreateProjectAvailability() {
  elements.createProject.disabled = newProjectHerdrSession() === null;
}

// The running Herdr session to use on `serverId`: the selected pane's, when it
// is on that machine, else the machine's default.
function herdrSessionForServer(serverId) {
  const { herdrSessions: all, panes } = snapshotRecords();
  if (all.length === 0) {
    return serverId === "local"
      ? { session_id: null, name: "default", running: true, available: true }
      : null;
  }
  const herdrSessions = all.filter((session) => (session.server_id || "local") === serverId);
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
    (session) => session.machine_default === true && session.running === true &&
      session.available === true,
  ) || herdrSessions.find(
    (session) => session.running === true && session.available === true,
  ) || null;
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

function sidebarActionMenu({
  id, label, actions, className = "", escapesOverflow = false,
  icon = ["M6 12h.01M12 12h.01M18 12h.01"], iconClass = "more-icon", summaryClass = "",
}) {
  const details = createElement("details", {
    className: `sidebar-action-menu ${className}`.trim(),
  });
  details.dataset.menuId = id;
  details.open = state.openActionMenuId === id;
  const summary = createElement("summary", {
    className: `workspace-action ${summaryClass}`.trim(),
  });
  summary.setAttribute("aria-label", label);
  summary.title = label;
  summary.append(createIcon(icon, iconClass));
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
    if (action.separator) {
      const rule = createElement("div", { className: "sidebar-action-separator" });
      rule.setAttribute("role", "separator");
      popover.append(rule);
      continue;
    }
    const button = createElement("button", {
      className: `sidebar-action-item ${action.danger ? "is-danger" : ""}`.trim(),
    });
    button.type = "button";
    button.setAttribute("role", "menuitem");
    if (action.key) button.dataset.action = action.key;
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
    state.selectedPaneId = preferredPaneId;
    state.preferredPaneId = preferredPaneId;
  }
  choosePane();
  syncCreateProjectAvailability();
  renderNavigation();
  const selected = selectedRecords();
  renderPaneHeading(selected.pane, selected.tab, selected.workspace);
  if (previousPaneId !== state.selectedPaneId) {
    showTerminalMessage(
      state.selectedPaneId ? "Loading output…" : "No open sessions.",
    );
  }
  void refreshTerminal();
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

// Small marks drawn here for each kind of program a row can run: simple
// shapes that suggest the program, not its published artwork.
const AGENT_MARKS = Object.freeze({
  claude: { box: "#d9774f", strokes: ["M12 5v14M5 12h14M7.1 7.1l9.8 9.8M16.9 7.1l-9.8 9.8"], color: "#ffffff", width: 1.9 },
  // six rounded petals turned 60 degrees apart, overlapping into a knot
  codex: { strokes: ["M12 2.6c2.3 0 3.6 2.3 3.6 4.7S14.2 12 12 12s-3.6-2.3-3.6-4.7S9.7 2.6 12 2.6z"], turns: 6, width: 1.4 },
  agy: { strokes: ["M6.5 19.5L12 5l5.5 14.5", "M3.5 14c4-2.4 13-2.4 17 0"], width: 1.8 },
  opencode: { strokes: ["M8.5 4.5h-4v15h4", "M15.5 4.5h4v15h-4", "M10.5 12h3"], width: 2.2 },
  other: { strokes: ["M12 3c.7 5 2 6.3 7 7-5 .7-6.3 2-7 7-.7-5-2-6.3-7-7 5-.7 6.3-2 7-7z", "M19 17v4M17 19h4"], width: 1.6 },
  shell: { strokes: ["M5 8l5 4-5 4", "M13 17h6"], width: 1.9 },
});

function agentMark(kind) {
  const mark = AGENT_MARKS[kind] || AGENT_MARKS.shell;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `agent-icon agent-icon-${kind in AGENT_MARKS ? kind : "shell"}`);
  if (mark.box) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "1");
    rect.setAttribute("y", "1");
    rect.setAttribute("width", "22");
    rect.setAttribute("height", "22");
    rect.setAttribute("rx", "6");
    rect.setAttribute("fill", mark.box);
    svg.append(rect);
  }
  for (const d of mark.strokes) for (let turn = 0; turn < (mark.turns || 1); turn += 1) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    if (turn > 0) path.setAttribute("transform", `rotate(${(360 / mark.turns) * turn} 12 12)`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", mark.color || "currentColor");
    path.setAttribute("stroke-width", String(mark.width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
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
  const kind = paneAgentKind(pane, agent);
  const statusText = agentStatusLabel(currentAgentStatus);
  const button = createElement("button", { className: "pane-button" });
  button.type = "button";
  button.dataset.paneId = paneId;
  button.dataset.status = currentAgentStatus;
  button.setAttribute("aria-pressed", String(paneId === state.selectedPaneId));

  button.setAttribute(
    "aria-label",
    `${agentLabel}, ${statusText}, ${[workspaceLabel, tabLabel].filter(Boolean).join(" / ")}`,
  );
  button.title = `${[sessionName, agentLabel].filter(Boolean).join(" · ")} · ${statusText}`;

  button.append(agentMark(kind));

  const title = paneDisplayTitle(sessionName, pane, tabLabel || "Terminal", agent);
  const copy = createElement("span", { className: "pane-copy" });
  copy.append(createElement("strong", { className: "pane-title", text: title }));
  const subtitle = paneSubtitle(title, pane);
  if (subtitle) copy.append(createElement("small", { className: "pane-cwd", text: subtitle }));
  button.append(copy);

  // Always present, so the row's text and menu stay put whatever the status.
  const status = createElement("span", {
    className: `pane-status ui-status state-${currentAgentStatus}`,
    text: agentStatusIcon(currentAgentStatus),
  });
  status.setAttribute("aria-hidden", "true");
  button.append(status);

  button.addEventListener("click", () => {
    if (state.selectedPaneId !== paneId) resetInputHistoryNavigation();
    state.selectedPaneId = paneId;
    syncComposerDraft();
    state.preferredPaneId = paneId;
    writePanePreference(panePreferenceStorage, paneId);
    acknowledgePaneCompletion(paneId);
    setFeedback("");
    renderNavigation();
    renderPaneHeading(pane, tab, workspace);
    showTerminalMessage("Loading output…");
    void refreshTerminal();
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

// Only a PC connected with Connect PC is renamed: this PC is not a connection.
function serverRenameForm(server) {
  return renameForm({
    value: server.name,
    label: `${server.name} machine name`,
    maxLength: 80,
    invalidMessage: "Enter a name.",
    onCancel: () => { state.editingServerId = null; renderNavigation(); },
    onSubmit: async (name) => {
      // The address is not edited here, so it is carried over unchanged.
      await api(`/api/servers/${server.id}`, { method: "PUT", body: { name, address: server.address ?? "" } });
      state.editingServerId = null;
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

const SERVER_KINDS = { local: "This PC", link: "Connect PC" };

// A connected PC on another app version still connects; Details says so. Its
// link protocol is what decides, so that is shown beside this PC's.
function linkDetailRows(server) {
  const here = snapshotRecords().servers.find((item) => item.id === "local");
  if (server.id === "local") {
    return [
      ["Connection protocol", server.link_protocol == null ? "Unknown" : String(server.link_protocol)],
      ["Connect PC port", state.connectPc
        ? `${state.connectPc.address} (${state.connectPc.allowed > 0 ? `${state.connectPc.allowed} allowed` : "nobody allowed yet"})`
        : "Closed"],
    ];
  }
  const protocol = server.link_protocol == null ? "Unknown" : String(server.link_protocol);
  const differs = here?.link_protocol != null && server.link_protocol != null && here.link_protocol !== server.link_protocol;
  return [
    ["Address", server.address || "Unknown"],
    ["Connection protocol", differs ? `${protocol} (this PC: ${here.link_protocol})` : protocol],
  ];
}

function herdRabbitVersionText(server) {
  if (!server.version) return "Unknown";
  const here = snapshotRecords().servers.find((item) => item.id === "local");
  return server.id !== "local" && here?.version && here.version !== server.version
    ? `${server.version} (this PC: ${here.version})`
    : server.version;
}

function showServerDetails(server) {
  const sessions = snapshotRecords().herdrSessions.filter((item) => item.server_id === server.id);
  // A pane record carries no server of its own; its id is where the server is.
  const panes = snapshotRecords().panes.filter((item) => paneServerId(item.pane_id) === server.id);
  // A machine is shown by the name Tailscale knows it by, not by an address.
  const rows = [
    ...(server.machine ? [["Machine", server.machine]] : []),
    ["Kind", server.id === "local" ? SERVER_KINDS.local : SERVER_KINDS.link],
    ["HerdRabbit", herdRabbitVersionText(server)],
    ...linkDetailRows(server),
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
// Even when the server cannot be told, this window forgets its launch token,
// so it is signed out here either way.
async function signOutThisDevice() {
  await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
  sessionsDialog.close();
  signedOut();
}

// A sign-in from before the list existed has no row to sign out from, so the
// dialog offers this device on its own.
const sessionsEndThis = document.querySelector("#sessions-end-this");
sessionsEndThis.addEventListener("click", () => void sessionsAction(signOutThisDevice));

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
      await signOutThisDevice();
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
  let sessions;
  try {
    ({ sessions } = await api("/api/auth/sessions"));
  } catch (error) {
    // Without the list there is no row to sign out from; this device still can.
    sessionsEndThis.hidden = false;
    throw error;
  }
  const items = array(sessions);
  sessionsEndThis.hidden = items.some((session) => session?.current);
  sessionsList.replaceChildren(...(items.length > 0
    ? items.map(sessionRow)
    : [createElement("li", { className: "passkey-empty", text: "Only sign-ins made since this list started are shown." })]));
}

async function showSessions() {
  setSessionsFeedback("");
  sessionsList.replaceChildren();
  sessionsEndThis.hidden = true;
  sessionsDialog.showModal();
  await sessionsAction(loadSessions);
}

function signedOut() {
  state.launchToken = clearLaunchToken(launchSessionStorage);
  showLogin();
}

// Unsent text belongs to the sign-in it was typed under: whichever way that
// ends (signing out, an expired session, a revoked device), it goes with it,
// so the next person to sign in on this browser does not get it back.
function forgetComposerDrafts() {
  window.clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  composerDrafts.clearAll();
  draftBlocked.clear();
  clearComposer();
  draftPaneId = null;
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
    // This PC's accounts, or a connected PC's, switched on that PC.
    {
      label: "AI accounts",
      paths: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 20a8 8 0 0 1 16 0"],
      onSelect: () => showAiAccounts(server),
    },
  ];
  // This machine is not a connection: there is nothing to rename or drop.
  if (server.id === "local") {
    return sidebarActionMenu({
      id: `server-${server.id}`,
      label: `More actions for ${server.name}`,
      className: "server-action-menu",
      actions,
    });
  }
  // A PC connected with Connect PC: renamed and dropped here, and found again
  // when it moved to another port.
  return linkActionMenu(server, actions);
}

function linkActionMenu(server, actions) {
  // A PC that moved to another port leaves its entry pointing at the old one,
  // offline for good. Its tailnet address says it is the same PC.
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
        if (!window.confirm(`Disconnect “${server.name}”? Its sessions keep running there.`)) return;
        void api(`/api/servers/${server.id}`, { method: "DELETE" })
          .then(() => refreshSnapshot())
          .catch((error) => setFeedback(error.message, true));
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
  // A row being held or dragged stays where it is; the redraw waits for the drop.
  if (sidebarDrag.isActive()) {
    navigationRedrawHeld = true;
    return;
  }
  navigationRedrawHeld = false;
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
        // This PC is the host the page is served from; another machine keeps
        // its words for the states a dot cannot tell apart.
        if (server.id === "local") heading.append(createElement("small", { className: "server-role", text: "Host" }));
        else if (!server.available) {
          heading.append(createElement("small", {
            text: server.status === "Connecting" ? "Connecting" : "Offline",
          }));
        }
        const dot = createElement("span", { className: "server-dot" });
        dot.setAttribute("aria-hidden", "true");
        heading.append(dot);
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
    group.dataset.workspaceId = workspaceId;
    group.dataset.dropScope = dropScope(workspace);
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
      tabGroup.dataset.tabId = tabId;
      tabGroup.dataset.workspaceId = workspaceId;
      tabGroup.dataset.dropScope = group.dataset.dropScope;
      const tabLabel = displayTabLabel(tab);
      const editingTab = state.editingTabId === tabId;
      const tabPanes = panes.filter((pane) => idOf(pane, "tab_id", "tabId") === tabId);
      // A split session can be put in order within its project, not carried out.
      if (tabPanes.length > 1) tabGroup.dataset.split = "true";
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

// Every place the page keeps state under a pane's id, each with how it follows
// the pane to a new id: the unsent draft (and its secret verdict), the
// blocked/held marks, the message history, the chosen lens and the acknowledged
// completion. A new pane-keyed store joins by being listed here. The functions
// are called late, so a store defined further down the file is fine.
const paneScopedStores = [
  { rename: (moves) => composerDrafts.rename(moves) },
  {
    rename(moves) {
      for (const set of [draftBlocked, draftHeld]) {
        const kept = [...set];
        set.clear();
        for (const id of kept) set.add(followMovedPane(id, moves));
      }
      // The pane on screen keeps its composer: the text stays, only the key changes.
      if (draftPaneId) draftPaneId = followMovedPane(draftPaneId, moves);
    },
  },
  {
    rename(moves) {
      state.inputHistoryByPane = renamePaneKeys(state.inputHistoryByPane, moves);
      writeInputHistories(panePreferenceStorage, state.inputHistoryByPane);
    },
  },
  {
    rename(moves) {
      state.acknowledgedCompletions = renamePaneKeys(state.acknowledgedCompletions, moves);
      writeAcknowledgedCompletions(panePreferenceStorage, state.acknowledgedCompletions);
    },
  },
  { rename: (moves) => renamePaneLenses(panePreferenceStorage, moves) },
  { rename: (moves) => chatLens.renamePanes(moves) },
];

function followMovedPaneState(moves) {
  if (!Array.isArray(moves) || moves.length === 0) return;
  saveComposerDraft();
  for (const store of paneScopedStores) store.rename(moves);
}

async function moveSidebarItem(request, pathFor, optimistic) {
  if (!request || state.mutationBusy) return;
  const before = state.snapshot;
  state.mutationBusy = true;
  setFeedback("");
  state.snapshot = optimistic();
  renderNavigation();
  let failed = false;
  let unread = false;
  let reorderedFeedback = "";
  try {
    const payload = await api(pathFor(request), { method: "POST", body: request.body });
    if (payload.moved?.reordered === false) reorderedFeedback = "Moved; it is at the end of the project.";
    // A session moved to another project brings its panes under new ids; the
    // one on screen is followed there.
    const followed = followMovedPane(state.selectedPaneId, payload.moved?.panes);
    followMovedPaneState(payload.moved?.panes);
    const paneMoved = followed !== state.selectedPaneId;
    if (paneMoved) writePanePreference(panePreferenceStorage, followed);
    if (payload.snapshot) adoptMutationSnapshot(payload.snapshot, paneMoved ? followed : null);
    else {
      // read once the mutation is over: refreshSnapshot waits out a busy one
      if (paneMoved) state.selectedPaneId = followed;
      unread = true;
    }
  } catch (error) {
    failed = true;
    state.snapshot = before;
    renderNavigation();
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
  }
  if (reorderedFeedback) setFeedback(reorderedFeedback);
  // A failed move may still have changed something; a move answered without a
  // snapshot is read now.
  if (failed || unread) void refreshSnapshot();
}

function renderPaneHeading(pane, tab, workspace) {
  syncAttachAvailability();
  if (modifierPaneId !== state.selectedPaneId) clearKeyModifiers();
  if (!pane) {
    elements.paneContext.textContent = "Select a pane";
    elements.paneTitle.textContent = "Terminal";
    elements.paneTitle.removeAttribute("title");
    stopTarget = { paneId: null, agent: null, status: null };
    chatLens.select(null);
    promptDock?.select(null);
    syncSendButton();
    return;
  }

  const paneId = idOf(pane, "pane_id", "id");
  const agent = agentForPane(paneId);
  stopTarget = { paneId, agent: chatAgent(pane, agent), status: agentStatus(agent, pane) };
  chatLens.select(paneId, { agent: chatAgent(pane, agent), status: agentStatus(agent, pane) });
  promptDock?.select(paneId, { agent: chatAgent(pane, agent), status: agentStatus(agent, pane) });
  syncSendButton();
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
  // the program's mark says which agent it is; the title says which pane
  const title = paneDisplayTitle("", pane, tabLabel || "Terminal", agent);
  elements.paneTitle.replaceChildren(agentMark(paneAgentKind(pane, agent)), createElement("span", { className: "pane-title-text", text: title }));
  elements.paneTitle.title = displayRecordLabel(agent, displayRecordLabel(pane, "Terminal"));
}

// An agent names files as it works -- "wrote src/api.mjs", "see ./docs/plan.md"
// -- and on a phone the only way to look at one was to go find it in the tree.
// A named file that this app can show becomes a link that opens it; any other
// name that ends in an extension becomes a link that shows it in the Files tab.
// So does a folder written out in full (`/home/me/proj`, `./build`): it opens
// in the Files tab.
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
  return `${trimTrailingSlashes(base)}/${raw.replace(/^\.\//u, "")}`;
}

// Whether the viewer can show a file of this name.
const hasPreview = (name) => previewFor(name) !== null;

function isLinkableTerminalPath(raw) {
  const name = raw.split("/").pop();
  return (hasPreview(name) || isFileName(name) || isFolderPath(raw)) && resolveTerminalPath(raw) !== null;
}

// Whether `path` on `server` lists as a folder. A file, or nothing there,
// does not.
async function listsAsFolder(server, path) {
  try {
    await transferRequest(`/api/browse?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`);
    return true;
  } catch {
    return false;
  }
}

async function openTerminalPath(raw) {
  const resolved = resolveTerminalPath(raw);
  if (!resolved) return;
  // a closing slash says "folder"; the name is the last one before it
  const trimmed = trimTrailingSlashes(resolved) || "/";
  const name = trimmed.split("/").pop();
  const server = paneServerId(state.selectedPaneId) || "local";
  // A folder may well be called `docs.md`: one written out in full is asked
  // about before the viewer is opened on it. Anything picked meanwhile -- a
  // folder, a machine, another link, another pane -- wins over this one.
  const generation = ++revealGeneration;
  const paneId = state.selectedPaneId;
  const viewable = trimmed === resolved && hasPreview(name)
    && !(isFolderPath(raw) && await listsAsFolder(server, trimmed));
  if (generation !== revealGeneration || paneId !== state.selectedPaneId) return;
  if (viewable) void viewFile(resolved, name, server);
  else void revealInFiles(trimmed, name, server);
}

function showTerminalMessage(message) {
  elements.terminalMessage.textContent = message;
  showTerminalView(false);
  state.renderedPaneId = null;
  if (terminalFind) syncTerminalFind();
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
    if (state.selectedPaneId !== pendingNotificationPaneId) resetInputHistoryNavigation();
    state.selectedPaneId = pendingNotificationPaneId;
    syncComposerDraft();
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
  if (state.selectedPaneId !== nextPaneId) resetInputHistoryNavigation();
  state.selectedPaneId = nextPaneId;
  if (nextPaneId) {
    state.preferredPaneId = nextPaneId;
    writePanePreference(panePreferenceStorage, nextPaneId);
  }
  syncComposerDraft();
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
      void refreshTerminal();
    }
  } catch (error) {
    setConnection("error", error.message);
  } finally {
    state.snapshotBusy = false;
  }
}

// Every pane is drawn by xterm. One that attaches gets herdr's own stream; one
// that cannot (no node-pty on this server, or herdr refused the attach)
// mirrors the screen the terminal socket polls instead: redrawn whole on each
// update and read-only to keystrokes, while the composer and quick keys still
// send to it.
function refreshTerminal({ streamPayload = null } = {}) {
  const paneId = state.selectedPaneId;
  if (!state.authenticated || document.hidden) return;
  // Another pane may have its own reason, or none.
  if (paneId !== state.renderedPaneId) renderTerminalStatus();
  if (!paneId) {
    // The pane on screen went away and nothing took its place.
    if (state.renderedPaneId) {
      attachedTerminal.show(null);
      showTerminalMessage("No open sessions.");
    }
    return;
  }
  // Long in the Chat lens, the terminal was let go: it attaches again on return.
  if (state.terminalParked !== null && state.terminalParked !== paneId) state.terminalParked = null;
  if (state.terminalParked === paneId) return;
  state.lastOutputRequestAt = Date.now();
  if (attachedTerminal.show(paneId)) {
    terminalStream.unwatch();
    state.mirrored = null;
    showTerminal(paneId);
    return;
  }
  terminalStream.select(paneId, HISTORY_PAGE_LINES);
  const payload = streamPayload ?? terminalStream.latest(paneId, HISTORY_PAGE_LINES);
  if (!payload || (!payload.update && payload.output === undefined)) return;
  const previous = state.mirrored?.paneId === paneId ? state.mirrored.output : null;
  const output = outputTextForUpdate(previous, payload.update ? payload : { ...payload, update: "replace" });
  if (output === null) return;
  state.mirrored = { paneId, output };
  attachedTerminal.mirror(paneId, output);
  showTerminal(paneId);
}

function showTerminal(paneId) {
  showTerminalView(true);
  state.renderedPaneId = paneId;
  if (terminalFind) syncTerminalFind();
  void completeNotificationRelay();
}

function refreshOutputOnSchedule() {
  const polling = outputPollingDecision({
    baseIntervalMs: state.pollIntervalMs,
    currentStatus: selectedAgentStatus(),
    recentSubmission: Date.now() < state.outputBurstUntil,
    connection: navigator.connection || navigator.mozConnection || navigator.webkitConnection,
  });
  if (Date.now() - state.lastOutputRequestAt < polling.intervalMs) return;
  void refreshTerminal();
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
  void refreshTerminal();
  window.setTimeout(() => void refreshTerminal(), OUTPUT_SUBMISSION_RETRY_MS);
  if (elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
    window.setTimeout(() => void refreshBrowseFolder({ silent: true }), OUTPUT_SUBMISSION_RETRY_MS);
  }
}

function streamPayloadIsCurrent(payload) {
  return payload.paneId === state.selectedPaneId && payload.requestedLines === HISTORY_PAGE_LINES;
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
    if (streamPayloadIsCurrent(next)) void refreshTerminal({ streamPayload: next });
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
    if (state.authenticated && !document.hidden) setConnection("error", error.message);
  },
  onAuthenticationRequired: () => showLogin(),
  onStatus: receiveLiveStatus,
  onStatusesReady: () => void refreshSnapshot(),
  onStatusesUnavailable: () => liveStatusUpdates.clear(),
});

// The find bar over the Terminal lens (terminal-find.js), made once the lens is,
// and the one over the Chat lens (chat-find.js).
let terminalFind = null;
let chatFind = null;

const attachedTerminal = createAttachedTerminal({
  host: elements.terminalXterm,
  connection: terminalStream,
  xterm,
  fontSize: state.terminalFontSize,
  // A pane that cannot attach is mirrored from the polled screen instead.
  onFallback: (paneId, problem) => {
    terminalAttachProblems.set(paneId, problem);
    if (terminalAttach?.paneId === paneId) terminalAttach = { paneId, state: "failed", since: Date.now(), problem };
    renderTerminalStatus();
    if (paneId !== state.selectedPaneId) return;
    showTerminalMessage("Loading output…");
    void refreshTerminal();
  },
  onStateChange: ({ paneId, held, ready, dropped }) => {
    if (paneId !== state.selectedPaneId) return;
    noteTerminalAttach(paneId, held ? "held" : ready ? "live" : "attaching");
    elements.terminalHeld.hidden = !held;
    if (dropped) setFeedback("Typing did not reach the terminal while it reconnected. Check the screen before typing again.", true);
  },
  isLinkablePath: isLinkableTerminalPath,
  onPath: openTerminalPath,
  onFontSizeChange: applyTerminalFontSize,
  onRetry: (paneId) => { if (paneId === state.selectedPaneId) void refreshTerminal(); },
  onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
  onViewMoved: () => terminalFind?.forgetPlace(),
});

// The strip over the Terminal lens that says why the terminal is not live:
// the socket is down, or the pane on screen could not attach. Quiet during a
// normal connect, gone as soon as the terminal is live again. A held pane has
// its own strip (#terminal-held), and the Chat lens shows neither.
// The pane on screen's attach ({ paneId, state, since, problem }), and why each
// pane last failed to attach (cleared once it attaches).
let terminalAttach = null;
const terminalAttachProblems = new Map();
let terminalConnectionState = terminalStream.connectionState;
let terminalStatusTimer = null;
let terminalStatusShown = null;

function noteTerminalAttach(paneId, next) {
  if (next === "live") terminalAttachProblems.delete(paneId);
  const same = terminalAttach?.paneId === paneId;
  const problem = next === "live" ? null : (same ? terminalAttach.problem : null) ?? terminalAttachProblems.get(paneId) ?? null;
  const since = same && terminalAttach.state === next ? terminalAttach.since : Date.now();
  terminalAttach = { paneId, state: next, since, problem };
  renderTerminalStatus();
}

function terminalMachine(paneId) {
  const serverId = paneServerId(paneId);
  if (!serverId || serverId === "local") return null;
  return array(state.snapshot?.servers).find((item) => item.id === serverId)?.name || null;
}

function renderTerminalStatus() {
  window.clearTimeout(terminalStatusTimer);
  terminalStatusTimer = null;
  const paneId = state.selectedPaneId;
  let attach = null;
  if (paneId && terminalAttach?.paneId === paneId) attach = terminalAttach;
  else if (paneId && terminalAttachProblems.has(paneId)) {
    attach = { paneId, state: "failed", since: 0, problem: terminalAttachProblems.get(paneId) };
  }
  const signedOut = terminalConnectionState.state === "signed-out";
  const { status, recheckAt } = (state.authenticated && !document.hidden) || signedOut
    ? terminalStatus({
      connection: terminalConnectionState,
      attach: attach && { ...attach, machine: terminalMachine(paneId) },
      offline: navigator.onLine === false,
    })
    : { status: null, recheckAt: null };
  terminalStatusShown = status;
  elements.terminalStatus.hidden = !status;
  if (status) {
    // Only a changed reason is announced; the countdown ticks silently.
    const { reason, countdown } = terminalStatusParts(status);
    if (elements.terminalStatusText.textContent !== reason) elements.terminalStatusText.textContent = reason;
    elements.terminalStatusCountdown.textContent = countdown;
    elements.terminalStatus.dataset.target = status.target;
    elements.terminalStatus.classList.toggle("is-quiet", Boolean(status.quiet));
    elements.terminalReconnect.hidden = !status.reconnect;
  }
  if (recheckAt !== null) {
    terminalStatusTimer = window.setTimeout(renderTerminalStatus, Math.max(50, Math.min(1000, recheckAt - Date.now())));
  }
}

terminalStream.onConnectionState((next) => {
  terminalConnectionState = next;
  renderTerminalStatus();
});

elements.terminalReconnect.addEventListener("click", () => {
  const status = terminalStatusShown;
  if (!status?.reconnect) return;
  if (status.target === "connection") {
    terminalStream.reconnectNow();
    return;
  }
  const paneId = state.selectedPaneId;
  if (!paneId) return;
  state.terminalParked = null;
  // A pane waiting out its retry is tried now; one still attaching is asked again.
  if (!attachedTerminal.retryNow(paneId)) void refreshTerminal();
  renderTerminalStatus();
});

// The network coming back is worth trying at once, not at the end of the wait.
window.addEventListener("online", () => {
  if (state.authenticated && !document.hidden) terminalStream.reconnectNow();
  renderTerminalStatus();
});
window.addEventListener("offline", () => renderTerminalStatus());

// A phone keyboard takes the bottom of the screen. The page shrinks to what is
// still visible, so the composer and key bar sit just above the keyboard
// instead of under it, and the terminal keeps its size and shows its foot.
// The tallest height seen at a width is the screen without a keyboard; each
// width (a phone held upright or turned) keeps its own.
// A keyboard takes far more than this; a browser's address bar folding away
// takes less.
const KEYBOARD_MIN_HEIGHT_PX = 120;
let phoneKeyboardOpen = false;
// A phone keyboard put away leaves the composer focused: Send reads that as
// out of the composer (and may turn into Stop) until the composer is tapped
// or focused again.
let composerKeyboardDismissed = false;
if (window.visualViewport) {
  const viewport = window.visualViewport;
  const unobstructedHeights = new Map();
  const followKeyboard = () => {
    const width = Math.round(viewport.width);
    const unobstructed = Math.max(unobstructedHeights.get(width) ?? 0, viewport.height);
    unobstructedHeights.set(width, unobstructed);
    // Only typing brings a keyboard: a split screen or a resized window with
    // nothing focused is a smaller screen, which the terminal fits.
    const typing = document.activeElement instanceof HTMLElement && document.activeElement.matches("input, textarea");
    const open = usesTouchInputEnvironment() && typing && viewport.height < unobstructed - KEYBOARD_MIN_HEIGHT_PX;
    if (open) document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
    else document.documentElement.style.removeProperty("--app-height");
    const dismissed = phoneKeyboardOpen && !open && document.activeElement === elements.terminalInput;
    phoneKeyboardOpen = open;
    if (open) composerKeyboardDismissed = false;
    if (dismissed) {
      composerKeyboardDismissed = true;
      syncSendButton();
    }
    attachedTerminal.setKeyboardOpen(open);
    // The browser may have scrolled the page to show the composer; the page
    // now fits, so it goes back to the top.
    if (open && window.scrollY) window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", followKeyboard);
  followKeyboard();
}

// A conversation page or tool output for the Chat lens. The answer's ETag
// comes back as If-None-Match, so an unchanged page costs no body (a 304).
async function conversationRequest(path, { etag } = {}) {
  const headers = new Headers();
  if (etag) headers.set("If-None-Match", etag);
  if (state.launchToken) headers.set("X-Herdr-Launch-Token", state.launchToken);
  const response = await fetch(path, { headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 304) return { notModified: true };
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
  return { payload, etag: response.headers.get("ETag") };
}

// After this long in the Chat lens without the terminal, the terminal is let
// go (detached); switching back attaches it again and herdr redraws it.
const TERMINAL_PARK_MS = 5 * 60_000;
const SCROLL_BOTTOM_RETRY_MS = 1_000;
let terminalParkTimer = null;

// Back from the Chat lens, the terminal shows the newest output: herdr's
// shared view of the pane goes to the bottom (asked of the server), and so
// does xterm's own viewport. A terminal let go while parked attaches again
// right after, so it counts too; a mirror has no herdr view to move.
// A request that fails is tried once more a moment later, while the pane is
// still the one in view in the terminal.
function showNewestTerminalOutput(paneId, { retry = true } = {}) {
  const attached = attachedTerminal.scrollToBottom();
  if (!attached && state.terminalParked !== paneId) return;
  api(`/api/panes/${encodeURIComponent(paneId)}/scroll-bottom`, { method: "POST", body: {} }).catch(() => {
    if (!retry) return;
    window.setTimeout(() => {
      if (chatLens.lens === "terminal" && state.selectedPaneId === paneId) showNewestTerminalOutput(paneId, { retry: false });
    }, SCROLL_BOTTOM_RETRY_MS);
  });
}

function scheduleTerminalPark(lens, paneId) {
  window.clearTimeout(terminalParkTimer);
  terminalParkTimer = null;
  if (lens !== "chat" || !paneId) return;
  terminalParkTimer = window.setTimeout(() => {
    terminalParkTimer = null;
    if (chatLens.lens !== "chat" || state.selectedPaneId !== paneId) return;
    state.terminalParked = paneId;
    attachedTerminal.show(null);
    terminalStream.unwatch();
  }, TERMINAL_PARK_MS);
}

// Made right after the lens switch, which tells it the lens (below).
let promptDock = null;
const chatLens = createChatLens({
  stage: elements.terminalStage,
  host: elements.chatHost,
  group: elements.lensSwitch,
  chatButton: elements.lensChat,
  terminalButton: elements.lensTerminal,
  storage: panePreferenceStorage,
  layout: () => ({ compact: !desktopMedia.matches, touch: usesTouchInputEnvironment() }),
  connection: terminalStream,
  fetchJson: conversationRequest,
  isLinkablePath: isLinkableTerminalPath,
  onOpenPath: openTerminalPath,
  onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
  onChatDrawn: (chat, drawn) => chatFind?.redrawn(chat, drawn),
  onLensChange: (lens, paneId, previous) => {
    // `previous` follows a pane renamed under it (a move to another workspace)
    if (lens === "terminal" && previous?.lens === "chat" && previous.paneId === paneId) showNewestTerminalOutput(paneId);
    scheduleTerminalPark(lens, paneId);
    // The key bar drives the terminal: the Chat lens hides it, and the
    // terminal fits again once it is back.
    elements.terminalPanel.dataset.lens = lens;
    // the composer's text size goes with the lens
    resizeTerminalInput();
    promptDock?.setLens(lens);
    syncSendButton();
    // Each lens has its own find bar, and each bar its own pane: a switch
    // closes the other lens's, and a pane switch the chat's.
    if (lens === "chat") terminalFind?.close();
    if (lens !== "chat" || chatFind?.paneId !== paneId) chatFind?.close();
    if (terminalFind) syncTerminalFind();
    if (lens === "terminal") window.requestAnimationFrame(() => attachedTerminal.refit());
    // Typing must not go on into a terminal that is no longer on screen.
    if (lens === "chat" && elements.terminalXterm.contains(document.activeElement)) {
      if (usesTouchInputEnvironment()) document.activeElement.blur();
      else elements.terminalInput.focus({ preventScroll: true });
    }
    if (lens === "terminal" && state.terminalParked) {
      state.terminalParked = null;
      void refreshTerminal();
    }
  },
});

// A blocked pane's prompt card: at the bottom of the Chat lens, and as a
// banner over the Terminal lens (src/prompt/, public/chat/prompt-card.js).
promptDock = createPromptDock({
  dock: elements.promptDock,
  connection: terminalStream,
  getJson: (path) => api(path),
  postJson: (path, body) => api(path, { method: "POST", body }),
  showChat: () => chatLens.showChat(),
  onAnswered: () => refreshAfterSubmission(),
});
promptDock.setLens(chatLens.lens);
elements.terminalPanel.dataset.lens = chatLens.lens;

// Find in the terminal: searches the pane's whole history on the server and
// herdr scrolls the pane's view to each match. Ctrl+F (Cmd+F on a Mac) opens
// it over the Terminal lens; the button in the header does on a phone too.
// A mirrored pane (no attach) shows a copy of its screen that herdr's scroll
// does not move, so it has no find.
const FIND_SHORTCUT_MAC = /Mac|iPhone|iPad/u.test(navigator.platform);
const MIRRORED_FIND_REASON = "Find needs the live terminal. This pane is shown as a copy of its screen, which a search cannot scroll.";
const terminalFindButton = document.querySelector("#terminal-find-open");
const terminalFindForm = document.querySelector("#terminal-find");
terminalFind = createTerminalFind({
  form: terminalFindForm,
  input: document.querySelector("#terminal-find-input"),
  count: document.querySelector("#terminal-find-count"),
  olderButton: document.querySelector("#terminal-find-older"),
  newerButton: document.querySelector("#terminal-find-newer"),
  closeButton: document.querySelector("#terminal-find-close"),
  search: (paneId, body) => api(`/api/panes/${encodeURIComponent(paneId)}/find`, { method: "POST", body }),
  reveal: (paneId, body) => api(`/api/panes/${encodeURIComponent(paneId)}/reveal`, { method: "POST", body }),
  // How many terminal rows the bar lies over, measured, so a match is
  // scrolled clear of it whatever the bar's size.
  coverRows: () => {
    const row = document.querySelector("#terminal-xterm .xterm-rows > div")?.getBoundingClientRect();
    const screen = document.querySelector("#terminal-xterm .xterm-screen")?.getBoundingClientRect();
    const bar = terminalFindForm.getBoundingClientRect();
    if (!row || !screen || row.height <= 0 || terminalFindForm.hidden) return undefined;
    return Math.max(0, Math.min(20, Math.ceil((bar.bottom - screen.top) / row.height)));
  },
  onHighlight: (marks) => attachedTerminal.setFind(marks),
  onOpen: () => syncTerminalFind(),
  onClose: () => {
    syncTerminalFind();
    if (!usesTouchInputEnvironment() && chatLens.lens === "terminal") attachedTerminal.focus();
  },
  onError: (message) => setFeedback(message, true),
});

// The pane find can work on now, or why not.
function terminalFindTarget() {
  const paneId = state.selectedPaneId && state.renderedPaneId === state.selectedPaneId ? state.selectedPaneId : null;
  return { paneId, mirrored: Boolean(paneId && state.mirrored?.paneId === paneId) };
}

function syncTerminalFind() {
  const { paneId, mirrored } = terminalFindTarget();
  terminalFind.setPane(mirrored ? null : paneId);
  terminalFindButton.hidden = !paneId;
  const shortcut = FIND_SHORTCUT_MAC ? "Cmd+F" : "Ctrl+F";
  // Over the Chat lens the same button finds in the conversation.
  if (chatLens.lens === "chat") {
    terminalFindButton.setAttribute("aria-controls", "chat-find");
    terminalFindButton.setAttribute("aria-disabled", "false");
    terminalFindButton.setAttribute("aria-expanded", String(Boolean(chatFind?.open)));
    terminalFindButton.setAttribute("aria-label", "Find in conversation");
    terminalFindButton.title = `Find in conversation (${shortcut})`;
    return;
  }
  terminalFindButton.setAttribute("aria-controls", "terminal-find");
  terminalFindButton.setAttribute("aria-disabled", String(mirrored));
  terminalFindButton.setAttribute("aria-expanded", String(terminalFind.open));
  terminalFindButton.setAttribute("aria-label", "Find in terminal");
  terminalFindButton.title = mirrored ? MIRRORED_FIND_REASON : `Find in terminal (${shortcut})`;
}

function openTerminalFind() {
  const { paneId, mirrored } = terminalFindTarget();
  if (!paneId || mirrored) return false;
  if (chatLens.lens !== "terminal") chatLens.showTerminal();
  terminalFind.show(paneId);
  syncTerminalFind();
  return true;
}

// Find in the conversation: marks the turns the Chat lens has drawn, and
// offers to load the earlier ones it has not (chat-find.js).
const chatFindForm = document.querySelector("#chat-find");
chatFind = createChatFind({
  form: chatFindForm,
  input: document.querySelector("#chat-find-input"),
  count: document.querySelector("#chat-find-count"),
  olderButton: document.querySelector("#chat-find-older"),
  newerButton: document.querySelector("#chat-find-newer"),
  closeButton: document.querySelector("#chat-find-close"),
  more: document.querySelector("#chat-find-more"),
  moreButton: document.querySelector("#chat-find-load"),
  onOpen: () => syncTerminalFind(),
  onClose: () => syncTerminalFind(),
});

function openChatFind() {
  const chat = chatLens.lens === "chat" ? chatLens.chatFor(chatLens.paneId) : null;
  if (!chat) return false;
  chatFind.show(chat);
  syncTerminalFind();
  return true;
}

terminalFindButton.addEventListener("click", () => {
  if (chatLens.lens === "chat") {
    if (chatFind.open) chatFind.close();
    else openChatFind();
    return;
  }
  if (terminalFindButton.getAttribute("aria-disabled") === "true") {
    setFeedback(MIRRORED_FIND_REASON, true);
    return;
  }
  if (terminalFind.open) terminalFind.close();
  else openTerminalFind();
});

// Taken before xterm sees it (it would send ^F to the program), and over the
// Chat lens for the conversation's own find, but never from a text field: the
// composer, a dialog or the sidebar's fields keep the browser's own find.
window.addEventListener("keydown", (event) => {
  if (!isFindShortcut(event, FIND_SHORTCUT_MAC) || !state.authenticated) return;
  if (document.querySelector("dialog[open]")) return;
  const active = document.activeElement;
  const inTerminal = elements.terminalXterm.contains(active);
  const inFind = terminalFindForm.contains(active) || chatFindForm.contains(active);
  if (!inTerminal && !inFind && active instanceof HTMLElement &&
      (active.isContentEditable || active.matches("input, textarea, select"))) return;
  if (chatLens.lens === "chat") {
    if (!chatLens.chatFor(chatLens.paneId)) return;
    event.preventDefault();
    event.stopPropagation();
    openChatFind();
    return;
  }
  if (chatLens.lens !== "terminal") return;
  const { paneId, mirrored } = terminalFindTarget();
  if (!paneId || mirrored) return;
  event.preventDefault();
  event.stopPropagation();
  openTerminalFind();
}, { capture: true });

// The Chat lens's text size, apart from the terminal's (chat-font-preference.js).
let chatFontSize = readChatFontSize(panePreferenceStorage);
let chatFontWheelDelta = 0;
function applyChatFontSize(size, { save = true } = {}) {
  const scroller = chatLens.chatFor(chatLens.paneId)?.root.querySelector(".chat-scroll");
  // the reader keeps their place: at the end stays at the end, elsewhere the same share of the way down
  const atEnd = scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48 : false;
  const share = scroller && scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
  chatFontSize = size;
  elements.terminalStage.style.setProperty("--chat-scale", String(chatScale(size)));
  elements.terminalStage.dataset.chatFontSize = String(size);
  // the composer takes the chat's size in the Chat lens
  document.documentElement.style.setProperty("--chat-font-size", `${size}px`);
  resizeTerminalInput();
  if (save) writeChatFontSize(panePreferenceStorage, size);
  if (scroller) scroller.scrollTop = atEnd ? scroller.scrollHeight : share * scroller.scrollHeight;
}
applyChatFontSize(chatFontSize, { save: false });

function overChat(target) {
  return chatLens.lens === "chat" && target instanceof Node &&
    (elements.chatHost.contains(target) || elements.promptDock.contains(target));
}

// Two fingers on the chat pinch its text size; one finger still scrolls it.
let chatPinch = null;
const touchSpread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
elements.terminalStage.addEventListener("touchstart", (event) => {
  if (event.touches.length === 2 && overChat(event.target)) {
    chatPinch = { distance: touchSpread(event.touches), start: chatFontSize };
  }
}, { passive: true });
elements.terminalStage.addEventListener("touchmove", (event) => {
  if (!chatPinch || event.touches.length !== 2) return;
  event.preventDefault();
  const size = pinchedChatFontSize(chatPinch.start, chatPinch.distance, touchSpread(event.touches));
  if (size !== chatFontSize) applyChatFontSize(size, { save: false });
}, { passive: false });
const endChatPinch = (event) => {
  if (!chatPinch || event.touches.length >= 2) return;
  if (chatFontSize !== chatPinch.start) writeChatFontSize(panePreferenceStorage, chatFontSize);
  chatPinch = null;
};
elements.terminalStage.addEventListener("touchend", endChatPinch, { passive: true });
elements.terminalStage.addEventListener("touchcancel", endChatPinch, { passive: true });

// The message (loading, errors) stands in for the terminal until a pane is drawn.
function showTerminalView(shown) {
  elements.terminalMessage.hidden = shown;
  elements.terminalXterm.hidden = !shown;
  if (!shown) elements.terminalHeld.hidden = true;
}

document.querySelector("#terminal-take-over").addEventListener("click", () => attachedTerminal.takeOver());

function clearComposer() {
  if (draftPaneId) draftBlocked.delete(draftPaneId);
  composerPopup.close();
  elements.terminalInput.value = "";
  window.clearTimeout(terminalInputResizeTimer);
  terminalInputResizeTimer = null;
  resizeTerminalInput();
}

elements.inputForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.terminalInput.value;
  const paneId = state.selectedPaneId;
  composerSending = true;
  syncSendButton();
  setFeedback("Sending…");
  // The Chat lens shows the message on its way and goes to the end at once.
  // The text itself shows only once the server says it was no password answer.
  let delivered = false;
  let secret = false;
  if (paneId) holdComposerDraft(paneId);
  chatLens.sent(paneId, null);
  let pending = null;
  try {
    if (text) {
      const sent = await sendText(text, paneId);
      secret = sent?.secret === true;
      // An answer to a password prompt is never kept, nor left on show in the chat.
      if (!sent?.secret) pending = chatLens.pend(paneId, text);
      if (!sent?.secret && paneKeepsInputHistory(paneId, snapshotRecords())) rememberSentInput(paneId, text);
    } else {
      await sendKeys(["enter"], paneId);
    }
    delivered = true;
    // Only the pane's own box: the message may have been sent from another pane's draft.
    if (draftPaneId === paneId || !paneId) clearComposer();
    setFeedback("");
    refreshAfterSubmission();
  } catch (error) {
    chatLens.unsent(paneId, pending);
    setFeedback(error.message, true);
  } finally {
    if (paneId) releaseComposerDraft(paneId, { sent: delivered, text, secret });
    composerSending = false;
    // On a desktop the composer gets focus back after a click on Send, so
    // the button stays Send and a second click cannot stop what was just
    // sent. A touch screen keeps its keyboard down (focusComposer no-ops).
    focusComposer();
    syncSendButton();
  }
});

elements.terminalInput.addEventListener("keydown", (event) => {
  if (composerPopup.handleKeydown(event)) return;
  // Esc in the composer stops the agent, as it does in the terminal, unless
  // the @ list (answered above), the find bar or a dialog has Esc first.
  if (composerEscapeStops({
    key: event.key, isComposing: event.isComposing, keyCode: event.keyCode,
    ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
    stopShown: stopReady(),
    ownedElsewhere: composerPopup.isOpen || Boolean(chatFind?.open) || Boolean(document.querySelector("dialog[open]")),
  })) {
    event.preventDefault();
    event.stopPropagation();
    void stopAgent();
    return;
  }
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
    if (!composerSending) elements.inputForm.requestSubmit();
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
  scheduleComposerDraftSave();
});

elements.terminalInput.addEventListener("blur", () => {
  void refreshTerminal();
});

window.addEventListener("resize", resizeTerminalInput);

let keyBarItems = readKeyBarItems(panePreferenceStorage);
const PAGE_KEY_DIRECTION = Object.freeze({ pageup: -1, pagedown: 1 });

function renderKeyBar() {
  const buttons = keyBarItems.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = keyBarItemLabel(item);
    if (item.type === "modifier") {
      button.dataset.modifier = item.modifier;
      button.setAttribute("aria-pressed", "false");
      button.title = "Combine with the next button or keyboard key";
    } else {
      button.dataset.key = item.key;
      // A saved combination sends exactly its own chord, whatever is held.
      if (item.modifiers) button.dataset.chord = item.modifiers.join("+");
      if (item.modifiers) button.title = keyBarItemKey(item) || "";
    }
    return button;
  });
  elements.quickKeys.replaceChildren(...buttons);
  // A latched modifier whose button was removed would stay on unseen.
  for (const name of [...selectedKeyModifiers]) {
    if (!keyBarItems.some((item) => item.type === "modifier" && item.modifier === name)) {
      selectedKeyModifiers.delete(name);
    }
  }
  renderKeyModifiers();
}

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
  if (!key || keySendBusy || !state.authenticated || !state.selectedPaneId) return;
  keySendBusy = true;
  const paneId = state.selectedPaneId;
  clearKeyModifiers();
  setFeedback(`Sending ${key}…`);
  try {
    await sendKeys([key], paneId);
    refreshAfterSubmission();
    setFeedback("");
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    keySendBusy = false;
  }
}

// Send doubles as Stop: the key bar's Esc for the Chat lens, which has no key
// bar. While the selected Claude or Codex pane works and the composer is not
// focused, the button shows Stop; typing in the composer makes it Send again,
// so a draft can still go out (the agent queues it). Esc interrupts without
// losing the conversation: no confirmation.
const STOP_BUSY_MS = 1_000;
// Panes whose Stop is still sending: busy is per pane, so a slow Esc to one
// does not hold another pane's Stop, and never holds Send.
const stoppingPanes = new Set();
// A message on its way: Send waits for it.
let composerSending = false;
// The mode a press started in, kept until its click: pressing the button moves
// focus out of the composer, which must not turn a press on Send into Stop.
let pressedSendMode = null;
let pressedSendModeTimer = null;

// The selected pane is a working agent in the Chat lens.
function stopReady() {
  return Boolean(stopTarget.paneId) && stopTarget.paneId === state.selectedPaneId &&
    showsStop({ lens: chatLens.lens, agent: stopTarget.agent, status: stopTarget.status });
}

// Whether the composer is where the person is: in it, or on Send having
// tabbed there from it (a keyboard press on Send means sending the draft).
// Send focused by a pointer press is not: that press chose its mode already.
let sendFocusedByPointer = false;
function composerFocused() {
  const active = document.activeElement;
  if (active === elements.sendButton) return !sendFocusedByPointer;
  return active === elements.terminalInput && !composerKeyboardDismissed;
}

function sendButtonMode() {
  // A message on its way keeps the button Send (and busy): a second press
  // then can never stop the work it is starting.
  if (composerSending || stopTarget.paneId !== state.selectedPaneId) return "send";
  return sendButtonModeFor({ lens: chatLens.lens, agent: stopTarget.agent, status: stopTarget.status,
    composerFocused: composerFocused() });
}

function syncSendButton() {
  const button = elements.sendButton;
  const mode = pressedSendMode ?? sendButtonMode();
  const stop = mode === "stop";
  const busy = stop && stoppingPanes.has(state.selectedPaneId);
  button.dataset.mode = mode;
  button.setAttribute("aria-label", stop ? "Stop" : "Send");
  button.title = stop ? "Stop (Esc)" : "Send";
  button.disabled = stop ? busy : composerSending;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function releasePressedSendMode() {
  window.clearTimeout(pressedSendModeTimer);
  pressedSendModeTimer = null;
  if (pressedSendMode === null) return;
  pressedSendMode = null;
  syncSendButton();
}

async function stopAgent() {
  const paneId = state.selectedPaneId;
  if (!stopReady() || !state.authenticated || !paneId || stoppingPanes.has(paneId)) return;
  // Busy until the Esc has gone, and for a moment at least; then ready again,
  // as Claude may need a second Esc. Stop does not queue behind another key
  // on its way (a slow link, a stuck request): the Esc goes at once, to the
  // pane it was pressed for, and is never dropped for waiting.
  stoppingPanes.add(paneId);
  syncSendButton();
  const shortest = new Promise((resolve) => window.setTimeout(resolve, STOP_BUSY_MS));
  clearKeyModifiers();
  try {
    await sendKeys(["esc"], paneId);
    refreshAfterSubmission();
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    await shortest;
    stoppingPanes.delete(paneId);
    syncSendButton();
  }
}

// The press decides: at pointerdown, before focus leaves the composer, a press
// is Send if the composer is focused and Stop if not (while the agent works).
elements.sendButton.addEventListener("pointerdown", () => {
  // The mode is what the button shows as it is pressed (Send when tabbed to
  // from the composer); the pointer's own focus counts only after.
  const mode = sendButtonMode();
  sendFocusedByPointer = true;
  if (elements.sendButton.disabled) return;
  window.clearTimeout(pressedSendModeTimer);
  pressedSendMode = mode;
  syncSendButton();
});
elements.sendButton.addEventListener("pointercancel", releasePressedSendMode);
elements.sendButton.addEventListener("focus", () => syncSendButton());
elements.sendButton.addEventListener("blur", () => { sendFocusedByPointer = false; syncSendButton(); });
// A press let go off the button has no click: its mode goes a moment later.
window.addEventListener("pointerup", () => {
  if (pressedSendMode === null) return;
  window.clearTimeout(pressedSendModeTimer);
  pressedSendModeTimer = window.setTimeout(releasePressedSendMode, 1_000);
});
elements.sendButton.addEventListener("click", (event) => {
  const mode = pressedSendMode ?? sendButtonMode();
  releasePressedSendMode();
  if (mode !== "stop") return; // the form sends the draft
  event.preventDefault();
  void stopAgent();
});
// A press never moves focus into the composer: focus there ends any press.
elements.terminalInput.addEventListener("focus", () => {
  composerKeyboardDismissed = false;
  window.clearTimeout(pressedSendModeTimer);
  pressedSendMode = null;
  syncSendButton();
});
elements.terminalInput.addEventListener("blur", () => syncSendButton());
// A tap on a still-focused composer brings the phone keyboard back.
elements.terminalInput.addEventListener("pointerdown", () => {
  if (!composerKeyboardDismissed) return;
  composerKeyboardDismissed = false;
  syncSendButton();
});

// Keep the composer focused when using the screen keyboard with a mouse.
elements.quickKeys.addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});

// A phone keyboard put away leaves its input focused, and Android brings the
// keyboard back as soon as the terminal answers a key. With the keyboard away,
// a tap on the bar lets go of the input; with it up, typing carries on.
elements.quickKeys.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("button") || !usesTouchInputEnvironment() || phoneKeyboardOpen) return;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.matches("input, textarea")) focused.blur();
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
    focusComposer();
    return;
  }
  const button = event.target.closest("button[data-key]");
  if (!button) return;
  const modifiers = button.dataset.chord !== undefined ? button.dataset.chord.split("+") : [...selectedKeyModifiers];
  if (button.dataset.chord === undefined) {
    if (event.ctrlKey) modifiers.push("ctrl");
    if (event.altKey) modifiers.push("alt");
    if (event.shiftKey) modifiers.push("shift");
  }
  // PgUp and PgDn page through the history, as a finger or the wheel does: a
  // shell or Claude Code does nothing with the keys. Held Shift sends the plain
  // key instead (not Shift+PgUp, which less and vim do not read as paging).
  // In the chat lens there is no terminal to page, and the key goes as before.
  const page = button.dataset.chord === undefined && Object.hasOwn(PAGE_KEY_DIRECTION, button.dataset.key)
    ? PAGE_KEY_DIRECTION[button.dataset.key] : undefined;
  if (page && modifiers.length === 0 && attachedTerminal.scrollPage(page)) return;
  if (page && modifiers.length > 0 && modifiers.every((part) => part === "shift")) {
    void sendCommandKey(button.dataset.key);
    return;
  }
  void sendCommandKey(combinedTerminalKey(button.dataset.key, modifiers));
});

// Only intercept the terminal area: login fields and other dialogs retain
// their normal shortcuts. Without a selected modifier, the composer does too.
elements.terminalPanel.addEventListener("keydown", (event) => {
  if (!state.authenticated || !state.selectedPaneId) return;
  // A physical copy shortcut belongs to the browser while text is selected.
  if ((event.ctrlKey || event.metaKey) && !event.altKey &&
      event.key.toLowerCase() === "c" && window.getSelection()?.toString()) return;
  if (selectedKeyModifiers.size === 0) return;
  const key = keyboardTerminalKey(event, [...selectedKeyModifiers]);
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) void sendCommandKey(key);
}, { capture: true });

// Mobile keyboards may emit beforeinput without a usable keydown event. Most
// also compose even a single letter, which cannot be cancelled: then the held
// modifier takes the one character the composer gained, and it is taken out.
let modifierInputBefore = null;
// The keyboard may still commit the letter it was composing once the
// modifier has gone; that copy is taken out too.
let modifierComposition = null;
elements.terminalInput.addEventListener("beforeinput", (event) => {
  if (!selectedKeyModifiers.size) return;
  if (!event.isComposing && event.inputType === "insertText" && event.cancelable &&
      typeof event.data === "string" && event.data.length === 1) {
    const key = keyboardTerminalKey({ key: event.data }, [...selectedKeyModifiers]);
    if (key) {
      event.preventDefault();
      void sendCommandKey(key);
      return;
    }
  }
  // Only typing takes the modifier: a pasted letter stays text.
  if (event.inputType !== "insertText" && event.inputType !== "insertCompositionText") return;
  const input = elements.terminalInput;
  modifierInputBefore ??= { value: input.value, start: input.selectionStart, end: input.selectionEnd };
});

function restoreComposer(before) {
  elements.terminalInput.value = before.value;
  elements.terminalInput.setSelectionRange(before.start, before.end);
}

elements.terminalInput.addEventListener("input", (event) => {
  const input = elements.terminalInput;
  const before = modifierInputBefore;
  modifierInputBefore = null;
  // The composition that gave the key may still change or commit until it
  // ends: whatever it writes is taken out again.
  if (modifierComposition) {
    restoreComposer(modifierComposition);
    return;
  }
  if (!before || !selectedKeyModifiers.size) return;
  const head = before.value.slice(0, before.start);
  const tail = before.value.slice(before.end);
  const { value } = input;
  // Head and tail can overlap when the text was cut short, so check the length too.
  if (value.length < head.length + tail.length || !value.startsWith(head) || !value.endsWith(tail)) return;
  const added = value.slice(head.length, value.length - tail.length);
  // Only a letter, digit or sign: a Korean or Japanese keyboard composes a
  // syllable through partial ones, and Ctrl with those means nothing here.
  const key = /^[\x21-\x7e]$/u.test(added) ? keyboardTerminalKey({ key: added }, [...selectedKeyModifiers]) : null;
  if (!key) return;
  restoreComposer(before);
  if (event.isComposing) modifierComposition = before;
  void sendCommandKey(key);
});

// A composition the key was taken from may end without a compositionend once
// the composer was set back; the next one starts afresh.
elements.terminalInput.addEventListener("compositionstart", () => {
  modifierComposition = null;
});

elements.terminalInput.addEventListener("compositionend", () => {
  // Some browsers commit after compositionend; let that input arrive first.
  window.setTimeout(() => {
    modifierComposition = null;
    modifierInputBefore = null;
  }, 0);
});

// A composition cut short by leaving the composer leaves nothing to take out.
elements.terminalInput.addEventListener("blur", () => {
  modifierComposition = null;
  modifierInputBefore = null;
});

// The "Edit keys" window: a list in bar order (drag a row on a desktop, or use
// the arrows), a list of keys to add, and custom combinations. Every change is
// saved and drawn on the bar at once.
const keyBarDialog = {
  root: document.querySelector("#key-bar-dialog"),
  list: document.querySelector("#key-bar-list"),
  empty: document.querySelector("#key-bar-empty"),
  addSelect: document.querySelector("#key-bar-add-select"),
  add: document.querySelector("#key-bar-add"),
  comboKey: document.querySelector("#key-bar-combo-key"),
  comboChar: document.querySelector("#key-bar-combo-char"),
  comboPreview: document.querySelector("#key-bar-combo-preview"),
  comboAdd: document.querySelector("#key-bar-combo-add"),
};
const KEY_BAR_CHARACTER = "character";
const comboModifiers = new Set();
let keyBarDragFrom = null;

function setKeyBarItems(next) {
  keyBarItems = next;
  writeKeyBarItems(panePreferenceStorage, keyBarItems);
  renderKeyBar();
  renderKeyBarDialog();
}

function keyBarComboItem() {
  const base = keyBarDialog.comboKey.value === KEY_BAR_CHARACTER ? keyBarDialog.comboChar.value : keyBarDialog.comboKey.value;
  if (keyBarDialog.comboKey.value === KEY_BAR_CHARACTER && [...base].length !== 1) return { error: "Enter one character." };
  const item = customKeyBarItem(base, [...comboModifiers]);
  return item ? { item } : { error: "That is not a key the terminal can take." };
}

function renderKeyBarCombo() {
  const character = keyBarDialog.comboKey.value === KEY_BAR_CHARACTER;
  keyBarDialog.comboChar.hidden = !character;
  for (const button of keyBarDialog.root.querySelectorAll("[data-combo-modifier]")) {
    button.setAttribute("aria-pressed", String(comboModifiers.has(button.dataset.comboModifier)));
  }
  const { item, error } = keyBarComboItem();
  const exists = item && keyBarItems.some((current) => keyBarItemId(current) === keyBarItemId(item));
  keyBarDialog.comboPreview.textContent = item ? keyBarItemLabel(item) : error;
  keyBarDialog.comboAdd.disabled = !item || exists || keyBarItems.length >= KEY_BAR_ITEMS_MAX;
  keyBarDialog.comboAdd.title = exists ? "Already on the bar" : "";
}

function fillKeyBarSelects() {
  const keyOption = (name) => {
    const option = createElement("option", { text: keyBarItemLabel({ type: "key", key: name }) });
    option.value = name;
    return option;
  };
  const modifierOption = (name) => {
    const option = createElement("option", { text: `${keyBarItemLabel({ type: "modifier", modifier: name })} (held for the next key)` });
    option.value = `modifier:${name}`;
    return option;
  };
  const chosen = keyBarDialog.addSelect.value;
  const present = new Set(keyBarItems.map(keyBarItemId));
  const options = [
    ...KEY_BAR_MODIFIERS.filter((name) => !present.has(`modifier:${name}`)).map(modifierOption),
    ...KEY_BAR_KEYS.filter((name) => !present.has(keyBarItemId({ type: "key", key: name }))).map(keyOption),
  ];
  if (!options.length) {
    const none = createElement("option", { text: "All keys added" });
    none.value = "";
    options.push(none);
  }
  keyBarDialog.addSelect.replaceChildren(...options);
  if (options.some((option) => option.value === chosen)) keyBarDialog.addSelect.value = chosen;
  keyBarDialog.add.disabled = !keyBarDialog.addSelect.value || keyBarItems.length >= KEY_BAR_ITEMS_MAX;
  if (!keyBarDialog.comboKey.options.length) {
    const comboOptions = KEY_BAR_KEYS.map(keyOption);
    const character = createElement("option", { text: "Single character" });
    character.value = KEY_BAR_CHARACTER;
    keyBarDialog.comboKey.replaceChildren(...comboOptions, character);
    keyBarDialog.comboKey.value = KEY_BAR_CHARACTER;
  }
}

function renderKeyBarDialog() {
  fillKeyBarSelects();
  keyBarDialog.empty.hidden = keyBarItems.length > 0;
  const rows = keyBarItems.map((item, index) => {
    const name = keyBarItemLabel(item);
    const row = createElement("li", { className: "key-bar-item" });
    row.draggable = true;
    row.dataset.index = String(index);
    row.append(
      createElement("span", { className: "key-bar-cap", text: name }),
      createElement("span", {
        className: "key-bar-kind",
        text: item.type === "modifier" ? "Held for the next key" : item.modifiers ? "Combination" : "",
      }),
    );
    const actions = createElement("span", { className: "key-bar-item-actions" });
    const action = (label, text, handler, disabled = false) => {
      const button = createElement("button", { text });
      button.type = "button";
      button.disabled = disabled;
      button.setAttribute("aria-label", `${label} ${name}`);
      button.title = `${label} ${name}`;
      button.addEventListener("click", handler);
      return button;
    };
    actions.append(
      action("Move up", "↑", () => setKeyBarItems(moveKeyBarItem(keyBarItems, index, index - 1)), index === 0),
      action("Move down", "↓", () => setKeyBarItems(moveKeyBarItem(keyBarItems, index, index + 1)), index === keyBarItems.length - 1),
      action("Remove", "×", () => setKeyBarItems(removeKeyBarItem(keyBarItems, index))),
    );
    row.append(actions);
    return row;
  });
  keyBarDialog.list.replaceChildren(...rows);
  renderKeyBarCombo();
}

function keyBarDropTarget(event) {
  const row = event.target.closest?.(".key-bar-item");
  if (!row || keyBarDragFrom === null) return null;
  const rect = row.getBoundingClientRect();
  return { row, index: Number(row.dataset.index), after: event.clientY > rect.top + rect.height / 2 };
}

function clearKeyBarDropMarks() {
  for (const row of keyBarDialog.list.children) {
    delete row.dataset.drop;
    delete row.dataset.dragging;
  }
}

keyBarDialog.list.addEventListener("dragstart", (event) => {
  const row = event.target.closest?.(".key-bar-item");
  if (!row) return;
  keyBarDragFrom = Number(row.dataset.index);
  row.dataset.dragging = "true";
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(keyBarDragFrom));
});
keyBarDialog.list.addEventListener("dragover", (event) => {
  const target = keyBarDropTarget(event);
  if (!target) return;
  event.preventDefault();
  for (const row of keyBarDialog.list.children) delete row.dataset.drop;
  target.row.dataset.drop = target.after ? "after" : "before";
});
keyBarDialog.list.addEventListener("drop", (event) => {
  const target = keyBarDropTarget(event);
  if (!target) return;
  event.preventDefault();
  let to = target.index + (target.after ? 1 : 0);
  if (keyBarDragFrom < to) to -= 1;
  const from = keyBarDragFrom;
  keyBarDragFrom = null;
  clearKeyBarDropMarks();
  setKeyBarItems(moveKeyBarItem(keyBarItems, from, to));
});
keyBarDialog.list.addEventListener("dragend", () => {
  keyBarDragFrom = null;
  clearKeyBarDropMarks();
});

keyBarDialog.add.addEventListener("click", () => {
  const value = keyBarDialog.addSelect.value;
  if (!value) return;
  const item = value.startsWith("modifier:")
    ? { type: "modifier", modifier: value.slice("modifier:".length) }
    : { type: "key", key: value };
  setKeyBarItems(addKeyBarItem(keyBarItems, item));
});
keyBarDialog.comboKey.addEventListener("change", renderKeyBarCombo);
keyBarDialog.comboChar.addEventListener("input", renderKeyBarCombo);
for (const button of keyBarDialog.root.querySelectorAll("[data-combo-modifier]")) {
  button.addEventListener("click", () => {
    const name = button.dataset.comboModifier;
    if (comboModifiers.has(name)) comboModifiers.delete(name);
    else comboModifiers.add(name);
    renderKeyBarCombo();
  });
}
keyBarDialog.comboAdd.addEventListener("click", () => {
  const { item } = keyBarComboItem();
  if (item) setKeyBarItems(addKeyBarItem(keyBarItems, item));
});
document.querySelector("#key-bar-reset").addEventListener("click", () => {
  resetKeyBarItems(panePreferenceStorage);
  keyBarItems = [...DEFAULT_KEY_BAR_ITEMS];
  renderKeyBar();
  renderKeyBarDialog();
});
document.querySelector("#key-bar-close").addEventListener("click", () => keyBarDialog.root.close());

function openKeyBarDialog() {
  renderKeyBarDialog();
  keyBarDialog.root.showModal();
}

renderKeyBar();

window.addEventListener("blur", clearKeyModifiers);

elements.createProject.addEventListener("click", () => {
  document.querySelector("#add-menu").open = false;
  if (state.mutationBusy) return;
  const herdrSession = newProjectHerdrSession();
  if (!herdrSession) return;
  state.createProjectSessionId = idOf(herdrSession, "session_id", "id") || null;
  const select = document.querySelector("#project-server-session");
  select.replaceChildren();
  // Every machine's running sessions: the picker chooses where it is made.
  for (const session of snapshotRecords().herdrSessions.filter((item) => item.running && item.available)) {
    const option = createElement("option", { text: `${session.server_name || "Local"} / ${session.name}` });
    option.value = idOf(session, "session_id", "id");
    select.append(option);
  }
  select.value = state.createProjectSessionId || "";
  select.disabled = select.options.length < 2;
  elements.projectSessionContext.textContent = select.options.length > 1
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
      // null: the server accepts any size.
      if (state.maxTransferBytes !== null && file.size > state.maxTransferBytes) {
        failed.push({ name, reason: `larger than ${formatTransferSize(state.maxTransferBytes)}` });
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
// Only the last file link pressed is taken to. One still waiting gives way to
// a later link, and to any folder or machine picked by hand meanwhile.
let revealGeneration = 0;

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

// A folder the tree can open into: not a broken link, and not one of the
// sign-in folders the server lists by name only.
function isOpenableFolder(entry) {
  return entry.kind === "directory" && !entry.broken && entry.locked !== true;
}

// The server marks a locked entry readable: false too, so the file actions
// need no separate locked test.
function browseRow({ entry, depth, expanded }) {
  // Sign-in keys and HerdRabbit's own settings are listed by name only: the
  // server never opens them, so neither does the tree.
  const locked = entry.locked === true;
  const row = createElement("div", { className: "transfer-row browse-row" });
  if (locked) row.classList.add("is-locked");
  row.tabIndex = -1;
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
  if (isOpenableFolder(entry) && !entry.removed) {
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
  } else if (locked) {
    row.title = `${entry.name}\nHerdRabbit does not open sign-in keys or its own settings.`;
  } else if (entry.modifiedAt) {
    const size = entry.kind === "directory" ? "" : `${formatTransferSize(entry.size ?? 0)} · `;
    row.title = `${entry.name}\n${size}${new Date(entry.modifiedAt).toLocaleString()}`;
  }

  if (entry.broken) {
    lead.append(createElement("span", { className: "transfer-meta", text: "broken" }));
  } else if (locked) {
    lead.append(createElement("span", { className: "transfer-meta", text: "locked" }));
  }

  const actions = createElement("div", { className: "transfer-row-actions" });
  if (!entry.removed) {
    // Expanding shows a folder in place; this re-roots the tree there, so a deep
    // path stops costing a column of indentation.
    if (isOpenableFolder(entry)) {
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
      if (isOpenableFolder(entry)) void toggleBrowseFolder(entry.path);
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

async function fetchListing(target, { prefix = "", server = browseState.server } = {}) {
  const parts = [`server=${encodeURIComponent(server)}`];
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

// Says whether the folder is now the one on show.
async function loadBrowseFolder(target, { refresh = false, reveal = false } = {}) {
  if (!reveal) revealGeneration += 1;
  if (browseState.busy) return false;
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
    return true;
  } catch (error) {
    setBrowseFeedback(error.message, true);
    return false;
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
// would drop exactly those, and a connected PC's files may still be reachable
// when Herdr itself is missing there.
function refreshServerChoices() {
  const options = [
    { id: "local", name: "This machine" },
    // Every connected PC answers for its own files.
    ...array(state.snapshot?.servers)
      .filter((server) => server.id !== "local")
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

// Points the Files tab at another machine and loads `target` there. An empty
// target asks that machine where its home is.
function selectBrowseServer(id, target, { reveal = false } = {}) {
  browseState.server = id;
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
  return loadBrowseFolder(target ?? (readBrowsePath(browsePathStorage, browseState.server) || ""), { reveal });
}

// How often a waiting folder load checks whether the one under way is done.
const BROWSE_IDLE_POLL_MS = 50;

// Resolves once no folder load is under way. `giveUp()` is asked after each
// wait; when it says so, resolves false instead.
async function waitForBrowseIdle(giveUp = () => false) {
  while (browseState.busy) {
    await new Promise((resolve) => window.setTimeout(resolve, BROWSE_IDLE_POLL_MS));
    if (giveUp()) return false;
  }
  return true;
}

// A machine picked by hand waits out a load still under way, which would turn
// its own away, and a file link still waiting gives way to it.
elements.fileServer.addEventListener("change", async () => {
  const id = elements.fileServer.value;
  revealGeneration += 1;
  await waitForBrowseIdle();
  if (elements.fileServer.value !== id) return;
  void selectBrowseServer(id);
});

const REVEAL_LOADED = "loaded";
const REVEAL_FAILED = "failed";
const REVEAL_SUPERSEDED = "superseded";

// A file the viewer cannot show is still a file somebody named: take them to
// it in the Files tab, in its own folder, with its row selected and in view.
// A folder somebody named is opened itself: whether the name is a file or a
// folder is read from its row in the parent's listing.
async function revealInFiles(filePath, name, server) {
  const generation = ++revealGeneration;
  const folder = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
  if (desktopMedia.matches) state.desktopSidebarCollapsed = false;
  else state.mobileSidebarOpen = true;
  syncSidebar();
  showNavigatorTab("files", { load: false });
  refreshServerChoices();
  // A load already under way would turn this one away, however slow the
  // machine it is reading: wait it out, and go again if another slipped in.
  // Settles as REVEAL_LOADED, REVEAL_FAILED, or REVEAL_SUPERSEDED when a later
  // press or a hand-picked folder took over.
  const open = async (target, first) => {
    const superseded = () => generation !== revealGeneration;
    for (;;) {
      if (!await waitForBrowseIdle(superseded)) return REVEAL_SUPERSEDED;
      const loaded = first && server !== browseState.server
        ? await selectBrowseServer(server, target, { reveal: true })
        : await loadBrowseFolder(target, { reveal: true });
      if (superseded()) return REVEAL_SUPERSEDED;
      if (loaded || !browseState.busy) return loaded ? REVEAL_LOADED : REVEAL_FAILED;
    }
  };
  const outcome = await open(folder, true);
  if (outcome === REVEAL_SUPERSEDED) return;
  elements.fileServer.value = browseState.server;
  if (outcome === REVEAL_FAILED) return;
  await ensureUploadsPath();
  if (generation !== revealGeneration) return;
  const listing = browseState.loaded.get(browseState.root);
  let entry = listing?.entries.find((item) => item.name === name);
  // A folder listed only in part may hold it past the cut: ask for it by name,
  // and add it to the rows already shown.
  if (!entry && listing?.truncated) {
    try {
      entry = (await fetchListing(browseState.root, { prefix: name })).entries.find((item) => item.name === name);
    } catch { /* the note below still says it could not be found */ }
    if (generation !== revealGeneration) return;
    if (entry) listing.entries.push(entry);
  }
  if (!entry) {
    setBrowseFeedback(`${name} is not in this folder.`);
    return;
  }
  if (isOpenableFolder(entry)) {
    browseState.selected = null;
    await open(entry.path, false);
    return;
  }
  browseState.selected = entry.path;
  renderBrowseTree();
  const row = browseRowElement(entry.path);
  row?.scrollIntoView({ block: "center" });
  row?.focus({ preventScroll: true });
}

function showNavigatorTab(tab, { load = true } = {}) {
  const files = tab === "files";
  elements.tabSessions.setAttribute("aria-selected", String(!files));
  elements.tabFiles.setAttribute("aria-selected", String(files));
  elements.workspaceList.hidden = files;
  elements.filePanel.hidden = !files;
  writeNavigatorTab(browsePathStorage, tab);
  if (files && load) {
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

window.addEventListener("herdr-theme-change", syncThemeItem);

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
  // Over the Chat lens it sizes the chat's text, not the terminal's.
  if (overChat(event.target)) {
    if (chatFontWheelDelta !== 0 && Math.sign(chatFontWheelDelta) !== Math.sign(event.deltaY)) chatFontWheelDelta = 0;
    chatFontWheelDelta += event.deltaY;
    if (Math.abs(chatFontWheelDelta) < 40) return;
    applyChatFontSize(adjustedChatFontSize(chatFontSize, chatFontWheelDelta < 0 ? "larger" : "smaller"));
    chatFontWheelDelta = 0;
    return;
  }
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

// Mod+J switches the pane between Chat and Terminal. Inside the terminal,
// Ctrl+J stays the program's (a newline); Cmd+J on a Mac switches there too.
function activateLensShortcut(event) {
  if (!state.authenticated || event.isComposing || event.altKey || event.shiftKey ||
      event.key.toLowerCase() !== "j" || document.querySelector("dialog[open]")) return false;
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  if (!mac && elements.terminalXterm.contains(document.activeElement) && chatLens.lens === "terminal") return false;
  if (!chatLens.paneId) return false;
  event.preventDefault();
  event.stopPropagation();
  chatLens.toggle();
  return true;
}

document.addEventListener("keydown", (event) => {
  if (activateLensShortcut(event)) return;
  if (activatePaneShortcut(event)) return;
  if (event.key !== "Escape") return;
  // The settings menu answers Escape on its own; the sidebar stays as it is.
  if (settingsMenu.details?.open) {
    settingsMenu.details.open = false;
    settingsMenu.details.querySelector("summary").focus();
    return;
  }
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

document.addEventListener("visibilitychange", () => {
  if (document.hidden) terminalStream.pause();
  if (document.hidden || !state.authenticated) return;
  // A chat watching a pane whose terminal was let go still needs the socket.
  terminalStream.resume();
  void dismissDeliveredNotifications();
  if (pendingNotificationPaneId) void refreshSnapshot();
  void refreshTerminal();
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
  const bootstrap = await api("/api/bootstrap");
  state.csrfToken = bootstrap.csrfToken;
  state.pollIntervalMs = bootstrap.pollIntervalMs || state.pollIntervalMs;
  state.maxTransferBytes = Number.isFinite(bootstrap.maxTransferBytes) && bootstrap.maxTransferBytes > 0 ? bootstrap.maxTransferBytes : null;
  state.pushPublicKey = typeof bootstrap.pushPublicKey === "string"
    ? bootstrap.pushPublicKey
    : null;
  document.querySelector("#manage-servers").hidden = bootstrap.servers !== true;
  state.connectPc = bootstrap.connectPc && typeof bootstrap.connectPc.address === "string" ? bootstrap.connectPc : null;
  showApplication();
  showLegacyMachinesNotice(bootstrap.legacyMachines);
  browseState.pinnedServer = readFileServer(browsePathStorage);
  showNavigatorTab(readNavigatorTab(browsePathStorage));
  await refreshSnapshot();
  void resumeAiLogins();
  // Each time the app opens, and on Check: never on a timer.
  void updatePanel.resume().then(() => updatePanel.refresh());
  refreshTerminal();
  if (notificationPanePreference) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("pane");
    window.history.replaceState(null, "", cleanUrl);
  }
  void syncPushSubscription().catch(() => renderNotificationItem());
  void dismissDeliveredNotifications();
  focusComposer();
  if (!state.pollingStarted) {
    state.pollingStarted = true;
    window.setInterval(() => void refreshSnapshot(), state.pollIntervalMs * 2);
    window.setInterval(refreshOutputOnSchedule, Math.min(state.pollIntervalMs, OUTPUT_POLL_TICK_MS));
  }
}

// Herdr SSH machines (`herdr machine`) are not shown here any more. Said once
// per browser: those PCs come back with Connect PC.
const LEGACY_MACHINES_NOTICE_KEY = "herdr:legacy-machines-notice";
const legacyMachinesDialog = document.querySelector("#legacy-machines-dialog");
document.querySelector("#legacy-machines-close").addEventListener("click", () => legacyMachinesDialog.close());
function showLegacyMachinesNotice(count) {
  let seen = false;
  try { seen = panePreferenceStorage?.getItem(LEGACY_MACHINES_NOTICE_KEY) === "seen"; } catch {}
  const message = legacyMachinesNotice({ count, seen });
  if (!message || legacyMachinesDialog.open) return;
  document.querySelector("#legacy-machines-message").textContent = message;
  try { panePreferenceStorage?.setItem(LEGACY_MACHINES_NOTICE_KEY, "seen"); } catch {}
  legacyMachinesDialog.showModal();
}

// Connect PC: another PC running HerdRabbit, reached on its Connect PC port.
const serversDialog = document.querySelector("#servers-dialog");
const serverForm = document.querySelector("#server-form");
const serverFeedback = document.querySelector("#server-feedback");
let editingServer = null;
let serverBusy = false;

// A PC is only worth saving once it has actually answered, so Save stays
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
  serverSubmitButton.textContent = profile ? "Save changes" : "Save";
  // Switching to another PC drops whatever the last test proved.
  verifiedServerSettings = null;
  syncServerSubmitState();
}

async function serverAction(action) {
  if (serverBusy) return;
  serverBusy = true;
  serversDialog.querySelectorAll("button, input").forEach((element) => { element.disabled = true; });
  serverFeedback.textContent = "Connecting…";
  serverFeedback.dataset.error = "false";
  try { await action(); }
  catch (error) { serverFeedback.textContent = error.message; serverFeedback.dataset.error = "true"; }
  finally {
    serverBusy = false;
    serversDialog.querySelectorAll("button, input").forEach((element) => { element.disabled = false; });
    // The blanket re-enable above would otherwise hand Save back untested.
    syncServerSubmitState();
    for (const row of candidateList.querySelectorAll(".server-candidate")) row.disabled = row.dataset.state !== "ready";
  }
}

document.querySelector("#manage-servers").addEventListener("click", () => {
  document.querySelector("#add-menu").open = false;
  resetServerForm();
  serversDialog.showModal();
  // PCs already added are managed from their sidebar rows; here the list
  // marks them as added.
  serverFeedback.textContent = "";
  void lookForServers();
});

const candidateList = document.querySelector("#server-candidates");
const setupHint = document.querySelector("#server-setup-hint");
const restSummary = document.querySelector("#server-rest");
const chosenBlock = document.querySelector("#server-chosen");
const chosenAddress = document.querySelector("#server-chosen-address");
const manualAddress = document.querySelector("#server-manual-address");

// The address comes from the tailnet (or is typed below), so what is left to
// decide is what to call the PC here.
function chooseCandidate(candidate, { fromList = true } = {}) {
  serverForm.elements.namedItem("name").value = candidate?.name ?? "";
  serverForm.elements.namedItem("address").value = candidate?.address ?? "";
  chosenBlock.hidden = candidate === null;
  chosenAddress.textContent = candidate ? candidate.address : "";
  for (const row of candidateList.querySelectorAll(".server-candidate")) {
    row.classList.toggle("is-chosen", fromList && row.dataset.address === candidate?.address);
  }
  if (fromList) manualAddress.value = "";
  syncServerSubmitState();
  if (candidate) serverFeedback.textContent = "Test it to save.";
}

manualAddress.addEventListener("input", () => {
  const typed = manualAddress.value.trim();
  if (!typed) { chooseCandidate(null, { fromList: false }); return; }
  let name = typed;
  try { name = new URL(typed).hostname || typed; } catch { /* the test says what is wrong with it */ }
  const current = serverForm.elements.namedItem("name").value;
  chooseCandidate({ name: current || name, address: typed }, { fromList: false });
});

const CANDIDATE_LABELS = {
  ready: "Ready",
  added: "Added",
  refused: "Does not allow this PC",
  incompatible: "Other protocol",
  absent: "No Connect PC port",
  offline: "Offline",
};

const CANDIDATE_ORDER = ["ready", "refused", "incompatible", "added"];
const NOTHING_TO_DO = new Set(["absent", "offline"]);

function candidateRow(candidate) {
  const row = createElement("button", { className: `server-candidate is-${candidate.state}` });
  row.type = "button";
  // Only a ready PC can be picked; the rest are shown so the reason is visible.
  row.disabled = candidate.state !== "ready";
  row.dataset.state = candidate.state;
  row.dataset.address = candidate.address;
  row.title = candidate.reason || candidate.address;
  const dot = createElement("span", { className: "server-candidate-dot" });
  dot.setAttribute("aria-hidden", "true");
  const identity = createElement("span", { className: "server-candidate-identity" });
  let where = candidate.address;
  try {
    const url = new URL(candidate.address);
    where = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch { /* an address we cannot parse is shown as it came */ }
  // A different app version connects; it is only said, for the person to know.
  if (candidate.version) where = `${where} · HerdRabbit ${candidate.version}`;
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
    setupHint.textContent = "Tailscale is not running, so PCs cannot be listed. Enter an address below instead.";
    return;
  }
  setupHint.textContent = found.self?.address
    ? `New PC? Install HerdRabbit there, open its Connect PC port, and allow ${found.self.address}.`
    : "";
  const candidates = array(found.candidates);
  if (candidates.length === 0) {
    candidateList.append(createElement("p", { className: "dialog-feedback", text: "No other PCs here." }));
    return;
  }
  const ordered = [...candidates].sort((first, second) =>
    CANDIDATE_ORDER.indexOf(first.state) - CANDIDATE_ORDER.indexOf(second.state));
  const actionable = ordered.filter((candidate) => !NOTHING_TO_DO.has(candidate.state));
  const rest = ordered.filter((candidate) => NOTHING_TO_DO.has(candidate.state));
  for (const candidate of actionable) candidateList.append(candidateRow(candidate));
  if (actionable.length === 0) {
    candidateList.append(createElement("p", { className: "dialog-feedback", text: "Nothing ready to connect yet." }));
  }
  restSummary.textContent = rest.length === 0
    ? ""
    : `${rest.length} other ${rest.length === 1 ? "PC" : "PCs"} with nothing to connect to.`;
}

// Only the latest look is drawn: an earlier one that answers late (a Refresh
// pressed while it ran) does not overwrite it.
let serverLook = 0;

async function lookForServers() {
  const look = ++serverLook;
  candidateList.replaceChildren(createElement("p", { className: "dialog-feedback", text: "Looking…" }));
  setupHint.textContent = "";
  try {
    const found = await api("/api/servers/discover", { method: "POST", body: {} });
    if (look === serverLook) renderCandidates(found);
  } catch (error) {
    if (look !== serverLook) return;
    candidateList.replaceChildren();
    setupHint.textContent = error.message;
  }
}

document.querySelector("#server-refresh").addEventListener("click", () => { void lookForServers(); });
document.querySelector("#server-close").addEventListener("click", () => { if (!serverBusy) serversDialog.close(); });
serversDialog.addEventListener("cancel", (event) => { if (serverBusy) event.preventDefault(); });
document.querySelector("#server-test").addEventListener("click", () => {
  if (!serverForm.elements.namedItem("address").value) {
    serverFeedback.textContent = "Pick a PC, or enter its Connect PC address.";
    serverFeedback.dataset.error = "true";
    return;
  }
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
    await refreshSnapshot();
    void lookForServers();
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
  buildSettingsMenu();
  syncThemeItem();
  renderNotificationItem();
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
    syncSettingsMenu();
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
