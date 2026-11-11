import { browserSessionStorage, browserStorage } from "./app/dom.js?v=1.4.53";
import { enhanceSelects } from "./app/select-popover.js?v=1.4.53";
import { createSnapshotModel } from "./app/snapshot.js?v=1.4.53";
import { createNotifications } from "./app/notifications.js?v=1.4.53";
import { createSettings } from "./app/settings.js?v=1.4.53";
import { createComposer } from "./app/composer.js?v=1.4.53";
import { createSidebarRows } from "./app/sidebar-rows.js?v=1.4.53";
import { createAccountDialogs } from "./app/account-dialogs.js?v=1.4.53";
import { createAiAccounts } from "./app/ai-accounts.js?v=1.4.53";
import { createNavigation } from "./app/navigation.js?v=1.4.53";
import { createSelection } from "./app/selection.js?v=1.4.53";
import { createPaneViews } from "./app/pane-views.js?v=1.4.53";
import { createTerminalStatus } from "./app/terminal-status.js?v=1.4.53";
import { createChatPanel, inTerminal } from "./app/chat-lens.js?v=1.4.53";
import { createKeyBar } from "./app/key-bar.js?v=1.4.53";
import { createKeyBarEditor } from "./app/key-bar-editor.js?v=1.4.53";
import { createProjectDialog } from "./app/project-dialog.js?v=1.4.53";
import { createSessionDialog } from "./app/session-dialog.js?v=1.4.53";
import { createWorktreeDialogs } from "./app/worktree-dialogs.js?v=1.4.53";
import { createFiles } from "./app/files.js?v=1.4.53";
import { createConnectPc } from "./app/connect-pc.js?v=1.4.53";
import { createApiClient, paneApi } from "./api-client.js?v=1.4.53";
import {
  detectTouchInput,
  paneServerId,
  loginMethodPresentation,
  preferredLoginMethod,
  cellShortcutDirection,
  paneShortcutTarget,
  sidebarPresentation,
  serverConnectionState,
} from "./ui-model.js?v=1.4.53";
import {
  readFileServer,
  readNavigatorTab,
} from "./browse-preference.js?v=1.4.53";
import { terminalConnection } from "./terminal-connection.js?v=1.4.53";
import { createAttachedTerminal } from "./xterm-terminal.js?v=1.4.53";
import {
  adjustedChatFontSize,
} from "./chat-font-preference.js?v=1.4.53";
import { chatAgent } from "./lens-preference.js?v=1.4.53";
import * as xterm from "./vendor/xterm.mjs?v=1.4.53";
import {
  readPanePreference,
} from "./pane-preference.js?v=1.4.53";
import {
  readCollapsedGroupIds,
  readCollapsedWorkspaceIds,
  readExpandedSplitTabIds,
} from "./workspace-preference.js?v=1.4.53";
import {
  adjustedTerminalFontSize,
  readTerminalFontSize,
  writeTerminalFontSize,
} from "./terminal-preference.js?v=1.4.53";
import {
  readAcknowledgedCompletions,
} from "./completion-preference.js?v=1.4.53";
import {
  looksLikePhysicalKey,
  readEnterKeyMode,
} from "./enter-key-preference.js?v=1.4.53";
import {
  attachSidebarDrag,
  movedTabSnapshot,
  movedWorkspaceSnapshot,
  tabMoveRequest,
  workspaceMoveRequest,
} from "./sidebar-drag.js?v=1.4.53";
import {
  readViewSplit,
  tiles as viewTiles,
} from "./view-split.js?v=1.4.53";
import {
  readInputHistories,
} from "./input-history-preference.js?v=1.4.53";
import { atFilesSource } from "./composer-at-files.js?v=1.4.53";
import { createComposerPopup } from "./composer-popup.js?v=1.4.53";
import { slashCommandsSource } from "./composer-slash.js?v=1.4.53";
import { createComposerDrafts, draftScreenIsSecret, draftScreenShowsPrompt } from "./composer-draft-preference.js?v=1.4.53";
import {
  readKeyBarItems,
} from "./key-bar-preference.js?v=1.4.53";
import {
  clearLaunchToken,
  readLaunchToken,
  writeLaunchToken,
} from "./launch-session.js?v=1.4.53";

let modifierPaneId = null;
// The selected pane's agent and status, for the Chat lens's Stop button.
let stopTarget = { paneId: null, agent: null, status: null };

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
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  sidebarScrim: document.querySelector("#sidebar-scrim"),
  mobileSidebarOpen: document.querySelector("#mobile-sidebar-open"),
  // The key bar's editor lives with the other settings at the foot of the sidebar.
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
  splitEven: document.querySelector("#split-even"),
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
  fileRefresh: document.querySelector("#file-refresh"),
  fileUploads: document.querySelector("#file-uploads"),
  fileServer: document.querySelector("#file-server"),
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
  // Whether other PCs can be connected from here: this machine's row offers
  // Connect PC… and Settings lists its PCs page only then.
  connectPcAvailable: false,
  // Whether Settings → Plugins can manage Herdr's plugins (with sign-in on).
  pluginsAvailable: false,
  // Whether Settings → Herdr can change Herdr's settings (with sign-in on).
  herdrSettingsAvailable: false,
  connectPcAccessAvailable: false,
  // Split tabs shown as a grid of their panes (tab id -> "grid"); any other
  // tab shows its selected pane alone.
  paneViews: new Map(),
  // The pane last selected in each split tab (tab id -> pane id), so a split
  // session's row on a phone opens where the user was.
  lastPaneOfTab: new Map(),
};

const {
  snapshotRecords, herdrSessionForServer,
  agentForPane, visibleStatusForPane, acknowledgePaneCompletion, pruneAcknowledgedCompletions,
} = createSnapshotModel({ state, storage: panePreferenceStorage });

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
// level hands `api` on (createSettings below does, for the Update panel).
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

// The special-key bar is for screens without a keyboard of their own: a touch
// screen or a phone-sized window. A desktop types Esc, Ctrl and the arrows
// itself, so the terminal gets that room.
function syncKeyBarShown() {
  document.body.classList.toggle("shows-key-bar", usesTouchInputEnvironment() || !desktopMedia.matches);
}
syncKeyBarShown();
for (const media of [desktopMedia, primaryTouchMedia, anyCoarsePointerMedia, anyHoverMedia, compactInputMedia]) {
  media.addEventListener("change", syncKeyBarShown);
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
  // Signed out (from Signed-in devices, say): nothing of the app stays over the sign-in.
  closeSettings();
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
const {
  closeSettings, syncSettings, updatePanel, renderNotificationItem, syncPushSubscription,
} = createSettings({
  state,
  api,
  snapshotRecords: (...args) => snapshotRecords(...args),
  setFeedback: (...args) => setFeedback(...args),
  panePreferenceStorage,
  desktopMedia,
  get paneGrid() { return paneGrid; },
  get chatLens() { return chatLens; },
  openKeyBarDialog: (...args) => openKeyBarDialog(...args),
  showPasskeys: (...args) => showPasskeys(...args),
  showSessions: (...args) => showSessions(...args),
  showServerDetails: (...args) => showServerDetails(...args),
  openConnectPc: (...args) => openConnectPc(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  // A plugin's pane opened from Settings → Plugins: shown as any other.
  showPane: (paneId) => {
    closeMobileSidebar();
    selectPane(paneId, { view: "solo" });
  },
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

// Each pane keeps the message typed but not sent. The textarea shows the
// selected pane's; switching panes saves it and brings the other pane's back.
// A draft is dropped before it is sent, and a text the server calls
// a password answer is never stored.
let draftPaneId = null;
let draftSaveTimer = null;
const draftBlocked = new Set(); // panes whose composer text must not be stored
const draftHeld = new Set(); // panes with a message on its way
const {
  resizeTerminalInput,
  syncComposerExpanded,
  scheduleTerminalInputResize,
  resetInputHistoryNavigation,
  saveComposerDraft,
  scheduleComposerDraftSave,
  syncComposerDraft,
  holdComposerDraft,
  releaseComposerDraft,
  rememberSentInput,
} = createComposer({
  state,
  elements,
  panePreferenceStorage,
  composerDrafts,
  composerPopup,
  draftBlocked,
  draftHeld,
  getDraftPaneId: () => draftPaneId,
  setDraftPaneId: (value) => { draftPaneId = value; },
  getDraftSaveTimer: () => draftSaveTimer,
  setDraftSaveTimer: (value) => { draftSaveTimer = value; },
  getTerminalInputResizeTimer: () => terminalInputResizeTimer,
  setTerminalInputResizeTimer: (value) => { terminalInputResizeTimer = value; },
  COMPOSER_RESIZE_DELAY_MS,
});

const {
  sidebarActionMenu, adoptMutationSnapshot, createSession, closeSession, renameForm, workspaceHeading,
  agentMark, paneButton, attachGroupCollapse, serverRenameForm,
} = createSidebarRows({
  state,
  panePreferenceStorage,
  desktopMedia,
  viewSplit,
  get viewGrid() { return viewGrid; },
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  agentForPane: (...args) => agentForPane(...args),
  visibleStatusForPane: (...args) => visibleStatusForPane(...args),
  choosePane: (...args) => choosePane(...args),
  renderNavigation: (...args) => renderNavigation(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  renderPaneHeading: (...args) => renderPaneHeading(...args),
  showTerminalMessage: (...args) => showTerminalMessage(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  setFeedback: (...args) => setFeedback(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  selectPane: (...args) => selectPane(...args),
  focusComposer: (...args) => focusComposer(...args),
  openNewSession: (...args) => openNewSession(...args),
  openNewWorktree: (...args) => worktreeDialogs.openNew(...args),
  openWorktree: (...args) => worktreeDialogs.openExisting(...args),
  removeWorktree: (...args) => worktreeDialogs.remove(...args),
});

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
  agentMark: (...args) => agentMark(...args),
  setFeedback: (...args) => setFeedback(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
});

// Made before the sidebar rows and split panes it draws with; it calls them
// only when the sidebar is drawn.
const {
  renameIsOpen,
  renderNavigation,
  followMovedPaneState,
  moveSidebarItem,
} = createNavigation({
  state,
  elements,
  sidebarDrag,
  panePreferenceStorage,
  composerDrafts,
  draftBlocked,
  draftHeld,
  viewSplit,
  api: (...args) => api(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  setFeedback: (...args) => setFeedback(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  renderPaneHeading: (...args) => renderPaneHeading(...args),
  agentForPane: (...args) => agentForPane(...args),
  visibleStatusForPane: (...args) => visibleStatusForPane(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  saveComposerDraft: (...args) => saveComposerDraft(...args),
  setViewSplit: (...args) => setViewSplit(...args),
  showServerDetails: (...args) => showServerDetails(...args),
  showAiAccounts: (...args) => showAiAccounts(...args),
  openConnectPc: (...args) => openConnectPc(...args),
  openNewProject: (...args) => openNewProject(...args),
  herdrSessionForServer: (...args) => herdrSessionForServer(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  renameForm: (...args) => renameForm(...args),
  serverRenameForm: (...args) => serverRenameForm(...args),
  attachGroupCollapse: (...args) => attachGroupCollapse(...args),
  workspaceHeading: (...args) => workspaceHeading(...args),
  paneButton: (...args) => paneButton(...args),
  closeSession: (...args) => closeSession(...args),
  canLayOut: (...args) => canLayOut(...args),
  splitSessionName: (...args) => splitSessionName(...args),
  splitPaneRow: (...args) => splitPaneRow(...args),
  splitDisclosureButton: (...args) => splitDisclosureButton(...args),
  splitSessionButton: (...args) => splitSessionButton(...args),
  evenOutLayout: (...args) => evenOutLayout(...args),
  separateSplitSession: (...args) => separateSplitSession(...args),
  get navigationRedrawHeld() { return navigationRedrawHeld; },
  set navigationRedrawHeld(value) { navigationRedrawHeld = value; },
  get draftPaneId() { return draftPaneId; },
  set draftPaneId(value) { draftPaneId = value; },
  get chatLens() { return chatLens; },
  get EVEN_ICON() { return EVEN_ICON; },
  get SEPARATE_ICON() { return SEPARATE_ICON; },
});

// Settles when the snapshot on its way (if any) has arrived or failed.
let snapshotSettled = Promise.resolve();

// Made before the terminal socket, the attached terminal, the Chat lens and
// the Files tab, which are read through getters (only later, never while this
// is made). Nothing here runs at the top level.
const {
  renderPaneHeading,
  isLinkableTerminalPath,
  openTerminalPath,
  showTerminalMessage,
  selectedRecords,
  selectedRecordsFor,
  choosePane,
  liveStatusUpdates,
  receiveLiveStatus,
  refreshSnapshot,
  refreshTerminal,
  refreshOutputOnSchedule,
  sendText,
  sendKeys,
  refreshAfterSubmission,
  streamPayloadIsCurrent,
  scheduleStreamRender,
} = createSelection({
  state,
  elements,
  notificationNavigation,
  panePreferenceStorage,
  pageOpenedAt,
  PENDING_REMOTE_PANE_MS,
  OUTPUT_SUBMISSION_BURST_MS,
  OUTPUT_SUBMISSION_RETRY_MS,
  snapshotRecords: (...args) => snapshotRecords(...args),
  agentForPane: (...args) => agentForPane(...args),
  acknowledgePaneCompletion: (...args) => acknowledgePaneCompletion(...args),
  pruneAcknowledgedCompletions: (...args) => pruneAcknowledgedCompletions(...args),
  api: (...args) => api(...args),
  transferRequest: (...args) => transferRequest(...args),
  completeNotificationRelay: (...args) => completeNotificationRelay(...args),
  restoreNotificationTarget: (...args) => restoreNotificationTarget(...args),
  resetInputHistoryNavigation: (...args) => resetInputHistoryNavigation(...args),
  syncComposerDraft: (...args) => syncComposerDraft(...args),
  syncAttachAvailability: (...args) => syncAttachAvailability(...args),
  clearKeyModifiers: (...args) => clearKeyModifiers(...args),
  syncSendButton: (...args) => syncSendButton(...args),
  agentMark: (...args) => agentMark(...args),
  viewFile: (...args) => viewFile(...args),
  revealInFiles: (...args) => revealInFiles(...args),
  refreshBrowseFolder: (...args) => refreshBrowseFolder(...args),
  showTerminalView: (...args) => showTerminalView(...args),
  syncTerminalFind: (...args) => syncTerminalFind(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  renameIsOpen: (...args) => renameIsOpen(...args),
  renderNavigation: (...args) => renderNavigation(...args),
  setConnection: (...args) => setConnection(...args),
  pruneViewSplit: (...args) => pruneViewSplit(...args),
  renderPaneViews: (...args) => renderPaneViews(...args),
  renderTerminalStatus: (...args) => renderTerminalStatus(...args),
  get snapshotSettled() { return snapshotSettled; },
  set snapshotSettled(value) { snapshotSettled = value; },
  get stopTarget() { return stopTarget; },
  set stopTarget(value) { stopTarget = value; },
  get modifierPaneId() { return modifierPaneId; },
  get revealGeneration() { return revealGeneration; },
  set revealGeneration(value) { revealGeneration = value; },
  get shownPaneView() { return shownPaneView; },
  get terminalStream() { return terminalStream; },
  get attachedTerminal() { return attachedTerminal; },
  get chatLens() { return chatLens; },
  get promptDock() { return promptDock; },
  get terminalFind() { return terminalFind; },
  get browseState() { return browseState; },
  setFeedback: (...args) => setFeedback(...args),
});

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

// The split tab whose grid is on screen, and what renderPaneViews last
// answered: set by pane-views.js, read here as well.
let shownGridTabId = null;
let shownPaneView = null;

// The chat panel is made after the pane views that read it; they reach it
// through this once it exists.
let lateChatLens = null;

const {
  SEPARATE_ICON, EVEN_ICON,
  paneTabId, canLayOut, paneGrid, viewGrid, shownGrid, setViewSplit, pruneViewSplit,
  dropOnPane, paneDropTargets, renderPaneViews, selectPane,
  splitSessionName, splitSessionButton, splitDisclosureButton, splitPaneRow,
  evenOutLayout, separateSplitSession,
} = createPaneViews({
  state,
  elements,
  desktopMedia,
  panePreferenceStorage,
  viewSplit,
  viewSplitStorage,
  paneCalls,
  notificationNavigation,
  getShownGridTabId: () => shownGridTabId,
  setShownGridTabId: (value) => { shownGridTabId = value; },
  getShownPaneView: () => shownPaneView,
  setShownPaneView: (value) => { shownPaneView = value; },
  getSnapshotSettled: () => snapshotSettled,
  snapshotRecords: (...args) => snapshotRecords(...args),
  agentForPane: (...args) => agentForPane(...args),
  visibleStatusForPane: (...args) => visibleStatusForPane(...args),
  acknowledgePaneCompletion: (...args) => acknowledgePaneCompletion(...args),
  completeNotificationRelay: (...args) => completeNotificationRelay(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  selectedRecordsFor: (...args) => selectedRecordsFor(...args),
  followMovedPaneState: (...args) => followMovedPaneState(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  renderNavigation: (...args) => renderNavigation(...args),
  renderPaneHeading: (...args) => renderPaneHeading(...args),
  showTerminalMessage: (...args) => showTerminalMessage(...args),
  resetInputHistoryNavigation: (...args) => resetInputHistoryNavigation(...args),
  syncComposerDraft: (...args) => syncComposerDraft(...args),
  focusComposer: (...args) => focusComposer(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  setFeedback: (...args) => setFeedback(...args),
  showLogin: (...args) => showLogin(...args),
  syncSettings: (...args) => syncSettings(...args),
  applyTerminalFontSize: (...args) => applyTerminalFontSize(...args),
  isLinkableTerminalPath: (...args) => isLinkableTerminalPath(...args),
  openTerminalPath: (...args) => openTerminalPath(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  paneButton: (...args) => paneButton(...args),
  agentMark: (...args) => agentMark(...args),
  // Made below (lateChatLens); read once the page draws a grid.
  get chatLens() { return lateChatLens; },
});

let phoneKeyboardOpen = false;
// A phone keyboard put away leaves the composer focused: Send reads that as
// out of the composer (and may turn into Stop) until the composer is tapped
// or focused again.
let composerKeyboardDismissed = false;

// Made after `attachedTerminal`, whose callbacks call these (only later, never
// while it is made). The phone keyboard is followed at once, as before.
const {
  attachTracker, noteTerminalAttach, renderTerminalStatus, showNewestTerminalOutput, scheduleTerminalPark,
} = createTerminalStatus({
  state,
  elements,
  terminalStream,
  attachedTerminal,
  paneCalls,
  paneServerId: (...args) => paneServerId(...args),
  shownGrid: (...args) => shownGrid(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
  syncSendButton: (...args) => syncSendButton(...args),
  get phoneKeyboardOpen() { return phoneKeyboardOpen; },
  set phoneKeyboardOpen(value) { phoneKeyboardOpen = value; },
  get composerKeyboardDismissed() { return composerKeyboardDismissed; },
  set composerKeyboardDismissed(value) { composerKeyboardDismissed = value; },
  get chatLens() { return chatLens; },
});

// Made right after the lens switch, which tells it the lens (below).
let promptDock = null;
const chatPanel = createChatPanel({
  state,
  elements,
  panePreferenceStorage,
  desktopMedia,
  terminalStream,
  attachedTerminal,
  paneCalls,
  conversationRequest,
  api: (...args) => api(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
  isLinkableTerminalPath: (...args) => isLinkableTerminalPath(...args),
  openTerminalPath: (...args) => openTerminalPath(...args),
  setFeedback: (...args) => setFeedback(...args),
  showNewestTerminalOutput: (...args) => showNewestTerminalOutput(...args),
  scheduleTerminalPark: (...args) => scheduleTerminalPark(...args),
  syncComposerExpanded: (...args) => syncComposerExpanded(...args),
  resizeTerminalInput: (...args) => resizeTerminalInput(...args),
  syncSendButton: (...args) => syncSendButton(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  refreshAfterSubmission: (...args) => refreshAfterSubmission(...args),
  selectPane: (...args) => selectPane(...args),
  viewFile: (...args) => viewFile(...args),
  selectedRecordsFor: (...args) => selectedRecordsFor(...args),
  viewTicket: (...args) => viewTicket(...args),
  renderPaneViews: (...args) => renderPaneViews(...args),
  shownGrid: (...args) => shownGrid(...args),
  focusComposer: (...args) => focusComposer(...args),
});
const { chatLens, syncTerminalFind, applyChatFontSize, overChat, showTerminalView } = chatPanel;
lateChatLens = chatLens;
promptDock = chatPanel.promptDock;
terminalFind = chatPanel.terminalFind;
chatFind = chatPanel.chatFind;
// Ctrl/Cmd + wheel over the chat sizes its text (the wheel handler below).
let chatFontWheelDelta = 0;

let keyBarItems = readKeyBarItems(panePreferenceStorage);
const { clearComposer, syncSendButton, clearKeyModifiers, renderKeyBar } = createKeyBar({
  state,
  elements,
  composerPopup,
  chatLens,
  attachedTerminal,
  draftBlocked,
  getDraftPaneId: () => draftPaneId,
  getTerminalInputResizeTimer: () => terminalInputResizeTimer,
  setTerminalInputResizeTimer: (value) => { terminalInputResizeTimer = value; },
  getChatFind: () => chatFind,
  getPromptDock: () => promptDock,
  getEnterKeyMode: () => enterKeyMode,
  getPhysicalKeyboardSeen: () => physicalKeyboardSeen,
  getKeyBarItems: () => keyBarItems,
  setModifierPaneId: (value) => { modifierPaneId = value; },
  getStopTarget: () => stopTarget,
  getComposerKeyboardDismissed: () => composerKeyboardDismissed,
  setComposerKeyboardDismissed: (value) => { composerKeyboardDismissed = value; },
  getPhoneKeyboardOpen: () => phoneKeyboardOpen,
  syncComposerExpanded: (...args) => syncComposerExpanded(...args),
  resizeTerminalInput: (...args) => resizeTerminalInput(...args),
  scheduleTerminalInputResize: (...args) => scheduleTerminalInputResize(...args),
  resetInputHistoryNavigation: (...args) => resetInputHistoryNavigation(...args),
  scheduleComposerDraftSave: (...args) => scheduleComposerDraftSave(...args),
  holdComposerDraft: (...args) => holdComposerDraft(...args),
  releaseComposerDraft: (...args) => releaseComposerDraft(...args),
  rememberSentInput: (...args) => rememberSentInput(...args),
  speechStop: (...args) => speechStop(...args),
  setFeedback: (...args) => setFeedback(...args),
  sendText: (...args) => sendText(...args),
  sendKeys: (...args) => sendKeys(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  agentForPane: (...args) => agentForPane(...args),
  refreshAfterSubmission: (...args) => refreshAfterSubmission(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  focusComposer: (...args) => focusComposer(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
  hintIfStillWorking: (...args) => hintIfStillWorking(...args),
});

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
const { open: openNewProject } = createProjectDialog({
  state,
  elements,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  herdrSessionForServer: (...args) => herdrSessionForServer(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  setFeedback: (...args) => setFeedback(...args),
  agentMark: (...args) => agentMark(...args),
});
const { open: openNewSession } = createSessionDialog({
  state,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  createSession,
  agentMark: (...args) => agentMark(...args),
  herdrSessionForServer: (...args) => herdrSessionForServer(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  setFeedback: (...args) => setFeedback(...args),
});
// The + at the top of the sidebar: New tab where the person is looking.
document.querySelector("#new-tab-open").addEventListener("click", () => openNewSession());
const worktreeDialogs = createWorktreeDialogs({
  state,
  agentMark: (...args) => agentMark(...args),
  api: (...args) => api(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  setFeedback: (...args) => setFeedback(...args),
});

// Only the last file link pressed is taken to. One still waiting gives way to
// a later link, and to any folder or machine picked by hand meanwhile.
let revealGeneration = 0;
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
  viewTicket,
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

window.addEventListener("herdr-theme-change", () => syncSettings());

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
    applyChatFontSize(adjustedChatFontSize(chatPanel.chatFontSize, chatFontWheelDelta < 0 ? "larger" : "smaller"));
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
    focusCell(shownGrid(), targetPaneId);
    return true;
  }
  targetButton.click();
  return true;
}

// Selects `paneId`'s cell of `grid` and gives it the typing: its terminal in
// Terminal, the composer in Chat (the cell's terminal is hidden there).
function focusCell(grid, paneId) {
  selectPane(paneId, { fromGrid: true });
  if (grid.lensOf(paneId) === "chat") focusComposer();
  else grid.focus(paneId);
}

// A text field that keeps Alt+arrow for itself: any but the composer and a
// cell's terminal (find, rename, a card's answer).
function keepsAltArrow(element) {
  return element instanceof HTMLElement && (element.isContentEditable || element.matches("input, textarea, select")) &&
    element !== elements.terminalInput && !element.closest(".pane-grid-cell .xterm");
}

// Alt+arrow moves between the cells of the grid or split view on screen, to
// the one that way as they are laid out. Taken before xterm sees it, so it
// works from a Terminal cell too (a shell's Alt+arrow word moves give way
// while a split is shown); with no split on screen the key stays the
// browser's (Back and Forward), and so it does while the selected pane has
// no cell on screen. Other text fields keep it (keepsAltArrow).
function activateCellShortcut(event) {
  const direction = cellShortcutDirection(event);
  if (!direction || !state.authenticated || document.querySelector("dialog[open]")) return false;
  const grid = shownGrid();
  if (!grid || !state.selectedPaneId || grid.lensOf(state.selectedPaneId) === null) return false;
  if (keepsAltArrow(document.activeElement)) return false;
  event.preventDefault();
  event.stopPropagation();
  const target = grid.neighbor(state.selectedPaneId, direction);
  if (target) focusCell(grid, target);
  return true;
}

// Mod+J switches the pane between Chat and Terminal. Inside the terminal,
// Ctrl+J stays the program's (a newline); Cmd+J on a Mac switches there too.
function activateLensShortcut(event) {
  if (!state.authenticated || event.isComposing || event.altKey || event.shiftKey ||
      event.key.toLowerCase() !== "j" || document.querySelector("dialog[open]")) return false;
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  if (!mac && inTerminal(document.activeElement, elements.terminalXterm) && chatLens.lens === "terminal") return false;
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
document.addEventListener("keydown", activateCellShortcut, { capture: true });

document.addEventListener("keydown", (event) => {
  if (activateLensShortcut(event)) return;
  if (activatePaneShortcut(event)) return;
  if (event.key !== "Escape") return;
  // An open dialog (the settings screen, a window over it) answers Escape on
  // its own; the sidebar under it stays as it is.
  if (document.querySelector("dialog[open]")) return;
  state.openActionMenuId = null;
  for (const menu of elements.workspaceList.querySelectorAll(
    ".sidebar-action-menu[open]",
  )) menu.open = false;
  closeMobileSidebar({ restoreFocus: true });
});

document.addEventListener("click", (event) => {
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

// Every select gets the app's own list on a desktop (touch keeps the OS picker).
enhanceSelects();

async function initializeApplication() {
  const bootstrap = await api("/api/bootstrap");
  state.csrfToken = bootstrap.csrfToken;
  state.pollIntervalMs = bootstrap.pollIntervalMs || state.pollIntervalMs;
  state.maxTransferBytes = Number.isFinite(bootstrap.maxTransferBytes) && bootstrap.maxTransferBytes > 0 ? bootstrap.maxTransferBytes : null;
  state.pushPublicKey = typeof bootstrap.pushPublicKey === "string"
    ? bootstrap.pushPublicKey
    : null;
  state.connectPcAvailable = bootstrap.servers === true;
  state.pluginsAvailable = bootstrap.plugins === true;
  state.herdrSettingsAvailable = bootstrap.herdrSettings === true;
  state.connectPcAccessAvailable = bootstrap.connectPcAccess === true;
  syncSettings();
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

const { showLegacyMachinesNotice, openConnectPc } = createConnectPc({
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
    syncSettings();
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
