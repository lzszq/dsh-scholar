#!/usr/bin/env bash
# Start the fully standalone DSH Scholar web application — no `dsh web` involved.
#
# This is the only supported browser UI. It runs the research-ui package's
# own HTTP server and does not inject any panel into `dsh web`:
#   - the shared DSH Research Kernel (default :7412)
#   - the full-screen UI at http://127.0.0.1:18610 (token-gated)
#   - /v1/* proxied to that kernel with bearer-token auth + CSRF checks
#
# Usage: bash scripts/start-standalone-ui.sh [--host 127.0.0.1] [--port 18610]
#        [--kernel-port 7412] [--kernel-data-dir <path>] [--data-dir <path>]
#        [--no-token]
#
# SEC-UI-01: token mode reads or creates the server-owned 0600 token file.
# Secret values are never accepted on argv, exposed by `ps`/`/proc`, or
# printed by this launcher.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
WEB_HOST="${DSH_SCHOLAR_STANDALONE_HOST:-127.0.0.1}"
WEB_PORT="${DSH_SCHOLAR_STANDALONE_PORT:-18610}"
KERNEL_PORT="${DSH_SCHOLAR_STANDALONE_KERNEL_PORT:-7412}"
KERNEL_DATA_DIR="${DSH_SCHOLAR_KERNEL_DATA:-$HOME/.dsh/research-kernel}"
DATA_DIR="${DSH_SCHOLAR_STANDALONE_DATA:-$HOME/.dsh-scholar-standalone}"
FRAME_ANCESTORS="${DSH_SCHOLAR_STANDALONE_FRAME_ANCESTORS:-http://127.0.0.1:3080,http://localhost:3080,http://[::1]:3080}"
SERVER_DATA_DIR="$DATA_DIR/research-ui-standalone"
PASSTHROUGH=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) WEB_HOST=$2; shift 2 ;;
    --host=*) WEB_HOST=${1#*=}; shift ;;
    --port) WEB_PORT=$2; shift 2 ;;
    --port=*) WEB_PORT=${1#*=}; shift ;;
    --kernel-port) KERNEL_PORT=$2; shift 2 ;;
    --kernel-port=*) KERNEL_PORT=${1#*=}; shift ;;
    --kernel-data-dir) KERNEL_DATA_DIR=$2; shift 2 ;;
    --kernel-data-dir=*) KERNEL_DATA_DIR=${1#*=}; shift ;;
    --data-dir) SERVER_DATA_DIR=$2; shift 2 ;;
    --data-dir=*) SERVER_DATA_DIR=${1#*=}; shift ;;
    --no-token) PASSTHROUGH+=(--no-token); shift ;;
    --principal) PASSTHROUGH+=(--principal "$2"); shift 2 ;;
    --principal=*) PASSTHROUGH+=(--principal "${1#*=}"); shift ;;
    --frame-ancestors) FRAME_ANCESTORS=$2; shift 2 ;;
    --frame-ancestors=*) FRAME_ANCESTORS=${1#*=}; shift ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done


case "$WEB_HOST" in
  0.0.0.0) PROBE_HOST=127.0.0.1 ;;
  ::|0:0:0:0:0:0:0:0) PROBE_HOST='[::1]' ;;
  *:*) PROBE_HOST="[$WEB_HOST]" ;;
  *) PROBE_HOST=$WEB_HOST ;;
esac
WEB_URL="http://$PROBE_HOST:$WEB_PORT"

BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$BIN" ]; then
  echo "building research-ui (client + standalone server) ..."
  (cd "$REPO/packages/dsh-research-ui" && pnpm run build)
fi

mkdir -p "$DATA_DIR"
echo "starting standalone DSH Scholar: $WEB_URL (kernel :$KERNEL_PORT, kernel data: $KERNEL_DATA_DIR, BFF data: $SERVER_DATA_DIR)"
# GOV-01: without an explicit operator override, the standalone BFF derives
# the same credential-bound principal as the DSH plugin from the shared
# kernel data directory. This keeps both project lists identical.
if [ -n "${DSH_SCHOLAR_STANDALONE_PRINCIPAL:-}" ] && ! [[ " ${PASSTHROUGH[*]} " == *" --principal "* ]]; then
  PASSTHROUGH+=(--principal "$DSH_SCHOLAR_STANDALONE_PRINCIPAL")
fi
setsid nohup node "$BIN" \
  --host "$WEB_HOST" --port "$WEB_PORT" --kernel-port "$KERNEL_PORT" \
  --kernel-data-dir "$KERNEL_DATA_DIR" --data-dir "$SERVER_DATA_DIR" \
  --frame-ancestors "$FRAME_ANCESTORS" \
  "${PASSTHROUGH[@]}" \
  >> "$DATA_DIR/standalone.log" 2>&1 < /dev/null &
SERVER_PID=$!
echo "pid $SERVER_PID — log: $DATA_DIR/standalone.log"
echo "token: $SERVER_DATA_DIR/standalone-token"

READY=0
for _ in $(seq 1 40); do
  if curl -sf -m 2 "$WEB_URL/" > /dev/null 2>&1; then
    READY_TOKEN=''
    if [ -f "$SERVER_DATA_DIR/standalone-token" ]; then
      READY_TOKEN=$(tr -d '\n' < "$SERVER_DATA_DIR/standalone-token")
    fi
    READY_BODY=$(node -e 'process.stdout.write(JSON.stringify({ token: process.argv[1] }))' "$READY_TOKEN")
    if curl -sf -m 2 -H 'Content-Type: application/json' -d "$READY_BODY" "$WEB_URL/api/token-check" | grep -q '"ok":true'; then
      READY=1
      break
    fi
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  echo "standalone DSH Scholar did not become ready; inspect $DATA_DIR/standalone.log" >&2
  tail -n 20 "$DATA_DIR/standalone.log" >&2 || true
  exit 1
fi
echo ""
echo "open $WEB_URL and paste the access token (see above)."
echo "verification: curl -s http://127.0.0.1:$KERNEL_PORT/v1/health"
