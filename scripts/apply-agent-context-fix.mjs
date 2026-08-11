import { readFile, writeFile, rm } from "node:fs/promises";

async function text(path) {
  return await readFile(path, "utf8");
}
async function put(path, value) {
  await writeFile(path, value, "utf8");
}
function once(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing anchor: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Anchor not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}
function all(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} occurrences for ${label}, found ${count}`);
  return source.split(before).join(after);
}

{
  const path = "src/model-config.ts";
  let s = await text(path);
  s = once(s,
`export interface RouteHealth {
  slot: ModelSlot;
  provider: ProviderKind;
  model: string;
  mode: "auto" | "pinned";`,
`export interface RouteHealth {
  slot: ModelSlot;
  provider: ProviderKind;
  model: string;
  contextWindow: number;
  mode: "auto" | "pinned";`,
"route health context");
  s = once(s,
`export const DEFAULT_MAX_OUTPUT_TOKENS: Record<ModelSlot, number> = {
  default: 128000,
  fable: 128000,
  opus: 128000,
  sonnet: 128000,
  haiku: 64000,
};

const DEFAULTS: ModelConfig = {
  contextWindow: 700000,`,
`export const DEFAULT_MAX_OUTPUT_TOKENS: Record<ModelSlot, number> = {
  default: 128000,
  fable: 128000,
  opus: 128000,
  sonnet: 128000,
  haiku: 64000,
};

export const DEFAULT_CONTEXT_WINDOW = 850000;
export const FALLBACK_CONTEXT_WINDOW = 200000;

// Claude Code currently derives its usable window from its own model catalog, not
// from /v1/models alone. These ids are therefore client capability carriers;
// OpenAI-CC still routes by slot and sends the configured upstream model.
const CLAUDE_CODE_STANDARD_MODEL_IDS: Record<ModelSlot, string> = {
  default: "claude-sonnet-4-5",
  fable: "claude-opus-4-8",
  opus: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-opus-4-7",
};

const CLAUDE_CODE_EXTENDED_MODEL_IDS: Record<ModelSlot, string> = {
  // Sonnet 5 is natively 1M on the gateway provider path when
  // CLAUDE_CODE_USE_GATEWAY=1 is present. The other ids use Claude Code's
  // explicit [1m] variant because its current 3P catalog still downgrades their
  // bare forms to 200K.
  default: "claude-sonnet-5",
  fable: "claude-opus-4-8[1m]",
  opus: "claude-haiku-4-5[1m]",
  sonnet: "claude-sonnet-4-6[1m]",
  haiku: "claude-opus-4-7[1m]",
};

const DEFAULTS: ModelConfig = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,`,
"defaults and context constants");
  s = once(s,
`  slotForRequestedModel(model: string): ModelSlot {
    const id = String(model || "").toLowerCase();
    if (id === "fable" || id.includes("fable")) return "fable";`,
`  slotForRequestedModel(model: string): ModelSlot {
    const id = String(model || "").trim().toLowerCase();
    const explicit = slotForClaudeCodeModel(this.state, id);
    if (explicit) return explicit;
    if (id === "fable" || id.includes("fable")) return "fable";`,
"slot explicit alias routing");
  s = once(s,
`  healthFor(slot: ModelSlot): RouteHealth {
    const route = this.state.routes[slot];
    const sameProvider = this.accounts.list().filter((credential) => credential.provider === route.provider);`,
`  healthFor(slot: ModelSlot): RouteHealth {
    const route = this.state.routes[slot];
    const contextWindow = contextWindowForRoute(this.state, slot);
    const sameProvider = this.accounts.list().filter((credential) => credential.provider === route.provider);`,
"health context local");
  s = all(s, "baseHealth(slot, route, ready, ", "baseHealth(slot, route, ready, contextWindow, ", 5, "baseHealth calls");
  s = once(s,
`export const MODEL_SLOTS: ModelSlot[] = ["default", "fable", "opus", "sonnet", "haiku"];

function normalizeStrict(input: Partial<ModelConfig>): ModelConfig {`,
`export const MODEL_SLOTS: ModelSlot[] = ["default", "fable", "opus", "sonnet", "haiku"];

export function contextWindowForRoute(config: ModelConfig, slot: ModelSlot): number {
  const configuredTarget = Math.max(FALLBACK_CONTEXT_WINDOW, Math.floor(Number(config.contextWindow) || FALLBACK_CONTEXT_WINDOW));
  return Math.min(configuredTarget, verifiedUpstreamContextWindow(config.routes[slot]));
}

export function claudeCodeModelAlias(config: ModelConfig, slot: ModelSlot): string {
  return contextWindowForRoute(config, slot) > FALLBACK_CONTEXT_WINDOW
    ? CLAUDE_CODE_EXTENDED_MODEL_IDS[slot]
    : CLAUDE_CODE_STANDARD_MODEL_IDS[slot];
}

export function slotForClaudeCodeModel(config: ModelConfig, model: string): ModelSlot | undefined {
  const id = String(model || "").trim().toLowerCase();
  for (const slot of MODEL_SLOTS) {
    const alias = claudeCodeModelAlias(config, slot).toLowerCase();
    const stripped = alias.replace(/\\[1m\\]$/i, "");
    if (id === alias || id === stripped) return slot;
  }
  return undefined;
}

function verifiedUpstreamContextWindow(route: ModelRoute): number {
  const model = String(route.model || "").trim().toLowerCase();
  if (route.provider === "chatgpt" && model === "gpt-5.6-terra") return 1050000;
  if (route.provider === "google" && model === "gemini-3.6-flash") return 1048576;
  if (route.provider === "zen" && model === "deepseek-v4-flash-free") return 200000;
  // Unknown routes stay conservative until their upstream capacity is verified.
  return FALLBACK_CONTEXT_WINDOW;
}

function normalizeStrict(input: Partial<ModelConfig>): ModelConfig {`,
"context helpers");
  s = once(s,
`function baseHealth(slot: ModelSlot, route: ModelRoute, ready: PublicCredential[], status: RouteHealth["status"], message: string): RouteHealth {
  return {
    slot,
    provider: route.provider,
    model: route.model,
    mode: route.credentialId ? "pinned" : "auto",`,
`function baseHealth(slot: ModelSlot, route: ModelRoute, ready: PublicCredential[], contextWindow: number, status: RouteHealth["status"], message: string): RouteHealth {
  return {
    slot,
    provider: route.provider,
    model: route.model,
    contextWindow,
    mode: route.credentialId ? "pinned" : "auto",`,
"baseHealth context field");
  await put(path, s);
}

{
  const path = "src/claude-config.ts";
  let s = await text(path);
  s = once(s,
`import { CLAUDE_DESKTOP_MODEL_ALIASES } from "./claude-desktop.js";
import { ModelConfig } from "./model-config.js";`,
`import { ModelConfig, claudeCodeModelAlias } from "./model-config.js";`,
"claude config imports");
  s = once(s,
`  // Remove the old OpenAI-CC context overrides. CLAUDE_CODE_MAX_CONTEXT_TOKENS only
  // takes effect when DISABLE_COMPACT is set, which defeats the token-efficient setup.
  if (env.CLAUDE_CODE_CONTEXT_WINDOW === String(config.contextWindow)) delete env.CLAUDE_CODE_CONTEXT_WINDOW;
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === String(config.contextWindow)) delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;`,
`  // Remove OpenAI-CC's obsolete hard context overrides. MAX_CONTEXT only becomes
  // effective with DISABLE_COMPACT, which would defeat automatic compaction.
  const oldContextValues = new Set(["700000", String(config.contextWindow)]);
  if (oldContextValues.has(String(env.CLAUDE_CODE_CONTEXT_WINDOW ?? ""))) delete env.CLAUDE_CODE_CONTEXT_WINDOW;
  if (oldContextValues.has(String(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? ""))) delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;`,
"claude context cleanup");
  s = once(s,
`    ANTHROPIC_MODEL: CLAUDE_DESKTOP_MODEL_ALIASES.fable,
    ANTHROPIC_DEFAULT_FABLE_MODEL: CLAUDE_DESKTOP_MODEL_ALIASES.fable,
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_DESKTOP_MODEL_ALIASES.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_DESKTOP_MODEL_ALIASES.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_DESKTOP_MODEL_ALIASES.haiku,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.contextWindow),`,
`    ANTHROPIC_MODEL: claudeCodeModelAlias(config, "default"),
    ANTHROPIC_DEFAULT_FABLE_MODEL: claudeCodeModelAlias(config, "fable"),
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeCodeModelAlias(config, "opus"),
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeCodeModelAlias(config, "sonnet"),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeCodeModelAlias(config, "haiku"),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Claude Code 2.1.x otherwise resolves a plain ANTHROPIC_BASE_URL as
    // first-party-with-a-custom-host and hard-falls back to a 200K budget.
    CLAUDE_CODE_USE_GATEWAY: "1",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.contextWindow),`,
"claude model aliases and gateway provider");
  await put(path, s);
}

{
  const path = "src/claude-desktop.ts";
  let s = await text(path);
  s = once(s,
`import { ModelConfig, ModelRoute, ModelSlot } from "./model-config.js";

export type ClaudeDesktopSlot = Exclude<ModelSlot, "default">;`,
`import {
  MODEL_SLOTS,
  ModelConfig,
  ModelRoute,
  ModelSlot,
  claudeCodeModelAlias,
  contextWindowForRoute,
  slotForClaudeCodeModel,
} from "./model-config.js";

export type ClaudeDesktopSlot = ModelSlot;`,
"desktop imports/type");
  s = once(s,
`export const CLAUDE_DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-000000008082";
export const CLAUDE_DESKTOP_PROFILE_NAME = "OpenAI-CC";
export const CLAUDE_DESKTOP_MODEL_ALIASES: Record<ClaudeDesktopSlot, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

const DESKTOP_SLOTS: ClaudeDesktopSlot[] = ["fable", "opus", "sonnet", "haiku"];`,
`export const CLAUDE_DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-000000008082";
export const CLAUDE_DESKTOP_PROFILE_NAME = "OpenAI-CC";

const DESKTOP_SLOTS: ClaudeDesktopSlot[] = [...MODEL_SLOTS];`,
"desktop aliases");
  s = once(s,
`  const slot = desktopSlotForModel(normalized);
  return slot ? modelInfo(slot, config) : undefined;`,
`  const slot = slotForClaudeCodeModel(config, normalized) ?? desktopSlotForModel(normalized);
  return slot ? modelInfo(slot, config) : undefined;`,
"desktop alias lookup");
  s = once(s, `...(config.contextWindow >= 1000000 ? { supports1m: true } : {}),`,
                `...(info.max_input_tokens >= 1000000 ? { supports1m: true } : {}),`,
                "desktop supports1m");
  s = once(s, `    id: CLAUDE_DESKTOP_MODEL_ALIASES[slot],`, `    id: claudeCodeModelAlias(config, slot),`, "desktop model id");
  s = once(s, `    max_input_tokens: config.contextWindow,`, `    max_input_tokens: contextWindowForRoute(config, slot),`, "desktop route context");
  await put(path, s);
}

{
  const path = "scripts/configure-clients.ts";
  let s = await text(path);
  s = once(s, "process.env.OPENAI_CC_CONTEXT_WINDOW || 700000", "process.env.OPENAI_CC_CONTEXT_WINDOW || 850000", "client context default");
  await put(path, s);
}

{
  const path = "setup.ps1";
  let s = await text(path);
  s = once(s, "$ContextWindow = 700000", "$ContextWindow = 850000", "installer context target");
  s = all(s,
`if ($userValue -eq [string]$ContextWindow) {`,
`if (@("700000", [string]$ContextWindow) -contains [string]$userValue) {`,
1,
"installer stale user context");
  s = all(s,
`if ($current -and $current.Value -eq [string]$ContextWindow) {`,
`if ($current -and @("700000", [string]$ContextWindow) -contains [string]$current.Value) {`,
1,
"installer stale process context");
  s = once(s,
`  Set-PersistentEnvironment "ANTHROPIC_MODEL" "claude-fable-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_FABLE_MODEL" "claude-fable-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_OPUS_MODEL" "claude-opus-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_SONNET_MODEL" "claude-sonnet-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_HAIKU_MODEL" "claude-haiku-4-5"
  Set-PersistentEnvironment "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" "1"
  Set-PersistentEnvironment "CLAUDE_CODE_AUTO_COMPACT_WINDOW" ([string]$ContextWindow)`,
`  # These ids carry Claude Code's client-side context capability only. The
  # gateway still dispatches to the configured upstream model for each slot.
  Set-PersistentEnvironment "ANTHROPIC_MODEL" "claude-sonnet-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_FABLE_MODEL" "claude-opus-4-8[1m]"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_OPUS_MODEL" "claude-haiku-4-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_SONNET_MODEL" "claude-sonnet-4-6[1m]"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_HAIKU_MODEL" "claude-opus-4-7[1m]"
  Set-PersistentEnvironment "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" "1"
  Set-PersistentEnvironment "CLAUDE_CODE_USE_GATEWAY" "1"
  Set-PersistentEnvironment "CLAUDE_CODE_AUTO_COMPACT_WINDOW" ([string]$ContextWindow)`,
"installer gateway model aliases");
  await put(path, s);
}

{
  const path = "src/admin/page.ts";
  let s = await text(path);
  s = once(s,
`<div class="route"><b>Context</b><span></span><input id="context-window" type="number" min="200000" max="1000000" value="'+c.contextWindow+'"><span></span><span class="muted">tokens</span></div>`,
`<div class="route"><b>Auto compact</b><span></span><input id="context-window" type="number" min="200000" max="1000000" value="'+c.contextWindow+'"><span></span><span class="muted">target tokens</span></div>`,
"admin context label");
  s = once(s,
`<div class="route-health '+esc(health?.status||'unavailable')+'">'+esc(health?.message||'')+'</div>`,
`<div class="route-health '+esc(health?.status||'unavailable')+'">'+esc(health?.message||'')+' · context cap '+Number(health?.contextWindow||200000).toLocaleString()+' tokens</div>`,
"admin route context");
  await put(path, s);
}

{
  const path = "tests/model-config.test.ts";
  let s = await text(path);
  s = once(s,
`import { ModelConfigStore } from "../src/model-config.js";`,
`import { ModelConfigStore, claudeCodeModelAlias, contextWindowForRoute } from "../src/model-config.js";`,
"model test imports");
  s += `

test("verified route contexts drive Claude Code capability aliases without over-advertising", async () => {
  const { accounts, models } = await fixture();
  const config = models.snapshot();
  assert.equal(config.contextWindow, 850000);
  assert.equal(contextWindowForRoute(config, "default"), 850000);
  assert.equal(contextWindowForRoute(config, "fable"), 850000);
  assert.equal(contextWindowForRoute(config, "opus"), 200000);
  assert.equal(contextWindowForRoute(config, "sonnet"), 850000);
  assert.equal(contextWindowForRoute(config, "haiku"), 850000);

  assert.equal(claudeCodeModelAlias(config, "default"), "claude-sonnet-5");
  assert.equal(claudeCodeModelAlias(config, "fable"), "claude-opus-4-8[1m]");
  assert.equal(claudeCodeModelAlias(config, "opus"), "claude-haiku-4-5");
  assert.equal(models.slotForRequestedModel("claude-opus-4-8"), "fable");
  assert.equal(models.slotForRequestedModel("claude-opus-4-7"), "haiku");

  const changed = models.snapshot();
  changed.routes.haiku = { provider: "nvidia", model: "unverified-haiku", maxOutputTokens: 32000 };
  const conservative = await models.update(changed);
  assert.equal(contextWindowForRoute(conservative, "haiku"), 200000);
  assert.equal(claudeCodeModelAlias(conservative, "haiku"), "claude-opus-4-7");
  accounts.close();
});
`;
  await put(path, s);
}

{
  const path = "tests/claude-desktop.test.ts";
  let s = await text(path);
  s = once(s,
`import {
  CLAUDE_DESKTOP_MODEL_ALIASES,
  CLAUDE_DESKTOP_PROFILE_ID,
  ClaudeDesktopPaths,
  claudeDesktopModel,
  claudeDesktopModelList,
  configureClaudeDesktopAtPaths,
} from "../src/claude-desktop.js";
import { ModelConfig } from "../src/model-config.js";`,
`import {
  CLAUDE_DESKTOP_PROFILE_ID,
  ClaudeDesktopPaths,
  claudeDesktopModel,
  claudeDesktopModelList,
  configureClaudeDesktopAtPaths,
} from "../src/claude-desktop.js";
import { MODEL_SLOTS, ModelConfig, claudeCodeModelAlias } from "../src/model-config.js";`,
"desktop test imports");
  s = s.split("700000").join("850000");
  s = once(s,
`test("Claude model discovery exposes only safe public aliases and configured limits", () => {
  const response = claudeDesktopModelList(config);
  assert.deepEqual(response.data.map((model) => model.id), [
    CLAUDE_DESKTOP_MODEL_ALIASES.fable,
    CLAUDE_DESKTOP_MODEL_ALIASES.opus,
    CLAUDE_DESKTOP_MODEL_ALIASES.sonnet,
    CLAUDE_DESKTOP_MODEL_ALIASES.haiku,
  ]);
  assert.equal(response.data.some((model) => model.id.includes("gemini") || model.id.includes("deepseek") || model.id.includes("gpt")), false);
  assert.equal(response.data[0].max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === CLAUDE_DESKTOP_MODEL_ALIASES.opus)?.max_tokens, 96000);
  assert.equal((response.data.find((model) => model.id === CLAUDE_DESKTOP_MODEL_ALIASES.sonnet)?.capabilities.image_input as any).supported, true);
  assert.equal((response.data.find((model) => model.id === CLAUDE_DESKTOP_MODEL_ALIASES.haiku)?.capabilities.image_input as any).supported, false);
  assert.equal(response.has_more, false);
});`,
`test("Claude model discovery exposes route-specific context caps and client capability ids", () => {
  const response = claudeDesktopModelList(config);
  const aliases = Object.fromEntries(MODEL_SLOTS.map((slot) => [slot, claudeCodeModelAlias(config, slot)])) as Record<string, string>;
  assert.deepEqual(response.data.map((model) => model.id), MODEL_SLOTS.map((slot) => aliases[slot]));
  assert.equal(response.data.some((model) => model.id.includes("gemini") || model.id.includes("deepseek") || model.id.includes("gpt")), false);
  assert.equal(response.data.find((model) => model.id === aliases.default)?.max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === aliases.fable)?.max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === aliases.opus)?.max_input_tokens, 200000);
  assert.equal(response.data.find((model) => model.id === aliases.sonnet)?.max_input_tokens, 850000);
  assert.equal(response.data.find((model) => model.id === aliases.haiku)?.max_input_tokens, 200000);
  assert.equal(response.data.find((model) => model.id === aliases.opus)?.max_tokens, 96000);
  assert.equal((response.data.find((model) => model.id === aliases.sonnet)?.capabilities.image_input as any).supported, true);
  assert.equal((response.data.find((model) => model.id === aliases.haiku)?.capabilities.image_input as any).supported, false);
  assert.equal(response.has_more, false);
});`,
"desktop discovery test");
  s = once(s,
`  assert.deepEqual(profile.inferenceModels.map((model: any) => model.name), Object.values(CLAUDE_DESKTOP_MODEL_ALIASES));`,
`  assert.deepEqual(profile.inferenceModels.map((model: any) => model.name), MODEL_SLOTS.map((slot) => claudeCodeModelAlias(config, slot)));`,
"desktop profile aliases");
  s = once(s,
`  assert.match(setup, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);
  assert.match(setup, /typescript-language-server/);`,
`  assert.match(setup, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);
  assert.match(setup, /CLAUDE_CODE_USE_GATEWAY/);
  assert.match(setup, /typescript-language-server/);`,
"installer gateway assertion");
  s = once(s,
`test("shared Claude settings use safe aliases, 850k auto-compaction, and onboarding repair", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "claude-config.ts"), "utf8");
  assert.match(source, /CLAUDE_DESKTOP_MODEL_ALIASES\\.fable/);
  assert.match(source, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);`,
`test("shared Claude settings use gateway-aware aliases, 850k auto-compaction, and onboarding repair", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "claude-config.ts"), "utf8");
  assert.match(source, /claudeCodeModelAlias\\(config, "fable"\\)/);
  assert.match(source, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);
  assert.match(source, /CLAUDE_CODE_USE_GATEWAY/);`,
"shared settings test");
  await put(path, s);
}

{
  const path = ".github/workflows/control-plane-ci.yml";
  let s = await text(path);
  s = once(s, "    timeout-minutes: 10", "    timeout-minutes: 15", "ci timeout");
  s = once(s,
`      - name: Run full test suite
        run: npm test
      - name: Parse Windows installers`,
`      - name: Run full test suite
        run: npm test
      - name: Configure fresh Claude Code gateway context
        env:
          OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP: "0"
          OPENAI_CC_CONTEXT_WINDOW: "850000"
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9"
          DATA_DIR: \${{ runner.temp }}/openai-cc-context
        run: node dist/scripts/configure-clients.js
      - name: Verify Claude Code client context budget
        run: node scripts/verify-claude-code-context.mjs
      - name: Parse Windows installers`,
"ci claude context verification");
  await put(path, s);
}

await put("scripts/verify-claude-code-context.mjs", `import { readFile } from "node:fs/promises";
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
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Claude Code failed (" + result.status + "):\n" + output);
  return output;
}

function parseContextBudget(output) {
  const match = output.match(/\\*\\*Tokens:\\*\\*[^\\n]*\\/\\s*([0-9]+(?:\\.[0-9]+)?)\\s*([kKmM])\\b/);
  if (!match) throw new Error("Could not parse /context token budget:\n" + output);
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

console.log("Claude Code version:", version.split("\n")[0]);
console.log("CLAUDE_CODE_USE_GATEWAY=" + configured.CLAUDE_CODE_USE_GATEWAY);
console.log("CLAUDE_CODE_AUTO_COMPACT_WINDOW=" + configured.CLAUDE_CODE_AUTO_COMPACT_WINDOW);

for (const [label, model, min, max] of probes) {
  if (!model) throw new Error("Missing configured model for " + label);
  const output = runClaude(["--model", String(model), "-p", "/context"]);
  const budget = parseContextBudget(output);
  console.log(label + ": model=" + model + " client_context=" + budget);
  if (budget < min || budget > max) {
    throw new Error(label + " context " + budget + " outside expected range " + min + ".." + max + "\n" + output);
  }
}
`);

await rm("scripts/apply-agent-context-fix.mjs", { force: true });
await rm(".github/workflows/agent-apply-context-fix.yml", { force: true });
console.log("Applied Claude Code 850k context fix.");
