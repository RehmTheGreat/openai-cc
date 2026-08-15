import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MODEL_SLOTS,
  ModelConfig,
  ModelRoute,
  ModelSlot,
  capabilitiesForRoute,
  claudeCodeModelAlias,
  contextWindowForRoute,
} from "./model-config.js";
import { ProviderRegistry } from "./provider-registry.js";

export type ClaudeDesktopSlot = ModelSlot;

export const CLAUDE_DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-000000008082";
export const CLAUDE_DESKTOP_PROFILE_NAME = "OpenAI-CC";

const DESKTOP_SLOTS: ClaudeDesktopSlot[] = [...MODEL_SLOTS];
const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00Z";

export interface ClaudeDesktopPaths {
  normalConfigFile: string;
  threepConfigFile: string;
  profileFile: string;
  metaFile: string;
}

export interface ClaudeDesktopConfigureResult {
  supported: boolean;
  configured: boolean;
  profileFile?: string;
  metaFile?: string;
}

export interface ClaudeModelInfo {
  id: string;
  type: "model";
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  capabilities: Record<string, unknown>;
}

export function claudeDesktopModels(config: ModelConfig, providers?: ProviderRegistry): ClaudeModelInfo[] {
  return DESKTOP_SLOTS.map((slot) => modelInfo(slot, config, providers));
}

export function claudeDesktopModel(config: ModelConfig, modelId: string, providers?: ProviderRegistry): ClaudeModelInfo | undefined {
  const normalized = decodeURIComponent(String(modelId || "")).trim().toLowerCase();
  const exact = claudeDesktopModels(config, providers).find((model) => model.id.toLowerCase() === normalized);
  if (exact) return exact;

  // openai-cc-* ids are private Claude Code transport carriers. They must never
  // become public model-discovery aliases or additional picker rows.
  if (normalized.startsWith("openai-cc-")) return undefined;
  const slot = desktopSlotForModel(normalized);
  return slot ? modelInfo(slot, config, providers) : undefined;
}

export function claudeDesktopModelList(
  config: ModelConfig,
  query: { afterId?: string; beforeId?: string; limit?: number } = {},
  providers?: ProviderRegistry,
): { data: ClaudeModelInfo[]; first_id: string | null; last_id: string | null; has_more: boolean } {
  const all = claudeDesktopModels(config, providers);
  let start = 0;
  let end = all.length;

  if (query.afterId) {
    const index = all.findIndex((model) => model.id === query.afterId);
    if (index >= 0) start = index + 1;
  }
  if (query.beforeId) {
    const index = all.findIndex((model) => model.id === query.beforeId);
    if (index >= 0) end = index;
  }

  const available = all.slice(start, end);
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(query.limit ?? 20) || 20)));
  const data = available.slice(0, limit);
  return {
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: available.length > data.length,
  };
}

export function claudeDesktopProfile(baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Record<string, unknown> {
  const inferenceModels = DESKTOP_SLOTS.map((slot) => {
    const info = modelInfo(slot, config, providers);
    return {
      name: info.id,
      labelOverride: info.display_name,
      ...(info.max_input_tokens > 200000 ? { supports1m: true } : {}),
    };
  });

  return {
    disableDeploymentModeChooser: true,
    inferenceGatewayApiKey: "local-not-used",
    inferenceGatewayAuthScheme: "bearer",
    inferenceGatewayBaseUrl: normalizeBaseUrl(baseUrl),
    inferenceProvider: "gateway",
    inferenceModels,
  };
}

export async function configureClaudeDesktop(baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Promise<ClaudeDesktopConfigureResult> {
  const paths = await currentPlatformPaths();
  if (!paths) return { supported: false, configured: false };
  await configureClaudeDesktopAtPaths(paths, baseUrl, config, providers);
  return { supported: true, configured: true, profileFile: paths.profileFile, metaFile: paths.metaFile };
}

export async function configureClaudeDesktopAtPaths(paths: ClaudeDesktopPaths, baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Promise<void> {
  const normal = await readJson(paths.normalConfigFile);
  normal.deploymentMode = "3p";
  await writeJson(paths.normalConfigFile, normal);

  const threep = await readJson(paths.threepConfigFile);
  threep.deploymentMode = "3p";
  await writeJson(paths.threepConfigFile, threep);

  await writeJson(paths.profileFile, claudeDesktopProfile(baseUrl, config, providers));

  const meta = await readJson(paths.metaFile);
  const entries = Array.isArray(meta.entries) ? meta.entries.filter((entry: any) => entry?.id !== CLAUDE_DESKTOP_PROFILE_ID) : [];
  entries.push({ id: CLAUDE_DESKTOP_PROFILE_ID, name: CLAUDE_DESKTOP_PROFILE_NAME });
  meta.entries = entries;
  meta.appliedId = CLAUDE_DESKTOP_PROFILE_ID;
  await writeJson(paths.metaFile, meta);
}

export async function currentPlatformPaths(): Promise<ClaudeDesktopPaths | undefined> {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const normalDir = await pickWindowsClaudeDir(localAppData, false) ?? path.join(localAppData, "Claude");
    const threepDir = await pickWindowsClaudeDir(localAppData, true) ?? path.join(localAppData, "Claude-3p");
    return pathsFromDirs(normalDir, threepDir);
  }
  if (process.platform === "darwin") {
    const appSupport = path.join(os.homedir(), "Library", "Application Support");
    return pathsFromDirs(path.join(appSupport, "Claude"), path.join(appSupport, "Claude-3p"));
  }
  return undefined;
}

function modelInfo(slot: ClaudeDesktopSlot, config: ModelConfig, providers?: ProviderRegistry): ClaudeModelInfo {
  const route = config.routes[slot];
  return {
    id: claudeCodeModelAlias(config, slot, providers),
    type: "model",
    // Technical provider/model details stay in Admin discovery. Claude's model
    // picker only gets the user-facing routing alias.
    display_name: title(slot),
    created_at: UNKNOWN_CREATED_AT,
    max_input_tokens: contextWindowForRoute(config, slot, providers),
    max_tokens: route.maxOutputTokens,
    capabilities: routeCapabilities(route, providers),
  };
}

function desktopSlotForModel(model: string): ClaudeDesktopSlot | undefined {
  if (model.includes("fable")) return "fable";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return undefined;
}

function routeCapabilities(route: ModelRoute, providers?: ProviderRegistry): Record<string, unknown> {
  const capabilities = capabilitiesForRoute(route, providers);
  const unsupported = { supported: false };
  return {
    batch: unsupported,
    citations: unsupported,
    code_execution: unsupported,
    context_management: {
      supported: false,
      clear_thinking_20251015: unsupported,
      clear_tool_uses_20250919: unsupported,
      compact_20260112: unsupported,
    },
    effort: {
      supported: false,
      low: unsupported,
      medium: unsupported,
      high: unsupported,
      xhigh: unsupported,
      max: unsupported,
    },
    image_input: { supported: capabilities.image },
    pdf_input: unsupported,
    structured_outputs: unsupported,
    thinking: {
      supported: capabilities.reasoning,
      types: {
        adaptive: unsupported,
        enabled: { supported: capabilities.reasoning },
      },
    },
  };
}

function pathsFromDirs(normalDir: string, threepDir: string): ClaudeDesktopPaths {
  const configLibrary = path.join(threepDir, "configLibrary");
  return {
    normalConfigFile: path.join(normalDir, "claude_desktop_config.json"),
    threepConfigFile: path.join(threepDir, "claude_desktop_config.json"),
    profileFile: path.join(configLibrary, `${CLAUDE_DESKTOP_PROFILE_ID}.json`),
    metaFile: path.join(configLibrary, "_meta.json"),
  };
}

async function pickWindowsClaudeDir(localAppData: string, threep: boolean): Promise<string | undefined> {
  const exact = path.join(localAppData, threep ? "Claude-3p" : "Claude");
  try {
    const entries = await readdir(localAppData, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("Claude") && entry.name.includes("-3p") === threep)
      .map((entry) => path.join(localAppData, entry.name))
      .sort();
    return candidates.includes(exact) ? exact : candidates[0];
  } catch {
    return undefined;
  }
}

async function readJson(file: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizeBaseUrl(value: string): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
