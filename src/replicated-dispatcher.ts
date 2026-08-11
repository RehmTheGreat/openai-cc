import http, { IncomingMessage, ServerResponse } from "node:http";
import OpenAI from "openai";
import { AccountRecord, AccountStore } from "./account-store.js";
import {
  ChatGptOAuthBoundary,
  ChatGptUpstreamError,
  createChatGptOAuthBoundary,
  readJsonSse,
  requireSuccessfulChatGptResponse,
} from "./chatgpt-oauth.js";
import { AnthropicChatSseTranslator, anthropicToChatCompletions, chatCompletionToAnthropic } from "./chat-translator.js";
import { Dispatcher, DispatcherOptions } from "./dispatcher.js";
import { anthropicToFccResponses, ResponsesConversionError } from "./fcc-responses.js";
import { ModelConfigStore } from "./model-config.js";
import { providerBaseUrl } from "./provider-registry.js";
import {
  AnthropicRequest,
  AnthropicSseTranslator,
  OpenAIToolNameCodec,
  responsesToAnthropic,
} from "./translator.js";
import { upstreamApiFor } from "./upstream-api.js";

const MESSAGE_BODY_LIMIT = 32 * 1024 * 1024;

type UpstreamClient = OpenAI | ChatGptOAuthBoundary;

/**
 * Production dispatcher wrapper. Non-inference endpoints continue to use the
 * battle-tested control-plane Dispatcher. /v1/messages is isolated here so the
 * ChatGPT path can exactly follow openai-oauth's raw transport contract.
 */
export class ReplicatedDispatcher {
  private readonly controlPlane: Dispatcher;
  private readonly clients = new Map<string, UpstreamClient>();
  private readonly clientFactory?: (account: AccountRecord) => any;

  constructor(
    private readonly store: AccountStore,
    private readonly models: ModelConfigStore,
    options: DispatcherOptions = {},
  ) {
    this.controlPlane = new Dispatcher(store, models, options);
    this.clientFactory = options.clientFactory;
    store.on("event", () => this.clients.clear());
  }

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = safePath(req);
    if (req.method !== "POST" || pathname !== "/v1/messages") {
      return this.controlPlane.handler(req, res);
    }

    try {
      await this.handleMessages(req, res);
    } catch (error) {
      this.sendMessageError(res, error);
    }
  };

  async close(): Promise<void> {
    this.clients.clear();
    await this.controlPlane.close();
  }

  private async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<AnthropicRequest>(req, MESSAGE_BODY_LIMIT);
    const route = this.models.routeForRequestedModel(body.model);
    const requestedMaxTokens = Number(body.max_tokens) || route.maxOutputTokens;
    const routedBody: AnthropicRequest = {
      ...body,
      max_tokens: Math.max(1, Math.min(Math.floor(requestedMaxTokens), route.maxOutputTokens)),
    };
    const toolNames = OpenAIToolNameCodec.fromRequest(routedBody);
    const attempted = new Set<string>();
    let account = this.models.credentialForRequestedModel(body.model, attempted);
    if (!account) {
      const health = this.models.healthFor(this.models.slotForRequestedModel(body.model));
      const code = route.credentialId ? "pinned_credential_unavailable" : "no_ready_credential";
      return void anthropicError(res, 409, "api_error", `${code}: ${health.message}`);
    }

    while (account && !attempted.has(account.id)) {
      attempted.add(account.id);
      await this.store.noteRequest(account.id);
      const model = route.model || account.model || body.model;

      try {
        if (account.provider === "chatgpt") {
          // Preserve the proven Terra path exactly: FCC translation -> raw
          // Evan/openai-oauth-compatible Codex transport -> /responses.
          const boundary = this.clientFor(account) as ChatGptOAuthBoundary;
          const requestBody = {
            ...anthropicToFccResponses(routedBody, toolNames),
            model,
            stream: Boolean(body.stream),
          } as Record<string, unknown>;
          const response = await requireSuccessfulChatGptResponse(
            await boundary.responses(requestBody),
            requestBody,
          );

          if (body.stream) {
            const translator = new AnthropicSseTranslator(body.model, toolNames);
            let wrote = false;
            for await (const event of readJsonSse(response)) {
              for (const chunk of translator.accept(event)) {
                if (!wrote) { beginSse(res); wrote = true; }
                res.write(chunk);
              }
            }
            if (!wrote) beginSse(res);
            if (!res.writableEnded) res.end();
            return;
          }

          const responseBody = await response.json();
          return void json(res, 200, responsesToAnthropic(responseBody, body.model, toolNames));
        }

        const client = this.clientFor(account) as OpenAI;
        if (upstreamApiFor(account.provider, model) === "responses") {
          const upstream = { ...anthropicToFccResponses(routedBody, toolNames), model };
          if (body.stream) {
            const stream = await client.responses.create({ ...upstream, stream: true } as any);
            const translator = new AnthropicSseTranslator(body.model, toolNames);
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
          return void json(res, 200, responsesToAnthropic(response, body.model, toolNames));
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
            return void streamTerminalError(res, "authentication_error", "The configured credential failed authentication after streaming began. Re-authenticate it before retrying.");
          }
          account = await this.models.markAuthErrorAndNext(body.model, account, upstreamMessage, attempted);
          if (!account) {
            const message = route.credentialId
              ? "The pinned credential failed authentication; pinned routes do not fall back."
              : `All ready ${route.provider} credentials for this model slot failed authentication or are unavailable.`;
            return void anthropicError(res, 401, "authentication_error", message);
          }
          continue;
        }

        if (isRateLimit(error)) {
          const cooldown = rateLimitCooldownMs(error, account);
          if (res.headersSent) {
            await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);
            return void streamTerminalError(res, "rate_limit_error", "The configured credential hit a limit after streaming began. The next request may use another eligible credential.");
          }
          account = await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);
          if (!account) {
            const message = route.credentialId
              ? "The pinned credential is rate-limited; pinned routes do not fall back."
              : `All ready ${route.provider} credentials for this model slot are rate-limited.`;
            return void anthropicError(res, 429, "rate_limit_error", message);
          }
          continue;
        }
        throw error;
      }
    }
  }

  private clientFor(account: AccountRecord): UpstreamClient {
    const cached = this.clients.get(account.id);
    if (cached) return cached;

    let client: UpstreamClient;
    if (account.provider === "chatgpt") {
      // Never allow test/injection hooks to replace the raw ChatGPT OAuth
      // boundary: this is the production Terra transport invariant.
      if (!account.authFile) throw new Error(`ChatGPT credential ${account.id} has no auth file.`);
      client = createChatGptOAuthBoundary(account.authFile);
    } else if (this.clientFactory) {
      client = this.clientFactory(account) as OpenAI;
    } else {
      if (!account.apiKey) throw new Error(`${account.provider} credential ${account.id} has no API key.`);
      client = new OpenAI({ apiKey: account.apiKey, baseURL: providerBaseUrl(account) });
    }
    this.clients.set(account.id, client);
    return client;
  }

  private sendMessageError(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      streamTerminalError(res, "api_error", sanitizeError(error));
      return;
    }
    if (error instanceof ResponsesConversionError) {
      anthropicError(res, 400, "invalid_request_error", error.message);
      return;
    }
    const status = upstreamHttpStatus(error) ?? 500;
    const type = status === 400 ? "invalid_request_error"
      : status === 401 ? "authentication_error"
      : status === 429 ? "rate_limit_error"
      : "api_error";
    anthropicError(res, status, type, sanitizeError(error));
  }
}

export function createReplicatedServer(
  store: AccountStore,
  models: ModelConfigStore,
  options: DispatcherOptions = {},
): http.Server {
  const dispatcher = new ReplicatedDispatcher(store, models, options);
  const server = http.createServer((req, res) => { void dispatcher.handler(req, res); });
  server.on("close", () => { void dispatcher.close(); });
  return server;
}

function isAuthenticationError(error: any): boolean {
  return error?.status === 401 || error?.statusCode === 401;
}

function isRateLimit(error: any): boolean {
  return error?.status === 429 || error?.statusCode === 429 || /\b429\b|rate.?limit|usage.?limit|quota/i.test(error?.message ?? "");
}

function rateLimitCooldownMs(error: any, account: AccountRecord): number | undefined {
  if (account.provider === "chatgpt") return undefined;
  const retryAfter = headerValue(error?.headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  const text = `${error?.message ?? ""} ${JSON.stringify(error?.error ?? {})}`;
  const secondsMatch = text.match(/(?:retry|try again)[^\d]{0,20}(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  return secondsMatch ? Math.ceil(Number(secondsMatch[1]) * 1000) : undefined;
}

function upstreamHttpStatus(error: unknown): number | undefined {
  const value = error as any;
  const status = Number(value?.status ?? value?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

function sanitizeError(error: unknown): string {
  if (error instanceof ChatGptUpstreamError) return error.message;
  const value = error as any;
  const raw = value?.error?.message ?? value?.message ?? "The upstream provider rejected the request.";
  return String(raw)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .slice(0, 1600);
}

function headerValue(headers: any, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? String(value[0]) : value !== undefined ? String(value) : undefined;
}

function safePath(req: IncomingMessage): string {
  try { return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).pathname; }
  catch { return req.url?.split("?", 1)[0] ?? "/"; }
}

async function readJson<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw Object.assign(new Error("Request body too large."), { status: 413 });
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw Object.assign(new Error("Request body is not valid JSON."), { status: 400 }); }
}

function beginSse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

function streamTerminalError(res: ServerResponse, type: string, message: string): void {
  if (res.writableEnded) return;
  if (!res.headersSent) beginSse(res);
  res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`);
  res.end();
}

function anthropicError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
