#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

export CODEX_RELAY_BASE="${CODEX_RELAY_BASE:-http://<your-relay-server>:19078}"
export CODEX_BRIDGE_TOKEN="${CODEX_BRIDGE_TOKEN:-}"
export CODEX_MAC_PROXY_HOST="${CODEX_MAC_PROXY_HOST:-127.0.0.1}"
export CODEX_MAC_PROXY_PORT="${CODEX_MAC_PROXY_PORT:-8787}"

cd "$REPO_ROOT"

echo "==> Start Mac Codex debug proxy"
echo "    Local:  http://${CODEX_MAC_PROXY_HOST}:${CODEX_MAC_PROXY_PORT}"
echo "    Relay:  ${CODEX_RELAY_BASE}"
echo
node scripts/remote-access/mac-codex-debug-proxy.mjs
