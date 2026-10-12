#!/bin/sh
set -eu

log() { printf '  > %s\n' "$1"; }
fail() { printf '  x %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "requires '$1'"; }

# Once main has moved forward, a failure puts the previous commit and its
# dependencies back, so the service is never left on code that did not pass.
# Herdr is not rolled back: an older HerdRabbit runs on a newer Herdr.
roll_back() {
    log "Rolling back to $(git rev-parse --short "$PREVIOUS_HEAD")"
    git reset --hard "$PREVIOUS_HEAD"
    npm ci --omit=dev || log "Warning: restoring the previous dependencies failed; run npm ci --omit=dev here"
    if [ "${RESTARTED:-0}" = 1 ]; then
        systemctl --user restart "$UPDATE_SERVICE" || log "Warning: the previous version did not restart either"
    fi
    fail "$1; rolled back to $(git rev-parse --short HEAD)"
}

# Parse the entire function before updating this script on disk.
main() {
    [ "$#" -eq 0 ] || fail "Usage: sh update.sh (optional: HERD_RABBIT_INSTALL_DIR=/path)"
    for dependency in git node npm systemctl flock; do need "$dependency"; done
    [ "$(uname -s)" = Linux ] || fail "the service updater supports Linux only"
    [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] || fail "requires Node.js 22 or newer"

    if [ -n "${HERD_RABBIT_INSTALL_DIR:-}" ]; then
        UPDATE_DIRECTORY="$HERD_RABBIT_INSTALL_DIR"
    elif [ -f "$0" ]; then
        UPDATE_DIRECTORY="$(dirname -- "$0")"
    else
        UPDATE_DIRECTORY="$HOME/.local/share/herd-rabbit"
    fi
    cd "$UPDATE_DIRECTORY" || fail "installation directory does not exist"
    UPDATE_DIRECTORY="$(pwd -P)"
    [ "$(git rev-parse --show-toplevel)" = "$UPDATE_DIRECTORY" ] || fail "run this script from a HerdRabbit repository root"
    case "$(git remote get-url origin)" in
        https://github.com/ultivis-iot/HerdRabbit.git|https://github.com/ultivis-iot/HerdRabbit|git@github.com:ultivis-iot/HerdRabbit.git) ;;
        *) fail "origin is not ultivis-iot/HerdRabbit" ;;
    esac
    UPDATE_LOCK="$(git rev-parse --git-path herdrabbit-update.lock)"
    exec 9>"$UPDATE_LOCK"
    flock -n 9 || fail "another update is running"
    [ "$(git branch --show-current)" = main ] || fail "updates require the main branch"
    [ -z "$(git status --porcelain)" ] || fail "local changes found; commit or move them before updating"

    UPDATE_SERVICE=herdrabbit.service
    if [ "$(systemctl --user show "$UPDATE_SERVICE" --property=LoadState --value)" != loaded ]; then
        UPDATE_SERVICE=herdr-web-local.service
    fi
    [ "$(systemctl --user show "$UPDATE_SERVICE" --property=LoadState --value)" = loaded ] || fail "service not installed for this user; run the installer first"
    SERVICE_DIRECTORY="$(systemctl --user show "$UPDATE_SERVICE" --property=WorkingDirectory --value)"
    [ -n "$SERVICE_DIRECTORY" ] || fail "could not determine the service installation directory"
    SERVICE_DIRECTORY="$(cd "$SERVICE_DIRECTORY" && pwd -P)"
    [ "$SERVICE_DIRECTORY" = "$UPDATE_DIRECTORY" ] || fail "service uses a different installation directory: $SERVICE_DIRECTORY"
    # The service's own Herdr is the one to update and check, not whichever
    # this shell would find first.
    SERVICE_HERDR_BIN="$(systemctl --user show "$UPDATE_SERVICE" --property=Environment --value | node scripts/service-environment.mjs HERDR_BIN)"
    HERDR_BIN="${SERVICE_HERDR_BIN:-${HERDR_BIN:-herdr}}"
    export HERDR_BIN
    need "$HERDR_BIN"

    log "Fetching main in $UPDATE_DIRECTORY"
    git fetch origin main
    git merge-base --is-ancestor HEAD FETCH_HEAD || fail "local main has unpublished or divergent commits; reconcile it manually"
    # Herdr comes first, checked against the minimum the incoming code names,
    # so a Herdr too old for it stops the update before any file changes.
    # The incoming src is read before Herdr is touched: if it cannot be, nothing
    # changes at all. It is the whole src, so its version module may import its
    # neighbours.
    INCOMING_DIRECTORY="$(mktemp -d)"
    git archive FETCH_HEAD src | tar -x -C "$INCOMING_DIRECTORY" || { rm -rf "$INCOMING_DIRECTORY"; fail "could not read the new code's src to check Herdr against"; }
    # --handoff moves running panes onto the new Herdr instead of stopping them.
    # A failed download leaves the installed Herdr in place; the version check
    # decides whether that one is still new enough.
    log "Updating Herdr"
    "$HERDR_BIN" update --handoff || log "Warning: Herdr could not be updated; keeping the installed version"
    # Passed to the check alone: exported, it would reach the tests below.
    HERDR_VERSION_MODULE="$INCOMING_DIRECTORY/src/herdr-version.mjs" node scripts/check-herdr-version.mjs || { rm -rf "$INCOMING_DIRECTORY"; fail "Herdr is missing or too old for the new HerdRabbit; update it and run this script again"; }
    rm -rf "$INCOMING_DIRECTORY"
    PREVIOUS_HEAD="$(git rev-parse HEAD)"
    git merge --ff-only FETCH_HEAD
    log "Installing runtime dependencies"
    npm ci --omit=dev || roll_back "dependency installation failed"
    log "Verifying the updated code"
    npm run verify || roll_back "verification failed"
    log "Configuring Claude to use native terminal scrollback"
    # Not rolled back: it only edits Claude's settings, and the new code has
    # already passed verification.
    node scripts/configure-claude.mjs
    log "Restarting $UPDATE_SERVICE"
    RESTARTED=1
    systemctl --user restart "$UPDATE_SERVICE" || roll_back "the service did not restart; check journalctl --user -u $UPDATE_SERVICE"
    systemctl --user is-active --quiet "$UPDATE_SERVICE" || roll_back "service is not active; check journalctl --user -u $UPDATE_SERVICE"
    log "Updated to $(git rev-parse --short HEAD). Refresh the web app or PWA."
    log "Existing service settings and saved SSH connections are preserved."

    # A unit that drifted to 0.0.0.0 -- hand-edited, or written by an older
    # installer -- puts the service on every network the machine is attached to,
    # including LAN and container bridges, and nothing else says so. The
    # installer binds loopback and lets Tailscale terminate HTTPS in front.
    BOUND_HOST="$(systemctl --user show "$UPDATE_SERVICE" --property=Environment --value | tr ' ' '\n' | sed -n 's/^HERDR_WEB_HOST=//p')"
    SERVER_ROLE="$(systemctl --user show "$UPDATE_SERVICE" --property=Environment --value | tr ' ' '\n' | sed -n 's/^HERDR_WEB_ROLE=//p')"
    if [ "$SERVER_ROLE" = leaf ]; then
        log "This machine was installed as a leaf, which is no longer supported. It now listens on 127.0.0.1 only."
        log "         Run 'npm run install-service' here to set it up again, and add it to your other HerdRabbit with herdr machine."
    fi
    if [ "$BOUND_HOST" = 0.0.0.0 ]; then
        log "Warning: this service binds 0.0.0.0, so it answers on every network this machine is on, not only your tailnet."
        log "         Set Environment=HERDR_WEB_HOST=127.0.0.1 in the unit and register 'tailscale serve --https=<port> http://127.0.0.1:<port>' to close that off."
    fi
}

main "$@"
