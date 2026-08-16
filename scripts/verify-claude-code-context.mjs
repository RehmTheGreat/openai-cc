import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

function probe(label, model, target) {
  const output = runClaude(["--model", model, "-p", "/context"]);
  const budget = parseContextBudget(output);
  console.log(label + ": model=" + model + " client_context=" + (budget ?? "not displayed"));
  if (budget !== undefined) {
    // Claude may round million-scale UI values (for example 1.05M -> 1.0M).
    const tolerance = Math.max(1000, Math.round(target * 0.05));
    if (Math.abs(budget - target) > tolerance) {
      throw new Error(label + " displays context " + budget + " instead of the Admin-configured " + target);
    }
  }
}

const version = runClaude(["--version"]);
if (!version.includes(CLAUDE_VERSION)) {
  throw new Error("Expected Claude Code " + CLAUDE_VERSION + ", got: " + version);
}

if (String(configured.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "") === "1") {
  throw new Error("Gateway model discovery must stay disabled so the five logical routes are not duplicated in the picker.");
}
if (String(configured.CLAUDE_CODE_USE_GATEWAY ?? "") !== "1") {
  throw new Error("CLAUDE_CODE_USE_GATEWAY must be enabled.");
}

const expectedAvailableModels = ["fable", "opus", "sonnet", "haiku"];
if (JSON.stringify(settings.availableModels) !== JSON.stringify(expectedAvailableModels)) {
  throw new Error("Claude availableModels must expose only the four named routes; Default is supplied by ANTHROPIC_MODEL. Got: " + JSON.stringify(settings.availableModels));
}

const target = Number(configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
if (!Number.isSafeInteger(target) || target < 1) {
  throw new Error("Invalid CLAUDE_CODE_AUTO_COMPACT_WINDOW: " + configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
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
console.log("CLAUDE_CODE_AUTO_COMPACT_WINDOW=" + target);
console.log("availableModels=" + JSON.stringify(settings.availableModels));

// If Claude displays a numeric context ceiling, it must track the Admin-set
// route rather than a fabricated 200K fallback. A client that omits the limit
// entirely is acceptable; OpenAI-CC does not invent a second client-side cap.
for (const model of ["default", "fable", "opus", "sonnet", "haiku"]) {
  probe(model, model, target);
}
