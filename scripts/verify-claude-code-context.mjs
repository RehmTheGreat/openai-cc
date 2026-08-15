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
  if (!match) throw new Error("Could not parse /context token budget:\n" + output);
  const value = Number(match[1]);
  return Math.round(value * (match[2].toLowerCase() === "m" ? 1000000 : 1000));
}

const version = runClaude(["--version"]);
if (!version.includes(CLAUDE_VERSION)) {
  throw new Error("Expected Claude Code " + CLAUDE_VERSION + ", got: " + version);
}

if (String(configured.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "") === "1") {
  throw new Error("Gateway model discovery must stay disabled: the five logical routes are already supplied by ANTHROPIC_*_MODEL settings.");
}
if (String(configured.CLAUDE_CODE_USE_GATEWAY ?? "") !== "1") {
  throw new Error("CLAUDE_CODE_USE_GATEWAY must be enabled for third-party context capability handling.");
}

const expectedAvailableModels = ["fable", "opus", "sonnet", "haiku"];
if (JSON.stringify(settings.availableModels) !== JSON.stringify(expectedAvailableModels)) {
  throw new Error("Claude availableModels must expose only the four named OpenAI-CC aliases; Default is always present. Got: " + JSON.stringify(settings.availableModels));
}

const target = Number(configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
if (!Number.isFinite(target) || target < 200000 || target > 1000000) {
  throw new Error("Invalid CLAUDE_CODE_AUTO_COMPACT_WINDOW: " + configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
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

const probes = [
  ["default/luna", configured.ANTHROPIC_MODEL, target, target],
  ["fable/luna", configured.ANTHROPIC_DEFAULT_FABLE_MODEL, target, target],
  ["opus/deepseek-free", configured.ANTHROPIC_DEFAULT_OPUS_MODEL, 0, 250000],
  ["sonnet/gemini-flash-lite", configured.ANTHROPIC_DEFAULT_SONNET_MODEL, target, target],
  ["haiku/gemini-flash-lite", configured.ANTHROPIC_DEFAULT_HAIKU_MODEL, target, target],
];

console.log("Claude Code version:", version.split("\n")[0]);
console.log("CLAUDE_CODE_USE_GATEWAY=" + configured.CLAUDE_CODE_USE_GATEWAY);
console.log("CLAUDE_CODE_AUTO_COMPACT_WINDOW=" + configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
console.log("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=" + String(configured.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "<unset>"));
console.log("availableModels=" + JSON.stringify(settings.availableModels));

for (const [label, model, min, max] of probes) {
  if (!model) throw new Error("Missing configured model for " + label);
  const output = runClaude(["--model", String(model), "-p", "/context"]);
  const budget = parseContextBudget(output);
  console.log(label + ": model=" + model + " client_context=" + budget);
  if (budget < min || budget > max) {
    throw new Error(
      label + " context " + budget + " outside expected range " + min + ".." + max + "\n" + output,
    );
  }
}

// The picker allowlist must hide explicit extended variants while the base logical
// alias still resolves through its pinned [1m] carrier. This is the key invariant
// that removes "Fable 1M" without regressing Fable's actual context budget.
const fableAlias = runClaude(["--model", "fable", "-p", "/context"]);
const fableAliasBudget = parseContextBudget(fableAlias);
console.log("fable alias: client_context=" + fableAliasBudget);
if (fableAliasBudget !== target) {
  throw new Error("Base Fable alias lost the configured context target: " + fableAliasBudget + " != " + target);
}

const blockedExtended = runClaudeRaw(["--model", "fable[1m]", "-p", "/context"]);
if (blockedExtended.status === 0) {
  throw new Error("Explicit fable[1m] is still selectable despite the five-route availableModels policy.\n" + blockedExtended.output);
}
console.log("explicit fable[1m] blocked by availableModels as expected");
