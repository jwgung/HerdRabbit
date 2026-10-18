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
- Show every pane as Herdr itself draws it (a real `herdr terminal attach` in xterm.js), on this machine and on PCs added with Connect PC, so full-screen TUIs, the cursor and colors match; a pane that cannot attach is mirrored read-only in the same terminal
- Read a Claude Code or Codex pane as a chat: its conversation as turns, the agent's tool calls folded under one "Worked for …" row, older turns loaded as you scroll up. A **Chat** / **Terminal** switch in the pane header (or `Ctrl`/`Cmd`+`J`) flips between the two without reconnecting anything
- Answer what an agent asks (tool approvals, questions, menus) with buttons on a card at the bottom of the chat, or from a banner over the terminal
- Each pane keeps its own unsent draft, also across a reload
- Send text and shell commands, or use a two-row extra-key bar (Ctrl/Alt/Shift, Esc, Tab, Home/End, PgUp/PgDn, arrows, slash, minus and Enter by default; edit it with **Edit keys**). Select modifiers, then tap a key or type it on your keyboard (for example Ctrl → End or Ctrl → C); on a phone keyboard, the letter typed after a modifier goes as that key and does not stay in the composer. PgUp and PgDn page through the terminal history a screen at a time, as a finger or the wheel does; hold Shift first to send the plain key to a program that pages itself, such as less or vim. With Ctrl or Alt held, or in a mirrored pane, they send their keys as before. Modifiers clear after one send or when switching panes. Ordinary composer shortcuts remain local unless a screen modifier is selected.
- Create shell workspaces and tabs, rename workspaces and sessions, and close tabs or workspaces after confirmation
- View images, video, audio, Markdown and text in the browser instead of downloading them first
- Manage every machine from its row in the sidebar, this one included: read its name and versions, and rename or disconnect a PC added with Connect PC (or find it again after it moved port)
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

### Other PCs running HerdRabbit (Connect PC)

Both PCs must be on the same tailnet with Tailscale running (with it off there is no tailnet address, so `HERDR_WEB_PEER_HOST` cannot be set and the `tailscale whois` check cannot work).

Every PC runs the same HerdRabbit: its own page and login, on `127.0.0.1` behind Tailscale Serve, as installed by the [quick install](#quick-install). A PC can also open a **Connect PC port** for other PCs: that lets another PC's HerdRabbit show this PC's sessions on its own page. It is one-way -- if A connects to B, B shows up on A's page, not the other way round -- and B keeps its own page and login either way.

**On the PC being connected to (B):** open its Connect PC port and say which PCs may use it. Re-run `npm run install-service` there and answer the Connect PC question ("다른 PC가 이 PC에 붙을 수 있게 열까요?"), then pick the allowed PCs from the tailnet list; or set it by hand:

| Variable | Meaning |
| --- | --- |
| `HERDR_WEB_PEER_HOST` | This PC's tailnet address (for example `100.64.0.2`). Setting it opens the Connect PC port; unset (the default) keeps it closed. Only an address in Tailscale's ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) or loopback is accepted -- never every interface (`0.0.0.0`, `::` in any spelling) or a LAN address; anything else stops the service from starting. |
| `HERDR_WEB_PEER_PORT` | Its port: an integer from 1024 to 65535, `38788` by default. It cannot share the page's port on the tailnet address, which Tailscale Serve holds. |
| `HERDR_WEB_PEER_ADDRESSES` | Tailnet addresses of the PCs allowed to connect, comma-separated. Only tailnet addresses (and loopback, for trying it on one PC) are accepted. |
| `HERDR_WEB_PEER_LOGINS` | Tailnet accounts allowed to connect, comma-separated, looked up for each caller's address with `tailscale whois`. With both lists set, a caller has to match both. |
| `HERDR_WEB_HUB` | Optional: the page of the PC that should connect, such as `https://laptop.tailnet.ts.net:38787`. This PC then tells it where its Connect PC port is, which matters only on a port other than the default. |

With both allowed lists empty, the port refuses everyone.

**On the PC that connects (A):** use **+ → Connect PC** at the top of the sidebar. The dialog lists the PCs on your tailnet and says what each one is: ready, already added, running HerdRabbit but not allowing this PC, on another connection protocol, or with nothing to connect to (no Connect PC port, or offline -- these fold away behind a count). Pick a ready one, or open **Enter an address** and type its Connect PC address (`http://100.64.0.2:38788`). **Save** stays disabled until **Test connection** succeeds for what is in the form. Nothing is stored on either side but the name and address: B recognises A by the address its requests arrive from, so there is no key or password to keep anywhere. Connected PCs are kept in `~/.config/herdr-bridge/servers.json` (mode `0600`, or `HERDR_WEB_SERVERS_FILE`) and shared by every browser using A.

A scan only tries the default port. A PC on another port -- a second account on the same PC, say -- announces itself instead when `HERDR_WEB_HUB` names A, and A lists it beside what it found. An announcement only puts a row in the list; adding it is still a choice, and choosing still probes the address. A PC may announce only itself, and only from your own tailnet account. What was announced is kept in `~/.config/herdr-bridge/announced.json`; an address a look proves empty is dropped, and the list is capped.

**Versions.** Two PCs connect when they speak the same **connection protocol**, a number that changes only when what they exchange does; their HerdRabbit versions may differ, and Details shows both. A PC on another protocol is shown offline, and its status and Details name both PCs' protocol and HerdRabbit version, so you can tell which one to update.

A connected PC's row menu has **Details** (kind, address, its HerdRabbit version beside this PC's, connection protocol, Herdr version), **AI accounts**, **Rename**, **Disconnect**, and, while it is offline, **Find new address**: a PC that moved to another port keeps its tailnet address, so this looks again and repoints the entry if it answers elsewhere. This PC's own Details shows its Connect PC address and how many PCs it allows.

What a connected PC does today: its projects, sessions and panes are listed with their agent status (streamed from B), its panes are attached as real terminals (typing, resizing and wheel scrolling included) and **Find** searches their whole Herdr history on B, text and keys reach its panes, projects and sessions are created, renamed, closed and dragged into order on B, the Files tab and uploads use B's own disk, path links open B's files, prompt cards answer B's agents (a Claude plan or question card with its whole words from B's transcript), **Chat** shows B's Claude and Codex panes, and **AI accounts** switches B's sign-ins on B. A PC on an older HerdRabbit keeps its panes mirrored, says it is too old to search them, and its Chat button says to update it; update it there.

A connected PC's pane is attached on that PC: B runs `herdr terminal attach` on its own pseudo-terminal, exactly as for its own page, and A relays it over one WebSocket on B's Connect PC port, which A's browsers share as they share a local pane (the recent screen for a late joiner, the size set by whoever opened or typed last, **Open here** when another client holds the pane). A never learns B's Herdr binary or socket: it asks which terminal the pane has, then asks B to attach it. A PC without node-pty, or one on a HerdRabbit from before this, shows its panes mirrored as before; A needs no node-pty of its own for B's panes.

### Herdr SSH machines (removed)

Earlier versions also listed Herdr's own SSH machines (`herdr machine add`) beside this one. That support has been removed in favour of Connect PC, which attaches, searches, chats, answers prompt cards, browses files and switches AI accounts on the other PC itself. To bring such a PC back, install HerdRabbit on it and add it with **+ → Connect PC**. HerdRabbit leaves Herdr's own machine list as it is; while it still names machines, the page says this once per browser.

### Every machine in one sidebar

All machines appear together as **machine → Herdr session → project → tab/pane**; selecting a pane sends input and reads output on that machine. Each machine refreshes on its own, with slower retries after a failure, so an unreachable one does not hold up local data; its last-known panes stay visible while it is marked offline. A machine's sessions appear in the project/session picker, and projects and tabs can be created, renamed and closed there.

A machine is managed where it is seen, and every machine has a row -- this one too, even when it is the only one. Its `⋯` menu opens **Details** -- the machine's name, the HerdRabbit version answering for this machine, its Herdr version (marked when it is older than 0.9.0; this machine also logs that at startup), and how many Herdr sessions and panes it contributes -- and **AI accounts**. Browser-wide settings (including **Passkeys** and **Signed-in devices**) are in the ⚙ menu at the foot of the sidebar, not here. Details are the first thing worth reading when a machine will not connect.

### PCs installed as a leaf by an older version

Older versions connected PCs the same way but called the connected PC a "leaf": it had no page of its own and answered only its hub (`HERDR_WEB_ROLE=leaf`). Such a unit keeps working: its leaf address and port become its Connect PC port, so the hub that saved it still connects, and it gains a page on `127.0.0.1`. A leaf never had a password, so until it has one that page answers only a 503 saying to set it (the Connect PC port is unaffected). Run `npm run install-service` there to write an ordinary unit with a password; it offers to keep the Connect PC port and its allowed PC. The installer moves the port off the page's port, which Tailscale Serve then holds, so use **Find new address** on the hub afterwards. A leaf that sat on loopback behind `tailscale serve` cannot be reached that way any more; open a Connect PC port for it as above.

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

### Install as a Herdr plugin

HerdRabbit can also be installed as a [Herdr plugin](https://herdr.dev/) (Herdr 0.9.0 or newer, Node.js 22+ and npm on `PATH`):

```bash
herdr plugin install ultivis-iot/HerdRabbit
```

- **Build:** after you confirm, Herdr runs `npm ci --omit=dev` in its own checkout of the plugin.
- **Startup:** each time Herdr starts (and after a live handoff), the plugin starts HerdRabbit in the background unless a HerdRabbit already answers. It does nothing while the systemd service (`herdrabbit.service`, or the older `herdr-web-local.service`) is active, so the two never run side by side.
- **Actions:** `herdr plugin action invoke herdrabbit.start`, `herdrabbit.stop`, `herdrabbit.status` and `herdrabbit.restart`. Stop only ever ends the server the plugin started itself; it never touches the systemd service. Status also says when the running server is still on an older checkout after `herdr plugin update`, so you know to restart it.
- **Connect pane:** `herdr plugin pane open --plugin herdrabbit --entrypoint connect` shows the page addresses (this PC, and the Tailscale Serve HTTPS address when one forwards to the port), whether a password is set, and how to set one. With `qrencode` installed it also draws a QR code for the phone address.
- **Password:** `herdr plugin pane open --plugin herdrabbit --entrypoint password` asks for it without echoing and restarts the plugin's server. The password is never written to the plugin's settings.
- **Settings:** `herdr plugin config-dir herdrabbit` prints the folder holding `.env`, created on first start as a commented template. It takes the `HERDR_WEB_*` variables from [Configuration](#configuration) and `HERDR_BIN`, one `KEY=VALUE` per line; restart afterwards. The server log and its pid file live in the plugin's state folder, not in the checkout.

The systemd service from the [quick install](#quick-install) remains the recommended way on Linux: it starts at login without Herdr and also registers Tailscale Serve. The service installer is Linux-only, so on macOS the plugin is the way to keep HerdRabbit running. Either way, a phone still reaches the page through Tailscale Serve; see [Tailscale Serve HTTPS](#tailscale-serve-https).

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

A pane on this machine is attached: the server runs one `herdr terminal attach` per pane on a pseudo-terminal (node-pty) and every open browser shares it. Typing goes straight to it, the terminal follows the size of the browser that opened the pane or typed into it last (others show that size as it is), and the wheel or a finger drag scrolls Herdr's own history, gliding on after a flick. A browser that opens the pane later gets the recent screen. When another client already holds the pane's attach slot (another web bridge), the pane says so and **Open here** takes it over; otherwise it tries again every few seconds and attaches once that client lets go. A pane of a PC added with Connect PC attaches the same way, on that PC (see [Other PCs running HerdRabbit](#other-pcs-running-herdrabbit-connect-pc)). If node-pty cannot load, or herdr will not attach a pane, the same terminal mirrors that pane instead: the screen the server polls is redrawn in place on each change. A mirror is read-only to keystrokes -- type into the composer or use the extra keys, which still send to the pane -- and it attaches again on its own once it can.

When the terminal is not live, a strip over its top edge says why: "Disconnected from HerdRabbit — retrying in 4s" (the server restarted, the network went away, or the phone slept), "Herdr is not answering", "This pane is gone", a Connect PC that is offline, refuses this PC or is too old, or "Sign-in expired — reload to sign in again". Where trying again can help it offers **Reconnect**, which tries at once instead of waiting out the retry. A pane that can only be mirrored says so quietly ("Shown read-only: this PC can't attach terminals") with no button. A normal connect shows nothing unless it takes more than about three seconds, the strip goes as soon as the terminal is live again, a pane another client holds keeps its **Open here** strip instead, and the Chat view never shows it.

### Chat

A pane running Claude Code or Codex can also be read as a chat. **Chat** and **Terminal** in the pane header (or `Ctrl`+`J`, `Cmd`+`J` on a Mac) switch between the two in one tap; inside the terminal `Ctrl`+`J` stays the program's, so press it from the composer there. Both live in the same place: switching only hides one and shows the other, so the terminal stays attached, the draft in the composer stays, and each keeps its scroll position. After five minutes in the chat without the terminal, the terminal is let go to save resources and attaches again (Herdr redraws it) when you switch back.

The chat reads the agent's own conversation file for that pane on this machine: the transcript Claude Code writes under `~/.claude/projects`, or the rollout Codex writes under `~/.codex/sessions` (or `$CODEX_HOME`). A Claude pane's transcript is the one of the session herdr reports, followed to where that session went on: a resumed session (`continued-in`), or a background job opened in it, which is found by the job's short id in `~/.claude/jobs/<id>/state.json` (under `$CLAUDE_CONFIG_DIR` when that is set); the latest of these that has a file is shown, so a pane showing a background job (`⑂`) reads that job's conversation (on this machine only). A Codex pane's rollout is found by what herdr reports for the pane (the rollout's path or the thread id, looked up in Codex's thread index `state_*.sqlite` when Node.js has `node:sqlite`, else by the file's name), by the rollout the pane's own Codex process holds open, and as a last resort by a recent answer of one of the directory's threads that the pane's screen shows. Codex's injected instructions, environment context and encrypted reasoning are never shown; its reasoning summaries read like Claude's thinking, and a compaction is marked where it happened. The chat draws the conversation as turns: your prompts as bubbles, the answer as Markdown, and everything the agent did on the way (commands, edits, reads, thinking) folded under one "Worked for 12s · 2 edits · 1 command" row that opens to each call, its diff or output, and the whole output on request. A command row offers **View in terminal**. File paths work as they do in the terminal: the viewer opens what it can show, and any other file name opens its folder in the Files tab. Scrolling up loads earlier turns; the view follows new turns while you are at the end. Markdown is drawn safely: everything is escaped, and only http(s) and mailto links are made. Changes are announced over the terminal socket while the chat is on screen, and each read sends `If-None-Match`, so an unchanged conversation costs nothing.

A pane of a PC added with Connect PC (B) is read by B itself: B finds and reads its own transcripts exactly as its own page does (the Codex rollout by B's own processes and screen too), and A only relays the pages, a tool's whole output, the plan or question a prompt card shows, and a short change signature that A asks for every 1.5 seconds while the chat is on screen. B answers this only for its own panes, never for a PC it reaches itself, and no transcript path or file crosses the link beyond what the page already shows.

The last lens chosen is remembered per pane. A pane never chosen for opens in Chat on a phone or touch screen and in Terminal on a desktop. A pane that runs neither Claude Code nor Codex, or whose conversation cannot be read yet (no session reported, no file), shows only its terminal, and the Chat button says why. Sending from the chat uses the same composer and send path as the terminal.

The chat is for reading and answering, so the extra-keys bar (Esc, arrows, Ctrl, …) shows only in the Terminal lens; the composer (files, text, send) stays in both. A message sent from the chat shows at once as a pending bubble, the view jumps to the end and follows the reply, and a "Claude is working · 1m 12s" (or "Codex is working") row stands at the end while the agent works (no animation with reduced motion). `Ctrl`/`Cmd`+wheel, a trackpad pinch or a two-finger pinch over the chat sets the chat's own text size (12-24 px, remembered apart from the terminal's), which the composer takes in the Chat lens. Switching from the chat to the Terminal lens brings the terminal down to the newest output. Copy buttons are icons that turn into a check for a moment once the copy worked.

While the agent works in the Chat lens and the composer is not focused, the Send button turns into **Stop** (a red square). It does what Esc does in the terminal: it sends one Esc to the pane, exactly the key bar's Esc, to interrupt Claude Code or Codex. Click into the composer (or tap it on a phone) and the button is Send again, so a draft can still go out while the agent works; what a press does is decided when it starts, so pressing Send from the composer always sends. Stop asks for no confirmation (Esc interrupts the work, the conversation stays), leaves the draft alone, and is busy for a moment after a press; press it again if the agent needs a second Esc. Esc in the composer stops too while the agent works, unless the `@` file list, find or a dialog is open, or an input method is composing. The button stays Send when the agent is idle, done or asking, and in the Terminal lens, where the key bar has Esc. It works for a connected PC's panes too.

### Prompt cards

For the selected Claude or Codex pane, whatever status herdr reports (it does not always say blocked while a menu waits), the server reads the pane's screen and turns a menu it finds there into a card; ordinary output, including a numbered list in an answer, is never a card. The cards: Claude Code's tool approvals (Yes / Yes, and don't ask again / No), plans, AskUserQuestion menus (one choice, several, or a typed answer), the review that submits several answers, and its unnumbered menus such as the folder-trust check; Codex's approvals (run a command, apply edits, trust a folder, with its "No, and tell Codex what to do differently" answered by Esc), its plan-mode questions (an option, or a typed answer in the notes of "None of the above"), the questions it queues while it works, and its "Press enter to continue" menus. Only while herdr reports the pane blocked, a screen no reader knows becomes a fallback card with the last lines and basic keys (Enter, Esc, a numbered menu's digits, y/n). A Claude plan or question card takes its words from the call Claude waits on in its transcript (the whole plan of `ExitPlanMode`, the whole question and options of `AskUserQuestion`), since the terminal may have scrolled a long plan away or cut an option short with `…` in a narrow pane; the rows, the keys and what the answer is checked against stay the screen's, and the screen's words remain when the transcript cannot say. A password prompt is never a card. In the Chat lens the card sits at the bottom, above the composer; over the Terminal lens a banner says the agent is asking and **Answer** switches to the chat, or, for a pane with no chat, opens the same card over the terminal. A banner can be dismissed for that prompt.

Pressing an option posts the card's id: the server reads the screen again, refuses with `409 prompt_changed` if the prompt is no longer the one shown (the card then refreshes), sends the cursor moves, and sends the Enter only once the screen shows the cursor on the chosen row. Cards are pushed over the terminal socket only for the selected pane, and only while it is a Claude or Codex pane or is blocked. A connected PC's panes work the same way.

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

Type `@` at the start of the composer or after a space to reference a file, as Claude Code and Codex take it: a list above the composer offers the names in the selected pane's working folder (the folder its program runs in, else the folder the pane started in), folders first, up to 50. Typing narrows it (`@src/ap`), `↑`/`↓` move, `Enter` or `Tab` (or a tap) picks a name, and `Esc` closes the list without sending; while the list is open `Enter` never sends. A folder goes in as `@src/` and its contents are offered next; a file goes in as `@src/app.js ` with a space after it. A name with a space goes in quoted, `@"my folder/notes.md"`, the form Claude Code accepts. `@/abs/path` lists from the root; hidden names show only once you type the leading `.`, and locked files are not offered. `@~/` is not completed: the home folder belongs to the pane's machine and the listing cannot name it, so type a path from the pane's folder or an absolute one instead. A pane with no known folder, or a folder that cannot be listed, simply shows no list.

Type `/` at the very start of the composer to pick a command for the selected pane's agent. A Claude Code pane offers Claude Code's own commands (`/compact`, `/model`, ...), your skills and commands (`~/.claude/skills/<name>/SKILL.md`, `~/.claude/commands/**/*.md`, a subfolder's as `dir:name`), the project's (`.claude/skills` and `.claude/commands` in the pane's working folder and, in a git checkout, in each folder above it up to the checkout's root) and those of installed plugins (as `plugin:name`, from `~/.claude/plugins/installed_plugins.json`); a Codex pane offers Codex's own commands and your prompts in `~/.codex/prompts` (as `prompts:name`). Each row shows the name, a one-line description and where it comes from (built-in, user, project or plugin). Typing narrows the list (names that start with what you typed first, then names and descriptions that contain it), and the keys and taps work as in the `@` list; picking puts `/name ` in with a space after it and sends nothing. Only the name and description in each file's frontmatter (or its first line) are read, never its body, and nothing outside those folders is opened. The agents' own commands are a fixed list kept in HerdRabbit, so a newer or older CLI may have a few more or fewer. Plugins are listed as installed, whether or not they are switched off in Claude Code's settings, which HerdRabbit does not read. A pane on a PC connected with Connect PC offers that PC's own list (its skills, commands, the pane's project, its plugins and prompts, read there by that PC) when it runs this version or later, otherwise its agent's own commands only. A pane running anything else shows no list.

### Files

The attach button beside the composer, and the folder icon at the foot of the sidebar, both open the **Uploads** dialog. Pick one or more files and choose **Upload**: they go up one at a time into a shared uploads folder on the machine running HerdRabbit, and their absolute paths are inserted into the composer in that order, ready to hand to an agent. A file that fails is named with the reason, and the rest still upload. Nothing is sent until you submit. The dialog also lists what the folder already holds, with a row each for inserting the path, copying it, downloading the file, and deleting it.

Files can also be dropped anywhere on the terminal panel, several at once, without opening anything, and an image pasted with `Ctrl`/`Cmd`+`V` is uploaded the same way — a screenshot goes from the clipboard to a path in the composer in one step, stored under a name that records when it arrived. Ordinary text pasting is unchanged.

Browsing is separate, in the sidebar. It has two tabs: **Sessions** is the project list, and **Files** is a tree of the machine's filesystem. Folders expand in place when you click their name or the arrow beside them, and a folder's own button re-roots the tree there so a deep path stops costing indentation. The path field at the foot of the tab goes straight to a folder, its ↑ button walks to the parent, and dotfiles are always listed. Any file can be downloaded to the browsing device from its row.

The path box at the foot of the tab goes anywhere directly. Typing offers matching folder names — arrow keys move through them and `Enter` opens the highlighted one. The tab reopens wherever browsing last stopped, and the uploads folder is the starting point on a first visit.

Sign-in keys and HerdRabbit's own settings are never opened: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.password-store`, `~/.local/share/keyrings`, `~/.config/gh`, `~/.config/gcloud`, `~/.config/rclone`, `~/.netrc`, `~/.git-credentials`, `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials`, the AI CLIs' sign-ins (`~/.claude/.credentials.json`, `~/.claude.json`, `~/.codex/auth.json`, `~/.config/claude*`) and HerdRabbit's settings folder show in the tree as **locked**, by name only, and cannot be expanded, viewed or downloaded -- also through a symbolic link and over Connect PC.

Browsing is read-only: nothing in the tree can be changed, and uploading and deleting live in the Uploads dialog instead. Files copied into the folder from a terminal appear in that dialog too. The uploads folder is `~/.local/share/herdrabbit/files` unless `HERDR_WEB_FILES_DIR` names another directory; it is deliberately separate from the configuration directory that holds credentials. Uploads and downloads have no size limit by default; `HERDR_WEB_MAX_TRANSFER_MB` sets one limit (in megabytes) for both. The folder itself has no size or file-count limit, so it grows until the disk is full and nothing is removed on your behalf.

With more than one machine registered, the Files tab gains a picker: choose one and the tree shows that machine, starting at its home. Each machine remembers its own last folder.

That choice is also where uploads go. Until one is made, a file you attach or paste follows the session you are looking at, and the path is inserted into the composer. Pick a machine and it is pinned for both browsing and uploading, across reloads. When the pinned machine is not the one the selected session runs on, the path is **not** inserted -- it would name a file that session cannot open -- and the upload says where it went instead. The attach button and the uploads dialog name the machine either way.

A connected PC's files are read and written by that PC itself. The confinement is the same on every machine: browsing is read-only, and writes reach only that machine's own uploads folder.

On iOS, a browser in standalone PWA mode may open a downloaded file instead of saving it. Use the share sheet to store it.

A file an agent names in its output is a link to itself. "wrote `src/api.mjs`", "see `./docs/plan.md`" -- the path opens in the viewer, resolved against the pane's own directory when it is relative. A file the viewer cannot show (say `app-release.aab`) opens the Files tab in its folder with that file selected, or says so when the file is no longer there. A folder written out in full is a link too: an absolute path (`/home/me/proj`) or one starting with `./` or `../` opens the Files tab inside that folder, and a path whose last name turns out to be a file there is selected in its parent instead; a closing slash (`/home/me/proj/`) means folder. Any other path becomes a link only when its last name is a file the viewer can show or has an extension (`name.ext`, with at least one letter in it), which is what keeps `src/foo`, `node_modules/`, `feat/settings-menu`, `1/2`, `.env`, `v1.2` and `10.0.0.1` plain. A lone `/word` (a slash command such as `/compact`), `//host/share` and the path inside a web address are not folder links; `~` is left alone, because that home belongs to the machine the pane runs on. In the live terminal, these paths and web addresses are underlined all the time, so they can be seen and tapped on a phone, and an address the output wrapped onto the next line is still one link. A path with spaces is one link when it is quoted -- `"/home/me/my folder"`, `'./build output/app.aab'` -- and starts with `/`, `./` or `../`; the link covers what is inside the quotes, backticks count as quotes in the terminal too, and without quotes a path ends at its first space. A relative path links only when the pane's own directory is known. A path is a path in any script (`/home/me/프로젝트`), and a Korean particle written straight after a file name (`src/a.md를`) is not part of it. The chat view finds paths with the same code as the terminal, so the same text links the same paths in both. The one difference is a code span: the whole span is taken as one path, so a name written alone there (`app.js`) is a link too, and so is a path with spaces (`` `/home/me/my folder` ``), the backticks quoting it. Joining a path the output wrapped onto the next row is the terminal's alone; chat text is not wrapped.

A file can be opened instead of downloaded. Images, video and audio play in place, Markdown and HTML are drawn, and text, code, logs and config are shown as characters. Reading a log on a phone should not mean saving it first.

What may be shown, and as what, is decided from the name against an allow-list, never by sniffing the bytes. Nothing gets to run, but the two formats that could are handled by how they are shown rather than by refusing them: an SVG goes in an `<img>`, which executes no script, and an HTML file is framed by a response whose own policy ends in `sandbox` -- an opaque origin with no script, for anyone who opens that URL and not only for the frame, which is also what lets a saved report keep its own stylesheet. Both were measured against a file that tried to call home and neither reached anything. Markdown goes the same way: the server renders it with `marked` and sends the result, so it lands in the same frame with the same policy and the browser downloads nothing extra. Which hrefs may become links, and what happens to markup embedded in the document, are decided here rather than by the parser: http(s) or it stays text, and embedded markup is shown as the characters it is made of. Any of them can be read as its own source instead, one press away. A PDF opens in a tab rather than in the dialog. Framing one is the part browsers disagree about -- Android Chrome draws nothing in a frame, iOS Safari draws the first page -- while a tab is not framing at all, works everywhere, and gives a page-shaped document the full height it was written for. It also means a PDF needs no exception to the framing rules and gets none: only HTML is reopened, and an image response still says `frame-ancestors 'none'`. Text works the same way -- opaque bytes in, characters out, no content type negotiated. Downloads are unchanged: still `application/octet-stream` as an attachment, which is what keeps a stored page from ever running at this origin.

Video seeks: a view link answers byte ranges, on a connected PC as well, because the machine holding the file is the one that slices it.

### AI accounts

A subscription CLI stops at its session or weekly limit, and moving to another account normally means signing in again. **AI accounts** in a server's row menu keeps each account's sign-in on that machine so switching is one press. Claude Code and Codex are supported.

For each CLI the dialog is a list of email addresses from A to Z, with the one in use marked in its place. Opening it saves the account signed in now, so there is nothing to save by hand. A line appears under an account only when it needs a new sign-in within a week or already does; Claude Code sign-ins last about a month, and Codex does not record when its own will end. Nothing else about an account is shown.

- **Add account**, at the end of each list, opens an `AI login: …` project and types the sign-in command there: `claude auth login`, or `codex login --device-auth`, pointed at an empty directory of its own. Signing in where the live account lives would revoke that account, which is why it happens apart. Codex's device code sign-in has to be turned on in ChatGPT's security settings first. Signing in is noticed on its own: the page checks every few seconds whether the CLI has written its sign-in into that directory, saves the account the moment it has, and closes the project. AI accounts then opens again with the new account marked **Just added**, unless another dialog is open. A reload does not lose the wait: the machine keeps which sign-ins are still open, and the page picks them up again when it starts or when AI accounts is opened. It stops checking after 20 minutes, and **Cancel sign-in** in AI accounts ends it sooner. What you type into that project is not kept in prompt history.
- **Switch**, in an account's ⋯ menu, changes the account for the whole machine. Settings, MCP servers, conversation history and memory stay as they are, so `claude --continue` or `codex resume` picks up where the other account stopped. The account being replaced is saved first, which keeps the tokens the CLI rotated while using it. If Herdr shows the CLI running in any pane, the switch lists those panes and waits for confirmation; they keep the old account until restarted. A CLI started outside Herdr is not seen.
- **Remove**, in the same menu, deletes the saved copy. It does not sign the account out anywhere.

Each machine keeps its own accounts. On a connected PC the saving, signing in and switching run there, and only whose account is where comes back; no sign-in travels between machines.

Saved sign-ins are stored in `~/.config/herdr-bridge/ai-accounts`, or the directory in `HERDR_WEB_AI_ACCOUNTS_DIR`, as mode-`0600` files inside mode-`0700` directories that only the owning OS user can read.

The CLI's own files are what gets switched: `~/.claude/.credentials.json` plus the `oauthAccount` field of `~/.claude.json`, and `~/.codex/auth.json`, or the directories in `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the HerdRabbit service sees them. Codex set to store sign-ins in the keyring cannot be switched and says so, and `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment still overrides whatever account is saved. Claude on macOS keeps sign-ins in the Keychain and is not supported.

### Output and history

Terminal output and history come only from Herdr's own screen and scrollback. Claude's JSONL transcript and Codex's rollout are never merged into the terminal; only the Chat lens reads them, as its own view (and a Claude plan or question card takes its words from them). In an attached terminal the wheel or a finger drag scrolls Herdr's own history; a mirrored pane shows its current screen only. History Herdr no longer holds cannot be shown. Claude must run in the plain terminal mode the installer configures for its scrollback to be readable.

During install and update, the current user's global Claude settings (`~/.claude/settings.json`, or the path in `CLAUDE_CONFIG_DIR`) get `tui: "default"` and `env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1"`, so ordinary terminal scrolling is used instead of Claude's own. Existing settings are backed up beside the file as `settings.json.herdrabbit-*.bak` and other keys are preserved. A running Claude picks this up after a restart. Each machine that runs HerdRabbit applies it during its own install or update. The settings survive Claude's own updates. To apply it by hand: `node scripts/configure-claude.mjs`.

Live terminal input (including composer submissions and extra keys) and output use `/api/terminal` WebSocket. An attached pane streams Herdr's own output. For a mirrored pane, after the initial snapshot only changes are sent; Herdr reports no general screen change outside a terminal attach, so the server observes output: 50 ms after each read during activity, 500 ms when quiet, shared by viewers of the same pane and line range. Background pages disconnect and receive a fresh snapshot on return. Session status uses Herdr `pane.agent_status_changed` events over WebSocket, including unselected sessions. Project/session lists still refresh over HTTP every two seconds and resynchronize after the status subscription starts. HTTP list refreshes also cover subscription failures while retrying. Authentication and project/session management remain HTTP. Push notifications are unchanged.

### Display settings

Use the control at the bottom of the sidebar to switch between light and dark mode. Adjust terminal and composer text size with `Ctrl`/`Cmd` + wheel or trackpad zoom. On mobile, pinch over the terminal with two fingers. The selected size is saved in `localStorage`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HERDR_WEB_HOST` | `127.0.0.1` | Any literal address to listen on: `127.0.0.1`, `0.0.0.0`, or one interface such as this host's Tailscale address. A single address is the tightest option -- the service is then absent from every other network the machine is on, and that address is accepted as a request host automatically. Names are refused, since they resolve at listen time. |
| `HERDR_WEB_PORT` | `38787` | Listening port from 1024 through 65535 |
| `HERDR_WEB_ALLOWED_HOSTS` | empty | Additional reverse-proxy or Tailscale hostnames, comma-separated |
| `HERDR_WEB_PEER_HOST`, `HERDR_WEB_PEER_PORT`, `HERDR_WEB_PEER_ADDRESSES`, `HERDR_WEB_PEER_LOGINS`, `HERDR_WEB_HUB` | unset; port an integer 1024–65535, default `38788` | The Connect PC port and who may use it; see [Other PCs running HerdRabbit](#other-pcs-running-herdrabbit-connect-pc). Closed unless `HERDR_WEB_PEER_HOST` is set, and refusing everyone while both allowed lists are empty. |
| `HERDR_WEB_SERVERS_FILE` | `~/.config/herdr-bridge/servers.json` | PCs added with Connect PC |
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

Run as the Linux account that installed the service. The updater uses its own directory, or `HERD_RABBIT_INSTALL_DIR`. It requires a clean `main` branch and the official origin, fetches `main`, updates the service's Herdr with `herdr update --handoff` (running panes stay alive), then fast-forwards `main`, installs dependencies, verifies, and restarts the matching user service. Herdr is checked against the minimum the incoming code requires before any file changes: a failed Herdr update continues when the installed Herdr is new enough, and stops the update with nothing changed otherwise. A lock prevents concurrent updates. Local changes or divergent commits stop the process before anything changes. When dependency installation, verification, or the restart fails after `main` moved, the updater resets to the previous commit, reinstalls its dependencies, and restarts that version if it had already restarted. Herdr itself is not rolled back. Configuring Claude's terminal scrollback runs after verification and is not rolled back either: if it fails, the update stops before restarting, and the next restart runs the verified new code. Ports, authentication, Tailscale settings, and connected PCs are preserved. If an older installation lacks `update.sh`, run `git pull --ff-only` once first. An installation older than 1.2.10 runs its own earlier `update.sh`, which does not update Herdr: run `herdr update --handoff` outside Herdr before that first update. HerdRabbit warns at startup and in the machine's Details while Herdr is older than 0.9.0.

The Service Worker reloads the page once when it activates a new app shell. Manually refresh a tab that has remained open for a long time.

### Update from the app

The page checks for a new version each time it opens, and again when you press **Check** in **⚙ → Update** (never on a timer). It fetches `main` from origin in the service's own checkout and compares it with what runs. A newer version puts a dot on the ⚙ button; the Update window shows the running and latest versions, the commit subjects in between, and, when `update.sh` would stop, why: not running as the systemd user service, an origin other than ultivis-iot/HerdRabbit, not on `main`, local changes, a local `main` that diverged, or an update already running. **Update** asks first, then runs the same `update.sh` with `systemd-run --user` in a unit of its own, outside the service, so the restart it ends with does not stop it. The page follows its log, waits out the restart and reloads into the new version; a failed run says so and keeps its log (`update.sh` rolls back by itself). The log and outcome are kept in `~/.local/share/herdrabbit/update/`. The Update window lists every PC connected with Connect PC too, each with its own versions, changes and reason, and **Update** there runs that PC's own `update.sh`; this page sends only which PC. A PC on a version from before this says "Update it there (older version)". Starting an update needs a signed-in session on this page; one run per PC a minute.

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
- HerdRabbit login passwords are stored only as `scrypt` hashes in a mode-`0600` file. Connected PCs hold no credential: a PC recognises another by the tailnet address its requests arrive from.
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
- Browsing is read-only and reaches every path the service account can read on this machine **except sign-in keys and HerdRabbit's own settings**, which it never lists into, opens, previews or downloads: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.password-store`, `~/.local/share/keyrings`, `~/.config/gh`, `~/.config/gcloud`, `~/.config/rclone`, `~/.netrc`, `~/.git-credentials`, `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials`, the AI CLIs' sign-ins (`~/.claude/.credentials.json`, `~/.claude.json` and its backups, `~/.codex/auth.json`, `~/.config/claude*`, and wherever `CLAUDE_CONFIG_DIR`/`CODEX_HOME` put them), and HerdRabbit's data (`~/.config/herdr-bridge/`, plus the password, push, servers and saved-sign-in paths when the environment moves them). Paths are compared after resolving symbolic links, so a link to a key is refused like the key. A listing shows such an entry as locked, by name and kind only. The same list applies to a connected PC's files (on that PC), and the service refuses to start with an uploads folder inside it. Beyond that list the OS file permissions are the boundary, which still includes things like `/proc/self/environ`. This is not an escalation, because an authenticated client can already run arbitrary commands as that account through a terminal pane — the list keeps sign-ins from leaving the machine through the file browser, not from a terminal. It is a further reason not to run HerdRabbit as root or as a shared account.
- No machine holds another's credentials. Each runs its own Herdr, and a connected PC's sign-ins and files stay on it.
- The **Connect PC port** is a listener of its own, apart from the page. It serves only `/api/link/`, never the page, the login or the browser API, and the page serves no `/api/link/` route at all, so a connected PC cannot use a page session and a browser session cannot reach the Connect PC API. A PC is let in by the address on its socket (and, with `HERDR_WEB_PEER_LOGINS`, by the tailnet account `tailscale whois` gives for it), never by a cookie, password or header; with an empty allowed list nobody is.
- The Connect PC port answers only to its own address: a request whose `Host` is not exactly the address and port it listens on (`[address]:port` for IPv6), or this PC's tailnet DNS name, gets `421`, and one carrying a browser's headers (`Origin`, `Sec-Fetch-Site`, `Sec-Fetch-Dest`) gets `403`. A web page on another name that resolves to this address (DNS rebinding), opened in a browser on an allowed PC, therefore cannot use the port. It holds at most 64 connections and 16 status streams, and a request has 5 seconds for its headers and 3 minutes in all to arrive.
- A terminal attach over Connect PC is the port's only WebSocket (`/api/link/panes/<pane>/attach`), and the upgrade passes exactly the checks every request does -- the exact `Host`, no browser headers, only `/api/link/`, an allowed address or account -- before the pane is even looked up; a refusal is an ordinary HTTP answer and nothing is started. At most 16 attaches are open at once, each pane's size is held to 1..1000, a frame from the hub is at most 256 KB, and the attach runs B's own `herdr terminal attach` for that pane with nothing from the hub but the pane id, the size and whether to take the slot over. The hub opens it with no redirects, a 10-second handshake and frames of at most 256 KB; closing either side ends the other, and B pauses the attach while A is not reading.
- The Connect PC port binds only to a tailnet address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`) or loopback; every interface in any spelling, and LAN addresses, are refused at startup.
- A hub reads what a connected PC sends no further than it needs: JSON answers stop at 8 MB (64 KB for an error, 16 KB for a discovery probe) and stay on their timeout until the whole body has arrived, and a file stops at the size it declared, at `HERDR_WEB_MAX_TRANSFER_MB`, or, with no size, at 1 GB -- a PC that keeps sending is cut off with an error, not read to the end. A redirect from a connected PC (or from a PC being probed) is never followed: it is refused as an error, so a PC cannot point the hub at another address.
- The Connect PC port listens directly on the tailnet address rather than behind `tailscale serve`, and that is the stronger shape: the caller's address is set by the kernel from a WireGuard-authenticated peer, so no process -- on this PC or elsewhere -- can claim to be an allowed PC. Behind Serve the proof would be a header, which only holds while Serve is the one thing that can reach the socket, and **any local process, as any user, could forge it**. It is plain HTTP inside the tailnet, which WireGuard already encrypts; HTTPS matters only for the page, where service workers and passkeys need a secure context.
- An allowed PC gets what a person at this PC's page would: its terminals (text and keys), files the service account can read (sign-in keys excepted, as above), and its AI account switches. **Every process on an allowed PC can send input to this PC's terminals and read its files -- the same as a shell here.** The check is the PC's address, not the program, so allow only PCs you would give a shell on this one. Allow only your own PCs. `HERDR_WEB_PEER_LOGINS` alone admits every device that account owns; add `HERDR_WEB_PEER_ADDRESSES` to narrow it to devices.
- Reading a file this way leaves no trace in any pane's history, works with no Herdr session running at all, and streams at link speed. Terminal-borne copying does none of those things.
- Regular files only. Directories, devices, and FIFOs are refused after the file is opened non-blocking, so a named pipe cannot stall the server. Files are served as `attachment` with `application/octet-stream`. Downloads have no size limit by default; `HERDR_WEB_MAX_TRANSFER_MB` sets one. A file that reports a size of 0 (procfs, sysfs) streams without a length and is cut off at 1GB.
- Downloads are fetched through a single-use ticket that expires in 30 seconds, so no file path appears in a URL. Directory paths and the server they belong to do appear in the browse request URL and will be recorded by any reverse proxy in front of HerdRabbit.
- Stored files are mode `0600` inside a mode-`0700` directory, and are always served as `attachment` with `application/octet-stream` so an uploaded HTML or SVG file cannot render in the browser.
- Uploads have no size limit by default, but must declare a `Content-Length`. When `HERDR_WEB_MAX_TRANSFER_MB` sets a limit, a larger upload is refused from that header before any of the body is read. An upload may take as long as it keeps sending; it is dropped only after 2 minutes without a byte. The uploads folder has no total size or file-count limit, so disk space is the only bound.
- Accepting a whole file in one request raises the body-receive timeout to two minutes for every route. The header timeout is unchanged, so slow-header attacks are still cut off, but a slow body is not.
- VAPID private keys and Push subscription URLs are stored in a mode-`0600` file readable only by the owning OS user.
- Saved AI CLI sign-ins are copies of the CLI's own credential files, mode `0600` inside mode-`0700` directories, and they are only ever copied between that directory and the CLI's. No API response, error, log line or browser storage carries a token: the account routes answer with an email, a plan and a sign-in expiry. This machine never receives a connected PC's sign-ins. Anyone who can use this HerdRabbit can switch its accounts, which is no more than a terminal pane already allows.
- A sign-in project only ever receives a command naming its empty directory. Its one-time sign-in code is not kept in prompt history, and the project is closed when the sign-in is finished or cancelled.
- Browser storage contains UI preferences and the current-window launch token, not terminal history or the password.

## License

[MIT](LICENSE)

Third-party code and its notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
