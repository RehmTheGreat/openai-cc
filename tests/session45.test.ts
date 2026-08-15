import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { ModelConfigStore, capabilitiesForRoute, contextWindowForRoute } from "../src/model-config.js";
import { GEMINI_FLASH_LITE_MODEL, ProviderRegistry, knownModelMetadata } from "../src/provider-registry.js";
import { createReplicatedServer } from "../src/replicated-dispatcher.js";
import { upstreamApiFor } from "../src/upstream-api.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-s45-"));
  const store = new AccountStore(root); await store.init();
  const providers = new ProviderRegistry(root); await providers.init();
  const models = new ModelConfigStore(root, store, providers); await models.init();
  return { root, store, providers, models };
}
async function listen(server: any) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: any) { await new Promise<void>((resolve) => server.close(() => resolve())); }

test("Gemini Flash-Lite metadata and fresh route contexts are capped correctly", async () => {
  const f = await fixture();
  const meta = knownModelMetadata("google", GEMINI_FLASH_LITE_MODEL);
  assert.equal(meta?.contextWindow, 1_048_576);
  assert.equal(meta?.maxOutputTokens, 65_536);
  const config = f.models.snapshot();
  assert.equal(contextWindowForRoute(config, "default", f.providers), 1_000_000);
  assert.equal(contextWindowForRoute(config, "opus", f.providers), 200_000);
  assert.equal(contextWindowForRoute(config, "fable", f.providers), 1_000_000);
  assert.equal(contextWindowForRoute(config, "sonnet", f.providers), 1_000_000);
  assert.equal(contextWindowForRoute(config, "haiku", f.providers), 1_000_000);
  f.store.close();
});

test("custom providers persist without a manual model catalog and ignore legacy models", async () => {
  const f = await fixture();
  const provider = await f.providers.createCustom({ displayName: "Local OpenAI", baseUrl: "https://example.invalid/v1/", apiStyle: "chat-completions" });
  assert.match(provider.id, /^custom-[a-f0-9]{12}$/);
  const stored = JSON.parse(await readFile(path.join(f.root, "providers.json"), "utf8"));
  stored.providers[0].models = [{ id: "legacy/manual", contextWindow: 333000, maxOutputTokens: 9999 }];
  await writeFile(path.join(f.root, "providers.json"), JSON.stringify(stored));
  const reloaded = new ProviderRegistry(f.root); await reloaded.init();
  assert.equal(reloaded.getCustom(provider.id)?.baseUrl, "https://example.invalid/v1");
  assert.equal((reloaded.getCustom(provider.id) as any)?.models, undefined);
  assert.equal(reloaded.metadata(provider.id, "legacy/manual")?.contextWindow, 1_000_000);
  assert.equal(reloaded.metadata(provider.id, "legacy/manual")?.maxOutputTokens, 16_384);
  const disk = await readFile(path.join(f.root, "providers.json"), "utf8");
  assert.equal(/api.?key|secret/i.test(disk), false);
  f.store.close();
});

test("custom /models discovery is authoritative and never returns the API key", async () => {
  const f = await fixture();
  const provider = await f.providers.createCustom({ displayName: "Discovery", baseUrl: "https://provider.invalid/v1", apiStyle: "chat-completions" });
  const account = await f.store.createApiKey({ provider: provider.id, apiKey: "do-not-expose" });
  let requestedUrl = ""; let authorization = "";
  const result = await f.providers.discover(account, (async (url, init) => {
    requestedUrl = String(url);
    authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
  }) as typeof fetch);
  assert.equal(requestedUrl, "https://provider.invalid/v1/models");
  assert.equal(authorization, "Bearer do-not-expose");
  assert.deepEqual(result.map((model) => model.upstreamModelId), ["m1", "m2"]);
  assert.equal(result[0].contextWindow, 1_000_000);
  assert.equal(result[0].maxOutputTokens, 16_384);
  assert.equal(JSON.stringify(result).includes("do-not-expose"), false);
  f.store.close();
});

test("custom API style selects Chat Completions or Responses without touching ChatGPT", async () => {
  const f = await fixture();
  const chat = await f.providers.createCustom({ displayName: "Chat", baseUrl: "https://chat.invalid/v1", apiStyle: "chat-completions" });
  const responses = await f.providers.createCustom({ displayName: "Responses", baseUrl: "https://responses.invalid/v1", apiStyle: "responses" });
  assert.equal(upstreamApiFor(chat.id, "m", f.providers), "chat-completions");
  assert.equal(upstreamApiFor(responses.id, "m", f.providers), "responses");
  assert.equal(upstreamApiFor("chatgpt", "gpt-5.6-terra", f.providers), "responses");
  f.store.close();
});

test("production Gemini Sonnet path carries vision, tools, multi-turn tool results, streaming and output cap", async () => {
  const f = await fixture();
  await f.store.createApiKey({ id: "g1", provider: "google", apiKey: "secret" });
  let captured: any;
  const server = createReplicatedServer(f.store, f.models, { bindHost: "127.0.0.1", providerRegistry: f.providers, clientFactory: () => ({ chat: { completions: { create: async (req: any) => {
    captured = req;
    if (req.stream) return (async function*() { yield { id: "s", choices: [{ delta: { content: "ok" } }] }; yield { id: "s", choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 1 } }; })();
    return { id: "r", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } };
  } } } }) });
  const base = await listen(server);
  try {
    let response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "sonnet", max_tokens: 999999, tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }], messages: [
      { role: "user", content: [{ type: "text", text: "classify" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    ] }) });
    assert.equal(response.status, 200);
    assert.equal(captured.model, GEMINI_FLASH_LITE_MODEL);
    assert.equal(captured.max_tokens, 65536);
    assert.equal(captured.messages[0].content[1].type, "image_url");
    assert.equal(captured.messages[1].tool_calls[0].id, "t1");
    assert.equal(captured.messages[2].role, "tool");
    response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "haiku", max_tokens: 16, stream: true, messages: [{ role: "user", content: "subagent compacted continuation" }] }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /message_stop/);
  } finally { await close(server); }
});

test("custom credential rotation stays provider-local after auth failure", async () => {
  const f = await fixture();
  const provider = await f.providers.createCustom({ displayName: "Rotating", baseUrl: "https://rotate.invalid/v1", apiStyle: "chat-completions" });
  await f.store.createApiKey({ id: "c1", provider: provider.id, apiKey: "one" });
  await f.store.createApiKey({ id: "c2", provider: provider.id, apiKey: "two" });
  const config = f.models.snapshot(); config.routes.sonnet = { provider: provider.id, model: "m", maxOutputTokens: 16000 }; await f.models.update(config);
  const calls: string[] = [];
  const server = createReplicatedServer(f.store, f.models, { bindHost: "127.0.0.1", providerRegistry: f.providers, clientFactory: (account) => ({ chat: { completions: { create: async () => {
    calls.push(account.id); if (account.id === "c1") throw Object.assign(new Error("401 token=hidden"), { status: 401 });
    return { id: "ok", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
  } } } }) });
  const base = await listen(server);
  try {
    const response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "sonnet", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(response.status, 200); assert.deepEqual(calls, ["c1", "c2"]); assert.equal(f.store.publicGet("c1")?.status, "auth_error");
  } finally { await close(server); }
});

test("DeepSeek route enforces the recorded 200K effective context before upstream dispatch", async () => {
  const f = await fixture(); await f.store.createApiKey({ id: "z1", provider: "zen", apiKey: "secret" });
  const config = f.models.snapshot(); config.routes.default = { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 }; await f.models.update(config);
  let calls = 0;
  const server = createReplicatedServer(f.store, f.models, { bindHost: "127.0.0.1", providerRegistry: f.providers, clientFactory: () => ({ chat: { completions: { create: async () => { calls++; return { id: "x", choices: [{ message: { content: "unexpected" }, finish_reason: "stop" }] }; } } } }) });
  const base = await listen(server);
  try {
    const response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "default", max_tokens: 8, messages: [{ role: "user", content: "x".repeat(730000) }] }) });
    assert.equal(response.status, 400); assert.match(await response.text(), /context_window_exceeded/); assert.equal(calls, 0);
  } finally { await close(server); }
});

test("new private Sonnet and Haiku transports route to Gemini without confusing Default", async () => {
  const f = await fixture(); await f.store.createApiKey({ id: "g1", provider: "google", apiKey: "secret" });
  const seen: string[] = [];
  const server = createReplicatedServer(f.store, f.models, { bindHost: "127.0.0.1", providerRegistry: f.providers, clientFactory: () => ({ chat: { completions: { create: async (req: any) => { seen.push(req.model); return { id: "ok", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } } } }) });
  const base = await listen(server);
  try {
    let response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai-cc-sonnet", max_tokens: 8, system: "Classify the requested task for Auto Mode.", messages: [{ role: "user", content: "x".repeat(730000) }] }) });
    assert.equal(response.status, 200);
    response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-4-7[1m]", max_tokens: 8, messages: [{ role: "user", content: "Haiku subagent continuation" }] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [GEMINI_FLASH_LITE_MODEL, GEMINI_FLASH_LITE_MODEL]);
    assert.equal(f.models.slotForRequestedModel("claude-sonnet-5"), "default");
  } finally { await close(server); }
});

test("custom service tier is preserved while capabilities are overridden only on the route", async () => {
  const f = await fixture();
  const provider = await f.providers.createCustom({ displayName: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", apiStyle: "chat-completions", serviceTier: "flex" });
  assert.deepEqual(f.providers.requestBodyDefaults(provider.id), { service_tier: "flex" });
  await f.store.createApiKey({ id: "di1", provider: provider.id, apiKey: "secret" });
  const config = f.models.snapshot();
  config.routes.sonnet = { provider: provider.id, model: "deepinfra/model", maxOutputTokens: 16000, vision: true, tools: true, reasoning: true };
  await f.models.update(config);
  const caps = capabilitiesForRoute(f.models.snapshot().routes.sonnet, f.providers);
  assert.equal(caps.image, true); assert.equal(caps.tools, true); assert.equal(caps.reasoning, true);
  let captured: any;
  const server = createReplicatedServer(f.store, f.models, { bindHost: "127.0.0.1", providerRegistry: f.providers, clientFactory: () => ({ chat: { completions: { create: async (req: any) => { captured = req; return { id: "ok", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } } } }) });
  const base = await listen(server);
  try {
    const response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "sonnet", max_tokens: 32, tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "use tool" }] }) });
    assert.equal(response.status, 200); assert.equal(captured.model, "deepinfra/model"); assert.equal(captured.service_tier, "flex"); assert.equal(captured.tools[0].type, "function");
  } finally { await close(server); }
});

test("custom Responses provider runs through production dispatcher with discovered-id defaults", async () => {
  const f = await fixture();
  const provider = await f.providers.createCustom({ displayName: "Responses Custom", baseUrl: "https://responses.invalid/v1", apiStyle: "responses" });
  await f.store.createApiKey({ id: "r1", provider: provider.id, apiKey: "secret" });
  const config = f.models.snapshot(); config.routes.sonnet = { provider: provider.id, model: "resp-model", maxOutputTokens: 16000 }; await f.models.update(config);
  const seen: any[] = [];
  const server = createReplicatedServer(f.store, f.models, { bindHost: "127.0.0.1", providerRegistry: f.providers, clientFactory: () => ({ responses: { create: async (req: any) => {
    seen.push(req); if (req.stream) return (async function*() { yield { type: "response.output_text.delta", item_id: "msg", output_index: 0, delta: "streamed" }; yield { type: "response.completed", response: { id: "resp-stream", usage: { input_tokens: 1, output_tokens: 1 } } }; })();
    return { id: "resp", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 1, output_tokens: 1 } };
  } } }) });
  const base = await listen(server);
  try {
    let response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "sonnet", max_tokens: 99999, messages: [{ role: "user", content: "use tool" }] }) });
    assert.equal(response.status, 200); assert.equal((await response.json() as any).content[0].text, "done"); assert.equal(seen[0].model, "resp-model"); assert.equal(seen[0].max_output_tokens, 16000);
    response = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "sonnet", max_tokens: 8, stream: true, messages: [{ role: "user", content: "stream" }] }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /streamed/);
  } finally { await close(server); }
});

test("custom provider routes and credentials survive restart without manual model metadata", async () => {
  const f = await fixture();
  const provider = await f.providers.createCustom({ displayName: "Persistent", baseUrl: "https://persist.invalid/v1", apiStyle: "chat-completions" });
  await f.store.createApiKey({ id: "persist-key", provider: provider.id, apiKey: "secret" });
  const config = f.models.snapshot(); config.routes.opus = { provider: provider.id, model: "persist-model", maxOutputTokens: 16000, tools: true }; await f.models.update(config);
  f.store.close();
  const store2 = new AccountStore(f.root); await store2.init();
  const providers2 = new ProviderRegistry(f.root); await providers2.init();
  const models2 = new ModelConfigStore(f.root, store2, providers2); await models2.init();
  assert.equal(models2.snapshot().routes.opus.provider, provider.id);
  assert.equal(models2.snapshot().routes.opus.model, "persist-model");
  assert.equal(models2.snapshot().routes.opus.tools, true);
  assert.equal(models2.contextWindowForRequestedModel("opus"), 1_000_000);
  assert.equal(models2.credentialForRequestedModel("opus")?.id, "persist-key");
  store2.close();
});

test("Admin custom provider API has no manual model mutation endpoint and never exposes secrets", async () => {
  const f = await fixture();
  const server = createReplicatedServer(f.store, f.models, { bindHost: "127.0.0.1", providerRegistry: f.providers });
  const base = await listen(server);
  try {
    let response = await fetch(base + "/admin/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Admin Custom", baseUrl: "https://custom.invalid/v1", apiStyle: "responses", serviceTier: "flex" }) });
    assert.equal(response.status, 201); const provider = await response.json() as any;
    response = await fetch(base + "/admin/providers/" + provider.id + "/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "manual" }) });
    assert.equal(response.status, 404);
    response = await fetch(base + "/admin/credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.id, apiKey: "never-return-this" }) });
    assert.equal(response.status, 201); assert.equal(JSON.stringify(await response.json()).includes("never-return-this"), false);
    response = await fetch(base + "/admin/state"); const stateText = await response.text();
    assert.equal(stateText.includes("never-return-this"), false);
    const state = JSON.parse(stateText); const publicProvider = state.providers.find((item: any) => item.id === provider.id);
    assert.equal(publicProvider.baseUrl, "https://custom.invalid/v1"); assert.equal(publicProvider.serviceTier, "flex"); assert.equal(publicProvider.models, undefined);
  } finally { await close(server); }
});
