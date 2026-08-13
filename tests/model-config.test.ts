import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { OpenAICCError } from "../src/errors.js";
import { CLOUDFLARE_GEMMA_MODEL, ModelConfigStore, claudeCodeModelAlias, contextWindowForRoute } from "../src/model-config.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-"));
  const accounts = new AccountStore(root);
  await accounts.init();
  await accounts.createApiKey({ id: "n1", name: "NVIDIA 1", provider: "nvidia", apiKey: "a", model: "m" });
  await accounts.createApiKey({ id: "n2", name: "NVIDIA 2", provider: "nvidia", apiKey: "b", model: "m" });
  await accounts.createApiKey({ id: "g1", name: "Google 1", provider: "google", apiKey: "c", model: "m" });
  const models = new ModelConfigStore(root, accounts);
  await models.init();
  return { root, accounts, models };
}

test("fresh routing uses Luna Default/Fable, DeepSeek Opus, and Gemini Flash-Lite Sonnet/Haiku", async () => {
  const { accounts, models } = await fixture();
  const config = models.snapshot();
  assert.deepEqual(config.routes.default, { provider: "chatgpt", model: "gpt-5.6-luna", maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.fable, { provider: "chatgpt", model: "gpt-5.6-luna", maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.opus, { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.sonnet, { provider: "google", model: "gemini-3.5-flash-lite", maxOutputTokens: 65536 });
  assert.deepEqual(config.routes.haiku, { provider: "google", model: "gemini-3.5-flash-lite", maxOutputTokens: 65536 });
  accounts.close();
});

test("auto routing uses preferred ready credential then same-provider fallback", async () => {
  const { accounts, models } = await fixture();
  await models.update({ routes: { ...models.snapshot().routes, sonnet: { provider: "nvidia", model: "nim-model", maxOutputTokens: 64000 } } });
  await accounts.prefer("n2");
  assert.equal(models.credentialForRequestedModel("sonnet")?.id, "n2");
  await accounts.markRateLimited("n2", "429", 60_000);
  assert.equal(models.credentialForRequestedModel("sonnet")?.id, "n1");
  accounts.close();
});

test("pinned credentials are exact and do not silently rotate", async () => {
  const { accounts, models } = await fixture();
  const routes = models.snapshot().routes;
  routes.sonnet = { provider: "nvidia", model: "nim-model", credentialId: "n2", maxOutputTokens: 64000 };
  await models.update({ routes });
  assert.equal(models.credentialForRequestedModel("sonnet")?.id, "n2");
  await accounts.markRateLimited("n2", "429", 60_000);
  assert.equal(models.credentialForRequestedModel("sonnet"), undefined);
  assert.equal(models.healthFor("sonnet").status, "unavailable");
  accounts.close();
});

test("route save rejects nonexistent and provider-mismatched pins", async () => {
  const { accounts, models } = await fixture();
  const first = models.snapshot();
  first.routes.sonnet = { provider: "nvidia", model: "nim", credentialId: "missing", maxOutputTokens: 10 };
  await assert.rejects(() => models.update(first), (error: unknown) => error instanceof OpenAICCError && error.status === 422 && error.code === "credential_pin_not_found");
  const second = models.snapshot();
  second.routes.sonnet = { provider: "nvidia", model: "nim", credentialId: "g1", maxOutputTokens: 10 };
  await assert.rejects(() => models.update(second), (error: unknown) => error instanceof OpenAICCError && error.status === 422 && error.code === "credential_provider_mismatch");
  accounts.close();
});

test("route save rejects unsupported provider, empty model, invalid limits, and verified output-cap violations", async () => {
  const { accounts, models } = await fixture();
  const bad: any = models.snapshot();
  bad.routes.default.provider = "bogus";
  await assert.rejects(() => models.update(bad), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_provider");
  const badModel: any = models.snapshot();
  badModel.routes.default.model = "";
  await assert.rejects(() => models.update(badModel), (error: unknown) => error instanceof OpenAICCError && error.code === "model_required");
  const badOutput: any = models.snapshot();
  badOutput.routes.default.maxOutputTokens = 0;
  await assert.rejects(() => models.update(badOutput), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_number");
  const aboveVerified: any = models.snapshot();
  aboveVerified.routes.sonnet.maxOutputTokens = 65537;
  await assert.rejects(
    () => models.update(aboveVerified),
    (error: unknown) => error instanceof OpenAICCError && error.code === "max_output_exceeds_verified_cap",
  );
  accounts.close();
});

test("verified route contexts drive Claude Code capability aliases without over-advertising", async () => {
  const { accounts, models } = await fixture();
  const config = models.snapshot();
  assert.equal(config.contextWindow, 1000000);
  assert.equal(contextWindowForRoute(config, "default"), 1000000);
  assert.equal(contextWindowForRoute(config, "fable"), 1000000);
  assert.equal(contextWindowForRoute(config, "opus"), 200000);
  assert.equal(contextWindowForRoute(config, "sonnet"), 1000000);
  assert.equal(contextWindowForRoute(config, "haiku"), 1000000);

  assert.equal(claudeCodeModelAlias(config, "default"), "claude-opus-4-8[1m]");
  assert.equal(claudeCodeModelAlias(config, "fable"), "claude-fable-5[1m]");
  assert.equal(claudeCodeModelAlias(config, "opus"), "claude-opus-5");
  assert.equal(claudeCodeModelAlias(config, "sonnet"), "claude-sonnet-5");
  assert.equal(claudeCodeModelAlias(config, "haiku"), "claude-opus-4-7[1m]");
  assert.equal(models.slotForRequestedModel("claude-opus-4-8[1m]"), "default");
  assert.equal(models.slotForRequestedModel("claude-fable-5"), "fable");
  assert.equal(models.slotForRequestedModel("claude-sonnet-5"), "sonnet");
  assert.equal(models.slotForRequestedModel("claude-opus-4-7[1m]"), "haiku");

  const changed = models.snapshot();
  changed.routes.haiku = { provider: "nvidia", model: "unverified-haiku", maxOutputTokens: 32000 };
  const conservative = await models.update(changed);
  assert.equal(contextWindowForRoute(conservative, "haiku"), 200000);
  assert.equal(claudeCodeModelAlias(conservative, "haiku"), "claude-haiku-4-5");
  accounts.close();
});

test("load repair clamps stored output limits to verified known-model safety caps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-output-repair-"));
  const accounts = new AccountStore(root); await accounts.init();
  await writeFile(path.join(root, "model-config.json"), JSON.stringify({
    contextWindow: 850000,
    routes: {
      default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
      fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
      opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 },
      sonnet: { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 999999 },
      haiku: { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 50000 },
    },
  }));
  const models = new ModelConfigStore(root, accounts); await models.init();
  assert.equal(models.snapshot().routes.sonnet.maxOutputTokens, 16384);
  assert.equal(models.snapshot().routes.haiku.maxOutputTokens, 16384);
  const persisted = JSON.parse(await readFile(path.join(root, "model-config.json"), "utf8"));
  assert.equal(persisted.routes.sonnet.maxOutputTokens, 16384);
  assert.equal(persisted.routes.haiku.maxOutputTokens, 16384);
  accounts.close();
});

test("existing user-selected routes survive upgrade unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-preserve-"));
  const accounts = new AccountStore(root); await accounts.init();
  await writeFile(path.join(root, "model-config.json"), JSON.stringify({
    contextWindow: 850000, routes: {
      default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
      fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
      opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 },
      sonnet: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: 32000 },
      haiku: { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 16384 },
    },
  }));
  const models = new ModelConfigStore(root, accounts); await models.init();
  assert.equal(models.snapshot().contextWindow, 850000);
  assert.equal(models.snapshot().routes.sonnet.model, "gemini-3.6-flash");
  assert.equal(models.snapshot().routes.sonnet.maxOutputTokens, 32000);
  assert.equal(models.snapshot().routes.haiku.provider, "cloudflare");
  accounts.close();
});
