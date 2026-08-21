import {
  AnthropicBlock,
  AnthropicRequest,
  OpenAIToolNameCodec,
  ResponsesRequest,
  mapModel,
} from "./translator.js";

export class ResponsesConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesConversionError";
  }
}

/**
 * TypeScript port of free-claude-code's core/openai_responses/provider_input.py.
 * This module owns only Anthropic -> public Responses-shape conversion. The
 * private ChatGPT/Codex wire format remains entirely owned by openai-oauth.
 */
export function anthropicToFccResponses(
  req: AnthropicRequest,
  toolNames: OpenAIToolNameCodec = OpenAIToolNameCodec.fromRequest(req),
): ResponsesRequest {
  validateSupportedRequest(req);
  const input: unknown[] = [];

  for (const message of req.messages ?? []) {
    if (message.role === "assistant") input.push(...assistantItems(message.content, toolNames));
    else input.push(...userItems(message.content, toolNames));
  }

  if (!input.length) throw new ResponsesConversionError("OpenAI Responses conversion requires at least one user or assistant item.");

  const body: ResponsesRequest = {
    model: mapModel(req.model),
    input,
    stream: Boolean(req.stream),
    store: false,
    include: ["reasoning.encrypted_content"],
  };

  const instructions = systemText(req.system);
  if (instructions) body.instructions = instructions;
  if (req.max_tokens !== undefined) body.max_output_tokens = req.max_tokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;

  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      type: "function",
      name: toolNames.encode(tool.name),
      description: tool.description,
      parameters: nonEmptyObject(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      strict: false,
    }));
  }

  const toolChoice = mapToolChoice(req.tool_choice, toolNames);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  const reasoning = reasoningConfig(req);
  if (reasoning) body.reasoning = reasoning;
  return body;
}

function validateSupportedRequest(req: AnthropicRequest): void {
  const raw = req as any;
  const providerToolTypes = [...new Set((req.tools ?? [])
    .map((tool: any) => typeof tool.type === "string" ? tool.type : undefined)
    .filter((value): value is string => Boolean(value)))].sort();
  if (providerToolTypes.length) {
    throw new ResponsesConversionError(`OpenAI Responses cannot represent provider-managed tool types: ${providerToolTypes.join(", ")}.`);
  }

  const unsupported: string[] = [];
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length) unsupported.push("stop_sequences");
  // Anthropic-compatible chat frontends commonly send top_k by default.
  // Responses has no equivalent, so ignore it rather than rejecting the request.
  if (!isNoopContextManagement(raw.context_management)) unsupported.push("context_management");

  if (raw.output_config && typeof raw.output_config === "object" && !Array.isArray(raw.output_config)) {
    for (const key of Object.keys(raw.output_config).sort()) if (key !== "effort") unsupported.push(`output_config.${key}`);
  }
  if (Array.isArray(raw.mcp_servers) && raw.mcp_servers.length) unsupported.push("mcp_servers");
  if (raw.extra_body && typeof raw.extra_body === "object" && Object.keys(raw.extra_body).length) unsupported.push("extra_body");

  if (unsupported.length) {
    throw new ResponsesConversionError(`OpenAI Responses cannot represent these fields without data loss: ${unsupported.join(", ")}.`);
  }
}

function isNoopContextManagement(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return true;
  if (keys.length !== 1 || keys[0] !== "edits" || !Array.isArray(value.edits)) return false;
  return value.edits.every((edit) => isRecord(edit)
    && edit.type === "clear_thinking_20251015"
    && edit.keep === "all"
    && Object.keys(edit).length === 2);
}

function assistantItems(content: string | AnthropicBlock[], toolNames: OpenAIToolNameCodec): unknown[] {
  if (typeof content === "string") return [assistantMessage([{ type: "output_text", text: content }])];
  if (!Array.isArray(content)) throw new ResponsesConversionError("Assistant content must be text or content blocks.");

  const items: any[] = [];
  const textParts: any[] = [];
  const thinkingParts: string[] = [];
  const encryptedParts: string[] = [];

  const flushText = (): void => {
    if (!textParts.length) return;
    items.push(assistantMessage(textParts.splice(0, textParts.length)));
  };

  for (const block of content) {
    const type = blockType(block);
    if (type === "text") {
      textParts.push({ type: "output_text", text: String((block as any).text ?? "") });
    } else if (type === "thinking") {
      thinkingParts.push(String((block as any).thinking ?? ""));
    } else if (type === "redacted_thinking") {
      encryptedParts.push(String((block as any).data ?? ""));
    } else if (type === "tool_use") {
      flushText();
      items.push({
        type: "function_call",
        call_id: String((block as any).id ?? ""),
        name: toolNames.encode(String((block as any).name ?? "")),
        arguments: JSON.stringify((block as any).input ?? {}),
      });
    } else {
      throw new ResponsesConversionError(`OpenAI Responses cannot represent assistant content block ${JSON.stringify(type)}.`);
    }
  }

  const summary = thinkingParts.filter(Boolean).map((text) => ({ type: "summary_text", text }));
  if (encryptedParts.filter(Boolean).length) {
    encryptedParts.filter(Boolean).forEach((encrypted_content, index) => items.splice(index, 0, {
      type: "reasoning",
      summary: index === 0 ? summary : [],
      encrypted_content,
    }));
  } else if (summary.length) {
    items.unshift({ type: "reasoning", summary });
  }
  flushText();
  return items;
}

function userItems(content: string | AnthropicBlock[], _toolNames: OpenAIToolNameCodec): unknown[] {
  if (typeof content === "string") return [userMessage([{ type: "input_text", text: content }])];
  if (!Array.isArray(content)) throw new ResponsesConversionError("User content must be text or content blocks.");

  const items: any[] = [];
  const messageParts: any[] = [];
  const flushMessage = (): void => {
    if (!messageParts.length) return;
    items.push(userMessage(messageParts.splice(0, messageParts.length)));
  };

  for (const block of content) {
    const type = blockType(block);
    if (type === "text") {
      messageParts.push({ type: "input_text", text: String((block as any).text ?? "") });
    } else if (type === "image") {
      messageParts.push(imagePart(block));
    } else if (type === "tool_result") {
      flushMessage();
      items.push({
        type: "function_call_output",
        call_id: String((block as any).tool_use_id ?? ""),
        output: toolResultOutput((block as any).content),
      });
    } else if (type === "document") {
      throw new ResponsesConversionError("OpenAI Responses provider does not support Anthropic document blocks.");
    } else {
      throw new ResponsesConversionError(`OpenAI Responses cannot represent user content block ${JSON.stringify(type)}.`);
    }
  }
  flushMessage();
  return items;
}

function imagePart(block: AnthropicBlock | Record<string, unknown>): Record<string, unknown> {
  const source = (block as any).source;
  if (!isRecord(source)) throw new ResponsesConversionError("Image source is required.");
  let url: unknown;
  if (source.type === "url") url = source.url;
  else if (source.type === "base64") {
    if (typeof source.media_type !== "string" || typeof source.data !== "string") {
      throw new ResponsesConversionError("Base64 images require media_type and data.");
    }
    url = `data:${source.media_type};base64,${source.data}`;
  } else {
    throw new ResponsesConversionError(`Unsupported image source type ${JSON.stringify(source.type)}.`);
  }
  if (typeof url !== "string" || !url) throw new ResponsesConversionError("Image source requires a non-empty URL.");
  return { type: "input_image", image_url: url };
}

/**
 * OpenAI/Codex function-call output supports structured content items. Keep
 * image blocks as input_image items instead of JSON-stringifying base64 into
 * text, which both loses multimodal semantics and massively inflates context.
 */
function toolResultOutput(content: unknown): string | Record<string, unknown>[] {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return isRecord(content) ? JSON.stringify(content) : String(content);

  const hasMedia = content.some((item) => isRecord(item) && item.type === "image");
  if (!hasMedia) {
    return content.map((item) => {
      if (isRecord(item) && item.type === "text") return String(item.text ?? "");
      if (isRecord(item)) return JSON.stringify(item);
      return String(item);
    }).join("\n");
  }

  return content.flatMap((item): Record<string, unknown>[] => {
    if (isRecord(item) && item.type === "text") {
      return [{ type: "input_text", text: String(item.text ?? "") }];
    }
    if (isRecord(item) && item.type === "image") return [imagePart(item)];
    if (isRecord(item) && item.type === "document") {
      throw new ResponsesConversionError("OpenAI Responses tool output does not support Anthropic document blocks.");
    }
    return [{ type: "input_text", text: isRecord(item) ? JSON.stringify(item) : String(item) }];
  });
}

function systemText(system: AnthropicRequest["system"]): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) throw new ResponsesConversionError("System content must contain only text.");
  const parts: string[] = [];
  for (const part of system) {
    if ((part as any).type !== "text") throw new ResponsesConversionError("System content must contain only text.");
    parts.push(String((part as any).text ?? ""));
  }
  return parts.filter(Boolean).join("\n\n");
}

function assistantMessage(content: unknown[]): Record<string, unknown> {
  return { type: "message", role: "assistant", content };
}

function userMessage(content: unknown[]): Record<string, unknown> {
  return { type: "message", role: "user", content };
}

function mapToolChoice(choice: any, toolNames: OpenAIToolNameCodec): unknown {
  if (!choice) return undefined;
  if (choice.type === "auto" || choice.type === "none") return String(choice.type);
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    if (typeof choice.name !== "string" || !choice.name) throw new ResponsesConversionError("Forced tool choice requires a tool name.");
    return { type: "function", name: toolNames.encode(choice.name) };
  }
  throw new ResponsesConversionError(`Unsupported tool_choice type ${JSON.stringify(choice.type)}.`);
}

function reasoningConfig(req: AnthropicRequest): { effort?: string; summary?: "auto" } | undefined {
  const raw = req as any;
  if (raw.thinking?.type === "disabled") return { effort: "none" };
  const explicit = normalizeReasoningEffort(raw.output_config?.effort);
  if (explicit) return { effort: explicit, summary: "auto" };
  if (raw.thinking?.type === "enabled" || raw.thinking?.type === "adaptive" || positiveNumber(raw.thinking?.budget_tokens)) {
    const budget = positiveNumber(raw.thinking?.budget_tokens) ? Number(raw.thinking.budget_tokens) : undefined;
    return { ...(budget ? { effort: budgetToEffort(budget) } : {}), summary: "auto" };
  }
  return undefined;
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim().toLowerCase();
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : undefined;
}

function budgetToEffort(tokens: number): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (tokens <= 512) return "minimal";
  if (tokens <= 1024) return "medium";
  if (tokens <= 2048) return "high";
  if (tokens <= 4096) return "xhigh";
  return "max";
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function blockType(block: unknown): string {
  return isRecord(block) && typeof block.type === "string" ? block.type : "unknown";
}

function nonEmptyObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
