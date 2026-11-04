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
| `create` | Partly | **New workspace…** on a machine's ⋯ menu, with a shell or an agent. Missing: choosing its folder (`--cwd`); it opens where Herdr's `new_cwd` setting says |
| `rename` | Done | |
| `close` | Done | After confirmation |
| `focus` | Not needed | The page selects a pane itself |
| `report-metadata` | Not needed | For agent integrations |

## Tab (`herdr tab`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list`, `get` | Shown | |
| `create` | Partly | **New tab…** on a workspace's ⋯ menu, with a shell, an agent, or an agent's earlier conversation. A resumed conversation opens in the workspace's folder; a new tab does not choose its folder (`--cwd`) |
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
| creating, opening and removing Git worktrees | Missing | A workspace per branch, from a workspace's ⋯ menu |

## Plugins (`herdr plugin`)

| Command | HerdRabbit | Notes |
|---|---|---|
| `list` | Shown | Settings → Plugins, per machine |
| `install` | Done | From a GitHub `owner/repo`, after confirmation; sign-in must be on |
| marketplace ([herdr.dev/plugins](https://herdr.dev/plugins/)) | Shown | Settings → Plugins → Browse: search, Herdr's sort orders, Installed badge, Install… into the same confirm step |
| `enable`, `disable`, `update`, `uninstall` | Done | Not for HerdRabbit itself, whose row runs About's update instead |
| update check | Shown | "Update available" when the marketplace's head commit differs from the installed one, only for plugins installed from GitHub without a Ref (the list is read every 10 minutes); Update all runs them one at a time, HerdRabbit last, and stops at the first failure |
| `link`, `unlink` | Missing | Local plugin folders |
| `action`, `pane` | Missing | Running a plugin's actions or opening its panes from the page |
| `log`, `config-dir` | Missing | |

## Other commands

| Command | HerdRabbit | Notes |
|---|---|---|
| `herdr update` | Done | Settings → About, for Herdr on every machine |
| `herdr channel` | Partly | Read to pick the update for Herdr's channel. Missing: choosing stable or preview |
| `herdr config`, `herdr server reload-config` | Missing | Editing Herdr's `config.toml` (keys, theme, `new_cwd`) |
| `herdr notification` | Not needed | HerdRabbit sends its own Web Push notifications |
| `herdr agent`, `herdr integration` | Missing | Installing Herdr's built-in agent integrations |
| `herdr machine` | Not needed | Replaced by Connect PC |
| `herdr api` | Used | The page's lists come from `herdr api snapshot` and Herdr's socket API |
| `herdr status`, `herdr server stop` | Missing | Herdr's own status and stopping its server |

## Missing, in a suggested order

1. Choosing the folder of a new workspace and a new tab (`--cwd`).
2. Resizing panes by dragging a split's divider, and naming a pane.
3. Git worktrees: a workspace per branch.
4. Sessions: start another, stop one, delete a stopped one.
5. Plugins: run a plugin's actions and open its panes from the page.
6. Herdr's update channel and `config.toml` settings such as `new_cwd`.
7. Herdr's agent integrations.
8. Sending one input to several panes (`pane input`).
9. Local plugin folders (`plugin link`), plugin logs.
