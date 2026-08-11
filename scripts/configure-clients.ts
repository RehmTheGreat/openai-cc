import { AccountStore } from "../src/account-store.js";
import { configureClaudeCode } from "../src/claude-config.js";
import { configureClaudeDesktop } from "../src/claude-desktop.js";
import { ModelConfigStore } from "../src/model-config.js";
import { ProviderRegistry } from "../src/provider-registry.js";

const dataDir = process.env.DATA_DIR || ".data";
const baseUrl = String(process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:8082").replace(/\/+$/, "");

const store = new AccountStore(dataDir);
await store.init();
const providers = new ProviderRegistry(dataDir);
await providers.init();
const models = new ModelConfigStore(dataDir, store, providers);
await models.init();

// ModelConfigStore creates Session 4.5 defaults only when model-config.json is
// absent. Existing installations are intentionally read-only here: an update
// must not rewrite user routes, pins, custom-provider selections, output caps,
// or their configured context target just because clients are being refreshed.
const config = models.snapshot();

const code = await configureClaudeCode(baseUrl, config, providers);
console.log(`Claude Code configured: ${code.settingsFile}`);

if (process.env.OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0") {
  const desktop = await configureClaudeDesktop(baseUrl, config, providers);
  if (desktop.supported) console.log(`Claude Desktop configured: ${desktop.profileFile}`);
}
