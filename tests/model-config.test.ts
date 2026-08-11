import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { OpenAICCError } from "../src/errors.js";
import { ModelConfigStore, claudeCodeModelAlias, contextWindowForRoute } from "../src/model-config.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-"));
  const accounts = new AccountStore(root);
  await accounts.init();
  await accounts.createApiKey({ id: "n1", name: "NVIDIA 1", provider: "nvidia", apiKey: "a", model: "m" });
  await accounts.createApiKey({ id: "n2", name: "NVIDIA 2", provider: "nvidia", apiKey: "b", model: "m" });
  await accounts.createApiKey({ id: "g1", name: "Google 1", provider: "google", apiKey: "c", model: "m" });
  const models = new ModelConfigStore(root, accounts);
  await models.init();
  return { accounts, models };
}

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

test("route save rejects unsupported provider, empty model, and invalid limits", async () => {
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
  accounts.close();
});


test("verified route contexts drive Claude Code capability aliases without over-advertising", async () => {
  const { accounts, models } = await fixture();
  const config = models.snapshot();
  assert.equal(config.contextWindow, 850000);
  assert.equal(contextWindowForRoute(config, "default"), 850000);
  assert.equal(contextWindowForRoute(config, "fable"), 850000);
  assert.equal(contextWindowForRoute(config, "opus"), 200000);
  assert.equal(contextWindowForRoute(config, "sonnet"), 850000);
  assert.equal(contextWindowForRoute(config, "haiku"), 850000);

  assert.equal(claudeCodeModelAlias(config, "default"), "claude-opus-4-8[1m]");
  assert.equal(claudeCodeModelAlias(config, "fable"), "claude-fable-5[1m]");
  assert.equal(claudeCodeModelAlias(config, "opus"), "claude-opus-5");
  assert.equal(claudeCodeModelAlias(config, "sonnet"), "claude-sonnet-5");
  assert.equal(models.slotForRequestedModel("claude-opus-4-8"), "default");
  assert.equal(models.slotForRequestedModel("claude-fable-5"), "fable");
  assert.equal(models.slotForRequestedModel("claude-sonnet-5"), "sonnet");
  assert.equal(models.slotForRequestedModel("claude-opus-4-7"), "haiku");

  const changed = models.snapshot();
  changed.routes.haiku = { provider: "nvidia", model: "unverified-haiku", maxOutputTokens: 32000 };
  const conservative = await models.update(changed);
  assert.equal(contextWindowForRoute(conservative, "haiku"), 200000);
  assert.equal(claudeCodeModelAlias(conservative, "haiku"), "claude-haiku-4-5");
  accounts.close();
});
