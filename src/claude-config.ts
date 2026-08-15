import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FALLBACK_CONTEXT_WINDOW,
  ModelConfig,
  claudeCodeModelAlias,
  contextWindowForRoute,
} from "./model-config.js";
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

  // The five logical routes are supplied by the standard family aliases plus
  // OpenAI-CC's transport mapping. Gateway discovery would add a second copy.
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;

  settings.availableModels = ["fable", "opus", "sonnet", "haiku"];

  const modelOverrides = isObject(settings.modelOverrides)
    ? { ...settings.modelOverrides as Record<string, unknown> }
    : {};

  const defaultExtended = contextWindowForRoute(config, "default", providers) > FALLBACK_CONTEXT_WINDOW;
  const fableExtended = contextWindowForRoute(config, "fable", providers) > FALLBACK_CONTEXT_WINDOW;
  const sonnetExtended = contextWindowForRoute(config, "sonnet", providers) > FALLBACK_CONTEXT_WINDOW;

  // A direct [1m] pin makes Claude Code render a second "Default 1M" or
  // "Fable 1M" picker row. For Default, Sonnet 5 is the one current gateway
  // carrier that Claude 2.1.x budgets natively at 1M without a suffix.
  const defaultModel = defaultExtended
    ? "claude-sonnet-5"
    : claudeCodeModelAlias(config, "default", providers);

  // For Fable/Sonnet, use Claude's version-level modelOverrides when the route
  // needs >200K. The picker remains on the ordinary family row while Claude
  // computes capability from the known Anthropic model and sends OpenAI-CC's
  // distinct transport id to the gateway. At <=200K, use the conservative
  // direct pin so the client window cannot exceed the route's verified cap.
  if (fableExtended) {
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL;
    modelOverrides["claude-fable-5"] = "openai-cc-fable";
  } else {
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = claudeCodeModelAlias(config, "fable", providers);
    delete modelOverrides["claude-fable-5"];
  }

  if (sonnetExtended) {
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    modelOverrides["claude-sonnet-5"] = "openai-cc-sonnet";
  } else {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = claudeCodeModelAlias(config, "sonnet", providers);
    delete modelOverrides["claude-sonnet-5"];
  }

  settings.modelOverrides = modelOverrides;
  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: normalizeBaseUrl(baseUrl),
    ANTHROPIC_AUTH_TOKEN: "local-not-used",
    ANTHROPIC_MODEL: defaultModel,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "Fable",
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeCodeModelAlias(config, "opus", providers),
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus",
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
