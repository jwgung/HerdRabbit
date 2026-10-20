#!/bin/sh
# Moves this PC from the systemd service to the Herdr plugin. See
# scripts/migrate-to-plugin.mjs; run it with Herdr running, either from a
# checkout or straight from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/ultivis-iot/HerdRabbit/main/migrate-to-plugin.sh | sh
# Piped like that there is no checkout beside it, so the current code is
# fetched into a temporary folder first: an installation too old to have this
# script moves over without updating it first.
set -eu

REPOSITORY_URL="https://github.com/ultivis-iot/HerdRabbit.git"

log() { printf '  > %s\n' "$1"; }
fail() { printf '  x %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "requires '$1'"; }

# Parsed whole before it runs: the old checkout (this file's folder, when run
# from one) is removed at the end, and a piped script is still being read.
main() {
    need node
    [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] || fail "requires Node.js 22 or newer"
    if [ -f "$0" ] && [ -f "$(dirname -- "$0")/scripts/migrate-to-plugin.mjs" ]; then
        DIRECTORY="$(cd "$(dirname -- "$0")" && pwd -P)"
    else
        need git
        need npm
        TEMPORARY="$(mktemp -d)"
        trap 'rm -rf "$TEMPORARY"' EXIT
        log "Fetching HerdRabbit into $TEMPORARY"
        git clone --quiet --depth 1 "$REPOSITORY_URL" "$TEMPORARY/HerdRabbit"
        npm --prefix "$TEMPORARY/HerdRabbit" ci --omit=dev --silent
        DIRECTORY="$TEMPORARY/HerdRabbit"
    fi
    cd "$HOME"
    # Piped from curl, standard input is this script: the questions are asked
    # on the terminal instead.
    if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
        node "$DIRECTORY/scripts/migrate-to-plugin.mjs" "$@" </dev/tty
    else
        node "$DIRECTORY/scripts/migrate-to-plugin.mjs" "$@"
    fi
}

main "$@"
