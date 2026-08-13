import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const read = (relative: string) => readFile(path.join(process.cwd(), relative), "utf8");

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

test("macOS client generator reuses the existing short-lived B2 grant contract", async () => {
  const generator = await read("distribution/b2/new-mac-client-installer.ps1");
  const publisher = await read("distribution/b2/publish-release.mjs");

  assert.match(generator, /grant-release\.mjs/);
  assert.match(generator, /readFiles/);
  assert.match(generator, /3660000/);
  assert.match(generator, /openai-cc-runtime-manifest-darwin-arm64\.json/);
  assert.match(generator, /installerSha256/);
  assert.match(generator, /\.command/);
  assert.match(generator, /revoke-grant\.mjs/);
  assert.match(publisher, /darwin-arm64/);
  assert.match(publisher, /install-macos\.mjs/);
  assert.match(publisher, /--platform/);
});
