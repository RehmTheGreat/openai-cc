import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { anthropicToChatCompletions } from "../src/chat-translator.js";
import { RequestDrivenProviderRegistry } from "../src/request-driven-provider-registry.js";

test("custom API-discovered models treat tools and reasoning as request-driven", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-request-driven-"));
  const accounts = new AccountStore(root);
  await accounts.init();
  try {
    const providers = new RequestDrivenProviderRegistry(root);
    await providers.init();
    const provider = await providers.createCustom({
      displayName: "Custom",
      baseUrl: "https://provider.invalid/v1",
      apiStyle: "chat-completions",
    });
    const account = await accounts.createApiKey({ provider: provider.id, apiKey: "secret" });
    const models = await providers.discover(account, (async () => new Response(JSON.stringify({
      data: [{ id: "model-a" }, { id: "model-b" }],
    }), { status: 200 })) as typeof fetch);

    assert.deepEqual(models.map((model) => model.upstreamModelId), ["model-a", "model-b"]);
    for (const model of models) {
      assert.equal(model.capabilities?.tools, true);
      assert.equal(model.capabilities?.reasoning, true);
      assert.equal(model.contextWindow, 1_000_000);
      assert.equal(model.maxOutputTokens, 16_384);
    }
    assert.equal((providers.getCustom(provider.id) as any)?.models, undefined);
  } finally {
    accounts.close();
  }
});

test("Chat Completions forwards tools and derives reasoning effort from Claude request", () => {
  const base = {
    model: "sonnet",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
  } as any;

  const high = anthropicToChatCompletions({ ...base, output_config: { effort: "high" } }, "custom-model");
  assert.equal(high.tools?.[0]?.type, "function");
  assert.equal(high.reasoning_effort, "high");

  const disabled = anthropicToChatCompletions({ ...base, thinking: { type: "disabled" } }, "custom-model");
  assert.equal(disabled.reasoning_effort, "none");

  const adaptive = anthropicToChatCompletions({ ...base, thinking: { type: "adaptive" } }, "custom-model");
  assert.equal(adaptive.reasoning_effort, "medium");
});
