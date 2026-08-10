import { randomUUID } from "node:crypto";

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
  thinking?: { type?: string; budget_tokens?: number };
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
  reasoning?: { effort?: "low" | "medium" | "high"; summary?: "auto" };
  stream: boolean;
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

export function anthropicToResponses(req: AnthropicRequest): ResponsesRequest {
  const input: unknown[] = [];

  for (const message of req.messages ?? []) {
    const blocks: AnthropicBlock[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

    const messageParts: unknown[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        messageParts.push({ type: "input_text", text: String((block as AnthropicTextBlock).text ?? "") });
      } else if (block.type === "image" && message.role === "user") {
        const source = (block as Extract<AnthropicBlock, { type: "image" }>).source;
        messageParts.push({ type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` });
      } else if (block.type === "tool_use" && message.role === "assistant") {
        flushMessage(message.role, messageParts, input);
        const tool = block as Extract<AnthropicBlock, { type: "tool_use" }>;
        input.push({
          type: "function_call",
          call_id: tool.id,
          name: tool.name,
          arguments: JSON.stringify(tool.input ?? {}),
        });
      } else if (block.type === "tool_result" && message.role === "user") {
        flushMessage(message.role, messageParts, input);
        const result = block as Extract<AnthropicBlock, { type: "tool_result" }>;
        input.push({
          type: "function_call_output",
          call_id: result.tool_use_id,
          output: toolResultToString(result.content, result.is_error),
        });
      } else if (block.type === "thinking" && message.role === "assistant") {
        // Claude thinking text is not sent as OpenAI hidden chain-of-thought. Preserve only a short
        // visible context marker so the conversation remains coherent without fabricating a reasoning item.
        const thinking = String((block as { thinking?: string }).thinking ?? "").trim();
        if (thinking) messageParts.push({ type: "input_text", text: `[prior reasoning summary]\n${thinking}` });
      }
    }
    flushMessage(message.role, messageParts, input);
  }

  const tools = req.tools?.map((tool) => ({
    type: "function",
    name: tool.name,
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
    tool_choice: mapToolChoice(req.tool_choice),
    parallel_tool_calls: true,
    stream: Boolean(req.stream),
  };

  if (req.thinking?.type === "enabled" || req.thinking?.budget_tokens) {
    out.reasoning = { effort: budgetToEffort(req.thinking?.budget_tokens), summary: "auto" };
  }
  return stripUndefined(out);
}

export function responsesToAnthropic(response: any, requestedModel: string) {
  const content: any[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
      }
    } else if (item.type === "function_call") {
      content.push({ type: "tool_use", id: item.call_id ?? item.id ?? `toolu_${randomUUID()}`, name: item.name, input: parseJsonObject(item.arguments) });
    } else if (item.type === "reasoning") {
      const summary = (item.summary ?? []).map((x: any) => x.text).filter(Boolean).join("\n");
      if (summary) content.push({ type: "thinking", thinking: summary, signature: "openai_reasoning_summary" });
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

export class AnthropicSseTranslator {
  private nextIndex = 0;
  private blocks = new Map<string, { index: number; kind: "text" | "tool" | "thinking"; callId?: string; name?: string }>();
  private messageId = `msg_${randomUUID()}`;
  private started = false;
  private usage = { input_tokens: 0, output_tokens: 0 };

  constructor(private readonly requestedModel: string) {}

  accept(event: any): string[] {
    const out: string[] = [];
    if (!this.started && (event.type === "response.created" || event.type === "response.in_progress")) {
      this.started = true;
      this.messageId = event.response?.id ?? this.messageId;
      out.push(sse("message_start", {
        type: "message_start",
        message: { id: this.messageId, type: "message", role: "assistant", model: this.requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }));
    }

    if (event.type === "response.output_item.added") {
      const item = event.item;
      const key = item.id ?? item.call_id ?? `item-${this.nextIndex}`;
      if (item.type === "function_call") {
        const index = this.nextIndex++;
        this.blocks.set(key, { index, kind: "tool", callId: item.call_id ?? item.id, name: item.name });
        out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: item.call_id ?? item.id ?? `toolu_${randomUUID()}`, name: item.name ?? "tool", input: {} } }));
      } else if (item.type === "reasoning") {
        const index = this.nextIndex++;
        this.blocks.set(key, { index, kind: "thinking" });
        out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }));
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
      const key = event.item_id ?? event.call_id;
      let block = key ? this.blocks.get(key) : undefined;
      if (!block) {
        block = { index: this.nextIndex++, kind: "tool", callId: event.call_id, name: event.name };
        if (key) this.blocks.set(key, block);
        out.push(sse("content_block_start", { type: "content_block_start", index: block.index, content_block: { type: "tool_use", id: event.call_id ?? `toolu_${randomUUID()}`, name: event.name ?? "tool", input: {} } }));
      }
      out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: event.delta ?? "" } }));
    }

    if (event.type === "response.reasoning_summary_text.delta") {
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
      const key = event.item?.id ?? event.item?.call_id;
      const block = key ? this.blocks.get(key) : undefined;
      if (block?.kind === "thinking") {
        out.push(sse("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: "openai_reasoning_summary" } }));
      }
      if (block) out.push(sse("content_block_stop", { type: "content_block_stop", index: block.index }));
    }

    if (event.type === "response.completed") {
      this.usage = {
        input_tokens: event.response?.usage?.input_tokens ?? 0,
        output_tokens: event.response?.usage?.output_tokens ?? 0,
      };
      const hasTool = [...this.blocks.values()].some((b) => b.kind === "tool");
      out.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: hasTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: this.usage.output_tokens } }));
      out.push(sse("message_stop", { type: "message_stop" }));
    }

    return out;
  }
}

export function estimateAnthropicTokens(req: AnthropicRequest): number {
  // Deliberately conservative approximation for Claude Code's preflight endpoint.
  // Exact Anthropic tokenization is not available locally; this prevents rejecting requests outright.
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

function mapToolChoice(choice: any): any {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) return { type: "function", name: choice.name };
  return undefined;
}

function budgetToEffort(tokens?: number): "low" | "medium" | "high" {
  if (!tokens || tokens < 4000) return "low";
  if (tokens < 12000) return "medium";
  return "high";
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
