import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { AnthropicChatSseTranslator, anthropicToChatCompletions } from "../src/chat-translator.js";
import { claudeDesktopModelList } from "../src/claude-desktop.js";
import { CLOUDFLARE_GEMMA_MODEL, ModelConfigStore } from "../src/model-config.js";
import { discoverModelsForCredential, knownModelMetadata, providerBaseUrl } from "../src/provider-registry.js";
import { createReplicatedServer } from "../src/replicated-dispatcher.js";
import { upstreamApiFor } from "../src/upstream-api.js";

test("Cloudflare credentials generate internal ids and do not require credential-level model ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-credential-"));
  const store = new AccountStore(root); await store.init();
  const account = await store.createApiKey({ provider: "cloudflare", apiKey: "secret", accountId: "account-123" });
  assert.match(account.id, /^cloudflare-[a-f0-9]{12}$/);
  assert.equal(account.name, "Cloudflare Workers AI");
  assert.equal(account.model, undefined);
  assert.equal(account.accountId, "account-123");
  assert.equal(providerBaseUrl(account), "https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1");
  assert.equal(upstreamApiFor("cloudflare", CLOUDFLARE_GEMMA_MODEL), "chat-completions");
  assert.match(store.generateCredentialId("chatgpt"), /^chatgpt-[a-f0-9]{12}$/);
  store.close();
});

test("legacy stored API-key credentials remain readable without migration loss", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-legacy-credential-"));
  await writeFile(path.join(root, "accounts.json"), JSON.stringify({
    version: 2,
    preferredCredentialByProvider: { nvidia: "legacy" },
    accounts: [{
      id: "legacy",
      name: "Old NIM",
      provider: "nvidia",
      apiKey: "old-secret",
      model: "legacy-model",
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }));
  const store = new AccountStore(root); await store.init();
  assert.equal(store.get("legacy")?.model, "legacy-model");
  assert.equal(store.get("legacy")?.apiKey, "old-secret");
  assert.equal(store.preferredId("nvidia"), "legacy");
  store.close();
});

test("Cloudflare discovery uses account-scoped official catalog and only enriches known metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-discovery-"));
  const store = new AccountStore(root); await store.init();
  const account = await store.createApiKey({ provider: "cloudflare", apiKey: "cf-token", accountId: "abc123" });
  let requestedUrl = "";
  let authorization = "";
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      success: true,
      result: [
        { name: CLOUDFLARE_GEMMA_MODEL },
        { name: "@cf/example/unknown-model" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const models = await discoverModelsForCredential(account, fakeFetch);
  assert.equal(requestedUrl, "https://api.cloudflare.com/client/v4/accounts/abc123/ai/models/search");
  assert.equal(authorization, "Bearer cf-token");
  assert.equal(models[0].upstreamModelId, CLOUDFLARE_GEMMA_MODEL);
  assert.equal(models[0].contextWindow, 200000);
  assert.equal(models[0].maxOutputTokens, 16384);
  assert.equal(models[0].capabilities?.image, true);
  assert.equal(models[0].capabilities?.tools, true);
  assert.equal(models[0].capabilities?.streaming, true);
  assert.deepEqual(models[1], {
    provider: "cloudflare",
    upstreamModelId: "@cf/example/unknown-model",
    availability: "available",
  });
  store.close();
});

test("known Cloudflare Gemma metadata stays below the hosted 256K context and keeps the safety output cap", () => {
  const metadata = knownModelMetadata("cloudflare", CLOUDFLARE_GEMMA_MODEL);
  assert.equal(metadata?.contextWindow, 200000);
  assert.equal(metadata?.maxOutputTokens, 16384);
  assert.deepEqual(metadata?.capabilities, {
    text: true,
    image: true,
    tools: true,
    streaming: true,
    reasoning: true,
  });
});

test("Claude-facing model discovery keeps aliases clean while retaining route-specific metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-labels-"));
  const store = new AccountStore(root); await store.init();
  const configs = new ModelConfigStore(root, store); await configs.init();
  const list = claudeDesktopModelList(configs.snapshot());
  assert.deepEqual(list.data.map((model) => model.display_name), ["Default", "Fable", "Opus", "Sonnet", "Haiku"]);
  const visible = JSON.stringify(list.data.map(({ id, display_name }) => ({ id, display_name })));
  assert.doesNotMatch(visible, /OpenAI-CC|gpt-5\.6-terra|deepseek-v4-flash-free|gemma-4-26b|cloudflare/i);
  const sonnet = list.data.find((model) => model.display_name === "Sonnet")!;
  const haiku = list.data.find((model) => model.display_name === "Haiku")!;
  assert.equal(sonnet.max_input_tokens, 200000);
  assert.equal(haiku.max_input_tokens, 200000);
  assert.equal(sonnet.max_tokens, 16384);
  assert.equal((sonnet.capabilities.image_input as any).supported, true);
  store.close();
});

test("Anthropic multimodal and multi-turn tools map to standard OpenAI Chat Completions semantics", () => {
  const request = anthropicToChatCompletions({
    model: "sonnet",
    max_tokens: 1024,
    stream: false,
    tools: [{
      name: "lookup",
      description: "Look up a value",
      input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    }],
    tool_choice: { type: "tool", name: "lookup" },
    messages: [
      { role: "user", content: [
        { type: "text", text: "Inspect this image then use the tool." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ] as any },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { key: "x" } }] as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "value" }] as any },
    ],
  } as any, CLOUDFLARE_GEMMA_MODEL);

  assert.equal(request.model, CLOUDFLARE_GEMMA_MODEL);
  assert.deepEqual((request.messages[0].content as any[])[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aGVsbG8=" },
  });
  assert.equal(request.messages[1].tool_calls[0].id, "call-1");
  assert.equal(request.messages[1].tool_calls[0].function.name, "lookup");
  assert.equal(request.messages[2].role, "tool");
  assert.equal(request.messages[2].tool_call_id, "call-1");
  assert.equal(request.tools?.[0].type, "function");
  assert.deepEqual(request.tool_choice, { type: "function", function: { name: "lookup" } });
});

test("streamed tool arguments stay incremental and finish as Anthropic tool_use", () => {
  const translator = new AnthropicChatSseTranslator("claude-sonnet-4-6");
  const chunks = [
    ...translator.accept({ id: "chat-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{\"key\":" } }] } }] }),
    ...translator.accept({ id: "chat-1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] } }] }),
    ...translator.accept({ id: "chat-1", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { completion_tokens: 7 } }),
  ].join("");
  assert.match(chunks, /"type":"tool_use"/);
  assert.ok(chunks.includes('"partial_json":"{\\"key\\":"'));
  assert.ok(chunks.includes('"partial_json":"\\"x\\"}"'));
  assert.match(chunks, /"stop_reason":"tool_use"/);
});

test("production dispatcher exposes clean Cloudflare metadata and sends exact model with output/tool/image contracts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-route-"));
  const store = new AccountStore(root); await store.init();
  await store.createApiKey({ id: "cf1", provider: "cloudflare", apiKey: "token", accountId: "acct" });
  const models = new ModelConfigStore(root, store); await models.init();
  let captured: any;
  const server = createReplicatedServer(store, models, {
    bindHost: "127.0.0.1",
    clientFactory: () => ({
      chat: { completions: { create: async (request: any) => {
        captured = request;
        return {
          id: "result-1",
          choices: [{
            message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"key\":\"x\"}" } }] },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        };
      } } },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const discovery = await fetch(`${base}/v1/models`);
    assert.equal(discovery.status, 200);
    const modelList = await discovery.json() as any;
    const sonnet = modelList.data.find((model: any) => model.display_name === "Sonnet");
    assert.equal(sonnet.id, "claude-sonnet-4-6");
    assert.equal(sonnet.max_input_tokens, 200000);
    assert.equal(sonnet.max_tokens, 16384);
    assert.doesNotMatch(JSON.stringify({ id: sonnet.id, display_name: sonnet.display_name }), /cloudflare|gemma/i);

    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 99999,
        stream: false,
        tools: [{ name: "lookup", description: "lookup", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: [
          { type: "text", text: "use the image" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(captured.model, CLOUDFLARE_GEMMA_MODEL);
    assert.equal(captured.max_tokens, 16384);
    assert.equal(captured.stream, false);
    assert.equal(captured.tools[0].type, "function");
    assert.equal(captured.messages[0].content[1].type, "image_url");
    assert.equal(body.stop_reason, "tool_use");
    assert.equal(body.content[0].name, "lookup");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("production Cloudflare route streams through the real replicated dispatcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-stream-"));
  const store = new AccountStore(root); await store.init();
  await store.createApiKey({ id: "cf1", provider: "cloudflare", apiKey: "token", accountId: "acct" });
  const models = new ModelConfigStore(root, store); await models.init();
  const server = createReplicatedServer(store, models, {
    bindHost: "127.0.0.1",
    clientFactory: () => ({
      chat: { completions: { create: async ({ stream, model }: any) => {
        assert.equal(stream, true);
        assert.equal(model, CLOUDFLARE_GEMMA_MODEL);
        return (async function*() {
          yield { id: "stream-1", choices: [{ delta: { content: "hello" } }] };
          yield { id: "stream-1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 1 } };
        })();
      } } },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /hello/);
    assert.match(text, /message_stop/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
