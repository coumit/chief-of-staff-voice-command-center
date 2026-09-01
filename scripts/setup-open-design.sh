#!/usr/bin/env bash
# =============================================================================
# setup-open-design.sh
# -----------------------------------------------------------------------------
# One-time setup for the bundled Open Design submodule (third_party/open-design).
# Chief of Staff (Jarvis) ships Open Design as a git submodule; this script:
#   1. Initializes/updates the submodule (in case it wasn't cloned recursively)
#   2. Verifies Node 24 + pnpm are available (Open Design requires them)
#   3. Installs dependencies and builds the `od` CLI + daemon (`pnpm bootstrap`)
#
# After this runs once, the app's "call my design shop" command can spawn the
# bundled `od` daemon on demand — customers do NOT need a separate Open Design
# checkout.
#
# Usage:  ./scripts/setup-open-design.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OD_DIR="$REPO_ROOT/third_party/open-design"

echo "==> Open Design setup"
echo "    submodule dir: $OD_DIR"

# --- 1. Ensure the submodule is present ------------------------------------
if [ ! -f "$OD_DIR/package.json" ]; then
  echo "==> Submodule not initialized; fetching it now..."
  git -C "$REPO_ROOT" submodule update --init --recursive third_party/open-design
fi

if [ ! -f "$OD_DIR/package.json" ]; then
  echo "ERROR: Open Design submodule still missing at $OD_DIR." >&2
  echo "       Try: git submodule update --init --recursive" >&2
  exit 1
fi

# --- 2. Check Node version (Open Design requires Node ~24) ------------------
NEED_NODE_MAJOR="$(tr -dc '0-9' < "$OD_DIR/.node-version" 2>/dev/null || echo 24)"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Open Design needs Node ${NEED_NODE_MAJOR}." >&2
  echo "       Install it (e.g. via nvm/fnm/asdf) and re-run this script." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "$NEED_NODE_MAJOR" ]; then
  echo "WARNING: Node ${NODE_MAJOR} detected, but Open Design expects Node ${NEED_NODE_MAJOR}." >&2
  echo "         If the build fails, switch Node versions (nvm use ${NEED_NODE_MAJOR}) and retry." >&2
fi

# --- 3. Ensure pnpm is available -------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "==> Enabling pnpm via corepack..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.33.2 --activate >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm not found. Install pnpm >= 10.33.2 (https://pnpm.io/installation)" >&2
  echo "       or enable corepack: 'corepack enable'." >&2
  exit 1
fi

# --- 4. Install + build ----------------------------------------------------
echo "==> Installing Open Design dependencies (this can take a few minutes)..."
( cd "$OD_DIR" && pnpm install )

echo "==> Building the od CLI + daemon..."
( cd "$OD_DIR" && pnpm bootstrap )

# --- 5. Verify the od binary is runnable -----------------------------------
OD_BIN="$OD_DIR/node_modules/.bin/od"
if [ ! -e "$OD_BIN" ]; then
  OD_BIN="$OD_DIR/apps/daemon/bin/od.mjs"
fi
if [ -e "$OD_DIR/apps/daemon/dist/cli.js" ]; then
  echo "==> Build OK: $OD_DIR/apps/daemon/dist/cli.js exists."
else
  echo "WARNING: expected build output apps/daemon/dist/cli.js not found." >&2
fi

echo ""
echo "==> Done. The bundled Open Design 'od' CLI is at:"
echo "    $OD_BIN"
echo ""
echo "The app resolves this automatically. To override, set OD_BIN in your env."
echo "Say \"call my design shop\" in the app to launch the daemon on demand."
