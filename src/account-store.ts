import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AccountStatus = "ready" | "exhausted" | "disabled";

export interface AccountRecord {
  id: string;
  name: string;
  authFile: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
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
  }

  list(): AccountRecord[] {
    return this.state.accounts.map((a) => ({ ...a }));
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
    if (!afterId) return ready[0];
    const start = this.state.accounts.findIndex((a) => a.id === afterId);
    for (let offset = 1; offset <= this.state.accounts.length; offset++) {
      const candidate = this.state.accounts[(start + offset) % this.state.accounts.length];
      if (candidate?.status === "ready") return { ...candidate };
    }
    return undefined;
  }

  authFileFor(id: string): string {
    return path.join(this.accountsDir, id, "auth.json");
  }

  async upsert(input: { id: string; name: string; authFile?: string }): Promise<AccountRecord> {
    validateId(input.id);
    const now = new Date().toISOString();
    const existing = this.state.accounts.find((a) => a.id === input.id);
    const authFile = path.resolve(input.authFile ?? this.authFileFor(input.id));
    if (existing) {
      existing.name = input.name;
      existing.authFile = authFile;
      existing.updatedAt = now;
      if (existing.status === "disabled") existing.status = "ready";
      await this.persist();
      this.emitChanged();
      return { ...existing };
    }

    const record: AccountRecord = {
      id: input.id,
      name: input.name,
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

  async activate(id: string): Promise<AccountRecord> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    if (account.status !== "ready") throw new Error(`Account ${id} is ${account.status}; reset it before activation.`);
    this.state.activeAccountId = id;
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.emit("event", {
      type: "activated",
      account: { ...account },
      activeAccountId: id,
      suggestedNextAccountId: this.suggestedNext(id)?.id ?? null,
    } satisfies StoreEvent);
    return { ...account };
  }

  async markRateLimited(id: string, message: string): Promise<void> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) return;
    const now = new Date().toISOString();
    account.status = "exhausted";
    account.exhaustedAt = now;
    account.lastError = message.slice(0, 1000);
    account.updatedAt = now;
    if (this.state.activeAccountId === id) this.state.activeAccountId = null;
    await this.persist();
    this.emit("event", {
      type: "rate_limit",
      account: { ...account },
      activeAccountId: this.state.activeAccountId,
      suggestedNextAccountId: this.suggestedNext(id)?.id ?? null,
    } satisfies StoreEvent);
  }

  async reset(id: string): Promise<AccountRecord> {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    account.status = "ready";
    delete account.exhaustedAt;
    delete account.lastError;
    account.updatedAt = new Date().toISOString();
    await this.persist();
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

export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) {
    throw new Error("Account id may contain only letters, numbers, dot, underscore and dash.");
  }
}
