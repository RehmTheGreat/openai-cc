import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountRecord, AccountStore, ProviderKind, PublicCredential } from "./account-store.js";
import { OpenAICCError, unprocessable } from "./errors.js";

export type ModelSlot = "default" | "fable" | "opus" | "sonnet" | "haiku";

export interface ModelRoute {
  provider: ProviderKind;
  model: string;
  credentialId?: string;
  maxOutputTokens: number;
}

export interface ModelConfig {
  contextWindow: number;
  routes: Record<ModelSlot, ModelRoute>;
}

export interface RouteHealth {
  slot: ModelSlot;
  provider: ProviderKind;
  model: string;
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
  sonnet: 128000,
  haiku: 64000,
};

const DEFAULTS: ModelConfig = {
  contextWindow: 700000,
  routes: {
    default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.default },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.fable },
    opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.opus },
    sonnet: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.sonnet },
    haiku: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.haiku },
  },
};

export class ModelConfigStore extends EventEmitter {
  private readonly file: string;
  private state: ModelConfig = structuredClone(DEFAULTS);

  constructor(dataDir: string, private readonly accounts: AccountStore) {
    super();
    this.file = path.join(path.resolve(dataDir), "model-config.json");
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<ModelConfig>;
      this.state = normalizeForLoad(raw);
      let repaired = false;
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

  async update(input: Partial<ModelConfig>): Promise<ModelConfig> {
    const candidateRoutes = Object.fromEntries(MODEL_SLOTS.map((slot) => [
      slot,
      { ...this.state.routes[slot], ...(input.routes?.[slot] ?? {}) },
    ])) as Record<ModelSlot, ModelRoute>;
    const candidate = normalizeStrict({ ...this.state, ...input, routes: candidateRoutes });
    this.validatePins(candidate);
    this.state = candidate;
    await this.persist();
    this.emit("event", { type: "model_config_changed" });
    return this.snapshot();
  }

  slotForRequestedModel(model: string): ModelSlot {
    const id = String(model || "").toLowerCase();
    if (id === "fable" || id.includes("fable")) return "fable";
    if (id === "opus" || id.includes("opus")) return "opus";
    if (id === "sonnet" || id.includes("sonnet")) return "sonnet";
    if (id === "haiku" || id.includes("haiku")) return "haiku";
    return "default";
  }

  routeForRequestedModel(model: string): ModelRoute {
    return { ...this.state.routes[this.slotForRequestedModel(model)] };
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

  pinnedSlotsForCredential(id: string): ModelSlot[] {
    return MODEL_SLOTS.filter((slot) => this.state.routes[slot].credentialId === id);
  }

  health(): Record<ModelSlot, RouteHealth> {
    return Object.fromEntries(MODEL_SLOTS.map((slot) => [slot, this.healthFor(slot)])) as Record<ModelSlot, RouteHealth>;
  }

  healthFor(slot: ModelSlot): RouteHealth {
    const route = this.state.routes[slot];
    const sameProvider = this.accounts.list().filter((credential) => credential.provider === route.provider);
    const ready = sameProvider.filter((credential) => credential.status === "ready");
    if (route.credentialId) {
      const pinned = sameProvider.find((credential) => credential.id === route.credentialId);
      if (!pinned) {
        return baseHealth(slot, route, ready, "unavailable", "Pinned credential is missing or belongs to another provider.");
      }
      if (pinned.status !== "ready") {
        const reset = pinned.limitResetsAt ? ` until ${pinned.limitResetsAt}` : "";
        return baseHealth(slot, route, ready, "unavailable", `Pinned credential is ${pinned.status}${reset}.`);
      }
      return baseHealth(slot, route, ready, "healthy", `Pinned to ${pinned.name}.`);
    }
    if (!ready.length) return baseHealth(slot, route, ready, "unavailable", `No ready ${route.provider} credential is available.`);
    const preferred = this.accounts.preferredId(route.provider);
    const preferredReady = preferred && ready.some((credential) => credential.id === preferred);
    const status = preferred && !preferredReady ? "degraded" : "healthy";
    const message = preferred && !preferredReady
      ? `Preferred credential is unavailable; ${ready.length} fallback credential${ready.length === 1 ? "" : "s"} ready.`
      : `${ready.length} ready credential${ready.length === 1 ? "" : "s"}; preferred first, then provider-local rotation.`;
    return baseHealth(slot, route, ready, status, message);
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
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export const MODEL_SLOTS: ModelSlot[] = ["default", "fable", "opus", "sonnet", "haiku"];

function normalizeStrict(input: Partial<ModelConfig>): ModelConfig {
  const contextWindow = finiteInteger(input.contextWindow, "contextWindow", 200000, 1000000);
  const routes = {} as Record<ModelSlot, ModelRoute>;
  for (const slot of MODEL_SLOTS) {
    const candidate = input.routes?.[slot];
    if (!candidate) throw new OpenAICCError(`Missing model route: ${slot}.`, 400, "missing_route");
    if (!isProvider(candidate.provider)) throw new OpenAICCError(`Unsupported provider for ${slot}.`, 400, "invalid_provider", { slot });
    const model = String(candidate.model ?? "").trim();
    if (!model) throw new OpenAICCError(`Model id is required for ${slot}.`, 400, "model_required", { slot });
    if (model.length > 256) throw new OpenAICCError(`Model id is too long for ${slot}.`, 400, "model_too_long", { slot });
    const maxOutputTokens = finiteInteger(candidate.maxOutputTokens, `${slot}.maxOutputTokens`, 1, 1000000);
    const credentialId = String(candidate.credentialId ?? "").trim() || undefined;
    routes[slot] = { provider: candidate.provider, model, credentialId, maxOutputTokens };
  }
  return { contextWindow, routes };
}

function normalizeForLoad(input: Partial<ModelConfig>): ModelConfig {
  const contextRaw = Number(input.contextWindow ?? DEFAULTS.contextWindow);
  const contextWindow = Number.isFinite(contextRaw) ? Math.max(200000, Math.min(1000000, Math.floor(contextRaw))) : DEFAULTS.contextWindow;
  const routes = {} as Record<ModelSlot, ModelRoute>;
  for (const slot of MODEL_SLOTS) {
    const fallback = DEFAULTS.routes[slot];
    const candidate = input.routes?.[slot] ?? fallback;
    const provider = isProvider(candidate.provider) ? candidate.provider : fallback.provider;
    const model = String(candidate.model ?? fallback.model).trim() || fallback.model;
    const rawMax = Number(candidate.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS[slot]);
    const maxOutputTokens = Number.isFinite(rawMax) ? Math.max(1, Math.min(1000000, Math.floor(rawMax))) : DEFAULT_MAX_OUTPUT_TOKENS[slot];
    const credentialId = String(candidate.credentialId ?? "").trim() || undefined;
    routes[slot] = { provider, model, credentialId, maxOutputTokens };
  }
  return { contextWindow, routes };
}

function finiteInteger(value: unknown, name: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw new OpenAICCError(`${name} must be an integer between ${min} and ${max}.`, 400, "invalid_number", { field: name, min, max });
  }
  return number;
}

function isProvider(value: unknown): value is ProviderKind {
  return value === "chatgpt" || value === "zen" || value === "nvidia" || value === "google";
}

function baseHealth(slot: ModelSlot, route: ModelRoute, ready: PublicCredential[], status: RouteHealth["status"], message: string): RouteHealth {
  return {
    slot,
    provider: route.provider,
    model: route.model,
    mode: route.credentialId ? "pinned" : "auto",
    credentialId: route.credentialId,
    readyCredentialIds: ready.map((credential) => credential.id),
    readyCredentials: ready.length,
    status,
    message,
  };
}
