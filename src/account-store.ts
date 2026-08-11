import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { conflict, notFound, OpenAICCError } from "./errors.js";

export type AccountStatus = "ready" | "exhausted" | "auth_error" | "disabled";
export type ProviderKind = "chatgpt" | "zen" | "nvidia" | "google" | "cloudflare";
export type ApiProviderKind = Exclude<ProviderKind, "chatgpt">;

export const LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_API_KEY_COOLDOWN_MS = 15 * 60 * 1000;
export const ACCOUNT_STORE_VERSION = 2;

export interface AccountRecord {
  id: string;
  name: string;
  provider: ProviderKind;
  email?: string;
  authFile?: string;
  apiKey?: string;
  accountId?: string;
  // Legacy compatibility: older API-key credentials stored a model on the
  // credential itself. Routing now owns model selection, but this field remains
  // readable so existing .data stores do not need destructive migration.
  model?: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
  firstRequestAt?: string;
  limitResetsAt?: string;
  exhaustedAt?: string;
  disabledAt?: string;
  lastError?: string;
}

export interface PublicCredential {
  id: string;
  name: string;
  provider: ProviderKind;
  email?: string;
  accountId?: string;
  model?: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
  firstRequestAt?: string;
  limitResetsAt?: string;
  exhaustedAt?: string;
  disabledAt?: string;
  lastError?: string;
}

interface StoreFileV2 {
  version: 2;
  preferredCredentialByProvider: Partial<Record<ProviderKind, string>>;
  accounts: AccountRecord[];
}

interface LegacyStoreFile {
  version?: number;
  activeAccountId?: string | null;
  preferredCredentialByProvider?: Partial<Record<ProviderKind, string>>;
  accounts?: Array<AccountRecord & { provider?: ProviderKind }>;
}

export type StoreEvent =
  | { type: "credentials_changed"; credential?: PublicCredential }
  | { type: "credential_status_changed"; credential: PublicCredential }
  | { type: "preferred_changed"; provider: ProviderKind; credentialId: string | null };

export interface AccountStoreSnapshot {
  version: 2;
  preferredCredentialByProvider: Partial<Record<ProviderKind, string>>;
  accounts: PublicCredential[];
}

export class AccountStore extends EventEmitter {
  readonly dataDir: string;
  readonly codexHomesDir: string;
  readonly legacyAccountsDir: string;
  readonly authJobsDir: string;
  private readonly dbFile: string;
  private state: StoreFileV2 = { version: ACCOUNT_STORE_VERSION, preferredCredentialByProvider: {}, accounts: [] };
  private readonly resetTimers = new Map<string, NodeJS.Timeout>();

  constructor(dataDir: string) {
    super();
    this.dataDir = path.resolve(dataDir);
    this.codexHomesDir = path.join(this.dataDir, "codex-homes");
    this.legacyAccountsDir = path.join(this.dataDir, "accounts");
    this.authJobsDir = path.join(this.dataDir, "auth-jobs");
    this.dbFile = path.join(this.dataDir, "accounts.json");
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.dataDir, { recursive: true, mode: 0o700 }),
      mkdir(this.codexHomesDir, { recursive: true, mode: 0o700 }),
      mkdir(this.authJobsDir, { recursive: true, mode: 0o700 }),
    ]);
    let changed = false;
    try {
      const parsed = JSON.parse(await readFile(this.dbFile, "utf8")) as LegacyStoreFile;
      const migrated = this.migrate(parsed);
      this.state = migrated.state;
      changed = migrated.changed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      changed = true;
    }

    const now = Date.now();
    for (const account of this.state.accounts) {
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
      this.scheduleReset(account);
    }
    this.repairPreferences();
    if (changed) await this.persist();
  }

  list(): PublicCredential[] {
    return this.state.accounts.map((account) => publicCredential(account));
  }

  get(id: string): AccountRecord | undefined {
    const account = this.state.accounts.find((candidate) => candidate.id === id);
    return account ? { ...account } : undefined;
  }

  publicGet(id: string): PublicCredential | undefined {
    const account = this.state.accounts.find((candidate) => candidate.id === id);
    return account ? publicCredential(account) : undefined;
  }

  has(id: string): boolean {
    return this.state.accounts.some((account) => account.id === id);
  }

  preferredId(provider: ProviderKind): string | undefined {
    return this.state.preferredCredentialByProvider[provider];
  }

  orderedReady(provider: ProviderKind, excluded = new Set<string>()): AccountRecord[] {
    const ready = this.state.accounts.filter((account) => account.provider === provider && account.status === "ready" && !excluded.has(account.id));
    const preferred = this.state.preferredCredentialByProvider[provider];
    if (!preferred) return ready.map((account) => ({ ...account }));
    return ready
      .map((account, index) => ({ account, rank: account.id === preferred ? -1 : index }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ account }) => ({ ...account }));
  }

  generateCredentialId(provider: ProviderKind): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = `${provider}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      if (!this.has(id)) return id;
    }
    throw new OpenAICCError("Could not allocate a unique credential id.", 500, "credential_id_generation_failed");
  }

  codexHomeFor(id: string): string {
    validateId(id);
    return path.join(this.codexHomesDir, id);
  }

  authFileFor(id: string): string {
    return path.join(this.codexHomeFor(id), "auth.json");
  }

  authJobDirFor(jobId: string): string {
    validateJobId(jobId);
    return path.join(this.authJobsDir, jobId);
  }

  async createChatGpt(input: { id?: string; name?: string; authFile?: string; email?: string }): Promise<AccountRecord> {
    const id = String(input.id ?? "").trim() || this.generateCredentialId("chatgpt");
    validateId(id);
    this.assertUnique(id);
    const now = new Date().toISOString();
    const authFile = path.resolve(input.authFile ?? this.authFileFor(id));
    assertManagedAuthPath(this, authFile);
    const email = input.email ?? await readAuthEmail(authFile);
    const record: AccountRecord = {
      id,
      name: cleanOptionalName(input.name) ?? email ?? defaultCredentialName("chatgpt"),
      provider: "chatgpt",
      email,
      authFile,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    const previousState = structuredClone(this.state);
    this.state.accounts.push(record);
    if (!this.state.preferredCredentialByProvider.chatgpt) this.state.preferredCredentialByProvider.chatgpt = record.id;
    try {
      await this.persist();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    this.emitEvent({ type: "credentials_changed", credential: publicCredential(record) });
    return { ...record };
  }

  async replaceChatGptAuth(id: string, input: { authFile: string; email?: string; name?: string }): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.provider !== "chatgpt") throw conflict(`Credential ${id} is ${account.provider}, not ChatGPT.`, "provider_conflict");
    const authFile = path.resolve(input.authFile);
    assertManagedAuthPath(this, authFile);
    const previousState = structuredClone(this.state);
    account.authFile = authFile;
    account.email = input.email ?? await readAuthEmail(authFile) ?? account.email;
    const requestedName = cleanOptionalName(input.name);
    if (requestedName !== undefined) account.name = requestedName;
    else if (account.email) account.name = account.email;
    account.status = "ready";
    delete account.firstRequestAt;
    delete account.limitResetsAt;
    delete account.exhaustedAt;
    delete account.lastError;
    delete account.disabledAt;
    account.updatedAt = new Date().toISOString();
    try {
      await this.persist();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    this.clearResetTimer(id);
    this.emitEvent({ type: "credentials_changed", credential: publicCredential(account) });
    return { ...account };
  }

  async createApiKey(input: {
    id?: string;
    name?: string;
    provider: ApiProviderKind;
    apiKey: string;
    model?: string;
    accountId?: string;
  }): Promise<AccountRecord> {
    if (!isApiProvider(input.provider)) throw new OpenAICCError(`Unsupported API provider: ${String(input.provider)}`, 400, "invalid_provider");
    const id = String(input.id ?? "").trim() || this.generateCredentialId(input.provider);
    validateId(id);
    this.assertUnique(id);
    const apiKey = String(input.apiKey ?? "").trim();
    if (!apiKey) throw new OpenAICCError("API key is required.", 400, "api_key_required");
    const model = cleanOptionalModel(input.model);
    const accountId = cleanOptionalAccountId(input.accountId);
    if (input.provider === "cloudflare" && !accountId) {
      throw new OpenAICCError("Cloudflare Account ID is required.", 400, "account_id_required");
    }
    const now = new Date().toISOString();
    const record: AccountRecord = {
      id,
      name: cleanOptionalName(input.name) ?? defaultCredentialName(input.provider),
      provider: input.provider,
      apiKey,
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    const previousState = structuredClone(this.state);
    this.state.accounts.push(record);
    if (!this.state.preferredCredentialByProvider[input.provider]) this.state.preferredCredentialByProvider[input.provider] = record.id;
    try {
      await this.persist();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    this.emitEvent({ type: "credentials_changed", credential: publicCredential(record) });
    return { ...record };
  }

  async replaceApiKey(id: string, input: { apiKey: string; model?: string; name?: string; accountId?: string }): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (!isApiProvider(account.provider)) throw conflict(`Credential ${id} is ChatGPT OAuth, not an API-key credential.`, "provider_conflict");
    const apiKey = String(input.apiKey ?? "").trim();
    if (!apiKey) throw new OpenAICCError("API key is required.", 400, "api_key_required");
    const previousState = structuredClone(this.state);
    account.apiKey = apiKey;
    if (input.model !== undefined) {
      const model = cleanOptionalModel(input.model);
      if (model) account.model = model;
      else delete account.model;
    }
    if (input.accountId !== undefined) {
      const accountId = cleanOptionalAccountId(input.accountId);
      if (accountId) account.accountId = accountId;
      else delete account.accountId;
    }
    if (account.provider === "cloudflare" && !account.accountId) {
      this.state = previousState;
      throw new OpenAICCError("Cloudflare Account ID is required.", 400, "account_id_required");
    }
    if (input.name !== undefined) account.name = cleanOptionalName(input.name) ?? defaultCredentialName(account.provider);
    account.status = "ready";
    delete account.firstRequestAt;
    delete account.limitResetsAt;
    delete account.exhaustedAt;
    delete account.lastError;
    delete account.disabledAt;
    account.updatedAt = new Date().toISOString();
    try {
      await this.persist();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    this.clearResetTimer(id);
    this.emitEvent({ type: "credentials_changed", credential: publicCredential(account) });
    return { ...account };
  }

  async rename(id: string, name: string): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    account.name = cleanName(name);
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.emitEvent({ type: "credentials_changed", credential: publicCredential(account) });
    return { ...account };
  }

  async prefer(id: string): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.status !== "ready") throw conflict(`Credential ${id} is ${account.status} and cannot be preferred until it is ready.`, "credential_unavailable");
    this.state.preferredCredentialByProvider[account.provider] = id;
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.emitEvent({ type: "preferred_changed", provider: account.provider, credentialId: id });
    return { ...account };
  }

  async disable(id: string): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.status === "disabled") return { ...account };
    account.status = "disabled";
    account.disabledAt = new Date().toISOString();
    account.updatedAt = account.disabledAt;
    await this.persist();
    this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });
    return { ...account };
  }

  async enable(id: string): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.status !== "disabled") return { ...account };
    const futureReset = account.limitResetsAt && Date.parse(account.limitResetsAt) > Date.now();
    account.status = futureReset ? "exhausted" : account.lastError ? "auth_error" : "ready";
    if (!futureReset && account.status === "ready") this.clearUsageWindow(account);
    delete account.disabledAt;
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.scheduleReset(account);
    this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });
    return { ...account };
  }

  async delete(id: string): Promise<void> {
    const index = this.state.accounts.findIndex((account) => account.id === id);
    if (index < 0) throw notFound(`Unknown credential: ${id}`, "credential_not_found");
    const [account] = this.state.accounts.splice(index, 1);
    const timer = this.resetTimers.get(id);
    if (timer) clearTimeout(timer);
    this.resetTimers.delete(id);
    if (this.state.preferredCredentialByProvider[account.provider] === id) {
      delete this.state.preferredCredentialByProvider[account.provider];
      const fallback = this.state.accounts.find((candidate) => candidate.provider === account.provider && candidate.status !== "disabled");
      if (fallback) this.state.preferredCredentialByProvider[account.provider] = fallback.id;
    }
    await this.persist();
    await this.removeManagedCredentialFiles(account);
    this.emitEvent({ type: "credentials_changed" });
  }

  async noteRequest(id: string): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.status !== "ready") throw conflict(`Credential ${id} is ${account.status}.`, "credential_unavailable");
    const nowMs = Date.now();
    if (account.limitResetsAt && Date.parse(account.limitResetsAt) <= nowMs) this.clearUsageWindow(account);
    if (account.provider === "chatgpt" && !account.firstRequestAt) {
      const now = new Date(nowMs);
      account.firstRequestAt = now.toISOString();
      account.limitResetsAt = new Date(nowMs + LIMIT_WINDOW_MS).toISOString();
      account.updatedAt = now.toISOString();
      await this.persist();
      this.scheduleReset(account);
      this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });
    }
    return { ...account };
  }

  async markRateLimited(id: string, message: string, cooldownMs?: number): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.status === "disabled") return { ...account };
    const now = new Date();
    if (account.provider === "chatgpt") {
      if (!account.firstRequestAt) account.firstRequestAt = now.toISOString();
      if (!account.limitResetsAt) account.limitResetsAt = new Date(Date.parse(account.firstRequestAt) + LIMIT_WINDOW_MS).toISOString();
    } else {
      account.firstRequestAt ??= now.toISOString();
      const delay = Math.max(1000, cooldownMs ?? Number(process.env.API_KEY_RATE_LIMIT_COOLDOWN_MS || DEFAULT_API_KEY_COOLDOWN_MS));
      account.limitResetsAt = new Date(now.getTime() + delay).toISOString();
    }
    account.status = "exhausted";
    account.exhaustedAt = now.toISOString();
    account.lastError = sanitizeError(message);
    account.updatedAt = now.toISOString();
    await this.persist();
    this.scheduleReset(account);
    this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });
    return { ...account };
  }

  async markAuthError(id: string, message: string): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.status === "disabled") return { ...account };
    const previousState = structuredClone(this.state);
    account.status = "auth_error";
    delete account.firstRequestAt;
    delete account.limitResetsAt;
    delete account.exhaustedAt;
    account.lastError = sanitizeError(message || "Authentication failed.");
    account.updatedAt = new Date().toISOString();
    try {
      await this.persist();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    this.clearResetTimer(id);
    this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });
    return { ...account };
  }

  async resetIfDue(id: string): Promise<AccountRecord> {
    const account = this.requireAccount(id);
    if (account.limitResetsAt && Date.parse(account.limitResetsAt) > Date.now()) {
      throw conflict(`Credential ${id} is expected to refresh at ${account.limitResetsAt}.`, "reset_not_due", { limitResetsAt: account.limitResetsAt });
    }
    this.clearUsageWindow(account);
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });
    return { ...account };
  }

  snapshot(): AccountStoreSnapshot {
    return {
      version: ACCOUNT_STORE_VERSION,
      preferredCredentialByProvider: { ...this.state.preferredCredentialByProvider },
      accounts: this.list(),
    };
  }

  close(): void {
    for (const timer of this.resetTimers.values()) clearTimeout(timer);
    this.resetTimers.clear();
  }

  private migrate(input: LegacyStoreFile): { state: StoreFileV2; changed: boolean } {
    const accounts = (Array.isArray(input.accounts) ? input.accounts : []).map((raw) => ({
      ...raw,
      provider: raw.provider ?? "chatgpt",
    })) as AccountRecord[];
    const preferred: Partial<Record<ProviderKind, string>> = { ...(input.preferredCredentialByProvider ?? {}) };
    let changed = input.version !== ACCOUNT_STORE_VERSION;
    if (input.activeAccountId && !Object.values(preferred).includes(input.activeAccountId)) {
      const active = accounts.find((account) => account.id === input.activeAccountId);
      if (active) {
        preferred[active.provider] = active.id;
        changed = true;
      }
    }
    return { state: { version: ACCOUNT_STORE_VERSION, preferredCredentialByProvider: preferred, accounts }, changed };
  }

  private repairPreferences(): void {
    for (const provider of PROVIDERS) {
      const id = this.state.preferredCredentialByProvider[provider];
      if (id && !this.state.accounts.some((account) => account.id === id && account.provider === provider)) {
        delete this.state.preferredCredentialByProvider[provider];
      }
    }
  }

  private assertUnique(id: string): void {
    if (this.state.accounts.some((account) => account.id === id)) {
      throw conflict(`Credential id ${id} already exists. Use an explicit replace or re-authenticate operation.`, "duplicate_credential");
    }
  }

  private requireAccount(id: string): AccountRecord {
    validateId(id);
    const account = this.state.accounts.find((candidate) => candidate.id === id);
    if (!account) throw notFound(`Unknown credential: ${id}`, "credential_not_found");
    return account;
  }

  private clearUsageWindow(account: AccountRecord): void {
    if (account.status !== "disabled") account.status = "ready";
    delete account.firstRequestAt;
    delete account.limitResetsAt;
    delete account.exhaustedAt;
    delete account.lastError;
    this.clearResetTimer(account.id);
  }

  private clearResetTimer(id: string): void {
    const timer = this.resetTimers.get(id);
    if (timer) clearTimeout(timer);
    this.resetTimers.delete(id);
  }

  private scheduleReset(account: AccountRecord): void {
    const old = this.resetTimers.get(account.id);
    if (old) clearTimeout(old);
    this.resetTimers.delete(account.id);
    if (!account.limitResetsAt) return;
    const delay = Math.max(0, Date.parse(account.limitResetsAt) - Date.now());
    const timer = setTimeout(() => { void this.refreshWindow(account.id); }, delay);
    timer.unref();
    this.resetTimers.set(account.id, timer);
  }

  private async refreshWindow(id: string): Promise<void> {
    const account = this.state.accounts.find((candidate) => candidate.id === id);
    if (!account?.limitResetsAt) return;
    if (Date.parse(account.limitResetsAt) > Date.now()) return void this.scheduleReset(account);
    this.clearUsageWindow(account);
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });
  }

  private async removeManagedCredentialFiles(account: AccountRecord): Promise<void> {
    if (account.provider !== "chatgpt" || !account.authFile) return;
    const authFile = path.resolve(account.authFile);
    const roots = [this.codexHomesDir, this.legacyAccountsDir].map((root) => path.resolve(root));
    const owningRoot = roots.find((root) => isPathInside(root, authFile));
    if (!owningRoot) return;
    const home = path.dirname(authFile);
    if (home === owningRoot || !isPathInside(owningRoot, home)) return;
    await rm(home, { recursive: true, force: true });
  }

  private emitEvent(event: StoreEvent): void {
    this.emit("event", event);
  }

  private async persist(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.dbFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.dbFile);
    try { await chmod(this.dbFile, 0o600); } catch { /* Windows ACLs are managed by the user profile. */ }
  }
}

export function publicCredential(account: AccountRecord): PublicCredential {
  const {
    authFile: _authFile,
    apiKey: _apiKey,
    ...safe
  } = account;
  return safe;
}

export async function readAuthEmail(authFile: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(authFile, "utf8")) as unknown;
    return findEmail(data) ?? findJwtEmail(data);
  } catch {
    return undefined;
  }
}

export async function validateAuthArtifact(authFile: string): Promise<{ email?: string }> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(authFile, "utf8"));
  } catch {
    throw new OpenAICCError("Codex login did not produce a readable auth.json.", 422, "invalid_auth_artifact");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new OpenAICCError("Codex auth.json has an invalid structure.", 422, "invalid_auth_artifact");
  }
  const object = data as Record<string, unknown>;
  const hasTokens = Boolean(object.tokens && typeof object.tokens === "object") || Object.keys(object).some((key) => /token/i.test(key));
  const authMode = typeof object.auth_mode === "string" ? object.auth_mode : undefined;
  if (!hasTokens && authMode !== "chatgpt") {
    throw new OpenAICCError("Codex auth.json does not contain a ChatGPT login session.", 422, "invalid_auth_artifact");
  }
  return { email: findEmail(data) ?? findJwtEmail(data) };
}

export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id) || id === "." || id === "..") {
    throw new OpenAICCError("Credential id may contain only letters, numbers, dot, underscore and dash and cannot be a path traversal segment.", 400, "invalid_credential_id");
  }
}

function validateJobId(id: string): void {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new OpenAICCError("Invalid auth job id.", 400, "invalid_job_id");
}

function assertManagedAuthPath(store: AccountStore, authFile: string): void {
  const resolved = path.resolve(authFile);
  if (!isPathInside(store.dataDir, resolved)) {
    throw new OpenAICCError("Authentication files must stay under OpenAI-CC's managed data directory.", 422, "unmanaged_auth_path");
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cleanName(value: string): string {
  const name = String(value ?? "").trim();
  if (!name) throw new OpenAICCError("Display name is required.", 400, "name_required");
  if (name.length > 120) throw new OpenAICCError("Display name is too long.", 400, "name_too_long");
  return name;
}

function cleanOptionalName(value: string | undefined): string | undefined {
  if (value === undefined || String(value).trim() === "") return undefined;
  return cleanName(value);
}

function cleanOptionalModel(value: string | undefined): string | undefined {
  if (value === undefined || String(value).trim() === "") return undefined;
  const model = String(value).trim();
  if (model.length > 256) throw new OpenAICCError("Provider model id is too long.", 400, "model_too_long");
  return model;
}

function cleanOptionalAccountId(value: string | undefined): string | undefined {
  if (value === undefined || String(value).trim() === "") return undefined;
  const accountId = String(value).trim();
  if (accountId.length > 128 || /[\s/\\?#]/.test(accountId)) {
    throw new OpenAICCError("Cloudflare Account ID has an invalid format.", 400, "invalid_account_id");
  }
  return accountId;
}

function defaultCredentialName(provider: ProviderKind): string {
  if (provider === "chatgpt") return "ChatGPT account";
  if (provider === "zen") return "OpenCode Zen";
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "google") return "Google AI Studio";
  return "Cloudflare Workers AI";
}

function sanitizeError(value: string): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key|authorization)\b\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]")
    .slice(0, 1000);
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

function isApiProvider(provider: string): provider is ApiProviderKind {
  return provider === "zen" || provider === "nvidia" || provider === "google" || provider === "cloudflare";
}

const PROVIDERS: ProviderKind[] = ["chatgpt", "zen", "nvidia", "google", "cloudflare"];
