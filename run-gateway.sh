#!/bin/bash
set -uo pipefail

GATEWAY_BASE_URL="http://127.0.0.1:8082"
INSTALL_ROOT="${OPENAI_CC_HOME:-$HOME/Library/Application Support/OpenAI-CC}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

NODE_BIN="${OPENAI_CC_NODE:-}"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js 20+ is required and was not found." >&2; exit 1; }

existing_pid="$(/usr/sbin/lsof -nP -tiTCP:8082 -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [[ -n "$existing_pid" ]]; then
  health="$(/usr/bin/curl -fsS --max-time 2 "$GATEWAY_BASE_URL/healthz" 2>/dev/null || true)"
  managed="$("$NODE_BIN" -e '
const p=require("node:path"); let h={}; try{h=JSON.parse(process.argv[1])}catch{}
process.stdout.write(h.ok && Number(h.pid)===Number(process.argv[3]) && p.resolve(String(h.installRoot||""))===p.resolve(process.argv[2]) ? "yes":"no");
' "$health" "$INSTALL_ROOT" "$existing_pid" 2>/dev/null || true)"
  if [[ "$managed" == "yes" ]]; then exit 0; fi
  echo "Port 8082 is already occupied by PID $existing_pid and is not this managed OpenAI-CC runtime." >&2
  exit 1
fi

while true; do
  RUNTIME_ROOT="$INSTALL_ROOT/current"
  ENTRYPOINT="$RUNTIME_ROOT/dist/src/index.js"
  MANIFEST="$RUNTIME_ROOT/runtime-manifest.json"
  [[ -f "$ENTRYPOINT" ]] || { echo "OpenAI-CC runtime entrypoint is missing: $ENTRYPOINT" >&2; exit 1; }
  [[ -f "$MANIFEST" ]] || { echo "OpenAI-CC runtime manifest is missing: $MANIFEST" >&2; exit 1; }

  export OPENAI_CC_HOME="$INSTALL_ROOT"
  export OPENAI_CC_RUNTIME_ROOT="$RUNTIME_ROOT"
  export OPENAI_CC_WATCH_RUNTIME_SWAP="1"
  export DATA_DIR="$INSTALL_ROOT/.data"
  cd "$INSTALL_ROOT"
  "$NODE_BIN" "$ENTRYPOINT"
  exit_code=$?
  if [[ "${OPENAI_CC_GATEWAY_ONESHOT:-0}" == "1" ]]; then exit "$exit_code"; fi
  /bin/sleep 0.5
done
