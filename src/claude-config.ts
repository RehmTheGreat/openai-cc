import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FALLBACK_CONTEXT_WINDOW,
  ModelConfig,
  claudeCodeTransportAlias,
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

  const oldContextValues = new Set(["700000", String(config.contextWindow)]);
  if (oldContextValues.has(String(env.CLAUDE_CODE_CONTEXT_WINDOW ?? ""))) delete env.CLAUDE_CODE_CONTEXT_WINDOW;
  if (oldContextValues.has(String(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? ""))) delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;

  // OpenAI-CC already supplies every logical route. Gateway discovery would add
  // another discovered copy to /model.
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;

  // Default is always present in Claude. Limit the named rows to the remaining
  // four OpenAI-CC routes. No direct [1m] pin is used for Default or Fable.
  settings.availableModels = ["fable", "opus", "sonnet", "haiku"];

  const modelOverrides = isObject(settings.modelOverrides)
    ? { ...settings.modelOverrides as Record<string, unknown> }
    : {};

  const fableExtended = contextWindowForRoute(config, "fable", providers) > FALLBACK_CONTEXT_WINDOW;
  const sonnetExtended = contextWindowForRoute(config, "sonnet", providers) > FALLBACK_CONTEXT_WINDOW;

  // Fable 5 and Sonnet 5 are known Claude picker models. Mapping them at the
  // version level preserves Claude's model capability/context accounting while
  // sending a distinct private id to OpenAI-CC. This avoids the duplicate
  // "Fable 1M" row produced by ANTHROPIC_DEFAULT_FABLE_MODEL=... [1m].
  if (fableExtended) {
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL;
    modelOverrides["claude-fable-5"] = claudeCodeTransportAlias(config, "fable", providers);
  } else {
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = claudeCodeTransportAlias(config, "fable", providers);
    delete modelOverrides["claude-fable-5"];
  }

  if (sonnetExtended) {
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    modelOverrides["claude-sonnet-5"] = claudeCodeTransportAlias(config, "sonnet", providers);
  } else {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = claudeCodeTransportAlias(config, "sonnet", providers);
    delete modelOverrides["claude-sonnet-5"];
  }

  settings.modelOverrides = modelOverrides;
  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: normalizeBaseUrl(baseUrl),
    ANTHROPIC_AUTH_TOKEN: "local-not-used",
    // Sonnet 5 is always 1M on gateway deployments and does not need a visible
    // [1m] suffix, so it is the clean long-context carrier for Default.
    ANTHROPIC_MODEL: claudeCodeTransportAlias(config, "default", providers),
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "Fable",
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeCodeTransportAlias(config, "opus", providers),
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus",
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeCodeTransportAlias(config, "haiku", providers),
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Haiku",
    CLAUDE_CODE_USE_GATEWAY: "1",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.contextWindow),
    CLAUDE_CODE_PLUGIN_PREFER_HTTPS: "1",
  };
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

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
