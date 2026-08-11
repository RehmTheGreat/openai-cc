import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicRequest,
  AnthropicSseTranslator,
  OpenAIToolNameCodec,
  anthropicToResponses,
  prepareChatGptCodexRequest,
  responsesToAnthropic,
} from "../src/translator.js";

const longToolName = `mcp__codex_provider__${"x".repeat(70)}`;

function request(): AnthropicRequest {
  return {
    model: "claude-opus-5",
    max_tokens: 128000,
    system: [{ type: "text", text: "You are a coding agent." }],
    metadata: { user_id: "desktop-user" },
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "high" },
    tools: [{
      name: longToolName,
      description: "Long MCP tool name",
      input_schema: { type: "object", properties: { value: { type: "string" } } },
    }],
    tool_choice: { type: "tool", name: longToolName },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "prior summary", signature: "sig" },
          { type: "redacted_thinking", data: "encrypted-reasoning" },
          { type: "text", text: "previous answer" },
          { type: "tool_use", id: "call_1", name: longToolName, input: { value: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "done" },
          { type: "text", text: "Say ok" },
        ],
      },
    ],
    stream: true,
  };
}

test("Codex conversion preserves Responses semantics and portable tool names", () => {
  const req = request();
  const codec = OpenAIToolNameCodec.fromRequest(req);
  const converted = anthropicToResponses(req, codec) as any;

  const assistantMessage = converted.input.find((item: any) => item.type === "message" && item.role === "assistant");
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.content[0].type, "output_text");
  assert.equal(assistantMessage.content[0].text, "previous answer");

  const reasoning = converted.input.find((item: any) => item.type === "reasoning");
  assert.ok(reasoning);
  assert.equal(reasoning.summary[0].text, "prior summary");
  assert.equal(reasoning.encrypted_content, "encrypted-reasoning");

  const tool = converted.tools[0];
  assert.notEqual(tool.name, longToolName);
  assert.ok(tool.name.length <= 64);
  assert.match(tool.name, /^[A-Za-z0-9_-]+$/);
  assert.equal(converted.tool_choice.name, tool.name);
  assert.equal(converted.reasoning.effort, "high");
  assert.equal(converted.reasoning.summary, "auto");

  const codex = prepareChatGptCodexRequest(converted) as any;
  assert.equal(codex.store, false);
  assert.ok(codex.include.includes("reasoning.encrypted_content"));
  assert.equal("max_output_tokens" in codex, false);
  assert.equal("parallel_tool_calls" in codex, false);
  assert.equal("metadata" in codex, false);
});

test("Responses output decodes aliased tool names for Claude", () => {
  const req = request();
  const codec = OpenAIToolNameCodec.fromRequest(req);
  const converted = anthropicToResponses(req, codec) as any;
  const alias = converted.tools[0].name;
  const response = responsesToAnthropic({
    id: "resp_1",
    output: [{ type: "function_call", id: "fc_1", call_id: "call_2", name: alias, arguments: "{\"value\":\"ok\"}" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }, "claude-opus-5", codec) as any;

  assert.equal(response.content[0].type, "tool_use");
  assert.equal(response.content[0].name, longToolName);
  assert.deepEqual(response.content[0].input, { value: "ok" });
});

test("Responses streaming always starts an Anthropic message before content", () => {
  const translator = new AnthropicSseTranslator("claude-opus-5");
  const chunks = translator.accept({
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    delta: "ok",
  });

  assert.match(chunks[0], /^event: message_start/m);
  assert.match(chunks[1], /^event: content_block_start/m);
  assert.match(chunks[2], /^event: content_block_delta/m);
  assert.ok(chunks[2].includes("ok"));
});

test("Responses streaming decodes tool aliases and preserves encrypted reasoning", () => {
  const req = request();
  const codec = OpenAIToolNameCodec.fromRequest(req);
  const converted = anthropicToResponses(req, codec) as any;
  const alias = converted.tools[0].name;
  const translator = new AnthropicSseTranslator("claude-opus-5", codec);

  const toolChunks = translator.accept({
    type: "response.output_item.added",
    item: { type: "function_call", id: "fc_2", call_id: "call_2", name: alias },
  }).join("");
  assert.ok(toolChunks.includes(longToolName));
  assert.equal(toolChunks.includes(alias), false);

  translator.accept({
    type: "response.output_item.added",
    item: { type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" },
  });
  const reasoningChunks = translator.accept({
    type: "response.output_item.done",
    item: { type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" },
  }).join("");
  assert.ok(reasoningChunks.includes("redacted_thinking"));
  assert.ok(reasoningChunks.includes("ciphertext"));
});
