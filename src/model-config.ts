import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountRecord, AccountStore, ProviderKind } from "./account-store.js";

export type ModelSlot = "default" | "fable" | "opus" | "sonnet" | "haiku";

export interface ModelRoute {
  provider: ProviderKind;
  model: string;
  credentialId?: string;
}

export interface ModelConfig {
  contextWindow: number;
  routes: Record<ModelSlot, ModelRoute>;
}

const DEFAULTS: ModelConfig = {
  contextWindow: 700000,
  routes: {
    default: { provider: "chatgpt", model: "gpt-5.6-terra" },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra" },
    opus: { provider: "zen", model: "deepseek-v4-flash-free" },
    sonnet: { provider: "google", model: "gemini-3.6-flash" },
    haiku: { provider: "google", model: "gemini-3.6-flash" },
  },
};

export class ModelConfigStore {
  private readonly file: string;
  private state: ModelConfig = structuredClone(DEFAULTS);

  constructor(dataDir: string, private readonly accounts: AccountStore) {
    this.file = path.join(path.resolve(dataDir), "model-config.json");
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<ModelConfig>;
      this.state = normalize(raw);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  snapshot(): ModelConfig {
    return structuredClone(this.state);
  }

  async update(input: Partial<ModelConfig>): Promise<ModelConfig> {
    this.state = normalize({ ...this.state, ...input, routes: { ...this.state.routes, ...(input.routes ?? {}) } });
    await this.persist();
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
    const candidates = this.accounts.list().filter((a) => (a.provider ?? "chatgpt") === route.provider && a.status === "ready" && !attempted.has(a.id));
    const candidate = route.credentialId ? candidates.find((a) => a.id === route.credentialId) : candidates[0];
    return candidate ? this.accounts.get(candidate.id) : undefined;
  }

  async markRateLimitedAndNext(model: string, account: AccountRecord, message: string, cooldownMs?: number, attempted = new Set<string>()): Promise<AccountRecord | undefined> {
    await this.accounts.markRateLimited(account.id, message, false, cooldownMs);
    return this.credentialForRequestedModel(model, attempted);
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export const MODEL_SLOTS: ModelSlot[] = ["default", "fable", "opus", "sonnet", "haiku"];

function normalize(input: Partial<ModelConfig>): ModelConfig {
  const contextWindow = Math.max(200000, Math.min(1000000, Number(input.contextWindow ?? DEFAULTS.contextWindow) || DEFAULTS.contextWindow));
  const routes = {} as Record<ModelSlot, ModelRoute>;
  for (const slot of MODEL_SLOTS) {
    const candidate = input.routes?.[slot] ?? DEFAULTS.routes[slot];
    const provider = isProvider(candidate?.provider) ? candidate.provider : DEFAULTS.routes[slot].provider;
    const model = String(candidate?.model ?? DEFAULTS.routes[slot].model).trim() || DEFAULTS.routes[slot].model;
    const credentialId = String(candidate?.credentialId ?? "").trim() || undefined;
    routes[slot] = { provider, model, credentialId };
  }
  return { contextWindow, routes };
}

function isProvider(value: unknown): value is ProviderKind {
  return value === "chatgpt" || value === "zen" || value === "nvidia" || value === "google";
}
