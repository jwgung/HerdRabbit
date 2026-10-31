// Kiro CLI screens, as herdr's detection snapshot reads them (text), captured
// from Kiro CLI on 2026-10-29: a tool approval and the workspace trust menu.
// `cursor` puts the ❯ on that row, as the arrow keys move it.

const RULE = "─".repeat(117);

function rows(labels, cursor) {
  return labels.map((label, index) => `${index === cursor ? " ❯ " : "   "}${label}`);
}

export const KIRO_APPROVAL_ROWS = [
  "Allow once",
  "Deny once",
  "Create allow rule to approve future similar actions",
  "Create deny rule to block future similar actions",
];

export function kiroApprovalScreen({ cursor = 0, title = "Print probe", tool = "shell", target = "echo probe" } = {}) {
  return [
    "  Run exactly this shell command and nothing else: echo probe",
    `↓ Shell ${target}`,
    "    ╰ description=Print probe, run_in_background=false",
    RULE,
    ` ${title} requires approval`,
    ` ${tool} → ${target}`,
    ...rows(KIRO_APPROVAL_ROWS, cursor),
    RULE,
    " esc to close · ↑↓ to navigate · ↵ to select · Tab to edit",
    "",
  ].join("\n");
}

export const KIRO_TRUST_ROWS = ["Trust, continue", "Don't trust, exit"];

export function kiroTrustScreen({ cursor = 0, folder = "/tmp/kiro-probe" } = {}) {
  return [
    `  ⢸⣿⣿⣿⡀⣸⣿⡀⣸⣿⡇   Upgrade your V2 agent configurations to V3 with /upgrade-agent`,
    ` ${RULE}`,
    " Trust this workspace?",
    ` ${RULE}`,
    ` ${folder}`,
    " This folder can contain hooks, agents, MCP servers and workflows that run commands on your machine. Only trust",
    " folders you know.",
    " Trusting lets Kiro use this workspace's configuration. Kiro will be able to read, edit, and execute files here.",
    ...rows(KIRO_TRUST_ROWS, cursor),
    ` ${RULE}`,
    " esc to exit · ↑↓ to navigate · ↵ to select",
    " Revoke later by removing workspaceTrusted from /home/me/.kiro/workspace-roots/60c6fd7b7d3372a4/permissions.yaml",
    "",
  ].join("\n");
}

// Recorded from Kiro CLI 2.35.1 on 2026-10-30 in a tmux window of that many
// columns (`tmux capture-pane -p`), a file write waiting for approval:
// - on a rule row the hint is "Enter to see more options", not "to navigate";
// - at 58 columns and fewer a long row and the hint go on to a second line.
export const KIRO_APPROVAL_44_CURSOR0 = "↓ Write /tmp/kiro-probe/note.txt\n  added 1 line in note.txt\n     1+  hello\n\n────────────────────────────────────────────\n Write File requires approval\n fs_write → note.txt\n\n ❯ Allow once\n   Deny once\n   Create allow rule to approve future\n   similar actions\n   Create deny rule to block future\n   similar actions\n────────────────────────────────────────────\n esc to close · ↑↓ to navigate · ↵ to\n                select · Tab to edit\n";
export const KIRO_APPROVAL_44_CURSOR2 = "↓ Write /tmp/kiro-probe/note.txt\n  added 1 line in note.txt\n     1+  hello\n\n────────────────────────────────────────────\n Write File requires approval\n fs_write → note.txt\n\n   Allow once\n   Deny once\n ❯ Create allow rule to approve future\n   similar actions\n   Create deny rule to block future\n   similar actions\n────────────────────────────────────────────\n esc to close · Enter to see more options\n";
export const KIRO_APPROVAL_58_CURSOR0 = "↓ Write /tmp/kiro-probe/note2.txt\n  added 1 line in note2.txt\n     1+  hello\n\n──────────────────────────────────────────────────────────\n Write File requires approval\n fs_write → note2.txt\n\n ❯ Allow once\n   Deny once\n   Create allow rule to approve future similar\n   actions\n   Create deny rule to block future similar actions\n──────────────────────────────────────────────────────────\n esc to close · ↑↓ to navigate · ↵ to select · Tab to\n                edit\n";
export const KIRO_APPROVAL_60_CURSOR2 = "↓ Write /tmp/kiro-probe/note.txt\n  added 1 line in note.txt\n     1+  hello\n\n────────────────────────────────────────────────────────────\n Write File requires approval\n fs_write → note.txt\n\n   Allow once\n   Deny once\n ❯ Create allow rule to approve future similar actions\n   Create deny rule to block future similar actions\n────────────────────────────────────────────────────────────\n esc to close · Enter to see more options\n";
export const KIRO_TRUST_60 = "      Prefer the previous experience? Launch with kiro-cli\n      --v2\n\n ──────────────────────────────────────────────────────────\n Trust this workspace?\n ──────────────────────────────────────────────────────────\n /tmp/kiro-probe\n\n This folder can contain hooks, agents, MCP servers and\n workflows that run commands on your machine. Only trust\n folders you know.\n\n Trusting lets Kiro use this workspace's configuration.\n Kiro will be able to read, edit, and execute files here.\n\n ❯ Trust, continue\n   Don't trust, exit\n ──────────────────────────────────────────────────────────\n esc to exit · ↑↓ to navigate · ↵ to select\n\n Revoke later by removing workspaceTrusted from\n /home/someuser/.kiro/workspace-roots/60c6fd7b7d3372a4/perm\n issions.yaml\n";

// Recorded from Kiro CLI 2.35.1 on 2026-10-31: the menu Enter opens on a rule row,
// where the rule's scope is chosen. Its rows have a second column (what the rule
// matches, its scope), its hint keeps 'esc to go back' in a column of its own, and a
// tool with one rule has one row.
export const KIRO_RULE_WRITE_100 = "────────────────────────────────────────────────────────────────────────────────────────────────────\n Create allow rule: sub.txt\n fs_write → sub.txt\n\n Scope:  [session]   workspace    user\n\n ❯ Trust \"sub.txt\"                   exact match · session\n   Trust entire tool (Write File)    session\n────────────────────────────────────────────────────────────────────────────────────────────────────\n esc to go back · ↑↓ to navigate · ↵ to select · s to cycle scope · Tab to edit\n";
export const KIRO_RULE_WRITE_55 = "───────────────────────────────────────────────────────\n Create allow rule: sub.txt\n fs_write → sub.txt\n\n Scope:  [session]   workspace    user\n\n ❯ Trust \"sub.txt\"                   exact match · ...\n   Trust entire tool (Write File)    session\n───────────────────────────────────────────────────────\n esc to go bac ·↑↓ to navigate · ↵ to select · s to\n                cycle scope · Tab to edit\n";
export const KIRO_RULE_WRITE_44 = "────────────────────────────────────────────\n Create allow rule: sub.txt\n fs_write → sub.txt\n\n Scope:  [session]   workspace    user\n\n ❯ Trust \"sub.txt\"                exact ...\n   Trust entire tool (Write       session\n   File)\n────────────────────────────────────────────\n esc to go   ·↑↓ to navigate · ↵ to select\n back         · s to cycle scope · Tab to\n              edit\n";
export const KIRO_RULE_WEB_56 = "────────────────────────────────────────────────────────\n Create allow rule: web_search\n web_search\n\n Scope:  [session]   workspace    user\n\n ❯ Trust entire tool (web_search)    session\n────────────────────────────────────────────────────────\n esc to go bac ·↑↓ to navigate · ↵ to select · s to\n                cycle scope · Tab to edit\n";
export const KIRO_RULE_WEB_44 = "────────────────────────────────────────────\n Create allow rule: web_search\n web_search\n\n Scope:  [session]   workspace    user\n\n ❯ Trust entire tool                session\n   (web_search)\n────────────────────────────────────────────\n esc to go   ·↑↓ to navigate · ↵ to select\n back         · s to cycle scope · Tab to\n              edit\n";
export const KIRO_DENY_RULE_WEB_55 = "───────────────────────────────────────────────────────\n Create deny rule: web_search\n web_search\n\n Scope:  [session]   workspace    user\n\n ❯ Deny entire tool (web_search)    session\n───────────────────────────────────────────────────────\n esc to go    · ↑↓ to navigate · ↵ to select · s to\n back           cycle scope · Tab to edit\n";
