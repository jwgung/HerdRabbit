import { array, browserSessionStorage, browserStorage, createElement, createIcon, placeFloatingMenu, workspaceActionButton } from "./app/dom.js?v=1.4.23";
import { createSnapshotModel, idOf } from "./app/snapshot.js?v=1.4.23";
import { combinedTerminalKey, keyboardTerminalKey } from "./key-combinations.js?v=1.4.23";
import { previewFor } from "./file-preview.js?v=1.4.23";
import { isFileName, isFolderPath, trimTrailingSlashes } from "./path-links.js?v=1.4.23";
import { createApiClient, paneApi } from "./api-client.js?v=1.4.23";
const selectedKeyModifiers = new Set();
let modifierPaneId = null;
let keySendBusy = false;
// The selected pane's agent and status, for the Chat lens's Stop button.
let stopTarget = { paneId: null, agent: null, status: null };
import {
  HISTORY_PAGE_LINES,
  agentStatus,
  detectTouchInput,
  displayRecordLabel,
  displayTabLabel,
  inputKeyAction,
  insertNewlineAtSelection,
  paneServerId,
  loginMethodPresentation,
  nextInputHistory,
  shouldBrowseInputHistory,
  preferredLoginMethod,
  outputPollingDecision,
  outputTextForUpdate,
  paneShortcutTarget,
  paneSelectionAfterSnapshot,
  sidebarPresentation,
  paneAgentKind,
  agentStatusIcon,
  agentStatusLabel,
  mostUrgentStatus,
  paneDisplayTitle,
  paneSubtitle,
  openRenames,
  clearedTabLabel,
  paneKeepsInputHistory,
  reconcileLiveStatus,
  seenCompletions,
  navigationModel,
  serverConnectionState,
} from "./ui-model.js?v=1.4.23";
import {
  readFileServer,
  readNavigatorTab,
} from "./browse-preference.js?v=1.4.23";
import { terminalConnection } from "./terminal-connection.js?v=1.4.23";
import { createAttachTracker, terminalStatus, terminalStatusParts } from "./terminal-status.js?v=1.4.23";
import { createAttachedTerminal } from "./xterm-terminal.js?v=1.4.23";
import { createPaneGrid, renderPaneMap } from "./pane-grid.js?v=1.4.23";
import { createTerminalFind, isFindShortcut } from "./terminal-find.js?v=1.4.23";
import { createChatLens } from "./chat/chat-view.js?v=1.4.23";
import { createChatFind } from "./chat/chat-find.js?v=1.4.23";
import { createPromptDock } from "./chat/prompt-card.js?v=1.4.23";
import {
  adjustedChatFontSize,
  chatScale,
  pinchedChatFontSize,
  readChatFontSize,
  writeChatFontSize,
} from "./chat-font-preference.js?v=1.4.23";
import { chatAgent } from "./lens-preference.js?v=1.4.23";
import { composerEscapeStops, sendButtonMode as sendButtonModeFor, showsStop, stopFollowUp, stopPresses } from "./chat/chat-activity.js?v=1.4.23";
import * as xterm from "./vendor/xterm.mjs?v=1.4.23";
import {
  readPanePreference,
  writePanePreference,
} from "./pane-preference.js?v=1.4.23";
import {
  readCollapsedGroupIds,
  readCollapsedWorkspaceIds,
  readExpandedSplitTabIds,
  writeCollapsedGroupIds,
  writeCollapsedWorkspaceIds,
  writeExpandedSplitTabIds,
} from "./workspace-preference.js?v=1.4.23";
import {
  adjustedTerminalFontSize,
  readGridFit,
  readGridFont,
  readTerminalFontSize,
  writeGridFont,
  writeTerminalFontSize,
} from "./terminal-preference.js?v=1.4.23";
import {
  readAcknowledgedCompletions,
  writeAcknowledgedCompletions,
} from "./completion-preference.js?v=1.4.23";
import {
  looksLikePhysicalKey,
  readEnterKeyMode,
} from "./enter-key-preference.js?v=1.4.23";
import {
  attachSidebarDrag,
  dropScope,
  followMovedPane,
  movedTabSnapshot,
  movedWorkspaceSnapshot,
  paneMoveRequest,
  tabMoveRequest,
  workspaceMoveRequest,
} from "./sidebar-drag.js?v=1.4.23";
import {
  addTile,
  layoutRects,
  moveTile,
  paneDropKind,
  prune as pruneViewTiles,
  readViewSplit,
  removeTile,
  renameTiles,
  swapTiles,
  tiles as viewTiles,
  writeViewSplit,
} from "./view-split.js?v=1.4.23";
import { renamePaneKeys } from "./pane-rename.js?v=1.4.23";
import { renamePaneLenses } from "./lens-preference.js?v=1.4.23";
import {
  readInputHistories,
  writeInputHistories,
} from "./input-history-preference.js?v=1.4.23";
import { atFilesSource } from "./composer-at-files.js?v=1.4.23";
import { createComposerPopup } from "./composer-popup.js?v=1.4.23";
import { slashCommandsSource } from "./composer-slash.js?v=1.4.23";
import { createComposerDrafts, draftScreenIsSecret, draftScreenShowsPrompt } from "./composer-draft-preference.js?v=1.4.23";
import {
  keyBarItemKey,
  keyBarItemLabel,
  readKeyBarItems,
} from "./key-bar-preference.js?v=1.4.23";
import {
  clearLaunchToken,
  readLaunchToken,
  writeLaunchToken,
} from "./launch-session.js?v=1.4.23";


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
import { createNotifications } from "./app/notifications.js?v=1.4.23";
// How long a link to another server's pane waits for that server's panes to load.
const PENDING_REMOTE_PANE_MS = 20_000;
const pageOpenedAt = Date.now();
// This window's own view split (view-split.js), kept for this window alone: a
// reload opens it again, on the tile last focused, unless a link names a pane.
const viewSplitStorage = browserSessionStorage();
const viewSplit = readViewSplit(viewSplitStorage);
const initialPanePreference =
  typeof notificationPanePreference === "string" &&
  notificationPanePreference.length > 0 &&
  notificationPanePreference.length <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(notificationPanePreference)
    ? notificationPanePreference
    : (viewSplit.shown && viewSplit.focus) || readPanePreference(panePreferenceStorage);
const initialCollapsedGroupIds = readCollapsedGroupIds(
  (() => { try { return window.localStorage; } catch { return null; } })(),
);
const initialCollapsedWorkspaceIds = readCollapsedWorkspaceIds(
  panePreferenceStorage,
);
const initialExpandedSplitTabIds = readExpandedSplitTabIds(panePreferenceStorage);
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
  paneMap: document.querySelector("#pane-map"),
  gridBack: document.querySelector("#grid-back"),
  viewBack: document.querySelector("#view-back"),
  viewClose: document.querySelector("#view-close"),
  chatHost: document.querySelector("#chat-host"),
  promptDock: document.querySelector("#prompt-dock"),
  lensSwitch: document.querySelector("#lens-switch"),
  lensChat: document.querySelector("#lens-chat"),
  lensTerminal: document.querySelector("#lens-terminal"),
  quickKeys: document.querySelector(".quick-keys"),
  inputForm: document.querySelector("#input-form"),
  sendButton: document.querySelector("#input-form .send-button"),
  terminalInput: document.querySelector("#terminal-input"),
  inputComposer: document.querySelector(".input-composer"),
  dictateButton: document.querySelector("#dictate-button"),
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
  navigatorTab: "sessions",
  mobileSidebarOpen: false,
  // The pane on screen, attached or mirrored, and a mirrored pane's text.
  // While a grid shows the selected pane's tab it is that pane, in its cell,
  // and `renderedGrid` is true.
  renderedPaneId: null,
  renderedGrid: false,
  mirrored: null,
  outputBurstUntil: 0,
  inputHistoryByPane: initialInputHistories,
  inputHistoryCursor: null,
  inputHistoryDraft: "",
  collapsedWorkspaceIds: initialCollapsedWorkspaceIds,
  collapsedGroupIds: initialCollapsedGroupIds,
  // Split sessions whose pane list is open under their row; folded otherwise.
  expandedSplitTabIds: initialExpandedSplitTabIds,
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
  // Split tabs shown as a grid of their panes (tab id -> "grid"); any other
  // tab shows its selected pane alone.
  paneViews: new Map(),
  // The pane last selected in each split tab (tab id -> pane id), so a split
  // session's row on a phone opens where the user was.
  lastPaneOfTab: new Map(),
};

const {
  snapshotRecords, newProjectHerdrSession, syncCreateProjectAvailability, herdrSessionForServer,
  agentForPane, visibleStatusForPane, acknowledgePaneCompletion, pruneAcknowledgedCompletions,
} = createSnapshotModel({ state, elements, storage: panePreferenceStorage });

// Made after `state`, which its listeners read. Nothing above calls these.
const notificationNavigation = createNotifications({
  state,
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  shownGrid: (...args) => shownGrid(...args),
});
const {
  acceptNotificationTarget, receiveNotificationRelay, completeNotificationRelay, restoreNotificationTarget,
} = notificationNavigation;

// Made right after `state`, which it reads, and before anything at the top
// level hands `api` on (createSettingsMenu below does, for the Update panel).
const { api, transferRequest, conversationRequest } = createApiClient({
  launchToken: () => state.launchToken,
  csrfToken: () => state.csrfToken,
  onAuthenticationRequired: () => {
    state.launchToken = clearLaunchToken(launchSessionStorage);
    showLogin();
  },
});
const paneCalls = paneApi(api);

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
      fetchCommands: (paneId) => paneCalls.commands(paneId),
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
  paneTargets: ({ tabId }) => paneDropTargets(tabId),
  onDropPane: (drop) => dropOnPane(drop),
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

// The composer's Enter on a touch device (see enter-key-preference.js), and
// whether this page has seen a physical keyboard type. The sighting lasts for
// the page only, so a keyboard unplugged later does not leave the on-screen
// keyboard without a way to break a line after a reload.
let enterKeyMode = readEnterKeyMode(browserStorage());
let physicalKeyboardSeen = false;
document.addEventListener("keydown", (event) => {
  if (!physicalKeyboardSeen && looksLikePhysicalKey(event)) physicalKeyboardSeen = true;
}, { capture: true, passive: true });

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
  applyNavigatorPanels();
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
  paneGrid.pause();
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
  // A grid left open over the sign-in connects its cells again.
  if (!document.hidden) {
    paneGrid.resume();
    viewGrid.resume();
  }
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
  return serverConnectionState(server, state.connection);
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
import { createSettingsMenu } from "./app/settings-menu.js?v=1.4.23";
const {
  settingsMenu, buildSettingsMenu, syncSettingsMenu, updatePanel, syncThemeItem,
  renderNotificationItem, syncPushSubscription,
} = createSettingsMenu({
  state,
  elements,
  api,
  snapshotRecords: (...args) => snapshotRecords(...args),
  setFeedback: (...args) => setFeedback(...args),
  panePreferenceStorage,
  desktopMedia,
  get paneGrid() { return paneGrid; },
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  openKeyBarDialog: (...args) => openKeyBarDialog(...args),
  showPasskeys: (...args) => showPasskeys(...args),
  showSessions: (...args) => showSessions(...args),
});

// On a Herdr grid whose cells keep their panes' sizes the text size steps the
// grid's own font, from the one its cells have now; the size chosen for a
// single pane stays as it is. A grid fitted to the window reads at that size.
function adjustTerminalFont(direction) {
  if (paneGrid.adjustFont(direction)) return;
  applyTerminalFontSize(adjustedTerminalFontSize(state.terminalFontSize, direction));
}

function applyTerminalFontSize(nextSize) {
  state.terminalFontSize = nextSize;
  document.documentElement.style.setProperty(
    "--terminal-font-size",
    `${nextSize}px`,
  );
  writeTerminalFontSize(panePreferenceStorage, nextSize);
  syncComposerExpanded({ defer: true });
  resizeTerminalInput();
  attachedTerminal.setFontSize(nextSize);
  paneGrid.setFontSize(nextSize);
  viewGrid.setFontSize(nextSize);
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

// A long text turns the composer's one row into a card: the text on top across
// the whole width, the buttons in a row below it (styles.css, .is-expanded).
// It expands once the text needs a second line at the one-row width, or holds
// a newline, and folds back only when the box is empty: the change of layout
// itself changes the box's width, so folding back on a shorter text would
// flip it to and fro. `fresh` is for a text put in whole (a draft, a recalled
// message), which is judged from the one-row layout again. `defer` keeps the
// measuring out of the input event: it runs in the next frame.
let composerExpandFrame = 0;
function composerTextNeedsExpanding(input) {
  if (input.value.includes("\n")) return true;
  const style = window.getComputedStyle(input);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return false;
  const oneRow = lineHeight + Number.parseFloat(style.paddingTop || "0") + Number.parseFloat(style.paddingBottom || "0");
  return input.scrollHeight > oneRow + lineHeight / 2;
}

function syncComposerExpanded({ fresh = false, defer = false } = {}) {
  const composer = elements.inputComposer;
  const input = elements.terminalInput;
  if (!composer) return;
  window.cancelAnimationFrame(composerExpandFrame);
  composerExpandFrame = 0;
  if (input.value === "") {
    composer.classList.remove("is-expanded");
    return;
  }
  if (fresh) composer.classList.remove("is-expanded");
  if (composer.classList.contains("is-expanded")) return;
  if (input.value.includes("\n")) {
    composer.classList.add("is-expanded");
    return;
  }
  const judge = () => {
    composerExpandFrame = 0;
    if (input.value !== "" && composerTextNeedsExpanding(input)) composer.classList.add("is-expanded");
  };
  if (defer) composerExpandFrame = window.requestAnimationFrame(judge);
  else judge();
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
    syncComposerExpanded({ fresh: true });
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
      if (action.key) rule.dataset.separator = action.key;
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
  // OpenCode's mark: a pixelated "O" — outer ring with an inner block,
  // the same shape as the published favicon
  opencode: { box: "#131010", fills: [{ d: "M6 4.5h12v15H6V4.5ZM9 7.5v9h6v-9H9Z", color: "#ffffff" }, { d: "M9 10.5h6v6H9v-6Z", color: "#5A5858" }] },
  // Cursor's mark: a text caret on a dark field, the terminal cursor it is named for
  cursor: { box: "#111111", strokes: ["M9 5h6M9 19h6M12 5v14"], color: "#ffffff", width: 1.9 },
  // Kiro's Ghostie mark on its brand violet (from ovis / devswha, MIT)
  kiro: { box: "#9046FF", fills: [
    { d: "M8 16.4c-1.7 3.6 1.8 4.5 4.4 2.4.8 2.4 3.6.6 4.6-1.2 2.3-4.1 1.4-8.3 1.2-9.2-1.6-5.8-9.6-5.8-11 0q-.4 1.7-.5 3.5l-.4 1.7-.6 1.2c-.5.9-.3 2.5 2 1.7z", color: "#ffffff" },
    { d: "M12.7 11c-.6 0-.7-.8-.7-1.3q0-.6.2-1l.5-.2q.5 0 .6.3l.2 1q0 1.1-.8 1.2m2.7 0c-.6 0-.7-.8-.7-1.3q0-.6.2-1l.5-.2q.5 0 .6.3.3.3.2 1 0 1.1-.8 1.2", color: "#9046FF" },
  ] },
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
  if (mark.fills) {
    for (const { d, color } of mark.fills) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", color || "currentColor");
      path.setAttribute("fill-rule", "evenodd");
      svg.append(path);
    }
    return svg;
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

  // A row opens its pane alone, even in a split tab: the split session's own row opens the grid.
  // A pane that is a tile of this window's view split is focused there instead.
  button.addEventListener("click", () => {
    if (desktopMedia.matches && viewTiles(viewSplit.tree).includes(paneId)) {
      selectPane(paneId, { view: "tiles" });
      viewGrid.focus(paneId, { terminal: false });
    } else selectPane(paneId, { view: "solo" });
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
import { createAccountDialogs } from "./app/account-dialogs.js?v=1.4.23";
import { createAiAccounts } from "./app/ai-accounts.js?v=1.4.23";

const { showServerDetails, showSessions, showPasskeys, forgetComposerDrafts } = createAccountDialogs({
  state,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  showLogin: (...args) => showLogin(...args),
  renderLoginMethods: (...args) => renderLoginMethods(...args),
  passkeyErrorMessage: (...args) => passkeyErrorMessage(...args),
  supportsPasskeys: (...args) => supportsPasskeys(...args),
  enteredPassword: (...args) => enteredPassword(...args),
  registerPasskey: (...args) => registerPasskey(...args),
  launchSessionStorage,
  composerDrafts,
  draftBlocked,
  clearComposer: (...args) => clearComposer(...args),
  getDraftSaveTimer: () => draftSaveTimer,
  setDraftSaveTimer: (value) => { draftSaveTimer = value; },
  setDraftPaneId: (value) => { draftPaneId = value; },
});

const { showAiAccounts, resumeAiLogins } = createAiAccounts({
  state,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  setFeedback: (...args) => setFeedback(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
});

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
  // What the tree is made of is decided by navigationModel (ui-model.js); this
  // draws it, with the page's own editing and dragging.
  const tree = navigationModel({
    servers, herdrSessions, workspaces, tabs, panes,
    statusOfPane: (paneId, pane) => visibleStatusForPane(paneId, agentForPane(paneId), pane),
    pageConnection: state.connection,
  });
  elements.workspaceList.replaceChildren();
  // Shown even for this machine alone: its row is where the machine is managed,
  // AI accounts included.
  const serverBodies = new Map();
  for (const node of tree.servers) {
    const server = node.record;
    const group = createElement("section", { className: "server-group" });
    const editingServer = state.editingServerId === server.id;
    const connection = node.connection;
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
      if (node.role === "host") heading.append(createElement("small", { className: "server-role", text: "Host" }));
      else if (node.role) {
        heading.append(createElement("small", { text: node.role === "connecting" ? "Connecting" : "Offline" }));
      }
      const dot = createElement("span", { className: "server-dot" });
      dot.setAttribute("aria-hidden", "true");
      heading.append(dot);
      // A server is managed where it is seen. The dialog is for adding one.
      heading.append(serverActionMenu(server));
    }
    group.append(heading);
    const body = createElement("div", { className: "server-body" });
    if (node.emptyText !== null) body.append(createElement("p", { className: "server-empty", text: node.emptyText }));
    group.append(body);
    attachGroupCollapse(group, heading, body, `server:${server.id}`, server.name);
    serverBodies.set(node.id, body);
    elements.workspaceList.append(group);
  }

  const appendWorkspace = (parent, node) => {
    const workspace = node.record;
    const workspaceId = node.id;
    const group = createElement("section", { className: "workspace-group" });
    group.dataset.workspaceId = workspaceId;
    group.dataset.dropScope = dropScope(workspace);
    const workspaceLabel = displayRecordLabel(workspace, "Project");
    const { hasCompletion, hasRequest } = node;
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

    for (const { record: tab, id: tabId, panes: tabPanes } of node.tabs) {
      const tabGroup = createElement("div", { className: "tab-group" });
      tabGroup.dataset.tabId = tabId;
      tabGroup.dataset.workspaceId = workspaceId;
      tabGroup.dataset.dropScope = group.dataset.dropScope;
      const tabLabel = displayTabLabel(tab);
      const editingTab = state.editingTabId === tabId;
      const split = tabPanes.length > 1;
      const sessionRow = createElement("div", { className: "session-row" });
      let sessionLabel;
      if (split) {
        // A split session can be put in order within its project, not carried out.
        tabGroup.dataset.split = "true";
        sessionLabel = splitSessionName(tabId, tabLabel, tabPanes);
        const paneList = createElement("div", { className: "split-panes" });
        paneList.id = `split-${tabId.replace(/[^A-Za-z0-9_-]/gu, "_")}-panes`;
        paneList.hidden = !state.expandedSplitTabIds.has(tabId);
        tabGroup.classList.toggle("is-expanded", !paneList.hidden);
        // Each pane says its own name: the session's name is on the row. On
        // this machine each has its own ⋯ with the grid cell's actions.
        const local = isLocalRecord(tabPanes[0]);
        for (const pane of tabPanes) paneList.append(splitPaneRow(pane, tab, workspace, local));
        sessionRow.classList.add("split-session-row");
        if (editingTab) {
          sessionRow.classList.add("is-editing");
          sessionRow.append(tabRenameForm(tab, tabId, tabLabel));
        } else {
          // The arrow takes the place of the row's program mark: laid over the
          // mark's column, first in reading order as it is first on screen.
          sessionRow.append(
            splitDisclosureButton(tabGroup, tabId, sessionLabel, paneList),
            splitSessionButton(tabId, sessionLabel, tabPanes, workspace),
          );
        }
        tabGroup.append(sessionRow, paneList);
      } else {
        // With one pane the pane is the session, so its name belongs in the button.
        const namesSession = Boolean(tabLabel);
        // An unnamed session has no heading to rename in, so renaming makes one.
        if (editingTab) {
          const tabHeading = createElement("div", { className: "tab-heading is-editing" });
          tabHeading.append(tabRenameForm(tab, tabId, tabLabel));
          tabGroup.append(tabHeading);
        }
        const sessionPanes = createElement("div", { className: "session-panes" });
        for (const pane of tabPanes) {
          sessionPanes.append(paneButton(pane, tab, workspace, { namesSession }));
        }
        sessionRow.append(sessionPanes);
        tabGroup.append(sessionRow);
        sessionLabel =
          tabLabel ||
          displayRecordLabel(agentForPane(idOf(tabPanes[0], "pane_id", "id")), "Session");
      }
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
          // Gives the panes equal shares of the session, and undoes the
          // split: each pane but the first becomes a session of its own.
          // This machine's only, as the grid's actions are.
          ...(split && isLocalRecord(tabPanes[0]) ? [{
            key: "even-layout",
            label: "Even out layout",
            paths: EVEN_ICON,
            onSelect: () => void evenOutLayout(idOf(tabPanes[0], "pane_id", "id")),
          }, {
            key: "separate-all",
            label: "Separate all panes",
            paths: SEPARATE_ICON,
            onSelect: () => void separateSplitSession(tabId, sessionLabel),
          }] : []),
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
      if (!sessionRow.classList.contains("is-editing")) sessionRow.append(sessionMenu);
      childrenInner.append(tabGroup);
    }
    children.append(childrenInner);
    group.append(children);
    parent.append(group);
  };

  const appendSession = (parent, node) => {
    const session = node.record;
    const sessionGroup = createElement("section", {
      className: "herdr-session-group",
    });
    const sessionHeading = createElement("div", {
      className: "herdr-session-heading",
    });
    const statusDot = createElement("span", {
      className: `herdr-session-dot${node.tone === "online" ? " is-online" : node.tone === "error" ? " is-error" : ""}`,
    });
    statusDot.setAttribute("aria-hidden", "true");
    sessionHeading.setAttribute("aria-label", `Herdr ${session.name}, ${node.status}`);
    sessionHeading.title = node.status;
    sessionHeading.append(
      statusDot,
      createElement("strong", { text: session.name }),
      createElement("small", { text: node.status }),
    );
    sessionGroup.append(sessionHeading);
    const sessionBody = createElement("div", { className: "herdr-session-body" });
    if (node.workspaces.length === 0) {
      sessionBody.append(createElement("p", {
        className: "herdr-session-empty",
        text: node.emptyText,
      }));
    } else {
      for (const workspaceNode of node.workspaces) appendWorkspace(sessionBody, workspaceNode);
    }
    sessionGroup.append(sessionBody);
    attachGroupCollapse(
      sessionGroup,
      sessionHeading,
      sessionBody,
      `session:${node.id}`,
      displayRecordLabel(session, "Herdr session"),
    );
    parent.append(sessionGroup);
  };

  // Projects (or their sessions) belong to a machine, so they go inside that
  // machine's body. Appending them to the list itself would leave them as
  // siblings of the machine heading, which then collapses over nothing.
  const draw = (parent, node) => (node.kind === "session" ? appendSession : appendWorkspace)(parent, node);
  for (const node of tree.servers) {
    for (const child of node.children) draw(serverBodies.get(node.id), child);
  }
  if (tree.empty) {
    elements.workspaceList.append(createElement("p", {
      className: "empty-state",
      text: "No open projects.",
    }));
    return;
  }
  for (const child of tree.children) draw(elements.workspaceList, child);
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
  {
    rename(moves) {
      if (!viewSplit.tree) return;
      viewSplit.focus = followMovedPane(viewSplit.focus, moves);
      setViewSplit(renameTiles(viewSplit.tree, moves));
    },
  },
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
  return selectedRecordsFor(state.selectedPaneId);
}

// The pane `paneId`, its tab and its project.
function selectedRecordsFor(paneId) {
  const { workspaces, tabs, panes } = snapshotRecords();
  const pane = panes.find((item) => idOf(item, "pane_id", "id") === paneId);
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

// ?pane= names the pane a link or notification opened; once it is used up (or
// given up on), a reload must not open it again. `onlyIf` drops it only when
// it still names that pane.
function dropPaneFromAddress(onlyIf = null) {
  const currentUrl = new URL(window.location.href);
  if (onlyIf !== null && currentUrl.searchParams.get("pane") !== onlyIf) return;
  currentUrl.searchParams.delete("pane");
  window.history.replaceState(null, "", currentUrl);
}

// What to select is decided by paneSelectionAfterSnapshot (ui-model.js); this
// carries it out.
function choosePane() {
  const { herdrSessions, panes, servers } = snapshotRecords();
  const before = state.selectedPaneId;
  const plan = paneSelectionAfterSnapshot({
    panes,
    servers,
    herdrSessions,
    selectedPaneId: state.selectedPaneId,
    preferredPaneId: state.preferredPaneId,
    pendingPaneId: notificationNavigation.pendingPaneId,
    pendingSince: notificationNavigation.pendingSince,
    openedAt: pageOpenedAt,
    now: Date.now(),
    waitLimitMs: PENDING_REMOTE_PANE_MS,
  });
  if (plan.selectedPaneId !== before) resetInputHistoryNavigation();
  state.selectedPaneId = plan.selectedPaneId;
  state.preferredPaneId = plan.preferredPaneId;
  notificationNavigation.pendingPaneId = plan.pendingPaneId;
  if (plan.remember) writePanePreference(panePreferenceStorage, plan.remember);
  if (plan.adopted) {
    dropPaneFromAddress();
    closeMobileSidebar();
  }
  if (plan.giveUp) dropPaneFromAddress(plan.giveUp);
  // A pane being waited for, or kept while its server returns, leaves the
  // composer as it is unless a notification's pane has just taken its place.
  if (plan.adopted || !plan.stop) syncComposerDraft();
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

// Settles when the snapshot on its way (if any) has arrived or failed.
let snapshotSettled = Promise.resolve();

async function refreshSnapshot() {
  if (!state.authenticated) return;
  if (state.snapshotBusy || state.mutationBusy || document.hidden) return;
  state.snapshotBusy = true;
  let settle;
  snapshotSettled = new Promise((resolve) => { settle = resolve; });
  const previousPaneId = state.selectedPaneId;
  const previousStatus = selectedAgentStatus();
  try {
    await restoreNotificationTarget();
    const statusAtRequest = liveStatusSequence;
    // when this snapshot was asked for: it shows the panes as they were then, or later
    const requestedAt = Date.now();
    const payload = await api("/api/snapshot");
    const held = snapshotRecords();
    const seen = seenCompletions({ panes: held.panes, agents: held.agents, acknowledged: state.acknowledgedCompletions });
    state.snapshot = payload.snapshot || {};
    // when the snapshot last arrived was asked for (one that failed or was skipped leaves it)
    state.snapshotAt = requestedAt;
    const records = snapshotRecords();
    const paneIds = records.panes.map(pane => idOf(pane, "pane_id", "id"));
    // What each status event received meanwhile does is reconcileLiveStatus's (ui-model.js):
    // a slow HTTP response must not undo a newer event.
    const reconciled = reconcileLiveStatus({
      pending: liveStatusUpdates, requestedAfter: statusAtRequest, panes: records.panes, agents: records.agents, seen,
    });
    for (const paneId of reconciled.drop) liveStatusUpdates.delete(paneId);
    for (const event of reconciled.apply) applyLiveStatus(event);
    for (const [paneId, identity] of reconciled.acknowledge) state.acknowledgedCompletions.set(paneId, identity);
    terminalStream.watchStatuses(paneIds);
    pruneViewSplit(paneIds);
    choosePane();
    pruneAcknowledgedCompletions();
    if (state.selectedPaneId) acknowledgePaneCompletion(state.selectedPaneId);
    syncCreateProjectAvailability();
    if (!renameIsOpen()) renderNavigation();
    const selected = selectedRecords();
    renderPaneHeading(selected.pane, selected.tab, selected.workspace);
    const gridBefore = shownPaneView;
    if (renderPaneViews() !== gridBefore) void refreshTerminal();
    setConnection("online", "Connected");
    const polling = outputPollingDecision({
      baseIntervalMs: state.pollIntervalMs,
      previousStatus,
      currentStatus: selectedAgentStatus(),
    });
    if (previousPaneId !== state.selectedPaneId || polling.refreshNow || notificationNavigation.relayTarget) {
      void refreshTerminal();
    }
  } catch (error) {
    setConnection("error", error.message);
  } finally {
    state.snapshotBusy = false;
    settle();
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
  // A split tab shown as a grid: each cell attaches its own pane, and the
  // single terminal lets its pane go, so a hidden screen never sizes it.
  if (renderPaneViews()) {
    state.lastOutputRequestAt = Date.now();
    attachedTerminal.show(null);
    terminalStream.unwatch();
    // The page may open on a view split (a reload): the composer, the keys and
    // the statuses still go through the page's own socket.
    terminalStream.hold();
    // The selected pane is in its cell: a notification for it is done once
    // that cell is on screen (another pane's zoom hides it until undone).
    state.renderedPaneId = paneId;
    state.renderedGrid = true;
    state.mirrored = null;
    // The strip describes the single terminal, which is not on screen, and
    // the terminal find works on it alone.
    renderTerminalStatus();
    if (terminalFind) syncTerminalFind();
    void completeNotificationRelay();
    return;
  }
  // Back from the grid, the single terminal has yet to show the pane (or, the
  // pane gone, says so below).
  if (state.renderedGrid) {
    state.renderedGrid = false;
    if (paneId) state.renderedPaneId = null;
  }
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

async function sendKeys(keys, paneId = state.selectedPaneId, { stop = false } = {}) {
  if (!paneId) throw new Error("Select a pane first.");
  await terminalStream.send(stop ? { paneId, keys, stop: true } : { paneId, keys });
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
    attachTracker.failed(paneId, problem);
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

// --- Split tabs: the grid (wide screens) and the pane map (phones) ---------

const GRID_ICON = ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"];

function paneTabId(paneId) {
  const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
  return idOf(pane, "tab_id", "tabId");
}

function panesOfTab(tabId) {
  return snapshotRecords().panes.filter((pane) => idOf(pane, "tab_id", "tabId") === tabId);
}

// Only this machine's panes are split, closed, zoomed or laid out from here:
// a connected PC's split tab opens one pane at a time, with no grid or map.
function isLocalRecord(record) {
  return (record?.server_id || "local") === "local";
}

// The selected pane's tab when it has more than one pane, on this machine, else null.
function selectedSplitTabId() {
  const tabId = paneTabId(state.selectedPaneId);
  const tabPanes = tabId ? panesOfTab(tabId) : [];
  return tabPanes.length > 1 && isLocalRecord(tabPanes[0]) ? tabId : null;
}

// The tab drawn as a grid now: a split tab chosen as one, on a wide screen.
function gridTabId() {
  const tabId = selectedSplitTabId();
  return tabId && desktopMedia.matches && state.paneViews.get(tabId) === "grid" ? tabId : null;
}

// What a cell or a map box says of each pane of `tabId`.
function splitTabPanes(tabId) {
  return panesOfTab(tabId).map((pane) => {
    const paneId = idOf(pane, "pane_id", "id");
    const agent = agentForPane(paneId);
    const status = visibleStatusForPane(paneId, agent, pane);
    return {
      paneId,
      label: paneDisplayTitle("", pane, "Terminal", agent),
      status,
      statusIcon: agentStatusIcon(status),
      statusText: agentStatusLabel(status),
    };
  });
}

// Herdr's layout of the split tab on screen, read again when its panes change
// or it is a few seconds old (a zoom or a split made in Herdr itself). It is
// undefined until first read, and null when it could not be read (a connected
// PC's tab is refused). Each read has its own number, and `latest` holds the
// newest read of each key: an older read of the same tab answering late (asked
// before the user went to another tab and back) is dropped, and so is every
// read begun before forgetPaneLayout (a split, a zoom), which may show the tab
// as it was. `loadingKey` is the read in flight: one for another tab does not
// hold up this tab's read, and its answer, should the tab no longer be
// selected, is dropped.
const PANE_LAYOUT_MAX_AGE_MS = 3_000;
const paneLayout = { key: "", tabId: null, layout: undefined, at: 0, loadingKey: null, reads: 0, latest: new Map() };

function paneLayoutFor(tabId) {
  const paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"));
  const key = `${tabId}|${paneIds.join(",")}`;
  if (paneLayout.loadingKey !== key && (paneLayout.key !== key || Date.now() - paneLayout.at > PANE_LAYOUT_MAX_AGE_MS)) {
    paneLayout.loadingKey = key;
    const read = ++paneLayout.reads;
    paneLayout.latest.set(key, read);
    paneCalls.layout(paneIds[0])
      .then((payload) => payload?.layout ?? null, () => null)
      .then((layout) => {
        if (paneLayout.latest.get(key) !== read) return;
        paneLayout.latest.delete(key);
        if (paneLayout.loadingKey === key) paneLayout.loadingKey = null;
        // The tab on screen is another now: draw it, which reads its layout.
        if (selectedSplitTabId() !== tabId) {
          if (state.authenticated) renderPaneViews();
          return;
        }
        const before = JSON.stringify(paneLayout.tabId === tabId ? paneLayout.layout ?? null : undefined);
        // A failed read keeps what was known of the same tab.
        const known = layout ?? (paneLayout.tabId === tabId ? paneLayout.layout ?? null : null);
        Object.assign(paneLayout, { key, tabId, layout: known, at: Date.now() });
        if (JSON.stringify(known) !== before) renderPaneViews();
      });
  }
  return paneLayout.tabId === tabId ? paneLayout.layout : undefined;
}

function forgetPaneLayout() {
  paneLayout.latest.clear();
  paneLayout.loadingKey = null;
  paneLayout.at = 0;
  paneLayout.key = "";
}

const paneGrid = createPaneGrid({
  host: elements.terminalStage,
  xterm,
  credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
  fontSize: state.terminalFontSize,
  fit: readGridFit(panePreferenceStorage),
  manualFont: readGridFont(panePreferenceStorage),
  onFontChange: (font) => {
    writeGridFont(panePreferenceStorage, font);
    syncSettingsMenu();
  },
  menuFor: paneGridMenu,
  onSelect: (paneId) => selectPane(paneId, { fromGrid: true }),
  onExpand: (paneId) => {
    selectPane(paneId, { view: "solo" });
    focusComposer();
  },
  onUnzoom: (paneId) => void paneGridAction(paneId, "zoom", { mode: "toggle" }),
  onRearrange: (drop) => void rearrangeGridPanes(drop),
  canRearrange: () => !state.mutationBusy,
  onAuthenticationRequired: () => showLogin(),
  terminalOptions: {
    // A pinch on a cell that sizes its pane sets the terminal font, as on a pane alone.
    onFontSizeChange: applyTerminalFontSize,
    isLinkablePath: isLinkableTerminalPath,
    onPath: openTerminalPath,
    onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
  },
});

// --- This window's own view split (view-split.js) --------------------------
// Panes of other projects side by side, for this browser window alone: Herdr
// is never asked to move or close anything, other devices never see it.

// The tiles: the Herdr grid's cells in view mode, each its own socket at the
// pane's own size. ⤢ opens a tile's pane alone (with Back to split view), ✕
// takes the tile out of the view and leaves the pane as it is.
const viewGrid = createPaneGrid({
  host: elements.terminalStage,
  xterm,
  credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
  fontSize: state.terminalFontSize,
  mode: "view",
  menuFor: viewTileMenu,
  onSelect: (paneId) => selectPane(paneId, { fromGrid: true }),
  onExpand: (paneId) => {
    selectPane(paneId, { view: "solo" });
    focusComposer();
  },
  onRearrange: (drop) => rearrangeViewTiles(drop),
  onAuthenticationRequired: () => showLogin(),
  terminalOptions: {
    isLinkablePath: isLinkableTerminalPath,
    onPath: openTerminalPath,
    onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
  },
});

// A tile dragged onto another: the two trade places (its middle) or it goes
// next to that tile on a side. This window's layout alone: Herdr hears
// nothing. The dragged tile stays selected and keeps the typing.
function rearrangeViewTiles({ paneId, targetPaneId, kind, side }) {
  const next = kind === "swap" ? swapTiles(viewSplit.tree, paneId, targetPaneId)
    : moveTile(viewSplit.tree, paneId, targetPaneId, side);
  if (!next || next === viewSplit.tree) return;
  viewSplit.focus = paneId;
  setViewSplit(next, true);
  if (state.selectedPaneId !== paneId) selectPane(paneId, { view: "tiles" });
  else renderPaneViews();
  viewGrid.focus(paneId);
}

// The grid on screen, the Herdr tab's or the view split's, or null.
function shownGrid() {
  return viewGrid.shown ? viewGrid : paneGrid.shown ? paneGrid : null;
}

// Keeps `tree` (null: no view split) and whether it is on screen, here and in
// this window's session storage.
function setViewSplit(tree, shown = viewSplit.shown) {
  viewSplit.tree = tree;
  viewSplit.shown = Boolean(tree) && shown;
  const ids = viewTiles(tree);
  if (!ids.includes(viewSplit.focus)) viewSplit.focus = ids[0] ?? null;
  writeViewSplit(viewSplitStorage, viewSplit);
}

// Whether the view split is on screen now: it is, it was not left for a pane
// alone, the selected pane is one of its tiles, and the screen is wide.
function viewSplitOnScreen() {
  return viewSplit.shown && desktopMedia.matches && viewTiles(viewSplit.tree).includes(state.selectedPaneId);
}

// What each tile says of its pane: as a grid cell, with its project.
function viewTilePanes() {
  const { panes } = snapshotRecords();
  return viewTiles(viewSplit.tree).flatMap((paneId) => {
    const pane = panes.find((item) => idOf(item, "pane_id", "id") === paneId);
    if (!pane) return [];
    const agent = agentForPane(paneId);
    const status = visibleStatusForPane(paneId, agent, pane);
    const records = selectedRecordsFor(paneId);
    return [{
      paneId,
      label: paneDisplayTitle(displayTabLabel(records.tab), pane, "Terminal", agent),
      context: displayRecordLabel(records.workspace, "Project"),
      status,
      statusIcon: agentStatusIcon(status),
      statusText: agentStatusLabel(status),
    }];
  });
}

const REMOVE_TILE_ICON = "M6 6l12 12M18 6 6 18";

// A tile's one action besides ⤢: ✕ takes it out of the view. Nothing in Herdr
// is touched (no split, zoom or close here).
function viewTileMenu(pane) {
  const button = createElement("button", { className: "pane-grid-remove" });
  button.type = "button";
  button.setAttribute("aria-label", `Remove ${pane.label} from view`);
  button.title = "Remove from view";
  button.append(createIcon([REMOVE_TILE_ICON]));
  button.addEventListener("click", () => removeViewTile(pane.paneId));
  return button;
}

// ✕ on a tile. With one tile left, the view split is over and that pane shows alone.
function removeViewTile(paneId) {
  const before = viewTiles(viewSplit.tree);
  const next = removeTile(viewSplit.tree, paneId);
  if (!next) {
    const remaining = before.find((id) => id !== paneId) ?? state.selectedPaneId;
    closeViewSplit(remaining);
    return;
  }
  setViewSplit(next, true);
  if (state.selectedPaneId === paneId || !viewTiles(next).includes(state.selectedPaneId)) {
    selectPane(viewSplit.focus, { view: "tiles" });
  } else renderPaneViews();
}

// Ends the view split; `paneId` (else the selected pane) shows alone.
function closeViewSplit(paneId = state.selectedPaneId) {
  setViewSplit(null, false);
  if (paneId) selectPane(paneId, { view: "solo" });
  else renderPaneViews();
}

// A session dropped on the pane alone or on a tile becomes a tile beside it,
// on the side it was dropped, and is selected there. On the pane alone a view
// split this window still keeps is carried on when that pane is one of its
// tiles; otherwise the two make a new one.
function addViewTile({ tabId, targetPaneId, side }) {
  const pane = panesOfTab(tabId)[0];
  const paneId = idOf(pane, "pane_id", "id");
  if (!paneId) return;
  const base = viewTiles(viewSplit.tree).includes(targetPaneId) ? viewSplit.tree : null;
  const next = addTile(base, targetPaneId, paneId, side);
  if (!next || next === base) {
    setFeedback(viewTiles(base).length >= 6 ? "A split view shows at most 6 panes." : "This pane is in the split view already.", true);
    if (base) selectPane(targetPaneId, { view: "tiles" });
    return;
  }
  setViewSplit(next, true);
  viewSplit.focus = paneId;
  selectPane(paneId, { view: "tiles" });
}

// Tiles whose panes are gone leave the view; with fewer than two left it is
// over. The selected pane, gone with its tile, gives way to another tile.
function pruneViewSplit(paneIds) {
  if (!viewSplit.tree || paneIds.length === 0) return;
  const before = viewTiles(viewSplit.tree);
  const next = pruneViewTiles(viewSplit.tree, paneIds);
  const after = viewTiles(next);
  if (after.length === before.length) return;
  const selectedGone = before.includes(state.selectedPaneId) && !paneIds.includes(state.selectedPaneId);
  const survivor = before.find((id) => paneIds.includes(id)) ?? null;
  setViewSplit(next);
  if (selectedGone && survivor) {
    state.selectedPaneId = next ? viewSplit.focus : survivor;
    syncComposerDraft();
  }
}

elements.viewBack.addEventListener("click", () => {
  if (!viewSplit.tree) return;
  selectPane(viewSplit.focus ?? viewTiles(viewSplit.tree)[0], { view: "tiles" });
});
elements.viewClose.addEventListener("click", () => closeViewSplit());

// Which screen a session dropped from the sidebar lands on.
function paneDropScreen() {
  return viewGrid.shown ? "tiles" : paneGrid.shown ? "grid" : "solo";
}

function paneDropKindFor(tabId, targetPaneId, screen = paneDropScreen()) {
  return paneDropKind(state.snapshot, { tabId, targetPaneId }, {
    screen,
    tileIds: viewTiles(viewSplit.tree),
    paneMoveAllowed: () => Boolean(paneMoveRequest(state.snapshot, { tabId, targetPaneId, side: "right" })),
  });
}

// A session dropped on a pane's edge: Herdr's own merge for a session of the
// pane's project, this window's view split for another project's (or any on
// a view split).
function dropOnPane(drop) {
  const kind = paneDropKindFor(drop.tabId, drop.targetPaneId);
  if (kind === "move") void movePaneIntoSplit(paneMoveRequest(state.snapshot, drop));
  else if (kind === "view") addViewTile(drop);
}

// The split tab whose grid is on screen, what renderPaneViews last answered,
// and what the phone's map last drew.
let shownGridTabId = null;
let shownPaneView = null;
let paneMapKey = "";

// Draws the grid (a Herdr tab's or this window's view split), the map and
// the Back to grid and Back to split view controls for the selected pane, and
// answers what is shown as a grid: the tab's id, "view" for the view split,
// null for one pane alone.
function renderPaneViews() {
  const tilesShown = viewSplitOnScreen();
  const splitTabId = tilesShown ? null : selectedSplitTabId();
  const gridTab = tilesShown ? null : gridTabId();
  const showMap = Boolean(splitTabId) && !desktopMedia.matches;
  // Read only for a grid or a map on screen: a pane shown alone needs none.
  const layout = gridTab || showMap ? paneLayoutFor(splitTabId) : undefined;
  const panes = splitTabId ? splitTabPanes(splitTabId) : [];
  elements.paneMap.hidden = !showMap;
  if (showMap) {
    const key = JSON.stringify([state.selectedPaneId, layout, panes]);
    if (key !== paneMapKey) {
      paneMapKey = key;
      renderPaneMap(elements.paneMap, {
        layout,
        panes,
        selectedPaneId: state.selectedPaneId,
        onPick: (paneId) => selectPane(paneId),
      });
    }
  } else paneMapKey = "";
  // The find bar lies over the terminal's top corner: below the map, not on it.
  elements.terminalStage.style.setProperty("--pane-map-clearance", showMap ? `${elements.paneMap.offsetHeight + 8}px` : "0px");
  elements.gridBack.hidden = !(splitTabId && desktopMedia.matches && !gridTab);
  elements.viewBack.hidden = !(viewSplit.tree && desktopMedia.matches && !tilesShown);
  elements.viewClose.hidden = !tilesShown;
  elements.terminalPanel.classList.toggle("is-grid", Boolean(gridTab) || tilesShown);
  if (gridTab) paneGrid.show({ panes, layout, selectedPaneId: state.selectedPaneId });
  else if (paneGrid.shown) paneGrid.hide();
  if (tilesShown) {
    if (viewSplit.focus !== state.selectedPaneId) {
      viewSplit.focus = state.selectedPaneId;
      writeViewSplit(viewSplitStorage, viewSplit);
    }
    viewGrid.show({ panes: viewTilePanes(), layout: layoutRects(viewSplit.tree), selectedPaneId: state.selectedPaneId });
  } else if (viewGrid.shown) viewGrid.hide();
  shownGridTabId = gridTab;
  // A notification left waiting on a zoomed-out cell is done once a layout
  // read shows that cell.
  if ((gridTab || tilesShown) && state.renderedGrid && notificationNavigation.relayTarget) void completeNotificationRelay();
  shownPaneView = gridTab ?? (tilesShown ? "view" : null);
  return shownPaneView;
}

// Makes `paneId` the selected pane: the sidebar, the heading, the composer and
// the key bar all follow it. `view` ("grid" or "solo") is how its tab shows,
// or "tiles" for this window's view split, which "grid" and "solo" leave (it
// stays kept, with Back to split view); left out, the tab keeps its view.
// From a grid cell or a tile nothing is redrawn but the focus ring, so the
// cell keeps the typing.
function selectPane(paneId, { view = null, fromGrid = false } = {}) {
  const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
  if (!pane) return;
  const changed = state.selectedPaneId !== paneId;
  if (changed) resetInputHistoryNavigation();
  state.selectedPaneId = paneId;
  syncComposerDraft();
  state.preferredPaneId = paneId;
  writePanePreference(panePreferenceStorage, paneId);
  acknowledgePaneCompletion(paneId);
  setFeedback("");
  const tabId = idOf(pane, "tab_id", "tabId");
  if (tabId) state.lastPaneOfTab.set(tabId, paneId);
  if (view === "grid") state.paneViews.set(tabId, "grid");
  else if (view === "solo") state.paneViews.delete(tabId);
  if (viewSplit.tree && view) setViewSplit(viewSplit.tree, view === "tiles");
  renderNavigation();
  const selected = selectedRecords();
  renderPaneHeading(selected.pane, selected.tab, selected.workspace);
  if (fromGrid) {
    shownGrid()?.focus(paneId, { terminal: false });
    void refreshTerminal();
    return;
  }
  const leavingGrid = shownGridTabId || viewGrid.shown;
  if (!gridTabId() && !viewSplitOnScreen() && (changed || leavingGrid)) showTerminalMessage("Loading output…");
  void refreshTerminal();
}

// The pane a split tab opens on, and whose title and mark its row wears: the
// selected pane when it is there, else the one last selected there, else the
// one Herdr has focused, else its first.
function splitTabFocusPaneId(tabId, paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"))) {
  const candidates = [state.selectedPaneId, state.lastPaneOfTab.get(tabId), state.snapshot?.focused_pane_id];
  return candidates.find((paneId) => paneId && paneIds.includes(paneId)) ?? paneIds[0] ?? null;
}

// Opens a split tab as a grid, on its focus pane (see splitTabFocusPaneId).
function openPaneGrid(tabId) {
  const paneId = splitTabFocusPaneId(tabId);
  if (!paneId) return;
  selectPane(paneId, { view: "grid" });
  closeMobileSidebar();
}

// A split session's row: the grid on a wide screen; on a phone, which has no
// grid, its focus pane alone with the pane map over it. A connected PC's
// split tab has no grid here, so it opens that pane alone too.
function openSplitSession(tabId) {
  const tabPanes = panesOfTab(tabId);
  if (tabPanes.length === 0) return;
  if (desktopMedia.matches && isLocalRecord(tabPanes[0])) {
    openPaneGrid(tabId);
    return;
  }
  const paneId = splitTabFocusPaneId(tabId);
  selectPane(paneId, { view: "solo" });
  closeMobileSidebar();
}

elements.gridBack.addEventListener("click", () => {
  const tabId = selectedSplitTabId();
  if (tabId) openPaneGrid(tabId);
});

// A split session's name: its tab's, else its focus pane's title, else "Split session".
function splitSessionName(tabId, tabLabel, tabPanes) {
  if (tabLabel) return tabLabel;
  const paneId = splitTabFocusPaneId(tabId, tabPanes.map((pane) => idOf(pane, "pane_id", "id")));
  const pane = tabPanes.find((item) => idOf(item, "pane_id", "id") === paneId);
  return paneDisplayTitle("", pane, "", agentForPane(paneId)) || "Split session";
}

// A split session is one row in the sidebar, as a one-pane session is: its
// focus pane's mark, its name, the number of panes, and the most urgent status
// of them. It is shown selected while any of its panes is.
function splitSessionButton(tabId, name, tabPanes, workspace) {
  const paneIds = tabPanes.map((pane) => idOf(pane, "pane_id", "id"));
  const focusPaneId = splitTabFocusPaneId(tabId, paneIds);
  const focusPane = tabPanes.find((pane) => idOf(pane, "pane_id", "id") === focusPaneId);
  const status = mostUrgentStatus(tabPanes.map((pane) => {
    const paneId = idOf(pane, "pane_id", "id");
    return visibleStatusForPane(paneId, agentForPane(paneId), pane);
  }));
  const statusText = agentStatusLabel(status);
  const button = createElement("button", { className: "pane-button split-session-button" });
  button.type = "button";
  button.dataset.tabId = tabId;
  button.dataset.status = status;
  button.setAttribute("aria-pressed", String(paneIds.includes(state.selectedPaneId)));
  const where = displayRecordLabel(workspace, "Project");
  button.setAttribute(
    "aria-label",
    `${name}, split session, ${paneIds.length} panes, ${statusText}, ${where}`,
  );
  button.title = `${name} · ${paneIds.length} panes · ${statusText}`;
  // Its mark column holds the arrow (laid over it, see splitDisclosureButton):
  // the focus pane's mark is drawn only in the folded sidebar's rail, which
  // has no arrow.
  button.append(agentMark(paneAgentKind(focusPane, agentForPane(focusPaneId))));
  const copy = createElement("span", { className: "pane-copy" });
  copy.append(createElement("strong", { className: "pane-title", text: name }));
  const subtitle = paneSubtitle(name, focusPane);
  if (subtitle) copy.append(createElement("small", { className: "pane-cwd", text: subtitle }));
  const badge = createElement("span", { className: "split-badge" });
  badge.setAttribute("aria-hidden", "true");
  badge.append(createIcon(GRID_ICON), createElement("span", { text: String(paneIds.length) }));
  const statusMark = createElement("span", {
    className: `pane-status ui-status state-${status}`,
    text: agentStatusIcon(status),
  });
  statusMark.setAttribute("aria-hidden", "true");
  button.append(copy, badge, statusMark);
  button.addEventListener("click", () => openSplitSession(tabId));
  return button;
}

// The arrow at the start of a split session's row, in the column the other
// rows' program marks sit in: shows or hides its panes under it. Folded until
// opened; which are open is kept in this browser. A pane selected in a folded
// session does not open it: the row shows it selected.
function splitDisclosureButton(tabGroup, tabId, name, paneList) {
  const expanded = state.expandedSplitTabIds.has(tabId);
  const labelFor = (open) => `${open ? "Hide" : "Show"} the panes of ${name}`;
  const button = workspaceActionButton({
    className: "split-disclosure",
    label: labelFor(expanded),
    paths: ["M9 18l6-6-6-6"],
  });
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-controls", paneList.id);
  button.addEventListener("click", () => {
    const open = !state.expandedSplitTabIds.has(tabId);
    if (open) state.expandedSplitTabIds.add(tabId);
    else state.expandedSplitTabIds.delete(tabId);
    tabGroup.classList.toggle("is-expanded", open);
    paneList.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", labelFor(open));
    button.title = labelFor(open);
    writeExpandedSplitTabIds(panePreferenceStorage, state.expandedSplitTabIds);
  });
  return button;
}

const SPLIT_RIGHT_ICON = ["M4 5h16v14H4z", "M12 5v14"];
const SPLIT_DOWN_ICON = ["M4 5h16v14H4z", "M4 12h16"];
const ZOOM_ICON = ["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"];
const UNZOOM_ICON = ["M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"];
const MOVE_OUT_ICON = ["M14 4h6v6", "M20 4l-8 8", "M19 14v5H5V5h5"];
const SEPARATE_ICON = ["M3 5h7v14H3z", "M14 5h7v14h-7z"];
const EVEN_ICON = ["M3 5h18v14H3z", "M9 5v14", "M15 5v14"];

// A pane's actions, the same in a grid cell's ⋯ and a split session's pane
// row in the sidebar.
function paneActions(paneId, zoomed) {
  return [
    { key: "split-right", label: "Split right", paths: SPLIT_RIGHT_ICON,
      onSelect: () => void paneGridAction(paneId, "split", { direction: "right" }) },
    { key: "split-down", label: "Split down", paths: SPLIT_DOWN_ICON,
      onSelect: () => void paneGridAction(paneId, "split", { direction: "down" }) },
    { key: "zoom", label: zoomed ? "Unzoom" : "Zoom", paths: zoomed ? UNZOOM_ICON : ZOOM_ICON,
      onSelect: () => void paneGridAction(paneId, "zoom", { mode: "toggle" }) },
    { key: "even-layout", label: "Even out layout", paths: EVEN_ICON,
      onSelect: () => void evenOutLayout(paneId) },
    { key: "move-out", label: "Move out to its own session", paths: MOVE_OUT_ICON,
      onSelect: () => void movePanesOut([paneId]) },
    { separator: true },
    { key: "close", label: "Close pane", paths: ["M6 6l12 12M18 6 6 18"], danger: true,
      onSelect: () => void closePaneFromGrid(paneId) },
  ];
}

function paneGridMenu(pane, zoomed) {
  return sidebarActionMenu({
    id: `grid-${pane.paneId}`,
    label: `More actions for ${pane.label}`,
    className: "pane-grid-menu",
    escapesOverflow: true,
    actions: paneActions(pane.paneId, zoomed),
  });
}

// A pane of a split session in the sidebar's list: its row, and on this
// machine a ⋯ with the grid cell's actions, laid over the row's right padding
// as every session row's is. Zoom reads Unzoom when the layout last read of
// its tab (the tab on screen) says it is zoomed.
function splitPaneRow(pane, tab, workspace, local) {
  const row = createElement("div", { className: "split-pane-row" });
  const button = paneButton(pane, tab, workspace);
  row.append(button);
  if (!local) return row;
  const paneId = button.dataset.paneId;
  const tabId = idOf(pane, "tab_id", "tabId");
  const layout = paneLayout.tabId === tabId ? paneLayout.layout : null;
  const zoomed = Boolean(layout?.zoomed);
  row.append(sidebarActionMenu({
    id: `split-pane-${paneId}`,
    label: `More actions for ${paneDisplayTitle("", pane, "Terminal", agentForPane(paneId))}`,
    className: "session-action-menu split-pane-menu",
    actions: paneActions(paneId, zoomed),
  }));
  return row;
}

// Takes panes out of their split session, one after another, each into a
// session of its own in the same project. A pane Herdr renames is followed
// (what the page keeps under its id, and the selection). A session left with
// one pane shows it alone again. The first refusal stops the rest and is said
// in the feedback line; the sidebar is read once at the end.
async function movePanesOut(paneIds) {
  if (paneIds.length === 0) return;
  if (state.mutationBusy) {
    setFeedback("Another change is still in progress. Try again in a moment.", true);
    return;
  }
  const fromTabId = paneTabId(paneIds[0]);
  let left = panesOfTab(fromTabId).length;
  state.mutationBusy = true;
  setFeedback("");
  let refusal = "";
  try {
    for (const paneId of paneIds) {
      try {
        const result = await paneCalls.moveOut(paneId);
        left -= 1;
        const movedTo = typeof result?.pane_id === "string" ? result.pane_id : paneId;
        if (movedTo !== paneId) {
          followMovedPaneState([{ from: paneId, to: movedTo }]);
          if (state.selectedPaneId === paneId) {
            state.selectedPaneId = movedTo;
            state.preferredPaneId = movedTo;
            writePanePreference(panePreferenceStorage, movedTo);
          }
        }
      } catch (error) {
        refusal = error.message;
        break;
      }
    }
  } finally {
    state.mutationBusy = false;
  }
  if (fromTabId && left <= 1) state.paneViews.delete(fromTabId);
  await refreshAfterPaneChange();
  void refreshTerminal();
  if (refusal) setFeedback(refusal, true);
}

// "Even out layout": the panes of `paneId`'s split session take equal shares
// of it. Herdr resizes them, so every device sees it; the grid re-reads the
// layout and its cells slide to their new places. Said in the feedback line:
// evened out, or why not (Herdr's reason, or a layout it could only partly
// even out or had to put back).
async function evenOutLayout(paneId) {
  if (state.mutationBusy) {
    setFeedback("Another change is still in progress. Try again in a moment.", true);
    return;
  }
  state.mutationBusy = true;
  setFeedback("");
  let notice;
  let failed = false;
  try {
    const result = await paneCalls.evenLayout(paneId);
    if (result?.even === false) {
      notice = result.message || "Could not even out the layout.";
      failed = true;
    } else notice = result?.changed === false ? "The panes are already even." : "Layout evened out.";
  } catch (error) {
    notice = error.message;
    failed = true;
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  void refreshTerminal();
  setFeedback(notice, failed);
}

// The split session's ⋯ "Separate all panes": every pane but the first to a
// session of its own, once the user says so.
function separateSplitSession(tabId, name) {
  const paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"));
  if (paneIds.length < 2) return;
  const count = paneIds.length;
  if (!window.confirm(`Separate the ${count} panes of “${name}” into ${count} sessions? Each pane keeps running; only the split is undone.`)) return;
  void movePanesOut(paneIds.slice(1));
}

function closePaneFromGrid(paneId) {
  const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
  if (!pane) return;
  const status = agentStatus(agentForPane(paneId), pane);
  const last = panesOfTab(idOf(pane, "tab_id", "tabId")).length <= 1;
  const label = paneDisplayTitle("", pane, "Terminal", agentForPane(paneId));
  const reason = last ? " It is the session's last pane, so the session closes too."
    : status === "working" ? " Its agent is still working."
    : status === "blocked" ? " Its agent is waiting for your answer." : "";
  if ((last || status === "working" || status === "blocked") &&
      !window.confirm(`Close pane “${label}”?${reason} This stops any running processes in it.`)) return;
  // The server closes a pane only when told the user meant it.
  void paneGridAction(paneId, "close", { confirmed: true });
}

// Runs a pane action from the grid (split, zoom, close) and shows the result:
// a split selects the new pane; a refusal (no room for another pane) is said
// in the feedback line.
async function paneGridAction(paneId, action, body = {}) {
  if (state.mutationBusy) {
    setFeedback("Another change is still in progress. Try again in a moment.", true);
    return;
  }
  state.mutationBusy = true;
  setFeedback("");
  let result = null;
  // Closing the selected pane leaves the selection on a neighbour in its tab,
  // not on whatever pane the page would fall back to.
  const siblings = panesOfTab(paneTabId(paneId)).map((pane) => idOf(pane, "pane_id", "id"));
  const at = siblings.indexOf(paneId);
  const neighbour = siblings[at + 1] ?? siblings[at - 1] ?? null;
  try {
    result = await paneCalls.act(paneId, action, body);
    if (action === "close" && state.selectedPaneId === paneId && neighbour) {
      state.selectedPaneId = neighbour;
      state.preferredPaneId = neighbour;
      writePanePreference(panePreferenceStorage, neighbour);
      syncComposerDraft();
    }
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  const added = typeof result?.pane_id === "string" ? result.pane_id : null;
  if (action === "split" && added && snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === added)) {
    selectPane(added, { fromGrid: shownGridTabId !== null });
  } else void refreshTerminal();
}

// The panes a session dragged from the sidebar may join now: the grid's cells,
// or the pane shown alone. A phone has neither (its sidebar is a drawer over
// them), and a session that may not join (several panes, another machine or
// Herdr session, the pane itself) gets none.
function paneDropTargets(tabId) {
  if (!desktopMedia.matches || state.mutationBusy) return [];
  const screen = paneDropScreen();
  const targets = screen !== "solo"
    ? [...elements.terminalStage.querySelectorAll(".pane-grid:not([hidden]) .pane-grid-cell:not([hidden])")]
      .map((element) => ({ paneId: element.dataset.paneId, element }))
    : state.selectedPaneId ? [{ paneId: state.selectedPaneId, element: elements.terminalStage }] : [];
  return targets.filter(({ paneId }) => paneDropKindFor(tabId, paneId, screen));
}

// After a pane is split, closed, zoomed or moved: the layout and the snapshot
// are read again. A snapshot already on its way was asked for before the
// change, so it is waited out first.
async function refreshAfterPaneChange() {
  forgetPaneLayout();
  await snapshotSettled;
  await refreshSnapshot();
}

// Moves a session's one pane next to another pane, into that pane's tab. The
// pane comes back under a new id: what the page keeps under its id follows it,
// and it is selected in the grid of the tab it joined. A refusal (Herdr has
// no room there) is said in the feedback line, and so is a pane that moved
// but could not then be swapped to the left or the top (`placed` false).
async function movePaneIntoSplit(request) {
  if (!request || state.mutationBusy) return;
  const targetTabId = paneTabId(request.body.targetPaneId);
  state.mutationBusy = true;
  setFeedback("");
  let movedTo = null;
  let unplaced = null;
  try {
    const result = await paneCalls.move(request.paneId, request.body);
    movedTo = typeof result?.pane_id === "string" ? result.pane_id : null;
    if (movedTo && movedTo !== request.paneId) {
      followMovedPaneState([{ from: request.paneId, to: movedTo }]);
      if (state.selectedPaneId === request.paneId) state.selectedPaneId = movedTo;
    }
    if (movedTo && targetTabId) state.paneViews.set(targetTabId, "grid");
    if (movedTo && result?.placed === false) {
      unplaced = `Moved, but could not put it on the ${request.body.side === "up" ? "top" : "left"}.`;
    }
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  if (movedTo && snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === movedTo)) {
    selectPane(movedTo, { view: "grid" });
  } else void refreshTerminal();
  // After the selection, which clears the feedback line.
  if (unplaced) setFeedback(unplaced, true);
}

// A cell of a Herdr grid dragged onto another of the same tab: the two swap
// places (dropped in its middle), or it moves next to it on a side (Herdr
// lifts it out of the tab and splits it back in there). The pane stays
// selected in the grid; should Herdr answer it under another id, what the
// page keeps under its id follows it. A relocate that could not finish says
// where the pane is now (`placed` false: put back in its session, or in a
// session of its own).
async function rearrangeGridPanes({ paneId, targetPaneId, kind, side }) {
  if (state.mutationBusy || !shownGridTabId || paneTabId(paneId) !== shownGridTabId || paneTabId(targetPaneId) !== shownGridTabId) return;
  const tabId = shownGridTabId;
  state.mutationBusy = true;
  setFeedback("");
  let finalId = paneId;
  let notice = null;
  try {
    const result = kind === "swap"
      ? await paneCalls.swap(paneId, targetPaneId)
      : await paneCalls.relocate(paneId, targetPaneId, side);
    if (typeof result?.pane_id === "string" && result.pane_id !== paneId) {
      finalId = result.pane_id;
      followMovedPaneState([{ from: paneId, to: finalId }]);
      if (state.selectedPaneId === paneId) state.selectedPaneId = finalId;
    }
    if (result?.placed === false) notice = result.message || "Could not move the pane there.";
  } catch (error) {
    notice = error.message;
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  if (snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === finalId)) {
    // Left in a session of its own, it shows there, alone.
    const inGrid = paneTabId(finalId) === tabId;
    selectPane(finalId, inGrid ? { fromGrid: true } : { view: "solo" });
    if (inGrid) paneGrid.focus(finalId);
  } else void refreshTerminal();
  // After the selection, which clears the feedback line.
  if (notice) setFeedback(notice, true);
}

// The strip over the Terminal lens that says why the terminal is not live:
// the socket is down, or the pane on screen could not attach. Quiet during a
// normal connect, gone as soon as the terminal is live again. A held pane has
// its own strip (#terminal-held), and the Chat lens shows neither.
// Where the pane on screen is in attaching, and why each pane last failed to.
const attachTracker = createAttachTracker();
let terminalConnectionState = terminalStream.connectionState;
let terminalStatusTimer = null;
let terminalStatusShown = null;

function noteTerminalAttach(paneId, next) {
  attachTracker.note(paneId, next);
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
  const attach = attachTracker.of(paneId);
  const signedOut = terminalConnectionState.state === "signed-out";
  const { status, recheckAt } = ((state.authenticated && !document.hidden) || signedOut) && !shownGrid()
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
  paneCalls.scrollToBottom(paneId).catch(() => {
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
  onChatDrawn: (chat, drawn) => {
    chatFind?.redrawn(chat, drawn);
    // a question card's context goes once the chat shows that message
    promptDock?.conversationChanged();
  },
  onLensChange: (lens, paneId, previous) => {
    // `previous` follows a pane renamed under it (a move to another workspace)
    if (lens === "terminal" && previous?.lens === "chat" && previous.paneId === paneId) showNewestTerminalOutput(paneId);
    scheduleTerminalPark(lens, paneId);
    // The key bar drives the terminal: the Chat lens hides it, and the
    // terminal fits again once it is back.
    elements.terminalPanel.dataset.lens = lens;
    // the composer's text size goes with the lens
    syncComposerExpanded({ defer: true });
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
  conversation: (paneId) => chatLens.chatFor(paneId)?.agentText ?? "",
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
  search: (paneId, body) => paneCalls.find(paneId, body),
  reveal: (paneId, body) => paneCalls.reveal(paneId, body),
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
    if (!usesTouchInputEnvironment() && chatLens.lens === "terminal" && !state.renderedGrid) attachedTerminal.focus();
  },
  onError: (message) => setFeedback(message, true),
});

// The pane find can work on now, or why not.
// None over a grid: its cells have no find, and the single terminal is not on screen.
function terminalFindTarget() {
  const paneId = !state.renderedGrid && state.selectedPaneId && state.renderedPaneId === state.selectedPaneId
    ? state.selectedPaneId : null;
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
  syncComposerExpanded({ defer: true });
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
  syncComposerExpanded();
  resizeTerminalInput();
  speechStop();
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
      syncComposerExpanded({ fresh: true });
      resizeTerminalInput();
    }
    return;
  }

  const action = inputKeyAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
    keyCode: event.keyCode,
    usesTouchInput: usesTouchInputEnvironment(),
    enterMode: enterKeyMode,
    physicalKeyboard: physicalKeyboardSeen,
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
  syncComposerExpanded({ defer: true });
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

window.addEventListener("resize", () => {
  syncComposerExpanded({ defer: true });
  resizeTerminalInput();
});

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
    // Only Claude Code puts a stopped message back in its box; the server
    // looks for it before the next send only after a Stop marked as Claude's.
    const agent = chatAgent(selectedRecords().pane, agentForPane(paneId));
    const claude = agent === "claude";
    await sendKeys(["esc"], paneId, { stop: claude });
    // OpenCode stops on a second Esc (within 5 seconds), sent apart from the first
    const { presses, gapMs } = stopPresses(agent);
    for (let press = 1; press < presses; press += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, gapMs));
      await sendKeys(["esc"], paneId);
    }
    refreshAfterSubmission();
    const followUp = stopFollowUp(agent);
    if (followUp) void hintIfStillWorking(paneId, followUp);
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    await shortest;
    stoppingPanes.delete(paneId);
    syncSendButton();
  }
}

// A moment after an OpenCode Stop: the pane, still selected and still
// working by a fresh snapshot, gets the hint that its Escs may have gone to a
// list or the shell mode instead. Fresh is asked for after this moment: one
// already on its way was asked for before, so it is waited out and another
// asked for (a few tries). A snapshot that could not be had (it failed, or was
// skipped) says nothing: the status from before the Stop is no evidence.
async function hintIfStillWorking(paneId, { afterMs, message }) {
  await new Promise((resolve) => window.setTimeout(resolve, afterMs));
  const asked = Date.now();
  for (let tries = 0; tries < 3 && !(state.snapshotAt >= asked); tries += 1) {
    if (state.snapshotBusy) await snapshotSettled;
    else await refreshSnapshot();
  }
  if (!(state.snapshotAt >= asked)) return;
  if (state.selectedPaneId === paneId && stopTarget.paneId === paneId && stopTarget.status === "working") setFeedback(message);
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
import { createKeyBarEditor } from "./app/key-bar-editor.js?v=1.4.23";
const { openKeyBarDialog } = createKeyBarEditor({
  panePreferenceStorage,
  getKeyBarItems: () => keyBarItems,
  assignKeyBarItems: (items) => { keyBarItems = items; },
  getEnterKeyMode: () => enterKeyMode,
  setEnterKeyMode: (mode) => { enterKeyMode = mode; },
  renderKeyBar: (...args) => renderKeyBar(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
});

renderKeyBar();

window.addEventListener("blur", clearKeyModifiers);
import { createProjectDialog } from "./app/project-dialog.js?v=1.4.23";
createProjectDialog({
  state,
  elements,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  newProjectHerdrSession: (...args) => newProjectHerdrSession(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
});


// Only the last file link pressed is taken to. One still waiting gives way to
// a later link, and to any folder or machine picked by hand meanwhile.
let revealGeneration = 0;
import { createFiles } from "./app/files.js?v=1.4.23";
const {
  applyNavigatorPanels,
  browsePathStorage,
  browseState,
  fetchListing,
  refreshBrowseFolder,
  revealInFiles,
  showNavigatorTab,
  speechStop,
  syncAttachAvailability,
  viewFile,
} = createFiles({
  state,
  elements,
  desktopMedia,
  revealState: {
    get generation() { return revealGeneration; },
    set generation(value) { revealGeneration = value; },
  },
  transferRequest: (...args) => transferRequest(...args),
  setFeedback: (...args) => setFeedback(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  syncComposerExpanded: (...args) => syncComposerExpanded(...args),
  syncSidebar: (...args) => syncSidebar(...args),
});

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
    elements.workspaceList.querySelectorAll(".pane-button[data-pane-id]"),
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
  // Within the grid on screen, the shortcut moves the focus between its cells;
  // within the view split, between its tiles.
  if ((shownGridTabId && paneTabId(targetPaneId) === shownGridTabId) ||
      (viewGrid.shown && viewTiles(viewSplit.tree).includes(targetPaneId))) {
    selectPane(targetPaneId, { fromGrid: true });
    shownGrid()?.focus(targetPaneId);
    return true;
  }
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

// Mod+0 puts a Herdr grid's text size back to the largest that fits.
function activateGridFontReset(event) {
  if (!state.authenticated || event.altKey || event.shiftKey || event.key !== "0" ||
      !(event.ctrlKey || event.metaKey) || document.querySelector("dialog[open]") ||
      !paneGrid.adjustable || paneGrid.manualFont === null) return false;
  event.preventDefault();
  event.stopPropagation();
  paneGrid.resetFont();
  return true;
}

document.addEventListener("keydown", activateGridFontReset, { capture: true });

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
  // The grid is for wide screens; a phone shows one pane and the map. Drawn
  // here too: refreshTerminal does nothing while the page is hidden.
  if (state.authenticated) renderPaneViews();
  void refreshTerminal();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    terminalStream.pause();
    paneGrid.pause();
    viewGrid.pause();
  }
  if (document.hidden || !state.authenticated) return;
  // A chat watching a pane whose terminal was let go still needs the socket.
  terminalStream.resume();
  paneGrid.resume();
  viewGrid.resume();
  void dismissDeliveredNotifications();
  if (notificationNavigation.pendingPaneId) void refreshSnapshot();
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
import { createConnectPc } from "./app/connect-pc.js?v=1.4.23";

const { showLegacyMachinesNotice } = createConnectPc({
  api: (...args) => api(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  panePreferenceStorage,
});

async function start() {
  if ("BroadcastChannel" in window) {
    notificationNavigation.relayChannel = new BroadcastChannel("herdr-notification-navigation");
    notificationNavigation.relayChannel.onmessage = ({ data }) => {
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
