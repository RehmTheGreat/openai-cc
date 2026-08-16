import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { OpenAICCError } from "../src/errors.js";
import {
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

test("fresh routing uses Luna and a 1.05M configurable context", async () => {
  const { accounts, models } = await fixture();
  const config = models.snapshot();
  assert.deepEqual(config.routes.default, { provider: "chatgpt", model: "gpt-5.6-luna", contextWindow: 1_050_000, maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.fable, { provider: "chatgpt", model: "gpt-5.6-luna", contextWindow: 1_050_000, maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.opus, { provider: "zen", model: "deepseek-v4-flash-free", contextWindow: 1_050_000, maxOutputTokens: 128000 });
  assert.deepEqual(config.routes.sonnet, { provider: "google", model: "gemini-3.5-flash-lite", contextWindow: 1_050_000, maxOutputTokens: 65536 });
  assert.deepEqual(config.routes.haiku, { provider: "google", model: "gemini-3.5-flash-lite", contextWindow: 1_050_000, maxOutputTokens: 65536 });
  assert.equal(config.contextWindow, 1_050_000);
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

test("route validation is structural and does not invent model-specific limits", async () => {
  const { accounts, models } = await fixture();
  const bad: any = models.snapshot(); bad.routes.default.provider = "bogus";
  await assert.rejects(() => models.update(bad), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_provider");
  const badModel: any = models.snapshot(); badModel.routes.default.model = "";
  await assert.rejects(() => models.update(badModel), (error: unknown) => error instanceof OpenAICCError && error.code === "model_required");
  const badContext: any = models.snapshot(); badContext.routes.default.contextWindow = 0;
  await assert.rejects(() => models.update(badContext), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_number");
  const badOutput: any = models.snapshot(); badOutput.routes.default.maxOutputTokens = 0;
  await assert.rejects(() => models.update(badOutput), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_number");

  const high = models.snapshot();
  high.routes.default.contextWindow = 1_050_000;
  high.routes.sonnet.contextWindow = 2_000_000;
  high.routes.sonnet.maxOutputTokens = 200_000;
  const saved = await models.update(high);
  assert.equal(saved.routes.default.contextWindow, 1_050_000);
  assert.equal(saved.routes.sonnet.contextWindow, 2_000_000);
  assert.equal(saved.routes.sonnet.maxOutputTokens, 200_000);
  assert.equal(saved.contextWindow, 2_000_000);
  accounts.close();
});

test("route context windows are authoritative and Claude exposes only five logical aliases", async () => {
  const { accounts, models } = await fixture();
  const changed = models.snapshot();
  changed.routes.default.contextWindow = 360000;
  changed.routes.fable.contextWindow = 850000;
  changed.routes.opus.contextWindow = 1_050_000;
  changed.routes.sonnet.contextWindow = 1_234_567;
  changed.routes.haiku.contextWindow = 200000;
  const config = await models.update(changed);

  assert.equal(contextWindowForRoute(config, "default"), 360000);
  assert.equal(contextWindowForRoute(config, "fable"), 850000);
  assert.equal(contextWindowForRoute(config, "opus"), 1_050_000);
  assert.equal(contextWindowForRoute(config, "sonnet"), 1_234_567);
  assert.equal(contextWindowForRoute(config, "haiku"), 200000);
  assert.equal(config.contextWindow, 1_234_567);

  for (const slot of ["default", "fable", "opus", "sonnet", "haiku"] as const) {
    assert.equal(claudeCodeModelAlias(config, slot), slot);
    assert.equal(claudeCodeTransportAlias(config, slot), slot);
    assert.equal(models.slotForRequestedModel(slot), slot);
  }
  assert.equal(models.slotForRequestedModel("openai-cc-fable"), "fable", "old sessions remain routable");
  assert.equal(models.slotForRequestedModel("claude-sonnet-5"), "default", "old default carrier remains routable");
  accounts.close();
});

test("route capability overrides are persisted independently of provider discovery", async () => {
  const { accounts, models } = await fixture();
  const changed = models.snapshot();
  changed.routes.sonnet.vision = false;
  changed.routes.sonnet.tools = false;
  changed.routes.sonnet.reasoning = false;
  const saved = await models.update(changed);
  const caps = capabilitiesForRoute(saved.routes.sonnet);
  assert.equal(caps.image, false);
  assert.equal(caps.tools, false);
  assert.equal(caps.reasoning, false);
  accounts.close();
});

test("legacy global context migrates into missing route context without provider-specific clamping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-legacy-"));
  const accounts = new AccountStore(root); await accounts.init();
  await writeFile(path.join(root, "model-config.json"), JSON.stringify({ contextWindow: 850000, routes: {
    default: { provider: "chatgpt", model: "some-chatgpt-model", maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "another-chatgpt-model", maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "some-zen-model", maxOutputTokens: 128000 },
    sonnet: { provider: "google", model: "some-google-model", maxOutputTokens: 999999 },
    haiku: { provider: "cloudflare", model: "some-cloudflare-model", maxOutputTokens: 50000 },
  } }));
  const models = new ModelConfigStore(root, accounts); await models.init();
  const snapshot = models.snapshot();
  for (const slot of ["default", "fable", "opus", "sonnet", "haiku"] as const) assert.equal(snapshot.routes[slot].contextWindow, 850000);
  assert.equal(snapshot.routes.sonnet.maxOutputTokens, 999999);
  assert.equal(snapshot.routes.haiku.maxOutputTokens, 50000);
  const persisted = JSON.parse(await readFile(path.join(root, "model-config.json"), "utf8"));
  assert.equal(persisted.contextWindow, undefined);
  accounts.close();
});

test("existing user-selected routes and capability overrides survive upgrade", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-preserve-"));
  const accounts = new AccountStore(root); await accounts.init();
  await writeFile(path.join(root, "model-config.json"), JSON.stringify({ routes: {
    default: { provider: "chatgpt", model: "user-default", contextWindow: 1_050_000, maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "user-fable", contextWindow: 990000, maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "user-opus", contextWindow: 777777, maxOutputTokens: 128000 },
    sonnet: { provider: "google", model: "user-sonnet", contextWindow: 888888, maxOutputTokens: 32000, vision: false, tools: true, reasoning: false },
    haiku: { provider: "cloudflare", model: "user-haiku", contextWindow: 666666, maxOutputTokens: 16384 },
  } }));
  const models = new ModelConfigStore(root, accounts); await models.init();
  const snapshot = models.snapshot();
  assert.equal(snapshot.routes.default.model, "user-default");
  assert.equal(snapshot.routes.opus.contextWindow, 777777);
  assert.equal(snapshot.routes.sonnet.model, "user-sonnet");
  assert.equal(snapshot.routes.sonnet.maxOutputTokens, 32000);
  assert.equal(snapshot.routes.sonnet.vision, false);
  assert.equal(snapshot.routes.sonnet.tools, true);
  assert.equal(snapshot.routes.haiku.provider, "cloudflare");
  accounts.close();
});
