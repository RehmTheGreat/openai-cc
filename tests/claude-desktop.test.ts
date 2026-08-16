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
    default: { provider: "chatgpt", model: "provider-default", maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "provider-fable", maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "provider-opus", maxOutputTokens: 96000 },
    sonnet: { provider: "google", model: "provider-sonnet", maxOutputTokens: 64000 },
    haiku: { provider: "nvidia", model: "provider-haiku", maxOutputTokens: 32000 },
  },
};

test("Claude model discovery exposes exactly five logical route ids and the Admin context", () => {
  const response = claudeDesktopModelList(config);
  assert.deepEqual(response.data.map((model) => model.id), ["default", "fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(response.data.map((model) => model.display_name), ["Default", "Fable", "Opus", "Sonnet", "Haiku"]);
  for (const model of response.data) assert.equal(model.max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === "opus")?.max_tokens, 96000);
  assert.equal((response.data.find((model) => model.id === "sonnet")?.capabilities.image_input as any).supported, true);
  assert.equal((response.data.find((model) => model.id === "haiku")?.capabilities.image_input as any).supported, false);
  assert.equal(response.has_more, false);
  const publicJson = JSON.stringify(response.data);
  assert.doesNotMatch(publicJson, /provider-default|provider-opus|provider-sonnet|\[1m\]|openai-cc-/i);
});

test("route capability overrides change Claude-facing metadata without changing upstream model selection", () => {
  const overridden = structuredClone(config);
  overridden.routes.sonnet.vision = false;
  overridden.routes.sonnet.tools = false;
  overridden.routes.sonnet.reasoning = false;
  const sonnet = claudeDesktopModelList(overridden).data.find((model) => model.display_name === "Sonnet")!;
  assert.equal((sonnet.capabilities.image_input as any).supported, false);
  assert.equal((sonnet.capabilities.thinking as any).supported, false);
  assert.equal(overridden.routes.sonnet.model, "provider-sonnet");
});

test("model retrieval accepts only public logical route ids", () => {
  assert.equal(claudeDesktopModel(config, "opus")?.max_tokens, 96000);
  assert.equal(claudeDesktopModel(config, "sonnet")?.id, "sonnet");
  assert.equal(claudeDesktopModel(config, "provider-opus"), undefined);
  assert.equal(claudeDesktopModel(config, "openai-cc-sonnet"), undefined);
  assert.equal(claudeDesktopModel(config, "claude-opus-5[1m]"), undefined);
});

test("Claude Desktop 3P configuration is merged, idempotent, and creates no supports1m variants", async () => {
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
  assert.equal(profile.inferenceModels.some((model: any) => "supports1m" in model), false);
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

test("shared Claude settings retain gateway context, clean route names, and no duplicate carrier policy", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "claude-config.ts"), "utf8");
  const clients = await readFile(path.join(process.cwd(), "scripts", "configure-clients.ts"), "utf8");
  assert.match(source, /claudeCodeModelAlias\(config, "default", providers\)/);
  assert.match(source, /delete env\.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);
  assert.doesNotMatch(source, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:\s*"1"/);
  assert.match(source, /settings\.availableModels = \["fable", "opus", "sonnet", "haiku"\]/);
  assert.match(source, /ANTHROPIC_DEFAULT_FABLE_MODEL:\s*claudeCodeModelAlias\(config, "fable", providers\)/);
  assert.match(source, /ANTHROPIC_DEFAULT_OPUS_MODEL:\s*claudeCodeModelAlias\(config, "opus", providers\)/);
  assert.match(source, /ANTHROPIC_DEFAULT_SONNET_MODEL:\s*claudeCodeModelAlias\(config, "sonnet", providers\)/);
  assert.match(source, /ANTHROPIC_DEFAULT_HAIKU_MODEL:\s*claudeCodeModelAlias\(config, "haiku", providers\)/);
  assert.match(source, /delete modelOverrides\["claude-fable-5"\]/);
  assert.match(source, /delete modelOverrides\["claude-sonnet-5"\]/);
  assert.match(source, /CLAUDE_CODE_USE_GATEWAY/);
  assert.match(source, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  assert.match(source, /String\(maxContextWindow\)/);
  assert.doesNotMatch(source, /supports1m|\[1m\]/);
  assert.match(source, /hasCompletedOnboarding = true/);
  assert.match(source, /hasSeenOnboarding = true/);
  assert.doesNotMatch(source, /DISABLE_COMPACT\s*[=:]/);
  assert.doesNotMatch(source, /CLAUDE_CODE_DISABLE_1M_CONTEXT/);
  assert.match(clients, /const config = models\.snapshot\(\)/);
  assert.doesNotMatch(clients, /models\.update\(/);
  assert.doesNotMatch(clients, /OPENAI_CC_CONTEXT_WINDOW/);
});

test("gateway launcher refreshes Claude clients after model changes and refuses an unrelated 8082 listener", async () => {
  const index = await readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");
  const launcher = await readFile(path.join(process.cwd(), "run-gateway.ps1"), "utf8");
  const clients = await readFile(path.join(process.cwd(), "scripts", "configure-clients.ts"), "utf8");
  assert.match(index, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0"/);
  assert.match(index, /modelConfig\.on\("event"/);
  assert.match(index, /event\?\.type !== "model_config_changed"/);
  assert.match(index, /refreshClaudeClients\("refreshed"\)/);
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
