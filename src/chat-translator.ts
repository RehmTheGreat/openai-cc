import { randomUUID } from "node:crypto";
import { AnthropicBlock, AnthropicRequest, AnthropicTextBlock } from "./translator.js";

export interface ChatCompletionRequest {
  model: string;
  messages: any[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: any[];
  tool_choice?: any;
  stream: boolean;
}

export function anthropicToChatCompletions(req: AnthropicRequest, model: string): ChatCompletionRequest {
  const messages: any[] = [];
  const system = systemToString(req.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of req.messages ?? []) {
    const blocks: AnthropicBlock[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

    if (message.role === "assistant") {
      const text: string[] = [];
      const toolCalls: any[] = [];
      for (const block of blocks) {
        if (block.type === "text") text.push(String((block as AnthropicTextBlock).text ?? ""));
        else if (block.type === "tool_use") {
          const tool = block as Extract<AnthropicBlock, { type: "tool_use" }>;
          toolCalls.push({
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
          });
        } else if (block.type === "thinking") {
          const thinking = String((block as { thinking?: string }).thinking ?? "").trim();
          if (thinking) text.push(`[prior reasoning summary]\n${thinking}`);
        }
      }
      const out: any = { role: "assistant", content: text.join("\n") || null };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    const userParts: any[] = [];
    const toolResults: any[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        userParts.push({ type: "text", text: String((block as AnthropicTextBlock).text ?? "") });
      } else if (block.type === "image") {
        const source = (block as Extract<AnthropicBlock, { type: "image" }>).source;
        userParts.push({ type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } });
      } else if (block.type === "tool_result") {
        const result = block as Extract<AnthropicBlock, { type: "tool_result" }>;
        toolResults.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: toolResultToString(result.content, result.is_error),
        });
      }
    }
    messages.push(...toolResults);
    if (userParts.length) {
      const onlyText = userParts.every((part) => part.type === "text");
      messages.push({
        role: "user",
        content: onlyText ? userParts.map((part) => part.text).join("\n") : userParts,
      });
    }
  }

  const tools = req.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));

  return stripUndefined({
    model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    tools: tools?.length ? tools : undefined,
    tool_choice: mapToolChoice(req.tool_choice),
    stream: Boolean(req.stream),
  });
}

export function chatCompletionToAnthropic(response: any, requestedModel: string) {
  const message = response.choices?.[0]?.message ?? {};
  const content: any[] = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    const text = message.content.map((part: any) => part?.text ?? "").filter(Boolean).join("");
    if (text) content.push({ type: "text", text });
  }
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? `toolu_${randomUUID()}`,
      name: call.function?.name ?? "tool",
      input: parseJsonObject(call.function?.arguments),
    });
  }

  return {
    id: response.id ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapStopReason(response.choices?.[0]?.finish_reason, content),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

export class AnthropicChatSseTranslator {
  private messageId = `msg_${randomUUID()}`;
  private started = false;
  private nextIndex = 0;
  private textIndex: number | undefined;
  private toolBlocks = new Map<number, { index: number; id: string; name: string }>();
  private openBlocks = new Set<number>();
  private outputTokens = 0;
  private stopReason = "end_turn";

  constructor(private readonly requestedModel: string) {}

  accept(chunk: any): string[] {
    const out: string[] = [];
    if (!this.started) {
      this.started = true;
      this.messageId = chunk.id ?? this.messageId;
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
          usage: { input_tokens: chunk.usage?.prompt_tokens ?? 0, output_tokens: 0 },
        },
      }));
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (this.textIndex === undefined) {
        this.textIndex = this.nextIndex++;
        this.openBlocks.add(this.textIndex);
        out.push(sse("content_block_start", {
          type: "content_block_start",
          index: this.textIndex,
          content_block: { type: "text", text: "" },
        }));
      }
      out.push(sse("content_block_delta", {
        type: "content_block_delta",
        index: this.textIndex,
        delta: { type: "text_delta", text: delta.content },
      }));
    }

    for (const call of delta.tool_calls ?? []) {
      const key = Number(call.index ?? 0);
      let block = this.toolBlocks.get(key);
      if (!block) {
        block = {
          index: this.nextIndex++,
          id: call.id ?? `toolu_${randomUUID()}`,
          name: call.function?.name ?? "tool",
        };
        this.toolBlocks.set(key, block);
        this.openBlocks.add(block.index);
        out.push(sse("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        }));
      }
      if (call.function?.arguments) {
        out.push(sse("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: call.function.arguments },
        }));
      }
    }

    if (chunk.usage?.completion_tokens !== undefined) this.outputTokens = chunk.usage.completion_tokens;
    if (choice?.finish_reason) {
      this.stopReason = choice.finish_reason === "tool_calls" ? "tool_use"
        : choice.finish_reason === "length" ? "max_tokens"
        : "end_turn";
      for (const index of [...this.openBlocks].sort((a, b) => a - b)) {
        out.push(sse("content_block_stop", { type: "content_block_stop", index }));
      }
      this.openBlocks.clear();
      out.push(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      }));
      out.push(sse("message_stop", { type: "message_stop" }));
    }
    return out;
  }
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
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return undefined;
}

function mapStopReason(reason: string | undefined, content: any[]): string {
  if (reason === "tool_calls" || content.some((block) => block.type === "tool_use")) return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return (value && typeof value === "object") ? value as Record<string, unknown> : {};
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return { _raw: value }; }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== "")) as T;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
