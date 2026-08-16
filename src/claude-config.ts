import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MODEL_SLOTS,
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

  const routeContextWindows = MODEL_SLOTS.map((slot) => contextWindowForRoute(config, slot, providers));
  const maxContextWindow = Math.max(...routeContextWindows);
  const oldContextValues = new Set(["700000", "850000", "1000000", ...routeContextWindows.map(String)]);
  if (oldContextValues.has(String(env.CLAUDE_CODE_CONTEXT_WINDOW ?? ""))) delete env.CLAUDE_CODE_CONTEXT_WINDOW;

  // Keep discovery constrained to OpenAI-CC's five logical routes. The gateway
  // catalog reports each route's Admin-configured context and never exposes
  // provider/carrier model IDs.
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  settings.availableModels = [...MODEL_SLOTS];

  // Remove obsolete OpenAI-CC carrier overrides left by older releases while
  // preserving any unrelated user-owned model overrides.
  const modelOverrides = isObject(settings.modelOverrides)
    ? { ...settings.modelOverrides as Record<string, unknown> }
    : {};
  if (modelOverrides["claude-fable-5"] === "openai-cc-fable") delete modelOverrides["claude-fable-5"];
  if (modelOverrides["claude-sonnet-5"] === "openai-cc-sonnet") delete modelOverrides["claude-sonnet-5"];
  if (Object.keys(modelOverrides).length) settings.modelOverrides = modelOverrides;
  else delete settings.modelOverrides;

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
    CLAUDE_CODE_USE_GATEWAY: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(maxContextWindow),
    // Anthropic documents MAX_CONTEXT_TOKENS as gated by DISABLE_COMPACT. Use
    // the explicit false value here: it is intentionally tested against the
    // real Claude client so we never trade correct context for lost compaction.
    DISABLE_COMPACT: "0",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(maxContextWindow),
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
