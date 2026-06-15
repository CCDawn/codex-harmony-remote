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

if ! nc -z "${LOCAL_SSH_HOST}" "${LOCAL_SSH_PORT}" >/dev/null 2>&1; then
  echo "Mac SSH is not listening on ${LOCAL_SSH_HOST}:${LOCAL_SSH_PORT}." >&2
  echo "Enable: System Settings -> General -> Sharing -> Remote Login" >&2
  exit 1
fi

args=(
  -N
  -o ExitOnForwardFailure=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o TCPKeepAlive=yes
  -R "127.0.0.1:${SERVER_SSH_PORT}:${LOCAL_SSH_HOST}:${LOCAL_SSH_PORT}"
)

echo "Starting Mac reverse access tunnel:"
echo "  Server 127.0.0.1:${SERVER_SSH_PORT} -> Mac ${LOCAL_SSH_HOST}:${LOCAL_SSH_PORT}"

if [[ "${ENABLE_VNC}" == "1" ]]; then
  if ! nc -z "${LOCAL_VNC_HOST}" "${LOCAL_VNC_PORT}" >/dev/null 2>&1; then
    echo "Mac Screen Sharing is not listening on ${LOCAL_VNC_HOST}:${LOCAL_VNC_PORT}." >&2
    echo "Enable: System Settings -> General -> Sharing -> Screen Sharing" >&2
    exit 1
  fi
  args+=(-R "127.0.0.1:${SERVER_VNC_PORT}:${LOCAL_VNC_HOST}:${LOCAL_VNC_PORT}")
  echo "  Server 127.0.0.1:${SERVER_VNC_PORT} -> Mac ${LOCAL_VNC_HOST}:${LOCAL_VNC_PORT}"
fi

echo
echo "Keep this terminal open. Press Ctrl+C to stop."
exec ssh "${args[@]}" "${SSH_HOST}"
