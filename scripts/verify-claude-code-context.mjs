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

function probe(label, model) {
  const output = runClaude(["--model", model, "-p", "/context"]);
  const budget = parseContextBudget(output);
  console.log(label + ": model=" + model + " client_context=" + budget);
  return budget;
}

const version = runClaude(["--version"]);
if (!version.includes(CLAUDE_VERSION)) {
  throw new Error("Expected Claude Code " + CLAUDE_VERSION + ", got: " + version);
}

if (String(configured.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "") === "1") {
  throw new Error("Gateway model discovery must stay disabled: the picker is supplied by Default plus the four named aliases.");
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

// The current public carrier selection uses explicit [1m] for Fable and Haiku,
// while Sonnet 5 can carry the configured long budget without a suffixed ID.
// The live /context probes below remain the source of truth for client budget.
for (const key of ["ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
  if (!String(configured[key] ?? "").endsWith("[1m]")) {
    throw new Error(key + " must carry [1m] for the fresh 1M route; got " + configured[key]);
  }
}
if (String(configured.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "").endsWith("[1m]")) {
  throw new Error("Fresh Opus/DeepSeek route is 200K and must not carry [1m].");
}
if (settings.modelOverrides?.["claude-fable-5"] === "openai-cc-fable" || settings.modelOverrides?.["claude-sonnet-5"] === "openai-cc-sonnet") {
  throw new Error("Stale OpenAI-CC modelOverrides must be removed because they regress gateway aliases to 200K: " + JSON.stringify(settings.modelOverrides));
}

console.log("Claude Code version:", version.split("\n")[0]);
console.log("CLAUDE_CODE_USE_GATEWAY=" + configured.CLAUDE_CODE_USE_GATEWAY);
console.log("CLAUDE_CODE_AUTO_COMPACT_WINDOW=" + configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
console.log("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=" + String(configured.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "<unset>"));
console.log("ANTHROPIC_MODEL=" + configured.ANTHROPIC_MODEL);
console.log("FABLE_PIN=" + configured.ANTHROPIC_DEFAULT_FABLE_MODEL);
console.log("OPUS_PIN=" + configured.ANTHROPIC_DEFAULT_OPUS_MODEL);
console.log("SONNET_PIN=" + configured.ANTHROPIC_DEFAULT_SONNET_MODEL);
console.log("HAIKU_PIN=" + configured.ANTHROPIC_DEFAULT_HAIKU_MODEL);
console.log("availableModels=" + JSON.stringify(settings.availableModels));

// Probe aliases, not just backing IDs. This is the path users, Auto mode,
// compaction, and subagents actually exercise.
const probes = [
  ["default/luna", configured.ANTHROPIC_MODEL, target, target],
  ["fable/luna", "fable", target, target],
  ["opus/deepseek-free", "opus", 0, 250000],
  ["sonnet/gemini-flash-lite", "sonnet", target, target],
  ["haiku/gemini-flash-lite", "haiku", target, target],
];

for (const [label, model, min, max] of probes) {
  if (!model) throw new Error("Missing configured model for " + label);
  const budget = probe(label, String(model));
  if (budget < min || budget > max) {
    throw new Error(label + " context " + budget + " outside expected range " + min + ".." + max);
  }
}
