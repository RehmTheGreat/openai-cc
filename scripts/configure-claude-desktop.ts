import { AccountStore } from "../src/account-store.js";
import { configureClaudeDesktop } from "../src/claude-desktop.js";
import { ModelConfigStore } from "../src/model-config.js";

const dataDir = process.env.DATA_DIR || ".data";
const baseUrl = String(process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:8082").replace(/\/+$/, "");
const store = new AccountStore(dataDir);
await store.init();
const models = new ModelConfigStore(dataDir, store);
await models.init();

const result = await configureClaudeDesktop(baseUrl, models.snapshot());
if (!result.supported) {
  throw new Error(`Claude Desktop 3P auto-configuration is supported on Windows and macOS; current platform is ${process.platform}.`);
}
console.log(`Claude Desktop configured: ${result.profileFile}`);
