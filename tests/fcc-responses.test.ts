import assert from "node:assert/strict";
import test from "node:test";
import { anthropicToFccResponses, ResponsesConversionError } from "../src/fcc-responses.js";
import { AnthropicRequest, OpenAIToolNameCodec } from "../src/translator.js";

const longToolName = `mcp__diagnostic__${"x".repeat(70)}`;

function request(): AnthropicRequest {
  return {
    model: "claude-opus-5",
    max_tokens: 4096,
    system: [{ type: "text", text: "You are a coding agent." }],
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
    tools: [{
      name: longToolName,
      description: "Diagnostic tool",
      input_schema: {},
    }],
    tool_choice: { type: "tool", name: longToolName },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "prior reasoning" },
          { type: "redacted_thinking", data: "ciphertext" },
          { type: "text", text: "prior answer" },
          { type: "tool_use", id: "call_1", name: longToolName, input: { value: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "done" }] },
          { type: "text", text: "Continue" },
        ],
      },
    ],
    stream: true,
  };
}

test("FCC port preserves message, reasoning, tools, and provider normalization inputs", () => {
  const req = request();
  const codec = OpenAIToolNameCodec.fromRequest(req);
  const converted = anthropicToFccResponses(req, codec) as any;

  assert.equal(converted.store, false);
  assert.deepEqual(converted.include, ["reasoning.encrypted_content"]);
  assert.equal(converted.instructions, "You are a coding agent.");
  assert.equal(converted.max_output_tokens, 4096);
  assert.equal(converted.reasoning.effort, "max");
  assert.equal(converted.reasoning.summary, "auto");

  const reasoning = converted.input.find((item: any) => item.type === "reasoning");
  assert.equal(reasoning.summary[0].text, "prior reasoning");
  assert.equal(reasoning.encrypted_content, "ciphertext");

  const tool = converted.tools[0];
  assert.ok(tool.name.length <= 64);
  assert.match(tool.name, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(tool.parameters, { type: "object", properties: {} });
  assert.equal(converted.tool_choice.name, tool.name);

  const result = converted.input.find((item: any) => item.type === "function_call_output");
  assert.equal(result.output, "done");
});

test("FCC port accepts the Claude no-op thinking context edit", () => {
  const req = request() as any;
  req.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  assert.doesNotThrow(() => anthropicToFccResponses(req));
});

test("FCC port tolerates Anthropic top_k from generic chat frontends", () => {
  const req = request() as any;
  req.top_k = 40;
  const converted = anthropicToFccResponses(req) as any;

  assert.equal(converted.top_k, undefined);
  assert.equal(converted.max_output_tokens, 4096);
});

test("FCC port rejects Anthropic fields Responses cannot represent", () => {
  const req = request() as any;
  req.stop_sequences = ["STOP"];
  assert.throws(() => anthropicToFccResponses(req), ResponsesConversionError);

  delete req.stop_sequences;
  req.output_config = { effort: "high", extra: true };
  assert.throws(() => anthropicToFccResponses(req), /output_config\.extra/);
});
