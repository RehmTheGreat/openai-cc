import { AccountStore } from "../src/account-store.js";
import { configureClaudeCode } from "../src/claude-config.js";
import { configureClaudeDesktop } from "../src/claude-desktop.js";
import { ModelConfigStore } from "../src/model-config.js";

const dataDir = process.env.DATA_DIR || ".data";
const baseUrl = String(process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:8082").replace(/\/+$/, "");
const requestedContext = Number(process.env.OPENAI_CC_CONTEXT_WINDOW || 850000);
if (!Number.isFinite(requestedContext) || requestedContext < 200000 || requestedContext > 1000000) {
  throw new Error(`OPENAI_CC_CONTEXT_WINDOW must be between 200000 and 1000000; got ${process.env.OPENAI_CC_CONTEXT_WINDOW}.`);
}

const store = new AccountStore(dataDir);
await store.init();
const models = new ModelConfigStore(dataDir, store);
await models.init();
const config = await models.update({ contextWindow: Math.floor(requestedContext) });

const code = await configureClaudeCode(baseUrl, config);
console.log(`Claude Code configured: ${code.settingsFile}`);

if (process.env.OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0") {
  const desktop = await configureClaudeDesktop(baseUrl, config);
  if (desktop.supported) console.log(`Claude Desktop configured: ${desktop.profileFile}`);
}
