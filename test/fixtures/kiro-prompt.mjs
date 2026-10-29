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
