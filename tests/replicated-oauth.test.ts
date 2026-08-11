import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChatGptOAuthBoundary, readJsonSse, requireSuccessfulChatGptResponse } from "../src/chatgpt-oauth.js";
import { anthropicToFccResponses } from "../src/fcc-responses.js";
import { AnthropicRequest, OpenAIToolNameCodec } from "../src/translator.js";

test("replicated boundary lets openai-oauth own Terra Responses Lite wire format", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-replicated-oauth-"));
  const authFile = path.join(root, "auth.json");
  await writeFile(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "synthetic-id-token",
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      account_id: "acct_replicated_test",
    },
    last_refresh: new Date().toISOString(),
  }), "utf8");

  let capturedBody: any;
  let capturedHeaders: Headers | undefined;
  const boundary = createChatGptOAuthBoundary(authFile, {
    codexVersion: "0.146.0",
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/models?client_version=")) {
        return new Response(JSON.stringify({
          models: [{
            slug: "gpt-5.6-terra",
            visibility: "list",
            supported_in_api: true,
            use_responses_lite: true,
            default_reasoning_level: "high",
            support_verbosity: true,
            default_verbosity: "medium",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/responses")) {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response([
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"resp_test"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"ok"}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"resp_test","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
          "",
          "",
        ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const models = await boundary.listModels();
  assert.deepEqual(models, ["gpt-5.6-terra", "gpt-image-2"]);

  const anthropic: AnthropicRequest = {
    model: "claude-opus-5",
    max_tokens: 128000,
    system: [{ type: "text", text: "You are a coding agent." }],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [{
      name: "diagnostic_echo",
      description: "Echo a value",
      input_schema: { type: "object", properties: { value: { type: "string" } } },
    }],
    messages: [{ role: "user", content: "Say ok" }],
    stream: true,
  };
  const codec = OpenAIToolNameCodec.fromRequest(anthropic);
  const request = { ...anthropicToFccResponses(anthropic, codec), model: "gpt-5.6-terra", stream: true } as Record<string, unknown>;
  const response = await requireSuccessfulChatGptResponse(await boundary.responses(request), request);
  const events: any[] = [];
  for await (const event of readJsonSse(response)) events.push(event);

  assert.equal(capturedHeaders?.get("authorization"), "Bearer synthetic-access-token");
  assert.equal(capturedHeaders?.get("chatgpt-account-id"), "acct_replicated_test");
  assert.equal(capturedHeaders?.get("x-openai-internal-codex-responses-lite"), "true");
  assert.equal(capturedBody.model, "gpt-5.6-terra");
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.stream, true);
  assert.equal("max_output_tokens" in capturedBody, false);
  assert.equal("tools" in capturedBody, false);
  assert.equal(capturedBody.instructions, "");
  assert.equal(capturedBody.parallel_tool_calls, false);
  assert.equal(capturedBody.reasoning.effort, "high");
  assert.equal(capturedBody.reasoning.context, "all_turns");
  assert.equal(capturedBody.input[0].type, "additional_tools");
  assert.equal(capturedBody.input[1].role, "developer");
  assert.ok(events.some((event) => event.type === "response.output_text.delta"));
});

test("empty upstream 400 becomes actionable diagnostics without request text", async () => {
  const request = {
    model: "gpt-5.6-terra",
    input: [{ role: "user", content: [{ type: "input_text", text: "SECRET PROMPT" }] }],
    tools: [{ type: "function", name: "x", parameters: {} }],
    stream: true,
  };
  await assert.rejects(
    () => requireSuccessfulChatGptResponse(new Response("", { status: 400 }), request),
    (error: any) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /model=gpt-5\.6-terra/);
      assert.match(error.message, /tools=1/);
      assert.match(error.message, /<empty body>/);
      assert.doesNotMatch(error.message, /SECRET PROMPT/);
      return true;
    },
  );
});
