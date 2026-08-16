import { randomBytes } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { AccountRecord, AccountStore, ApiProviderKind, publicCredential, validateId } from "./account-store.js";
import { ChatGptAuthRunner, OfficialCodexAuthRunner } from "./chatgpt-auth.js";
import {
  ChatGptUpstreamError,
  chatGptRateLimitReset,
  createChatGptOAuthBoundary,
  requireSuccessfulChatGptResponse,
} from "./chatgpt-oauth.js";
import { claudeDesktopModel, claudeDesktopModelList } from "./claude-desktop.js";
import { ModelConfigStore } from "./model-config.js";
import { OpenAICCError, conflict } from "./errors.js";
import { adminPage } from "./admin/page.js";
import { DiscoveredModel, ProviderRegistry, discoverModelsForCredential } from "./provider-registry.js";

const ADMIN_BODY_LIMIT = 64 * 1024;

export interface ControlPlaneOptions {
  authRunner?: ChatGptAuthRunner;
  bindHost?: string;
  allowRemoteAdmin?: boolean;
  modelDiscoverer?: (account: AccountRecord) => Promise<DiscoveredModel[]>;
  providerRegistry?: ProviderRegistry;
}

/**
 * Non-inference HTTP surface: model discovery, Admin UI/API, credential
 * management, OAuth jobs, provider configuration and event streams.
 * /v1/messages belongs exclusively to Dispatcher in dispatcher.ts.
 */
export class ControlPlaneDispatcher {
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly authRunner: ChatGptAuthRunner;
  private readonly csrfToken = randomBytes(32).toString("base64url");
  private readonly cspNonce = randomBytes(18).toString("base64url");
  private readonly bindHost: string;
  private readonly allowRemoteAdmin: boolean;
  private readonly modelDiscoverer: (account: AccountRecord) => Promise<DiscoveredModel[]>;
  private readonly providers: ProviderRegistry;

  constructor(
    private readonly store: AccountStore,
    private readonly models: ModelConfigStore,
    options: ControlPlaneOptions = {},
  ) {
    this.bindHost = options.bindHost ?? "127.0.0.1";
    this.allowRemoteAdmin = options.allowRemoteAdmin ?? process.env.OPENAI_CC_UNSAFE_REMOTE_ADMIN === "1";
    this.providers = options.providerRegistry ?? new ProviderRegistry();
    this.modelDiscoverer = options.modelDiscoverer ?? ((account) => discoverModelsForCredential(account, fetch, this.providers));
    this.authRunner = options.authRunner ?? new OfficialCodexAuthRunner(store);
    store.on("event", (event) => this.broadcast(event.type, event));
    models.on("event", (event) => this.broadcast(event.type, event));
    this.providers.on("event", (event) => this.broadcast(event.type, event));
    this.authRunner.on("job", (job) => this.broadcast("auth_job_changed", job));
  }

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = safeUrl(req);
      const isAdmin = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
      if (isAdmin) {
        setAdminSecurityHeaders(res, this.cspNonce);
        this.assertAdminAccess(req);
        if (isMutation(req.method)) this.assertAdminMutation(req);
      } else {
        setGatewayCors(req, res);
        if (req.method === "OPTIONS") return void send(res, 204, "");
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return void json(res, 200, { ok: true, contextWindow: this.models.snapshot().contextWindow });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        return void json(res, 200, claudeDesktopModelList(this.models.snapshot(), {
          afterId: url.searchParams.get("after_id") ?? undefined,
          beforeId: url.searchParams.get("before_id") ?? undefined,
          limit,
        }, this.providers));
      }
      if (req.method === "GET" && /^\/v1\/models\/[^/]+$/.test(url.pathname)) {
        const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
        const model = claudeDesktopModel(this.models.snapshot(), modelId, this.providers);
        return void json(res, model ? 200 : 404, model ?? { error: { type: "not_found_error", message: `Model not found: ${modelId}` } });
      }

      if (req.method === "GET" && url.pathname === "/admin") {
        return void html(res, cleanAdminPage(adminPage(this.csrfToken, this.cspNonce)));
      }
      if (req.method === "GET" && url.pathname === "/admin/state") return void json(res, 200, this.adminState());
      if (req.method === "GET" && url.pathname === "/admin/events") return void this.handleEventStream(req, res);
      if (req.method === "POST" && url.pathname === "/admin/providers") {
        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);
        return void json(res, 201, await this.providers.createCustom(body));
      }
      if (req.method === "PATCH" && /^\/admin\/providers\/[^/]+$/.test(url.pathname)) {
        const id = providerIdFromPath(url.pathname);
        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);
        return void json(res, 200, await this.providers.updateCustom(id, body));
      }
      if (req.method === "DELETE" && /^\/admin\/providers\/[^/]+$/.test(url.pathname)) {
        await readJson(req, ADMIN_BODY_LIMIT, true);
        const id = providerIdFromPath(url.pathname);
        const credential = this.store.list().find((item) => item.provider === id);
        if (credential) throw conflict(`Provider ${id} still has credentials. Remove them first.`, "provider_has_credentials");
        const slots = this.models.slotsForProvider(id);
        if (slots.length) throw conflict(`Provider ${id} is routed by: ${slots.join(", ")}. Change those routes first.`, "provider_in_use", { slots });
        await this.providers.deleteCustom(id);
        return void json(res, 200, { ok: true });
      }
      if (req.method === "GET" && /^\/admin\/credentials\/[^/]+\/models$/.test(url.pathname)) {
        const id = credentialIdFromPath(url.pathname);
        const account = this.store.get(id);
        if (!account) throw new OpenAICCError(`Unknown credential: ${id}`, 404, "credential_not_found");
        const models = await this.modelDiscoverer(account);
        return void json(res, 200, { credentialId: id, provider: account.provider, models });
      }
      if (req.method === "POST" && url.pathname === "/admin/model-config") {
        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);
        const modelConfig = await this.models.update(body);
        return void json(res, 200, { modelConfig, routeHealth: this.models.health() });
      }
      if (req.method === "POST" && url.pathname === "/admin/chatgpt/auth") {
        const body = await readJson<{ id?: string; name?: string; loginMode?: string }>(req, ADMIN_BODY_LIMIT, true);
        const credentialId = String(body.id ?? "").trim() || this.store.generateCredentialId("chatgpt");
        const job = await this.authRunner.start({
          credentialId,
          displayName: String(body.name ?? "").trim() || "ChatGPT account",
          mode: "create",
          loginMode: body.loginMode === "device" ? "device" : "browser",
        });
        return void json(res, 202, job);
      }
      if (req.method === "GET" && /^\/admin\/auth-jobs\/[^/]+$/.test(url.pathname)) {
        const jobId = decodeURIComponent(url.pathname.split("/")[3]);
        return void json(res, 200, this.authRunner.status(jobId));
      }
      if (req.method === "POST" && /^\/admin\/auth-jobs\/[^/]+\/cancel$/.test(url.pathname)) {
        await readJson(req, ADMIN_BODY_LIMIT, true);
        const jobId = decodeURIComponent(url.pathname.split("/")[3]);
        await this.authRunner.cancel(jobId);
        return void json(res, 200, this.authRunner.status(jobId));
      }
      if (req.method === "POST" && url.pathname === "/admin/credentials") {
        const body = await readJson<{ id?: string; name?: string; provider?: string; apiKey?: string; model?: string; accountId?: string }>(req, ADMIN_BODY_LIMIT, true);
        const record = await this.addApiKey(body);
        return void json(res, 201, publicCredential(record));
      }
      if (req.method === "PATCH" && /^\/admin\/credentials\/[^/]+$/.test(url.pathname)) {
        const id = credentialIdFromPath(url.pathname);
        const body = await readJson<{ name?: string }>(req, ADMIN_BODY_LIMIT, true);
        if (body.name === undefined) throw new OpenAICCError("name is required.", 400, "name_required");
        return void json(res, 200, publicCredential(await this.store.rename(id, body.name)));
      }
      if (req.method === "DELETE" && /^\/admin\/credentials\/[^/]+$/.test(url.pathname)) {
        await readJson(req, ADMIN_BODY_LIMIT, true);
        const id = credentialIdFromPath(url.pathname);
        const pinned = this.models.pinnedSlotsForCredential(id);
        if (pinned.length) throw conflict(`Credential ${id} is pinned to: ${pinned.join(", ")}. Clear those pins before removing it.`, "credential_pinned", { slots: pinned });
        const activeJob = this.authRunner.activeJobs().find((job) => job.credentialId === id);
        if (activeJob) throw conflict(`Credential ${id} has an active authentication job. Cancel it first.`, "auth_job_conflict", { jobId: activeJob.jobId });
        await this.store.delete(id);
        return void json(res, 200, { ok: true });
      }
      if (req.method === "POST" && /^\/admin\/credentials\/[^/]+\/(prefer|disable|enable)$/.test(url.pathname)) {
        await readJson(req, ADMIN_BODY_LIMIT, true);
        const id = credentialIdFromPath(url.pathname);
        const action = url.pathname.split("/")[4];
        const record = action === "prefer" ? await this.store.prefer(id) : action === "disable" ? await this.store.disable(id) : await this.store.enable(id);
        return void json(res, 200, publicCredential(record));
      }
      if (req.method === "POST" && /^\/admin\/credentials\/[^/]+\/retry$/.test(url.pathname)) {
        await readJson(req, ADMIN_BODY_LIMIT, true);
        const id = credentialIdFromPath(url.pathname);
        return void json(res, 200, await this.retryChatGptCredential(id));
      }
      if (req.method === "POST" && /^\/admin\/credentials\/[^/]+\/reauth$/.test(url.pathname)) {
        const id = credentialIdFromPath(url.pathname);
        const body = await readJson<{ loginMode?: string; name?: string }>(req, ADMIN_BODY_LIMIT, true);
        const existing = this.store.get(id);
        if (!existing) throw new OpenAICCError(`Unknown credential: ${id}`, 404, "credential_not_found");
        const job = await this.authRunner.start({
          credentialId: id,
          displayName: String(body.name ?? existing.email ?? existing.name),
          mode: "reauth",
          loginMode: body.loginMode === "device" ? "device" : "browser",
        });
        return void json(res, 202, job);
      }
      if (req.method === "POST" && /^\/admin\/credentials\/[^/]+\/replace-key$/.test(url.pathname)) {
        const id = credentialIdFromPath(url.pathname);
        const body = await readJson<{ apiKey?: string; model?: string; name?: string; accountId?: string }>(req, ADMIN_BODY_LIMIT, true);
        const record = await this.store.replaceApiKey(id, {
          apiKey: String(body.apiKey ?? ""),
          model: body.model,
          name: body.name,
          accountId: body.accountId,
        });
        return void json(res, 200, publicCredential(record));
      }
      return void json(res, 404, { error: { code: "not_found", message: "Not found" } });
    } catch (error: unknown) {
      return void this.sendError(res, error);
    }
  };

  async close(): Promise<void> {
    for (const stream of this.eventStreams) stream.end();
    this.eventStreams.clear();
    await this.authRunner.shutdown();
    this.store.close();
  }

  private adminState() {
    return { ...this.store.snapshot(), providers: this.providers.listPublic(), modelConfig: this.models.snapshot(), routeHealth: this.models.health() };
  }

  private async addApiKey(input: { id?: string; name?: string; provider?: string; apiKey?: string; model?: string; accountId?: string }): Promise<AccountRecord> {
    const provider = String(input.provider ?? "").trim().toLowerCase();
    if (!this.providers.isApiKeyProvider(provider)) throw new OpenAICCError("Choose a configured API-key provider.", 400, "invalid_provider");
    return this.store.createApiKey({
      id: String(input.id ?? "").trim() || undefined,
      name: String(input.name ?? "").trim() || undefined,
      provider: provider as ApiProviderKind,
      apiKey: String(input.apiKey ?? ""),
      model: input.model,
      accountId: input.accountId,
    });
  }

  private async retryChatGptCredential(id: string): Promise<Record<string, unknown>> {
    const account = this.store.get(id);
    if (!account) throw new OpenAICCError(`Unknown credential: ${id}`, 404, "credential_not_found");
    if (account.provider !== "chatgpt" || !account.authFile) {
      throw new OpenAICCError("Retry currently applies to ChatGPT OAuth credentials.", 400, "retry_not_supported");
    }
    if (account.status === "disabled") {
      throw conflict(`Credential ${id} is disabled. Enable it before retrying.`, "credential_disabled");
    }

    const boundary = createChatGptOAuthBoundary(account.authFile);
    const availableModels = await boundary.listModels();
    const configuredModels = Object.values(this.models.snapshot().routes)
      .filter((route) => route.provider === "chatgpt")
      .map((route) => route.model)
      .filter((model): model is string => Boolean(model));
    const model = configuredModels.find((candidate) => availableModels.includes(candidate))
      ?? availableModels.find((candidate) => candidate.startsWith("gpt-"))
      ?? availableModels[0];
    if (!model) throw new OpenAICCError("Codex returned no model suitable for the retry probe.", 502, "retry_model_unavailable");

    const request: Record<string, unknown> = {
      model,
      stream: false,
      input: "Reply with exactly: ok",
    };

    try {
      const response = await requireSuccessfulChatGptResponse(await boundary.responses(request), request);
      const payload = await response.json() as any;
      if (payload?.status && payload.status !== "completed") {
        throw new OpenAICCError(`Codex retry probe returned status ${String(payload.status)}.`, 502, "retry_incomplete");
      }
      const record = await this.store.markRetrySucceeded(id);
      return { ok: true, model, credential: publicCredential(record), message: "Retry succeeded. This credential is usable now." };
    } catch (error: unknown) {
      if (error instanceof ChatGptUpstreamError && error.status === 429) {
        const reset = chatGptRateLimitReset(error);
        const record = await this.store.markRateLimited(id, error.message, reset?.cooldownMs);
        return {
          ok: false,
          model,
          credential: publicCredential(record),
          status: "exhausted",
          resetAt: reset?.resetAt,
          window: reset?.window,
          message: reset
            ? `Still rate-limited. Codex reports reset at ${reset.resetAt}.`
            : "Still rate-limited. Codex did not report a reset time; it will stay exhausted until you Retry again.",
        };
      }
      if (error instanceof ChatGptUpstreamError && error.status === 401) {
        const record = await this.store.markAuthError(id, error.message);
        return { ok: false, model, credential: publicCredential(record), status: "auth_error", message: "Retry failed authentication. Re-authenticate this account." };
      }
      throw error;
    }
  }

  private handleEventStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(this.adminState())}\n\n`);
    this.eventStreams.add(res);
    req.on("close", () => this.eventStreams.delete(res));
  }

  private broadcast(type: string, data: unknown): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of this.eventStreams) response.write(payload);
  }

  private assertAdminAccess(req: IncomingMessage): void {
    if (!this.allowRemoteAdmin && !isLoopbackHost(this.bindHost)) {
      throw new OpenAICCError("Admin UI is disabled because the gateway is bound to a non-loopback host. Set OPENAI_CC_UNSAFE_REMOTE_ADMIN=1 only if you intentionally provide separate network protections.", 403, "remote_admin_disabled");
    }
    if (!this.allowRemoteAdmin) {
      const remote = normalizeAddress(req.socket.remoteAddress);
      if (remote && !isLoopbackAddress(remote)) throw new OpenAICCError("Admin access is loopback-only.", 403, "admin_loopback_only");
      const host = hostName(req.headers.host);
      if (!host || !isLoopbackHost(host)) throw new OpenAICCError("Admin requests require a loopback Host header.", 403, "invalid_admin_host");
    }
  }

  private assertAdminMutation(req: IncomingMessage): void {
    const type = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (type !== "application/json") throw new OpenAICCError("Admin mutations require Content-Type: application/json.", 415, "unsupported_media_type");
    const origin = req.headers.origin;
    const csrfValid = req.headers["x-openai-cc-csrf"] === this.csrfToken;
    if (origin) {
      let parsed: URL;
      try { parsed = new URL(origin); } catch { throw new OpenAICCError("Invalid Origin header.", 403, "invalid_origin"); }
      const requestHost = String(req.headers.host ?? "").toLowerCase();
      if (!requestHost || parsed.host.toLowerCase() !== requestHost) throw new OpenAICCError("Cross-origin Admin mutation rejected.", 403, "invalid_origin");
      if (!this.allowRemoteAdmin && (!isLoopbackHost(parsed.hostname) || parsed.protocol !== "http:")) {
        throw new OpenAICCError("Cross-origin Admin mutation rejected.", 403, "invalid_origin");
      }
      if (this.allowRemoteAdmin && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new OpenAICCError("Unsupported Admin Origin scheme.", 403, "invalid_origin");
      }
      if (!csrfValid) throw new OpenAICCError("Missing or invalid Admin anti-CSRF token.", 403, "invalid_csrf");
    } else if (this.allowRemoteAdmin) {
      if (!csrfValid) throw new OpenAICCError("Remote Admin mutations require the anti-CSRF token.", 403, "invalid_csrf");
    } else if (req.headers["x-openai-cc-csrf"] && !csrfValid) {
      throw new OpenAICCError("Invalid Admin anti-CSRF token.", 403, "invalid_csrf");
    }
  }

  private sendError(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (error instanceof OpenAICCError) {
      json(res, error.status, { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
      return;
    }
    const upstreamStatus = upstreamHttpStatus(error);
    if (upstreamStatus !== undefined) {
      json(res, upstreamStatus, { error: { code: "upstream_error", message: sanitizeUpstreamMessage(error) } });
      return;
    }
    json(res, 500, { error: { code: "internal_error", message: "Internal server error." } });
  }
}

function cleanAdminPage(page: string): string {
  return page
    .replace("Selecting a discovered model seeds its reported context when available.", "")
    .replace(",reported=meta?.contextWindow", "")
    .replace("<span>API reported: <strong>'+(reported?Number(reported).toLocaleString()+' tokens':'Not reported')+'</strong></span>", "")
    .replace("function seedDiscoveredLimits(slot,provider,modelId,replaceContext){const meta=findModel(provider,modelId),ctx=document.querySelector('#ctx-'+slot),out=document.querySelector('#o-'+slot);if(meta?.contextWindow&&ctx&&(replaceContext||!Number(ctx.value)))ctx.value=String(meta.contextWindow);if(meta?.maxOutputTokens&&out&&Number(out.value)>meta.maxOutputTokens)out.value=String(meta.maxOutputTokens)}", "function seedDiscoveredLimits(){}");
}

function upstreamHttpStatus(error: unknown): number | undefined {
  const value = error as any;
  const status = Number(value?.status ?? value?.statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 599) return undefined;
  return status;
}

function sanitizeUpstreamMessage(error: unknown): string {
  const value = error as any;
  const raw = value?.error?.message ?? value?.message ?? "The upstream provider rejected the request.";
  return String(raw)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .slice(0, 1200);
}

async function readJson<T = unknown>(req: IncomingMessage, maxBytes: number, requireJson: boolean): Promise<T> {
  if (requireJson) {
    const type = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (type !== "application/json") throw new OpenAICCError("Expected application/json.", 415, "unsupported_media_type");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new OpenAICCError("Request body too large.", 413, "body_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw new OpenAICCError("Request body is not valid JSON.", 400, "invalid_json"); }
}

function send(res: ServerResponse, status: number, body: string): void { res.statusCode = status; res.end(body); }
function json(res: ServerResponse, status: number, body: unknown): void { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }
function html(res: ServerResponse, body: string): void { res.statusCode = 200; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(body); }

function setGatewayCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin === "http://127.0.0.1" || origin === "http://localhost") res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "authorization,content-type,x-api-key,anthropic-version,anthropic-beta");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function setAdminSecurityHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
}

function safeUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "127.0.0.1";
  try { return new URL(req.url ?? "/", `http://${host}`); }
  catch { return new URL(req.url ?? "/", "http://127.0.0.1"); }
}

function credentialIdFromPath(pathname: string): string {
  const id = decodeURIComponent(pathname.split("/")[3]);
  validateId(id);
  return id;
}

function providerIdFromPath(pathname: string): string {
  const id = decodeURIComponent(pathname.split("/")[3]);
  if (!/^custom-[a-f0-9]{12}$/.test(id)) throw new OpenAICCError("Invalid custom provider id.", 400, "invalid_provider");
  return id;
}

function isMutation(method: string | undefined): boolean { return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE"; }
function hostName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(`http://${value}`).hostname; } catch { return undefined; }
}
function normalizeAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}
function isLoopbackAddress(value: string): boolean { return value === "127.0.0.1" || value === "::1" || value.startsWith("127."); }
function isLoopbackHost(value: string): boolean {
  const normalized = String(value).replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}
