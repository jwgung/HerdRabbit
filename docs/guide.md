# HerdRabbit guide

English | [한국어](guide.ko.md)

The full reference. For installing and first steps, the [README](../README.md) is shorter.

HerdRabbit is a small personal web app for controlling [Herdr](https://herdr.dev/) workspaces running on your own machine. It reconnects to existing Herdr sessions, shows terminal output and agent state, sends text and special keys, and installs as a PWA on desktop and mobile devices.

> [!IMPORTANT]
> HerdRabbit is a **personal-use tool for one person to access their own Herdr sessions**. It is not a multi-user account system, an authorization boundary between untrusted users, or a public hosting service. Do not expose it directly to the public internet. Use it over a private network such as Tailscale.

HerdRabbit runs once per OS user and may be protected with one instance password. It does not use usernames. The app, repository, and systemd service are all named `HerdRabbit`. It installs as a Herdr plugin; a PC with the older systemd service (under either `herdrabbit.service` or the former `herdr-web-local.service`) is moved over to the plugin the next time the installer runs.

## Reusable HTML UI

[`public/ui`](../public/ui/README.md) contains the shared styles used by the app and a standalone catalog. Open `/ui/index.html` while the app is running, or copy the folder and open its `index.html` directly. Load `ui/ui.css` to reuse themes, buttons, inputs, navigation/status, menus, sidebars, and dialogs without a framework or build step.

Run `npm run check:ui` with Playwright installed, or set `PLAYWRIGHT_MODULE` to its module path.

[`docs/design.md`](design.md) holds the design rules (type, spacing, radii, layers, shadows, color roles, status, touch targets, motion, copy). Changes to the app's look follow it.

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

[`docs/herdr-coverage.md`](herdr-coverage.md) lists every Herdr command group, what the page does with it, and what is still missing.

- Browse the current OS user's Herdr persistent sessions, workspaces, tabs, panes, and agent states
- Aggregate multiple Herdr persistent sessions without local ID collisions
- Split, close and zoom panes, move a pane out of a split again, and see a split tab as Herdr lays it out ([Split panes](#split-panes))
- Show every pane as Herdr itself draws it (a real `herdr terminal attach` in xterm.js), on this machine and on PCs added with Connect PC, so full-screen TUIs, the cursor and colors match; a pane that cannot attach is mirrored read-only in the same terminal
- Read a Claude Code, Codex, OpenCode, Kiro CLI or Antigravity CLI (`agy`) pane as a chat: its conversation as turns, the agent's tool calls folded under one "Worked for …" row, older turns loaded as you scroll up. A **Chat** / **Terminal** switch in the pane header (or `Ctrl`/`Cmd`+`J`) flips between the two without reconnecting anything
- Show the local images an agent puts in its answer (`![](out/chart.png)`) inside the chat, and open them full screen to zoom, pan, step through, copy or download ([Chat](#chat))
- Answer what an agent asks (tool approvals, questions, menus) with buttons on a card at the bottom of the chat, or from a banner over the terminal
- Each pane keeps its own unsent draft, also across a reload
- Send text and shell commands, or use a two-row extra-key bar on a touch screen or a phone-sized window (Ctrl/Alt/Shift, Esc, Tab, Home/End, PgUp/PgDn, arrows, slash, minus and Enter by default; edit it with **Edit keys**). Select modifiers, then tap a key or type it on your keyboard (for example Ctrl → End or Ctrl → C); on a phone keyboard, the letter typed after a modifier goes as that key and does not stay in the composer. PgUp and PgDn page through the terminal history a screen at a time, as a finger or the wheel does; hold Shift first to send the plain key to a program that pages itself, such as less or vim. With Ctrl or Alt held, or in a mirrored pane, they send their keys as before. Modifiers clear after one send or when switching panes. Ordinary composer shortcuts remain local unless a screen modifier is selected. A desktop types these keys itself and shows no bar.
- Create tabs with the `+` at the top of the sidebar or a workspace's `⋯` menu (**New tab…**), and workspaces from a machine's `⋯` menu (**New workspace…**) or from New tab itself, start either in a folder you type or pick from the folder tree and with an agent installed on that machine, name a new tab or resume an agent's earlier conversation in the folder chosen, rename workspaces and tabs, and close tabs or workspaces after confirmation
- Work on a Git branch in its own workspace: **New worktree…**, **Open worktree…** and **Remove worktree…** in a workspace's `⋯` menu, with each worktree's branch beside its name
- View images, video, audio, Markdown and text in the browser instead of downloading them first
- Manage every machine from its row in the sidebar, this one included: make a workspace on it (**New workspace…**), read its name and versions, connect another PC from this one's row (**Connect PC…**), and rename or disconnect a PC added with Connect PC (or find it again after it moved port)
- Switch the Claude Code, Codex, Antigravity CLI or Kiro CLI account a machine uses without signing in again, from the same row
- Move files between the browsing device and the Herdr machine through a shared uploads folder: upload from the composer's attach button, paste the stored path into the composer, and download or delete stored files
- Remember the selected pane and collapsed workspaces in the browser
- Move between the cells of a split with `Alt`+arrow keys, and switch sidebar entries with `Ctrl+Tab`, `Ctrl+Shift+Tab`, or `Ctrl+1`–`Ctrl+9` when the browser forwards those shortcuts to the app ([Keyboard shortcuts](#keyboard-shortcuts))
- Restore terminal font size and the last 100 sent prompts per pane across app launches; use Up/Down in the composer to recall prompts
- Mark each tab in the sidebar with the program it runs (Claude, Codex, another agent, or a shell) and its status at the far right: Herdr's own symbol for the status (`◐` working, `×` needs your answer, `✓` done and not yet viewed, `○` idle); a tab waiting on you also says "Needs your answer" in place of its folder; collapsed workspaces still call out unviewed completions
- Send status-only PWA notifications with the workspace and tab names when an agent needs input or finishes; while the app is in front, show them inside it instead
- Install as a responsive PWA with light and dark themes (switched in ⚙ Settings → Appearance)
- Resize terminal text with `Ctrl`/`Cmd` + wheel, trackpad zoom, or a two-finger mobile gesture
- Protect an instance with an optional password, Passkey login, a seven-day hard session limit, login on each new PWA window, and a list of signed-in browsers to sign out one by one or all at once
- Install as a Herdr plugin on a collision-free port in `30000–39999` (or as a per-user systemd service)
- Register Tailscale Serve HTTPS during setup when Tailscale is available

Herdr persistent-session renaming, resizing split panes by dragging their borders, and multi-user accounts are not currently provided.

## Technology

- **Server:** Node.js 22+, ESM, and Node's standard-library HTTP, crypto, filesystem, and process APIs
- **Web UI:** semantic HTML, CSS, and vanilla JavaScript with no frontend framework
- **PWA:** Web App Manifest, Service Worker app-shell caching, responsive standalone UI
- **Notifications:** standards-based Web Push, Push API, VAPID, and the `web-push` package
- **Herdr integration:** local `herdr` CLI calls through `execFile` argument arrays without a shell
- **Process management:** a Herdr plugin started with Herdr (a per-user `systemd --user` service remains an option on Linux)
- **Private HTTPS:** Tailscale Serve proxying to a loopback HTTP listener
- **Authentication:** WebAuthn Passkeys through SimpleWebAuthn, `scrypt` password hashes, HMAC-signed sessions, `HttpOnly` cookies, per-window signed launch tokens, CSRF tokens, and same-origin checks
- **Testing:** Node's built-in `node:test`, integration tests, and a fake Herdr executable

Live terminal input (including composer submissions and extra keys) and output use `/api/terminal` WebSocket. An attached pane streams Herdr's own output. For a mirrored pane, after the initial snapshot only changes are sent; Herdr reports no general screen change outside a terminal attach, so the server observes output: 50 ms after each read during activity, 500 ms when quiet, shared by viewers of the same pane and line range. Background pages disconnect and receive a fresh snapshot on return. Agent status uses Herdr `pane.agent_status_changed` events over WebSocket, including unselected tabs. Workspace and tab lists still refresh over HTTP every two seconds and resynchronize after the status subscription starts. HTTP list refreshes also cover subscription failures while retrying. Authentication and workspace and tab management remain HTTP. Push notifications are unchanged.

## Additional machines

### Other PCs running HerdRabbit (Connect PC)

Both PCs must be on the same tailnet with Tailscale running (with it off there is no tailnet address, so `HERDR_WEB_PEER_HOST` cannot be set and the `tailscale whois` check cannot work).

Every PC runs the same HerdRabbit: its own page and login, on `127.0.0.1` behind Tailscale Serve, as installed by the [quick install](#quick-install). A PC can also open a **Connect PC port** for other PCs: that lets another PC's HerdRabbit show this PC's sessions on its own page. It is one-way -- if A connects to B, B shows up on A's page, not the other way round -- and B keeps its own page and login either way.

**On the PC being connected to (B):** open its Connect PC port and say which PCs may use it. The port is closed until you do.

- **From the page** (installed as a Herdr plugin, with a password set): **⚙ Settings → PCs → Let other PCs connect → Choose PCs…** offers **All my PCs** (every device signed in to Tailscale as this PC's account; chosen first on a closed port), **Only these** (the tailnet's devices, ticked one by one) or **No other PC**. Enter the password and **Save**: HerdRabbit writes `HERDR_WEB_PEER_HOST` (this PC's tailnet address) and either `HERDR_WEB_PEER_LOGINS` (this PC's account) or `HERDR_WEB_PEER_ADDRESSES` (the devices) into the plugin's `.env`, never both, since with both a caller would have to match both. Its other lines stay, and it restarts through Herdr. No other PC removes them and closes the port. The page keeps those three lines, replacing what was set by hand there; `HERDR_WEB_PEER_PORT` stays as it is. A tagged device (one owned by its tags) is never taken as yours. The settings are checked as the server reads them before anything is written; a `.env` that is a link is not changed.
- **Installed as a Herdr plugin, from a terminal:** add the settings to the plugin's `.env` (`herdr plugin config-dir herdrabbit` prints its folder), then restart:

  ```bash
  cd "$(herdr plugin config-dir herdrabbit)"
  printf '\n%s\n' "HERDR_WEB_PEER_HOST=$(tailscale ip -4)" "HERDR_WEB_PEER_ADDRESSES=100.64.0.3" >> .env
  herdr plugin action invoke herdrabbit.restart
  ```

  `HERDR_WEB_PEER_HOST` is B's own tailnet address; `HERDR_WEB_PEER_ADDRESSES` is A's (`tailscale ip -4` on A, or its row in `tailscale status`). The plugin does not ask about this when it is installed.
- **Installed as the systemd service:** re-run `npm run install-service` there and answer the Connect PC question ("다른 PC가 이 PC에 붙을 수 있게 열까요?"), then pick the allowed PCs from the tailnet list.

The settings:

| Variable | Meaning |
| --- | --- |
| `HERDR_WEB_PEER_HOST` | This PC's tailnet address (for example `100.64.0.2`). Setting it opens the Connect PC port; unset (the default) keeps it closed. Only an address in Tailscale's ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) or loopback is accepted -- never every interface (`0.0.0.0`, `::` in any spelling) or a LAN address; anything else stops the service from starting. |
| `HERDR_WEB_PEER_PORT` | Its port: an integer from 1024 to 65535, `38788` by default. It cannot share the page's port on the tailnet address, which Tailscale Serve holds. |
| `HERDR_WEB_PEER_ADDRESSES` | Tailnet addresses of the PCs allowed to connect, comma-separated. Only tailnet addresses (and loopback, for trying it on one PC) are accepted. |
| `HERDR_WEB_PEER_LOGINS` | Tailnet accounts allowed to connect, comma-separated, looked up for each caller's address with `tailscale whois`. With both lists set, a caller has to match both. |
| `HERDR_WEB_HUB` | Optional: the page of the PC that should connect, such as `https://laptop.tailnet.ts.net:38787`. This PC then tells it where its Connect PC port is, which matters only on a port other than the default. |

With both allowed lists empty, the port refuses everyone.

**On the PC that connects (A):** open this PC's row menu (`⋯`) in the sidebar and choose **Connect PC…**. The dialog lists the PCs on your tailnet and says what each one is: ready, already added, running HerdRabbit but not allowing this PC, on another connection protocol, or with nothing to connect to (no Connect PC port, or offline -- these fold away behind a count). Pick a ready one, or open **Enter an address** and type its Connect PC address (`http://100.64.0.2:38788`). **Save** stays disabled until **Test connection** succeeds for what is in the form. Nothing is stored on either side but the name and address: B recognises A by the address its requests arrive from, so there is no key or password to keep anywhere. Connected PCs are kept in `~/.config/herdr-bridge/servers.json` (mode `0600`, or `HERDR_WEB_SERVERS_FILE`) and shared by every browser using A.

A scan only tries the default port. A PC on another port -- a second account on the same PC, say -- announces itself instead when `HERDR_WEB_HUB` names A, and A lists it beside what it found. An announcement only puts a row in the list; adding it is still a choice, and choosing still probes the address. A PC may announce only itself, and only from your own tailnet account. What was announced is kept in `~/.config/herdr-bridge/announced.json`; an address a look proves empty is dropped, and the list is capped.

**Versions.** Two PCs connect when they speak the same **connection protocol**, a number that changes only when what they exchange does; their HerdRabbit versions may differ, and Details shows both. A PC on another protocol is shown offline, and its status and Details name both PCs' protocol and HerdRabbit version, so you can tell which one to update.

A connected PC's row menu has **New workspace…** (while a Herdr session runs there), **Details** (kind, address, its HerdRabbit version beside this PC's, connection protocol, Herdr version), **AI accounts**, **Rename**, **Disconnect**, and, while it is offline, **Find new address**: a PC that moved to another port keeps its tailnet address, so this looks again and repoints the entry if it answers elsewhere. This PC's own Details shows its Connect PC address and how many PCs it allows.

What a connected PC does today: its workspaces, tabs and panes are listed with their agent status (streamed from B), its panes are attached as real terminals (typing, resizing and wheel scrolling included) and **Find** searches their whole Herdr history on B, text and keys reach its panes, workspaces and tabs are created, renamed, closed and dragged into order on B, its split tabs open as a grid and are split, zoomed, closed, rearranged and evened out on B, the Files tab and uploads use B's own disk, path links open B's files, prompt cards answer B's agents (a Claude plan or question card with its whole words from B's transcript, an OpenCode question's from B's database), **Chat** shows B's Claude, Codex, OpenCode, Kiro CLI and Antigravity panes, and **AI accounts** switches B's sign-ins on B. A PC on an older HerdRabbit keeps its panes mirrored, says it is too old to search them, and its Chat button says to update it; update it there.

A connected PC's pane is attached on that PC: B runs `herdr terminal attach` on its own pseudo-terminal, exactly as for its own page, and A relays it over one WebSocket on B's Connect PC port, which A's browsers share as they share a local pane (the recent screen for a late joiner, the size set by whoever opened or typed last, **Open here** when another client holds the pane). A never learns B's Herdr binary or socket: it asks which terminal the pane has, then asks B to attach it. A PC without node-pty, or one on a HerdRabbit from before this, shows its panes mirrored as before; A needs no node-pty of its own for B's panes.

### Herdr SSH machines (removed)

Earlier versions also listed Herdr's own SSH machines (`herdr machine add`) beside this one. That support has been removed in favour of Connect PC, which attaches, searches, chats, answers prompt cards, browses files and switches AI accounts on the other PC itself. To bring such a PC back, install HerdRabbit on it and add it with **Connect PC…** in this PC's row menu. HerdRabbit leaves Herdr's own machine list as it is; while it still names machines, the page says this once per browser.

### Every machine in one sidebar

All machines appear together as **machine → session → workspace → tab → pane**, as Herdr names them; selecting a pane sends input and reads output on that machine. Each machine refreshes on its own, with slower retries after a failure, so an unreachable one does not hold up local data; its last-known panes stay visible while it is marked offline. A workspace is made from its machine's `⋯` menu and a tab from its workspace's, and both can be renamed and closed where they are shown.

A machine is managed where it is seen, and every machine has a row -- this one too, even when it is the only one. Its `⋯` menu opens **Details** -- the machine's name, the HerdRabbit version answering for this machine, its Herdr version (marked when it is older than 0.9.0; this machine also logs that at startup), and how many Herdr sessions and panes it contributes -- and **AI accounts**. Browser-wide settings (including **Passkeys** and **Signed-in devices**) are in ⚙ Settings at the foot of the sidebar, not here. Details are the first thing worth reading when a machine will not connect.

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

Creating a workspace creates a Herdr workspace and its shell, then types the chosen agent's command into that first pane when one was picked. Creating a tab creates a new Herdr tab and default shell in that workspace, then names it and types the chosen agent's command into it when those were picked. HerdRabbit does not run a separate terminal backend; it reads from and writes to Herdr panes.

### Multiple Herdr persistent sessions

HerdRabbit calls `herdr session list --json`, reads snapshots from every running persistent session, and scopes local IDs such as `w1:p1` to their originating session.

- One persistent session is shown without an extra grouping level.
- Multiple or unavailable sessions are grouped and labeled in the sidebar.
- Stopped sessions show their state but are not queried for snapshots.
- Commands are routed back to the original Herdr persistent session.
- Sessions owned by another OS user and one-off `herdr --no-session` processes are not included.

### Multiple OS users on one server

Each OS user runs their own installation. Herdr plugins and `systemd --user` services are per account, while the installer selects an unused local and Tailscale HTTPS port.

```text
alice → 127.0.0.1:38787 → https://server.example.ts.net:38787
bob   → 127.0.0.1:30000 → https://server.example.ts.net:30000
```

Each instance is still personal: it exposes only the Herdr sessions and configuration of the OS user running that instance.

## Requirements

- Linux or macOS (the systemd service option is Linux-only)
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

If Herdr is absent, the HerdRabbit installer downloads the official Herdr installer automatically. To install Herdr yourself:

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

Herdr installs to `~/.local/bin/herdr` by default. Add it to your shell PATH if necessary:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Quick install

Run this in a Linux or macOS terminal. It installs HerdRabbit [as a Herdr plugin](#install-as-a-herdr-plugin):

```bash
curl -fsSL https://raw.githubusercontent.com/jwgung/HerdRabbit/main/install.sh | sh
```

The bootstrap script:

1. Checks Git, npm and Node.js 22+, and fetches the current HerdRabbit into a temporary folder (removed at the end)
2. Moves a PC that still has the older systemd service over to the plugin instead ([Moving an existing install to the plugin](#moving-an-existing-install-to-the-plugin)), and stops there
3. Installs Herdr from `https://herdr.dev/install.sh` when `herdr` is missing, or updates it with `herdr update --handoff` when it is older than 0.9.0
4. Installs the plugin with `herdr plugin install jwgung/HerdRabbit`
5. Selects an unused port, preferring `38787` and then `30000–39999`, and writes it with this PC's tailnet name into the plugin's `.env`
6. Prompts for an optional HerdRabbit password through the terminal (an existing one is kept unless you ask to replace it)
7. Starts the plugin when Herdr is running; otherwise it starts with Herdr
8. Registers Tailscale Serve HTTPS when Tailscale is running, and prints the local and HTTPS addresses

Run it again to change the password or register Tailscale Serve again; the plugin's settings and port are kept. It also sets Claude's terminal mode, as the service installer does.

### Manual repository install

```bash
gh repo clone jwgung/HerdRabbit
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

Install HerdRabbit as a [Herdr plugin](https://herdr.dev/) (Herdr 0.9.0 or newer, Node.js 22+ and npm on `PATH`). It is also listed in the [Herdr plugin marketplace](https://herdr.dev/plugins/).

```bash
herdr plugin install jwgung/HerdRabbit
```

- **Build:** after you confirm, Herdr runs `npm ci --omit=dev` in its own checkout of the plugin.
- **Startup:** each time Herdr starts (and after a live handoff), the plugin starts HerdRabbit in the background unless a HerdRabbit already answers. It does nothing while the systemd service (`herdrabbit.service`, or the older `herdr-web-local.service`) is active, so the two never run side by side.
- **Actions:** `herdr plugin action invoke herdrabbit.start`, `herdrabbit.stop`, `herdrabbit.status` and `herdrabbit.restart`. Stop only ever ends the server the plugin started itself; it never touches the systemd service. Status also says when the running server is still on an older checkout after `herdr plugin update`, so you know to restart it.
- **Connect pane:** `herdr plugin pane open --plugin herdrabbit --entrypoint connect` shows the page addresses (this PC, and the Tailscale Serve HTTPS address when one forwards to the port), whether a password is set, and how to set one. With `qrencode` installed it also draws a QR code for the phone address.
- **Password:** `herdr plugin pane open --plugin herdrabbit --entrypoint password` asks for it without echoing and restarts the plugin's server. The password is never written to the plugin's settings.
- **Settings:** `herdr plugin config-dir herdrabbit` prints the folder holding `.env`, created on first start as a commented template. It takes the `HERDR_WEB_*` variables from [Configuration](#configuration) and `HERDR_BIN`, one `KEY=VALUE` per line; restart afterwards. To let other PCs connect to this one, the `HERDR_WEB_PEER_*` settings from Connect PC go here too. The server log and its pid file live in the plugin's state folder, not in the checkout.
- **Updates:** updates follow releases. HerdRabbit's row in **⚙ Settings → Plugins** on the page runs `herdr plugin install <owner>/HerdRabbit --ref v<x.y.z> --yes` for the latest release and then the restart action ([Update from the app](#update-from-the-app)). That pins the plugin to the release tag, so a later `herdr plugin update` keeps it there instead of following `main`. From a terminal, run `herdr plugin install jwgung/HerdRabbit --ref v<x.y.z> --yes` with the tag of the [latest release](https://github.com/jwgung/HerdRabbit/releases/latest), then `herdr plugin action invoke herdrabbit.restart`.

The plugin starts with Herdr, so to have HerdRabbit up after login, have Herdr start then too. A phone reaches the page through Tailscale Serve; the Connect pane prints the command to register it, and [Tailscale Serve HTTPS](#tailscale-serve-https) has the details.

### Moving an existing install to the plugin

This replaces the systemd service written by an earlier one-line installer or `npm run install-service` with the plugin; the one-line installer above does the same on such a PC. Run it on that PC while Herdr is running:

```bash
curl -fsSL https://raw.githubusercontent.com/jwgung/HerdRabbit/main/migrate-to-plugin.sh | sh
```

It needs `git`, `npm` and Node.js 22+. Piped like this, it fetches the current HerdRabbit into a temporary folder and runs from there, so an installation of any age moves over without updating it first; the folder is removed afterwards. From an up-to-date checkout, `sh migrate-to-plugin.sh` in it does the same.

- It shows what it will do and asks first (without a terminal, pass `--yes`: `... | sh -s -- --yes`).
- It installs the plugin with `herdr plugin install jwgung/HerdRabbit` and carries the unit's `HERDR_WEB_*` settings (port, allowed hosts, the Connect PC port and allowed PCs, and so on) into the plugin's `.env`. A value with a double quote or a line break is not carried and is named so you can add it by hand. `HERDR_BIN` is not carried: the plugin uses the Herdr that runs it. The password file, uploads folder and push subscriptions file the service used are written in explicitly, so a different XDG folder in Herdr's environment does not move them. A `.env` that already has settings is left as it is, and then none of the unit's settings are carried; if its address is not the service's, the move stops before the service is touched.
- It stops the service and starts the plugin on the same address. The port is the same, so the Tailscale Serve address, an installed PWA and other PCs' connections carry on.
- Once the plugin answers, it disables the service, deletes its unit file when it is in `~/.config/systemd/user`, and deletes the old checkout when it is an unmodified official checkout in the default place (`~/.local/share/herd-rabbit`, or `HERD_RABBIT_INSTALL_DIR`) holding nothing but its installed dependencies. A checkout anywhere else, one with changes, or one holding other ignored files is kept. If the plugin does not answer, the service is started again and nothing is deleted.
- The password, Passkeys, signed-in devices, connected PCs (`~/.config/herdr-bridge/`) and uploads (`~/.local/share/herdrabbit/files`) live outside the install folder and stay as they are.
- A PC an older version installed as a leaf is set up again with `npm run install-service` first.
- From then on HerdRabbit starts when Herdr starts, not at login.

## Password and Passkey authentication

Run this as the same Linux user that owns the service:

```bash
cd ~/.local/share/herd-rabbit
npm run password
```

Entering a new password twice replaces the old password and restarts the installed service. Installed as a plugin, use the plugin's password pane instead ([Install as a Herdr plugin](#install-as-a-herdr-plugin)); it restarts the plugin's server. Leaving the first input empty disables password authentication. Existing login sessions and registered Passkeys become invalid after either change.

The plaintext HerdRabbit login password is never stored. The `scrypt` hash, session-signing secret, and registered Passkey public data are stored with mode `0600` in the compatibility path:

```text
~/.config/herdr-bridge/auth.json
```

Authenticated sessions have a fixed seven-day maximum lifetime. Every API request requires both an `HttpOnly`, `SameSite=Strict` cookie and a separately signed token stored in the current window's `sessionStorage`. Closing the PWA or tab and opening a new one requires login again by Passkey or password. Reloading or returning from the background in the same window keeps the login. HTTPS connections also use the cookie's `Secure` attribute.

**Signed-in devices** on the Security page of ⚙ Settings at the foot of the sidebar (shown when a password is set) opens a list of browsers: each browser signed in, named by browser and system, with when it signed in and was last used. The list keeps the 64 most recent; signing in past that ends the oldest. A browser that signs in again replaces its own earlier entry instead of adding another. **Sign out** ends one, and its open terminals close at once; **Sign out everywhere** ends all of them, this one included. Neither asks for the password, since they only take access away. The row marked `(this device)` has the **Sign out** that ends this browser's own session; when this browser signed in before the list existed and has no row, **Sign out this device** at the bottom does the same. The list keeps a hash of each session, never the token, in the auth file. Sign-ins made before the list existed stay valid until they expire and are not listed; **Sign out everywhere** ends them too.

Wrong passwords are counted per caller: the Tailscale login or forwarded address Tailscale Serve reports, or the connecting address. Guesses from one device lock only that device, up to fifteen minutes; a loose limit across all callers still applies.

After the first successful password login, HerdRabbit offers to register a Passkey when the browser supports WebAuthn. Within five minutes of that sign-in the window can register one passkey without typing the password again; after that, registering asks for it. Later login screens show **Sign in with a passkey** beside the password fallback. Depending on the device, the browser can use Face ID, a fingerprint, Windows Hello, the device PIN, a security key, or cross-device QR authentication. The biometric and private key stay on the authenticator; HerdRabbit stores only the credential ID, public key, signature counter, transport metadata, and the name and dates shown in the list below. Passkeys are bound to the exact hostname used during registration, so use the stable Tailscale HTTPS address rather than alternating between addresses.

**Passkeys** on the Security page of ⚙ Settings lists the registered passkeys by name, with the day each was added and last used, and whether it syncs between devices. The name comes from the browser that registered it, such as `Safari · iOS`; passkeys registered before this list existed show as `Passkey` with no dates. Removing one or adding another asks for the password again, so a stolen browser session cannot plant a passkey that outlives it. Removing a passkey signs every other device out -- the usual reason to remove one is a lost device, which may still be signed in -- while the browser that removed it stays signed in; open terminals elsewhere close within 15 seconds. Removing the last one leaves the password. The list and removal work without WebAuthn, so a lost device's passkey can be removed from any browser. The list shows names and dates only; credential IDs and public keys stay in the auth file. To clear every passkey at once, run `npm run password`.

## Usage

### Selecting and restoring a tab

Select an agent or pane in the sidebar to show its output. The last selected pane is stored in `localStorage` and restored on reload when it still exists. Browser storage is isolated by origin, so an HTTP LAN URL and a Tailscale HTTPS URL have separate preferences.

Opening a tab whose `✓` marks an unviewed completion marks that completion as viewed and turns the `✓` into `○` in the current browser. A later completion has a new state sequence and shows `✓` again.

### Agent status notifications

Use the **Off** / **On** choice on the Notifications page of ⚙ Settings at the bottom of the sidebar to enable or disable notifications for the current browser or installed PWA. The line under it says the state in words: on, off, or blocked by the browser (allow them in the browser's site settings); a browser without push support says so and shows no choice. Permission is requested only after pressing **On**.

- Titles use `workspace name · tab name`, led by the server name when more than one server is connected.
- Only completion and input required are sent, as short status-only messages. An agent going idle or an unknown state sends nothing.
- While a HerdRabbit window is in front, no system notification appears: the pane it shows stays quiet, and another pane's alert drops in at the top of the app with a short sound. Tap it to open that pane, or swipe it sideways or up to dismiss it; a short drag snaps back.
- Each state event is sent once, and a newer alert replaces the previous alert for the same tab. Opening it launches or focuses the installed PWA and restores the targeted tab.

Background delivery uses standards-based Web Push; a Firebase project and FCM SDK are not required. On iPhone and iPad, install HerdRabbit on the Home Screen and allow notifications on iOS/iPadOS 16.4 or newer.

VAPID keys and per-device Push subscriptions are stored with mode `0600` in:

```text
~/.config/herdr-bridge/push.json
```

Workspace and tab names may appear on the lock screen. Previous commands and request text are not included. Enable notifications only on personal devices.

### Workspaces and tabs

- The `+` at the top of the sidebar, at the right of the logo, opens **New tab** on the workspace on show (with nothing on show, the first online machine's first workspace). A workspace's `⋯` menu holds **New tab…** too, opening the same dialog on that workspace, and a machine's `⋯` menu holds **New workspace…** while a Herdr session runs on it.
- **New workspace…** creates a named workspace on that machine. It opens in the selected pane's Herdr session when that pane is on the machine, else in the machine's default session; a machine running more than one session shows a picker of them. Its **Agent** choices are **Shell** and the agents installed on that machine, each with its program's mark, and **Create** starts the one chosen in the new workspace's first pane. The agent is typed only into the pane Herdr's create answer named, once the snapshot shows it in that new workspace; if that pane cannot be found the workspace stays as a shell and the page says so. A connected PC on an older HerdRabbit, which does not name its new workspace's pane, is refused with 501 before anything is made, as is an agent that is not installed there (409).
- Use a workspace's `⋯` menu to rename it, add a tab, or close the workspace.
- Git worktrees (Herdr's `herdr worktree`). A worktree is a second checkout of a repository, in its own folder and on its own branch, opened as its own workspace and grouped with the repository's workspace in Herdr. A workspace Herdr knows a checkout of shows its branch beside its name, read from Herdr's `worktree list` and asked again every 15 seconds at most.
  - **New worktree…** on a repository's workspace asks for a **Branch**, an optional **Start from** (a branch, tag or commit, `HEAD` when empty), an optional **Workspace name** and an **Agent** (Shell, or one installed on that machine, started in the new workspace's first pane as **New workspace…** does; an agent not installed there is refused with 409 and a PC too old to list its agents with 501, before anything is made). Herdr checks out a local branch of that name if there is one, else makes it from Start from, in a folder under its `worktrees.directory`, and **Create** selects the new workspace's pane. Names follow `git check-ref-format`: up to 200 characters, any letters (not only ASCII), no spaces, control characters or `~ ^ : ? * [ \`, no `..`, `@{` or `//`, no part starting with `.` or ending in `.lock`, not `@` alone or `HEAD`, not starting with `-` (Git would read it as an option) or `/`, not ending with `/` or `.`; Start from may end in `~N` or `^N`. Others are refused with 400 `invalid_input` before Herdr is asked. If the agent cannot be started (the create call named no pane the snapshot shows), the worktree stays and the page says so.
  - **Open worktree…** lists the repository's checkouts, each by branch (or Detached) and folder, marked Open when a workspace already has it and Main for the repository's own; bare and prunable ones are left out. **Open** opens the one chosen as a workspace, or selects the workspace it is already open in.
  - **Remove worktree…** on a worktree workspace asks first, then runs Herdr's `worktree remove`: the folder is deleted (`git worktree remove`), the workspace closes and its processes stop, and the branch is kept. When Git refuses a checkout with uncommitted changes (409 `dirty_worktree_requires_force`), the page asks again and only then removes it with `--force`; those changes are lost.
  - The menu offers New and Open on a workspace that is not itself a worktree (Herdr starts them from the repository's workspace) and Remove only on one that is. A workspace whose folder is not in Git still offers New and Open, and the dialog says so (409 `not_git_worktree`) with nothing to create. Herdr's other refusals reach the dialog as 409 with Herdr's code. Repositories owned by another user (Herdr's `--trust-repository`) are not supported.
  - A connected PC runs these through its own Herdr; a PC on an older HerdRabbit is refused with 501 (update it there).
- The **New tab** dialog asks, from the top: **Machine** and **Workspace** (each machine marked online or offline; an offline one cannot be chosen), **Folder**, **Agent**, the agent's earlier conversations, and an optional **Tab name**. The last Workspace choice, **New workspace…**, asks for a **Workspace name** and **Create** makes the workspace with this tab as its first, as **New workspace…** does (in the machine's running Herdr session, the selected pane's when it is there), in the Folder chosen, with the agent started in it and the tab named when a name is given. It is off on a machine with no Herdr session running.
- The **Agent** choices are one row of tabs that scrolls sideways when they do not fit (a swipe on a phone, the arrows at its faded ends, or ←/→, Home and End). They are **Shell** and each agent installed on the workspace's machine, each with its program's mark: Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), Kiro (`kiro-cli`), Antigravity (`agy`) and Cursor Agent (`cursor-agent`). An agent counts as installed when its command is an executable file in a folder on the PATH HerdRabbit's server runs with; nothing is run to find out, and the answer is kept for 30 seconds. A new tab's shell may have a different PATH from the HerdRabbit server, so an agent found here may still fail to start there. A connected PC answers for itself; a PC on an older HerdRabbit offers only Shell and says to update it there. **Start** makes the tab, names it when a name was given, types the agent's command into it and selects it. The command comes from HerdRabbit's own list, never from the request, and an agent that is not installed there is refused before anything is made. The dialog chooses the agent last started from it while the page stays open.
- Under the Agent tabs, an agent's earlier conversations in the chosen Folder are listed as a choice: **Start new conversation** (chosen first), or one of them (newest first, up to 20, each by its title or first prompt and when it was last used). **Resume** opens the tab in that folder and types the agent's own resume command: `claude --resume <id>`, `codex resume <id>`, `opencode --session <id>` or `kiro-cli chat --resume-id <id>`. The workspace's folder is the folder of its first pane that has one, as the sidebar shows it. The conversations are read from the same files the Chat view reads (Claude's project folder, Codex's thread index, Kiro's session folders, OpenCode's database); the id typed must be one the workspace's machine has just listed there, so a conversation removed meanwhile is refused. Changing the Folder lists that folder's conversations again. The list is hidden when the folder has no earlier conversations of that agent, for a shell, and for a workspace not made yet; the dialog says so and **Start** makes a new one. A malformed id is refused with 400 and a well-formed id that is not in the machine's list with 409, both before any tab is made. Antigravity and Cursor Agent conversations are not listed. A connected PC lists its own conversations; a PC on an older HerdRabbit says to update it there, and a new conversation still starts.
- Both dialogs have a **Folder** row: a path on that machine, typed (it completes as the Files tab's path field does) or chosen from the tree its ▾ opens under it. The tree is the Files tab's for that machine in a folders-only mode, opened on the folder's parent with the folder marked: click a folder's row to choose it, its arrow to open it in place; to go higher, type the path. ▾ again, Escape or a click outside closes it. It lists folders as the Files tab does (hidden ones too, a sign-in folder marked locked and not opened), and leaves out files and broken links. New workspace opens it at `~`, the machine's home; New tab at the workspace's folder, shown from `~` when it is under the home folder. The folder shown is passed to Herdr as `--cwd`, so it opens there and not where Herdr's `new_cwd` setting would put it. A folder is absolute or starts with `~` (`~` or `~/…`, that machine's home), up to 4096 characters on one line, and must be an existing folder on that machine: otherwise the dialog shows the refusal (400 `invalid_folder`, `folder_not_found`, `not_a_folder`, or `protected_folder` for a folder the Files tab will not open) and nothing is made. A connected PC checks a folder itself and expands `~` to its own home; a PC on an older HerdRabbit makes it as before when the folder is left as the dialog opened it, and is refused with 501 (update it there) for any other folder. A resumed conversation opens in the Folder chosen, the one its conversations were listed for.
- Use a tab's `⋯` menu to rename or close it. A split tab's menu also has **Even out layout** and **Separate all panes** (see [Split panes](#split-panes)).
- Collapse or expand a workspace's child tabs with the arrow beside its name.
- Drag a tab to reorder it within its workspace, or onto another workspace of the same machine and Herdr session to move it there (it keeps its name; a split tab with several panes can only be reordered within its workspace); drag a workspace's name to reorder workspaces. On a phone, hold a row for a moment before dragging; a short tap still selects and a swipe still scrolls. Reordering uses Herdr's `tab.move` and `workspace.move`, moving uses `pane move`.
- Servers and Herdr sessions collapse the same way, so a sidebar listing several machines can be narrowed to the one in use. The choice is remembered per browser.
- Destructive close actions always require confirmation.

A tab shows the agent running in it until it is given a name. That is not a name: it changes when the agent does, and two tabs running the same agent read alike. Renaming one puts the name where the agent was, and moves the agent beside the status; a tab with several panes carries its name on its one row (see [Split panes](#split-panes)). Emptying the field takes the name back off and the tab shows its agent again. Herdr has no unnamed tab -- `tab rename` insists on a label -- so clearing writes back the number the tab was born with, which the sidebar hides. Workspace renaming goes to Herdr's `workspace rename`, tab renaming to `tab rename`, so both are the same operation a person at that machine would run.

The status word (`working`, `idle`) is not spelled out beside a tab. The mark at the far right already carries it (`◐` working, `×` waiting for your answer, `✓` finished and not yet viewed, `○` idle, coloured per state), and rows have no status-coloured border; the selected row is only tinted. A line under the name shows the folder the tab runs in when that differs from the name. The one exception is a tab waiting for your answer: its line under the name says "Needs your answer" in red instead of the folder, and so does a split tab's row when any of its panes waits. Hover a tab, or read it with a screen reader, to get the status in words.

Run other commands such as `cd` inside a created shell, or start an agent there yourself. Creation uses Herdr's `--no-focus` option so it does not steal focus from the desktop Herdr client.

### Split panes

A tab with several panes is one row in the sidebar, laid out like any other tab: its name (the tab's name, else the title of the pane last selected in it, else "Split tab"), a grid badge with the number of panes, and the most urgent status of its panes (waiting for your answer, then working, then finished, then idle). Clicking the row opens the **grid**: every pane of the tab at the place and size Herdr gives it, one live terminal per cell. The row is tinted while any of its panes is selected.

The arrow at the start of the row, where other rows show their agent's mark, shows the tab's panes under it, one row each; a pane row opens that pane alone, with its Chat and Terminal lenses. The list starts folded, and whether it is open is remembered per tab in this browser; selecting a pane does not unfold it. Each pane row has its own `⋯` with the same actions as a grid cell's (below), on this machine. The row's `⋯` menu renames or closes the whole tab, has **Even out layout** (below), or **Separate all panes**: after a confirmation, every pane but the first leaves for a tab of its own in the same workspace, which undoes the split; the first stays in the tab. The row is dragged like any other to reorder it within its workspace.

 HerdRabbit sets no limit of its own on the number of panes; a split Herdr refuses shows Herdr's message. A cell too small to read shows only its name and status until it is focused.

- Click a cell to select it; typed text, the key bar and the composer go to that pane only. A click in a Chat cell's conversation puts the typing in the composer (not a click on its buttons, links or card, nor a drag that selects text).
- `Alt`+arrow keys move to the cell on that side, as the cells are laid out (no wrap at the edges). A Chat cell gets the composer focused, a Terminal cell its terminal. The keys are taken while a grid or split view is on screen, from a cell's terminal too (there they do not reach the program); find, rename and a card's answer field keep them, and with no split on screen they stay the browser's Back and Forward.
- On a wide screen every cell of a grid or of a split view shows its pane as **Chat** or **Terminal** on its own: the two small icons in the cell's header, before the expand button, switch that cell alone (or `Ctrl`/`Cmd`+`J` for the selected cell, pressed outside its terminal). The choice is the one kept per pane for the pane alone, so a pane read as a chat alone opens as a chat in the grid, and the other way round. Cells are separate rounded cards, 6px apart, the selected one ringed.
  - A cell in Chat shows its pane's conversation in the cell, and a blocked pane's prompt card at the bottom of it; a cell in Terminal says it waits for an answer in its header. The cell's terminal stays attached under the chat, only hidden, and with **Fit panes to this window** it keeps sizing the pane to the cell, so switching changes nothing in Herdr (its layout, the pane's size, other devices) and the terminal is back at once. The rest of the page keeps its size too: in a split the key bar stays under a Chat cell as well (its keys go to that cell's pane), so selecting another cell resizes no pane.
  - The composer, Stop, the key bar's target, the composer's text size and find (`Ctrl`/`Cmd`+`F`: in the conversation over a Chat cell, in the terminal's history over a Terminal cell) follow the selected cell and its lens.
  - A pane with no chat (a shell, or an agent the chat cannot read) has a dimmed Chat icon whose tooltip says why. A cell smaller than 320 by 220 px has no room for a conversation: it shows its terminal, dims the Chat icon and, when the pane is read as a chat, says "Too small for the chat. Open alone" under its header (a cell too small even for that shows only its name); it shows the chat again once it is large enough. Phones keep the pane map (below), with no cells.
- **Fit panes to this window** on the Terminal & keys page of ⚙ Settings (wide screens; an **Off** / **On** choice, on by default, remembered in this browser) makes the grid adapt to the browser window the way Herdr adapts to its own terminal: the cells keep Herdr's proportions but fill the whole stage, and each cell sizes its pane's terminal to itself at the text size set for a single pane, so `Ctrl`/`Cmd`+wheel, a pinch or that setting change the grid's text too and the panes follow. While the grid is open, Herdr itself and other devices showing those panes see them at the cells' sizes, as they already do for a pane opened alone. A cell tells its pane a new size once it has kept still for a moment (after a layout change has slid into place, the window is resized or the sidebar dragged), and only when its size changed. A cell with no room for 10 columns by 3 rows shows its name until it is focused, and then never sizes its pane below that. Switching the setting off or on applies at once to a grid on screen.
- With the setting off, a grid cell never resizes the pane's terminal: it shows the pane at Herdr's size, and the grid's text size is chosen for you: every cell shares the largest font at which the board (Herdr's tab shape) fills the stage, up to 32px, whatever the text size set for a single pane. To adjust it, use `Ctrl`/`Cmd`+wheel, a trackpad pinch or a two-finger pinch on the grid: each step is one font step from the size the cells have now, every cell alike, and a smaller size shrinks the board (centred, the cells still filled). A step larger than the stage has room for returns to the automatic size. `Ctrl`/`Cmd`+`0`, or **Reset text size** in ⚙ Settings → Appearance (available while a size is chosen), goes back to automatic too. The choice is remembered in this browser, apart from the single pane's text size, which a grid never changes; a zoomed pane and the view split keep following that one.
- A cell's `⋯` menu, and a pane row's in the sidebar, has **Split right**, **Split down** (the new pane starts in the same folder), **Zoom**, **Even out layout**, **Move out to its own tab** and **Close pane**. Moving out takes the pane out of the split into a new tab of the same workspace (Herdr's `pane move --new-tab`); the pane keeps running and stays selected if it was, and a tab left with one pane is an ordinary one-pane tab again. The expand button (or a double click on the cell's header) opens that pane alone; **Back to grid** returns. Closing asks first when the agent is working or waiting for your answer. A zoomed tab shows its one pane with an **Unzoom** bar.
- On a wide screen, drag a cell by its header (not its terminal, which keeps selecting and typing; the header's buttons work as before) onto another cell of the same grid to rearrange it. In the middle of that cell (about 40% each way) the whole cell lights up with **Swap**: the two panes trade places. Near an edge the half it would take shows dashed, as for a tab dragged from the sidebar: the pane moves next to that cell on that side. Dropping on its own cell or outside the grid does nothing, and `Esc` puts it back. The pane keeps its id, its terminal and the selection. A cell too small to read is dragged by its name. A zoomed tab is not rearranged. In Herdr, a swap is `pane swap`; a move is two `pane move`s (Herdr does not move a pane within its own tab): the pane goes out to a tab of its own and is split back in beside that cell, then `pane swap` for left and up. Should the second step fail, the pane is put back in its tab beside another of its panes if Herdr allows, else it stays in a tab of its own, and the feedback line says which.
  - In a split view the same drag rearranges the tiles, for this window only: nothing is sent to Herdr, and a reload keeps the new arrangement.
- On a wide screen, drag a one-pane tab from the sidebar onto the edge of a cell, or of the terminal when one pane is open (the outer 28% of the pane; the middle does nothing). Dropping between rows still reorders.
  - A tab of the **same workspace** merges into that pane's tab on that side, in Herdr itself: every device sees the new split, and the tab it came from is gone. Left and up are a move to the right or down followed by Herdr's `pane swap`.
  - A tab of **another workspace**, on this machine or another (a PC added with Connect PC), dropped on the pane open alone, makes this window's own **split view** instead: the two panes side by side, each a live terminal whose header names its workspace and tab. Nothing changes in Herdr: no pane moves, nothing closes, other devices and other browser windows do not see it, and it lasts for this window only (a reload brings it back; closing the window ends it). Drop more tabs on the edges of a tile to add them (up to 6); inside a split view every drop is view-only, a tab of the tile's own workspace included. Click a tile to type into it; the composer and the key bar follow it. Each tile has ⤢ **Open alone** (with **Back to split view** to return) and ✕ **Remove from view**, which takes the tile out and leaves the pane as it is; with one tile left the split view ends and that pane shows alone, as **Close split view** does at once. Clicking a tile's pane in the sidebar focuses its tile; any other pane opens alone, with **Back to split view**. A tile whose pane is closed leaves the view. When the split holds panes of more than one machine, each tile's header begins with its machine's name; a tile whose machine is offline says so in place of its terminal and attaches again when the machine is back (the split stays). Tiles share the space evenly (no border dragging); each tile switches between Chat and Terminal on its own, as a grid cell does (above).
  - Another workspace's tab over a grid (a split tab shown as Herdr lays it out) offers no zones, and a tab of another machine is never merged into a Herdr tab (only made a tile).
- On a phone (up to 760px wide) there is no grid: the tab's row opens the pane last selected in it (or its first), shown as usual with a small map of the tab's layout above it, coloured by agent state; tap a box to switch pane. On any screen, the row of a tab on a PC added with Connect PC opens that pane alone, without a grid or a map.
- **Even out layout** (a cell's `⋯`, a pane row's, or the split row's) gives the tab's panes equal shares, split by split as Herdr nests them: three columns side by side become three equal columns, and a column split in two gets two equal halves of its column. It changes the layout in Herdr itself, so every device sees it, and runs at once without a confirmation; the grid reads the layout again and its cells slide to their new places. Herdr has no "even" command, so it is a series of Herdr's `pane resize`, one border at a time (outermost first), with the layout read again after each, up to 60 resizes; a border within one cell of even counts as even (40 rows in three are 13, 14, 13). The feedback line says **Layout evened out.** or why not: a zoomed tab is refused (unzoom it first), and should Herdr not move a border any further, it stops where it got; if that would leave the panes further from even than they began (or Herdr refuses a resize partway), the borders are moved back toward where they were, as far as Herdr allows.
- Splitting uses Herdr's `pane split`, `pane close`, `pane zoom`, `pane move`, `pane swap` and `pane resize`, on the machine the tab is on: this one, or a PC added with Connect PC, which runs them there. A connected PC on a HerdRabbit from before this cannot: its split tab opens one pane at a time, its pane rows have no `⋯` and its split rows no **Even out layout** or **Separate all panes**, until it is updated. Panes never move between machines.

### Terminal

A pane on this machine is attached: the server runs one `herdr terminal attach` per pane on a pseudo-terminal (node-pty) and every open browser shares it. Typing goes straight to it, the terminal follows the size of the browser that opened the pane or typed into it last (others show that size as it is), and the wheel or a finger drag scrolls Herdr's own history, gliding on after a flick. A browser that opens the pane later gets the recent screen. When another client already holds the pane's attach slot (another web bridge), the pane says so and **Open here** takes it over; otherwise it tries again every few seconds and attaches once that client lets go. A pane of a PC added with Connect PC attaches the same way, on that PC (see [Other PCs running HerdRabbit](#other-pcs-running-herdrabbit-connect-pc)). If node-pty cannot load, or herdr will not attach a pane, the same terminal mirrors that pane instead: the screen the server polls is redrawn in place on each change. A mirror is read-only to keystrokes -- type into the composer or use the extra keys, which still send to the pane -- and it attaches again on its own once it can.

When the terminal is not live, a strip over its top edge says why: "Disconnected from HerdRabbit — retrying in 4s" (the server restarted, the network went away, or the phone slept), "Herdr is not answering", "This pane is gone", a Connect PC that is offline, refuses this PC or is too old, or "Sign-in expired — reload to sign in again". Where trying again can help it offers **Reconnect**, which tries at once instead of waiting out the retry. A pane that can only be mirrored says so quietly ("Shown read-only: this PC can't attach terminals") with no button. A normal connect shows nothing unless it takes more than about three seconds, the strip goes as soon as the terminal is live again, a pane another client holds keeps its **Open here** strip instead, and the Chat view never shows it.

### Chat

A pane running Claude Code, Codex, OpenCode, Kiro CLI or Antigravity CLI (`agy`) can also be read as a chat. **Chat** and **Terminal** in the pane header (or `Ctrl`+`J`, `Cmd`+`J` on a Mac) switch between the two in one tap; inside the terminal `Ctrl`+`J` stays the program's, so press it from the composer there. Both live in the same place: switching only hides one and shows the other, so the terminal stays attached, the draft in the composer stays, and each keeps its scroll position. After five minutes in the chat without the terminal, the terminal is let go to save resources and attaches again (Herdr redraws it) when you switch back.

The chat reads the agent's own conversation file for that pane on this machine: the transcript Claude Code writes under `~/.claude/projects`, or the rollout Codex writes under `~/.codex/sessions` (or `$CODEX_HOME`). A Claude pane's transcript is the one of the session herdr reports, followed to where that session went on: a resumed session (`continued-in`), or a background job opened in it, which is found by the job's short id in `~/.claude/jobs/<id>/state.json` (under `$CLAUDE_CONFIG_DIR` when that is set); the latest of these that has a file is shown, so a pane showing a background job (`⑂`) reads that job's conversation (on this machine only). A Codex pane's rollout is found by the one rollout the pane's own Codex process holds open, then by the one thread whose name the pane's title shows (Codex titles its pane `<thread name> | <folder>`; the title is the pane's own, so it is preferred over herdr's report, which Codex's shared app-server daemon can bind to another pane), then by what herdr reports for the pane (the rollout's path or the thread id, looked up in Codex's thread index `state_*.sqlite` when Node.js has `node:sqlite`, else by the file's name), and as a last resort by a recent answer of one of the directory's threads that the pane's screen shows below its last Codex header (so, while the screen shows a header, answers an earlier run left above a restart or `/new` never count). Codex 0.150 and later run tools through one code-mode `exec` script per call; such a row reads as what Codex recorded the script doing (the commands it ran, the files it changed, an MCP tool, a search or an image), as "Ran" or "Edited" when that was all it did, a `wait` on a running script reads as that script, a script that polls a command it left running (`write_stdin`) reads as that command, and a command or file change that finished after its script returned, or that you ran yourself, is a row of its own unless a script of the same turn already names it. Codex's injected instructions, environment context and encrypted reasoning are never shown; its reasoning summaries read like Claude's thinking, and a compaction is marked where it happened. The chat draws the conversation as turns: your prompts as bubbles, the answer as Markdown, and everything the agent did on the way (commands, edits, reads, thinking) folded under one "Worked for 12s · 2 edits · 1 command" row that opens to each call, its diff or output, and the whole output on request. Each call is its own row that opens on its own: a known tool reads as a verb and its object ("Ran npm test", "Read src/a.ts", "Edited src/a.ts", Codex's patches included), a subagent's call as its description, and any other tool by its name; the tool's name is in the row's tooltip and its opened detail. A command row offers **View in terminal**. File paths work as they do in the terminal: the viewer opens what it can show, and any other file name opens its folder in the Files tab. Files Claude Code hands you with `SendUserFile` read as a card next to the answer, outside the folded work: its caption, then each file by name with its folder, opened the same way when pressed (a call still running, failed, whose result does not say its files were delivered, or with an input HerdRabbit cannot read stays an ordinary tool row). Scrolling up loads earlier turns; the view follows new turns while you are at the end. Markdown is drawn safely: everything is escaped, and only http(s) and mailto links are made. A code block over 30 lines opens showing its first 20, with **Show all N lines** below it. Blocks in JavaScript/TypeScript, Python, shell, JSON, CSS and diff are coloured by a small built-in tokenizer that only sets text (no library, no build step); other languages, and blocks over 30,000 characters, stay plain. Changes are announced over the terminal socket while the chat is on screen, and each read sends `If-None-Match`, so an unchanged conversation costs nothing.

An OpenCode pane's chat reads OpenCode's own database, `opencode.db` under `$XDG_DATA_HOME/opencode` (else `~/.local/share/opencode`), read only. The session is the one herdr's OpenCode plugin reports for the pane (it follows a switch in `/sessions`); with none reported, the newest top-level session started in the pane's folder, as long as it changed after the pane's OpenCode started (an older one is an earlier run's conversation). A subagent's child session is never shown as the pane's. Your prompts, OpenCode's answers and reasoning, and its tool calls read as they do for Claude: `bash` as a command, `read`, `grep` and `glob` as reads, `edit`, `write` and `apply_patch` as edits with their diff or patch, `todowrite` as a to-do list, and a `question` as the question and its choices (answered on its prompt card, below). Only the session's messages and their parts are read, by a fixed set of queries; the sign-ins and share secrets OpenCode keeps in the same database are never read. A database whose tables HerdRabbit does not know says so on the Chat button instead of showing a broken chat. OpenCode panes get Stop, prompt cards and the `/` list like the others.

A Kiro CLI pane's chat reads the transcript Kiro writes, `sessions/<workspace hash>/sess_<id>/messages.jsonl` under `$KIRO_CONFIG_DIR` (else `~/.kiro`), the hash being taken from the pane's folder. Herdr reports no Kiro session, so the session is the one the pane's own Kiro process logs that it loads (read through Linux `/proc`); without that, the newest session in the pane's folder that was written after the pane's Kiro started, but only while no other Kiro pane is in the same folder, since both would show it (the Chat button then says "Chat appears once the agent reports its conversation."). An Antigravity CLI pane's chat reads the step ledger agy writes, `brain/<id>/.system_generated/logs/transcript_full.jsonl` under `$ANTIGRAVITY_APP_DATA_DIR` (else `~/.gemini/antigravity-cli`). agy records no folder for a session, so the session is the one whose presence lock (`presence/<id>.lock`) the pane's own agy process holds open, also read through Linux `/proc`; agy takes it with the first message, so until then (or while not exactly one lock is held) the chat is empty. For both, your prompts, the answers and the tool calls read as they do for the other agents, except that an agy tool call shows only the output agy logged: its records carry no id to fetch the whole output by.

Whatever the agent, a pane whose agent runs but has not written its first message, or whose conversation nothing names yet, opens an empty chat ("No conversation yet") instead of a disabled Chat button, and shows the conversation once it is found; a Kiro session the pane's Kiro names but has not written yet is that session's empty chat. The Chat button stays disabled where the pane's conversation cannot be told from another pane's (two Kiro panes in one folder whose own Kiro names no session; an OpenCode pane with no session reported for it in a folder with another OpenCode pane whose session herdr does not report), where herdr names an OpenCode session that is not one or only a subagent's child session whose top-level session is not there, where herdr names a Codex rollout by a path that is gone and neither one rollout the pane's Codex holds open nor one thread its title names tells the pane's, and in the cases above where the conversation cannot be read at all (an OpenCode database HerdRabbit does not know, a Node.js older than 22.13 for OpenCode, a connected PC that is offline or too old). A conversation is only ever taken from the folder's newest when it changed after the pane's agent started, so a new conversation never shows an earlier one's turns; a conversation resumed without herdr naming it shows once its next message is written. A chat shown again reads its conversation at once rather than showing what it kept while hidden.

A pane of a PC added with Connect PC (B) is read by B itself: B finds and reads its own transcripts exactly as its own page does (the Codex rollout by B's own processes and screen too, the OpenCode session from B's own database), and A only relays the pages, a tool's whole output, the plan or question a prompt card shows, the OpenCode version a pane's cards are read for, and a short change signature that A asks for every 1.5 seconds while the chat is on screen. B answers this only for its own panes, never for a PC it reaches itself, and no transcript path or file crosses the link beyond what the page already shows.

The last lens chosen is remembered per pane. A pane never chosen for opens in the lens **Open panes in** names (⚙ Settings → Chat, kept in this browser): **Auto** (the default) opens it in Chat on a phone or touch screen and in Terminal on a desktop; **Chat** or **Terminal** opens it there on any screen. A pane's own last choice always wins over the setting. A pane that runs none of Claude Code, Codex, OpenCode, Kiro CLI and Antigravity CLI, or whose conversation cannot be read yet (no conversation reported, no file), shows only its terminal, and the Chat button says why. Sending from the chat uses the same composer and send path as the terminal.

A local image the agent writes into its answer, `![chart](out/chart.png)` or `![](/tmp/plot.svg)`, shows in the chat as the picture. A relative path is resolved against the pane's folder, the same way a path link is. The picture is read only through the Files viewer's file route: a view ticket from `POST /api/browse/tickets`, which refuses a protected path (`~/.ssh`, sign-in files, HerdRabbit's own settings), and then `/api/browse/download/<ticket>`. Only names the viewer draws as images count (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG, an SVG always inside an `<img>`). A picture loads when it scrolls near the screen. A missing or protected file, a home path (`~/…`) or a Windows path keeps its plain fallback, the image's words and a link to its path, followed by "Image unavailable". A remote image (`![logo](https://…)`) is never loaded: it stays a link to its address, as before, and nothing is fetched from that host.

Pressing a picture opens it full screen, together with the other pictures shown in that chat. The wheel, a pinch, **Zoom in** / **Zoom out** or `+` / `-` zoom it at the pointer up to 8x, and the percentage button (or `0`) fits it again. A drag, a finger or the arrow keys pan a zoomed picture. A double click or a double tap switches between fit and 2.5x. At fit, the side buttons, a swipe or Left / Right step to the next or previous picture, wrapping at both ends. **Copy image** puts the picture on the clipboard as PNG (this needs HTTPS or `localhost`). **Download image** saves the file through a download ticket, as the Files tab does. Esc or **Close** closes it. Every control is 44 px square, so the viewer works on a phone, and the viewer's own gestures never zoom the page.

In a grid or a split view each cell has its own Chat and Terminal (see Split panes); several cells can show their conversations side by side, and the composer answers the selected one.

The chat is for reading and answering, so the extra-keys bar (Esc, arrows, Ctrl, …) shows only in the Terminal lens (and only on a touch screen or a phone-sized window); the composer (files, text, send) stays in both. On a desktop, a click in the conversation puts the typing in the composer, as in a Chat cell (not a click on its buttons, links or card, nor a drag that selects text); until you type, `Ctrl`/`Cmd`+`F` still finds in the conversation. A long conversation draws only the turns near the view, so a new answer costs the same however much is above it. A message sent from the chat shows at once as a dimmed pending bubble (until the transcript has it, or a message that ends with it; a bubble that has waited 5 seconds gets a clock, a bubble whose place a different message took goes after a few seconds, and none waits more than a minute), the view jumps to the end and follows the reply, and a "Claude is working · 1m 12s" (or "Codex is working", "OpenCode is working", "Kiro is working", "Antigravity is working") row stands at the end while the agent works (no animation with reduced motion). `Ctrl`/`Cmd`+wheel, a trackpad pinch or a two-finger pinch over the chat sets the chat's own text size (12-24 px, remembered apart from the terminal's), which the composer takes in the Chat lens. Switching from the chat to the Terminal lens brings the terminal down to the newest output. Copy buttons are icons that turn into a check for a moment once the copy worked. An agent's answer has one copy icon that opens a small menu beside it: **Copy as Markdown** copies the answer as the agent wrote it, and **Copy as text** copies it as the chat reads, with no Markdown marks (list bullets and numbers stay, table cells are split by tabs, code keeps its text, and a link keeps its address in brackets after its words). A user message of more than 12 lines (or a long paste with few line breaks) is folded to its first 12 lines with a "Show all" button under it; "Show less" folds it again, and an opened message stays open while the chat is up.

While the agent works in the Chat lens and the composer is empty, the Send button turns into **Stop** (a red square), whether the composer is focused or not. It does what Esc does in the terminal: it sends one Esc to the pane, exactly the key bar's Esc, to interrupt Claude Code, Codex, Kiro CLI or Antigravity CLI (one Esc stops Kiro CLI 2.35.1 and agy 1.4.10, checked 2026-10-30). OpenCode interrupts only on a second Esc within 5 seconds ("esc again to interrupt"), so for an OpenCode pane Stop sends two Escs 0.4 s apart (apart, as two Escs back to back can read as Alt+Esc). OpenCode's Esc is not always its interrupt: an open autocomplete list, its shell mode (`!`) or an input without the focus takes the first one, and the Escs then stop nothing. So 2.5 s after an OpenCode Stop the chat looks at the pane again and, if herdr still reports it working, says so under the composer ("OpenCode is still working. If it should stop, press Stop again or press Esc twice in the terminal."); it does not press again on its own, since another Esc could close what the first one opened. Type into the composer and the button is Send again, so a draft can still go out while the agent works; for 1.5 s after a message goes out it stays Send, so a quick second click never stops what was just sent. What a press does is decided when it starts. Stop asks for no confirmation (Esc interrupts the work, the conversation stays), and is busy for a moment after a press; press it again if the agent needs a second Esc. Claude Code puts a message it was stopped on right after it went in back into its input box; before the next message goes, HerdRabbit reads that box (only after this Stop button or the composer's Esc stop; an Esc sent from the key bar or typed in the terminal is just a key and clears nothing) and, when it holds exactly the stopped message, empties it (Ctrl+K, Ctrl+U), so the new message is not typed after it. This is for Claude Code panes; a Codex, Kiro or Antigravity pane's Stop is just the Esc, and an OpenCode pane's the two. Anything else in the box, such as text typed in the terminal, is left alone and the send is refused rather than typed after it; so is a send when the stopped message cannot be cleared, the box cannot be found or read, or something else changes it while it is being cleared. The draft stays in the composer; clear the box in the terminal and send again. Esc in the composer stops too while the agent works, unless the `@` file list, find or a dialog is open, or an input method is composing. The button stays Send when the agent is idle, done or asking, and in the Terminal lens, where the key bar has Esc. It works for a connected PC's panes too.

### Prompt cards

For the selected Claude, Codex, OpenCode or Kiro CLI pane, whatever status herdr reports (it does not always say blocked while a menu waits), the server reads the pane's screen and turns a menu it finds there into a card; ordinary output, including a numbered list in an answer, is never a card. The cards: Claude Code's tool approvals (Yes / Yes, and don't ask again / No), plans, AskUserQuestion menus (one choice, several, or a typed answer), the review that submits several answers, and its unnumbered menus such as the folder-trust check; Codex's approvals (run a command, apply edits, trust a folder, with its "No, and tell Codex what to do differently" answered by Esc), its plan-mode questions (an option, or a typed answer in the notes of "None of the above"), the questions it queues while it works, and its "Press enter to continue" menus; OpenCode's permission requests (Allow once / Allow always / Reject, with what the tool would do: the command, the edit's diff, the path or patterns), the "Always allow" check that Allow always opens (Confirm / Cancel), the message a subagent's Reject asks for (typed on the card, or none), the questions of its `question` tool (one choice, several, or a typed answer through "Type your own answer") and the review that submits several; Kiro CLI's tool approvals (Allow once / Deny once and its rule rows), the scope menu a rule row opens, and its other arrow-key menus such as trusting a workspace, each row picked as in the terminal (the arrows move Kiro's `❯` onto it, then Enter). OpenCode's permission buttons sit in a row and the selected one differs only in colour, so an OpenCode pane's screen is read with its colours: the card moves the selection with ← / → and sends Enter once the screen shows it on the chosen button; Reject is Esc. When the colours cannot be read, or no single button carries the colour of the panel's "△", the card still shows but only Reject answers from it. While an OpenCode dialog is open over the session, keys go to the dialog and the panel only dims under it, so no prompt card shows until the dialog closes: a dialog with a search box (the `ctrl+p` command list, the session list, the model and agent pickers) gets none, and any other (`/status`, `/help`) is a panel card (below). OpenCode cards appear only for OpenCode 1.18.x, 1.19.x and 2.x (checked on 1.18.34, 1.19.3 and 2.2.5), by the version of the OpenCode program running in the pane (read from the program itself on Linux), or where that cannot be told, the version that created the pane's session in OpenCode's database (a session carried on by a newer OpenCode keeps it); a connected PC's pane is read on that PC; a pane of any other version, or whose version cannot be read, gets no card, not even the fallback, and is answered in its terminal, while its chat still reads. The Reject message and the review of several answers are looked at again before each key: the same card still on screen, and before the Enter that sends a message, the box holding exactly that message; otherwise the answer stops with "The prompt changed" rather than typing into OpenCode's own input. A question of several paragraphs shows them all. A question's rows are picked by their digit (the first nine). Only while herdr reports the pane blocked, a screen no reader knows becomes a fallback card with the last lines and basic keys (Enter, Esc, a numbered menu's digits, y/n). That is the only prompt card an Antigravity CLI pane gets: agy has no reader of its own, so its menus become cards only while herdr reports it blocked (its `/` panels are panel cards, below). A Claude plan or question card takes its words from the call Claude waits on in its transcript (the whole plan of `ExitPlanMode`, the whole question and options of `AskUserQuestion`), and an OpenCode question card from the `question` call still running in OpenCode's database (one more fixed query), since the terminal may have scrolled a long plan away or cut an option short with `…` in a narrow pane; the rows, the keys and what the answer is checked against stay the screen's, and the screen's words remain when the transcript cannot say. A password prompt is never a card. In the Chat lens the card sits at the bottom, above the composer; over the Terminal lens a banner says the agent is asking and **Answer** switches to the chat, or, for a pane with no chat, opens the same card over the terminal. A banner can be dismissed for that prompt.

A card says "Needs your answer" above its title. While a card that takes one choice is open, the composer reads "Type 1–3 to answer, or a message" (its own numbers): typing just an option's number marks that option on the card, and Enter (or Send) answers the card with it, checked like a press of the option; any other text is sent as a message. Once an answer leaves the card, the chat shows "You answered" and the answer at its end until the transcript moves on, or for a minute at most.

On a phone the pane header shows only the tab's name before the pane's title; the workspace and machine are in the sidebar.

While a Claude AskUserQuestion is open, Claude Code has not yet written the message before it (an answer, a table) nor the question to its transcript, so the chat cannot show that message. The question card then carries it: what the terminal shows from Claude's last message bullet down to the question's rule (the last 6,000 characters at most, cut at a line; the rule, the question, its rows and the key hint stay out), read once per card from the pane's recent lines. It sits folded above the question as "Claude's message above this question (from the terminal)", in monospace as the terminal draws it, as plain text. It goes, without a reload, once the chat's last agent turns contain its first line of words (compared without Markdown marks and table borders), that is, once the transcript has caught up. A question whose last row is Claude's "Chat about this" gets a **Chat about this** button that picks that row as the terminal would: the cursor moved onto it, then Enter, checked like any option.

Pressing an option posts the card's id: the server reads the screen again, refuses with `409 prompt_changed` if the prompt is no longer the one shown (the card then refreshes), sends the cursor moves, and sends the Enter only once the screen shows the cursor on the chosen row. Cards are pushed over the terminal socket only for the selected pane and for the panes of a grid's or split view's Chat cells (each shows its own card at its bottom; the selected cell's is the one the composer's numbers answer), and only while it is a Claude, Codex, OpenCode, Kiro or Antigravity pane or is blocked. One socket watches at most 8 conversations and 8 panes' cards. A connected PC's panes work the same way.

A panel an agent's own `/` command opens is a **panel card**, for Claude Code, Codex, Kiro CLI, Antigravity CLI and OpenCode panes, whatever status herdr reports (it calls most of them idle, and Claude's `/mcp` blocked): Claude's settings panel (`/usage`, `/status`, `/config`, `/cost`, `/stats`) and its `/mcp`, `/plugin`, `/hooks`, `/memory`, `/permissions`, `/help`; Codex's `/usage`, `/config`, `/hooks`, `/skills`, `/permissions`, `/experimental`, `/statusline`, `/agents`; Kiro's `/usage`, `/context`, `/config`, `/mcp`, `/tools`, `/help` and its other panels; Antigravity's `/usage`, `/help`, `/config`, `/mcp`, `/tasks` and its other panels; OpenCode's `/status` and `/help` dialogs. The card shows the panel's name and the tab shown (its tab row as chips, the shown tab picked out as the terminal colours it), the panel's text in monospace as the terminal draws it (a wide line scrolls sideways inside the card), and a button per key the panel's hint line names (`←/→/tab to switch · Esc to close`, `enter open · esc back`, `Keyboard: ↑/↓ Navigate  esc Close`), the arrows first in one order (← → ↑ ↓), Esc last. A panel with tabs gets ← and →, and a list with a row picked ↑ and ↓, even where its hint leaves them out. No button is made for a key whose hint says it kills, deletes, removes, resets, signs out or buys something, or quits or stops the agent, nor ever for Ctrl+C, Ctrl+D or Ctrl+Z; Esc, which closes every panel, is always there. A button sends its key as it is, and the card stays and follows the panel (another tab, the next row) until the panel closes. The key goes only while the same panel is still on screen (another panel, or none, refuses it with `409 prompt_changed` and the card is read again); the same key may go again at once. The panel is read again with its colours from the pane's recent lines (`pane read --source recent-unwrapped`), so a panel taller than the pane keeps its tab row, and only when its plain screen ends with such a hint, or, for Claude's tabs that draw none (Stats), shows its tab row under the last rule. An OpenCode dialog is read as OpenCode's screen always is, with its colours from the visible screen, and known by its title row with `esc` (or `esc/enter`) at its right edge. While a panel card is open the composer reads "Typing goes to the open panel": a number answers nothing, and what is sent goes to the panel (a search field, for one). Over the Terminal lens the banner says "Claude has a panel open: Usage" and **Open** shows the card. Claude's and Codex's `/model` and Claude's `/effort` get no card: their Enter saves a default, so they are answered in the terminal. Checked on Claude Code 2.1.322, Codex 0.167.0, Kiro CLI 2.35.1, Antigravity CLI 1.5.2 and OpenCode 2.2.6.

While the pane shows a password prompt (`[sudo] password for …:`, `Password:`, a passphrase or PIN), a message sent from the composer is not kept in its input history or in notification requests.

### Extra keys and drafts

The two-row key bar under the terminal (on a touch screen or a phone-sized window) can be edited. Choose **Edit keys** on the Terminal & keys page of ⚙ Settings at the bottom of the sidebar to open a window where you can add keys from a list (named keys, F1-F12, and the Ctrl, Alt and Shift latches), remove them, and reorder them by dragging a row on a desktop or with each row's up and down buttons on a touch screen. **Custom combination** adds a chord such as `Ctrl`+`R`, `Ctrl`+`Shift`+`Z` or `Ctrl`+`Shift`+`F5` from a base key (or any single character) and the modifiers you pick; a saved combination always sends exactly that chord, while a plain key still takes the Shift, Ctrl and Alt you latched. The layout is saved in this browser, up to 40 keys, and applies at once; **Reset to default** brings back the original bar. The bar stays hidden in the Chat lens.

Each pane keeps its own unsent composer text. Opening another pane saves what you typed and shows that pane's draft; a reload brings the drafts back (up to 30 panes, 8000 characters each, kept a week, stored in this browser). A draft is removed when its message is sent. Text sent as a password answer is not kept as a draft.

### Input

Click or tap an attached terminal and type: text, Tab, arrows, Enter, and Ctrl combinations go to the current pane immediately, including shell and agent completion menus. `Ctrl+Enter` in the terminal sends a line feed (`Ctrl+J`), as a native terminal does, so Claude Code and Codex start a new line instead of sending. Dragging over the terminal selects text instead of sending mouse clicks to the program; a **Copy** button appears over the selection, and `Ctrl`+`C` copies it too. On a phone, hold a finger still for half a second, then drag to select; a short drag still scrolls. The composer below is the draft-and-submit way in, and the only one for a mirrored pane. On a phone, a key on the extra-keys bar tapped after the keyboard was put away does not bring it back. While the keyboard is up the page fits the room above it, so the composer and extra keys stay just above the keyboard, and the terminal keeps its size and shows its bottom rows, where the prompt is; the pane is not resized as the keyboard comes and goes.

`Ctrl`+`F` (`Cmd`+`F` on a Mac) over the Terminal view, or the magnifier in the pane header (a grid or split view has no magnifier; the shortcut finds in the selected cell), opens **Find in terminal**: it searches the pane's whole Herdr history (Herdr's own copy-mode search, a capital letter makes it case-sensitive), shows "3/17", and scrolls the pane's view to the match, for every client of that pane. `Enter` steps to an older match and `Shift`+`Enter` to a newer one; matches on screen are tinted, and `Esc` closes the bar where the view is. From the composer or any other text field `Ctrl`+`F` stays the browser's, and a mirrored pane has no find. Find uses Herdr's copy-mode search over its socket API and was checked on Herdr 0.9.3; on an older Herdr that lacks it the bar says the search failed, with Herdr's reason, and the rest of HerdRabbit works as before.

Over the Chat view the same shortcut and magnifier open **Find in conversation**: it searches the messages already loaded on the page (what is drawn, including open work blocks; work folded shut is not searched), marks every match, shows "3/17", and scrolls the current one to the middle of the view, unfolding a folded code block or user message for it. `Enter` steps up and `Shift`+`Enter` down, `Esc` takes the marks away. While earlier messages are not loaded the bar says so, with a button that loads them.

| Action | Key or control |
| --- | --- |
| Send input in a mouse-oriented environment | `Enter` |
| Insert a newline in a mouse-oriented environment | `Shift+Enter` or `Ctrl+Enter` |
| Insert a newline from the on-screen keyboard of a touch device | `Enter` (in **Auto**, until a physical keyboard is seen on the page; see below) |
| Send input in a touch-oriented environment | Arrow send button, or `Ctrl+Enter` / `Cmd+Enter` |
| Send from a physical keyboard on a touch device | `Enter`: in **Auto** once a letter or digit has been typed on it, always in **Send**, never in **New line** (see below) |
| Insert a newline from a physical keyboard on a touch device | `Shift+Enter` |
| Recall previous sent input | `↑` |
| Recall later input or restore the current draft | `↓` |

On a touch device **Edit keys** (⚙ Settings → Terminal & keys) has an **Enter in the message box** choice of three, kept in this browser: **Auto** (the default) inserts a newline until a physical keyboard is seen on the page and sends from then on; **New line** always inserts a newline, as before; **Send** always sends, as on a desktop. A browser does not say whether a keyboard is plugged in, so Auto takes a letter or digit key reporting its physical key code, pressed without Ctrl, Alt or Cmd, as the sign: on-screen keyboards leave that code empty or report key code 229, and an input method's composing keys (Korean, Japanese, ...) are not counted. The sign lasts until the page is reloaded: a keyboard unplugged after it was seen leaves `Enter` sending from the on-screen keyboard too, until you reload the page or choose **New line**. In every mode `Shift+Enter` is a newline, `Ctrl+Enter` or `Cmd+Enter` sends, and an `Enter` that confirms an input method's composition never sends. The choice is not shown in a mouse-oriented environment, where `Enter` always sends.

What a touch device is, is decided from the browser's touch information, not the device's name: a primary pointer that is coarse and cannot hover, any coarse pointer when no pointer can hover, or touch points in a window at most 1024px wide (so a narrow window on a PC without touch is not taken for one, nor a touchscreen laptop with a mouse in a wider window).

What you send is typed into the selected pane with Enter, whatever runs there, through Herdr's `pane run` (text naming an image is typed first and Enter pressed after it); at a shell prompt it runs as a command. The server has no API that runs a command you write anywhere but in a pane.

The composer starts as one row: the Files button, the text, the microphone and Send side by side. Once the text needs a second line at that width, or holds a newline, the composer becomes a card: the text takes the full width on top and the buttons move to their own row below it (Files at the left, the microphone and Send at the right). The text then grows to about eight lines or 40% of the screen height, whichever is smaller, and scrolls internally beyond that. Making the text shorter keeps the card; it returns to one row when the box is empty again, after sending or clearing.

Type `@` at the start of the composer or after a space to reference a file, as Claude Code and Codex take it: a list above the composer offers the names in the selected pane's working folder (the folder its program runs in, else the folder the pane started in), folders first, up to 50. Typing narrows it (`@src/ap`), `↑`/`↓` move, `Enter` or `Tab` (or a tap) picks a name, and `Esc` closes the list without sending; while the list is open `Enter` never sends. A folder goes in as `@src/` and its contents are offered next; a file goes in as `@src/app.js ` with a space after it. A name with a space goes in quoted, `@"my folder/notes.md"`, the form Claude Code accepts. `@/abs/path` lists from the root; hidden names show only once you type the leading `.`, and locked files are not offered. `@~/` is not completed: the home folder belongs to the pane's machine and the listing cannot name it, so type a path from the pane's folder or an absolute one instead. A pane with no known folder, or a folder that cannot be listed, simply shows no list.

Type `/` at the very start of the composer to pick a command for the selected pane's agent. A Claude Code pane offers Claude Code's own commands and the skills it bundles (`/compact`, `/model`, ...), your skills and commands (`~/.claude/skills/<name>/SKILL.md`, `~/.claude/commands/**/*.md`, a subfolder's as `dir:name`; under `$CLAUDE_CONFIG_DIR` when that is set), the project's (`.claude/skills` and `.claude/commands` in the pane's working folder and, in a git checkout, in each folder above it up to the checkout's root) and those of installed plugins (as `plugin:name`, from `~/.claude/plugins/installed_plugins.json`, or `$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json` when that is set); a Codex pane offers Codex's own commands and your prompts in `~/.codex/prompts` (`$CODEX_HOME/prompts` when that is set; as `prompts:name`); an OpenCode pane offers OpenCode's own commands as of 1.19.3 (with their aliases, the server's `/init` and `/review` and the built-in `customize-opencode` skill; `/variants`, `/org`, `/update`, `/warp` and `/workspaces` work in OpenCode only where they apply), the command files of its config folders (`commands/*.md` and the older singular `command/`; subfolders are not read) and its skills, which OpenCode takes as `/name` too (every `SKILL.md` under a config folder's `skill/` or `skills/`, and under `.claude/skills` and `.agents/skills`, named by its frontmatter's `name`; one without a `name` is not listed, nor a skill named like a command). The config folders are those OpenCode reads: `.opencode` in the pane's working folder and in each folder above it up to the git checkout's root (outside a checkout, up to `/`; 32 folders at most), `~/.opencode`, `$OPENCODE_CONFIG_DIR` and `$XDG_CONFIG_HOME/opencode` (by default `~/.config/opencode`); `.claude/skills` and `.agents/skills` are looked for in the same folders on the way up and in the home folder. `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_EXTERNAL_SKILLS` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` (or `OPENCODE_DISABLE_CLAUDE_CODE`) are taken from the HerdRabbit server's environment (a connected PC's from its own) and followed as OpenCode follows them. Commands and skill paths defined in `opencode.json` are not listed: HerdRabbit never opens that file, since it can hold keys. A Kiro CLI pane offers Kiro's own commands as of kiro-cli 2.35.1 and its skills and file prompts: `.kiro/skills/<name>/SKILL.md` and `.kiro/prompts/<name>.md` in the pane's working folder (not the folders above it, which Kiro does not read), then the same under `$KIRO_CONFIG_DIR` (else `~/.kiro`); prompts an MCP server offers are not listed. An Antigravity CLI pane offers agy's own commands and the skills it ships as of agy 1.4.12, and its skills: `.agents/skills/<name>/SKILL.md` in the pane's working folder and, in a git checkout, in each folder above it up to the checkout's root, then `~/.gemini/config/skills`. Each row shows the name, a one-line description and where it comes from (built-in, user, project or plugin). Typing narrows the list (names that start with what you typed first, then names and descriptions that contain it), and the keys and taps work as in the `@` list; picking puts `/name ` in with a space after it and sends nothing. Only the name and description in each file's frontmatter (or its first line) are read, never its body, and nothing outside those folders is opened. Claude Code's and Codex's own commands are those of the version the pane runs, read from where its executable is installed (`/proc/<pid>/exe`, so a build an update removed while it runs still counts). Claude Code is asked itself: that build is run once per version with `-p --setting-sources "" --strict-mcp-config --input-format stream-json --output-format stream-json --verbose`, so none of your settings, hooks, plugins or MCP servers load and no model is asked, and answers its SDK `initialize` request; the commands only its terminal UI has (`/resume`, `/exit`, `/help`, ...), which that answer leaves out, come from a list kept in HerdRabbit as of 2.1.319; after a Claude Code update, `npm run check:agent-commands` says whether that list is behind Claude Code's commands reference (a new command only its terminal UI has also goes in `CLAUDE_TUI_ONLY_COMMANDS` in `src/slash-commands.mjs`). Codex's come from its release: the popup's list in that version's source on GitHub (`openai/codex` at tag `rust-v<version>`), fetched once per version, less its debug-only commands, those of other platforms and those it marks "DO NOT USE". Each version's list is kept in `$XDG_DATA_HOME/herdrabbit/agent-commands` (else `~/.local/share/herdrabbit/agent-commands`), so it is looked up once; one that cannot be had (no network, a build that will not answer) is tried again after an hour, and meanwhile the lists kept in HerdRabbit stand in (Claude Code 2.1.319, Codex 0.167.0). The other agents' own commands are a fixed list kept in HerdRabbit, so a newer or older CLI may have a few more or fewer. Plugins are listed as installed, whether or not they are switched off in Claude Code's settings, which HerdRabbit does not read. A pane on a PC connected with Connect PC offers that PC's own list (its skills, commands, the pane's project, its plugins and prompts, read there by that PC) when it runs this version or later, otherwise its agent's own commands only. A pane running anything else shows no list.

### Keyboard shortcuts

Every shortcut the page itself answers. Keys typed in an attached terminal go to the program, except where a row says otherwise. On a Mac, read `Cmd` where a row says `Ctrl`/`Cmd`.

| Where | Keys | What it does |
| --- | --- | --- |
| Grid or split view | `Alt`+`←` `→` `↑` `↓` | Move to the cell on that side; a Chat cell focuses the composer, a Terminal cell its terminal ([Split panes](#split-panes)) |
| Anywhere | `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous sidebar entry (in a grid, the cell of that pane). Only when the browser forwards it, as an installed PWA window does |
| Anywhere | `Ctrl+1`–`Ctrl+9` | The sidebar entry of that number, as above |
| Pane | `Ctrl`/`Cmd`+`J` | Switch the pane (or the selected cell) between Chat and Terminal. Inside a terminal `Ctrl+J` stays the program's |
| Pane | `Ctrl`/`Cmd`+`F` | Find in the terminal's history or in the conversation, by lens. From the composer or another text field it stays the browser's |
| Find bar | `Enter` / `Shift+Enter` / `Esc` | Older (up) / newer (down) match / close |
| Composer | `Enter` | Send (see [Input](#input) for touch devices) |
| Composer | `Shift+Enter`, `Ctrl+Enter` | New line |
| Composer | `↑` / `↓` | Earlier / later sent input, at the start / end of the text |
| Composer | `Esc` | Stop the agent while it works in the Chat lens |
| Composer, `@` or `/` list | `↑` `↓`, `Enter` or `Tab`, `Esc` | Move, pick, close |
| Terminal | `Ctrl+Enter` | Line feed (`Ctrl+J`): a new line in Claude Code and Codex |
| Terminal | `Ctrl+C` with text selected, `Ctrl+V` | Copy the selection, paste |
| Grid | `Ctrl`/`Cmd`+wheel, `Ctrl`/`Cmd`+`0` | With **Fit panes to this window** off: the grid's text size, back to the size that fits. With it on, the wheel sizes the terminal font as for a pane alone |
| Pane alone | `Ctrl`/`Cmd`+wheel | Terminal text size |
| Grid | `Esc` while carrying a cell | Put it back |
| Grid | `Enter` or `Space` on a focused cell | Select it; a Terminal cell's terminal takes the typing |
| Image viewer | `←` `→`, `+` `-` `0`, arrows when zoomed, `Esc` | Previous / next image, zoom in / out / fit, pan, close |
| Menus and sidebar | `Esc` | Close the open menu, then the phone sidebar |

### Files

The attach button beside the composer, and the folder icon at the foot of the sidebar, both open the **Uploads** dialog. Pick one or more files and choose **Upload**: they go up one at a time into a shared uploads folder on the machine running HerdRabbit, and their absolute paths are inserted into the composer in that order, ready to hand to an agent. A file that fails is named with the reason, and the rest still upload. Nothing is sent until you submit. The dialog also lists what the folder already holds, newest first, with a row each for inserting the path, copying it, downloading the file, and deleting it.

Files can also be dropped anywhere on the terminal panel, several at once, without opening anything, and an image pasted with `Ctrl`/`Cmd`+`V` is uploaded the same way — a screenshot goes from the clipboard to a path in the composer in one step, stored under a name that records when it arrived. Ordinary text pasting is unchanged.

Browsing is separate, in the sidebar. It has two tabs: **Workspaces** is the workspace list, and **Files** is a tree of the machine's filesystem. Folders expand in place when you click their name or the arrow beside them, and a folder's own button re-roots the tree there so a deep path stops costing indentation. The path field at the foot of the tab goes straight to a folder, its ↑ button walks to the parent, and dotfiles are always listed. Any file can be downloaded to the browsing device from its row.

A file's **View** (the eye on its row) opens it in place. A picture opens full screen in the same picture viewer as the chat's (zoom up to 8x with the buttons, the wheel or a pinch, pan, copy, download). An SVG, an HTML page and Markdown open in the viewer dialog with **Source** beside the drawing; an SVG there zooms with a pinch, a double tap or `Ctrl`/`Cmd`+wheel, and drags when zoomed. Text opens as characters, and a pinch or `Ctrl`/`Cmd`+wheel over it sets its letter size (0.6x to 4x). The page itself never zooms. A file whose extension is not on the viewer's list (a `.service` unit, `LICENSE`, a `.mdc` rule) is tried as text too, up to 2 MB: when its bytes hold a NUL in the first 8 KB it is binary, and the viewer says to download it instead. Archives, programs, office files, fonts and databases are never tried.

The path box at the foot of the tab goes anywhere directly. Typing offers matching folder names — arrow keys move through them and `Enter` opens the highlighted one. The tab reopens wherever browsing last stopped, and the uploads folder is the starting point on a first visit.

Sign-in keys and HerdRabbit's own settings are never opened: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.password-store`, `~/.local/share/keyrings`, `~/.config/gh`, `~/.config/gcloud`, `~/.config/rclone`, `~/.netrc`, `~/.git-credentials`, `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials(.toml)`, the AI CLIs' sign-ins (`~/.claude/.credentials.json`, `~/.claude.json`, `~/.codex/auth.json`, `~/.gemini/antigravity-cli/antigravity-oauth-token`, `~/.local/share/kiro-cli/data.sqlite3`, `~/.config/claude*`, and the same files where `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `XDG_DATA_HOME` put them) and HerdRabbit's settings folder show in the tree as **locked**, by name only, and cannot be expanded, viewed or downloaded -- also through a symbolic link and over Connect PC.

Browsing is read-only: nothing in the tree can be changed, and uploading and deleting live in the Uploads dialog instead. Files copied into the folder from a terminal appear in that dialog too. The uploads folder is `~/.local/share/herdrabbit/files` unless `HERDR_WEB_FILES_DIR` names another directory; it is deliberately separate from the configuration directory that holds credentials. Uploads and downloads have no size limit by default; `HERDR_WEB_MAX_TRANSFER_MB` sets one limit (in megabytes) for both. The folder itself has no size or file-count limit, so it grows until the disk is full and nothing is removed on your behalf.

With more than one machine registered, the Files tab gains a picker: choose one and the tree shows that machine, starting at its home. Each machine remembers its own last folder.

That choice is also where uploads go. Until one is made, a file you attach or paste follows the tab you are looking at, and the path is inserted into the composer. Pick a machine and it is pinned for both browsing and uploading, across reloads. When the pinned machine is not the one the selected tab runs on, the path is **not** inserted -- it would name a file that tab cannot open -- and the upload says where it went instead. The attach button and the uploads dialog name the machine either way.

A connected PC's files are read and written by that PC itself. The confinement is the same on every machine: browsing is read-only, and writes reach only that machine's own uploads folder.

On iOS, a browser in standalone PWA mode may open a downloaded file instead of saving it. Use the share sheet to store it.

A file an agent names in its output is a link to itself. "wrote `src/api.mjs`", "see `./docs/plan.md`" -- the path opens in the viewer. A relative one is looked for where its writer most likely meant it, and the first place it is found wins: the folder of an absolute path written before it in the same chat turn ("made `/tmp/mock/1-a.png`; the same folder has `2-b.png`"), then the folder the agent works in (Claude Code's and Codex's transcripts record it, so a worktree counts), then the pane's own directory. One found nowhere says which folders were looked in. A file the viewer cannot show (say `app-release.aab`) opens the Files tab in its folder with that file selected, or says so when the file is no longer there. A folder written out in full is a link too: an absolute path (`/home/me/proj`) or one starting with `./` or `../` opens the Files tab inside that folder, and a path whose last name turns out to be a file there is selected in its parent instead; a closing slash (`/home/me/proj/`) means folder. Any other path becomes a link only when its last name is a file the viewer can show or has an extension (`name.ext`, with at least one letter in it), which is what keeps `src/foo`, `node_modules/`, `feat/settings-menu`, `1/2`, `.env`, `v1.2` and `10.0.0.1` plain. A lone `/word` (a slash command such as `/compact`), `//host/share` and the path inside a web address are not folder links. A path from `~` is a link too, and opens from the home of the machine the pane runs on. In the live terminal, these paths and web addresses are underlined all the time, so they can be seen and tapped on a phone, and an address the output wrapped onto the next line is still one link. A path with spaces is one link when it is quoted -- `"/home/me/my folder"`, `'./build output/app.aab'` -- and starts with `/`, `./` or `../`; the link covers what is inside the quotes, backticks count as quotes in the terminal too, and without quotes a path ends at its first space. A relative path links only when the pane's own directory is known. A path is a path in any script (`/home/me/프로젝트`), and a Korean particle written straight after a file name (`src/a.md를`) is not part of it. The chat view finds paths with the same code as the terminal, so the same text links the same paths in both. The one difference is a code span: the whole span is taken as one path, so a name written alone there (`app.js`) is a link too, and so is a path with spaces (`` `/home/me/my folder` ``), the backticks quoting it. Joining a path the output wrapped onto the next row is the terminal's alone; chat text is not wrapped.

A file can be opened instead of downloaded. Images, video and audio play in place, Markdown and HTML are drawn, and text, code, logs and config are shown as characters. Reading a log on a phone should not mean saving it first.

What may be shown, and as what, is decided from the name against an allow-list, never by sniffing the bytes. Nothing runs at this app's origin, and the two formats that could run are handled by how they are shown rather than by refusing them: an SVG goes in an `<img>`, which executes no script, and an HTML file is framed by a response whose own policy ends in `sandbox allow-scripts` -- an opaque origin, for anyone who opens that URL and not only for the frame (see below for what it may load). Both were measured against a file that tried to call home and neither reached anything. Markdown goes the same way: the server renders it with `marked` and sends the result, so it lands in the same frame with the same policy and the browser downloads nothing extra. Which hrefs may become links, and what happens to markup embedded in the document, are decided here rather than by the parser: http(s) or it stays text, and embedded markup is shown as the characters it is made of. Any of them can be read as its own source instead, one press away. A PDF opens in a tab rather than in the dialog. Framing one is the part browsers disagree about -- Android Chrome draws nothing in a frame, iOS Safari draws the first page -- while a tab is not framing at all, works everywhere, and gives a page-shaped document the full height it was written for. It also means a PDF needs no exception to the framing rules and gets none: only HTML is reopened, and an image response still says `frame-ancestors 'none'`. Text works the same way -- opaque bytes in, characters out, no content type negotiated. Downloads are unchanged: still `application/octet-stream` as an attachment, which is what keeps a stored page from ever running at this origin.

An HTML page, and Markdown, open with their folder: the page's own stylesheets, pictures, fonts and scripts load, and its scripts run, so a test report, a mockup comparison or a build's output looks as it does in a browser. The server hands the viewer a short-lived link that stands for that folder alone (`/api/browse/site/<ticket>/…`); anything that would climb out of it, or into a protected file, is refused, and a link inside the folder that points out of it is not followed. The page runs in a sandbox without `allow-same-origin`: an opaque origin with no cookie, no storage and no reach into this app, no forms, popups or navigation of the page around it. Every request it makes is held to its folder's own URL (and `data:` and `blob:`), so a script that reads a file beside it has nowhere to send it. **Settings → Files → Internet in HTML previews** (off unless chosen, per browser, taken when a page is opened) adds `https:`, for a page built on a CDN; with it on, a page could send what it reads from its folder to a site. Markdown's relative pictures and links resolve in the same folder. Images, video and audio the browser may or may not handle (HEIC, TIFF and JPEG XL pictures, MKV, 3GP, AVI, WMV and FLV video, AIFF audio) are handed to it; one it cannot draw or play says so in its place, beside the Download button.

Video seeks: a view link answers byte ranges, on a connected PC as well, because the machine holding the file is the one that slices it.

### AI accounts

A subscription CLI stops at its session or weekly limit, and moving to another account normally means signing in again. **AI accounts** in a server's row menu keeps each account's sign-in on that machine so switching is one press. Claude Code, Codex, the Antigravity CLI (`agy`) and Kiro CLI are supported.

The dialog has a tab for each CLI, wearing that program's mark and its name, with the number of saved accounts and a dot when one is in use; arrow keys, Home and End move between them. The tabs stay on one row: when they do not all fit, the row scrolls sideways (a swipe, the wheel, or the ‹ › buttons that appear on the side with more tabs). A CLI that has no sign-in and no saved account and is not installed on that machine (its command is not on the PATH the machine's HerdRabbit sees, the same answer New tab uses) has no tab; a machine on an older HerdRabbit that cannot say shows them all. The first tab chosen is the CLI whose account was just added or is being signed in, else the one last chosen in this browser. A tab lists its CLI's email addresses from A to Z, with the one in use marked in its place, and says there why a CLI cannot be switched when it cannot. Opening it saves the account signed in now, so there is nothing to save by hand. A line appears under an account only when it needs a new sign-in within a week or already does; Claude Code sign-ins last about a month, a Kiro CLI sign-in's client registration about three months, and Codex and Antigravity do not record when theirs will end. Nothing else about an account is shown.

- **Add account**, at the end of each CLI's list, opens an `AI login: …` workspace and types the sign-in command there: `claude auth login`, `codex login --device-auth`, `agy` itself (it has no sign-in command and signs in on its first run), or `kiro-cli login --use-device-flow` (it asks Builder ID, Google, GitHub or your organization), pointed at an empty directory of its own. `agy` starts there without a session bus (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` and `DISPLAY` unset), so the new sign-in is written to that directory and never into the keyring. It prints a Google sign-in address to open in any browser. Signing in where the live account lives would revoke that account, which is why it happens apart. Codex's device code sign-in has to be turned on in ChatGPT's security settings first. Signing in is noticed on its own: the page checks every few seconds whether the CLI has written its sign-in into that directory, saves the account the moment it has, and closes the project. AI accounts then opens again with the new account marked **Just added**, unless another dialog is open. A reload does not lose the wait: the machine keeps which sign-ins are still open, and the page picks them up again when it starts or when AI accounts is opened. It stops checking after 20 minutes, and **Cancel sign-in** in AI accounts ends it sooner. What you type into that project is not kept in prompt history.
- **Switch**, in an account's ⋯ menu, changes the account for the whole machine. Settings, MCP servers, conversation history and memory stay as they are, so `claude --continue`, `codex resume`, `agy --continue` or `kiro-cli chat --resume` picks up where the other account stopped. The account being replaced is saved first, which keeps the tokens the CLI rotated while using it. If Herdr shows the CLI running in any pane, the switch lists those panes and waits for confirmation; they keep the old account until restarted, so restart them soon: one that refreshes its sign-in before then can write the old account back. A CLI started outside Herdr is not seen.
- **Remove**, in the same menu, deletes the saved copy. It does not sign the account out anywhere.

**Usage** sits under the account in use: a bar for each limit its CLI reports, how much is used (amber from 80%, red from 95%), and when each starts again. HerdRabbit asks the CLI itself, so the CLI keeps refreshing its own sign-in and HerdRabbit never reads or writes a token for this:

| CLI | Asked with | Shows |
|---|---|---|
| Claude Code | `claude -p /usage --no-session-persistence` | the session and each week, as Claude words the reset; when the sign-in ends |
| Codex | `codex app-server`, `account/rateLimits/read` | each window (five hours, a week) with its reset; credits left; free limit resets |
| Antigravity CLI | `agy -p /usage` | each model group's limit (weekly, or daily when it reports one) |
| Kiro CLI | `kiro-cli chat` in a terminal, then `/usage` | the month's credits and when they reset |

None of these sends anything to a model or leaves a conversation behind. Kiro CLI has no way to print `/usage` -- run without a terminal it takes the words as a prompt -- so it is started in a terminal (node-pty), typed to only once its prompt is drawn, and closed as soon as its panel shows, or after 45 seconds when it does not. The CLIs run in an `ai-usage` directory beside the saved sign-ins (`~/.config/herdr-bridge/ai-usage` by default; beside `HERDR_WEB_AI_ACCOUNTS_DIR` when that is set), and only for the tab being looked at: Claude takes about ten seconds, Kiro about six, the others a second or two. An answer is kept a minute on the machine and for as long as the page is open; **Refresh** asks again, and switching accounts forgets the old one's. When the CLI cannot say, the block says why and offers **Retry**. On a connected PC the CLI runs there; a PC on an older HerdRabbit says to update it.

Each machine keeps its own accounts. On a connected PC the saving, signing in and switching run there, and only whose account is where comes back; no sign-in travels between machines.

Saved sign-ins are stored in `~/.config/herdr-bridge/ai-accounts`, or the directory in `HERDR_WEB_AI_ACCOUNTS_DIR`, as mode-`0600` files inside mode-`0700` directories that only the owning OS user can read.

The CLI's own files are what gets switched: `~/.claude/.credentials.json` plus the `oauthAccount` field of `~/.claude.json`, `~/.codex/auth.json`, and `~/.gemini/antigravity-cli/antigravity-oauth-token`, and the sign-in rows of Kiro CLI's `~/.local/share/kiro-cli/data.sqlite3` (or under `XDG_DATA_HOME`), or the directories in `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the HerdRabbit service sees them. Codex set to store sign-ins anywhere but a file (`cli_auth_credentials_store` other than `file`, such as `keyring` or `auto`) cannot be switched and says so; so does `agy` when the system keyring (Secret Service) holds its sign-in, which it uses whenever it can reach one, in place of the file. HerdRabbit asks the keyring only whether that entry exists, on the session bus in `DBUS_SESSION_BUS_ADDRESS` or `XDG_RUNTIME_DIR`; a service started with neither assumes the file, and one without `gdbus` says the keyring could not be checked. `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment still overrides whatever account is saved. Claude on macOS keeps sign-ins in the Keychain and is not supported. Kiro CLI keeps its sign-in in the same database as its conversations, history and telemetry, which running `kiro-cli` processes keep open, so only the sign-in rows (every `auth_kv` row named `kirocli:*` and the `auth.idc.start-url`, `auth.idc.region` and `api.codewhisperer.profile` state rows) are swapped, in one transaction that waits for a write in progress; each saved account keeps its own client registration. Nothing in that database says whose account it is, so HerdRabbit runs `kiro-cli whoami` to learn the email, over the network: once per sign-in while the service runs, plus once after each token refresh for a Google or GitHub sign-in, which has no client registration to tell it by. A saved account carries its email, so a restarted service knows the live one without asking; when it cannot tell whose the live sign-in is, a switch is refused rather than replacing it unsaved. Kiro CLI is switched on Linux only, with Node 22.13 or later (for `node:sqlite`).

### Plugins

**Settings → Plugins** manages Herdr's own plugins (`herdr plugin …`) on each machine. It is shown only when sign-in (a password) is on, and the server refuses every plugin request otherwise: a plugin runs its build and its own code on its machine, as the user HerdRabbit runs as.

- With more than one machine, **Machine** chooses which one the page shows: this PC or a connected PC.
- Each plugin shows its name, version and source (`owner/repo@ref`, linked to its GitHub repository), an **On/Off** switch (`herdr plugin enable|disable`), and a ⋯ menu with **Update** (`herdr plugin update <id> --yes`, for a plugin installed from GitHub) and **Uninstall…** (`herdr plugin uninstall <id>`, after a confirm).
- **Install plugin…** asks for a **Source**, `owner/repo` or `owner/repo/folder` (a pasted `https://github.com/…` address is reduced to that), and an optional **Ref** (a branch, tag or commit). It shows the `https://github.com/<owner>/<repo>` address it names and a warning that the plugin runs code on that machine, then asks to confirm before running `herdr plugin install <source> [--ref <ref>] --yes`.
- **Browse** lists the plugins in Herdr's plugin marketplace ([herdr.dev/plugins](https://herdr.dev/plugins/)): public GitHub repositories tagged `herdr-plugin`, one row per plugin manifest in them. Nobody reviews these listings: the install dialog warns before anything is installed. Search (every word must match the name, id, `owner/repo`, description, language or a topic), sort by Herdr's own orders (**Popular**, **Trending**, **Recently updated**, **Newest**, **Name**), and **Load more** reads 50 more. Each row shows the name, version, `owner/repo[/folder]` linked to GitHub, the description, ★ stars and stars this week, when it was last pushed, its platforms and "needs Herdr x or later" when the manifest says. A plugin the chosen machine already has (same id, or same repository and folder) says **Installed**; the others have **Install…**, which opens Install plugin… with Source filled in and goes through the same confirm step on the machine chosen in **Machine**. HerdRabbit is listed with no Install.
- The hub reads the list itself, not the browser: `https://assets.herdr.dev/plugins/index.json`, the file herdr.dev/plugins reads (not a documented API). It waits at most 15 seconds, reads at most 8 MB, takes only schema version 1, and keeps each field only when it passes the same rules an install does (links are only `https://github.com/<owner>/<repo>[/tree/HEAD/<folder>]`). The list is kept for 10 minutes; if reading it again fails, the copy already read is shown and the page says how old it is. If it cannot be read at all, Browse says so, and you can still install by typing `owner/repo` in Install plugin….
- **Update available** marks a plugin whose repository has moved on: the hub compares the commit Herdr installed (`resolved_commit` in `herdr plugin list --json`) with the commit the marketplace list names for that repository's default branch (`headCommit`), for the manifest with the same id or folder. Only a plugin installed from GitHub without a **Ref** is compared (or with the default branch's name as its Ref, once the list names that branch; today it does not), since `herdr plugin update` keeps a plugin on the ref it was installed at. A pinned branch, tag or commit, a linked plugin, a plugin the list does not have, or a list that cannot be read (or is only an old copy, or takes more than 5 seconds the first time) shows no badge and never fails the plugin list. `GET /api/plugins` answers this as `updateAvailable: true | false | null` on each plugin. The list can lag GitHub by as long as Herdr takes to read it again, and in a repository with several plugins any new commit counts for each of them.
- HerdRabbit's own row comes first, marked **this app**, with no switch or menu. It shows the version that machine runs and, when a newer release is out, **Update** beside its name, `current → new · restarts HerdRabbit when done`, why the update would stop (if it would) and **Update**; **What changed** (folded) and the run, step by step, show under it ([Update from the app](#update-from-the-app)). It shows on every machine that answers the update check, also where Herdr does not list HerdRabbit as a plugin (an `update.sh` install). Its **Update** asks the same question as before and sends `POST /api/plugins/herdrabbit/update`, which the server runs as HerdRabbit's own update -- the same run `/api/update/run` starts, with the same sign-in, write token, origin check and one start a minute per PC -- never `herdr plugin update`. The server still refuses to disable, unlink, uninstall or reinstall HerdRabbit, or run its actions and panes (any repository named HerdRabbit counts).
- A plugin marked **Update** has its own **Update** button beside its switch (the same request as ⋯ → **Update**); ⋯ → **Update** stays for any plugin Herdr can update, marked or not (a plugin on a pinned branch shows no badge).
- **Update all (N)**, beside Installed and Browse, is there while something on the chosen machine has an update: the marked plugins and HerdRabbit. It asks once, listing what it will update, then runs each plugin's update one after another, waiting for each to end, and HerdRabbit's last, since it restarts HerdRabbit there. The first failure stops it, and the line under the list says which update failed and what was left. Herdr's own update is not part of it (it is on the Herdr page). The page does the sequencing: each step is an existing request, so the rules below about one change at a time still hold, and closing Settings does not stop it, but closing or reloading the page does (the change already running still finishes on its machine). **Check for updates** asks every PC about HerdRabbit and Herdr again and reads the chosen machine's plugins again.
- The settings list shows a count beside **Plugins** (PCs with a newer HerdRabbit, plus plugins marked behind on the machines Plugins has read) and beside **Herdr** (PCs with a newer Herdr).
- One plugin change runs at a time on a machine, and none while HerdRabbit or Herdr is updating there; the page says when HerdRabbit or Herdr is updating (started in Plugins, the Update window, or from another device) and keeps its controls waiting. An install or update clones and builds, which can take minutes; the page shows it running and follows it until it ends.
- On a connected PC the commands run on that PC, which checks the request again, and only while that PC has a sign-in password too: one without says to set it there. A PC on an older HerdRabbit says to update it there.
- ⋯ → **Actions and panes…** lists a plugin's actions, each with **Run**, and its panes, each with **Open** (from `herdr plugin list --json`). **Workspace** above them picks where they go: the workspace of the pane you have open when it is on that machine, else the machine's first; any other workspace of that machine with a pane can be chosen. An action runs for the pane you have open when it is in that workspace, else for the workspace's active pane (the focused pane of its active tab): HerdRabbit asks Herdr's socket (`plugin.action.invoke`) with that pane's workspace, tab, folder and agent as the action's context, so `HERDR_PLUGIN_CONTEXT_JSON` names it. Herdr adds the workspace's own folder and its source (`invocation_source: "api"`). A pane opens as a new tab of the chosen workspace. With no workspace of that machine to choose, the action runs where Herdr's focus is (`herdr plugin action invoke <action> --plugin <id>`). Herdr starts it and answers at once; **Logs…** shows how it went.
- **Open** opens the pane as a new tab of the chosen workspace (`plugin.pane.open` with `placement: "tab"` and no focus), then shows it, Settings closed. Herdr's own placements do not fit a page: an overlay covers whatever Herdr itself has in focus, wherever that is (it ignores the workspace asked for), and a popup is not a pane at all, so neither could be shown here. A tab is a normal Herdr pane: it shows in the sidebar, Herdr's own screen stays where it was, and the tab closes when the pane's command exits. Open needs a workspace of that machine with a pane.
- ⋯ → **Logs…** shows a plugin's last 20 command logs (`herdr plugin log list --plugin <id> --limit 20`), newest first: the action or hook, how it ended and when, and the last lines it printed, with colours removed and every folder shown as its last part.
- **Link local folder…** links a plugin folder on that machine (`herdr plugin link <folder> [--disabled]`), typed or picked from the folder tree as in New workspace. The folder must be one the Files tab would open (not a sign-in key or HerdRabbit settings folder) and hold its own `herdr-plugin.toml` (a regular file of at most 256 KB, not a link) whose `id` is neither HerdRabbit's nor a plugin already there. Herdr does not build a linked plugin, but it runs its startup hooks; the dialog says so. Herdr is given the folder's real path, the one checked. The change is named by the plugin's id, never its folder. A linked plugin's ⋯ has **Unlink…** (`herdr plugin unlink <id>`, after a confirm; the folder stays) in place of Uninstall….
- HerdRabbit's own actions (start, stop, restart, status) and panes (connect, password) are neither listed nor run from here: stopping HerdRabbit from its own page would cut the page off. Its logs can be read through the API, but its row has no menu.

Source, ref and plugin id are checked on both machines: GitHub's owner and repository name rules, a git ref name without spaces, `..` or a leading `-`, and short plugin ids. Action and pane ids follow Herdr's rule (letters, digits, `:`, `_`, `-`, no dots) and may not start with `-`. A pane named on another machine is refused. Herdr is run with an argument list, never through a shell.

### Herdr settings

**Settings → Herdr** changes Herdr's own settings on each machine (pick it in **Machine** when there is more than one). Like Plugins it is shown only when sign-in (a password) is on, and the server refuses every request otherwise; on a connected PC the commands run there, and only while that PC has a sign-in password too. A PC on an older HerdRabbit says to update it there. Its first row is Herdr itself.

- **Herdr:** the version that machine runs and, when a newer one is out on its channel, **Update** beside the name and `current → new · Stable` (or `Preview`), why it cannot be updated from here if it cannot, and **What's new in Herdr x** (folded). **Update…** opens the Update window ([Update from the app](#update-from-the-app)), which asks first and follows the run. While Herdr updates, the row says so.
- **Update channel:** **Stable** or **Preview**, read with `herdr channel show` and set with `herdr channel set <stable|preview>`. Herdr keeps the channel in `config.toml` (`[update] channel`), and Herdr's update check follows that channel.
- **Agent integrations:** each integration `herdr integration status` lists, with its state (**Installed** and its version, **Not installed**, **Outdated**, **Needs repair**; experimental ones are marked). **Install…** / **Uninstall…** (and **Update…** / **Repair…**, which install again) ask first, then run `herdr integration install|uninstall <name>`. Herdr 0.9.5 asks nothing while it does: it writes the hook into the agent's own config folder, or refuses when that folder is not there (the agent is not installed on that machine), and the page shows Herdr's reason. Only a name Herdr lists on that machine is run. The hook files Herdr names are not shown.
- **config.toml:** the machine's Herdr config as text, at the path `herdr --help` names (`HERDR_CONFIG_PATH` if set, else `~/.config/herdr/config.toml`), up to 512 KB. **Check** runs `herdr config check` on the text and shows Herdr's diagnostics. **Save…** asks first; Herdr checks the text in a private temporary file (`HERDR_CONFIG_PATH` pointed at it) and a config it rejects is never written. One it accepts replaces the file: the old file is copied beside it as `config.toml.bak-<YYYYMMDD-HHMMSS>` (Herdr's own backup name; `-2`, `-3`… for more saves in the same second), the new one is written next to it and renamed over it with the old file's mode, checked once more in place (the backup is put back if that fails), then `herdr server reload-config` runs. If no Herdr server is running, the page says so; the config applies when Herdr starts. A save names the version it edited, so a file changed meanwhile (another editor, a channel change) is not overwritten: **Revert** reads it again. A `config.toml` that is a symbolic link stays one: the file it points at is written. **Herdr's defaults** shows `herdr --default-config`, to read.
- One change at a time on a machine, and none while HerdRabbit or Herdr is updating there. Herdr is run with an argument list, never through a shell. After each save the newest 10 `config.toml.bak-…` files are kept and older ones removed; a folder or link of that name and other files are left alone. A half-written file a crash left (`.config.toml.herdrabbit-…`, over ten minutes old) is removed too.

### Output and history

Terminal output and history come only from Herdr's own screen and scrollback. Claude's JSONL transcript, Codex's rollout and OpenCode's database are never merged into the terminal; only the Chat lens reads them, as its own view (and a Claude plan or question card takes its words from them). In an attached terminal the wheel or a finger drag scrolls Herdr's own history; a mirrored pane shows its current screen only. History Herdr no longer holds cannot be shown. Claude must run in the plain terminal mode the installer configures for its scrollback to be readable.

During install and update, the current user's global Claude settings (`~/.claude/settings.json`, or the path in `CLAUDE_CONFIG_DIR`) get `tui: "default"` and `env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1"`, so ordinary terminal scrolling is used instead of Claude's own. Existing settings are backed up beside the file as `settings.json.herdrabbit-*.bak` and other keys are preserved. A running Claude picks this up after a restart. Each machine that runs HerdRabbit applies it during its own install or update. The settings survive Claude's own updates. To apply it by hand: `node scripts/configure-claude.mjs`.

Live terminal input (including composer submissions and extra keys) and output use `/api/terminal` WebSocket. An attached pane streams Herdr's own output. For a mirrored pane, after the initial snapshot only changes are sent; Herdr reports no general screen change outside a terminal attach, so the server observes output: 50 ms after each read during activity, 500 ms when quiet, shared by viewers of the same pane and line range. Background pages disconnect and receive a fresh snapshot on return. Agent status uses Herdr `pane.agent_status_changed` events over WebSocket, including unselected tabs. Workspace and tab lists still refresh over HTTP every two seconds and resynchronize after the status subscription starts. HTTP list refreshes also cover subscription failures while retrying. Authentication and workspace and tab management remain HTTP. Push notifications are unchanged.

### Settings

The ⚙ button at the foot of the sidebar opens the settings screen. On a desktop it is a dialog with the page list on the left; on a phone (760px wide or less) it fills the screen with the list, a page opens when tapped, and the back arrow (`‹`, labelled **Back to settings**) returns to the list. Everything on it is kept in this browser unless it says otherwise.

- **Appearance:** the theme (**Dark** / **Light**) and **Reset text size**, for a grid whose text size was changed by hand.
- **Chat:** **Open panes in** (**Auto** / **Chat** / **Terminal**, see [Chat](#chat)) and **Chat width** (**Narrow** / **Default** / **Wide** / **Full**): how wide the conversation column grows on a wide window, 680px, 860px, 1120px or the whole stage. A phone keeps its own width.
- **Terminal & keys:** **Edit keys** (with **Enter in the message box** on a touch device) and **Fit panes to this window** (wide screens).
- **Notifications:** the **Off** / **On** choice and its state.
- **Security** (shown when a password is set): **Passkeys** and **Signed-in devices**.
- **PCs** (shown where Connect PC is available): the connected PCs, each opening its Details, and **Connect PC**. With sign-in on, **Let other PCs connect** above them says whether this PC's Connect PC port is open and to whom; **Choose PCs…** changes it ([Connect PC](#other-pcs-running-herdrabbit-connect-pc)).
- **Plugins** (shown when a password is set): Herdr's plugins on each machine, with HerdRabbit's own row and its **Update** first and **Update all** (plugins, then HerdRabbit last), see [Plugins](#plugins). A count beside it says how many updates are waiting.
- **Herdr** (shown when a password is set): Herdr itself (its version, the newer one, **Update…** opening the Update window), its update channel, agent integrations and `config.toml` on each machine, see [Herdr settings](#herdr-settings). A count beside it says how many PCs have a newer Herdr.
- **About:** this machine's HerdRabbit and Herdr versions. With sign-in off (no Plugins or Herdr page) it also carries this PC's HerdRabbit update (its line, **What changed**, **Update** and the run) and **Update…** for the Update window.

There is no separate Updates page: each update is where the thing it updates lives.

### Display settings

Switch between light and dark mode in ⚙ Settings → Appearance. Adjust terminal and composer text size with `Ctrl`/`Cmd` + wheel or trackpad zoom. On mobile, pinch over the terminal with two fingers. The selected size is saved in `localStorage`.

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
| `HERDR_WEB_AI_ACCOUNTS_DIR` | `~/.config/herdr-bridge/ai-accounts` | Saved AI CLI sign-ins (Claude Code, Codex, Antigravity CLI, Kiro CLI) |
| `HERDR_WEB_PLUGIN_CONFIG_DIR`, `HERDR_WEB_PLUGIN_STATE_DIR` | set by the plugin runner | Herdr's plugin config and state folders (from `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR`), which the plugin runner sets for the server; the in-app direct restart needs them. Not meant to be set by hand. |
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

To run HerdRabbit as a systemd service instead of the [plugin](#install-as-a-herdr-plugin), the simplest setup is:

```bash
npm run install-service
```

New installations try `38787`, then search `30000–39999` while excluding local listeners and existing Tailscale HTTPS ports. Reinstalling an existing user service preserves its assigned port.

For a manual service installation, review and adapt [`systemd/herdrabbit.service`](../systemd/herdrabbit.service), then run:

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

Run as the Linux account that installed the service. The updater uses its own directory, or `HERD_RABBIT_INSTALL_DIR`. It requires a clean `main` branch and the official origin. Updates follow releases: the updater lists origin's tags, takes the latest release (the highest `vX.Y.Z` tag; after each merge to `main` passes CI, CI commits the next patch version as `release: x.y.z` and tags it, unless the merged commit's message has `[skip release]` on a line of its own) and stops with "Already up to date" when that is not newer than the `package.json` version here, so commits on `main` past a release, and a checkout ahead of the latest release, are left alone. Otherwise it fetches that tag alone, updates the service's Herdr with `herdr update --handoff` (running panes stay alive), then fast-forwards `main` to the release commit, installs dependencies, verifies, and restarts the matching user service. Herdr is checked against the minimum the incoming code requires before any file changes: a failed Herdr update continues when the installed Herdr is new enough, and stops the update with nothing changed otherwise. A lock prevents concurrent updates. Local changes, or local commits that are not in the release, stop the process before anything changes. When dependency installation, verification, or the restart fails after `main` moved, the updater resets to the previous commit, reinstalls its dependencies, and restarts that version if it had already restarted. Herdr itself is not rolled back. Configuring Claude's terminal scrollback runs after verification and is not rolled back either: if it fails, the update stops before restarting, and the next restart runs the verified new code. Ports, authentication, Tailscale settings, and connected PCs are preserved. If an older installation lacks `update.sh`, run `git pull --ff-only` once first. An installation older than 1.2.10 runs its own earlier `update.sh`, which does not update Herdr: run `herdr update --handoff` outside Herdr before that first update. HerdRabbit warns at startup and in the machine's Details while Herdr is older than 0.9.0.

Installed as a Herdr plugin, use HerdRabbit's row in **⚙ Settings → Plugins** instead of `update.sh`, or `herdr plugin install jwgung/HerdRabbit --ref v<x.y.z> --yes` from a terminal ([Install as a Herdr plugin](#install-as-a-herdr-plugin)).

The Service Worker reloads the page once when it activates a new app shell. Manually refresh a tab that has remained open for a long time.

### Update from the app

The page checks for a new version each time it opens, and again when you press **Check for updates** in **⚙ Settings → Plugins** or **Check** in the Update window (never on a timer). Updates follow releases, not commits: the server lists origin's tags (`git ls-remote --tags`) from the service's own checkout, takes the highest `vX.Y.Z` tag as the latest release (the one GitHub marks Latest; other tags such as `v2.0.0-rc.1` are ignored), and compares its version with the `package.json` version that runs. Only a newer release is an update: commits on `main` past the latest release are not, and a checkout ahead of it (a dev build, or `main` past the release) is never offered a downgrade. For a newer release it fetches that tag alone and reads the notes from it. A newer release puts a dot on the ⚙ button and a count beside Plugins; HerdRabbit's row in Settings → Plugins shows the running and latest versions, the commit subjects from the running checkout to the release (folded under **What changed**), and, when `update.sh` would stop, why: not running as the systemd user service, an origin other than ultivis-iot/HerdRabbit or jwgung/HerdRabbit (the address moves to the second; a checkout keeps the one it was cloned from, which GitHub redirects), not on `main`, local changes, a local `main` with commits that are not in the release, or an update already running. **Update** asks first, then runs the same `update.sh` with `systemd-run --user` in a unit of its own, outside the service, so the restart it ends with does not stop it. The page follows the run as a list of steps -- Fetch the latest release, Update Herdr, Install dependencies, Verify the updated code, Restart HerdRabbit, Reload this page, read from the lines `update.sh` logs -- each marked done (✓), in progress (a spinner, with the time since the run started and "Step n of N") or not started (an empty circle). While the service restarts, the restart step says "Waiting for HerdRabbit to come back…"; once the new version answers, the reload is the step left and the page reloads into it. A failed run marks the step it failed in with ✕ and says so (`update.sh` rolls back by itself). Running as a Herdr plugin, the page checks Herdr's checkout the same way (its branch and local changes do not matter), and **Update** runs `herdr plugin install <owner>/<repo> --ref v<x.y.z> --yes` for that release and then `herdr plugin action invoke herdrabbit.restart` in a process detached from the server. `herdr plugin update` cannot do this: it fetches the default branch, or stays on the ref the plugin was installed at. The owner and repository are where Herdr says it installed the plugin from (`herdr plugin list --json`), and only ultivis-iot/HerdRabbit or jwgung/HerdRabbit on GitHub is installed from; any other source fails the run with nothing installed. The install replaces the plugin in place (same id, settings and state folders) and pins it to the tag, so `herdr plugin update` from a terminal leaves it on that release; its steps are Download and build the new version, Restart HerdRabbit and Reload this page. Herdr only queues the restart action, so the run then watches Herdr's log of that action (`herdr plugin log list`, for up to 30 seconds) until it has ended. If the action failed, or `herdr plugin action invoke` itself exited non-zero -- for example Herdr could not start `node` because the `PATH` it was started with points at a Node that is gone ("No such file or directory (os error 2)") -- the run restarts HerdRabbit itself (if the outcome cannot be told -- the action is still running when the 30 seconds end, Herdr's log cannot be read, or `herdr plugin action invoke` timed out and its log does not say the action failed -- the run neither fails nor restarts a second time: the window shows a quiet "Could not confirm the restart" note with the reason, and the page's own wait decides): `scripts/plugin.mjs restart` from the new checkout (as `herdr plugin list --json` names it), with the Node HerdRabbit runs on and the plugin folders Herdr gave the startup hook. If that is not possible or fails too, the run ends as failed: the window says the new version is installed but HerdRabbit could not restart, shows Herdr's error, and asks you to run `herdr plugin action invoke herdrabbit.restart` or reopen Herdr from a shell where `node` is on `PATH`. Herdr builds in a new checkout, and a failed plugin update leaves the installed version running; there is no verification step or automatic rollback in this case, and the window never says `update.sh` put anything back. The log is folded away under **Log** while the run goes and after it succeeded, and open when it failed. A finished run is shown until you have seen it once: after the window is closed it does not appear again (remembered per PC in this browser, falling back to the last 30 minutes when browser storage is unavailable). The log and outcome are kept in `~/.local/share/herdrabbit/update/`. Plugins shows the chosen machine's check and starts its update from **Update** (and last in **Update all**); with sign-in off, when there is no Plugins page, **About** shows this PC's HerdRabbit line, **What changed**, **Update** and the run instead. Every place follows the one run. The Update window lists every PC connected with Connect PC too, each with its own versions, changes and reason, and **Update** there runs that PC's own `update.sh`; this page sends only which PC. A PC on a version from before this says "Update it there (older version)". Starting an update needs a signed-in session on this page; one run per PC a minute.

The Update window (**Update…** in Herdr's row in Settings → Herdr, or under **Herdr update** in About with sign-in off) is Herdr's: one block per PC. At the same moments the page checks HerdRabbit, the server asks the Herdr it runs (`HERDR_BIN`, or `herdr` on its `PATH`) for `--version` and `channel show`, and reads `https://herdr.dev/latest.json` (stable) or `https://herdr.dev/preview.json` (preview) for the newest version and its notes; those two addresses are fixed. A newer Herdr alone puts the dot on ⚙ too. The row shows the running and latest versions, the release notes folded away, and **Update Herdr**, which asks first, then runs `herdr update --handoff` with `systemd-run --user` in a unit of its own, given only `PATH`, `HOME` and the XDG folders that place Herdr's config and sockets (`XDG_CONFIG_HOME` and the like, when absolute) -- none of the service's `HERDR_*` settings. Running panes are handed over to the new Herdr live, so agents keep running; HerdRabbit does not restart. The page follows the log, with a spinner and the time the run has taken, and checks again so the new version shows. It cannot run on a PC that is not Linux, has no `systemd-run`, or installed Herdr with Homebrew, Nix or mise (update it with that package manager); if Herdr itself refuses, its own message is shown. The log and outcome are kept beside HerdRabbit's (`herdr-update.log`, `herdr-update-state.json`). Only one update, HerdRabbit's or Herdr's, runs on a PC at a time; Herdr's also starts at most once a minute. A HerdRabbit update still updates Herdr first, as before. A connected PC from before this shows no Herdr row. Herdr's run is shown the same way (result, folded log, gone once seen); when its output says installed Herdr integrations need updating, a short note asks you to run the `herdr integration install` commands from the log in a terminal; HerdRabbit never runs them.

## Verification and development

```bash
npm run verify
npm run check:browser   # Playwright checks against a fake Herdr (needs `npx playwright install chromium`)
npm run check:agent-commands   # after a Claude Code update: is the kept `/` list behind its commands reference? (needs the network)
npm run dev
```

`npm run check` finds every script under `src`, `public` and `scripts` and checks its syntax, along with `install.sh`, `update.sh` and `migrate-to-plugin.sh`, so a new file needs no registration there. It also checks every stylesheet under `public` (except the tokens, the UI catalog's own layout and vendored xterm styles) against the design rules (`scripts/check-design.mjs`, rules in [`docs/design.md`](design.md)): colors, font sizes, spacing, radii, layers, shadows and transition times come from the tokens. GitHub Actions runs `npm run verify` on every pull request and on pushes to `main`.

The page's script is `public/app.js`, which boots the app and wires together the modules under `public/app/`. New page code goes in a module there: name it in lowercase letters, digits and hyphens (`public/app/<name>.js`, which the server serves as `/app/<name>.js` on its own), import it with the release's `?v=` like the other files, and add it to `APP_SHELL` in `public/sw.js`. `npm run verify` fails when a module is missing from that list or would not be served.

Tests use a fake Herdr executable and temporary state. They do not write to real terminal panes or create and close real workspaces or tabs.

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
- Browsing is read-only and reaches every path the service account can read on this machine **except sign-in keys and HerdRabbit's own settings**, which it never lists into, opens, previews or downloads: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.password-store`, `~/.local/share/keyrings`, `~/.config/gh`, `~/.config/gcloud`, `~/.config/rclone`, `~/.netrc`, `~/.git-credentials`, `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials(.toml)`, the AI CLIs' sign-ins (`~/.claude/.credentials.json`, `~/.claude.json` and its backups, `~/.codex/auth.json`, `~/.gemini/antigravity-cli/antigravity-oauth-token`, `~/.local/share/kiro-cli/data.sqlite3`, `~/.config/claude*`, and wherever `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `XDG_DATA_HOME` put them), and HerdRabbit's data (`~/.config/herdr-bridge/`, plus the password, push, servers and saved-sign-in paths when the environment moves them). Paths are compared after resolving symbolic links, so a link to a key is refused like the key. A listing shows such an entry as locked, by name and kind only. The same list applies to a connected PC's files (on that PC), and the service refuses to start with an uploads folder inside it. Beyond that list the OS file permissions are the boundary, which still includes things like `/proc/self/environ`. This is not an escalation, because an authenticated client can already run arbitrary commands as that account through a terminal pane — the list keeps sign-ins from leaving the machine through the file browser, not from a terminal. It is a further reason not to run HerdRabbit as root or as a shared account.
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
- Saved AI CLI sign-ins are copies of the CLI's own credential files, mode `0600` inside mode-`0700` directories, and they are only ever copied between that directory and the CLI's. No API response, error, log line or browser storage carries a token: the account routes answer with an email, a plan and a sign-in expiry, and usage with how much of each limit is used, when it resets and credits left. This machine never receives a connected PC's sign-ins. Anyone who can use this HerdRabbit can switch its accounts, which is no more than a terminal pane already allows.
- A sign-in workspace only ever receives a command naming its empty directory. Its one-time sign-in code is not kept in prompt history, and the workspace is closed when the sign-in is finished or cancelled.
- Browser storage contains UI preferences and the current-window launch token, not terminal history or the password.

## License

[MIT](../LICENSE)

Third-party code and its notices: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
