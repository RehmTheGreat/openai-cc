import { createHash, randomUUID } from "node:crypto";

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  metadata?: unknown;
  thinking?: { type?: string; budget_tokens?: number; display?: string };
  context_management?: unknown;
  output_config?: { effort?: string; [key: string]: unknown };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data?: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | Record<string, unknown>;

export interface AnthropicTextBlock { type: "text"; text: string; cache_control?: unknown }
export interface AnthropicTool { name: string; description?: string; input_schema: Record<string, unknown>; cache_control?: unknown }

export interface ResponsesRequest {
  model: string;
  input: unknown[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: "auto" };
  store?: boolean;
  include?: string[];
  stream: boolean;
}

const OPENAI_TOOL_NAME_MAX_LENGTH = 64;
const TOOL_ALIAS_DIGEST_LENGTH = 16;
const PORTABLE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const INVALID_TOOL_NAME_CHARACTERS = /[^A-Za-z0-9_-]+/g;

export class OpenAIToolNameCodec {
  private constructor(
    private readonly originalToAlias: Map<string, string>,
    private readonly aliasToOriginal: Map<string, string>,
  ) {}

  static fromRequest(req: AnthropicRequest): OpenAIToolNameCodec {
    const names = new Set<string>();
    for (const tool of req.tools ?? []) if (tool.name) names.add(tool.name);

    const choice = req.tool_choice as any;
    if (choice?.type === "tool" && typeof choice.name === "string") names.add(choice.name);
    if (choice?.type === "function" && typeof choice.function?.name === "string") names.add(choice.function.name);

    for (const message of req.messages ?? []) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "tool_use" && typeof (block as any).name === "string") names.add(String((block as any).name));
      }
    }
    return OpenAIToolNameCodec.fromNames(names);
  }

  static fromNames(names: Iterable<string>): OpenAIToolNameCodec {
    const unique = new Set([...names].filter(Boolean));
    const reserved = new Set([...unique].filter((name) => PORTABLE_TOOL_NAME.test(name)));
    const originalToAlias = new Map<string, string>();
    const aliasToOriginal = new Map<string, string>();

    for (const name of [...unique].filter((value) => !PORTABLE_TOOL_NAME.test(value)).sort()) {
      const alias = uniqueToolAlias(name, reserved);
      reserved.add(alias);
      originalToAlias.set(name, alias);
      aliasToOriginal.set(alias, name);
    }
    return new OpenAIToolNameCodec(originalToAlias, aliasToOriginal);
  }

  encode(name: string): string { return this.originalToAlias.get(name) ?? name; }
  decode(name: unknown): string {
    const value = typeof name === "string" ? name : "";
    return this.aliasToOriginal.get(value) ?? value;
  }
}

export function mapModel(model: string): string {
  const explicit = safeJson(process.env.MODEL_MAP_JSON) as Record<string, string> | undefined;
  if (explicit?.[model]) return explicit[model];
  if (explicit) {
    const match = Object.entries(explicit).find(([prefix]) => model.startsWith(prefix));
    if (match) return match[1];
  }
  return process.env.DEFAULT_OPENAI_MODEL || "gpt-5.6-sol";
}

export function anthropicToResponses(
  req: AnthropicRequest,
  toolNames: OpenAIToolNameCodec = OpenAIToolNameCodec.fromRequest(req),
): ResponsesRequest {
  const input: unknown[] = [];

  for (const message of req.messages ?? []) {
    const blocks: AnthropicBlock[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    const turnItems: unknown[] = [];
    const messageParts: unknown[] = [];
    const reasoningSummary: string[] = [];
    const encryptedReasoning: string[] = [];

    for (const block of blocks) {
      if (block.type === "text") {
        messageParts.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: String((block as AnthropicTextBlock).text ?? ""),
        });
      } else if (block.type === "image" && message.role === "user") {
        const source = (block as Extract<AnthropicBlock, { type: "image" }>).source;
        messageParts.push({ type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` });
      } else if (block.type === "tool_use" && message.role === "assistant") {
        flushMessage(message.role, messageParts, turnItems);
        const tool = block as Extract<AnthropicBlock, { type: "tool_use" }>;
        turnItems.push({
          type: "function_call",
          call_id: tool.id,
          name: toolNames.encode(tool.name),
          arguments: JSON.stringify(tool.input ?? {}),
        });
      } else if (block.type === "tool_result" && message.role === "user") {
        flushMessage(message.role, messageParts, turnItems);
        const result = block as Extract<AnthropicBlock, { type: "tool_result" }>;
        turnItems.push({
          type: "function_call_output",
          call_id: result.tool_use_id,
          output: toolResultToString(result.content, result.is_error),
        });
      } else if (block.type === "thinking" && message.role === "assistant") {
        const thinking = String((block as { thinking?: string }).thinking ?? "").trim();
        if (thinking) reasoningSummary.push(thinking);
      } else if (block.type === "redacted_thinking" && message.role === "assistant") {
        const encrypted = String((block as { data?: string }).data ?? "").trim();
        if (encrypted) encryptedReasoning.push(encrypted);
      }
    }
    flushMessage(message.role, messageParts, turnItems);

    if (message.role === "assistant" && (reasoningSummary.length || encryptedReasoning.length)) {
      const summary = reasoningSummary.map((text) => ({ type: "summary_text", text }));
      if (encryptedReasoning.length) {
        encryptedReasoning.forEach((encrypted_content, index) => input.push({
          type: "reasoning",
          summary: index === 0 ? summary : [],
          encrypted_content,
        }));
      } else {
        input.push({ type: "reasoning", summary });
      }
    }
    input.push(...turnItems);
  }

  const tools = req.tools?.map((tool) => ({
    type: "function",
    name: toolNames.encode(tool.name),
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));

  const out: ResponsesRequest = {
    model: mapModel(req.model),
    input,
    instructions: systemToString(req.system),
    max_output_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    tools: tools?.length ? tools : undefined,
    tool_choice: mapToolChoice(req.tool_choice, toolNames),
    stream: Boolean(req.stream),
  };

  const explicitEffort = normalizeReasoningEffort(req.output_config?.effort);
  if (explicitEffort) {
    out.reasoning = { effort: explicitEffort, summary: "auto" };
  } else if (req.thinking?.type === "enabled" || req.thinking?.type === "adaptive" || req.thinking?.budget_tokens) {
    out.reasoning = {
      ...(req.thinking?.budget_tokens ? { effort: budgetToEffort(req.thinking.budget_tokens) } : {}),
      summary: "auto",
    };
  }
  return stripUndefined(out);
}

/**
 * The ChatGPT subscription endpoint is the private Codex Responses backend, not
 * the public API. Match Codex/FCC semantics before handing the request to the
 * openai-oauth transport: stateless replay, encrypted reasoning, and no public
 * max-output field.
 */
export function prepareChatGptCodexRequest(request: ResponsesRequest): ResponsesRequest {
  const include = new Set(request.include ?? []);
  include.add("reasoning.encrypted_content");
  const out: ResponsesRequest = {
    ...request,
    store: false,
    include: [...include],
  };
  delete out.max_output_tokens;
  delete out.parallel_tool_calls;
  delete (out as any).metadata;
  return stripUndefined(out);
}

export function responsesToAnthropic(
  response: any,
  requestedModel: string,
  toolNames: OpenAIToolNameCodec = OpenAIToolNameCodec.fromNames([]),
) {
  const content: any[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
      }
    } else if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id ?? item.id ?? `toolu_${randomUUID()}`,
        name: toolNames.decode(item.name) || "tool",
        input: parseJsonObject(item.arguments),
      });
    } else if (item.type === "reasoning") {
      const summary = (item.summary ?? []).map((x: any) => x.text).filter(Boolean).join("\n");
      if (summary) content.push({ type: "thinking", thinking: summary, signature: "openai_reasoning_summary" });
      if (typeof item.encrypted_content === "string" && item.encrypted_content) {
        content.push({ type: "redacted_thinking", data: item.encrypted_content });
      }
    }
  }
  return {
    id: response.id ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}

type StreamBlock = {
  index: number;
  kind: "text" | "tool" | "thinking";
  callId?: string;
  name?: string;
  receivedDelta?: boolean;
  stopped?: boolean;
};

export class AnthropicSseTranslator {
  private nextIndex = 0;
  private blocks = new Map<string, StreamBlock>();
  private encryptedReasoning = new Map<string, string>();
  private messageId = `msg_${randomUUID()}`;
  private started = false;
  private usage = { input_tokens: 0, output_tokens: 0 };

  constructor(
    private readonly requestedModel: string,
    private readonly toolNames: OpenAIToolNameCodec = OpenAIToolNameCodec.fromNames([]),
  ) {}

  accept(event: any): string[] {
    if (event?.type === "response.failed" || event?.type === "response.error" || event?.type === "error") {
      const message = event?.response?.error?.message ?? event?.error?.message ?? event?.message ?? "OpenAI response failed.";
      throw new Error(String(message));
    }

    const out: string[] = [];
    this.ensureStarted(event, out);

    if (event.type === "response.output_item.added") {
      const item = event.item ?? {};
      const key = item.id ?? item.call_id ?? `item-${this.nextIndex}`;
      if (item.type === "function_call") {
        const index = this.nextIndex++;
        const name = this.toolNames.decode(item.name) || "tool";
        const block: StreamBlock = { index, kind: "tool", callId: item.call_id ?? item.id, name };
        this.blocks.set(key, block);
        out.push(sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: item.call_id ?? item.id ?? `toolu_${randomUUID()}`, name, input: {} },
        }));
      } else if (item.type === "reasoning") {
        if (typeof item.encrypted_content === "string" && item.encrypted_content) this.encryptedReasoning.set(key, item.encrypted_content);
      }
    }

    if (event.type === "response.output_text.delta") {
      const key = event.item_id ?? `message-${event.output_index ?? 0}`;
      let block = this.blocks.get(key);
      if (!block) {
        block = { index: this.nextIndex++, kind: "text" };
        this.blocks.set(key, block);
        out.push(sse("content_block_start", { type: "content_block_start", index: block.index, content_block: { type: "text", text: "" } }));
      }
      out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "text_delta", text: event.delta ?? "" } }));
    }

    if (event.type === "response.function_call_arguments.delta") {
      const key = event.item_id ?? event.call_id ?? `tool-${this.nextIndex}`;
      let block = this.blocks.get(key);
      if (!block) {
        const name = this.toolNames.decode(event.name) || "tool";
        block = { index: this.nextIndex++, kind: "tool", callId: event.call_id, name };
        this.blocks.set(key, block);
        out.push(sse("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "tool_use", id: event.call_id ?? `toolu_${randomUUID()}`, name, input: {} },
        }));
      }
      const delta = String(event.delta ?? "");
      if (delta) {
        block.receivedDelta = true;
        out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: delta } }));
      }
    }

    if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
      const key = event.item_id ?? `reasoning-${event.output_index ?? 0}`;
      let block = this.blocks.get(key);
      if (!block) {
        block = { index: this.nextIndex++, kind: "thinking" };
        this.blocks.set(key, block);
        out.push(sse("content_block_start", { type: "content_block_start", index: block.index, content_block: { type: "thinking", thinking: "" } }));
      }
      out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "thinking_delta", thinking: event.delta ?? "" } }));
    }

    if (event.type === "response.output_item.done") {
      const item = event.item ?? {};
      const key = item.id ?? item.call_id;
      let block = key ? this.blocks.get(key) : undefined;

      if (item.type === "function_call") {
        if (!block) {
          const name = this.toolNames.decode(item.name) || "tool";
          block = { index: this.nextIndex++, kind: "tool", callId: item.call_id ?? item.id, name };
          if (key) this.blocks.set(key, block);
          out.push(sse("content_block_start", {
            type: "content_block_start",
            index: block.index,
            content_block: { type: "tool_use", id: item.call_id ?? item.id ?? `toolu_${randomUUID()}`, name, input: {} },
          }));
        }
        if (!block.receivedDelta && typeof item.arguments === "string" && item.arguments) {
          out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: item.arguments } }));
        }
        if (!block.stopped) {
          out.push(sse("content_block_stop", { type: "content_block_stop", index: block.index }));
          block.stopped = true;
        }
      } else if (item.type === "reasoning") {
        if (block?.kind === "thinking" && !block.stopped) {
          out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: "openai_reasoning_summary" } }));
          out.push(sse("content_block_stop", { type: "content_block_stop", index: block.index }));
          block.stopped = true;
        }
        const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content
          ? item.encrypted_content
          : (key ? this.encryptedReasoning.get(key) : undefined);
        if (encrypted) {
          const index = this.nextIndex++;
          out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "redacted_thinking", data: encrypted } }));
          out.push(sse("content_block_stop", { type: "content_block_stop", index }));
        }
      } else if (block && !block.stopped) {
        if (block.kind === "thinking") {
          out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: "openai_reasoning_summary" } }));
        }
        out.push(sse("content_block_stop", { type: "content_block_stop", index: block.index }));
        block.stopped = true;
      }
    }

    if (event.type === "response.completed" || event.type === "response.incomplete") {
      this.closeOpenBlocks(out);
      this.usage = {
        input_tokens: event.response?.usage?.input_tokens ?? 0,
        output_tokens: event.response?.usage?.output_tokens ?? 0,
      };
      const hasTool = [...this.blocks.values()].some((b) => b.kind === "tool");
      const stopReason = hasTool ? "tool_use" : event.type === "response.incomplete" ? "max_tokens" : "end_turn";
      out.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: this.usage.output_tokens } }));
      out.push(sse("message_stop", { type: "message_stop" }));
    }

    return out;
  }

  private ensureStarted(event: any, out: string[]): void {
    if (this.started) return;
    this.started = true;
    this.messageId = event?.response?.id ?? this.messageId;
    out.push(sse("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  private closeOpenBlocks(out: string[]): void {
    for (const block of [...this.blocks.values()].sort((a, b) => a.index - b.index)) {
      if (block.stopped) continue;
      if (block.kind === "thinking") {
        out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: "openai_reasoning_summary" } }));
      }
      out.push(sse("content_block_stop", { type: "content_block_stop", index: block.index }));
      block.stopped = true;
    }
  }
}

export function estimateAnthropicTokens(req: AnthropicRequest): number {
  const chars = systemToString(req.system).length
    + JSON.stringify(req.messages ?? []).length
    + JSON.stringify(req.tools ?? []).length;
  return Math.max(1, Math.ceil(chars / 3.6));
}

function flushMessage(role: "user" | "assistant", parts: unknown[], input: unknown[]): void {
  if (!parts.length) return;
  input.push({ type: "message", role, content: parts.splice(0, parts.length) });
}

function systemToString(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((x) => x.type === "text").map((x) => x.text).join("\n");
}

function toolResultToString(content: string | AnthropicBlock[] | undefined, isError?: boolean): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((b) => b.type === "text" ? String((b as any).text ?? "") : JSON.stringify(b)).join("\n");
  return isError ? `[tool error]\n${text}` : text;
}

function mapToolChoice(choice: any, toolNames: OpenAIToolNameCodec): any {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) return { type: "function", name: toolNames.encode(String(choice.name)) };
  if (choice.type === "function" && choice.function?.name) return { type: "function", name: toolNames.encode(String(choice.function.name)) };
  return undefined;
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim().toLowerCase();
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort) ? effort : undefined;
}

function budgetToEffort(tokens?: number): "low" | "medium" | "high" {
  if (!tokens || tokens < 4000) return "low";
  if (tokens < 12000) return "medium";
  return "high";
}

function uniqueToolAlias(name: string, reserved: Set<string>): string {
  let readable = name.replace(INVALID_TOOL_NAME_CHARACTERS, "_").replace(/^[_-]+|[_-]+$/g, "") || "tool";
  const maxReadable = OPENAI_TOOL_NAME_MAX_LENGTH - TOOL_ALIAS_DIGEST_LENGTH - 1;
  readable = readable.slice(0, maxReadable).replace(/[_-]+$/g, "") || "tool";
  let attempt = 0;
  while (true) {
    const source = attempt === 0 ? name : `${name}\0${attempt}`;
    const digest = createHash("sha256").update(source).digest("hex").slice(0, TOOL_ALIAS_DIGEST_LENGTH);
    const alias = `${readable}_${digest}`;
    if (!reserved.has(alias)) return alias;
    attempt += 1;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return (value && typeof value === "object") ? value as Record<string, unknown> : {};
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return { _raw: value }; }
}

function safeJson(value?: string): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== "")) as T;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
