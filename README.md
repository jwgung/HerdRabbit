# HerdRabbit

English | [한국어](README.ko.md)

HerdRabbit puts your [Herdr](https://herdr.dev/) sessions in a browser on your phone, tablet or another PC. You can watch and type into panes, read agents (Claude Code, Codex, OpenCode, Kiro CLI, Antigravity CLI) as a chat, answer their questions, and get notified when one needs you or finishes. It installs as a PWA.

> [!IMPORTANT]
> It is a personal tool: one person reaching their own Herdr sessions. Reach it over Tailscale, never from the public internet.

Everything not covered here is in the full guide: [docs/guide.md](docs/guide.md).

## Install

You need Linux or macOS, Node.js 22+, Git, and [Tailscale](https://tailscale.com/) on this PC and on the device you will open the page from. Herdr is installed or updated by the installer if needed.

```bash
curl -fsSL https://raw.githubusercontent.com/jwgung/HerdRabbit/main/install.sh | sh
```

It installs HerdRabbit as a Herdr plugin and asks for an optional password. With Tailscale running, it also sets up a tailnet-only HTTPS address and prints it. HerdRabbit starts with Herdr from then on.

Already have Herdr? This does the same, without the port, password and Tailscale steps:

```bash
herdr plugin install jwgung/HerdRabbit
```

A PC on the older systemd service is moved to the plugin by the installer above ([details](docs/guide.md#moving-an-existing-install-to-the-plugin)).

## Open it

1. Open the HTTPS address the installer printed (like `https://my-pc.your-tailnet.ts.net:38787`) on a device signed in to the same tailnet. To see it again: `herdr plugin pane open --plugin herdrabbit --entrypoint connect`. This also draws a QR code when `qrencode` is installed.
2. Install it as an app: **Add to Home Screen** in Safari on iPhone/iPad, **Install app** in Chrome or Edge.
3. Sign in, then add a Passkey when the page offers one.

To set or change the password: `herdr plugin pane open --plugin herdrabbit --entrypoint password`.

## Connect another PC

With HerdRabbit on several PCs, one PC's page can show the others' sessions too. If PC **A** should show PC **B**:

**On B**, once: on B's page open **⚙ Settings → PCs → Let other PCs connect → Choose PCs…**, keep **All my PCs**, enter B's password and **Save**. HerdRabbit restarts on B to open its Connect PC port to every device signed in to Tailscale as you, so a PC you add later needs nothing on B. **Only these** lets in just the devices you tick instead. This needs a password set on B; without one, or from a terminal, see [the guide](docs/guide.md#other-pcs-running-herdrabbit-connect-pc).

**On A**, open the `⋯` menu of this PC's row in the sidebar, choose **Connect PC…**, pick B (marked **Ready**), **Test connection**, then **Save**.

It is one-way: B shows up on A's page, and B keeps its own page. More in the guide: [Connect PC](docs/guide.md#other-pcs-running-herdrabbit-connect-pc).

## Update

With a password set, **⚙ Settings → Plugins** updates HerdRabbit (its own row, or **Update all** with the plugins, HerdRabbit last) and **⚙ Settings → Herdr** updates Herdr, on every PC; without one, **⚙ Settings → About** updates this PC's HerdRabbit and opens Herdr's Update window. It checks each time the page opens, or when you press **Check for updates**.

## Settings

HerdRabbit's settings live in the plugin's `.env` file: `herdr plugin config-dir herdrabbit` prints its folder. Restart after a change with `herdr plugin action invoke herdrabbit.restart`. Every setting is listed in [Configuration](docs/guide.md#configuration).

## When something is wrong

- **The page does not open:** check `tailscale serve status` and `herdr plugin action invoke herdrabbit.status`. See [Troubleshooting](docs/guide.md#troubleshooting).
- **Forgot the password:** set a new one with the password pane above.
- **B is not in Connect PC's list, only counted under "other PCs with nothing to connect to":** B's Connect PC port is not open. Do the B step above. If B is listed as not allowing this PC, choose All my PCs there, or tick A.

## More

- [Full guide](docs/guide.md): every feature, settings, security, troubleshooting
- [What Herdr does from the page](docs/herdr-coverage.md)
- [Design rules](docs/design.md) and the [shared UI kit](public/ui/README.md)
- Development: `npm run verify`, and `npm run check:browser` for the browser checks

## License

[MIT](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
