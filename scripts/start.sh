#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEAMHUB_DEMO_MODE=0
TEAMHUB_PORT_VALUE=8765
TEAMHUB_DATA_PATH=''
TEAMHUB_LISTEN_ADDRESS='127.0.0.1'
while (( $# )); do
  case "$1" in
    --demo) TEAMHUB_DEMO_MODE=1; shift ;;
    --port) TEAMHUB_PORT_VALUE="$2"; shift 2 ;;
    --data-dir) TEAMHUB_DATA_PATH="$2"; shift 2 ;;
    --host) TEAMHUB_LISTEN_ADDRESS="$2"; shift 2 ;;
    *) echo "Usage: bash scripts/start.sh [--demo] [--port 8765] [--data-dir PATH] [--host ADDRESS]"; exit 2 ;;
  esac
done
if [[ -z "$TEAMHUB_DATA_PATH" ]]; then
  if (( TEAMHUB_DEMO_MODE )); then TEAMHUB_DATA_PATH='.teamhub-demo'; else TEAMHUB_DATA_PATH='.teamhub'; fi
fi
[[ -x .venv/bin/python ]] || python3 -m venv .venv
.venv/bin/python -m pip install -c constraints-tested.txt -e '.[mcp]'
if [[ ! -f web/dist/index.html ]]; then
  (cd web && npm ci && npm run build)
fi
if (( ! TEAMHUB_DEMO_MODE )) && [[ ! -f "$TEAMHUB_DATA_PATH/teamhub.db" ]]; then
  .venv/bin/python -m teamhub init --data-dir "$TEAMHUB_DATA_PATH"
fi
TEAMHUB_SERVE_ARGS=(-m teamhub serve --data-dir "$TEAMHUB_DATA_PATH" --port "$TEAMHUB_PORT_VALUE" --host "$TEAMHUB_LISTEN_ADDRESS")
if (( TEAMHUB_DEMO_MODE )); then TEAMHUB_SERVE_ARGS+=(--demo); fi
exec .venv/bin/python "${TEAMHUB_SERVE_ARGS[@]}"
