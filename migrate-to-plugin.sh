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
    # Run as a file ("sh path/to/it"), its own checkout; piped, $0 is the
    # shell's name, never a path, so a folder that happens to be current is not taken.
    DIRECTORY=""
    case "$0" in
        */*|migrate-to-plugin.sh) [ -f "$(dirname -- "$0")/scripts/migrate-to-plugin.mjs" ] && DIRECTORY="$(cd "$(dirname -- "$0")" && pwd -P)" ;;
    esac
    if [ -z "$DIRECTORY" ]; then
        need git
        need npm
        TEMPORARY="$(mktemp -d)"
        trap 'rm -rf "$TEMPORARY"' EXIT
        trap 'exit 130' INT TERM HUP
        log "Fetching HerdRabbit into $TEMPORARY"
        git clone --quiet --depth 1 "$REPOSITORY_URL" "$TEMPORARY/HerdRabbit"
        npm --prefix "$TEMPORARY/HerdRabbit" ci --omit=dev
        DIRECTORY="$TEMPORARY/HerdRabbit"
    fi
    cd "$HOME"
    # Piped from curl, standard input is this script: node asks its questions
    # on the terminal instead. Only node's input moves -- the shell goes on
    # reading the rest of the script from the pipe.
    if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
        node "$DIRECTORY/scripts/migrate-to-plugin.mjs" "$@" </dev/tty
    else
        node "$DIRECTORY/scripts/migrate-to-plugin.mjs" "$@"
    fi
}

main "$@"
