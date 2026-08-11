import { createOpenAIOAuthTransport, type FetchFunction, type OpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";

export interface ChatGptOAuthBoundaryOptions {
  fetch?: FetchFunction;
  codexVersion?: string;
}

export interface ResponsesRequestSummary {
  model?: string;
  bodyKeys: string[];
  inputTypes: string[];
  toolCount: number;
  stream: boolean;
}

export class ChatGptUpstreamError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly summary: ResponsesRequestSummary;
  readonly upstreamMessage: string;

  constructor(status: number, summary: ResponsesRequestSummary, upstreamMessage: string) {
    const diagnostic = [
      `ChatGPT Codex upstream HTTP ${status}.`,
      summary.model ? `model=${summary.model}` : "model=<missing>",
      `keys=${summary.bodyKeys.join(",") || "<none>"}`,
      `inputTypes=${summary.inputTypes.join(",") || "<none>"}`,
      `tools=${summary.toolCount}`,
      `stream=${summary.stream}`,
      `upstream=${upstreamMessage || "<empty body>"}`,
    ].join(" ");
    super(diagnostic);
    this.name = "ChatGptUpstreamError";
    this.status = status;
    this.statusCode = status;
    this.summary = summary;
    this.upstreamMessage = upstreamMessage;
  }
}

export interface ChatGptOAuthBoundary {
  readonly transport: OpenAIOAuthTransport;
  listModels(): Promise<string[]>;
  responses(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
}

/**
 * This is intentionally the same boundary used by EvanZhouDev/openai-oauth:
 * local Codex auth.json -> createOpenAIOAuthTransport -> raw /models and
 * /responses requests. OpenAI-CC does not add another OpenAI SDK serializer or
 * private-Codex compatibility layer on top of it.
 */
export function createChatGptOAuthBoundary(
  authFilePath: string,
  options: ChatGptOAuthBoundaryOptions = {},
): ChatGptOAuthBoundary {
  const credentials = openaiCredentials({
    authFilePath,
    fetch: options.fetch,
  });
  const transport = createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    responsesState: false,
    fetch: options.fetch,
    codexVersion: options.codexVersion,
  });

  return {
    transport,
    async listModels(): Promise<string[]> {
      // Mirrors openai-oauth/packages/openai-oauth/src/models.ts.
      const response = await transport.request("/models");
      const bodyText = await response.text();
      if (!response.ok) throw new Error(readSafeUpstreamMessage(bodyText) || `Codex models HTTP ${response.status}.`);
      let parsed: unknown;
      try { parsed = JSON.parse(bodyText); } catch { throw new Error("Codex returned an invalid models response."); }
      if (!isRecord(parsed) || !Array.isArray(parsed.data)) throw new Error("Codex returned a malformed models response.");
      const models = [...new Set(parsed.data
        .map((model) => isRecord(model) ? model.id : undefined)
        .filter((id): id is string => typeof id === "string" && id.length > 0))];
      if (!models.length) throw new Error("Codex returned an empty models list.");
      return models;
    },
    async responses(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
      // Mirrors openai-oauth/packages/openai-oauth/src/responses.ts. The full
      // conversation must be replayed because the transport is stateless.
      if (usesServerReplayState(body)) {
        throw new Error("Stateless Codex responses endpoint does not support previous_response_id or item_reference. Replay the full conversation history in input on each request.");
      }
      return transport.request("/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    },
  };
}

export async function requireSuccessfulChatGptResponse(
  response: Response,
  request: Record<string, unknown>,
): Promise<Response> {
  if (response.ok) return response;
  const bodyText = await response.text();
  throw new ChatGptUpstreamError(response.status, summarizeResponsesRequest(request), readSafeUpstreamMessage(bodyText));
}

export function summarizeResponsesRequest(body: Record<string, unknown>): ResponsesRequestSummary {
  const input = Array.isArray(body.input) ? body.input : [];
  const inputTypes = [...new Set(input.map((item) => {
    if (!isRecord(item)) return typeof item;
    if (typeof item.type === "string") return item.type;
    if (typeof item.role === "string") return `role:${item.role}`;
    return "object";
  }))];
  return {
    model: typeof body.model === "string" ? body.model : undefined,
    bodyKeys: Object.keys(body).sort(),
    inputTypes,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    stream: body.stream === true,
  };
}

export async function* readJsonSse(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    if (done) buffer += decoder.decode();

    let boundary = nextSseBoundary(buffer);
    while (boundary) {
      const rawEvent = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const parsed = parseSseEvent(rawEvent);
      if (parsed) yield parsed;
      boundary = nextSseBoundary(buffer);
    }
    if (done) break;
  }

  const trailing = parseSseEvent(buffer);
  if (trailing) yield trailing;
}

function usesServerReplayState(body: Record<string, unknown>): boolean {
  if (typeof body.previous_response_id === "string") return true;
  return Array.isArray(body.input) && body.input.some((item) =>
    isRecord(item) && item.type === "item_reference" && typeof item.id === "string");
}

function nextSseBoundary(value: string): { index: number; length: number } | undefined {
  const crlf = value.indexOf("\r\n\r\n");
  const lf = value.indexOf("\n\n");
  if (crlf < 0 && lf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseSseEvent(raw: string): Record<string, unknown> | undefined {
  const data = raw.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed = JSON.parse(data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readSafeUpstreamMessage(bodyText: string): string {
  if (!bodyText.trim()) return "<empty body>";
  try {
    const parsed = JSON.parse(bodyText);
    if (isRecord(parsed)) {
      const direct = firstString(parsed.message, parsed.detail);
      if (direct) return redact(direct);
      if (isRecord(parsed.error)) {
        const nested = firstString(parsed.error.message, parsed.error.detail, parsed.error.code);
        if (nested) return redact(nested);
      }
    }
  } catch { }
  // Do not echo arbitrary upstream bodies because they may contain request text.
  return "<non-JSON or unstructured body omitted>";
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .slice(0, 800);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
