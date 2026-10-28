#!/bin/sh
# Installs HerdRabbit as a Herdr plugin:
#   curl -fsSL https://raw.githubusercontent.com/jwgung/HerdRabbit/main/install.sh | sh
# The current code is fetched into a temporary folder and runs
# scripts/install-plugin.mjs from there: it installs or updates Herdr, installs
# the plugin, and asks for a password. A PC that has the older systemd service
# is moved over to the plugin instead. The folder is removed afterwards; the
# plugin itself lives in Herdr's own checkout.
set -eu

REPOSITORY_URL="https://github.com/jwgung/HerdRabbit.git"

log() { printf '  > %s\n' "$1"; }
fail() { printf '  x %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "requires '$1'"; }

# Parsed whole before it runs: piped from curl, the shell is still reading it.
main() {
    [ "$#" -eq 0 ] || fail "Usage: curl -fsSL <install.sh URL> | sh"
    need git
    need node
    need npm
    [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] || fail "requires Node.js 22 or newer (found $(node --version))"
    case "$(uname -s)" in
        Linux|Darwin) ;;
        *) fail "HerdRabbit runs on Linux and macOS" ;;
    esac
    (: </dev/tty) 2>/dev/null || fail "an interactive terminal is required for setup"

    TEMPORARY="$(mktemp -d)"
    trap 'rm -rf "$TEMPORARY"' EXIT
    trap 'exit 130' INT TERM HUP
    log "Fetching HerdRabbit into $TEMPORARY"
    git clone --quiet --depth 1 "$REPOSITORY_URL" "$TEMPORARY/HerdRabbit"
    npm --prefix "$TEMPORARY/HerdRabbit" ci --omit=dev
    cd "$HOME"
    # Only node reads the terminal: the shell goes on reading this script from the pipe.
    node "$TEMPORARY/HerdRabbit/scripts/install-plugin.mjs" </dev/tty
}

main "$@"
