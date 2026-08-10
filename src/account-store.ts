import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AccountStatus = "ready" | "exhausted" | "disabled";
export type ProviderKind = "chatgpt" | "zen" | "nvidia" | "google";

export const LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_API_KEY_COOLDOWN_MS = 15 * 60 * 1000;

export interface AccountRecord {
  id: string;
  name: string;
  provider?: ProviderKind;
  email?: string;
  authFile?: string;
  apiKey?: string;
  model?: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
  firstRequestAt?: string;
  limitResetsAt?: string;
  exhaustedAt?: string;
  lastError?: string;
}

interface StoreFile {
  activeAccountId: string | null;
  accounts: AccountRecord[];
}

export interface StoreEvent {
  type: "changed" | "rate_limit" | "activated";
  account?: AccountRecord;
  activeAccountId: string | null;
  suggestedNextAccountId?: string | null;
}

export class AccountStore extends EventEmitter {
  readonly dataDir: string;
  readonly accountsDir: string;
  private readonly dbFile: string;
  private state: StoreFile = { activeAccountId: null, accounts: [] };
  private readonly resetTimers = new Map<string, NodeJS.Timeout>();

  constructor(dataDir: string) {
    super();
    this.dataDir = path.resolve(dataDir);
    this.accountsDir = path.join(this.dataDir, "accounts");
    this.dbFile = path.join(this.dataDir, "accounts.json");
  }

  async init(): Promise<void> {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await readFile(this.dbFile, "utf8")) as StoreFile;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }

    let changed = false;
    const now = Date.now();
    for (const account of this.state.accounts) {
      if (!account.provider) {
        account.provider = "chatgpt";
        changed = true;
      }
      if (account.provider === "chatgpt" && account.authFile && !account.email) {
        const email = await readAuthEmail(account.authFile);
        if (email) {
          account.email = email;
          account.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (account.limitResetsAt && Date.parse(account.limitResetsAt) <= now) {
        this.clearUsageWindow(account);
        changed = true;
      }
    }
    if (changed) await this.persist();
    for (const account of this.state.accounts) this.scheduleReset(account);
  }

  list(): AccountRecord[] {
    return this.state.accounts.map((a) => this.publicRecord(a));
  }

  get(id: string): AccountRecord | undefined {
    const account = this.state.accounts.find((a) => a.id === id);
    return account ? { ...account } : undefined;
  }

  active(): AccountRecord | undefined {
    if (!this.state.activeAccountId) return undefined;
    return this.get(this.state.activeAccountId);
  }

  suggestedNext(afterId?: string): AccountRecord | undefined {
    const ready = this.state.accounts.filter((a) => a.status === "ready");
    if (!ready.length) return undefined;
    if (!afterId) return { ...ready[0] };
    const start = this.state.accounts.findIndex((a) => a.id === afterId);
    for (let offset = 1; offset <= this.state.accounts.length; offset++) {
      const candidate = this.state.accounts[(Math.max(start, -1) + offset) % this.state.accounts.length];
      if (candidate?.status === "ready") return { ...candidate };
    }
    return undefined;
  }

  authFileFor(id: string): string {
    return path.join(this.accountsDir, id, "auth.json");
  }

  async upsert(input: { id: string; name: string; email?: string; authFile?: string }): Promise<AccountRecord> {
    validateId(input.id);
    const now = new Date().toISOString();
    const existing = this.state.accounts.find((a) => a.id === input.id);
    const authFile = path.resolve(input.authFile ?? this.authFileFor(input.id));
    const email = input.email ?? await readAuthEmail(authFile);
    if (existing) {
      existing.name = input.name;
      existing.provider = "chatgpt";
      existing.authFile = authFile;
      delete existing.apiKey;
      delete existing.model;
      if (email) existing.email = email;
      existing.updatedAt = now;
      if (existing.status === "disabled") existing.status = "ready";
      await this.persist();
      this.emitChanged();
      return { ...existing };
    }

    const record: AccountRecord = {
      id: input.id,
      name: input.name,
      provider: "chatgpt",
      email,
      authFile,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.state.accounts.push(record);
    if (!this.state.activeAccountId) this.state.activeAccountId = record.id;
    await this.persist();
    this.emitChanged();
    return { ...record };
  }

  async upsertApiKey(input: { id: string; name: string; provider: Exclude<ProviderKind, "chatgpt">; apiKey: string; model: string }): Promise<AccountRecord> {
    validateId(input.id);
    if (!isApiProvider(input.provider)) throw new Error(`Unsupported API provider: ${input.provider}`);
    const apiKey = String(input.apiKey ?? "").trim();
    const model = String(input.model ?? "").trim();
    if (!apiKey) throw new Error("API key is required.");
    if (!model) throw new Error("Provider model id is required.");

    const now = new Date().toISOString();
    const existing = this.state.accounts.find((a) => a.id === input.id);
    if (existing) {
      existing.name = input.name;
      existing.provider = input.provider;
      existing.apiKey = apiKey;
      existing.model = model;
      delete existing.authFile;
      delete existing.email;
      existing.updatedAt = now;
      if (existing.status === "disabled") existing.status = "ready";
      await this.persist();
      this.emitChanged();
      return { ...existing };
    }

    const record: AccountRecord = {
      id: input.id,
      name: input.name,
      provider: input.provider,
      apiKey,
      model,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.state.accounts.push(record);
    if (!this.state.activeAccountId) this.state.activeAccountId = record.id;
    await this.persist();
    this.emitChanged();
    return { ...record };
  }

  async activate(id: string): Promise<AccountRecord> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    if (account.limitResetsAt && Date.parse(account.limitResetsAt) <= Date.now()) this.clearUsageWindow(account);
    if (account.status !== "ready") throw new Error(`Account ${id} is ${account.status}; it will be ready at ${account.limitResetsAt ?? "its next reset"}.`);
    this.state.activeAccountId = id;
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.scheduleReset(account);
    this.emit("event", {
      type: "activated",
      account: this.publicRecord(account),
      activeAccountId: id,
      suggestedNextAccountId: this.suggestedNext(id)?.id ?? null,
    } satisfies StoreEvent);
    return { ...account };
  }

  async noteRequest(id: string): Promise<AccountRecord> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    if (account.status !== "ready") throw new Error(`Account ${id} is ${account.status}.`);

    const nowMs = Date.now();
    if (account.limitResetsAt && Date.parse(account.limitResetsAt) <= nowMs) this.clearUsageWindow(account);

    if ((account.provider ?? "chatgpt") === "chatgpt" && !account.firstRequestAt) {
      const firstRequestAt = new Date(nowMs);
      account.firstRequestAt = firstRequestAt.toISOString();
      account.limitResetsAt = new Date(nowMs + LIMIT_WINDOW_MS).toISOString();
      account.updatedAt = firstRequestAt.toISOString();
      await this.persist();
      this.scheduleReset(account);
      this.emitChanged();
    }
    return { ...account };
  }

  async markRateLimited(id: string, message: string, activateNext = false, cooldownMs?: number): Promise<AccountRecord | undefined> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) return undefined;
    const now = new Date();
    const provider = account.provider ?? "chatgpt";

    if (provider === "chatgpt") {
      if (!account.firstRequestAt) account.firstRequestAt = now.toISOString();
      if (!account.limitResetsAt) account.limitResetsAt = new Date(Date.parse(account.firstRequestAt) + LIMIT_WINDOW_MS).toISOString();
    } else {
      account.firstRequestAt = account.firstRequestAt ?? now.toISOString();
      const delay = Math.max(1000, cooldownMs ?? Number(process.env.API_KEY_RATE_LIMIT_COOLDOWN_MS || DEFAULT_API_KEY_COOLDOWN_MS));
      account.limitResetsAt = new Date(now.getTime() + delay).toISOString();
    }

    account.status = "exhausted";
    account.exhaustedAt = now.toISOString();
    account.lastError = message.slice(0, 1000);
    account.updatedAt = now.toISOString();
    if (this.state.activeAccountId === id) this.state.activeAccountId = null;

    const next = activateNext ? this.suggestedNext(id) : undefined;
    if (next) {
      this.state.activeAccountId = next.id;
      const nextRecord = this.state.accounts.find((a) => a.id === next.id);
      if (nextRecord) nextRecord.updatedAt = now.toISOString();
    }

    await this.persist();
    this.scheduleReset(account);
    this.emit("event", {
      type: "rate_limit",
      account: this.publicRecord(account),
      activeAccountId: this.state.activeAccountId,
      suggestedNextAccountId: this.suggestedNext(this.state.activeAccountId ?? id)?.id ?? null,
    } satisfies StoreEvent);
    if (next) {
      const nextRecord = this.state.accounts.find((a) => a.id === next.id);
      this.emit("event", {
        type: "activated",
        account: nextRecord ? this.publicRecord(nextRecord) : undefined,
        activeAccountId: next.id,
        suggestedNextAccountId: this.suggestedNext(next.id)?.id ?? null,
      } satisfies StoreEvent);
    }
    return next ? this.get(next.id) : undefined;
  }

  async reset(id: string): Promise<AccountRecord> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    if (account.limitResetsAt && Date.parse(account.limitResetsAt) > Date.now()) {
      throw new Error(`Account ${id} is expected to refresh at ${account.limitResetsAt}.`);
    }
    this.clearUsageWindow(account);
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.scheduleReset(account);
    this.emitChanged();
    return { ...account };
  }

  snapshot(): StoreFile & { suggestedNextAccountId: string | null } {
    return {
      activeAccountId: this.state.activeAccountId,
      accounts: this.list(),
      suggestedNextAccountId: this.suggestedNext(this.state.activeAccountId ?? undefined)?.id ?? null,
    };
  }

  private publicRecord(account: AccountRecord): AccountRecord {
    const copy = { ...account };
    if (copy.apiKey) copy.apiKey = "********";
    return copy;
  }

  private clearUsageWindow(account: AccountRecord): void {
    account.status = "ready";
    delete account.firstRequestAt;
    delete account.limitResetsAt;
    delete account.exhaustedAt;
    delete account.lastError;
    account.updatedAt = new Date().toISOString();
    const timer = this.resetTimers.get(account.id);
    if (timer) clearTimeout(timer);
    this.resetTimers.delete(account.id);
  }

  private scheduleReset(account: AccountRecord): void {
    const oldTimer = this.resetTimers.get(account.id);
    if (oldTimer) clearTimeout(oldTimer);
    this.resetTimers.delete(account.id);
    if (!account.limitResetsAt) return;

    const delay = Math.max(0, Date.parse(account.limitResetsAt) - Date.now());
    const timer = setTimeout(() => { void this.refreshWindow(account.id); }, delay);
    timer.unref();
    this.resetTimers.set(account.id, timer);
  }

  private async refreshWindow(id: string): Promise<void> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account?.limitResetsAt) return;
    if (Date.parse(account.limitResetsAt) > Date.now()) {
      this.scheduleReset(account);
      return;
    }
    this.clearUsageWindow(account);
    await this.persist();
    this.emitChanged();
  }

  private emitChanged(): void {
    this.emit("event", {
      type: "changed",
      activeAccountId: this.state.activeAccountId,
      suggestedNextAccountId: this.suggestedNext(this.state.activeAccountId ?? undefined)?.id ?? null,
    } satisfies StoreEvent);
  }

  private async persist(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.dbFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.dbFile);
    try { await chmod(this.dbFile, 0o600); } catch { /* Windows */ }
  }
}

export async function readAuthEmail(authFile: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(authFile, "utf8")) as unknown;
    return findEmail(data) ?? findJwtEmail(data);
  } catch {
    return undefined;
  }
}

function findEmail(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = findEmail(item, depth + 1);
      if (email) return email;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(object)) {
    if (key.toLowerCase().includes("email") && typeof item === "string" && looksLikeEmail(item)) return item;
  }
  for (const item of Object.values(object)) {
    const email = findEmail(item, depth + 1);
    if (email) return email;
  }
  return undefined;
}

function findJwtEmail(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 8) return undefined;
  if (typeof value === "string") {
    const parts = value.split(".");
    if (parts.length !== 3) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
      return findEmail(payload);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = findJwtEmail(item, depth + 1);
      if (email) return email;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const email = findJwtEmail(item, depth + 1);
    if (email) return email;
  }
  return undefined;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isApiProvider(provider: string): provider is Exclude<ProviderKind, "chatgpt"> {
  return provider === "zen" || provider === "nvidia" || provider === "google";
}

export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) {
    throw new Error("Account id may contain only letters, numbers, dot, underscore and dash.");
  }
}
