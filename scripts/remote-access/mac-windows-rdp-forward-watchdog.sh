#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-root@<your-relay-server>}"
LOCAL_RDP_PORT="${LOCAL_RDP_PORT:-3390}"
SERVER_RDP_PORT="${SERVER_RDP_PORT:-13389}"
LOG_DIR="${LOG_DIR:-$HOME/codex-remote-link/logs}"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/mac-windows-rdp-forward.log"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a "$LOG_FILE"
}

server_port_open() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "python3 - <<'PY'
import socket
s=socket.socket()
s.settimeout(2)
try:
    s.connect(('127.0.0.1',$SERVER_RDP_PORT))
    print('ok')
except Exception as e:
    print('failed', repr(e))
finally:
    s.close()
PY" 2>/dev/null | grep -q '^ok$'
}

while true; do
  if ! server_port_open; then
    log "server Windows RDP port 127.0.0.1:${SERVER_RDP_PORT} unavailable; retrying"
    sleep 10
    continue
  fi

  log "starting Mac local RDP forward: 127.0.0.1:${LOCAL_RDP_PORT} -> server 127.0.0.1:${SERVER_RDP_PORT}"
  set +e
  ssh -N \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=2 \
    -o TCPKeepAlive=yes \
    -L "127.0.0.1:${LOCAL_RDP_PORT}:127.0.0.1:${SERVER_RDP_PORT}" \
    "$SSH_HOST" >>"$LOG_FILE" 2>&1
  exit_code=$?
  set -e
  log "RDP forward exited with code ${exit_code}; reconnecting in 5s"
  sleep 5
done
