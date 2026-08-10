import { AccountStore } from "./account-store.js";
import { configureClaudeCode } from "./claude-config.js";
import { createServer } from "./dispatcher.js";
import { ModelConfigStore } from "./model-config.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8082);
const dataDir = process.env.DATA_DIR || ".data";
const store = new AccountStore(dataDir);
await store.init();
const modelConfig = new ModelConfigStore(dataDir, store);
await modelConfig.init();

const baseUrl = `http://${host}:${port}`;
try {
  const configured = await configureClaudeCode(baseUrl, modelConfig.snapshot());
  console.log(`Claude Code configured: ${configured.settingsFile}`);
} catch (error: any) {
  console.warn(`Claude Code auto-config failed: ${error?.message ?? String(error)}`);
}

const server = createServer(store, modelConfig);
server.listen(port, host, () => {
  console.log(`Anthropic-compatible endpoint: ${baseUrl}`);
  console.log(`Admin panel: ${baseUrl}/admin`);
  console.log(`Context window: ${modelConfig.snapshot().contextWindow}`);
});
