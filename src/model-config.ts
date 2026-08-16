import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountRecord, AccountStore, ProviderKind, PublicCredential } from "./account-store.js";
import { OpenAICCError, unprocessable } from "./errors.js";
import {
  ModelCapabilities,
  ProviderRegistry,
  modelCapabilities,
} from "./provider-registry.js";

export type ModelSlot = "default" | "fable" | "opus" | "sonnet" | "haiku";

export interface ModelRoute {
  provider: ProviderKind;
  model: string;
  credentialId?: string;
  maxOutputTokens: number;
  /**
   * Deprecated write-compatibility only. New state never persists or returns
   * this field; Admin uses ModelConfig.contextWindow exclusively.
   */
  contextWindow?: number;
  /** Optional capability overrides. Undefined means use provider defaults/discovery. */
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

export interface ModelConfig {
  /** Single authoritative Claude/gateway context window configured by the user. */
  contextWindow: number;
  routes: Record<ModelSlot, ModelRoute>;
}

export type ModelConfigUpdate = {
  contextWindow?: unknown;
  routes?: Partial<Record<ModelSlot, Partial<ModelRoute>>>;
};

export interface RouteHealth {
  slot: ModelSlot;
  provider: ProviderKind;
  model: string;
  contextWindow: number;
  mode: "auto" | "pinned";
  credentialId?: string;
  readyCredentialIds: string[];
  readyCredentials: number;
  status: "healthy" | "degraded" | "unavailable";
  message: string;
}

export const DEFAULT_MAX_OUTPUT_TOKENS: Record<ModelSlot, number> = {
  default: 128000,
  fable: 128000,
  opus: 128000,
  sonnet: 65536,
  haiku: 65536,
};

export const DEFAULT_CONTEXT_WINDOW = 1_050_000;
export const GEMINI_FLASH_LITE_MODEL = "gemini-3.5-flash-lite";

/** Public Claude-facing ids are exactly the five logical OpenAI-CC routes. */
const CLAUDE_ROUTE_IDS: Record<ModelSlot, string> = {
  default: "default",
  fable: "fable",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
};

const DEFAULT_ROUTES: Record<ModelSlot, ModelRoute> = {
  default: { provider: "chatgpt", model: "gpt-5.6-luna", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.default },
  fable: { provider: "chatgpt", model: "gpt-5.6-luna", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.fable },
  opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.opus },
  sonnet: { provider: "google", model: GEMINI_FLASH_LITE_MODEL, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.sonnet },
  haiku: { provider: "google", model: GEMINI_FLASH_LITE_MODEL, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.haiku },
};

const DEFAULTS: ModelConfig = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  routes: DEFAULT_ROUTES,
};

type StoredRoute = Partial<ModelRoute> & { contextWindow?: unknown };
type StoredModelConfig = {
  contextWindow?: unknown;
  routes?: Partial<Record<ModelSlot, StoredRoute>>;
};

export class ModelConfigStore extends EventEmitter {
  private readonly file: string;
  private state: ModelConfig = structuredClone(DEFAULTS);

  constructor(dataDir: string, private readonly accounts: AccountStore, private readonly providers?: ProviderRegistry) {
    super();
    this.file = path.join(path.resolve(dataDir), "model-config.json");
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as StoredModelConfig;
      const normalized = normalizeForLoad(raw, this.providers);
      this.state = normalized.config;
      let repaired = normalized.changed;
      for (const slot of MODEL_SLOTS) {
        const route = this.state.routes[slot];
        if (!route.credentialId) continue;
        const credential = this.accounts.get(route.credentialId);
        if (!credential || credential.provider !== route.provider) {
          delete route.credentialId;
          repaired = true;
        }
      }
      if (repaired) await this.persist();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  snapshot(): ModelConfig {
    return structuredClone(this.state);
  }

  async update(input: ModelConfigUpdate): Promise<ModelConfig> {
    const candidateRoutes = Object.fromEntries(MODEL_SLOTS.map((slot) => {
      const previous = this.state.routes[slot];
      const patch = input.routes?.[slot] ?? {};
      const { contextWindow: _legacyContext, ...cleanPatch } = patch;
      return [slot, { ...previous, ...cleanPatch } as ModelRoute];
    })) as Record<ModelSlot, ModelRoute>;
    const legacyRouteContexts = MODEL_SLOTS
      .map((slot) => positiveSafeInteger(input.routes?.[slot]?.contextWindow))
      .filter((value): value is number => value !== undefined);
    const explicitContext = positiveSafeInteger(input.contextWindow);
    const useLegacyContext = legacyRouteContexts.length > 0
      && (input.contextWindow === undefined || explicitContext === this.state.contextWindow);
    const candidate = normalizeStrict({
      contextWindow: useLegacyContext
        ? Math.max(...legacyRouteContexts)
        : (input.contextWindow ?? this.state.contextWindow),
      routes: candidateRoutes,
    }, this.providers);
    this.validatePins(candidate);
    this.state = candidate;
    await this.persist();
    this.emit("event", { type: "model_config_changed" });
    return this.snapshot();
  }

  slotForRequestedModel(model: string): ModelSlot {
    const id = String(model || "").trim().toLowerCase();
    const explicit = slotForClaudeCodeModel(this.state, id, this.providers);
    if (explicit) return explicit;
    // Old carrier IDs are accepted only so already-open sessions survive upgrade.
    if (id === "claude-opus-4-8" || id === "claude-opus-4-8[1m]" || id === "claude-sonnet-5") return "default";
    if (id === "fable" || id.includes("fable")) return "fable";
    if (id === "opus" || id.includes("opus")) return "opus";
    if (id === "sonnet" || id.includes("sonnet")) return "sonnet";
    if (id === "haiku" || id.includes("haiku")) return "haiku";
    return "default";
  }

  routeForRequestedModel(model: string): ModelRoute {
    return { ...this.state.routes[this.slotForRequestedModel(model)] };
  }

  contextWindowForRequestedModel(_model: string): number {
    return this.state.contextWindow;
  }

  credentialForRequestedModel(model: string, attempted = new Set<string>()): AccountRecord | undefined {
    const route = this.routeForRequestedModel(model);
    if (route.credentialId) {
      if (attempted.has(route.credentialId)) return undefined;
      const pinned = this.accounts.get(route.credentialId);
      return pinned?.provider === route.provider && pinned.status === "ready" ? pinned : undefined;
    }
    return this.accounts.orderedReady(route.provider, attempted)[0];
  }

  async markRateLimitedAndNext(model: string, account: AccountRecord, message: string, cooldownMs?: number, attempted = new Set<string>()): Promise<AccountRecord | undefined> {
    await this.accounts.markRateLimited(account.id, message, cooldownMs);
    const route = this.routeForRequestedModel(model);
    if (route.credentialId) return undefined;
    return this.credentialForRequestedModel(model, attempted);
  }

  async markAuthErrorAndNext(model: string, account: AccountRecord, message: string, attempted = new Set<string>()): Promise<AccountRecord | undefined> {
    await this.accounts.markAuthError(account.id, message);
    const route = this.routeForRequestedModel(model);
    if (route.credentialId) return undefined;
    return this.credentialForRequestedModel(model, attempted);
  }

  pinnedSlotsForCredential(id: string): ModelSlot[] {
    return MODEL_SLOTS.filter((slot) => this.state.routes[slot].credentialId === id);
  }

  slotsForProvider(provider: string): ModelSlot[] {
    return MODEL_SLOTS.filter((slot) => this.state.routes[slot].provider === provider);
  }

  health(): Record<ModelSlot, RouteHealth> {
    return Object.fromEntries(MODEL_SLOTS.map((slot) => [slot, this.healthFor(slot)])) as Record<ModelSlot, RouteHealth>;
  }

  healthFor(slot: ModelSlot): RouteHealth {
    const route = this.state.routes[slot];
    const contextWindow = this.state.contextWindow;
    const sameProvider = this.accounts.list().filter((credential) => credential.provider === route.provider);
    const ready = sameProvider.filter((credential) => credential.status === "ready");
    if (route.credentialId) {
      const pinned = sameProvider.find((credential) => credential.id === route.credentialId);
      if (!pinned) return baseHealth(slot, route, ready, contextWindow, "unavailable", "Pinned credential is missing or belongs to another provider.");
      if (pinned.status !== "ready") {
        const reset = pinned.limitResetsAt ? ` until ${pinned.limitResetsAt}` : "";
        return baseHealth(slot, route, ready, contextWindow, "unavailable", `Pinned credential is ${pinned.status}${reset}.`);
      }
      return baseHealth(slot, route, ready, contextWindow, "healthy", `Pinned to ${pinned.name}.`);
    }
    if (!ready.length) return baseHealth(slot, route, ready, contextWindow, "unavailable", `No ready ${route.provider} credential is available.`);
    const preferred = this.accounts.preferredId(route.provider);
    const preferredReady = preferred && ready.some((credential) => credential.id === preferred);
    const status = preferred && !preferredReady ? "degraded" : "healthy";
    const message = preferred && !preferredReady
      ? `Preferred credential is unavailable; ${ready.length} fallback credential${ready.length === 1 ? "" : "s"} ready.`
      : `${ready.length} ready credential${ready.length === 1 ? "" : "s"}; preferred first, then provider-local rotation.`;
    return baseHealth(slot, route, ready, contextWindow, status, message);
  }

  credentialsForProvider(provider: ProviderKind): PublicCredential[] {
    return this.accounts.list().filter((credential) => credential.provider === provider);
  }

  private validatePins(config: ModelConfig): void {
    for (const slot of MODEL_SLOTS) {
      const route = config.routes[slot];
      if (!route.credentialId) continue;
      const credential = this.accounts.get(route.credentialId);
      if (!credential) throw unprocessable(`Credential ${route.credentialId} does not exist.`, "credential_pin_not_found", { slot, credentialId: route.credentialId });
      if (credential.provider !== route.provider) {
        throw unprocessable(
          `Credential ${route.credentialId} uses ${credential.provider}, but ${slot} is configured for ${route.provider}.`,
          "credential_provider_mismatch",
          { slot, credentialId: route.credentialId, routeProvider: route.provider, credentialProvider: credential.provider },
        );
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ contextWindow: this.state.contextWindow, routes: this.state.routes }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export const MODEL_SLOTS: ModelSlot[] = ["default", "fable", "opus", "sonnet", "haiku"];

export function contextWindowForRoute(config: ModelConfig, _slot: ModelSlot, _providers?: ProviderRegistry): number {
  return config.contextWindow;
}

export function capabilitiesForRoute(route: ModelRoute, providers?: ProviderRegistry): ModelCapabilities {
  const detected = modelCapabilities(route.provider, route.model, providers);
  return {
    ...detected,
    image: route.vision ?? detected.image,
    tools: route.tools ?? detected.tools,
    reasoning: route.reasoning ?? detected.reasoning,
  };
}

export function claudeCodeModelAlias(_config: ModelConfig, slot: ModelSlot, _providers?: ProviderRegistry): string {
  return CLAUDE_ROUTE_IDS[slot];
}

export function claudeCodeTransportAlias(config: ModelConfig, slot: ModelSlot, providers?: ProviderRegistry): string {
  return claudeCodeModelAlias(config, slot, providers);
}

export function slotForClaudeCodeModel(_config: ModelConfig, model: string, _providers?: ProviderRegistry): ModelSlot | undefined {
  const id = String(model || "").trim().toLowerCase();
  return MODEL_SLOTS.find((slot) => CLAUDE_ROUTE_IDS[slot] === id);
}

function normalizeStrict(input: { contextWindow?: unknown; routes?: Partial<Record<ModelSlot, Partial<ModelRoute>>> }, providers?: ProviderRegistry): ModelConfig {
  const contextWindow = requirePositiveSafeInteger(input.contextWindow, "contextWindow");
  const routes = {} as Record<ModelSlot, ModelRoute>;
  for (const slot of MODEL_SLOTS) {
    const candidate = input.routes?.[slot];
    if (!candidate) throw new OpenAICCError(`Missing model route: ${slot}.`, 400, "missing_route");
    if (!isProvider(candidate.provider, providers)) throw new OpenAICCError(`Unsupported provider for ${slot}.`, 400, "invalid_provider", { slot });
    const model = String(candidate.model ?? "").trim();
    if (!model) throw new OpenAICCError(`Model id is required for ${slot}.`, 400, "model_required", { slot });
    if (model.length > 256) throw new OpenAICCError(`Model id is too long for ${slot}.`, 400, "model_too_long", { slot });
    const maxOutputTokens = requirePositiveSafeInteger(candidate.maxOutputTokens, `${slot}.maxOutputTokens`);
    const vision = optionalBoolean(candidate.vision, `${slot}.vision`);
    const tools = optionalBoolean(candidate.tools, `${slot}.tools`);
    const reasoning = optionalBoolean(candidate.reasoning, `${slot}.reasoning`);
    const credentialId = String(candidate.credentialId ?? "").trim() || undefined;
    routes[slot] = {
      provider: candidate.provider,
      model,
      credentialId,
      maxOutputTokens,
      ...(vision !== undefined ? { vision } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }
  return { contextWindow, routes };
}

function normalizeForLoad(input: StoredModelConfig, providers?: ProviderRegistry): { config: ModelConfig; changed: boolean } {
  const topLevelContext = positiveSafeInteger(input.contextWindow);
  const oldRouteContexts = MODEL_SLOTS
    .map((slot) => positiveSafeInteger(input.routes?.[slot]?.contextWindow))
    .filter((value): value is number => value !== undefined);
  // Older builds persisted context per route. When collapsing to one setting,
  // preserve the largest user-selected window rather than silently reducing it.
  const contextWindow = topLevelContext ?? (oldRouteContexts.length ? Math.max(...oldRouteContexts) : DEFAULT_CONTEXT_WINDOW);
  const routes = {} as Record<ModelSlot, ModelRoute>;
  let changed = topLevelContext === undefined || oldRouteContexts.length > 0;

  for (const slot of MODEL_SLOTS) {
    const fallback = DEFAULT_ROUTES[slot];
    const original = input.routes?.[slot];
    const candidate = original ?? fallback;
    const provider = isProvider(candidate.provider, providers) ? candidate.provider : fallback.provider;
    if (original && provider !== candidate.provider) changed = true;
    const model = String(candidate.model ?? fallback.model).trim() || fallback.model;
    const parsedMax = positiveSafeInteger(candidate.maxOutputTokens);
    const maxOutputTokens = parsedMax ?? DEFAULT_MAX_OUTPUT_TOKENS[slot];
    if (candidate.maxOutputTokens !== undefined && parsedMax === undefined) changed = true;
    const vision = validOptionalBoolean(candidate.vision);
    const tools = validOptionalBoolean(candidate.tools);
    const reasoning = validOptionalBoolean(candidate.reasoning);
    if (candidate.vision !== undefined && vision === undefined) changed = true;
    if (candidate.tools !== undefined && tools === undefined) changed = true;
    if (candidate.reasoning !== undefined && reasoning === undefined) changed = true;
    const credentialId = String(candidate.credentialId ?? "").trim() || undefined;
    routes[slot] = {
      provider,
      model,
      credentialId,
      maxOutputTokens,
      ...(vision !== undefined ? { vision } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }
  return { config: { contextWindow, routes }, changed };
}

function positiveSafeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  const number = positiveSafeInteger(value);
  if (number === undefined) {
    throw new OpenAICCError(`${name} must be a positive safe integer.`, 400, "invalid_number", { field: name, min: 1 });
  }
  return number;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "boolean") throw new OpenAICCError(`${name} must be true, false, or unset.`, 400, "invalid_boolean", { field: name });
  return value;
}

function validOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isProvider(value: unknown, providers?: ProviderRegistry): value is ProviderKind {
  if (value === "chatgpt" || value === "zen" || value === "nvidia" || value === "google" || value === "cloudflare") return true;
  return typeof value === "string" && Boolean(providers?.has(value));
}

function baseHealth(slot: ModelSlot, route: ModelRoute, ready: PublicCredential[], contextWindow: number, status: RouteHealth["status"], message: string): RouteHealth {
  return {
    slot,
    provider: route.provider,
    model: route.model,
    contextWindow,
    mode: route.credentialId ? "pinned" : "auto",
    credentialId: route.credentialId,
    readyCredentialIds: ready.map((credential) => credential.id),
    readyCredentials: ready.length,
    status,
    message,
  };
}
