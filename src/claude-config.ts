import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelConfig, claudeCodeModelAlias } from "./model-config.js";
import { ProviderRegistry } from "./provider-registry.js";

export interface ClaudeConfigureResult {
  settingsFile: string;
  stateFile: string;
}

export async function configureClaudeCode(baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Promise<ClaudeConfigureResult> {
  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const stateFile = path.join(os.homedir(), ".claude.json");
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });

  const settings = await readJson(settingsFile);
  const env = isObject(settings.env) ? { ...settings.env as Record<string, unknown> } : {};

  // Remove OpenAI-CC's obsolete hard context overrides. MAX_CONTEXT only becomes
  // effective with DISABLE_COMPACT, which would defeat automatic compaction.
  const oldContextValues = new Set(["700000", String(config.contextWindow)]);
  if (oldContextValues.has(String(env.CLAUDE_CODE_CONTEXT_WINDOW ?? ""))) delete env.CLAUDE_CODE_CONTEXT_WINDOW;
  if (oldContextValues.has(String(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? ""))) delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;

  // The five logical routes are already supplied through ANTHROPIC_MODEL and the
  // per-family defaults below. Enabling gateway model discovery at the same time
  // makes Claude Code add a second discovered copy of those same five routes to
  // /model (for example Fable + Fable 1M). Clear the old flag on upgrades.
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;

  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: normalizeBaseUrl(baseUrl),
    ANTHROPIC_AUTH_TOKEN: "local-not-used",
    ANTHROPIC_MODEL: claudeCodeModelAlias(config, "default", providers),
    ANTHROPIC_DEFAULT_FABLE_MODEL: claudeCodeModelAlias(config, "fable", providers),
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "Fable",
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeCodeModelAlias(config, "opus", providers),
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus",
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeCodeModelAlias(config, "sonnet", providers),
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeCodeModelAlias(config, "haiku", providers),
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Haiku",
    // Claude Code 2.1.x otherwise resolves a plain ANTHROPIC_BASE_URL as
    // first-party-with-a-custom-host and hard-falls back to a 200K budget.
    CLAUDE_CODE_USE_GATEWAY: "1",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.contextWindow),
    CLAUDE_CODE_PLUGIN_PREFER_HTTPS: "1",
  };
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  // Claude Code occasionally re-enters onboarding when routed through a local gateway.
  // Preserve every unrelated state field and only mark the local onboarding as completed.
  const state = await readJson(stateFile);
  state.hasCompletedOnboarding = true;
  state.hasSeenOnboarding = true;
  state.numStartups = Math.max(1, Number(state.numStartups ?? 0));
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  return { settingsFile, stateFile };
}

async function readJson(file: string): Promise<Record<string, any>> {
  try {
    const text = await readFile(file, "utf8");
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    return isObject(value) ? value as Record<string, any> : {};
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function normalizeBaseUrl(value: string): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
