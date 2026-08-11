import http from "node:http";
import { AccountStore } from "./account-store.js";
import { runtimeIdentity } from "./build-info.js";
import { configureClaudeCode } from "./claude-config.js";
import { configureClaudeDesktop } from "./claude-desktop.js";
import { ModelConfigStore } from "./model-config.js";
import { ReplicatedDispatcher } from "./replicated-dispatcher.js";
import { ProviderRegistry } from "./provider-registry.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8082);
const dataDir = process.env.DATA_DIR || ".data";
const store = new AccountStore(dataDir);
await store.init();
const providers = new ProviderRegistry(dataDir);
await providers.init();
const modelConfig = new ModelConfigStore(dataDir, store, providers);
await modelConfig.init();

const baseUrl = `http://${host}:${port}`;
try {
  const configured = await configureClaudeCode(baseUrl, modelConfig.snapshot(), providers);
  console.log(`Claude Code configured: ${configured.settingsFile}`);
} catch (error: any) {
  console.warn(`Claude Code auto-config failed: ${error?.message ?? String(error)}`);
}

if (process.env.OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0") {
  try {
    const configured = await configureClaudeDesktop(baseUrl, modelConfig.snapshot(), providers);
    if (configured.supported) console.log(`Claude Desktop configured: ${configured.profileFile}`);
  } catch (error: any) {
    console.warn(`Claude Desktop auto-config failed: ${error?.message ?? String(error)}`);
  }
}

const dispatcher = new ReplicatedDispatcher(store, modelConfig, { bindHost: host, providerRegistry: providers });
const server = http.createServer((req, res) => {
  const pathname = safePath(req.url, req.headers.host);
  if (req.method === "GET" && pathname === "/healthz") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(runtimeIdentity(modelConfig.snapshot().contextWindow)));
    return;
  }
  void dispatcher.handler(req, res);
});
server.on("close", () => { void dispatcher.close(); });

server.listen(port, host, () => {
  console.log(`Anthropic-compatible endpoint: ${baseUrl}`);
  if (isLoopback(host) || process.env.OPENAI_CC_UNSAFE_REMOTE_ADMIN === "1") console.log(`Admin panel: ${baseUrl}/admin`);
  else console.log("Admin panel: disabled because HOST is not loopback (set OPENAI_CC_UNSAFE_REMOTE_ADMIN=1 only behind your own protection). ");
  console.log(`Context window: ${modelConfig.snapshot().contextWindow}`);
  const identity = runtimeIdentity(modelConfig.snapshot().contextWindow);
  console.log(`Build: ${identity.buildSha} (${identity.buildTime}) pid=${identity.pid} root=${identity.installRoot}`);
});

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  server.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function safePath(url: string | undefined, hostHeader: string | undefined): string {
  try { return new URL(url ?? "/", `http://${hostHeader ?? "127.0.0.1"}`).pathname; }
  catch { return url?.split("?", 1)[0] ?? "/"; }
}

function isLoopback(value: string): boolean {
  const normalized = value.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}
