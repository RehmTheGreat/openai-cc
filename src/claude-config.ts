import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelConfig } from "./model-config.js";

export interface ClaudeConfigureResult {
  settingsFile: string;
  stateFile: string;
}

export async function configureClaudeCode(baseUrl: string, config: ModelConfig): Promise<ClaudeConfigureResult> {
  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const stateFile = path.join(os.homedir(), ".claude.json");
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });

  const settings = await readJson(settingsFile);
  const env = isObject(settings.env) ? settings.env as Record<string, unknown> : {};
  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "local-not-used",
    ANTHROPIC_MODEL: "Default",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "Opus",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "Sonnet",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "Haiku",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "Fable",
    CLAUDE_CODE_CONTEXT_WINDOW: String(config.contextWindow),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(config.contextWindow),
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
    const value = JSON.parse(await readFile(file, "utf8"));
    return isObject(value) ? value as Record<string, any> : {};
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
