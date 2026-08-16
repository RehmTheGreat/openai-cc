import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { AnthropicChatSseTranslator, anthropicToChatCompletions } from "../src/chat-translator.js";
import { claudeDesktopModelList } from "../src/claude-desktop.js";
import { ModelConfigStore } from "../src/model-config.js";
import { discoverModelsForCredential, providerBaseUrl } from "../src/provider-registry.js";
import { createReplicatedServer } from "../src/replicated-dispatcher.js";
import { upstreamApiFor } from "../src/upstream-api.js";

const CF_MODEL = "@cf/example/model";

test("Cloudflare credentials generate internal ids and do not require credential-level model ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-credential-"));
  const store = new AccountStore(root); await store.init();
  const account = await store.createApiKey({ provider: "cloudflare", apiKey: "secret", accountId: "account-123" });
  assert.match(account.id, /^cloudflare-[a-f0-9]{12}$/);
  assert.equal(account.name, "Cloudflare Workers AI");
  assert.equal(account.model, undefined);
  assert.equal(account.accountId, "account-123");
  assert.equal(providerBaseUrl(account), "https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1");
  assert.equal(upstreamApiFor("cloudflare", CF_MODEL), "chat-completions");
  assert.match(store.generateCredentialId("chatgpt"), /^chatgpt-[a-f0-9]{12}$/);
  store.close();
});

test("legacy stored API-key credentials remain readable without migration loss", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-legacy-credential-"));
  await writeFile(path.join(root, "accounts.json"), JSON.stringify({
    version: 2,
    preferredCredentialByProvider: { nvidia: "legacy" },
    accounts: [{
      id: "legacy", name: "Old NIM", provider: "nvidia", apiKey: "old-secret", model: "legacy-model", status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }));
  const store = new AccountStore(root); await store.init();
  assert.equal(store.get("legacy")?.model, "legacy-model");
  assert.equal(store.get("legacy")?.apiKey, "old-secret");
  assert.equal(store.preferredId("nvidia"), "legacy");
  store.close();
});

test("provider discovery returns provider model ids without OpenAI-CC model decoration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-discovery-"));
  const store = new AccountStore(root); await store.init();
  const account = await store.createApiKey({ provider: "cloudflare", apiKey: "cf-token", accountId: "abc123" });
  let requestedUrl = "";
  let authorization = "";
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ success: true, result: [{ name: CF_MODEL }, { name: "@cf/example/other" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const models = await discoverModelsForCredential(account, fakeFetch);
  assert.equal(requestedUrl, "https://api.cloudflare.com/client/v4/accounts/abc123/ai/models/search");
  assert.equal(authorization, "Bearer cf-token");
  assert.deepEqual(models, [
    { provider: "cloudflare", upstreamModelId: CF_MODEL, availability: "available" },
    { provider: "cloudflare", upstreamModelId: "@cf/example/other", availability: "available" },
  ]);
  assert.equal(models[0].contextWindow, undefined);
  assert.equal(models[0].maxOutputTokens, undefined);
  assert.equal(models[0].capabilities, undefined);
  store.close();
});

test("Claude-facing discovery exposes five routes with the one Admin context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-labels-"));
  const store = new AccountStore(root); await store.init();
  const configs = new ModelConfigStore(root, store); await configs.init();
  await configs.update({ contextWindow: 1_234_567 });
  const list = claudeDesktopModelList(configs.snapshot());
  assert.deepEqual(list.data.map((model) => model.id), ["default", "fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(list.data.map((model) => model.display_name), ["Default", "Fable", "Opus", "Sonnet", "Haiku"]);
  assert.deepEqual(list.data.map((model) => model.max_input_tokens), [1_234_567, 1_234_567, 1_234_567, 1_234_567, 1_234_567]);
  const visible = JSON.stringify(list.data.map(({ id, display_name }) => ({ id, display_name })));
  assert.doesNotMatch(visible, /gpt-|deepseek|gemini|cloudflare|\[1m\]|openai-cc-/i);
  store.close();
});

test("Anthropic multimodal and multi-turn tools map to standard OpenAI Chat Completions semantics", () => {
  const request = anthropicToChatCompletions({
    model: "sonnet",
    max_tokens: 1024,
    stream: false,
    tools: [{ name: "lookup", description: "Look up a value", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }],
    tool_choice: { type: "tool", name: "lookup" },
    messages: [
      { role: "user", content: [
        { type: "text", text: "Inspect this image then use the tool." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ] as any },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { key: "x" } }] as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "value" }] as any },
    ],
  } as any, CF_MODEL);

  assert.equal(request.model, CF_MODEL);
  assert.deepEqual((request.messages[0].content as any[])[1], { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } });
  assert.equal(request.messages[1].tool_calls[0].id, "call-1");
  assert.equal(request.messages[2].role, "tool");
  assert.deepEqual(request.tool_choice, { type: "function", function: { name: "lookup" } });
});

test("streamed tool arguments stay incremental and finish as Anthropic tool_use", () => {
  const translator = new AnthropicChatSseTranslator("sonnet");
  const chunks = [
    ...translator.accept({ id: "chat-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{\"key\":" } }] } }] }),
    ...translator.accept({ id: "chat-1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] } }] }),
    ...translator.accept({ id: "chat-1", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { completion_tokens: 7 } }),
  ].join("");
  assert.match(chunks, /"type":"tool_use"/);
  assert.match(chunks, /"stop_reason":"tool_use"/);
});

test("production Cloudflare route sends the configured model, output cap, tools and image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-route-"));
  const store = new AccountStore(root); await store.init();
  await store.createApiKey({ id: "cf1", provider: "cloudflare", apiKey: "token", accountId: "acct" });
  const models = new ModelConfigStore(root, store); await models.init();
  const routeConfig = models.snapshot();
  routeConfig.routes.sonnet = { provider: "cloudflare", model: CF_MODEL, maxOutputTokens: 16384 };
  await models.update(routeConfig);
  let captured: any;
  const server = createReplicatedServer(store, models, {
    bindHost: "127.0.0.1",
    clientFactory: () => ({ chat: { completions: { create: async (request: any) => {
      captured = request;
      return {
        id: "result-1",
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"key\":\"x\"}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      };
    } } } }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const discovery = await fetch(`${base}/v1/models`);
    const modelList = await discovery.json() as any;
    const sonnet = modelList.data.find((model: any) => model.id === "sonnet");
    assert.equal(sonnet.max_input_tokens, 1_050_000);
    assert.equal(sonnet.max_tokens, 16384);

    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sonnet", max_tokens: 99999, stream: false,
        tools: [{ name: "lookup", description: "lookup", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: [
          { type: "text", text: "use the image" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(captured.model, CF_MODEL);
    assert.equal(captured.max_tokens, 16384);
    assert.equal(captured.messages[0].content[1].type, "image_url");
    assert.equal(body.stop_reason, "tool_use");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("production Cloudflare route streams through the real dispatcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cf-stream-"));
  const store = new AccountStore(root); await store.init();
  await store.createApiKey({ id: "cf1", provider: "cloudflare", apiKey: "token", accountId: "acct" });
  const models = new ModelConfigStore(root, store); await models.init();
  const routeConfig = models.snapshot();
  routeConfig.routes.sonnet = { provider: "cloudflare", model: CF_MODEL, maxOutputTokens: 16384 };
  await models.update(routeConfig);
  const server = createReplicatedServer(store, models, {
    bindHost: "127.0.0.1",
    clientFactory: () => ({ chat: { completions: { create: async ({ stream, model }: any) => {
      assert.equal(stream, true); assert.equal(model, CF_MODEL);
      return (async function*() {
        yield { id: "stream-1", choices: [{ delta: { content: "hello" } }] };
        yield { id: "stream-1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 1 } };
      })();
    } } } }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
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
