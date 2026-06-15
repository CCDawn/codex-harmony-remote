#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-root@<your-relay-server>}"
SERVER_SSH_PORT="${SERVER_SSH_PORT:-22022}"
SERVER_VNC_PORT="${SERVER_VNC_PORT:-15900}"
ENABLE_VNC="${ENABLE_VNC:-0}"
LOCAL_SSH_HOST="${LOCAL_SSH_HOST:-127.0.0.1}"
LOCAL_SSH_PORT="${LOCAL_SSH_PORT:-22}"
LOCAL_VNC_HOST="${LOCAL_VNC_HOST:-127.0.0.1}"
LOCAL_VNC_PORT="${LOCAL_VNC_PORT:-5900}"
LOG_DIR="${LOG_DIR:-$HOME/codex-remote-link/logs}"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/mac-reverse-access.log"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a "$LOG_FILE"
}

port_open() {
  nc -z "$1" "$2" >/dev/null 2>&1
}

clear_remote_port() {
  local port="$1"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "python3 - <<'PY'
import os, re, subprocess
port = '$port'
try:
    out = subprocess.check_output(['ss', '-ltnp'], text=True, stderr=subprocess.DEVNULL)
except Exception:
    out = ''
pids = set()
for line in out.splitlines():
    if f':{port} ' not in line:
        continue
    for pid in re.findall(r'pid=(\d+)', line):
        pids.add(pid)
for pid in pids:
    try:
        os.kill(int(pid), 15)
        print(f'killed stale listener pid={pid} port={port}')
    except Exception as exc:
        print(f'kill failed pid={pid} port={port}: {exc}')
PY" >>"$LOG_FILE" 2>&1 || true
}

while true; do
  if ! port_open "$LOCAL_SSH_HOST" "$LOCAL_SSH_PORT"; then
    log "Mac SSH is not listening on ${LOCAL_SSH_HOST}:${LOCAL_SSH_PORT}; retrying"
    sleep 10
    continue
  fi

  args=(
    -N
    -o BatchMode=yes
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=20
    -o ServerAliveCountMax=2
    -o TCPKeepAlive=yes
    -R "127.0.0.1:${SERVER_SSH_PORT}:${LOCAL_SSH_HOST}:${LOCAL_SSH_PORT}"
  )

  clear_remote_port "$SERVER_SSH_PORT"
  log "starting reverse SSH: server 127.0.0.1:${SERVER_SSH_PORT} -> Mac ${LOCAL_SSH_HOST}:${LOCAL_SSH_PORT}"

  if [[ "$ENABLE_VNC" == "1" ]]; then
    if port_open "$LOCAL_VNC_HOST" "$LOCAL_VNC_PORT"; then
      clear_remote_port "$SERVER_VNC_PORT"
      args+=(-R "127.0.0.1:${SERVER_VNC_PORT}:${LOCAL_VNC_HOST}:${LOCAL_VNC_PORT}")
      log "starting reverse VNC: server 127.0.0.1:${SERVER_VNC_PORT} -> Mac ${LOCAL_VNC_HOST}:${LOCAL_VNC_PORT}"
    else
      log "Mac Screen Sharing is not listening on ${LOCAL_VNC_HOST}:${LOCAL_VNC_PORT}; SSH only"
    fi
  fi

  set +e
  ssh "${args[@]}" "$SSH_HOST" >>"$LOG_FILE" 2>&1
  exit_code=$?
  set -e
  log "reverse tunnel exited with code ${exit_code}; reconnecting in 5s"
  sleep 5
done
