import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_DESKTOP_MODEL_ALIASES,
  CLAUDE_DESKTOP_PROFILE_ID,
  ClaudeDesktopPaths,
  claudeDesktopModel,
  claudeDesktopModelList,
  configureClaudeDesktopAtPaths,
} from "../src/claude-desktop.js";
import { ModelConfig } from "../src/model-config.js";

const config: ModelConfig = {
  contextWindow: 700000,
  routes: {
    default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 96000 },
    sonnet: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: 64000 },
    haiku: { provider: "nvidia", model: "test-haiku-upstream", maxOutputTokens: 32000 },
  },
};

test("Claude model discovery exposes only safe public aliases and configured limits", () => {
  const response = claudeDesktopModelList(config);
  assert.deepEqual(response.data.map((model) => model.id), [
    CLAUDE_DESKTOP_MODEL_ALIASES.fable,
    CLAUDE_DESKTOP_MODEL_ALIASES.opus,
    CLAUDE_DESKTOP_MODEL_ALIASES.sonnet,
    CLAUDE_DESKTOP_MODEL_ALIASES.haiku,
  ]);
  assert.equal(response.data.some((model) => model.id.includes("gemini") || model.id.includes("deepseek") || model.id.includes("gpt")), false);
  assert.equal(response.data[0].max_input_tokens, 700000);
  assert.equal(response.data.find((model) => model.id === CLAUDE_DESKTOP_MODEL_ALIASES.opus)?.max_tokens, 96000);
  assert.equal((response.data.find((model) => model.id === CLAUDE_DESKTOP_MODEL_ALIASES.sonnet)?.capabilities.image_input as any).supported, true);
  assert.equal((response.data.find((model) => model.id === CLAUDE_DESKTOP_MODEL_ALIASES.haiku)?.capabilities.image_input as any).supported, false);
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
  assert.deepEqual(profile.inferenceModels.map((model: any) => model.name), Object.values(CLAUDE_DESKTOP_MODEL_ALIASES));
  assert.equal(profile.inferenceModels.some((model: any) => model.supports1m === true), false);
  assert.equal(meta.appliedId, CLAUDE_DESKTOP_PROFILE_ID);
  assert.equal(meta.entries.filter((entry: any) => entry.id === CLAUDE_DESKTOP_PROFILE_ID).length, 1);
  assert.equal(meta.entries.some((entry: any) => entry.id === "other"), true);
});

async function writeJson(file: string, value: unknown): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("PowerShell setup installs Claude Desktop only when missing and configures the local gateway", async () => {
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");
  assert.match(setup, /Test-ClaudeDesktopInstalled/);
  assert.match(setup, /winget install --id Anthropic\.Claude --exact/);
  assert.doesNotMatch(setup, /winget\s+upgrade/i);
  assert.match(setup, /dist\/scripts\/configure-claude-desktop\.js/);
  assert.match(setup, /http:\/\/127\.0\.0\.1:8082\/healthz/);
  assert.doesNotMatch(setup, /API[_ -]?KEY\s*=|ANTHROPIC_AUTH_TOKEN\s*=/i);
});
