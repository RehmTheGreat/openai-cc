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
  const oldContextValues = new Set(["700000", ...routeContextWindows.map(String)]);
  if (oldContextValues.has(String(env.CLAUDE_CODE_CONTEXT_WINDOW ?? ""))) delete env.CLAUDE_CODE_CONTEXT_WINDOW;
  if (oldContextValues.has(String(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? ""))) delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;

  // OpenAI-CC supplies the four named aliases itself. Gateway discovery would
  // add another discovered copy of the same logical routes to /model. Default
  // remains available automatically in Claude Code.
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  settings.availableModels = ["fable", "opus", "sonnet", "haiku"];

  // PR #35 briefly used modelOverrides for Fable/Sonnet. Claude Code 2.1.226
  // then budgeted those aliases at the third-party 200K fallback. Direct family
  // pins are required for the long-context carrier behavior. Remove only the
  // obsolete OpenAI-CC-owned overrides and preserve unrelated user overrides.
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
    // Use the same Claude-facing route IDs advertised by /v1/models. The model
    // config chooses a [1m] carrier only where the route needs one, and Claude
    // strips that client-only suffix before dispatch when applicable.
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
    // Claude Code exposes one process-level auto-compact ceiling. Keep it at
    // the largest route window; each route remains independently authoritative
    // in Admin, /v1/models metadata, and gateway request enforcement.
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
