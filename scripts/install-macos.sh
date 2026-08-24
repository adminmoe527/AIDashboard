#!/usr/bin/env bash
#
# One-command installer for AI Status on macOS.
#
#   git clone -b claude/ai-status-dashboard-sbs9uv \
#     https://github.com/adminmoe527/AIDashboard.git ~/AIDashboard \
#     && bash ~/AIDashboard/scripts/install-macos.sh
#
# Safe to re-run any time: it pulls the latest code, rebuilds, and replaces
# the installed app.

set -euo pipefail

BRANCH="claude/ai-status-dashboard-sbs9uv"
APP_NAME="AI Status"
DEST="/Applications/${APP_NAME}.app"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- sanity ----
[ "$(uname)" = "Darwin" ] || fail "This installer is for macOS. On other systems, see the README."

command -v git >/dev/null 2>&1 \
  || fail "git is required. Install the Xcode Command Line Tools: xcode-select --install"

command -v node >/dev/null 2>&1 \
  || fail "Node.js 20+ is required. Install it with: brew install node   (or from https://nodejs.org)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] \
  || fail "Node.js ${NODE_MAJOR} found, but 20+ is required. Update with: brew upgrade node"

# Repo root = one directory up from this script.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# ------------------------------------------------------------- update src ----
say "Updating source (${BRANCH})"
git fetch origin "$BRANCH" || true
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH" || true

# ----------------------------------------------------------------- build ----
say "Installing build dependencies (first run downloads Electron, ~100MB)"
npm install --no-audit --no-fund

say "Building ${APP_NAME}.app"
npm run pack

APP_SRC="$(find "$REPO/dist" -maxdepth 2 -type d -name "${APP_NAME}.app" | head -1)"
[ -n "$APP_SRC" ] || fail "Build finished but ${APP_NAME}.app was not found under dist/."

# --------------------------------------------------------------- install ----
say "Installing to /Applications"
# Quit a running copy so the bundle can be replaced cleanly.
osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
sleep 1

rm -rf "$DEST"
ditto "$APP_SRC" "$DEST"

# The build is unsigned; clear quarantine so Gatekeeper doesn't block it.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

say "Launching"
open "$DEST"

cat <<EOF

  Done. Look for the status dot near your clock in the menu bar.

    - Click the dot for the dashboard popover
    - Right-click it for settings, including "Start at Login"
    - To update later, just re-run this script

EOF
