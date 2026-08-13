#!/bin/bash
set -euo pipefail
GATEWAY_BASE_URL="http://127.0.0.1:8082"
/usr/bin/curl -fsS --max-time 2 "$GATEWAY_BASE_URL/healthz" >/dev/null || {
  echo "OpenAI-CC gateway is not running. Start the installed LaunchAgent or run current/run-gateway.sh." >&2
  exit 1
}
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[[ -n "$CLAUDE_BIN" ]] || { echo "Claude Code is not installed or is not on PATH." >&2; exit 1; }
export ANTHROPIC_BASE_URL="$GATEWAY_BASE_URL"
exec "$CLAUDE_BIN" "$@"
