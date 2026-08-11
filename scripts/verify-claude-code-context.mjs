import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLAUDE_VERSION = "2.1.226";
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
const configured = settings.env ?? {};
const env = { ...process.env, ...Object.fromEntries(Object.entries(configured).map(([key, value]) => [key, String(value)])), NO_COLOR: "1" };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function runClaude(args) {
  const result = spawnSync(
    npm,
    ["exec", "--yes", "--package=@anthropic-ai/claude-code@" + CLAUDE_VERSION, "--", "claude", ...args],
    { env, encoding: "utf8", timeout: 120000 },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("
").trim();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Claude Code failed (" + result.status + "):
" + output);
  return output;
}

function parseContextBudget(output) {
  const match = output.match(/\*\*Tokens:\*\*[^\n]*\/\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM])\b/);
  if (!match) throw new Error("Could not parse /context token budget:
" + output);
  const value = Number(match[1]);
  return Math.round(value * (match[2].toLowerCase() === "m" ? 1000000 : 1000));
}

const version = runClaude(["--version"]);
if (!version.includes(CLAUDE_VERSION)) throw new Error("Expected Claude Code " + CLAUDE_VERSION + ", got: " + version);

const probes = [
  ["default", configured.ANTHROPIC_MODEL, 850000, Infinity],
  ["fable", configured.ANTHROPIC_DEFAULT_FABLE_MODEL, 850000, Infinity],
  ["opus/deepseek-free", configured.ANTHROPIC_DEFAULT_OPUS_MODEL, 0, 250000],
];

console.log("Claude Code version:", version.split("
")[0]);
console.log("CLAUDE_CODE_USE_GATEWAY=" + configured.CLAUDE_CODE_USE_GATEWAY);
console.log("CLAUDE_CODE_AUTO_COMPACT_WINDOW=" + configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);

for (const [label, model, min, max] of probes) {
  if (!model) throw new Error("Missing configured model for " + label);
  const output = runClaude(["--model", String(model), "-p", "/context"]);
  const budget = parseContextBudget(output);
  console.log(label + ": model=" + model + " client_context=" + budget);
  if (budget < min || budget > max) {
    throw new Error(label + " context " + budget + " outside expected range " + min + ".." + max + "
" + output);
  }
}
