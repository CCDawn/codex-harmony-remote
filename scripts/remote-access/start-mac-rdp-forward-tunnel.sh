#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-<relay-server>}"
LOCAL_PORT="${LOCAL_PORT:-3389}"
SERVER_RDP_PORT="${SERVER_RDP_PORT:-13389}"

if nc -z 127.0.0.1 "${LOCAL_PORT}" >/dev/null 2>&1; then
  echo "Mac local RDP tunnel already appears alive: 127.0.0.1:${LOCAL_PORT}"
  echo "Open Windows App and connect to 127.0.0.1:${LOCAL_PORT}"
  exit 0
fi

if ! ssh "${SSH_HOST}" "python3 - <<'PY'
import socket
s=socket.socket()
s.settimeout(2)
try:
    s.connect(('127.0.0.1',${SERVER_RDP_PORT}))
    print('connect-ok')
except Exception as e:
    print('connect-failed', e)
finally:
    s.close()
PY" | grep -q 'connect-ok'; then
  echo "Server-side RDP reverse tunnel is not reachable: ${SSH_HOST}:127.0.0.1:${SERVER_RDP_PORT}" >&2
  echo "Run scripts/remote-access/start-windows-rdp-reverse-tunnel.ps1 on Windows first." >&2
  exit 1
fi

echo "Starting Mac RDP tunnel:"
echo "  localhost:${LOCAL_PORT} -> ${SSH_HOST}:127.0.0.1:${SERVER_RDP_PORT}"
echo "Open Windows App and connect to 127.0.0.1:${LOCAL_PORT}"
echo
ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${SERVER_RDP_PORT}" \
  "$SSH_HOST"
