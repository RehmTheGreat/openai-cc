#!/bin/bash
set -euo pipefail
ROOT="${OPENAI_CC_HOME:-$HOME/Library/Application Support/OpenAI-CC}"
NODE="$ROOT/toolchain/node/bin/node"
SCRIPT="$ROOT/current/uninstall-macos.mjs"
[[ -x "$NODE" ]] || { echo "OpenAI-CC private Node is missing: $NODE" >&2; exit 1; }
[[ -f "$SCRIPT" ]] || { echo "OpenAI-CC uninstaller is missing: $SCRIPT" >&2; exit 1; }
exec "$NODE" "$SCRIPT" --install-root "$ROOT" "$@"
