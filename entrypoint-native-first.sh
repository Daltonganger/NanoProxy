#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export INTERNAL_PROXY_HOST="${INTERNAL_PROXY_HOST:-127.0.0.1}"
export INTERNAL_PROXY_PORT="${INTERNAL_PROXY_PORT:-8788}"
export UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-https://nano-gpt.com/api/v1}"

PROXY_HOST="$INTERNAL_PROXY_HOST" PROXY_PORT="$INTERNAL_PROXY_PORT" UPSTREAM_BASE_URL="$UPSTREAM_BASE_URL" node "$SCRIPT_DIR/server.js" &
bridge_pid=$!

cleanup() {
  kill "$bridge_pid" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

for _ in $(seq 1 50); do
  if wget -qO- "http://${INTERNAL_PROXY_HOST}:${INTERNAL_PROXY_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

exec node "$SCRIPT_DIR/native-first-proxy.js"
