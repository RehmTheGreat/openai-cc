import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const CLAUDE_VERSION = "2.1.226";
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
const configured = settings.env ?? {};
const env = {
  ...process.env,
  ...Object.fromEntries(Object.entries(configured).map(([key, value]) => [key, String(value)])),
  NO_COLOR: "1",
};

function runClaudeRaw(args) {
  const npmArgs = ["exec", "--yes", "--package=@anthropic-ai/claude-code@" + CLAUDE_VERSION, "--", "claude", ...args];
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...npmArgs] : npmArgs;
  const result = spawnSync(command, commandArgs, { env, encoding: "utf8", timeout: 120000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error) throw result.error;
  return { ...result, output };
}

function runClaude(args) {
  const result = runClaudeRaw(args);
  if (result.status !== 0) throw new Error("Claude Code failed (" + result.status + "):\n" + result.output);
  return result.output;
}

function parseContextBudget(output) {
  const match = output.match(/\*\*Tokens:\*\*[^\n]*\/\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM])\b/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Math.round(value * (match[2].toLowerCase() === "m" ? 1000000 : 1000));
}

async function probe(label, model, target) {
  let lastBudget;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const output = runClaude(["--model", model, "-p", "/context"]);
    const budget = parseContextBudget(output);
    lastBudget = budget;
    console.log(label + ": model=" + model + " client_context=" + (budget ?? "not displayed") + " attempt=" + attempt);
    if (budget === undefined) return;
    // Claude may round million-scale UI values (for example 1.05M -> 1.0M).
    const tolerance = Math.max(1000, Math.round(target * 0.05));
    if (Math.abs(budget - target) <= tolerance) return;
    await delay(500);
  }
  throw new Error(label + " displays context " + lastBudget + " instead of the Admin-configured " + target);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startGateway() {
  const baseUrl = new URL(String(configured.ANTHROPIC_BASE_URL));
  const port = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      HOST: baseUrl.hostname,
      PORT: port,
      DATA_DIR: process.env.DATA_DIR || path.join(os.tmpdir(), "openai-cc-context"),
      OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP: "0",
    },
    stdio: "ignore",
  });
  child.on("error", (error) => console.error("Gateway process error:", error));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) return child;
    } catch {}
    if (child.exitCode !== null) throw new Error("Gateway exited before context verification.");
    await delay(100);
  }
  child.kill();
  throw new Error("Gateway did not become ready for context verification.");
}

const version = runClaude(["--version"]);
if (!version.includes(CLAUDE_VERSION)) {
  throw new Error("Expected Claude Code " + CLAUDE_VERSION + ", got: " + version);
}

if (String(configured.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "") !== "1") {
  throw new Error("Gateway model discovery must be enabled for the five logical route catalog.");
}
if (String(configured.CLAUDE_CODE_USE_GATEWAY ?? "") !== "1") {
  throw new Error("CLAUDE_CODE_USE_GATEWAY must be enabled.");
}

const expectedAvailableModels = ["default", "fable", "opus", "sonnet", "haiku"];
if (JSON.stringify(settings.availableModels) !== JSON.stringify(expectedAvailableModels)) {
  throw new Error("Claude availableModels must expose exactly the five logical routes. Got: " + JSON.stringify(settings.availableModels));
}

const target = Number(configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
if (!Number.isSafeInteger(target) || target < 1) {
  throw new Error("Invalid CLAUDE_CODE_AUTO_COMPACT_WINDOW: " + configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
}
if (String(configured.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "") !== String(target)) {
  throw new Error("CLAUDE_CODE_MAX_CONTEXT_TOKENS must equal the Admin context: " + target);
}
if (String(configured.DISABLE_COMPACT ?? "") !== "0") {
  throw new Error("DISABLE_COMPACT must remain false so Claude compaction stays enabled.");
}
if (String(configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "") !== String(target)) {
  throw new Error("CLAUDE_CODE_AUTO_COMPACT_WINDOW must equal the Admin context: " + target);
}

const expectedPins = {
  ANTHROPIC_MODEL: "default",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "fable",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
};
for (const [key, expected] of Object.entries(expectedPins)) {
  if (configured[key] !== expected) throw new Error(key + " must be " + expected + "; got " + configured[key]);
}
const expectedNames = {
  ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "Fable",
  ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet",
  ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Haiku",
};
for (const [key, expected] of Object.entries(expectedNames)) {
  if (configured[key] !== expected) throw new Error(key + " must be " + expected + "; got " + configured[key]);
}

const serializedSettings = JSON.stringify(settings);
if (/\[1m\]|openai-cc-(?:fable|sonnet)/i.test(serializedSettings)) {
  throw new Error("Stale long-context carrier aliases remain in Claude settings: " + serializedSettings);
}

console.log("Claude Code version:", version.split("\n")[0]);
console.log("CLAUDE_CODE_MAX_CONTEXT_TOKENS=" + target);
console.log("CLAUDE_CODE_AUTO_COMPACT_WINDOW=" + target);
console.log("DISABLE_COMPACT=0");
console.log("availableModels=" + JSON.stringify(settings.availableModels));

const gateway = await startGateway();
try {
  const modelsResponse = await fetch(new URL("/v1/models?limit=1000", configured.ANTHROPIC_BASE_URL));
  if (!modelsResponse.ok) throw new Error("Gateway /v1/models failed with HTTP " + modelsResponse.status);
  const catalog = await modelsResponse.json();
  const ids = catalog.data?.map((model) => model.id) ?? [];
  if (JSON.stringify(ids) !== JSON.stringify(expectedAvailableModels)) {
    throw new Error("Gateway model catalog must contain exactly the five logical routes. Got: " + JSON.stringify(ids));
  }
  for (const model of catalog.data ?? []) {
    if (model.max_input_tokens !== target) {
      throw new Error(model.id + " gateway max_input_tokens=" + model.max_input_tokens + " instead of " + target);
    }
  }

  for (const model of expectedAvailableModels) {
    await probe(model, model, target);
  }
} finally {
  gateway.kill();
}
