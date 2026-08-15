import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { OpenAICCError } from "../src/errors.js";
import {
  CLOUDFLARE_GEMMA_MODEL,
  ModelConfigStore,
  capabilitiesForRoute,
  claudeCodeModelAlias,
  claudeCodeTransportAlias,
  contextWindowForRoute,
} from "../src/model-config.js";

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

test("fresh routing uses model-specific context defaults", async () => {
  const { accounts, models } = await fixture();
  const config = models.snapshot();
  assert.deepEqual(config.routes.default, { provider: "chatgpt", model: "gpt-5.6-luna", contextWindow: 1_000_000, maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.fable, { provider: "chatgpt", model: "gpt-5.6-luna", contextWindow: 1_000_000, maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.opus, { provider: "zen", model: "deepseek-v4-flash-free", contextWindow: 200_000, maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.sonnet, { provider: "google", model: "gemini-3.5-flash-lite", contextWindow: 1_000_000, maxOutputTokens: 65536 });
  assert.deepEqual(config.routes.haiku, { provider: "google", model: "gemini-3.5-flash-lite", contextWindow: 1_000_000, maxOutputTokens: 65536 });
  accounts.close();
});

test("auto routing uses preferred ready credential then same-provider fallback", async () => {
  const { accounts, models } = await fixture();
  await models.update({ routes: { sonnet: { provider: "nvidia", model: "nim-model", maxOutputTokens: 64000 } } });
  await accounts.prefer("n2");
  assert.equal(models.credentialForRequestedModel("sonnet")?.id, "n2");
  await accounts.markRateLimited("n2", "429", 60_000);
  assert.equal(models.credentialForRequestedModel("sonnet")?.id, "n1");
  accounts.close();
});

test("pinned credentials are exact and do not silently rotate", async () => {
  const { accounts, models } = await fixture();
  const routes = models.snapshot().routes;
  routes.sonnet = { ...routes.sonnet, provider: "nvidia", model: "nim-model", credentialId: "n2", maxOutputTokens: 64000 };
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
  first.routes.sonnet = { ...first.routes.sonnet, provider: "nvidia", model: "nim", credentialId: "missing", maxOutputTokens: 10 };
  await assert.rejects(() => models.update(first), (error: unknown) => error instanceof OpenAICCError && error.status === 422 && error.code === "credential_pin_not_found");
  const second = models.snapshot();
  second.routes.sonnet = { ...second.routes.sonnet, provider: "nvidia", model: "nim", credentialId: "g1", maxOutputTokens: 10 };
  await assert.rejects(() => models.update(second), (error: unknown) => error instanceof OpenAICCError && error.status === 422 && error.code === "credential_provider_mismatch");
  accounts.close();
});

test("route save rejects unsupported provider, empty model, invalid context/output, and verified output-cap violations", async () => {
  const { accounts, models } = await fixture();
  const bad: any = models.snapshot(); bad.routes.default.provider = "bogus";
  await assert.rejects(() => models.update(bad), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_provider");
  const badModel: any = models.snapshot(); badModel.routes.default.model = "";
  await assert.rejects(() => models.update(badModel), (error: unknown) => error instanceof OpenAICCError && error.code === "model_required");
  const badContext: any = models.snapshot(); badContext.routes.default.contextWindow = 0;
  await assert.rejects(() => models.update(badContext), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_number");
  const badOutput: any = models.snapshot(); badOutput.routes.default.maxOutputTokens = 0;
  await assert.rejects(() => models.update(badOutput), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_number");
  const aboveVerified: any = models.snapshot(); aboveVerified.routes.sonnet.maxOutputTokens = 65537;
  await assert.rejects(() => models.update(aboveVerified), (error: unknown) => error instanceof OpenAICCError && error.code === "max_output_exceeds_verified_cap");
  accounts.close();
});

test("route context windows are independent, authoritative, and choose the correct Claude carrier", async () => {
  const { accounts, models } = await fixture();
  const changed = models.snapshot();
  changed.routes.default.contextWindow = 360000;
  changed.routes.fable.contextWindow = 850000;
  changed.routes.opus.contextWindow = 131072;
  changed.routes.sonnet.contextWindow = 1000000;
  changed.routes.haiku.contextWindow = 200000;
  const config = await models.update(changed);

  assert.equal(contextWindowForRoute(config, "default"), 360000);
  assert.equal(contextWindowForRoute(config, "fable"), 850000);
  assert.equal(contextWindowForRoute(config, "opus"), 131072);
  assert.equal(contextWindowForRoute(config, "sonnet"), 1000000);
  assert.equal(contextWindowForRoute(config, "haiku"), 200000);
  assert.equal(config.contextWindow, 1000000, "derived compatibility ceiling must be the largest route window");

  assert.equal(claudeCodeModelAlias(config, "default"), "claude-opus-4-8[1m]");
  assert.equal(claudeCodeModelAlias(config, "fable"), "claude-fable-5[1m]");
  assert.equal(claudeCodeModelAlias(config, "opus"), "claude-opus-5");
  assert.equal(claudeCodeModelAlias(config, "sonnet"), "claude-sonnet-4-6[1m]");
  assert.equal(claudeCodeModelAlias(config, "haiku"), "claude-haiku-4-5");
  assert.equal(claudeCodeTransportAlias(config, "default"), "claude-sonnet-5");
  assert.equal(claudeCodeTransportAlias(config, "fable"), "openai-cc-fable");
  assert.equal(claudeCodeTransportAlias(config, "opus"), "claude-opus-5");
  assert.equal(claudeCodeTransportAlias(config, "sonnet"), "openai-cc-sonnet");
  assert.equal(claudeCodeTransportAlias(config, "haiku"), "claude-haiku-4-5");
  assert.equal(models.slotForRequestedModel("claude-sonnet-5"), "default");
  assert.equal(models.slotForRequestedModel("openai-cc-fable"), "fable");
  assert.equal(models.slotForRequestedModel("openai-cc-sonnet"), "sonnet");
  assert.equal(models.slotForRequestedModel("claude-opus-5"), "opus");
  assert.equal(models.slotForRequestedModel("claude-haiku-4-5"), "haiku");
  accounts.close();
});

test("route capability overrides are persisted independently of provider discovery", async () => {
  const { accounts, models } = await fixture();
  const changed = models.snapshot();
  changed.routes.sonnet.vision = false;
  changed.routes.sonnet.tools = false;
  changed.routes.sonnet.reasoning = false;
  const saved = await models.update(changed);
  assert.equal(saved.routes.sonnet.vision, false);
  assert.equal(saved.routes.sonnet.tools, false);
  assert.equal(saved.routes.sonnet.reasoning, false);
  const caps = capabilitiesForRoute(saved.routes.sonnet);
  assert.equal(caps.image, false);
  assert.equal(caps.tools, false);
  assert.equal(caps.reasoning, false);
  accounts.close();
});

test("load repair clamps stored output limits and migrates the legacy global context into each route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-output-repair-"));
  const accounts = new AccountStore(root); await accounts.init();
  await writeFile(path.join(root, "model-config.json"), JSON.stringify({ contextWindow: 850000, routes: {
    default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 },
    sonnet: { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 999999 },
    haiku: { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 50000 },
  } }));
  const models = new ModelConfigStore(root, accounts); await models.init();
  const snapshot = models.snapshot();
  assert.equal(snapshot.routes.default.contextWindow, 850000);
  assert.equal(snapshot.routes.fable.contextWindow, 850000);
  assert.equal(snapshot.routes.opus.contextWindow, 200000);
  assert.equal(snapshot.routes.sonnet.contextWindow, 200000);
  assert.equal(snapshot.routes.haiku.contextWindow, 200000);
  assert.equal(snapshot.routes.sonnet.maxOutputTokens, 16384);
  assert.equal(snapshot.routes.haiku.maxOutputTokens, 16384);
  const persisted = JSON.parse(await readFile(path.join(root, "model-config.json"), "utf8"));
  assert.equal(persisted.contextWindow, undefined);
  assert.equal(persisted.routes.sonnet.contextWindow, 200000);
  assert.equal(persisted.routes.sonnet.maxOutputTokens, 16384);
  assert.equal(persisted.routes.haiku.maxOutputTokens, 16384);
  accounts.close();
});

test("existing user-selected routes and capability overrides survive upgrade with effective legacy contexts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-preserve-"));
  const accounts = new AccountStore(root); await accounts.init();
  await writeFile(path.join(root, "model-config.json"), JSON.stringify({ contextWindow: 850000, routes: {
    default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 },
    sonnet: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: 32000, vision: false, tools: true, reasoning: false },
    haiku: { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 16384 },
  } }));
  const models = new ModelConfigStore(root, accounts); await models.init();
  const snapshot = models.snapshot();
  assert.equal(snapshot.routes.default.contextWindow, 850000);
  assert.equal(snapshot.routes.fable.contextWindow, 850000);
  assert.equal(snapshot.routes.opus.contextWindow, 200000);
  assert.equal(snapshot.routes.sonnet.contextWindow, 850000);
  assert.equal(snapshot.routes.haiku.contextWindow, 200000);
  assert.equal(snapshot.routes.sonnet.model, "gemini-3.6-flash");
  assert.equal(snapshot.routes.sonnet.maxOutputTokens, 32000);
  assert.equal(snapshot.routes.sonnet.vision, false);
  assert.equal(snapshot.routes.sonnet.tools, true);
  assert.equal(snapshot.routes.haiku.provider, "cloudflare");
  accounts.close();
});
