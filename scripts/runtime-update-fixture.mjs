import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, rootArg] = process.argv.slice(2);
if (!mode || !rootArg || !["seed", "verify"].includes(mode)) {
  throw new Error("Usage: node scripts/runtime-update-fixture.mjs <seed|verify> <install-root>");
}

const installRoot = path.resolve(rootArg);
const runtimeRoot = path.join(installRoot, "current");
const dataDir = path.join(installRoot, ".data");

async function runtimeImport(relative) {
  return import(pathToFileURL(path.join(runtimeRoot, relative)).href);
}

const { AccountStore } = await runtimeImport("dist/src/account-store.js");
const { ModelConfigStore } = await runtimeImport("dist/src/model-config.js");
const { ProviderRegistry } = await runtimeImport("dist/src/provider-registry.js");

const providerName = "Session 6A CI Custom Provider";
const providerBaseUrl = "https://session6a.invalid/v1";
const modelId = "session6a-custom-model";
const preferredId = "session6a-custom-primary";
const disabledId = "session6a-custom-disabled";
const primarySecret = "session6a-ci-primary-secret";
const disabledSecret = "session6a-ci-disabled-secret";

if (mode === "seed") {
  const accounts = new AccountStore(dataDir);
  await accounts.init();
  const providers = new ProviderRegistry(dataDir);
  await providers.init();
  const models = new ModelConfigStore(dataDir, accounts, providers);
  await models.init();

  const provider = await providers.createCustom({
    displayName: providerName,
    baseUrl: providerBaseUrl,
    apiStyle: "responses",
  });
  await providers.upsertManualModel(provider.id, {
    id: modelId,
    contextWindow: 333000,
    maxOutputTokens: 8192,
  });

  await accounts.createApiKey({
    id: preferredId,
    name: "Session 6A preferred credential",
    provider: provider.id,
    apiKey: primarySecret,
    model: modelId,
  });
  await accounts.createApiKey({
    id: disabledId,
    name: "Session 6A disabled credential",
    provider: provider.id,
    apiKey: disabledSecret,
    model: modelId,
  });
  await accounts.disable(disabledId);
  await accounts.prefer(preferredId);

  await models.update({
    contextWindow: 850000,
    routes: {
      default: {
        provider: provider.id,
        model: modelId,
        credentialId: preferredId,
        maxOutputTokens: 8192,
      },
    },
  });
  accounts.close();
  console.log("Session 6A persistence fixture seeded.");
} else {
  const providersFile = JSON.parse(await readFile(path.join(dataDir, "providers.json"), "utf8"));
  const accountsFile = JSON.parse(await readFile(path.join(dataDir, "accounts.json"), "utf8"));
  const modelConfig = JSON.parse(await readFile(path.join(dataDir, "model-config.json"), "utf8"));

  const provider = providersFile.providers.find((item) => item.displayName === providerName);
  assert.ok(provider, "custom provider did not survive update");
  assert.equal(provider.baseUrl, providerBaseUrl);
  assert.equal(provider.apiStyle, "responses");
  assert.deepEqual(provider.models, [{ id: modelId, contextWindow: 333000, maxOutputTokens: 8192 }]);

  const primary = accountsFile.accounts.find((item) => item.id === preferredId);
  const disabled = accountsFile.accounts.find((item) => item.id === disabledId);
  assert.ok(primary, "preferred custom-provider credential did not survive update");
  assert.ok(disabled, "disabled custom-provider credential did not survive update");
  assert.equal(primary.provider, provider.id);
  assert.equal(primary.apiKey, primarySecret);
  assert.equal(primary.status, "ready");
  assert.equal(disabled.provider, provider.id);
  assert.equal(disabled.apiKey, disabledSecret);
  assert.equal(disabled.status, "disabled");
  assert.equal(accountsFile.preferredCredentialByProvider[provider.id], preferredId);

  assert.equal(modelConfig.routes.default.provider, provider.id);
  assert.equal(modelConfig.routes.default.model, modelId);
  assert.equal(modelConfig.routes.default.credentialId, preferredId);
  assert.equal(modelConfig.routes.default.maxOutputTokens, 8192);
  assert.equal(modelConfig.contextWindow, 850000);

  console.log("Session 6A persistence fixture verified.");
}
