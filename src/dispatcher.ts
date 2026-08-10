import { randomBytes } from "node:crypto";
import http, { IncomingMessage, ServerResponse } from "node:http";
import OpenAI from "openai";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";
import { AccountRecord, AccountStore, ApiProviderKind, ProviderKind, publicCredential, validateId } from "./account-store.js";
import { ChatGptAuthRunner, OfficialCodexAuthRunner } from "./chatgpt-auth.js";
import { claudeDesktopModel, claudeDesktopModelList } from "./claude-desktop.js";
import { AnthropicRequest, AnthropicSseTranslator, anthropicToResponses, estimateAnthropicTokens, responsesToAnthropic } from "./translator.js";
import { AnthropicChatSseTranslator, anthropicToChatCompletions, chatCompletionToAnthropic } from "./chat-translator.js";
import { MODEL_SLOTS, ModelConfigStore } from "./model-config.js";
import { OpenAICCError, conflict } from "./errors.js";
import { adminPage } from "./admin/page.js";

type ApiProvider = Exclude<ProviderKind, "chatgpt">;
const MESSAGE_BODY_LIMIT = 32 * 1024 * 1024;
const ADMIN_BODY_LIMIT = 64 * 1024;

export interface DispatcherOptions {
  authRunner?: ChatGptAuthRunner;
  bindHost?: string;
  allowRemoteAdmin?: boolean;
  clientFactory?: (account: AccountRecord) => any;
}

export class Dispatcher {
  private readonly clients = new Map<string, any>();
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly authRunner: ChatGptAuthRunner;
  private readonly csrfToken = randomBytes(32).toString("base64url");
  private readonly cspNonce = randomBytes(18).toString("base64url");
  private readonly bindHost: string;
  private readonly allowRemoteAdmin: boolean;
  private readonly clientFactory?: (account: AccountRecord) => any;

  constructor(
    private readonly store: AccountStore,
    private readonly models: ModelConfigStore,
    options: DispatcherOptions = {},
  ) {
    this.bindHost = options.bindHost ?? "127.0.0.1";
    this.allowRemoteAdmin = options.allowRemoteAdmin ?? process.env.OPENAI_CC_UNSAFE_REMOTE_ADMIN === "1";
    this.clientFactory = options.clientFactory;
    this.authRunner = options.authRunner ?? new OfficialCodexAuthRunner(store);
    store.on("event", (event) => this.broadcast(event.type, event));
    models.on("event", (event) => this.broadcast(event.type, event));
    this.authRunner.on("job", (job) => {
      if (job.status === "complete") this.clients.delete(job.credentialId);
      this.broadcast("auth_job_changed", job);
    });
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
        }));
      }
      if (req.method === "GET" && /^\/v1\/models\/[^/]+$/.test(url.pathname)) {
        const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
        const model = claudeDesktopModel(this.models.snapshot(), modelId);
        return void json(res, model ? 200 : 404, model ?? { error: { type: "not_found_error", message: `Model not found: ${modelId}` } });
      }
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const body = await readJson<AnthropicRequest>(req, MESSAGE_BODY_LIMIT, false);
        return void json(res, 200, { input_tokens: estimateAnthropicTokens(body) });
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") return void await this.handleMessages(req, res);

      if (req.method === "GET" && url.pathname === "/admin") return void html(res, adminPage(this.csrfToken, this.cspNonce));
      if (req.method === "GET" && url.pathname === "/admin/state") return void json(res, 200, this.adminState());
      if (req.method === "GET" && url.pathname === "/admin/events") return void this.handleEventStream(req, res);
      if (req.method === "POST" && url.pathname === "/admin/model-config") {
        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);
        const modelConfig = await this.models.update(body);
        return void json(res, 200, { modelConfig, routeHealth: this.models.health() });
      }
      if (req.method === "POST" && url.pathname === "/admin/chatgpt/auth") {
        const body = await readJson<{ id?: string; name?: string; loginMode?: string }>(req, ADMIN_BODY_LIMIT, true);
        const job = await this.authRunner.start({
          credentialId: String(body.id ?? "").trim(),
          displayName: String(body.name ?? "").trim(),
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
        const body = await readJson<{ id?: string; name?: string; provider?: string; apiKey?: string; model?: string }>(req, ADMIN_BODY_LIMIT, true);
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
        this.clients.delete(id);
        return void json(res, 200, { ok: true });
      }
      if (req.method === "POST" && /^\/admin\/credentials\/[^/]+\/(prefer|disable|enable)$/.test(url.pathname)) {
        await readJson(req, ADMIN_BODY_LIMIT, true);
        const id = credentialIdFromPath(url.pathname);
        const action = url.pathname.split("/")[4];
        const record = action === "prefer" ? await this.store.prefer(id) : action === "disable" ? await this.store.disable(id) : await this.store.enable(id);
        return void json(res, 200, publicCredential(record));
      }
      if (req.method === "POST" && /^\/admin\/credentials\/[^/]+\/reauth$/.test(url.pathname)) {
        const id = credentialIdFromPath(url.pathname);
        const body = await readJson<{ loginMode?: string; name?: string }>(req, ADMIN_BODY_LIMIT, true);
        const existing = this.store.get(id);
        if (!existing) throw new OpenAICCError(`Unknown credential: ${id}`, 404, "credential_not_found");
        const job = await this.authRunner.start({
          credentialId: id,
          displayName: String(body.name ?? existing.name),
          mode: "reauth",
          loginMode: body.loginMode === "device" ? "device" : "browser",
        });
        return void json(res, 202, job);
      }
      if (req.method === "POST" && /^\/admin\/credentials\/[^/]+\/replace-key$/.test(url.pathname)) {
        const id = credentialIdFromPath(url.pathname);
        const body = await readJson<{ apiKey?: string; model?: string; name?: string }>(req, ADMIN_BODY_LIMIT, true);
        const record = await this.store.replaceApiKey(id, { apiKey: String(body.apiKey ?? ""), model: body.model, name: body.name });
        this.clients.delete(id);
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
    return { ...this.store.snapshot(), modelConfig: this.models.snapshot(), routeHealth: this.models.health() };
  }

  private async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<AnthropicRequest>(req, MESSAGE_BODY_LIMIT, false);
    const route = this.models.routeForRequestedModel(body.model);
    const requestedMaxTokens = Number(body.max_tokens) || route.maxOutputTokens;
    const routedBody: AnthropicRequest = {
      ...body,
      max_tokens: Math.max(1, Math.min(Math.floor(requestedMaxTokens), route.maxOutputTokens)),
    };
    const attempted = new Set<string>();
    let account = this.models.credentialForRequestedModel(body.model, attempted);
    if (!account) {
      const health = this.models.healthFor(this.models.slotForRequestedModel(body.model));
      const code = route.credentialId ? "pinned_credential_unavailable" : "no_ready_credential";
      return void json(res, 409, { error: { type: "handoff_required", code, message: health.message } });
    }

    while (account && !attempted.has(account.id)) {
      attempted.add(account.id);
      await this.store.noteRequest(account.id);
      const client = this.clientFor(account);
      const model = route.model || account.model || body.model;
      try {
        if (usesResponsesApi(account)) {
          const upstream = { ...anthropicToResponses(routedBody), model } as any;
          if (body.stream) {
            const stream = await client.responses.create({ ...upstream, stream: true });
            const translator = new AnthropicSseTranslator(body.model);
            let wrote = false;
            for await (const event of stream as any) {
              for (const chunk of translator.accept(event)) {
                if (!wrote) { beginSse(res); wrote = true; }
                res.write(chunk);
              }
            }
            if (!wrote) beginSse(res);
            if (!res.writableEnded) res.end();
            return;
          }
          const response = await client.responses.create({ ...upstream, stream: false } as any);
          return void json(res, 200, responsesToAnthropic(response, body.model));
        }

        const upstream = anthropicToChatCompletions(routedBody, model) as any;
        if (body.stream) {
          const stream = await client.chat.completions.create({ ...upstream, stream: true });
          const translator = new AnthropicChatSseTranslator(body.model);
          let wrote = false;
          for await (const chunk of stream as any) {
            for (const out of translator.accept(chunk)) {
              if (!wrote) { beginSse(res); wrote = true; }
              res.write(out);
            }
          }
          if (!wrote) beginSse(res);
          if (!res.writableEnded) res.end();
          return;
        }
        const response = await client.chat.completions.create({ ...upstream, stream: false } as any);
        return void json(res, 200, chatCompletionToAnthropic(response, body.model));
      } catch (error: any) {
        if (isAuthenticationError(error)) {
          const upstreamMessage = error?.message ?? "Upstream authentication failed.";
          if (res.headersSent) {
            await this.models.markAuthErrorAndNext(body.model, account, upstreamMessage, attempted);
            if (!res.writableEnded) {
              res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "authentication_error", message: "The configured credential failed authentication after streaming began; no partial response was replayed. Re-authenticate or replace the credential. The next request may use another eligible credential." } })}\n\n`);
              res.end();
            }
            return;
          }
          account = await this.models.markAuthErrorAndNext(body.model, account, upstreamMessage, attempted);
          if (!account) {
            const message = route.credentialId ? "The pinned credential failed authentication; pinned routes do not fall back." : `All ready ${route.provider} credentials for this model slot failed authentication or are unavailable.`;
            return void json(res, 401, { error: { type: "authentication_error", message } });
          }
          continue;
        }
        if (!isRateLimit(error)) throw error;
        const cooldown = rateLimitCooldownMs(error, account);
        if (res.headersSent) {
          await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);
          if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "The configured credential hit a limit after streaming began; no partial response was replayed. The next request will use the next eligible credential." } })}\n\n`);
            res.end();
          }
          return;
        }
        account = await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);
        if (!account) {
          const message = route.credentialId ? "The pinned credential is rate-limited; pinned routes do not fall back." : `All ready ${route.provider} credentials for this model slot are rate-limited.`;
          return void json(res, 429, { error: { type: "rate_limit_error", message } });
        }
      }
    }
  }

  private async addApiKey(input: { id?: string; name?: string; provider?: string; apiKey?: string; model?: string }): Promise<AccountRecord> {
    const id = String(input.id ?? "").trim();
    const name = String(input.name ?? id).trim();
    const provider = String(input.provider ?? "").trim().toLowerCase();
    const apiKey = String(input.apiKey ?? "").trim();
    const model = String(input.model ?? "").trim();
    if (!id) throw new OpenAICCError("Credential id is required.", 400, "credential_id_required");
    validateId(id);
    if (!isApiProvider(provider)) throw new OpenAICCError("Provider must be zen, nvidia, or google.", 400, "invalid_provider");
    const record = await this.store.createApiKey({ id, name, provider, apiKey, model });
    this.clients.delete(id);
    return record;
  }

  private clientFor(account: AccountRecord): any {
    const cached = this.clients.get(account.id);
    if (cached) return cached;
    if (this.clientFactory) {
      const client = this.clientFactory(account);
      this.clients.set(account.id, client);
      return client;
    }
    const provider = account.provider;
    let client: OpenAI;
    if (provider === "chatgpt") {
      if (!account.authFile) throw new OpenAICCError(`ChatGPT credential ${account.id} has no auth file.`, 409, "missing_auth_file");
      const credentials = openaiCredentials({ authFilePath: account.authFile });
      const transport = createOpenAIOAuthTransport({ auth: () => credentials.getSession() });
      client = new OpenAI({ apiKey: "openai-oauth", baseURL: transport.baseURL, fetch: transport.fetch });
    } else {
      if (!account.apiKey) throw new OpenAICCError(`${provider} credential ${account.id} has no API key.`, 409, "missing_api_key");
      client = new OpenAI({ apiKey: account.apiKey, baseURL: providerBaseUrl(provider) });
    }
    this.clients.set(account.id, client);
    return client;
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
    json(res, 500, { error: { code: "internal_error", message: "Internal server error." } });
  }
}

export function createServer(store: AccountStore, models: ModelConfigStore, options: DispatcherOptions = {}): http.Server {
  const dispatcher = new Dispatcher(store, models, options);
  const server = http.createServer((req, res) => { void dispatcher.handler(req, res); });
  server.on("close", () => { void dispatcher.close(); });
  return server;
}

function providerBaseUrl(provider: ApiProvider): string {
  if (provider === "zen") return "https://opencode.ai/zen/v1";
  if (provider === "nvidia") return "https://integrate.api.nvidia.com/v1";
  return "https://generativelanguage.googleapis.com/v1beta/openai/";
}
function usesResponsesApi(account: AccountRecord): boolean { return account.provider === "chatgpt" || account.provider === "zen"; }
function isApiProvider(value: string): value is ApiProviderKind { return value === "zen" || value === "nvidia" || value === "google"; }
function isAuthenticationError(error: any): boolean { return error?.status === 401 || error?.statusCode === 401; }
function isRateLimit(error: any): boolean { return error?.status === 429 || error?.statusCode === 429 || /\b429\b|rate.?limit|usage.?limit|quota/i.test(error?.message ?? ""); }
function rateLimitCooldownMs(error: any, account: AccountRecord): number | undefined {
  if (account.provider === "chatgpt") return undefined;
  const retryAfter = headerValue(error?.headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter); if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter); if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  const text = `${error?.message ?? ""} ${JSON.stringify(error?.error ?? {})}`;
  const secondsMatch = text.match(/(?:retry|try again)[^\d]{0,20}(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  if (secondsMatch) return Math.ceil(Number(secondsMatch[1]) * 1000);
  return undefined;
}
function headerValue(headers: any, name: string): string | undefined {
  if (!headers) return undefined; if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? String(value[0]) : value !== undefined ? String(value) : undefined;
}
function beginSse(res: ServerResponse): void { res.statusCode = 200; res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive"); res.flushHeaders(); }
async function readJson<T = unknown>(req: IncomingMessage, maxBytes: number, requireJson: boolean): Promise<T> {
  if (requireJson) {
    const type = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (type !== "application/json") throw new OpenAICCError("Expected application/json.", 415, "unsupported_media_type");
  }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new OpenAICCError("Request body too large.", 413, "body_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { throw new OpenAICCError("Request body is not valid JSON.", 400, "invalid_json"); }
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
  try { return new URL(req.url ?? "/", `http://${host}`); } catch { return new URL(req.url ?? "/", "http://127.0.0.1"); }
}
function credentialIdFromPath(pathname: string): string {
  const id = decodeURIComponent(pathname.split("/")[3]);
  validateId(id);
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
