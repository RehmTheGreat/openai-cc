#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${OPENAI_CC_NODE:-$(command -v node 2>/dev/null || true)}"
[[ -n "$NODE_BIN" ]] || { echo "Node.js 20+ is required for OpenAI-CC on macOS." >&2; exit 1; }
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 20 ]] || { echo "Node.js 20+ is required; found $($NODE_BIN --version)." >&2; exit 1; }
exec "$NODE_BIN" "$SCRIPT_DIR/install-macos.mjs" "$@"
