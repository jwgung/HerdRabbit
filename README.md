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
- Show this machine's panes as Herdr itself draws them (a real `herdr terminal attach` in xterm.js), so full-screen TUIs, the cursor and colors match; other servers' panes show their ANSI screen text, loading 200 older lines of Herdr scrollback when scrolling to the top
- Send text and shell commands, or use a two-row extra-key bar with Ctrl/Alt/Shift, Esc, Tab, Home/End, PgUp/PgDn, arrows, slash, minus, and Enter. Select modifiers, then tap a key or type it on your keyboard (for example Ctrl → End or Ctrl → C). Modifiers clear after one send or when switching panes. Ordinary composer shortcuts remain local unless a screen modifier is selected.
- Create shell workspaces and tabs, rename workspaces and sessions, and close tabs or workspaces after confirmation
- View images, video, audio, Markdown and text in the browser instead of downloading them first
- Manage every machine from its row in the sidebar, this one included: read its Tailscale name and version, and for a connected machine rename it, find it again after it moved port, or disconnect it
- Switch the Claude Code or Codex account a machine uses without signing in again, from the same row
- Move files between the browsing device and the Herdr machine through a shared uploads folder: upload from the composer's attach button, paste the stored path into the composer, and download or delete stored files
- Remember the selected pane and collapsed workspaces in the browser
- Switch sidebar entries with `Ctrl+Tab`, `Ctrl+Shift+Tab`, or `Ctrl+1`–`Ctrl+9` when the browser forwards those shortcuts to the app
- Restore terminal font size and the last 100 sent prompts per pane across app launches; use Up/Down in the composer to recall prompts
- Show Herdr-native state symbols such as `×`, `◐`, `✓`, `○`, and `·`
- Emphasize unviewed completed sessions and their collapsed projects in the sidebar
- Send status-only PWA notifications with the project and tab names when an agent needs input or finishes; while the app is in front, show them inside it instead
- Install as a responsive PWA with light and dark themes
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

Live terminal input (including composer submissions and extra keys) and output use `/api/terminal` WebSocket. After the initial snapshot, only changes are sent. Herdr reports no general screen change outside a terminal attach, so the server observes output: 50 ms after each read during activity, 500 ms when quiet, shared by viewers of the same pane and line range. Background pages disconnect and receive a fresh snapshot on return. Session status uses Herdr `pane.agent_status_changed` events over WebSocket, including unselected sessions. Project/session lists still refresh over HTTP every two seconds and resynchronize after the status subscription starts. HTTP list refreshes also cover subscription failures while retrying. Older history, authentication, and project/session management remain HTTP. Push notifications are unchanged.

## Additional machines

Local Herdr remains the default. Use **+ → Connect Server** at the top of the sidebar to add another machine. All registered servers appear together as **server → Herdr session → project → tab/pane**; selecting a pane sends input and reads output on that machine.

Every server is another HerdRabbit. The dialog lists the machines on your tailnet and says what each one is: ready to add, already added, running HerdRabbit but not accepting this machine, or on a different version. Pick a ready one and its name and address fill in. Machines with nothing to act on -- no HerdRabbit, or offline -- fold away behind a count, so a large tailnet stays readable while a machine you expected to see is still findable with the reason it cannot be added. A machine is picked, never typed: the address comes from the tailnet, and the only thing left to choose is what to call it here.

A scan of the default port cannot find a machine that runs more than one HerdRabbit -- one per account, say, sharing a tailnet address and differing only by port. Those announce themselves instead: a leaf is installed knowing which hub it answers to, so it tells that hub where it is, and the hub lists it alongside the machines it found by probing. An announcement only puts a row in the list; adding the server is still a choice, and choosing still probes the address. A machine may announce itself and nothing else.

What a machine said is kept -- on disk, in `~/.config/herdr-bridge/announced.json` -- rather than expiring. It does not stop being true because the hub restarted or the leaf went quiet, and a machine that is genuinely gone falls out of the dialog on its own, since every candidate is probed before it is offered. The list is capped; when it is full, the machine that has gone longest without saying anything makes room. An address that a look proves is not there -- the machine answers, but nothing is on that port -- is dropped, so a machine that moved to a different port does not leave its old entry behind for good. A machine that is merely switched off is left alone; it announces itself again when it comes back.

A server already added keeps pointing at the address it was added with, so a machine that moved to another port goes offline and stays there. The tailnet address says the two are the same machine, so a server that cannot connect carries a **Find new address** action in the sidebar: it looks again, and if that machine answers on another port it repoints the entry and keeps the name it was given.

Machines with nothing to connect to are counted, not listed. A machine running HerdRabbit that refuses this hub is still listed with the reason, because it points at another hub and will never announce itself here -- only a probe can say so.

To prepare a machine, install HerdRabbit on it in **leaf mode**, naming this machine as its hub — the dialog shows this machine's tailnet address so you have it to hand. Nothing is stored on this side but the name and the address: a leaf recognises its hub by the address the requests arrive from, so there is no key or password to keep anywhere. **Save** stays disabled until **Test connection** succeeds for the address currently in the form; changing it closes Save again.

A leaf needs no HTTPS and no `tailscale serve`. It listens on its own tailnet address, and the tailnet is what proves who is calling. HTTPS matters only for a hub, which a browser opens: service workers and passkeys require a secure context.

Hub and leaf are the same code and the same install; only the service unit differs. Re-run the installer to change which one a machine is — the prompt defaults to what it already is, so a rerun that just accepts the defaults changes nothing. Converting a hub to a leaf deletes that machine's password and registered passkeys, since a leaf has no login, and removes its Tailscale Serve registration. Converting back asks for a password again and republishes it.

Both machines must run the same HerdRabbit version. A mismatch shows that server as offline and names both versions rather than merging a snapshot whose shape may differ. `update.sh` moves a machine to the latest `main`, so update hub and leaves together.

Remote snapshots refresh independently, with slower retries after a failure, so an unreachable machine does not hold up local data. Last-known remote panes stay visible during an outage and their server is marked offline. Terminal output for a remote pane is polled through the same watcher local panes use, and agent status arrives on a server-sent event stream from the leaf.

A linked machine is a full participant: its sessions appear in the project/session picker, and projects and tabs can be created, renamed and closed there. The machine that owns a session is the one that validates the change, so its rules cannot drift from what a person sitting at it would get.

A server is managed where it is seen, and every machine has a row -- this one too, even when it is the only one. Its `⋯` menu opens **Details** -- the name Tailscale knows the machine by, the HerdRabbit version answering there, its Herdr version (marked when it is older than 0.9.0; this machine also logs that at startup), and how many Herdr sessions and panes it contributes -- and **AI accounts**. When a password is set, this machine's menu also opens **Passkeys** (see Password and Passkey authentication). A connected machine's menu also renames and disconnects it. Details are the first thing worth reading when a machine will not connect. This machine goes by its host name when Tailscale does not name it, and a connected machine Tailscale does not name shows no name. The dialog that adds machines is for adding them.

Servers are stored on this machine in `~/.config/herdr-bridge/servers.json` with mode `0600`; override with `HERDR_WEB_SERVERS_FILE`. They are shared by every device using this HerdRabbit instance.

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

This machine's `⋯` menu opens **Signed-in devices**: each browser signed in, named by browser and system, with when it signed in and was last used. The list keeps the 64 most recent; signing in past that ends the oldest. **Sign out** ends one, and its open terminals close at once; **Sign out everywhere** ends all of them, this one included. Neither asks for the password, since they only take access away. The menu's **Sign out** ends this browser's own session. The list keeps a hash of each session, never the token, in the auth file. Sign-ins made before the list existed stay valid until they expire and are not listed; **Sign out everywhere** ends them too.

Wrong passwords are counted per caller: the Tailscale login or forwarded address Tailscale Serve reports, or the connecting address. Guesses from one device lock only that device, up to fifteen minutes; a loose limit across all callers still applies.

After the first successful password login, HerdRabbit offers to register a Passkey when the browser supports WebAuthn. Within five minutes of that sign-in the window can register one passkey without typing the password again; after that, registering asks for it. Later login screens show **Sign in with a passkey** beside the password fallback. Depending on the device, the browser can use Face ID, a fingerprint, Windows Hello, the device PIN, a security key, or cross-device QR authentication. The biometric and private key stay on the authenticator; HerdRabbit stores only the credential ID, public key, signature counter, transport metadata, and the name and dates shown in the list below. Passkeys are bound to the exact hostname used during registration, so use the stable Tailscale HTTPS address rather than alternating between addresses.

**Passkeys** in this machine's row menu lists the registered passkeys by name, with the day each was added and last used, and whether it syncs between devices. The name comes from the browser that registered it, such as `Safari · iOS`; passkeys registered before this list existed show as `Passkey` with no dates. Removing one or adding another asks for the password again, so a stolen browser session cannot plant a passkey that outlives it. Removing a passkey signs every other device out -- the usual reason to remove one is a lost device, which may still be signed in -- while the browser that removed it stays signed in; open terminals elsewhere close within 15 seconds. Removing the last one leaves the password. The list and removal work without WebAuthn, so a lost device's passkey can be removed from any browser. The list shows names and dates only; credential IDs and public keys stay in the auth file. To clear every passkey at once, run `npm run password`.

## Usage

### Selecting and restoring a session

Select an agent or pane in the sidebar to show its output. The last selected pane is stored in `localStorage` and restored on reload when it still exists. Browser storage is isolated by origin, so an HTTP LAN URL and a Tailscale HTTPS URL have separate preferences.

Opening a completed `✓` session marks that completion as viewed and changes it to idle `○` in the current browser. A later completion has a new state sequence and displays `✓` again.

### Agent status notifications

Use the bell at the bottom of the sidebar to enable or disable notifications for the current browser or installed PWA. Permission is requested only after pressing this control.

- Titles use `project name · tab name`, led by the server name when more than one server is connected.
- Only completion and input required are sent, as short status-only messages. An agent going idle or an unknown state sends nothing.
- While a HerdRabbit window is in front, no system notification appears: the pane it shows stays quiet, and another pane's alert drops in at the top of the app with a short sound. Tap it to open that pane. The machine's `⋯` menu turns the sound off or on.
- With notifications on, the same menu sends a test notification to every subscribed device.
- Each state event is sent once, and a newer alert replaces the previous alert for the same session. Opening it launches or focuses the installed PWA and restores the targeted session.

Background delivery uses standards-based Web Push; a Firebase project and FCM SDK are not required. On iPhone and iPad, install HerdRabbit on the Home Screen and allow notifications on iOS/iPadOS 16.4 or newer.

VAPID keys and per-device Push subscriptions are stored with mode `0600` in:

```text
~/.config/herdr-bridge/push.json
```

Project and tab names may appear on the lock screen. Previous commands and request text are not included. Enable notifications only on personal devices.

### Projects and sessions

- Use the top `+` action to create a named workspace with a default shell.
- Use a project's `⋯` menu to rename it, add a shell session, or close the project.
- Use a session's `⋯` menu to rename it or close that Herdr tab.
- Collapse or expand a project's child sessions with the arrow beside its name.
- Servers and Herdr sessions collapse the same way, so a sidebar listing several machines can be narrowed to the one in use. The choice is remembered per browser.
- Destructive close actions always require confirmation.

A session shows the agent running in it until it is given a name. That is not a name: it changes when the agent does, and two sessions running the same agent read alike. Renaming one puts the name where the agent was, and moves the agent beside the status; a session with several panes keeps its name above the group instead of repeating it on each. Emptying the field takes the name back off and the session shows its agent again. Herdr has no unnamed tab -- `tab rename` insists on a label -- so clearing writes back the number the tab was born with, which the sidebar hides. Project renaming goes to Herdr's `workspace rename`, session renaming to `tab rename`, so both are the same operation a person at that machine would run.

The status word (`idle`, `working`) is not spelled out beside a session. The marker already carries it, and a done or blocked session says so again in its border and glow. Hover a session, or read it with a screen reader, to get the status in words.

Run commands such as `cd`, `codex`, or `claude` inside a created shell. Creation uses Herdr's `--no-focus` option so it does not steal focus from the desktop Herdr client.

### Terminal

A pane on this machine is attached: the server runs one `herdr terminal attach` per pane on a pseudo-terminal (node-pty) and every open browser shares it. Typing goes straight to it, the terminal follows the size of the browser that opened the pane or typed into it last (others show that size as it is), and the wheel or a finger drag scrolls Herdr's own history, gliding on after a flick. A browser that opens the pane later gets the recent screen. When another client already holds the pane's attach slot (another web bridge), the pane says so and **Open here** takes it over; otherwise it tries again every few seconds and attaches once that client lets go. If node-pty cannot load, or a pane cannot attach (another server's pane, for now), the pane falls back to the screen-text view described below.

While the pane shows a password prompt (`[sudo] password for …:`, `Password:`, a passphrase or PIN), a message sent from the composer is not kept in its input history or in notification requests.

### Input

Click or tap the terminal output for direct input, indicated by `Direct input`. Text, Tab, arrows, Enter, and Ctrl combinations go to the current pane immediately, including shell and agent completion menus. IME composition updates are sent immediately as edits to the changed suffix. Selecting terminal text preserves native copy; clicking the composer returns to the draft-and-submit behavior below. Composer history does not intercept direct input.

Direct writes are ordered. A failed write stops pending input without automatic retries; check the terminal before clicking it to resume. This applies to the screen-text view, which uses server-observed ANSI snapshots rather than a terminal emulator, so cursor and full-screen TUI fidelity are not guaranteed there.

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

Browsing is read-only: nothing in the tree can be changed, and uploading and deleting live in the Uploads dialog instead. Files copied into the folder from a terminal appear in that dialog too. The uploads folder is `~/.local/share/herdrabbit/files` unless `HERDR_WEB_FILES_DIR` names another directory; it is deliberately separate from the configuration directory that holds credentials. One upload may be at most 50MB, one download at most 1GB, and the folder itself has no size or file-count limit, so it grows until the disk is full and nothing is removed on your behalf.

With more than one machine registered, the Files tab gains a picker: choose one and the tree shows that machine, starting at its home. Each machine remembers its own last folder.

That choice is also where uploads go. Until one is made, a file you attach or paste follows the session you are looking at, and the path is inserted into the composer. Pick a machine and it is pinned for both browsing and uploading, across reloads. When the pinned machine is not the one the selected session runs on, the path is **not** inserted -- it would name a file that session cannot open -- and the upload says where it went instead. The attach button and the uploads dialog name the machine either way.

A linked machine answers for its own files using the same browser it would use for a person opening it directly. This hub never reads another machine's disk; it asks. The confinement is therefore identical on every machine: browsing is read-only, and writes reach only that machine's own uploads folder.

On iOS, a browser in standalone PWA mode may open a downloaded file instead of saving it. Use the share sheet to store it.

A file an agent names in its output is a link to itself. "wrote `src/api.mjs`", "see `./docs/plan.md`" -- the path opens in the viewer, resolved against the pane's own directory when it is relative. Only paths naming something this app can show become links, which is what keeps `/usr/bin` and `node_modules/` plain; `~` is left alone, because that home belongs to the machine the pane runs on. In the live terminal, these paths and web addresses are underlined all the time, so they can be seen and tapped on a phone, and an address the output wrapped onto the next line is still one link.

A file can be opened instead of downloaded. Images, video and audio play in place, Markdown and HTML are drawn, and text, code, logs and config are shown as characters. Reading a log on a phone should not mean saving it first.

What may be shown, and as what, is decided from the name against an allow-list, never by sniffing the bytes. Nothing gets to run, but the two formats that could are handled by how they are shown rather than by refusing them: an SVG goes in an `<img>`, which executes no script, and an HTML file is framed by a response whose own policy ends in `sandbox` -- an opaque origin with no script, for anyone who opens that URL and not only for the frame, which is also what lets a saved report keep its own stylesheet. Both were measured against a file that tried to call home and neither reached anything. Markdown goes the same way: the server renders it with `marked` and sends the result, so it lands in the same frame with the same policy and the browser downloads nothing extra. Which hrefs may become links, and what happens to markup embedded in the document, are decided here rather than by the parser: http(s) or it stays text, and embedded markup is shown as the characters it is made of. Any of them can be read as its own source instead, one press away. A PDF opens in a tab rather than in the dialog. Framing one is the part browsers disagree about -- Android Chrome draws nothing in a frame, iOS Safari draws the first page -- while a tab is not framing at all, works everywhere, and gives a page-shaped document the full height it was written for. It also means a PDF needs no exception to the framing rules and gets none: only HTML is reopened, and an image response still says `frame-ancestors 'none'`. Text works the same way -- opaque bytes in, characters out, no content type negotiated. Downloads are unchanged: still `application/octet-stream` as an attachment, which is what keeps a stored page from ever running at this origin.

Video seeks: a view link answers byte ranges, and does so across a link to another machine as well, because the machine holding the file is the one that slices it.

### AI accounts

A subscription CLI stops at its session or weekly limit, and moving to another account normally means signing in again. **AI accounts** in a server's row menu keeps each account's sign-in on that machine so switching is one press. Claude Code and Codex are supported.

For each CLI the dialog is a list of email addresses from A to Z, with the one in use marked in its place. Opening it saves the account signed in now, so there is nothing to save by hand. A line appears under an account only when it needs a new sign-in within a week or already does; Claude Code sign-ins last about a month, and Codex does not record when its own will end. Nothing else about an account is shown.

- **Add account**, at the end of each list, opens an `AI login: …` project and types the sign-in command there: `claude auth login`, or `codex login --device-auth`, pointed at an empty directory of its own. Signing in where the live account lives would revoke that account, which is why it happens apart. Codex's device code sign-in has to be turned on in ChatGPT's security settings first. Signing in is noticed on its own: the page checks every few seconds whether the CLI has written its sign-in into that directory, saves the account the moment it has, and closes the project. AI accounts then opens again with the new account marked **Just added**, unless another dialog is open. A reload does not lose the wait: the machine keeps which sign-ins are still open, and the page picks them up again when it starts or when AI accounts is opened. It stops checking after 20 minutes, and **Cancel sign-in** in AI accounts ends it sooner. What you type into that project is not kept in prompt history.
- **Switch**, in an account's ⋯ menu, changes the account for the whole machine. Settings, MCP servers, conversation history and memory stay as they are, so `claude --continue` or `codex resume` picks up where the other account stopped. The account being replaced is saved first, which keeps the tokens the CLI rotated while using it. If Herdr shows the CLI running in any pane, the switch lists those panes and waits for confirmation; they keep the old account until restarted. A CLI started outside Herdr is not seen.
- **Remove**, in the same menu, deletes the saved copy. It does not sign the account out anywhere.

Each machine keeps its own accounts. A hub asks a linked machine to save, sign in or switch, and hears back whose account is where; no sign-in travels between machines.

Saved sign-ins are stored in `~/.config/herdr-bridge/ai-accounts`, or the directory in `HERDR_WEB_AI_ACCOUNTS_DIR`, as mode-`0600` files inside mode-`0700` directories that only the owning OS user can read.

The CLI's own files are what gets switched: `~/.claude/.credentials.json` plus the `oauthAccount` field of `~/.claude.json`, and `~/.codex/auth.json`, or the directories in `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the HerdRabbit service sees them. Codex set to store sign-ins in the keyring cannot be switched and says so, and `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment still overrides whatever account is saved. Claude on macOS keeps sign-ins in the Keychain and is not supported.

### Output and history

Output and history come only from Herdr's ANSI screen and scrollback. Claude's JSONL logs are never read or merged into the screen. Scrolling to the top asks for 200 more lines at a time, up to 100,000. History Herdr no longer holds cannot be shown. Claude must run in the plain terminal mode the installer configures for its scrollback to be readable.

During install and update, the current user's global Claude settings (`~/.claude/settings.json`, or the path in `CLAUDE_CONFIG_DIR`) get `tui: "default"` and `env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1"`, so ordinary terminal scrolling is used instead of Claude's own. Existing settings are backed up beside the file as `settings.json.herdrabbit-*.bak` and other keys are preserved. A running Claude picks this up after a restart. Every machine applies it during its own install or update, since each one runs its own HerdRabbit. The settings survive Claude's own updates. To apply it by hand: `node scripts/configure-claude.mjs`.

Live terminal input (including composer submissions and extra keys) and output use `/api/terminal` WebSocket. After the initial snapshot, only changes are sent. Herdr reports no general screen change outside a terminal attach, so the server observes output: 50 ms after each read during activity, 500 ms when quiet, shared by viewers of the same pane and line range. Background pages disconnect and receive a fresh snapshot on return. Session status uses Herdr `pane.agent_status_changed` events over WebSocket, including unselected sessions. Project/session lists still refresh over HTTP every two seconds and resynchronize after the status subscription starts. HTTP list refreshes also cover subscription failures while retrying. Older history, authentication, and project/session management remain HTTP. Push notifications are unchanged.

### Display settings

Use the control at the bottom of the sidebar to switch between light and dark mode. Adjust terminal and composer text size with `Ctrl`/`Cmd` + wheel or trackpad zoom. On mobile, pinch over terminal output with two fingers. The selected size is saved in `localStorage`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HERDR_WEB_HOST` | `127.0.0.1` | Any literal address to listen on: `127.0.0.1`, `0.0.0.0`, or one interface such as this host's Tailscale address. A single address is the tightest option -- the service is then absent from every other network the machine is on, and that address is accepted as a request host automatically. Names are refused, since they resolve at listen time. |
| `HERDR_WEB_PORT` | `38787` | Listening port from 1024 through 65535 |
| `HERDR_WEB_ALLOWED_HOSTS` | empty | Additional reverse-proxy or Tailscale hostnames, comma-separated |
| `HERDR_WEB_ROLE` | `hub` | `hub` serves people; `leaf` serves only its hub and answers nothing else. A leaf listens either on this machine's tailnet address, where the caller is read off the socket, or on loopback behind `tailscale serve`, where Tailscale stamps the caller's identity on. It may not bind every interface, and it must have no password -- the process refuses to start otherwise. |
| `HERDR_WEB_PEER_LOGINS` | empty | Tailnet logins a leaf accepts, comma-separated. Read from `Tailscale-User-Login`, which Tailscale Serve stamps on and strips from public traffic. Setting this without `HERDR_WEB_ROLE=leaf` is refused, because it would otherwise leave the API open to the whole tailnet while everything still appeared to work. |
| `HERDR_WEB_PEER_ADDRESSES` | empty | Tailnet addresses a leaf accepts, comma-separated. Required when a leaf listens on its tailnet address, since that is the only thing it has to go on. Behind Serve it is still worth setting: a login proves the account, not the device, so without it a leaf answers every device that account owns. |
| `HERDR_WEB_HUB` | empty | The hub a leaf announces itself to, as a full URL such as `https://hub.tailnet.ts.net:38787`. A name rather than an address, because a hub sits behind Tailscale Serve and its certificate is for the tailnet name. Unset means the leaf waits to be found, which only works on the default port. |
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

Run as the Linux account that installed the service. The updater uses its own directory, or `HERD_RABBIT_INSTALL_DIR`. It requires a clean `main` branch and the official origin, fetches `main`, updates the service's Herdr with `herdr update --handoff` (running panes stay alive), then fast-forwards `main`, installs dependencies, verifies, and restarts the matching user service. Herdr is checked against the minimum the incoming code requires before any file changes: a failed Herdr update continues when the installed Herdr is new enough, and stops the update with nothing changed otherwise. A lock prevents concurrent updates. Local changes or divergent commits stop the process before anything changes. When dependency installation, verification, or the restart fails after `main` moved, the updater resets to the previous commit, reinstalls its dependencies, and restarts that version if it had already restarted. Herdr itself is not rolled back. Configuring Claude's terminal scrollback runs after verification and is not rolled back either: if it fails, the update stops before restarting, and the next restart runs the verified new code. Ports, authentication, Tailscale settings, and saved servers are preserved. If an older installation lacks `update.sh`, run `git pull --ff-only` once first. An installation older than 1.2.10 runs its own earlier `update.sh`, which does not update Herdr: run `herdr update --handoff` outside Herdr before that first update. HerdRabbit warns at startup and in the machine's Details while Herdr is older than 0.9.0.

The Service Worker reloads the page once when it activates a new app shell. Manually refresh a tab that has remained open for a long time.

## Verification and development

```bash
npm run verify
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

The machine icon on this machine's row in the sidebar turns red when this page cannot reach HerdRabbit, and hovering it shows why. A connected machine's icon says only whether HerdRabbit reaches that machine.

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
- HerdRabbit login passwords are stored only as `scrypt` hashes in a mode-`0600` file. Servers hold no credential at all: a leaf recognises its hub by the address its requests arrive from, so there is nothing to store.
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
- A **leaf** is protected by the tailnet, not by a password. Listening on its own tailnet address is the stronger of the two shapes: the caller's address is set by the kernel from a WireGuard-authenticated peer, so a process on the leaf cannot claim to be the hub. Behind `tailscale serve` the proof is a header instead, which only holds while Serve is the one thing that can reach the socket -- and there **any local process on the leaf, as any user, can forge that header and reach the whole API.** Prefer the direct shape unless something else needs Serve on that port.
- A leaf's identity check authenticates an **account**, not a device, so `HERDR_WEB_PEER_ADDRESSES` is what stops every device that account owns from reaching it directly.
- No machine holds another's credentials. Each one runs its own HerdRabbit and its own Herdr, so compromising one does not hand over the others.
- Reading a file this way leaves no trace in any pane's history, works with no Herdr session running at all, and streams at link speed. Terminal-borne copying does none of those things.
- Regular files only. Directories, devices, and FIFOs are refused after the file is opened non-blocking, so a named pipe cannot stall the server. Files are served as `attachment` with `application/octet-stream`, and a single download is capped at 1GB.
- Downloads are fetched through a single-use ticket that expires in 30 seconds, so no file path appears in a URL. Directory paths and the server they belong to do appear in the browse request URL and will be recorded by any reverse proxy in front of HerdRabbit.
- Stored files are mode `0600` inside a mode-`0700` directory, and are always served as `attachment` with `application/octet-stream` so an uploaded HTML or SVG file cannot render in the browser.
- One upload is capped at 50MB and is refused from its declared `Content-Length` before any of the body is read. The uploads folder has no total size or file-count limit, so disk space is the only bound.
- Accepting a whole file in one request raises the body-receive timeout to two minutes for every route. The header timeout is unchanged, so slow-header attacks are still cut off, but a slow body is not.
- VAPID private keys and Push subscription URLs are stored in a mode-`0600` file readable only by the owning OS user.
- Saved AI CLI sign-ins are copies of the CLI's own credential files, mode `0600` inside mode-`0700` directories, and they are only ever copied between that directory and the CLI's. No API response, link request, error, log line or browser storage carries a token: the account routes answer with an email, a plan and a sign-in expiry. A hub never receives a linked machine's sign-ins. Anyone who can use this HerdRabbit can switch its accounts, which is no more than a terminal pane already allows.
- A sign-in project only ever receives a command naming its empty directory. Its one-time sign-in code is not kept in prompt history, and the project is closed when the sign-in is finished or cancelled.
- Browser storage contains UI preferences and the current-window launch token, not terminal history or the password.

## License

[MIT](LICENSE)

Third-party code and its notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
