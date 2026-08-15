import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountRecord, AccountStore, ProviderKind, PublicCredential } from "./account-store.js";
import { OpenAICCError, unprocessable } from "./errors.js";
import {
  ModelCapabilities,
  ProviderRegistry,
  modelCapabilities,
  verifiedModelContextWindow,
  verifiedModelMaxOutputTokens,
} from "./provider-registry.js";

export type ModelSlot = "default" | "fable" | "opus" | "sonnet" | "haiku";

export interface ModelRoute {
  provider: ProviderKind;
  model: string;
  credentialId?: string;
  /** Authoritative Claude/gateway context window for this route. */
  contextWindow?: number;
  maxOutputTokens: number;
  /** Optional capability overrides. Undefined means use provider/model discovery metadata. */
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

export interface ModelConfig {
  /**
   * Derived compatibility ceiling only: the largest route context window.
   * It is not editable and is never persisted. Route contextWindow values are authoritative.
   */
  contextWindow: number;
  routes: Record<ModelSlot, ModelRoute>;
}

export type ModelConfigUpdate = {
  routes?: Partial<Record<ModelSlot, Partial<ModelRoute>>>;
  /** Deprecated compatibility input. New callers must set routes.<slot>.contextWindow. */
  contextWindow?: unknown;
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

/** Kept for migration/backward compatibility with the former global setting. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const FALLBACK_CONTEXT_WINDOW = 200000;
export const CLOUDFLARE_GEMMA_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const GEMINI_FLASH_LITE_MODEL = "gemini-3.5-flash-lite";

export const DEFAULT_CONTEXT_WINDOWS: Record<ModelSlot, number> = {
  default: 1_000_000,
  fable: 1_000_000,
  opus: 200_000,
  sonnet: 1_000_000,
  haiku: 1_000_000,
};

const CLAUDE_PUBLIC_STANDARD_MODEL_IDS: Record<ModelSlot, string> = {
  default: "claude-opus-4-8",
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

const CLAUDE_PUBLIC_EXTENDED_MODEL_IDS: Record<ModelSlot, string> = {
  default: "claude-opus-4-8[1m]",
  fable: "claude-fable-5[1m]",
  opus: "claude-opus-5[1m]",
  sonnet: "claude-sonnet-4-6[1m]",
  haiku: "claude-opus-4-7[1m]",
};

const CLAUDE_CODE_STANDARD_TRANSPORT_IDS: Record<ModelSlot, string> = {
  default: "claude-opus-4-8",
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

const CLAUDE_CODE_EXTENDED_TRANSPORT_IDS: Record<ModelSlot, string> = {
  default: "claude-sonnet-5",
  fable: "openai-cc-fable",
  opus: "claude-opus-5[1m]",
  sonnet: "openai-cc-sonnet",
  haiku: "claude-opus-4-7[1m]",
};

const DEFAULT_ROUTES: Record<ModelSlot, ModelRoute> = {
  default: { provider: "chatgpt", model: "gpt-5.6-luna", contextWindow: DEFAULT_CONTEXT_WINDOWS.default, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.default },
  fable: { provider: "chatgpt", model: "gpt-5.6-luna", contextWindow: DEFAULT_CONTEXT_WINDOWS.fable, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.fable },
  opus: { provider: "zen", model: "deepseek-v4-flash-free", contextWindow: DEFAULT_CONTEXT_WINDOWS.opus, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.opus },
  sonnet: { provider: "google", model: GEMINI_FLASH_LITE_MODEL, contextWindow: DEFAULT_CONTEXT_WINDOWS.sonnet, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.sonnet },
  haiku: { provider: "google", model: GEMINI_FLASH_LITE_MODEL, contextWindow: DEFAULT_CONTEXT_WINDOWS.haiku, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.haiku },
};

const DEFAULTS: ModelConfig = {
  contextWindow: Math.max(...Object.values(DEFAULT_CONTEXT_WINDOWS)),
  routes: DEFAULT_ROUTES,
};

type StoredModelConfig = {
  routes?: Partial<Record<ModelSlot, Partial<ModelRoute>>>;
  /** Legacy pre-route setting. It is migrated into every route and then removed. */
  contextWindow?: unknown;
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
    const candidateRoutes = Object.fromEntries(MODEL_SLOTS.map((slot) => [
      slot,
      { ...this.state.routes[slot], ...(input.routes?.[slot] ?? {}) },
    ])) as Record<ModelSlot, ModelRoute>;
    const candidate = normalizeStrict({ routes: candidateRoutes }, this.providers);
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
    if (id === "fable" || id.includes("fable")) return "fable";
    if (id === "opus" || id.includes("opus")) return "opus";
    if (id === "sonnet" || id.includes("sonnet")) return "sonnet";
    if (id === "haiku" || id.includes("haiku")) return "haiku";
    return "default";
  }

  routeForRequestedModel(model: string): ModelRoute {
    return { ...this.state.routes[this.slotForRequestedModel(model)] };
  }

  contextWindowForRequestedModel(model: string): number {
    return contextWindowForRoute(this.state, this.slotForRequestedModel(model), this.providers);
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
    const contextWindow = contextWindowForRoute(this.state, slot, this.providers);
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
    // Persist only the route-specific source of truth. The top-level ceiling is derived.
    await writeFile(tmp, `${JSON.stringify({ routes: this.state.routes }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export const MODEL_SLOTS: ModelSlot[] = ["default", "fable", "opus", "sonnet", "haiku"];

export function contextWindowForRoute(config: ModelConfig, slot: ModelSlot, providers?: ProviderRegistry): number {
  const route = config.routes[slot];
  const explicit = Number(route.contextWindow);
  if (Number.isFinite(explicit) && Number.isInteger(explicit) && explicit >= 1 && explicit <= 1_000_000) return explicit;
  // Compatibility only for old in-memory callers/tests that still construct a
  // config with the former top-level ceiling. Persisted configs are migrated.
  const legacy = Number(config.contextWindow);
  const target = Number.isFinite(legacy) && legacy >= 1 ? Math.min(1_000_000, Math.floor(legacy)) : DEFAULT_CONTEXT_WINDOWS[slot];
  return Math.min(target, verifiedUpstreamContextWindow(route, providers));
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

/** Public/desktop Claude-facing alias. Never contains a private OpenAI-CC transport id. */
export function claudeCodeModelAlias(config: ModelConfig, slot: ModelSlot, providers?: ProviderRegistry): string {
  return contextWindowForRoute(config, slot, providers) > FALLBACK_CONTEXT_WINDOW
    ? CLAUDE_PUBLIC_EXTENDED_MODEL_IDS[slot]
    : CLAUDE_PUBLIC_STANDARD_MODEL_IDS[slot];
}

/** Provider-side model id sent by Claude Code after picker/model capability resolution. */
export function claudeCodeTransportAlias(config: ModelConfig, slot: ModelSlot, providers?: ProviderRegistry): string {
  return contextWindowForRoute(config, slot, providers) > FALLBACK_CONTEXT_WINDOW
    ? CLAUDE_CODE_EXTENDED_TRANSPORT_IDS[slot]
    : CLAUDE_CODE_STANDARD_TRANSPORT_IDS[slot];
}

export function slotForClaudeCodeModel(config: ModelConfig, model: string, providers?: ProviderRegistry): ModelSlot | undefined {
  const id = String(model || "").trim().toLowerCase();
  for (const slot of MODEL_SLOTS) {
    const transport = claudeCodeTransportAlias(config, slot, providers).toLowerCase();
    const strippedTransport = transport.replace(/\[1m\]$/i, "");
    if (id === transport || id === strippedTransport) return slot;
  }
  for (const slot of MODEL_SLOTS) {
    const alias = claudeCodeModelAlias(config, slot, providers).toLowerCase();
    const stripped = alias.replace(/\[1m\]$/i, "");
    if (id === alias || id === stripped) return slot;
  }
  return undefined;
}

function verifiedUpstreamContextWindow(route: Pick<ModelRoute, "provider" | "model">, providers?: ProviderRegistry): number {
  return verifiedModelContextWindow(route.provider, route.model, providers) ?? FALLBACK_CONTEXT_WINDOW;
}

function normalizeStrict(input: { routes?: Partial<Record<ModelSlot, Partial<ModelRoute>>> }, providers?: ProviderRegistry): ModelConfig {
  const routes = {} as Record<ModelSlot, ModelRoute>;
  for (const slot of MODEL_SLOTS) {
    const candidate = input.routes?.[slot];
    if (!candidate) throw new OpenAICCError(`Missing model route: ${slot}.`, 400, "missing_route");
    if (!isProvider(candidate.provider, providers)) throw new OpenAICCError(`Unsupported provider for ${slot}.`, 400, "invalid_provider", { slot });
    const model = String(candidate.model ?? "").trim();
    if (!model) throw new OpenAICCError(`Model id is required for ${slot}.`, 400, "model_required", { slot });
    if (model.length > 256) throw new OpenAICCError(`Model id is too long for ${slot}.`, 400, "model_too_long", { slot });
    const contextWindow = finiteInteger(candidate.contextWindow, `${slot}.contextWindow`, 1, 1000000);
    const maxOutputTokens = finiteInteger(candidate.maxOutputTokens, `${slot}.maxOutputTokens`, 1, 1000000);
    const verifiedOutputCap = verifiedModelMaxOutputTokens(candidate.provider, model, providers);
    if (verifiedOutputCap !== undefined && maxOutputTokens > verifiedOutputCap) {
      throw new OpenAICCError(`${slot}.maxOutputTokens cannot exceed the verified ${verifiedOutputCap}-token safety cap for ${model}.`, 400, "max_output_exceeds_verified_cap", { slot, provider: candidate.provider, model, verifiedOutputCap });
    }
    const vision = optionalBoolean(candidate.vision, `${slot}.vision`);
    const tools = optionalBoolean(candidate.tools, `${slot}.tools`);
    const reasoning = optionalBoolean(candidate.reasoning, `${slot}.reasoning`);
    const credentialId = String(candidate.credentialId ?? "").trim() || undefined;
    routes[slot] = {
      provider: candidate.provider,
      model,
      credentialId,
      contextWindow,
      maxOutputTokens,
      ...(vision !== undefined ? { vision } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }
  return { contextWindow: maximumRouteContext(routes), routes };
}

function normalizeForLoad(input: StoredModelConfig, providers?: ProviderRegistry): { config: ModelConfig; changed: boolean } {
  const legacyRaw = Number(input.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
  const legacyContextWindow = Number.isFinite(legacyRaw)
    ? Math.max(1, Math.min(1000000, Math.floor(legacyRaw)))
    : DEFAULT_CONTEXT_WINDOW;
  const routes = {} as Record<ModelSlot, ModelRoute>;
  let changed = input.contextWindow !== undefined;
  for (const slot of MODEL_SLOTS) {
    const fallback = DEFAULT_ROUTES[slot];
    const original = input.routes?.[slot];
    const candidate = original ?? fallback;
    const provider = isProvider(candidate.provider, providers) ? candidate.provider : fallback.provider;
    if (original && provider !== candidate.provider) changed = true;
    const model = String(candidate.model ?? fallback.model).trim() || fallback.model;
    const rawContext = Number(candidate.contextWindow);
    let contextWindow: number;
    if (Number.isFinite(rawContext) && Number.isInteger(rawContext) && rawContext >= 1 && rawContext <= 1000000) {
      contextWindow = rawContext;
    } else if (original) {
      contextWindow = Math.min(legacyContextWindow, verifiedUpstreamContextWindow({ provider, model }, providers));
      changed = true;
    } else {
      contextWindow = fallback.contextWindow ?? DEFAULT_CONTEXT_WINDOWS[slot];
    }
    const rawMax = Number(candidate.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS[slot]);
    let maxOutputTokens = Number.isFinite(rawMax) ? Math.max(1, Math.min(1000000, Math.floor(rawMax))) : DEFAULT_MAX_OUTPUT_TOKENS[slot];
    const verifiedOutputCap = verifiedModelMaxOutputTokens(provider, model, providers);
    if (verifiedOutputCap !== undefined && maxOutputTokens > verifiedOutputCap) {
      maxOutputTokens = verifiedOutputCap;
      changed = true;
    }
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
      contextWindow,
      maxOutputTokens,
      ...(vision !== undefined ? { vision } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }
  return { config: { contextWindow: maximumRouteContext(routes), routes }, changed };
}

function maximumRouteContext(routes: Record<ModelSlot, ModelRoute>): number {
  return Math.max(...MODEL_SLOTS.map((slot) => Number(routes[slot].contextWindow) || DEFAULT_CONTEXT_WINDOWS[slot]));
}

function finiteInteger(value: unknown, name: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw new OpenAICCError(`${name} must be an integer between ${min} and ${max}.`, 400, "invalid_number", { field: name, min, max });
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
