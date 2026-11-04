# What HerdRabbit does with Herdr's commands

[한국어](herdr-coverage.ko.md)

Checked against Herdr 0.9.5 (`herdr --help` and each command group's `--help`). HerdRabbit uses Herdr's names throughout: a **Session** holds **Workspaces**, a workspace holds **Tabs**, a tab holds **Panes**.

**Shown** means the page shows it, **Done** means you can do it from the page, **Partly** means part of it is there, **Used** means HerdRabbit runs it for its own work without a control of its own, and **Missing** means there is no way to do it from HerdRabbit yet. Herdr commands that only Herdr's own terminal interface or an agent integration needs are marked **Not needed**.

## Session (`herdr session`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list` | Shown | Every machine's sessions in the sidebar, with whether each runs |
| `attach` | Not needed | The page attaches to panes, not to a whole session |
| `stop` | Missing | Stop a running session from its ⋯ menu |
| `delete` | Missing | Delete a stopped session |
| a new named session (`herdr --session <name>`) | Missing | Start another session on a machine |

## Workspace (`herdr workspace`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list`, `get` | Shown | Workspaces in the sidebar |
| `create` | Done | **New workspace…** on a machine's ⋯ menu, with a shell or an agent, in a folder typed or chosen with Browse… (`--cwd`); left at `~`, where Herdr's `new_cwd` setting says |
| `rename` | Done | |
| `close` | Done | After confirmation |
| `focus` | Not needed | The page selects a pane itself |
| `report-metadata` | Not needed | For agent integrations |

## Tab (`herdr tab`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list`, `get` | Shown | |
| `create` | Done | **New tab…** on a workspace's ⋯ menu, with a shell, an agent, or an agent's earlier conversation, in the workspace's folder or another typed or chosen with Browse… (`--cwd`). A resumed conversation opens in the workspace's folder |
| `rename` | Done | |
| `close` | Done | After confirmation |
| `focus` | Not needed | |

## Pane (`herdr pane`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list`, `get`, `layout` | Shown | Panes, their folder, the agent in them and the tab's layout |
| `process-info` | Used | Read to find which Codex conversation a pane runs; not shown |
| `read` | Done | Mirrored panes and Find in terminal |
| `send-text`, `send-keys`, `run` | Done | Composer, key bar, starting agents |
| `split` | Done | Split right or down, in the pane's folder |
| `close` | Done | |
| `zoom` | Done | |
| `resize` | Partly | **Even out layout** only. Missing: dragging a split's divider |
| `swap`, `move` | Done | Dragging rows and panes, Move out to its own tab |
| `rename` | Missing | Naming a pane (tabs and workspaces can be renamed) |
| `focus`, `neighbor`, `edges` | Not needed | The page moves between panes itself |
| `input` | Missing | Sending one input to several panes at once |
| `wait-output` | Not needed | For scripts |
| `report-agent`, `report-agent-session`, `release-agent`, `report-metadata` | Not needed | For agent integrations |

## Terminal (`herdr terminal`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `attach` | Done | Each attached pane is a real `herdr terminal attach` |
| `session`, `title` | Not needed | |

## Worktree (`herdr worktree`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list` | Done | Open worktree… lists a repository's checkouts; the branch of each worktree workspace is shown beside its name |
| `create` | Done | New worktree… on a repository's workspace: branch, optional base and name, never `--path`; opens without taking Herdr's focus |
| `open` | Done | Open worktree… opens a listed checkout by its folder (`--path`) |
| `remove` | Done | Remove worktree… on a worktree workspace, after confirmation; `--force` only after a second confirmation when Git refuses a checkout with changes |
| `--cwd`, `--trust-repository` | Missing | Starting from a folder rather than a workspace, and repositories owned by another user |

## Plugins (`herdr plugin`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list` | Shown | Settings → Plugins, per machine |
| `install` | Done | From a GitHub `owner/repo`, after confirmation; sign-in must be on |
| marketplace ([herdr.dev/plugins](https://herdr.dev/plugins/)) | Shown | Settings → Plugins → Browse: search, Herdr's sort orders, Installed badge, Install… into the same confirm step |
| `enable`, `disable`, `update`, `uninstall` | Done | Not for HerdRabbit itself, which Settings → Updates updates instead; plugins with a new version are updated there too (Update all) |
| update check | Shown | "Update available" when the marketplace's head commit differs from the installed one, only for plugins installed from GitHub without a Ref (the list is read every 10 minutes); Update all runs them one at a time, HerdRabbit last, and stops at the first failure |
| `link`, `unlink` | Missing | Local plugin folders |
| `action`, `pane` | Missing | Running a plugin's actions or opening its panes from the page |
| `log`, `config-dir` | Missing | |

## Other commands

| Command | HerdRabbit | Notes |
|---|---|---|
| `herdr update` | Done | Settings → Updates, for Herdr on every machine |
| `herdr channel` | Done | Settings → Herdr: Stable or Preview, per machine; Updates follows it |
| `herdr config`, `herdr server reload-config` | Done | Settings → Herdr: `config.toml` as text, checked by `herdr config check` before it is saved, then reloaded. `config reset-keys` is not offered |
| `herdr notification` | Not needed | HerdRabbit sends its own Web Push notifications |
| `herdr integration` | Done | Settings → Herdr: status, install and uninstall, per machine |
| `herdr agent` | Missing | |
| `herdr machine` | Not needed | Replaced by Connect PC |
| `herdr api` | Used | The page's lists come from `herdr api snapshot` and Herdr's socket API |
| `herdr status`, `herdr server stop` | Missing | Herdr's own status and stopping its server |

## Missing, in a suggested order

1. Resizing panes by dragging a split's divider, and naming a pane.
2. Sessions: start another, stop one, delete a stopped one.
3. Plugins: run a plugin's actions and open its panes from the page.
4. Sending one input to several panes (`pane input`).
5. Local plugin folders (`plugin link`), plugin logs.
