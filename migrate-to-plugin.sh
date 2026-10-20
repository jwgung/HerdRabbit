#!/bin/sh
# Moves this PC from the systemd service to the Herdr plugin. See
# scripts/migrate-to-plugin.mjs; run it with Herdr running.
set -eu

fail() { printf '  x %s\n' "$1" >&2; exit 1; }

# Parse the entire function before the old checkout (this file's folder) is removed.
main() {
    command -v node >/dev/null 2>&1 || fail "requires 'node'"
    [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] || fail "requires Node.js 22 or newer"
    DIRECTORY="$(cd "$(dirname -- "$0")" && pwd -P)"
    cd "$HOME"
    node "$DIRECTORY/scripts/migrate-to-plugin.mjs" "$@"
}

main "$@"
