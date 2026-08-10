import { AccountStore } from "./account-store.js";
import { configureClaudeCode } from "./claude-config.js";
import { configureClaudeDesktop } from "./claude-desktop.js";
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

if (process.env.OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0") {
  try {
    const configured = await configureClaudeDesktop(baseUrl, modelConfig.snapshot());
    if (configured.supported) console.log(`Claude Desktop configured: ${configured.profileFile}`);
  } catch (error: any) {
    console.warn(`Claude Desktop auto-config failed: ${error?.message ?? String(error)}`);
  }
}

const server = createServer(store, modelConfig, { bindHost: host });
server.listen(port, host, () => {
  console.log(`Anthropic-compatible endpoint: ${baseUrl}`);
  if (isLoopback(host) || process.env.OPENAI_CC_UNSAFE_REMOTE_ADMIN === "1") console.log(`Admin panel: ${baseUrl}/admin`);
  else console.log("Admin panel: disabled because HOST is not loopback (set OPENAI_CC_UNSAFE_REMOTE_ADMIN=1 only behind your own protection). ");
  console.log(`Context window: ${modelConfig.snapshot().contextWindow}`);
});

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  const timer = setTimeout(() => process.exit(1), 5000);
  timer.unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function isLoopback(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}
