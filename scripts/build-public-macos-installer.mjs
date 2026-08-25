import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function fail(message) { throw new Error(message); }
function arg(name, fallback = "") { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
async function sha256(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function b64(bytes) { return Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\n"); }

const bundleDir = resolve(arg("--bundle-dir", "artifacts"));
const output = resolve(arg("--output", join(bundleDir, "OpenAI-CC-Mac-Installer.command")));
const manifestPath = join(bundleDir, "openai-cc-runtime-manifest-darwin-arm64.json");
const installPath = join(bundleDir, "install.sh");
const installerPath = join(bundleDir, "install-macos.mjs");
const provisionerPath = join(bundleDir, "macos-provision-clients.mjs");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.platform !== "darwin-arm64") fail("Expected darwin-arm64 manifest.");
if (!/^[0-9a-f]{40}$/i.test(String(manifest.sourceCommit || ""))) fail("Manifest sourceCommit is invalid.");
const bundleName = String(manifest.bundleUrl || "");
if (!bundleName || basename(bundleName) !== bundleName) fail("Manifest bundleUrl is unsafe.");
const bundlePath = join(bundleDir, bundleName);
const payloads = [
  ["install.sh", installPath, manifest.bootstrapSha256],
  ["install-macos.mjs", installerPath, manifest.installerSha256],
  ["macos-provision-clients.mjs", provisionerPath, manifest.provisionerSha256],
  ["openai-cc-runtime-manifest-darwin-arm64.json", manifestPath, await sha256(manifestPath)],
  [bundleName, bundlePath, manifest.bundleSha256],
];
for (const [name, path, expected] of payloads) {
  const info = await stat(path);
  if (!info.isFile() || !info.size) fail(`Payload is missing or empty: ${name}`);
  if ((await sha256(path)).toLowerCase() !== String(expected || "").toLowerCase()) fail(`Payload hash mismatch: ${name}`);
}

let script = `#!/bin/bash
set -euo pipefail
# OpenAI-CC public macOS installer
# Source SHA: ${manifest.sourceCommit}
# This artifact is self-contained and has no expiring distribution grant.
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo "This installer supports Apple Silicon macOS only." >&2; exit 1; }
TMP="$(mktemp -d \"${'${TMPDIR:-/tmp}'}/openai-cc-public.XXXXXX\")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
verify_sha() {
  local expected="$1" path="$2" actual
  actual="$(/usr/bin/shasum -a 256 "$path" | /usr/bin/awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "Integrity check failed for $path" >&2; exit 1; }
}
decode_payload() {
  local output="$1"
  /usr/bin/base64 -D > "$output"
}
`;
for (const [name, path, expected] of payloads) {
  const marker = `OPENAICC_${createHash("sha256").update(name).digest("hex").slice(0,16)}`;
  script += `\ndecode_payload "$TMP/${name}" <<'${marker}'\n${b64(await readFile(path))}\n${marker}\nverify_sha ${shellQuote(String(expected).toLowerCase())} "$TMP/${name}"\n`;
}
script += `
NODE_BASE="https://nodejs.org/dist/latest-v22.x"
/usr/bin/curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$NODE_BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
NODE_LINE="$(/usr/bin/awk '$2 ~ /^node-v[0-9.]+-darwin-arm64\\.tar\\.gz$/ {print $1 " " $2}' "$TMP/SHASUMS256.txt")"
[[ -n "$NODE_LINE" && "$(printf '%s\\n' "$NODE_LINE" | /usr/bin/wc -l | tr -d ' ')" == "1" ]] || { echo "Could not resolve one official Node 22 Apple Silicon archive." >&2; exit 1; }
NODE_SHA="${'${NODE_LINE%% *}'}"
NODE_FILE="${'${NODE_LINE#* }'}"
/usr/bin/curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$NODE_BASE/$NODE_FILE" -o "$TMP/$NODE_FILE"
verify_sha "$NODE_SHA" "$TMP/$NODE_FILE"
mkdir -p "$TMP/node"
/usr/bin/tar -xzf "$TMP/$NODE_FILE" -C "$TMP/node"
NODE_ROOT="$TMP/node/${'${NODE_FILE%.tar.gz}'}"
NODE_BIN="$NODE_ROOT/bin/node"
[[ -x "$NODE_BIN" ]] || { echo "Verified Node archive did not contain bin/node." >&2; exit 1; }
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -eq 22 ]] || { echo "Expected Node 22 bootstrap, found $($NODE_BIN --version)." >&2; exit 1; }
export OPENAI_CC_NODE="$NODE_BIN"
INSTALL_ARGS=(--manifest "$TMP/openai-cc-runtime-manifest-darwin-arm64.json" --bundle "$TMP/${bundleName}" --bootstrap-node-root "$NODE_ROOT")
if [[ -n "${'${OPENAI_CC_CLIENT_INSTALL_ROOT:-}'}" ]]; then INSTALL_ARGS+=(--install-root "$OPENAI_CC_CLIENT_INSTALL_ROOT"); fi
if [[ "${'${OPENAI_CC_SKIP_CLIENT_PROVISION:-0}'}" == "1" ]]; then INSTALL_ARGS+=(--skip-client-provision --skip-desktop-config); fi
if [[ "${'${OPENAI_CC_CLIENT_NO_STARTUP_SHORTCUT:-0}'}" == "1" ]]; then INSTALL_ARGS+=(--no-launch-agent); fi
/bin/bash "$TMP/install.sh" "${'${INSTALL_ARGS[@]}'}"
echo "[OK] OpenAI-CC, Claude Desktop, and Claude Code are ready."
echo "Admin: http://127.0.0.1:8082/admin"
if [[ "${'${OPENAI_CC_CLIENT_NO_OPEN_ADMIN:-0}'}" != "1" ]]; then /usr/bin/open "http://127.0.0.1:8082/admin" >/dev/null 2>&1 || true; fi
if [[ "${'${OPENAI_CC_CLIENT_NO_OPEN_CLAUDE:-0}'}" != "1" ]]; then
  if [[ -d "$HOME/Applications/Claude.app" ]]; then /usr/bin/open "$HOME/Applications/Claude.app" >/dev/null 2>&1 || true;
  elif [[ -d "/Applications/Claude.app" ]]; then /usr/bin/open "/Applications/Claude.app" >/dev/null 2>&1 || true; fi
fi
`;
await writeFile(output, script, { encoding: "utf8", mode: 0o700 });
console.log(`Public macOS installer: ${output}`);
console.log(`Source SHA: ${manifest.sourceCommit}`);
console.log(`SHA256: ${await sha256(output)}`);
