import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { AccountStore, readAuthEmail, validateAuthArtifact, validateId } from "./account-store.js";
import { conflict, notFound, OpenAICCError } from "./errors.js";

export type AuthJobStatus =
  | "starting"
  | "awaiting_browser"
  | "awaiting_user"
  | "validating"
  | "complete"
  | "cancelled"
  | "error";

export interface AuthJob {
  jobId: string;
  credentialId: string;
  displayName: string;
  mode: "create" | "reauth";
  loginMode: "browser" | "device";
  status: AuthJobStatus;
  startedAt: string;
  finishedAt?: string;
  email?: string;
  safeMessage?: string;
  errorCode?: string;
  safeError?: string;
}

export interface StartAuthOptions {
  credentialId: string;
  displayName: string;
  mode?: "create" | "reauth";
  loginMode?: "browser" | "device";
}

export interface ChatGptAuthRunner {
  start(options: StartAuthOptions): Promise<AuthJob>;
  status(jobId: string): AuthJob;
  cancel(jobId: string): Promise<void>;
  activeJobs(): AuthJob[];
  shutdown(): Promise<void>;
  on(event: "job", listener: (job: AuthJob) => void): this;
}

export const TESTED_CODEX_VERSION = "0.146.0";
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_CAPTURE = 16 * 1024;

interface InternalJob extends AuthJob {
  child?: ReturnType<typeof spawn>;
  timer?: NodeJS.Timeout;
  tempRoot: string;
  codexHome: string;
  settled: boolean;
  output: string;
}

type Listener = (job: AuthJob) => void;

export class OfficialCodexAuthRunner implements ChatGptAuthRunner {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly listeners = new Set<Listener>();
  private shuttingDown = false;

  constructor(
    private readonly store: AccountStore,
    private readonly options: { timeoutMs?: number; codexEntrypoint?: string } = {},
  ) {}

  on(_event: "job", listener: Listener): this {
    this.listeners.add(listener);
    return this;
  }

  async start(options: StartAuthOptions): Promise<AuthJob> {
    if (this.shuttingDown) throw new OpenAICCError("Authentication runner is shutting down.", 503, "auth_runner_unavailable");
    const credentialId = String(options.credentialId ?? "").trim();
    const displayName = String(options.displayName ?? "").trim();
    validateId(credentialId);
    if (!displayName) throw new OpenAICCError("Display name is required.", 400, "name_required");
    const mode = options.mode ?? "create";
    const loginMode = options.loginMode ?? "browser";
    const current = this.store.get(credentialId);
    if (mode === "create" && current) throw conflict(`Credential id ${credentialId} already exists.`, "duplicate_credential");
    if (mode === "reauth" && !current) throw notFound(`Unknown credential: ${credentialId}`, "credential_not_found");
    if (mode === "reauth" && current?.provider !== "chatgpt") throw conflict(`Credential ${credentialId} is not a ChatGPT credential.`, "provider_conflict");
    const running = this.activeJobs();
    if (running.length) throw conflict(`Another ChatGPT login is already running for ${running[0].credentialId}.`, "auth_job_conflict");

    const jobId = randomUUID();
    const tempRoot = this.store.authJobDirFor(jobId);
    const codexHome = path.join(tempRoot, "codex-home");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const job: InternalJob = {
      jobId,
      credentialId,
      displayName,
      mode,
      loginMode,
      status: "starting",
      startedAt: new Date().toISOString(),
      safeMessage: loginMode === "browser" ? "Starting official Codex browser sign-in…" : "Starting official Codex device sign-in…",
      tempRoot,
      codexHome,
      settled: false,
      output: "",
    };
    this.jobs.set(jobId, job);
    this.emit(job);

    let entrypoint: string;
    try {
      entrypoint = await this.resolveCodexEntrypoint();
    } catch (error: unknown) {
      await this.fail(job, error, "codex_unavailable");
      return cloneJob(job);
    }

    const args = [entrypoint, "-c", 'cli_auth_credentials_store="file"', "login"];
    if (loginMode === "device") args.push("--device-auth");
    const env = { ...process.env, CODEX_HOME: codexHome };
    const child = spawn(process.execPath, args, {
      env,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    job.child = child;
    this.setStatus(job, loginMode === "browser" ? "awaiting_browser" : "awaiting_user",
      loginMode === "browser"
        ? "Browser opened. Finish signing in with ChatGPT."
        : "Complete the device sign-in shown by the official Codex flow.");

    const capture = (chunk: Buffer | string): void => {
      const text = String(chunk);
      job.output = (job.output + "\n" + redactSensitive(text)).slice(-MAX_CAPTURE);
      if (/device|enter.*code|verification/i.test(text) && job.loginMode === "device") {
        this.setStatus(job, "awaiting_user", "Complete the device sign-in in your browser.");
      } else if (/browser|sign.?in|login/i.test(text) && job.loginMode === "browser") {
        this.setStatus(job, "awaiting_browser", "Browser opened. Finish signing in with ChatGPT.");
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => { void this.fail(job, error, "codex_launch_failed"); });
    child.once("exit", (code, signal) => { void this.handleExit(job, code, signal); });

    const requestedTimeout = this.options.timeoutMs ?? Number(process.env.OPENAI_CC_AUTH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const timeoutMs = this.options.timeoutMs === undefined ? Math.max(30_000, requestedTimeout) : Math.max(50, requestedTimeout);
    job.timer = setTimeout(() => { void this.timeout(job); }, timeoutMs);
    job.timer.unref();
    return cloneJob(job);
  }

  status(jobId: string): AuthJob {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("Authentication job not found.", "auth_job_not_found");
    return cloneJob(job);
  }

  activeJobs(): AuthJob[] {
    return [...this.jobs.values()].filter((job) => !isTerminal(job.status)).map(cloneJob);
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("Authentication job not found.", "auth_job_not_found");
    if (isTerminal(job.status)) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    await terminateChild(job.child);
    job.status = "cancelled";
    job.safeMessage = "Authentication cancelled.";
    job.finishedAt = new Date().toISOString();
    await this.cleanup(job);
    this.emit(job);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.activeJobs().map((job) => this.cancel(job.jobId).catch(() => undefined)));
  }

  private async handleExit(job: InternalJob, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (job.settled) return;
    if (job.timer) clearTimeout(job.timer);
    if (code !== 0) {
      const suffix = signal ? ` (${signal})` : code === null ? "" : ` (exit ${code})`;
      return void await this.fail(job, new Error(`Official Codex login did not complete${suffix}. ${safeOutputSummary(job.output)}`), "codex_login_failed");
    }
    this.setStatus(job, "validating", "Validating Codex credentials…");
    const tempAuth = path.join(job.codexHome, "auth.json");
    try {
      const { email } = await validateAuthArtifact(tempAuth);
      if (job.mode === "create" && this.store.has(job.credentialId)) {
        throw conflict(`Credential id ${job.credentialId} was created while login was running.`, "duplicate_credential");
      }
      const targetAuth = this.store.authFileFor(job.credentialId);
      const promotion = await promoteAuthFile(tempAuth, targetAuth);
      try {
        if (job.mode === "create") {
          await this.store.createChatGpt({ id: job.credentialId, name: job.displayName, email, authFile: targetAuth });
        } else {
          await this.store.replaceChatGptAuth(job.credentialId, { authFile: targetAuth, email, name: job.displayName });
        }
        await promotion.commit();
      } catch (error) {
        await promotion.rollback();
        throw error;
      }
      job.settled = true;
      job.status = "complete";
      job.email = email ?? await readAuthEmail(targetAuth);
      job.safeMessage = job.email ? `Signed in as ${job.email}.` : "ChatGPT authentication completed.";
      job.finishedAt = new Date().toISOString();
      await this.cleanup(job);
      this.emit(job);
    } catch (error: unknown) {
      await this.fail(job, error, error instanceof OpenAICCError ? error.code : "auth_validation_failed");
    }
  }

  private async timeout(job: InternalJob): Promise<void> {
    if (job.settled) return;
    job.settled = true;
    await terminateChild(job.child);
    job.status = "error";
    job.errorCode = "auth_timeout";
    job.safeError = "ChatGPT sign-in timed out before completion.";
    job.safeMessage = "Authentication timed out. You can retry safely; existing credentials were not changed.";
    job.finishedAt = new Date().toISOString();
    await this.cleanup(job);
    this.emit(job);
  }

  private async fail(job: InternalJob, error: unknown, code: string): Promise<void> {
    if (job.settled && job.status !== "validating" && job.status !== "starting") return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    await terminateChild(job.child);
    const message = error instanceof Error ? error.message : String(error);
    job.status = "error";
    job.errorCode = code;
    job.safeError = this.redactError(message);
    job.safeMessage = "Authentication failed. Existing credentials, if any, were left unchanged.";
    job.finishedAt = new Date().toISOString();
    await this.cleanup(job);
    this.emit(job);
  }

  private setStatus(job: InternalJob, status: AuthJobStatus, safeMessage: string): void {
    if (job.settled || job.status === status && job.safeMessage === safeMessage) return;
    job.status = status;
    job.safeMessage = safeMessage;
    this.emit(job);
  }

  private emit(job: InternalJob): void {
    const safe = cloneJob(job);
    for (const listener of this.listeners) listener(safe);
  }

  private redactError(message: string): string {
    const managedRoot = this.store.dataDir;
    return redactSensitive(message)
      .split(managedRoot).join("[managed-data]")
      .split(managedRoot.replace(/\\/g, "/")).join("[managed-data]")
      .slice(0, 1200);
  }

  private async cleanup(job: InternalJob): Promise<void> {
    try { await rm(job.tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    delete job.child;
    delete job.timer;
    job.output = "";
  }

  private async resolveCodexEntrypoint(): Promise<string> {
    if (this.options.codexEntrypoint) return path.resolve(this.options.codexEntrypoint);
    if (process.env.OPENAI_CC_CODEX_ENTRYPOINT) return path.resolve(process.env.OPENAI_CC_CODEX_ENTRYPOINT);
    try {
      const require = createRequire(import.meta.url);
      const packageJson = require.resolve("@openai/codex/package.json");
      const entrypoint = path.join(path.dirname(packageJson), "bin", "codex.js");
      await stat(entrypoint);
      return entrypoint;
    } catch (error: unknown) {
      throw new OpenAICCError(
        `Official Codex ${TESTED_CODEX_VERSION} is unavailable. Re-run npm install for OpenAI-CC.`,
        503,
        "codex_unavailable",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}

interface AuthPromotion {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

async function promoteAuthFile(source: string, target: string): Promise<AuthPromotion> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.${randomUUID()}.new`;
  const backup = `${target}.${randomUUID()}.bak`;
  await copyFile(source, staging);
  let hadExisting = false;
  try {
    await stat(target);
    hadExisting = true;
  } catch { /* no existing auth */ }
  try {
    if (hadExisting) await rename(target, backup);
    await rename(staging, target);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    if (hadExisting) {
      try {
        await stat(backup);
        await rename(backup, target);
      } catch { /* preserve original error */ }
    }
    throw error;
  }

  let settled = false;
  return {
    async commit(): Promise<void> {
      if (settled) return;
      settled = true;
      if (hadExisting) await unlink(backup).catch(() => undefined);
    },
    async rollback(): Promise<void> {
      if (settled) return;
      settled = true;
      await unlink(target).catch(() => undefined);
      if (hadExisting) {
        try { await rename(backup, target); } catch { /* best effort; original error still wins */ }
      }
    },
  };
}

function cloneJob(job: InternalJob): AuthJob {
  return {
    jobId: job.jobId,
    credentialId: job.credentialId,
    displayName: job.displayName,
    mode: job.mode,
    loginMode: job.loginMode,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    email: job.email,
    safeMessage: job.safeMessage,
    errorCode: job.errorCode,
    safeError: job.safeError,
  };
}

function isTerminal(status: AuthJobStatus): boolean {
  return status === "complete" || status === "cancelled" || status === "error";
}

function redactSensitive(value: string): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[redacted-auth-url]")
    .replace(/\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key)\b\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]");
}

function safeOutputSummary(output: string): string {
  const clean = redactSensitive(output).replace(/\s+/g, " ").trim();
  return clean ? clean.slice(-600) : "";
}

async function terminateChild(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
    });
  } else {
    try { child.kill("SIGTERM"); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (child.exitCode === null) try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}
