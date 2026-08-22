import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const readMaybe = async (relative: string) => {
  try { return await readFile(path.join(process.cwd(), relative), "utf8"); } catch { return ""; }
};

test("macOS uninstall is ownership-aware and preserves unrelated Claude state", async () => {
  const uninstall = await readMaybe("uninstall-macos.mjs");
  const launcher = await readMaybe("uninstall.command");

  assert.ok(uninstall, "uninstall-macos.mjs must exist");
  assert.ok(launcher, "uninstall.command must exist");
  assert.match(uninstall, /managedDependencies/);
  assert.match(uninstall, /installedByOpenAICC/);
  assert.match(uninstall, /com\.openai-cc\.gateway/);
  assert.match(uninstall, /healthz/);
  assert.match(uninstall, /00000000-0000-4000-8000-000000008082/);
  assert.match(uninstall, /ANTHROPIC_BASE_URL/);
  assert.match(uninstall, /CLAUDE_CODE_USE_GATEWAY/);
  assert.doesNotMatch(uninstall, /rm\s+-rf\s+["']?\$HOME\/\.claude|Application Support\/Claude["']?\s*\)/);
  assert.match(launcher, /uninstall-macos\.mjs/);
});
