# HerdRabbit

English | [한국어](README.ko.md)

HerdRabbit is a small personal web app for controlling [Herdr](https://herdr.dev/) workspaces running on your own machine. It reconnects to existing Herdr sessions, shows terminal output and agent state, sends text and special keys, and installs as a PWA on desktop and mobile devices.

> [!IMPORTANT]
> HerdRabbit is a **personal-use tool for one person to access their own Herdr sessions**. It is not a multi-user account system, an authorization boundary between untrusted users, or a public hosting service. Do not expose it directly to the public internet. Use it over a private network such as Tailscale.

HerdRabbit runs once per OS user and may be protected with one instance password. It does not use usernames. The app, repository, and systemd service are all named `HerdRabbit`. Installations that still use the former `herdrabbit.service` name are migrated automatically the next time the installer runs.

## Reusable HTML UI

[`public/ui`](public/ui/README.md) contains the shared styles used by the app and a standalone catalog. Open `/ui/index.html` while the app is running, or copy the folder and open its `index.html` directly. Load `ui/ui.css` to reuse themes, buttons, inputs, navigation/status, menus, sidebars, and dialogs without a framework or build step.

Run `npm run check:ui` with Playwright installed, or set `PLAYWRIGHT_MODULE` to its module path.

## Recommended access: Tailscale first

HerdRabbit is designed to listen on `127.0.0.1` and be reached remotely through [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve):

```text
phone, tablet, or PC PWA
        │ HTTPS inside your tailnet
        ▼
Tailscale Serve
        │ HTTP to 127.0.0.1:3xxxx
        ▼
HerdRabbit on the Herdr machine
```

Both the Herdr machine and the device opening HerdRabbit must be signed in to the same tailnet. The resulting HTTPS URL is tailnet-only, not a public website. The optional HerdRabbit password adds another layer but does not replace Tailscale. Do not enable Tailscale Funnel for this app.

When Tailscale is installed and running, the [one-line installer](#quick-install) automatically detects the machine's Tailscale DNS name, allows that host, and registers an HTTPS Serve rule on HerdRabbit's selected port. See [Tailscale Serve HTTPS](#tailscale-serve-https) for manual setup and troubleshooting.

## Features

- Browse the current OS user's Herdr persistent sessions, workspaces, tabs, panes, and agent states
- Aggregate multiple Herdr persistent sessions without local ID collisions
- Show every pane as Herdr itself draws it (a real `herdr terminal attach` in xterm.js), on this machine and on Herdr SSH machines, so full-screen TUIs, the cursor and colors match; a pane that cannot attach is mirrored read-only in the same terminal
- Read a Claude Code or Codex pane as a chat: its conversation as turns, the agent's tool calls folded under one "Worked for …" row, older turns loaded as you scroll up. A **Chat** / **Terminal** switch in the pane header (or `Ctrl`/`Cmd`+`J`) flips between the two without reconnecting anything
- Answer what an agent asks (tool approvals, questions, menus) with buttons on a card at the bottom of the chat, or from a banner over the terminal
- Each pane keeps its own unsent draft, also across a reload
- Send text and shell commands, or use a two-row extra-key bar (Ctrl/Alt/Shift, Esc, Tab, Home/End, PgUp/PgDn, arrows, slash, minus and Enter by default; edit it with **Edit keys**). Select modifiers, then tap a key or type it on your keyboard (for example Ctrl → End or Ctrl → C); on a phone keyboard, the letter typed after a modifier goes as that key and does not stay in the composer. PgUp and PgDn page through the terminal history a screen at a time, as a finger or the wheel does; hold Shift first to send the plain key to a program that pages itself, such as less or vim. With Ctrl or Alt held, or in a mirrored pane, they send their keys as before. Modifiers clear after one send or when switching panes. Ordinary composer shortcuts remain local unless a screen modifier is selected.
- Create shell workspaces and tabs, rename workspaces and sessions, and close tabs or workspaces after confirmation
- View images, video, audio, Markdown and text in the browser instead of downloading them first
- Manage every machine from its row in the sidebar, this one included: read its name and versions, and for a Herdr SSH machine rename it, turn it off or remove it
- Switch the Claude Code or Codex account a machine uses without signing in again, from the same row
- Move files between the browsing device and the Herdr machine through a shared uploads folder: upload from the composer's attach button, paste the stored path into the composer, and download or delete stored files
- Remember the selected pane and collapsed workspaces in the browser
- Switch sidebar entries with `Ctrl+Tab`, `Ctrl+Shift+Tab`, or `Ctrl+1`–`Ctrl+9` when the browser forwards those shortcuts to the app
- Restore terminal font size and the last 100 sent prompts per pane across app launches; use Up/Down in the composer to recall prompts
- Mark each session in the sidebar with the program it runs (Claude, Codex, another agent, or a shell) and its status at the far right: Herdr's own symbol for the status (`◐` working, `×` needs your answer, `✓` done and not yet viewed, `○` idle); collapsed projects still call out unviewed completions
- Send status-only PWA notifications with the project and tab names when an agent needs input or finishes; while the app is in front, show them inside it instead
- Install as a responsive PWA with light and dark themes (switched in the ⚙ settings menu)
- Resize terminal text with `Ctrl`/`Cmd` + wheel, trackpad zoom, or a two-finger mobile gesture
- Protect an instance with an optional password, Passkey login, a seven-day hard session limit, login on each new PWA window, and a list of signed-in browsers to sign out one by one or all at once
- Install a per-user systemd service on a collision-free port in `30000–39999`
- Register Tailscale Serve HTTPS during setup when Tailscale is available

Pane splitting, Herdr persistent-session renaming, and multi-user accounts are not currently provided.

## Technology

- **Server:** Node.js 22+, ESM, and Node's standard-library HTTP, crypto, filesystem, and process APIs
- **Web UI:** semantic HTML, CSS, and vanilla JavaScript with no frontend framework
- **PWA:** Web App Manifest, Service Worker app-shell caching, responsive standalone UI
- **Notifications:** standards-based Web Push, Push API, VAPID, and the `web-push` package
- **Herdr integration:** local `herdr` CLI calls through `execFile` argument arrays without a shell
- **Process management:** per-user `systemd --user` service on Linux
- **Private HTTPS:** Tailscale Serve proxying to a loopback HTTP listener
- **Authentication:** WebAuthn Passkeys through SimpleWebAuthn, `scrypt` password hashes, HMAC-signed sessions, `HttpOnly` cookies, per-window signed launch tokens, CSRF tokens, and same-origin checks
- **Testing:** Node's built-in `node:test`, integration tests, and a fake Herdr executable

Live terminal input (including composer submissions and extra keys) and output use `/api/terminal` WebSocket. An attached pane streams Herdr's own output. For a mirrored pane, after the initial snapshot only changes are sent; Herdr reports no general screen change outside a terminal attach, so the server observes output: 50 ms after each read during activity, 500 ms when quiet, shared by viewers of the same pane and line range. Background pages disconnect and receive a fresh snapshot on return. Session status uses Herdr `pane.agent_status_changed` events over WebSocket, including unselected sessions. Project/session lists still refresh over HTTP every two seconds and resynchronize after the status subscription starts. HTTP list refreshes also cover subscription failures while retrying. Authentication and project/session management remain HTTP. Push notifications are unchanged.

## Additional machines

### Herdr SSH machines

Machines added with `herdr machine add` appear in the sidebar next to this one, and **+ → Add SSH machine** adds one from here (shown in that menu only where SSH machines are available): give an SSH target (`user@host`, or a host from your SSH config) and optionally a name. Nothing is installed on that machine besides the Herdr it already runs. HerdRabbit keeps one SSH connection per enabled machine and forwards that machine's Herdr sockets to a private directory of its own, so its panes list, take input, report status and open as a real terminal the same way this machine's do. The machine's `⋯` menu renames it, turns it off or removes it, through `herdr machine`, so Herdr's own list stays the same.

SSH has to sign in with a key and already trust the host. A machine that asks for a password or a new host key shows that in its status; run `herdr machine reconnect` (or `herdr machine add`) for it once in a terminal.

The Files tab and the uploads dialog work for these machines too: pick the machine in the Files tab, or upload while one of its panes is open. Browsing, previews, downloads and uploads run a few fixed shell commands over the same SSH connection, so again nothing is installed there. Uploads go to `~/.local/share/herdrabbit/files` in that machine's home (always there, whatever `HERDR_WEB_FILES_DIR` says here), created private (0700) on the first upload. The same size setting applies as here: no limit by default, or whatever `HERDR_WEB_MAX_TRANSFER_MB` sets. The machine needs an sh-compatible login shell (bash, zsh or dash, not fish) and GNU findutils and coreutils (`find -printf`, `tail`, `head`, `ln -T`), which any ordinary Linux has; a machine without them (BusyBox, macOS) says so in the Files tab instead of listing anything. Paths with a backslash in them cannot be opened on these machines.

**AI accounts** in the machine's `⋯` menu switches its Claude Code and Codex sign-ins the same way as on this machine, and everything happens on that machine: each call sends HerdRabbit's own account code, as fixed text, to the machine's Node.js over the same SSH connection and runs it there. Sign-ins are saved in `~/.config/herdr-bridge/ai-accounts` in that machine's home, or under its own `XDG_CONFIG_HOME` (0700 folders, 0600 files, where a HerdRabbit installed there would keep them; `HERDR_WEB_AI_ACCOUNTS_DIR` here does not apply there), a switch copies files only within that machine, and **Add account** opens the sign-in project in one of the machine's Herdr sessions. No credential file is read back to this machine or copied between machines; what comes back is whose account it is (email, organization, plan, sign-in expiry). A switch checks the machine's own panes for running agents first. It needs Node.js 22 or newer on the machine, on the PATH an SSH command gets (or under `~/.nvm` or fnm), and `flock` (util-linux, on any ordinary Linux) so that only one change runs there at a time; without them, AI accounts shows why instead. A change that outlasts its 20-second wait here may still finish on the machine; the next one waits for it.

### Every machine in one sidebar

All machines appear together as **machine → Herdr session → project → tab/pane**; selecting a pane sends input and reads output on that machine. Each machine refreshes on its own, with slower retries after a failure, so an unreachable one does not hold up local data; its last-known panes stay visible while it is marked offline. A machine's sessions appear in the project/session picker, and projects and tabs can be created, renamed and closed there.

A machine is managed where it is seen, and every machine has a row -- this one too, even when it is the only one. Its `⋯` menu opens **Details** -- the machine's name, the HerdRabbit version answering for this machine, its Herdr version (marked when it is older than 0.9.0; this machine also logs that at startup), and how many Herdr sessions and panes it contributes -- and **AI accounts**. Browser-wide settings (including **Passkeys** and **Signed-in devices**) are in the ⚙ menu at the foot of the sidebar, not here. Details are the first thing worth reading when a machine will not connect.

### Computers linked by an older version

Earlier versions linked another PC by installing a second HerdRabbit on it in "leaf" mode and adding it with **+ → Connect Server**. That mode is gone: remote PCs are Herdr SSH machines now, with nothing of HerdRabbit installed on them. Links saved by an older version in `~/.config/herdr-bridge/servers.json` (or `HERDR_WEB_SERVERS_FILE`) are no longer shown. The file is left as it is, and the page says once, in each browser, how many there were: re-add each of those PCs with **+ → Add SSH machine** (or `herdr machine add`).

A PC that was installed as a leaf ignores its leaf settings (`HERDR_WEB_ROLE`, `HERDR_WEB_PEER_LOGINS`, `HERDR_WEB_PEER_ADDRESSES`, `HERDR_WEB_HUB`) with one warning and listens on `127.0.0.1` only. A leaf never had a password and its peer gate is gone, so without a password it does not serve HerdRabbit at all: it stays up (an update does not roll back), and every request gets only a 503 saying to set a password, so it is not left open behind Tailscale Serve. `update.sh` from this version on stops on a leaf before changing anything and prints the same steps. Run `npm run install-service` there to set it up again as an ordinary HerdRabbit with a password, or stop its service if it is only reached as a Herdr SSH machine.

## Architecture

```text
Browser / installed PWA
        │
        │ HTTPS (optional)
        ▼
Tailscale Serve
        │
        │ http://127.0.0.1:3xxxx
        ▼
HerdRabbit Node.js server
        │
        │ execFile argument arrays
        ▼
local herdr CLI ── default and named Herdr persistent sessions
                         └─ workspaces, tabs, and panes
```

Creating a project creates a Herdr workspace and default shell. Creating a session creates a new tab and default shell in that workspace. HerdRabbit does not run a separate terminal backend; it reads from and writes to Herdr panes.

### Multiple Herdr persistent sessions

HerdRabbit calls `herdr session list --json`, reads snapshots from every running persistent session, and scopes local IDs such as `w1:p1` to their originating session.

- One persistent session is shown without an extra grouping level.
- Multiple or unavailable sessions are grouped and labeled in the sidebar.
- Stopped sessions show their state but are not queried for snapshots.
- Commands are routed back to the original Herdr persistent session.
- Sessions owned by another OS user and one-off `herdr --no-session` processes are not included.

### Multiple OS users on one server

Each Linux user runs their own installation. `systemd --user` isolates identically named services by OS account, while the installer selects an unused local and Tailscale HTTPS port.

```text
alice → 127.0.0.1:38787 → https://server.example.ts.net:38787
bob   → 127.0.0.1:30000 → https://server.example.ts.net:30000
```

Each instance is still personal: it exposes only the Herdr sessions and configuration of the OS user running that instance.

## Requirements

- Linux for automatic systemd service installation; macOS may use direct execution
- Node.js 22 or newer
- Git and curl for the one-line installer
- Herdr 0.9.0 or newer with a running persistent session. The installer and `update.sh` update an older Herdr with `herdr update --handoff`, which keeps running panes alive
- Tailscale when remote HTTPS access is required
- Outbound internet access to browser push services when background notifications are enabled

Check the local tools with:

```bash
node --version
herdr --version
herdr status server
```

If Herdr is absent, the HerdRabbit service installer downloads the official Herdr installer automatically. To install Herdr yourself:

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

Herdr installs to `~/.local/bin/herdr` by default. Add it to your shell PATH if necessary:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Quick install

Run this in a Linux terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/ultivis-iot/HerdRabbit/main/install.sh | sh
```

The bootstrap script:

1. Checks Linux, Git, and Node.js 22+
2. Clones or updates HerdRabbit in `~/.local/share/herd-rabbit`
3. Installs Herdr from `https://herdr.dev/install.sh` when `herdr` is missing, or updates it with `herdr update --handoff` when it is older than 0.9.0
4. Prompts for an optional HerdRabbit password through the terminal
5. Selects an unused port, preferring `38787` and then `30000–39999`
6. Installs and starts `herdrabbit.service` for the current OS user
7. Registers Tailscale Serve HTTPS when Tailscale is running
8. Prints the final local port and HTTPS URL

The bootstrap refuses to overwrite local changes in an existing installation. Override its installation directory with `HERD_RABBIT_INSTALL_DIR`:

```bash
HERD_RABBIT_INSTALL_DIR="$HOME/apps/herd-rabbit" \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/ultivis-iot/HerdRabbit/main/install.sh)"
```

### Manual repository install

```bash
gh repo clone ultivis-iot/HerdRabbit
cd HerdRabbit
npm ci --omit=dev
npm run install-service
```

The service installer asks for the password without echoing it:

```text
HerdRabbit 비밀번호 (비워 두면 사용 안 함):
비밀번호 확인:
```

- `herdr` is installed to `~/.local/bin/herdr` from `https://herdr.dev/install.sh` when missing, and updated with `herdr update --handoff` when older than 0.9.0. Installation stops if it is still older afterwards.
- Enter a password to require login in the web app.
- Press `Enter` with an empty password to disable authentication.
- Tailscale setup may request your sudo password for `sudo tailscale serve`.
- If Tailscale is not running, local service installation still completes.

### Direct execution

Run without installing a service:

```bash
npm ci --omit=dev
npm start
```

The default address is:

```text
http://127.0.0.1:38787
```

The one-line installer installs the Web Push and WebAuthn runtime dependencies automatically. Run `npm ci --omit=dev` after a manual clone or update.

## Password and Passkey authentication

Run this as the same Linux user that owns the service:

```bash
cd ~/.local/share/herd-rabbit
npm run password
```

Entering a new password twice replaces the old password and restarts the installed service. Leaving the first input empty disables password authentication. Existing login sessions and registered Passkeys become invalid after either change.

The plaintext HerdRabbit login password is never stored. The `scrypt` hash, session-signing secret, and registered Passkey public data are stored with mode `0600` in the compatibility path:

```text
~/.config/herdr-bridge/auth.json
```

Authenticated sessions have a fixed seven-day maximum lifetime. Every API request requires both an `HttpOnly`, `SameSite=Strict` cookie and a separately signed token stored in the current window's `sessionStorage`. Closing the PWA or tab and opening a new one requires login again by Passkey or password. Reloading or returning from the background in the same window keeps the login. HTTPS connections also use the cookie's `Secure` attribute.

**Signed-in devices** in the ⚙ settings menu at the foot of the sidebar (shown when a password is set) opens a list of browsers: each browser signed in, named by browser and system, with when it signed in and was last used. The list keeps the 64 most recent; signing in past that ends the oldest. A browser that signs in again replaces its own earlier entry instead of adding another. **Sign out** ends one, and its open terminals close at once; **Sign out everywhere** ends all of them, this one included. Neither asks for the password, since they only take access away. The row marked `(this device)` has the **Sign out** that ends this browser's own session; when this browser signed in before the list existed and has no row, **Sign out this device** at the bottom does the same. The list keeps a hash of each session, never the token, in the auth file. Sign-ins made before the list existed stay valid until they expire and are not listed; **Sign out everywhere** ends them too.

Wrong passwords are counted per caller: the Tailscale login or forwarded address Tailscale Serve reports, or the connecting address. Guesses from one device lock only that device, up to fifteen minutes; a loose limit across all callers still applies.

After the first successful password login, HerdRabbit offers to register a Passkey when the browser supports WebAuthn. Within five minutes of that sign-in the window can register one passkey without typing the password again; after that, registering asks for it. Later login screens show **Sign in with a passkey** beside the password fallback. Depending on the device, the browser can use Face ID, a fingerprint, Windows Hello, the device PIN, a security key, or cross-device QR authentication. The biometric and private key stay on the authenticator; HerdRabbit stores only the credential ID, public key, signature counter, transport metadata, and the name and dates shown in the list below. Passkeys are bound to the exact hostname used during registration, so use the stable Tailscale HTTPS address rather than alternating between addresses.

**Passkeys** in the ⚙ settings menu lists the registered passkeys by name, with the day each was added and last used, and whether it syncs between devices. The name comes from the browser that registered it, such as `Safari · iOS`; passkeys registered before this list existed show as `Passkey` with no dates. Removing one or adding another asks for the password again, so a stolen browser session cannot plant a passkey that outlives it. Removing a passkey signs every other device out -- the usual reason to remove one is a lost device, which may still be signed in -- while the browser that removed it stays signed in; open terminals elsewhere close within 15 seconds. Removing the last one leaves the password. The list and removal work without WebAuthn, so a lost device's passkey can be removed from any browser. The list shows names and dates only; credential IDs and public keys stay in the auth file. To clear every passkey at once, run `npm run password`.

## Usage

### Selecting and restoring a session

Select an agent or pane in the sidebar to show its output. The last selected pane is stored in `localStorage` and restored on reload when it still exists. Browser storage is isolated by origin, so an HTTP LAN URL and a Tailscale HTTPS URL have separate preferences.

Opening a session whose `✓` marks an unviewed completion marks that completion as viewed and turns the `✓` into `○` in the current browser. A later completion has a new state sequence and shows `✓` again.

### Agent status notifications

Use **Notifications** in the ⚙ settings menu at the bottom of the sidebar (it shows On, Off or Blocked) to enable or disable notifications for the current browser or installed PWA. Permission is requested only after pressing this control.

- Titles use `project name · tab name`, led by the server name when more than one server is connected.
- Only completion and input required are sent, as short status-only messages. An agent going idle or an unknown state sends nothing.
- While a HerdRabbit window is in front, no system notification appears: the pane it shows stays quiet, and another pane's alert drops in at the top of the app with a short sound. Tap it to open that pane, or swipe it sideways or up to dismiss it; a short drag snaps back.
- Each state event is sent once, and a newer alert replaces the previous alert for the same session. Opening it launches or focuses the installed PWA and restores the targeted session.

Background delivery uses standards-based Web Push; a Firebase project and FCM SDK are not required. On iPhone and iPad, install HerdRabbit on the Home Screen and allow notifications on iOS/iPadOS 16.4 or newer.

VAPID keys and per-device Push subscriptions are stored with mode `0600` in:

```text
~/.config/herdr-bridge/push.json
```

Project and tab names may appear on the lock screen. Previous commands and request text are not included. Enable notifications only on personal devices.

### Projects and sessions

- Use the top `+` → **New project** to create a named workspace with a default shell. It opens in the selected pane's Herdr session; the session picker lists every machine's running sessions, so a project can be made on another machine too.
- Use a project's `⋯` menu to rename it, add a shell session, or close the project.
- Use a session's `⋯` menu to rename it or close that Herdr tab.
- Collapse or expand a project's child sessions with the arrow beside its name.
- Drag a session to reorder it within its project, or onto another project of the same machine and Herdr session to move it there (it keeps its name; a split session with several panes can only be reordered within its project); drag a project's name to reorder projects. On a phone, hold a row for a moment before dragging; a short tap still selects and a swipe still scrolls. Reordering uses Herdr's `tab.move` and `workspace.move`, moving uses `pane move`.
- Servers and Herdr sessions collapse the same way, so a sidebar listing several machines can be narrowed to the one in use. The choice is remembered per browser.
- Destructive close actions always require confirmation.

A session shows the agent running in it until it is given a name. That is not a name: it changes when the agent does, and two sessions running the same agent read alike. Renaming one puts the name where the agent was, and moves the agent beside the status; a session with several panes keeps its name above the group instead of repeating it on each. Emptying the field takes the name back off and the session shows its agent again. Herdr has no unnamed tab -- `tab rename` insists on a label -- so clearing writes back the number the tab was born with, which the sidebar hides. Project renaming goes to Herdr's `workspace rename`, session renaming to `tab rename`, so both are the same operation a person at that machine would run.

The status word (`idle`, `working`) is not spelled out beside a session. The mark at the far right already carries it (`◐` working, `×` waiting for your answer, `✓` finished and not yet viewed, `○` idle, coloured per state), and rows have no status-coloured border; the selected row is only tinted. A line under the name shows the folder the session runs in when that differs from the name. Hover a session, or read it with a screen reader, to get the status in words.

Run commands such as `cd`, `codex`, or `claude` inside a created shell. Creation uses Herdr's `--no-focus` option so it does not steal focus from the desktop Herdr client.

### Terminal

A pane on this machine is attached: the server runs one `herdr terminal attach` per pane on a pseudo-terminal (node-pty) and every open browser shares it. Typing goes straight to it, the terminal follows the size of the browser that opened the pane or typed into it last (others show that size as it is), and the wheel or a finger drag scrolls Herdr's own history, gliding on after a flick. A browser that opens the pane later gets the recent screen. When another client already holds the pane's attach slot (another web bridge), the pane says so and **Open here** takes it over; otherwise it tries again every few seconds and attaches once that client lets go. If node-pty cannot load, or herdr will not attach a pane, the same terminal mirrors that pane instead: the screen the server polls is redrawn in place on each change. A mirror is read-only to keystrokes -- type into the composer or use the extra keys, which still send to the pane -- and it attaches again on its own once it can.

### Chat

A pane running Claude Code or Codex can also be read as a chat. **Chat** and **Terminal** in the pane header (or `Ctrl`+`J`, `Cmd`+`J` on a Mac) switch between the two in one tap; inside the terminal `Ctrl`+`J` stays the program's, so press it from the composer there. Both live in the same place: switching only hides one and shows the other, so the terminal stays attached, the draft in the composer stays, and each keeps its scroll position. After five minutes in the chat without the terminal, the terminal is let go to save resources and attaches again (Herdr redraws it) when you switch back.

The chat reads the agent's own conversation file for that pane, on this machine or a Herdr SSH machine: the transcript Claude Code writes under `~/.claude/projects`, or the rollout Codex writes under `~/.codex/sessions` (or `$CODEX_HOME`). A Claude pane's transcript is the one of the session herdr reports, followed to where that session went on: a resumed session (`continued-in`), or a background job opened in it, which is found by the job's short id in `~/.claude/jobs/<id>/state.json` (under `$CLAUDE_CONFIG_DIR` when that is set); the latest of these that has a file is shown, so a pane showing a background job (`⑂`) reads that job's conversation (on this machine only). A Codex pane's rollout is found by what herdr reports for the pane (the rollout's path or the thread id, looked up in Codex's thread index `state_*.sqlite` when Node.js has `node:sqlite`, else by the file's name), by the rollout the pane's own Codex process holds open, and as a last resort by a recent answer of one of the directory's threads that the pane's screen shows; on a Herdr SSH machine only the reported path and the thread id are used. Codex's injected instructions, environment context and encrypted reasoning are never shown; its reasoning summaries read like Claude's thinking, and a compaction is marked where it happened. The chat draws the conversation as turns: your prompts as bubbles, the answer as Markdown, and everything the agent did on the way (commands, edits, reads, thinking) folded under one "Worked for 12s · 2 edits · 1 command" row that opens to each call, its diff or output, and the whole output on request. A command row offers **View in terminal**. File paths work as they do in the terminal: the viewer opens what it can show, and any other file name opens its folder in the Files tab. Scrolling up loads earlier turns; the view follows new turns while you are at the end. Markdown is drawn safely: everything is escaped, and only http(s) and mailto links are made. Changes are announced over the terminal socket while the chat is on screen, and each read sends `If-None-Match`, so an unchanged conversation costs nothing.

The last lens chosen is remembered per pane. A pane never chosen for opens in Chat on a phone or touch screen and in Terminal on a desktop. A pane that runs neither Claude Code nor Codex, or whose conversation cannot be read yet (no session reported, no file), shows only its terminal, and the Chat button says why. Sending from the chat uses the same composer and send path as the terminal.

The chat is for reading and answering, so the extra-keys bar (Esc, arrows, Ctrl, …) shows only in the Terminal lens; the composer (files, text, send) stays in both. A message sent from the chat shows at once as a pending bubble, the view jumps to the end and follows the reply, and a "Claude is working · 1m 12s" (or "Codex is working") row stands at the end while the agent works (no animation with reduced motion). `Ctrl`/`Cmd`+wheel, a trackpad pinch or a two-finger pinch over the chat sets the chat's own text size (12-24 px, remembered apart from the terminal's). Copy buttons are icons that turn into a check for a moment once the copy worked.

### Prompt cards

For the selected Claude or Codex pane, whatever status herdr reports (it does not always say blocked while a menu waits), the server reads the pane's screen and turns a menu it finds there into a card; ordinary output, including a numbered list in an answer, is never a card. The cards: Claude Code's tool approvals (Yes / Yes, and don't ask again / No), plans, AskUserQuestion menus (one choice, several, or a typed answer), the review that submits several answers, and its unnumbered menus such as the folder-trust check; Codex's approvals (run a command, apply edits, trust a folder, with its "No, and tell Codex what to do differently" answered by Esc), its plan-mode questions (an option, or a typed answer in the notes of "None of the above"), the questions it queues while it works, and its "Press enter to continue" menus. Only while herdr reports the pane blocked, a screen no reader knows becomes a fallback card with the last lines and basic keys (Enter, Esc, a numbered menu's digits, y/n). A Claude plan or question card takes its words from the call Claude waits on in its transcript (the whole plan of `ExitPlanMode`, the whole question and options of `AskUserQuestion`), since the terminal may have scrolled a long plan away or cut an option short with `…` in a narrow pane; the rows, the keys and what the answer is checked against stay the screen's, and the screen's words remain when the transcript cannot say. A password prompt is never a card. In the Chat lens the card sits at the bottom, above the composer; over the Terminal lens a banner says the agent is asking and **Answer** switches to the chat, or, for a pane with no chat, opens the same card over the terminal. A banner can be dismissed for that prompt.

Pressing an option posts the card's id: the server reads the screen again, refuses with `409 prompt_changed` if the prompt is no longer the one shown (the card then refreshes), sends the cursor moves, and sends the Enter only once the screen shows the cursor on the chosen row. Cards are pushed over the terminal socket only for the selected pane, and only while it is a Claude or Codex pane or is blocked. Herdr machine panes work the same way.

While the pane shows a password prompt (`[sudo] password for …:`, `Password:`, a passphrase or PIN), a message sent from the composer is not kept in its input history or in notification requests.

### Extra keys and drafts

The two-row key bar under the terminal can be edited. Choose **Edit keys** in the ⚙ settings menu at the bottom of the sidebar to open a window where you can add keys from a list (named keys, F1-F12, and the Ctrl, Alt and Shift latches), remove them, and reorder them by dragging a row on a desktop or with each row's up and down buttons on a touch screen. **Custom combination** adds a chord such as `Ctrl`+`R`, `Ctrl`+`Shift`+`Z` or `Ctrl`+`Shift`+`F5` from a base key (or any single character) and the modifiers you pick; a saved combination always sends exactly that chord, while a plain key still takes the Shift, Ctrl and Alt you latched. The layout is saved in this browser, up to 40 keys, and applies at once; **Reset to default** brings back the original bar. The bar stays hidden in the Chat lens.

Each pane keeps its own unsent composer text. Opening another pane saves what you typed and shows that pane's draft; a reload brings the drafts back (up to 30 panes, 8000 characters each, kept a week, stored in this browser). A draft is removed when its message is sent. Text sent as a password answer is not kept as a draft.

### Input

Click or tap an attached terminal and type: text, Tab, arrows, Enter, and Ctrl combinations go to the current pane immediately, including shell and agent completion menus. `Ctrl+Enter` in the terminal sends a line feed (`Ctrl+J`), as a native terminal does, so Claude Code and Codex start a new line instead of sending. Dragging over the terminal selects text instead of sending mouse clicks to the program; a **Copy** button appears over the selection, and `Ctrl`+`C` copies it too. On a phone, hold a finger still for half a second, then drag to select; a short drag still scrolls. The composer below is the draft-and-submit way in, and the only one for a mirrored pane. On a phone, a key on the extra-keys bar tapped after the keyboard was put away does not bring it back. While the keyboard is up the page fits the room above it, so the composer and extra keys stay just above the keyboard, and the terminal keeps its size and shows its bottom rows, where the prompt is; the pane is not resized as the keyboard comes and goes.

`Ctrl`+`F` (`Cmd`+`F` on a Mac) over the Terminal view, or the magnifier in the pane header, opens **Find in terminal**: it searches the pane's whole Herdr history (Herdr's own copy-mode search, a capital letter makes it case-sensitive), shows "3/17", and scrolls the pane's view to the match, for every client of that pane. `Enter` steps to an older match and `Shift`+`Enter` to a newer one; matches on screen are tinted, and `Esc` closes the bar where the view is. From the composer or any other text field `Ctrl`+`F` stays the browser's, and a mirrored pane has no find. Find uses Herdr's copy-mode search over its socket API and was checked on Herdr 0.9.3; on an older Herdr that lacks it the bar says the search failed, with Herdr's reason, and the rest of HerdRabbit works as before.

Over the Chat view the same shortcut and magnifier open **Find in conversation**: it searches the messages already loaded on the page (what is drawn, including open work blocks; work folded shut is not searched), marks every match, shows "3/17", and scrolls the current one to the middle of the view, unfolding a folded code block for it. `Enter` steps up and `Shift`+`Enter` down, `Esc` takes the marks away. While earlier messages are not loaded the bar says so, with a button that loads them.

| Action | Key or control |
| --- | --- |
| Send input in a mouse-oriented environment | `Enter` |
| Insert a newline in a mouse-oriented environment | `Ctrl+Enter` |
| Insert a newline in a touch-oriented environment | `Enter` |
| Send input in a touch-oriented environment | Arrow send button |
| Send from an external keyboard on a touch device | `Ctrl+Enter` or `Cmd+Enter` |
| Recall previous sent input | `↑` |
| Recall later input or restore the current draft | `↓` |

The composer starts at one line, grows with explicit or soft wrapping up to five lines, and then scrolls internally. Submitted text is delivered atomically with Enter through Herdr's `pane run` command.

### Files

The attach button beside the composer, and the folder icon at the foot of the sidebar, both open the **Uploads** dialog. Pick one or more files and choose **Upload**: they go up one at a time into a shared uploads folder on the machine running HerdRabbit, and their absolute paths are inserted into the composer in that order, ready to hand to an agent. A file that fails is named with the reason, and the rest still upload. Nothing is sent until you submit. The dialog also lists what the folder already holds, with a row each for inserting the path, copying it, downloading the file, and deleting it.

Files can also be dropped anywhere on the terminal panel, several at once, without opening anything, and an image pasted with `Ctrl`/`Cmd`+`V` is uploaded the same way — a screenshot goes from the clipboard to a path in the composer in one step, stored under a name that records when it arrived. Ordinary text pasting is unchanged.

Browsing is separate, in the sidebar. It has two tabs: **Sessions** is the project list, and **Files** is a tree of the machine's filesystem. Folders expand in place when you click their name or the arrow beside them, and a folder's own button re-roots the tree there so a deep path stops costing indentation. The path field at the foot of the tab goes straight to a folder, its ↑ button walks to the parent, and dotfiles are always listed. Any file can be downloaded to the browsing device from its row.

The path box at the foot of the tab goes anywhere directly. Typing offers matching folder names — arrow keys move through them and `Enter` opens the highlighted one. The tab reopens wherever browsing last stopped, and the uploads folder is the starting point on a first visit.

Browsing is read-only: nothing in the tree can be changed, and uploading and deleting live in the Uploads dialog instead. Files copied into the folder from a terminal appear in that dialog too. The uploads folder is `~/.local/share/herdrabbit/files` unless `HERDR_WEB_FILES_DIR` names another directory; it is deliberately separate from the configuration directory that holds credentials. Uploads and downloads have no size limit by default; `HERDR_WEB_MAX_TRANSFER_MB` sets one limit (in megabytes) for both. The folder itself has no size or file-count limit, so it grows until the disk is full and nothing is removed on your behalf.

With more than one machine registered, the Files tab gains a picker: choose one and the tree shows that machine, starting at its home. Each machine remembers its own last folder.

That choice is also where uploads go. Until one is made, a file you attach or paste follows the session you are looking at, and the path is inserted into the composer. Pick a machine and it is pinned for both browsing and uploading, across reloads. When the pinned machine is not the one the selected session runs on, the path is **not** inserted -- it would name a file that session cannot open -- and the upload says where it went instead. The attach button and the uploads dialog name the machine either way.

A Herdr SSH machine's files are read and written over its SSH connection with a few fixed commands (see Herdr SSH machines). The confinement is the same on every machine: browsing is read-only, and writes reach only that machine's own uploads folder.

On iOS, a browser in standalone PWA mode may open a downloaded file instead of saving it. Use the share sheet to store it.

A file an agent names in its output is a link to itself. "wrote `src/api.mjs`", "see `./docs/plan.md`" -- the path opens in the viewer, resolved against the pane's own directory when it is relative. A file the viewer cannot show (say `app-release.aab`) opens the Files tab in its folder with that file selected, or says so when the file is no longer there. A folder written out in full is a link too: an absolute path (`/home/me/proj`) or one starting with `./` or `../` opens the Files tab inside that folder, and a path whose last name turns out to be a file there is selected in its parent instead; a closing slash (`/home/me/proj/`) means folder. Any other path becomes a link only when its last name is a file the viewer can show or has an extension (`name.ext`, with at least one letter in it), which is what keeps `src/foo`, `node_modules/`, `feat/settings-menu`, `1/2`, `.env`, `v1.2` and `10.0.0.1` plain. A lone `/word` (a slash command such as `/compact`), `//host/share` and the path inside a web address are not folder links; `~` is left alone, because that home belongs to the machine the pane runs on. In the live terminal, these paths and web addresses are underlined all the time, so they can be seen and tapped on a phone, and an address the output wrapped onto the next line is still one link. A path with spaces is one link when it is quoted -- `"/home/me/my folder"`, `'./build output/app.aab'` -- and starts with `/`, `./` or `../`; the link covers what is inside the quotes, backticks count as quotes in the terminal too, and without quotes a path ends at its first space. A relative path links only when the pane's own directory is known. A path is a path in any script (`/home/me/프로젝트`), and a Korean particle written straight after a file name (`src/a.md를`) is not part of it. The chat view finds paths with the same code as the terminal, so the same text links the same paths in both. The one difference is a code span: the whole span is taken as one path, so a name written alone there (`app.js`) is a link too, and so is a path with spaces (`` `/home/me/my folder` ``), the backticks quoting it. Joining a path the output wrapped onto the next row is the terminal's alone; chat text is not wrapped.

A file can be opened instead of downloaded. Images, video and audio play in place, Markdown and HTML are drawn, and text, code, logs and config are shown as characters. Reading a log on a phone should not mean saving it first.

What may be shown, and as what, is decided from the name against an allow-list, never by sniffing the bytes. Nothing gets to run, but the two formats that could are handled by how they are shown rather than by refusing them: an SVG goes in an `<img>`, which executes no script, and an HTML file is framed by a response whose own policy ends in `sandbox` -- an opaque origin with no script, for anyone who opens that URL and not only for the frame, which is also what lets a saved report keep its own stylesheet. Both were measured against a file that tried to call home and neither reached anything. Markdown goes the same way: the server renders it with `marked` and sends the result, so it lands in the same frame with the same policy and the browser downloads nothing extra. Which hrefs may become links, and what happens to markup embedded in the document, are decided here rather than by the parser: http(s) or it stays text, and embedded markup is shown as the characters it is made of. Any of them can be read as its own source instead, one press away. A PDF opens in a tab rather than in the dialog. Framing one is the part browsers disagree about -- Android Chrome draws nothing in a frame, iOS Safari draws the first page -- while a tab is not framing at all, works everywhere, and gives a page-shaped document the full height it was written for. It also means a PDF needs no exception to the framing rules and gets none: only HTML is reopened, and an image response still says `frame-ancestors 'none'`. Text works the same way -- opaque bytes in, characters out, no content type negotiated. Downloads are unchanged: still `application/octet-stream` as an attachment, which is what keeps a stored page from ever running at this origin.

Video seeks: a view link answers byte ranges, on a Herdr SSH machine as well, because the machine holding the file is the one that slices it.

### AI accounts

A subscription CLI stops at its session or weekly limit, and moving to another account normally means signing in again. **AI accounts** in a server's row menu keeps each account's sign-in on that machine so switching is one press. Claude Code and Codex are supported.

For each CLI the dialog is a list of email addresses from A to Z, with the one in use marked in its place. Opening it saves the account signed in now, so there is nothing to save by hand. A line appears under an account only when it needs a new sign-in within a week or already does; Claude Code sign-ins last about a month, and Codex does not record when its own will end. Nothing else about an account is shown.

- **Add account**, at the end of each list, opens an `AI login: …` project and types the sign-in command there: `claude auth login`, or `codex login --device-auth`, pointed at an empty directory of its own. Signing in where the live account lives would revoke that account, which is why it happens apart. Codex's device code sign-in has to be turned on in ChatGPT's security settings first. Signing in is noticed on its own: the page checks every few seconds whether the CLI has written its sign-in into that directory, saves the account the moment it has, and closes the project. AI accounts then opens again with the new account marked **Just added**, unless another dialog is open. A reload does not lose the wait: the machine keeps which sign-ins are still open, and the page picks them up again when it starts or when AI accounts is opened. It stops checking after 20 minutes, and **Cancel sign-in** in AI accounts ends it sooner. What you type into that project is not kept in prompt history.
- **Switch**, in an account's ⋯ menu, changes the account for the whole machine. Settings, MCP servers, conversation history and memory stay as they are, so `claude --continue` or `codex resume` picks up where the other account stopped. The account being replaced is saved first, which keeps the tokens the CLI rotated while using it. If Herdr shows the CLI running in any pane, the switch lists those panes and waits for confirmation; they keep the old account until restarted. A CLI started outside Herdr is not seen.
- **Remove**, in the same menu, deletes the saved copy. It does not sign the account out anywhere.

Each machine keeps its own accounts. On a Herdr SSH machine the saving, signing in and switching run there (see Herdr SSH machines), and only whose account is where comes back; no sign-in travels between machines.

Saved sign-ins are stored in `~/.config/herdr-bridge/ai-accounts`, or the directory in `HERDR_WEB_AI_ACCOUNTS_DIR`, as mode-`0600` files inside mode-`0700` directories that only the owning OS user can read.

The CLI's own files are what gets switched: `~/.claude/.credentials.json` plus the `oauthAccount` field of `~/.claude.json`, and `~/.codex/auth.json`, or the directories in `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the HerdRabbit service sees them. Codex set to store sign-ins in the keyring cannot be switched and says so, and `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment still overrides whatever account is saved. Claude on macOS keeps sign-ins in the Keychain and is not supported.

### Output and history

Terminal output and history come only from Herdr's own screen and scrollback. Claude's JSONL transcript and Codex's rollout are never merged into the terminal; only the Chat lens reads them, as its own view (and a Claude plan or question card takes its words from them). In an attached terminal the wheel or a finger drag scrolls Herdr's own history; a mirrored pane shows its current screen only. History Herdr no longer holds cannot be shown. Claude must run in the plain terminal mode the installer configures for its scrollback to be readable.

During install and update, the current user's global Claude settings (`~/.claude/settings.json`, or the path in `CLAUDE_CONFIG_DIR`) get `tui: "default"` and `env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1"`, so ordinary terminal scrolling is used instead of Claude's own. Existing settings are backed up beside the file as `settings.json.herdrabbit-*.bak` and other keys are preserved. A running Claude picks this up after a restart. Each machine that runs HerdRabbit applies it during its own install or update; a Herdr SSH machine is not changed. The settings survive Claude's own updates. To apply it by hand: `node scripts/configure-claude.mjs`.

Live terminal input (including composer submissions and extra keys) and output use `/api/terminal` WebSocket. An attached pane streams Herdr's own output. For a mirrored pane, after the initial snapshot only changes are sent; Herdr reports no general screen change outside a terminal attach, so the server observes output: 50 ms after each read during activity, 500 ms when quiet, shared by viewers of the same pane and line range. Background pages disconnect and receive a fresh snapshot on return. Session status uses Herdr `pane.agent_status_changed` events over WebSocket, including unselected sessions. Project/session lists still refresh over HTTP every two seconds and resynchronize after the status subscription starts. HTTP list refreshes also cover subscription failures while retrying. Authentication and project/session management remain HTTP. Push notifications are unchanged.

### Display settings

Use the control at the bottom of the sidebar to switch between light and dark mode. Adjust terminal and composer text size with `Ctrl`/`Cmd` + wheel or trackpad zoom. On mobile, pinch over the terminal with two fingers. The selected size is saved in `localStorage`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HERDR_WEB_HOST` | `127.0.0.1` | Any literal address to listen on: `127.0.0.1`, `0.0.0.0`, or one interface such as this host's Tailscale address. A single address is the tightest option -- the service is then absent from every other network the machine is on, and that address is accepted as a request host automatically. Names are refused, since they resolve at listen time. |
| `HERDR_WEB_PORT` | `38787` | Listening port from 1024 through 65535 |
| `HERDR_WEB_ALLOWED_HOSTS` | empty | Additional reverse-proxy or Tailscale hostnames, comma-separated |
| `HERDR_WEB_MAX_TRANSFER_MB` | unset (no limit) | Largest single upload or download, in megabytes (a positive integer). Unset means no limit; on a shared or low-disk host, setting one is a good idea. |
| `HERDR_WEB_AUTH_FILE` | `~/.config/herdr-bridge/auth.json` | Password hash and signing-secret file |
| `HERDR_WEB_PUSH_FILE` | `~/.config/herdr-bridge/push.json` | VAPID keys and browser Push subscriptions |
| `HERDR_WEB_AI_ACCOUNTS_DIR` | `~/.config/herdr-bridge/ai-accounts` | Saved Claude Code and Codex sign-ins |
| `HERDR_BIN` | `herdr` | Herdr executable path |

Example:

```bash
HERDR_WEB_HOST=0.0.0.0 \
HERDR_WEB_PORT=38787 \
HERDR_WEB_ALLOWED_HOSTS=my-server.example-tailnet.ts.net \
HERDR_BIN="$HOME/.local/bin/herdr" \
npm start
```

`127.0.0.1` is the recommended value for local and Tailscale Serve access. Use `0.0.0.0` only when direct LAN access is intentional. Password protection does not make direct public-internet exposure appropriate because authenticated users can write to your Herdr terminal panes and read any file that account can read.

## systemd user service

The recommended setup is:

```bash
npm run install-service
```

New installations try `38787`, then search `30000–39999` while excluding local listeners and existing Tailscale HTTPS ports. Reinstalling an existing user service preserves its assigned port.

For a manual service installation, review and adapt [`systemd/herdrabbit.service`](systemd/herdrabbit.service), then run:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/herdrabbit.service ~/.config/systemd/user/
systemctl --user edit --full herdrabbit.service
systemctl --user daemon-reload
systemctl --user enable --now herdrabbit.service
```

Inspect the service with:

```bash
systemctl --user status herdrabbit.service
journalctl --user -u herdrabbit.service -f
```

To keep the per-user service running after logout, enable linger if allowed by the machine's policy:

```bash
sudo loginctl enable-linger "$USER"
```

## Tailscale Serve HTTPS

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) proxies tailnet-only HTTPS requests to HerdRabbit's loopback listener. Both the server and client device must be connected to the same tailnet.

The automatic installers perform this setup. For manual setup:

```bash
tailscale status
tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")'
```

Add the resulting DNS name, without a scheme or port, to `HERDR_WEB_ALLOWED_HOSTS`, restart HerdRabbit, and register the HTTPS port. For port `38787`:

```bash
systemctl --user restart herdrabbit.service
sudo tailscale serve --bg --yes --https=38787 http://127.0.0.1:38787
tailscale serve status
```

Expected shape:

```text
https://my-server.example-tailnet.ts.net:38787 (tailnet only)
|-- / proxy http://127.0.0.1:38787
```

The `--bg` configuration survives Tailscale and machine restarts. Remove every Serve rule with `sudo tailscale serve reset`. Do not use Tailscale Funnel for HerdRabbit.

## Install the PWA

- **Chrome or Edge desktop:** open the Tailscale HTTPS URL and use the browser's install-app action.
- **iPhone or iPad:** open the HTTPS URL in Safari, use Share, then **Add to Home Screen**.
- **Android:** open the HTTPS URL in Chrome and choose **Install app** or **Add to Home screen**.

If an older name, icon, or app shell remains cached, fully close and reopen the PWA. Reinstalling the PWA may be required for an OS-level app-name or icon cache.

## Update

```bash
cd ~/.local/share/herd-rabbit
sh ./update.sh
```

Run as the Linux account that installed the service. The updater uses its own directory, or `HERD_RABBIT_INSTALL_DIR`. It requires a clean `main` branch and the official origin, fetches `main`, updates the service's Herdr with `herdr update --handoff` (running panes stay alive), then fast-forwards `main`, installs dependencies, verifies, and restarts the matching user service. Herdr is checked against the minimum the incoming code requires before any file changes: a failed Herdr update continues when the installed Herdr is new enough, and stops the update with nothing changed otherwise. A lock prevents concurrent updates. Local changes or divergent commits stop the process before anything changes. When dependency installation, verification, or the restart fails after `main` moved, the updater resets to the previous commit, reinstalls its dependencies, and restarts that version if it had already restarted. Herdr itself is not rolled back. Configuring Claude's terminal scrollback runs after verification and is not rolled back either: if it fails, the update stops before restarting, and the next restart runs the verified new code. Ports, authentication, Tailscale settings, and Herdr SSH machines are preserved. If an older installation lacks `update.sh`, run `git pull --ff-only` once first. An installation older than 1.2.10 runs its own earlier `update.sh`, which does not update Herdr: run `herdr update --handoff` outside Herdr before that first update. HerdRabbit warns at startup and in the machine's Details while Herdr is older than 0.9.0.

The Service Worker reloads the page once when it activates a new app shell. Manually refresh a tab that has remained open for a long time.

## Verification and development

```bash
npm run verify
npm run check:browser   # Playwright checks against a fake Herdr (needs `npx playwright install chromium`)
npm run dev
```

`npm run check` finds every script under `src`, `public` and `scripts` and checks its syntax, along with `install.sh` and `update.sh`, so a new file needs no registration. GitHub Actions runs `npm run verify` on every pull request and on pushes to `main`.

Tests use a fake Herdr executable and temporary state. They do not write to real terminal panes or create and close real workspaces or sessions.

```text
public/   browser UI, PWA manifest, Service Worker, and icons
scripts/  bootstrap, service installation, Herdr installation, and password tools
src/      HTTP server, validation, authentication, and Herdr CLI adapters
systemd/  example per-user service unit
test/     unit and integration tests plus fake Herdr
```

## Troubleshooting

### `421 Request host rejected`

Add the current DNS hostname, without a scheme or port, to `HERDR_WEB_ALLOWED_HOSTS` and restart the service.

### This machine's icon turns red

The machine icon on this machine's row in the sidebar turns red when this page cannot reach HerdRabbit, and hovering it shows why. Every machine row also has a small dot: green while HerdRabbit reaches that machine, grey while it does not. This machine's row is labelled Host.

```bash
systemctl --user status herdrabbit.service
herdr status server
herdr api snapshot
journalctl --user -u herdrabbit.service -n 100 --no-pager
```

### `Herdr returned invalid JSON`

This means a Herdr command that should return JSON did not do so. Verify `HERDR_BIN` and run `herdr api snapshot` directly.

### Tailscale HTTPS does not open

```bash
tailscale status
tailscale serve status
systemctl --user status herdrabbit.service
```

Confirm that server and client use the same tailnet, MagicDNS and HTTPS certificates are enabled, and the tailnet ACL permits the client.

### Forgotten password

Open a shell on the machine as the service's OS user and run `npm run password`. The old password is not required. Replacing or disabling it invalidates existing sessions and registered Passkeys.

### Installer cannot find a port

The installer stops only when every port in `30000–39999` is already used by a local listener or Tailscale Serve rule.

```bash
ss -ltn
tailscale serve status
```

### Old UI or icon remains visible

Close every tab or installed PWA window and reopen it. If necessary, clear site data or reinstall the PWA. Clearing site data also resets the selected pane, collapsed workspaces, theme, and terminal font size.

## Security boundaries

- The default listener is `127.0.0.1`.
- This remains a personal single-user tool even when the repository is public.
- HerdRabbit login passwords are stored only as `scrypt` hashes in a mode-`0600` file. Herdr SSH machines are reached with your own SSH keys; HerdRabbit stores no credential for them.
- Passkey private keys and biometric data never reach HerdRabbit; only public credential data is stored.
- Protected APIs require both a signed `HttpOnly` cookie and a separate signed current-window token.
- HTTPS cookies use `Secure`; all login cookies use `SameSite=Strict`.
- Changing or disabling the password invalidates existing sessions and removes registered Passkeys.
- Adding or removing a Passkey from the browser asks for the password again, so a stolen session cannot plant a sign-in that outlives it. Removing one signs every other session out.
- After five wrong passwords, password checks lock for 1 s, then twice as long after each further mistake, up to 15 minutes. Sign-in and the recheck count apart, so guesses at the sign-in screen cannot stop a signed-in owner from removing a lost device's passkey. A right password resets the count, Passkey sign-in keeps working while it is locked, and only one password is checked at a time -- a guess sent while another is being checked is refused.
- Herdr commands use shell-free `execFile` argument arrays.
- Session, workspace, tab, pane, label, input length, output row count, and command duration are validated and bounded.
- The browser cannot invent a Herdr persistent session; only recently discovered running sessions are accepted.
- Destructive close APIs require an explicit confirmation value.
- Write APIs require both a per-process CSRF token and a same-origin request.
- Allowed request hosts are restricted, CORS is not enabled, and strict CSP, frame, and MIME-sniffing protections are sent.
- The Service Worker caches only static app-shell files, never API responses or terminal output.
- Writes reach only this machine's uploads folder, which sits outside the configuration directory holding the password hash and VAPID keys. Upload and delete cannot address a path outside it: names from the URL are rejected rather than repaired, and the target is taken from the directory listing rather than a composed path.
- Browsing is read-only and reaches **every path the service account can read on this machine**. There is no path allow-list; the OS file permissions are the boundary. That includes `~/.ssh`, `~/.config/herdr-bridge/`, and `/proc/self/environ`. This is not an escalation, because an authenticated client can already run arbitrary commands as that account through a terminal pane — but it is a further reason not to run HerdRabbit as root or as a shared account.
- No machine holds another's credentials. Each runs its own Herdr, and an SSH machine's sign-ins and files stay on it.
- Reading a file this way leaves no trace in any pane's history, works with no Herdr session running at all, and streams at link speed. Terminal-borne copying does none of those things.
- Regular files only. Directories, devices, and FIFOs are refused after the file is opened non-blocking, so a named pipe cannot stall the server. Files are served as `attachment` with `application/octet-stream`. Downloads have no size limit by default; `HERDR_WEB_MAX_TRANSFER_MB` sets one. A file that reports a size of 0 (procfs, sysfs) streams without a length and is cut off at 1GB.
- Downloads are fetched through a single-use ticket that expires in 30 seconds, so no file path appears in a URL. Directory paths and the server they belong to do appear in the browse request URL and will be recorded by any reverse proxy in front of HerdRabbit.
- Stored files are mode `0600` inside a mode-`0700` directory, and are always served as `attachment` with `application/octet-stream` so an uploaded HTML or SVG file cannot render in the browser.
- Uploads have no size limit by default, but must declare a `Content-Length`. When `HERDR_WEB_MAX_TRANSFER_MB` sets a limit, a larger upload is refused from that header before any of the body is read. An upload may take as long as it keeps sending; it is dropped only after 2 minutes without a byte. The uploads folder has no total size or file-count limit, so disk space is the only bound.
- Accepting a whole file in one request raises the body-receive timeout to two minutes for every route. The header timeout is unchanged, so slow-header attacks are still cut off, but a slow body is not.
- VAPID private keys and Push subscription URLs are stored in a mode-`0600` file readable only by the owning OS user.
- Saved AI CLI sign-ins are copies of the CLI's own credential files, mode `0600` inside mode-`0700` directories, and they are only ever copied between that directory and the CLI's. No API response, error, log line or browser storage carries a token: the account routes answer with an email, a plan and a sign-in expiry. This machine never receives an SSH machine's sign-ins. Anyone who can use this HerdRabbit can switch its accounts, which is no more than a terminal pane already allows.
- A sign-in project only ever receives a command naming its empty directory. Its one-time sign-in code is not kept in prompt history, and the project is closed when the sign-in is finished or cancelled.
- Browser storage contains UI preferences and the current-window launch token, not terminal history or the password.

## License

[MIT](LICENSE)

Third-party code and its notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
