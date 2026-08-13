import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_DESKTOP_PROFILE_ID,
  ClaudeDesktopPaths,
  claudeDesktopModel,
  claudeDesktopModelList,
  configureClaudeDesktopAtPaths,
} from "../src/claude-desktop.js";
import { MODEL_SLOTS, ModelConfig, claudeCodeModelAlias } from "../src/model-config.js";

const config: ModelConfig = {
  contextWindow: 850000,
  routes: {
    default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 96000 },
    sonnet: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: 64000 },
    haiku: { provider: "nvidia", model: "test-haiku-upstream", maxOutputTokens: 32000 },
  },
};

test("Claude model discovery exposes route-specific context caps and client capability ids", () => {
  const response = claudeDesktopModelList(config);
  const aliases = Object.fromEntries(MODEL_SLOTS.map((slot) => [slot, claudeCodeModelAlias(config, slot)])) as Record<string, string>;
  assert.deepEqual(response.data.map((model) => model.id), MODEL_SLOTS.map((slot) => aliases[slot]));
  assert.equal(response.data.some((model) => model.id.includes("gemini") || model.id.includes("deepseek") || model.id.includes("gpt")), false);
  assert.equal(response.data.find((model) => model.id === aliases.default)?.max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === aliases.fable)?.max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === aliases.opus)?.max_input_tokens, 200000);
  assert.equal(response.data.find((model) => model.id === aliases.sonnet)?.max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === aliases.haiku)?.max_input_tokens, 200000);
  assert.equal(response.data.find((model) => model.id === aliases.opus)?.max_tokens, 96000);
  assert.equal((response.data.find((model) => model.id === aliases.sonnet)?.capabilities.image_input as any).supported, true);
  assert.equal((response.data.find((model) => model.id === aliases.haiku)?.capabilities.image_input as any).supported, false);
  assert.equal(response.has_more, false);
});

test("model retrieval accepts Claude-family version aliases without exposing upstream ids", () => {
  assert.equal(claudeDesktopModel(config, "claude-opus-5")?.max_tokens, 96000);
  assert.equal(claudeDesktopModel(config, "claude-opus-5-20260724")?.id, "claude-opus-5");
  assert.equal(claudeDesktopModel(config, "deepseek-v4-flash-free"), undefined);
});

test("Claude Desktop 3P configuration is merged and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-desktop-"));
  const paths: ClaudeDesktopPaths = {
    normalConfigFile: path.join(root, "Claude", "claude_desktop_config.json"),
    threepConfigFile: path.join(root, "Claude-3p", "claude_desktop_config.json"),
    profileFile: path.join(root, "Claude-3p", "configLibrary", `${CLAUDE_DESKTOP_PROFILE_ID}.json`),
    metaFile: path.join(root, "Claude-3p", "configLibrary", "_meta.json"),
  };
  await writeJson(paths.normalConfigFile, { keepMe: true, deploymentMode: "1p" });
  await writeJson(paths.metaFile, { entries: [{ id: "other", name: "Other" }], appliedId: "other" });

  await configureClaudeDesktopAtPaths(paths, "http://127.0.0.1:8082/", config);
  await configureClaudeDesktopAtPaths(paths, "http://127.0.0.1:8082/", config);

  const normal = JSON.parse(await readFile(paths.normalConfigFile, "utf8"));
  const threep = JSON.parse(await readFile(paths.threepConfigFile, "utf8"));
  const profile = JSON.parse(await readFile(paths.profileFile, "utf8"));
  const meta = JSON.parse(await readFile(paths.metaFile, "utf8"));

  assert.equal(normal.keepMe, true);
  assert.equal(normal.deploymentMode, "3p");
  assert.equal(threep.deploymentMode, "3p");
  assert.equal(profile.inferenceProvider, "gateway");
  assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:8082");
  assert.equal(profile.inferenceGatewayAuthScheme, "bearer");
  assert.deepEqual(profile.inferenceModels.map((model: any) => model.name), MODEL_SLOTS.map((slot) => claudeCodeModelAlias(config, slot)));
  assert.equal(profile.inferenceModels.some((model: any) => model.supports1m === true), true);
  assert.equal(profile.inferenceModels.find((model: any) => model.name === claudeCodeModelAlias(config, "default"))?.supports1m, true);
  assert.equal(meta.appliedId, CLAUDE_DESKTOP_PROFILE_ID);
  assert.equal(meta.entries.filter((entry: any) => entry.id === CLAUDE_DESKTOP_PROFILE_ID).length, 1);
  assert.equal(meta.entries.some((entry: any) => entry.id === "other"), true);
});

test("bare-PC installer only requires the cleaned runtime dependency and never revives Git or VS Code CLI automation", async () => {
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");

  assert.match(install, /MinimumNodeVersion = \[Version\]"20\.0\.0"/);
  assert.match(install, /OpenJS\.NodeJS\.LTS/);
  assert.match(install, /Test-ClaudeCodeInstalled/);
  assert.match(install, /Test-ClaudeDesktopInstalled/);
  assert.match(install, /dist\\scripts\\configure-clients\.js/);
  assert.match(install, /Claude Code is not installed; gateway settings were prepared/);
  assert.match(install, /Existing Claude Desktop integration refreshed/);
  assert.doesNotMatch(install, /Git\.Git/);
  assert.doesNotMatch(install, /git\s+(clone|fetch|reset|clean)/i);
  assert.doesNotMatch(install, /Microsoft\.VisualStudioCode/);
  assert.doesNotMatch(install, /--install-extension|--list-extensions/);
  assert.doesNotMatch(install, /Get-Command code(?:\.cmd)?/);
  assert.doesNotMatch(install, /typescript-language-server|context-mode@|rtk-x86_64/);

  assert.match(setup, /compatibility entrypoint/);
  assert.match(setup, /does not require Git/);
  assert.match(setup, /-ManifestUrl/);
  assert.doesNotMatch(setup, /git\s+(clone|pull|fetch|reset|clean)/i);
});

test("shared Claude settings retain gateway-aware aliases, route capability behavior, and onboarding repair", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "claude-config.ts"), "utf8");
  const clients = await readFile(path.join(process.cwd(), "scripts", "configure-clients.ts"), "utf8");
  assert.match(source, /claudeCodeModelAlias\(config, "fable", providers\)/);
  assert.match(source, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);
  assert.match(source, /CLAUDE_CODE_USE_GATEWAY/);
  assert.match(source, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  assert.match(source, /hasCompletedOnboarding = true/);
  assert.match(source, /hasSeenOnboarding = true/);
  assert.doesNotMatch(source, /DISABLE_COMPACT\s*[=:]/);

  assert.match(clients, /const config = models\.snapshot\(\)/);
  assert.doesNotMatch(clients, /models\.update\(/);
  assert.doesNotMatch(clients, /OPENAI_CC_CONTEXT_WINDOW/);
});

test("gateway launcher binds persistent data to managed root and refuses an unrelated 8082 listener", async () => {
  const index = await readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");
  const launcher = await readFile(path.join(process.cwd(), "run-gateway.ps1"), "utf8");
  const clients = await readFile(path.join(process.cwd(), "scripts", "configure-clients.ts"), "utf8");
  assert.match(index, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0"/);
  assert.match(clients, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0"/);
  assert.match(launcher, /OPENAI_CC_HOME/);
  assert.match(launcher, /OPENAI_CC_RUNTIME_ROOT/);
  assert.match(launcher, /DATA_DIR/);
  assert.match(launcher, /dist\\src\\index\.js/);
  assert.match(launcher, /Port 8082 is already occupied/);
});

async function writeJson(file: string, value: unknown): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
