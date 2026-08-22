import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const read = (relative: string) => readFile(path.join(process.cwd(), relative), "utf8");
const readMaybe = async (relative: string) => {
  try { return await read(relative); } catch { return ""; }
};

test("macOS support is native Apple Silicon and keeps the shared gateway", async () => {
  const install = await read("install-macos.mjs");
  const gateway = await read("run-gateway.sh");
  const index = await read("src/index.ts");
  const watcher = await read("src/runtime-swap.ts");

  assert.match(install, /darwin-arm64/);
  assert.match(install, /Application Support["), ]+OpenAI-CC/);
  assert.match(install, /join\(installRoot, "\.data"\)/);
  assert.match(install, /rename\(current, rollback\)/);
  assert.match(install, /rename\(staged, current\)/);
  assert.match(install, /protected \.data changed during update/);
  assert.doesNotMatch(install, /process\.kill|kill -9|rm -rf/);

  assert.match(gateway, /OPENAI_CC_WATCH_RUNTIME_SWAP/);
  assert.match(gateway, /dist\/src\/index\.js/);
  assert.match(index, /watchManagedRuntimeSwap\(shutdown\)/);
  assert.match(watcher, /statSync\(path\.join\(installRoot, "current"\)\)/);
});

test("macOS runtime bundle is manifest-driven and contains no target state", async () => {
  const builder = await read("scripts/build-runtime-bundle-macos.mjs");
  assert.match(builder, /process\.platform !== "darwin"/);
  assert.match(builder, /process\.arch !== "arm64"/);
  assert.match(builder, /platform:"darwin-arm64"/);
  assert.match(builder, /openai-cc-runtime-manifest-darwin-arm64\.json/);
  assert.match(builder, /run-gateway\.sh/);
  assert.match(builder, /run-claude\.sh/);
  assert.match(builder, /installerSha256/);
  assert.doesNotMatch(builder, /copyItem\("\.data/);
});

test("legacy gated macOS generator stays scoped and uses unambiguous ESM stdin", async () => {
  const generator = await read("distribution/b2/new-mac-client-installer.ps1");
  const publisher = await read("distribution/b2/publish-release.mjs");

  assert.match(generator, /grant-release\.mjs/);
  assert.match(generator, /readFiles/);
  assert.match(generator, /ValidateRange\(300, 172800\)/);
  assert.match(generator, /openai-cc-runtime-manifest-darwin-arm64\.json/);
  assert.match(generator, /installerSha256/);
  assert.match(generator, /\.command/);
  assert.match(generator, /revoke-grant\.mjs/);
  assert.match(generator, /\.openai-cc-private\\b2-issuer-credentials\.json/);
  assert.match(generator, /Automatic cleanup could not revoke failed client grant/);
  assert.match(generator, /--input-type=module/);
  assert.doesNotMatch(generator, /const \{ createHash \} = require\("node:crypto"\)/);
  assert.match(publisher, /darwin-arm64/);
  assert.match(publisher, /install-macos\.mjs/);
  assert.match(publisher, /--platform/);
});

test("public macOS installer is durable, self-contained, and provisions verified Node", async () => {
  const builder = await readMaybe("scripts/build-public-macos-installer.mjs");
  assert.ok(builder, "public macOS installer builder must exist");
  assert.match(builder, /OpenAI-CC-Mac-Installer\.command/);
  assert.match(builder, /SHASUMS256\.txt/);
  assert.match(builder, /latest-v22\.x/);
  assert.match(builder, /shasum\s+-a\s+256/);
  assert.match(builder, /install-macos\.mjs/);
  assert.match(builder, /openai-cc-runtime-manifest-darwin-arm64\.json/);
  assert.doesNotMatch(builder, /B2_(?:ISSUER|PUBLISH|DIST)|applicationKey|expirationTimestamp|TtlSeconds/);
});

test("macOS installer owns private Node and provisions clients before configuration", async () => {
  const install = await read("install-macos.mjs");
  const provision = await readMaybe("macos-provision-clients.mjs");
  assert.match(install, /--bootstrap-node-root/);
  assert.match(install, /toolchain["), ]+node/);
  assert.match(install, /managedDependencies/);
  assert.match(install, /installedByOpenAICC/);
  assert.ok(provision, "macOS client provisioner must exist");
  assert.match(provision, /claude\.ai\/api\/desktop\/darwin\/universal\/dmg\/latest\/redirect/);
  assert.match(provision, /claude\.ai\/install\.sh/);
  assert.match(provision, /codesign/);
  assert.doesNotMatch(provision, /npm\s+install\s+-g|sudo/);

  const provisionAt = install.indexOf("provisionMacClients");
  const configureAt = install.indexOf("configure-clients.js");
  assert.ok(provisionAt >= 0 && configureAt > provisionAt, "clients must be provisioned before configuration");
  assert.doesNotMatch(install, /desktopInstalled\s*\?\s*"1"\s*:\s*"0"/);
});
