import path from "node:path";
import { AccountStore } from "../src/account-store.js";
import { ModelConfigStore } from "../src/model-config.js";
import { ProviderRegistry } from "../src/provider-registry.js";

const rawDataDir = process.argv[2];
if (!rawDataDir) throw new Error("Usage: node migrate-data.js <data-dir>");

const dataDir = path.resolve(rawDataDir);
const accounts = new AccountStore(dataDir);

try {
  await accounts.init();
  const providers = new ProviderRegistry(dataDir);
  await providers.init();
  const models = new ModelConfigStore(dataDir, accounts, providers);
  await models.init();
  console.log("Persistent data schema is compatible with this runtime.");
} finally {
  accounts.close();
}
