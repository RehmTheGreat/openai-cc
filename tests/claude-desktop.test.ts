import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_DESKTOP_PROFILE_ID,
  ClaudeDesktopPaths,
  claudeDesktopModel,
  claudeDesktopModelList,
  configureClaudeDesktopAtPaths,
} from "../src/claude-desktop.js";
import { MODEL_SLOTS, ModelConfig, claudeCodeModelAlias } from "../src/model-config.js";

const config: ModelConfig = {
  contextWindow: 850000,
  routes: {
    default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },
    opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 96000 },
    sonnet: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: 64000 },
    haiku: { provider: "nvidia", model: "test-haiku-upstream", maxOutputTokens: 32000 },
  },
};

test("Claude model discovery exposes route-specific context caps and client capability ids", () => {
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
});

test("model retrieval accepts Claude-family version aliases without exposing upstream ids", () => {
  assert.equal(claudeDesktopModel(config, "claude-opus-5")?.max_tokens, 96000);
  assert.equal(claudeDesktopModel(config, "claude-opus-5-20260724")?.id, "claude-opus-5");
  assert.equal(claudeDesktopModel(config, "deepseek-v4-flash-free"), undefined);
});

test("Claude Desktop 3P configuration is merged and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-desktop-"));
  const paths: ClaudeDesktopPaths = {
    normalConfigFile: path.join(root, "Claude", "claude_desktop_config.json"),
    threepConfigFile: path.join(root, "Claude-3p", "claude_desktop_config.json"),
    profileFile: path.join(root, "Claude-3p", "configLibrary", `${CLAUDE_DESKTOP_PROFILE_ID}.json`),
    metaFile: path.join(root, "Claude-3p", "configLibrary", "_meta.json"),
  };
  await writeJson(paths.normalConfigFile, { keepMe: true, deploymentMode: "1p" });
  await writeJson(paths.metaFile, { entries: [{ id: "other", name: "Other" }], appliedId: "other" });

  await configureClaudeDesktopAtPaths(paths, "http://127.0.0.1:8082/", config);
  await configureClaudeDesktopAtPaths(paths, "http://127.0.0.1:8082/", config);

  const normal = JSON.parse(await readFile(paths.normalConfigFile, "utf8"));
  const threep = JSON.parse(await readFile(paths.threepConfigFile, "utf8"));
  const profile = JSON.parse(await readFile(paths.profileFile, "utf8"));
  const meta = JSON.parse(await readFile(paths.metaFile, "utf8"));

  assert.equal(normal.keepMe, true);
  assert.equal(normal.deploymentMode, "3p");
  assert.equal(threep.deploymentMode, "3p");
  assert.equal(profile.inferenceProvider, "gateway");
  assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:8082");
  assert.equal(profile.inferenceGatewayAuthScheme, "bearer");
  assert.deepEqual(profile.inferenceModels.map((model: any) => model.name), MODEL_SLOTS.map((slot) => claudeCodeModelAlias(config, slot)));
  assert.equal(profile.inferenceModels.some((model: any) => model.supports1m === true), false);
  assert.equal(meta.appliedId, CLAUDE_DESKTOP_PROFILE_ID);
  assert.equal(meta.entries.filter((entry: any) => entry.id === CLAUDE_DESKTOP_PROFILE_ID).length, 1);
  assert.equal(meta.entries.some((entry: any) => entry.id === "other"), true);
});

test("PowerShell installer requires explicit buffered Y/N choices for optional apps", async () => {
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");
  assert.match(setup, /function Clear-PendingConsoleInput/);
  assert.match(setup, /\[Console\]::KeyAvailable/);
  assert.match(setup, /\[Console\]::ReadKey\(\$true\)/);
  assert.match(setup, /if \(\$key\.Key -eq \[ConsoleKey\]::Y\)/);
  assert.match(setup, /if \(\$key\.Key -eq \[ConsoleKey\]::N\)/);
  assert.match(setup, /Install Claude Code CLI\?/);
  assert.match(setup, /Install\/configure VS Code \(Claude Code extension is manual\)\?/);
  assert.match(setup, /Install and configure Claude Desktop\?/);
  assert.match(setup, /Anthropic\.ClaudeCode/);
  assert.match(setup, /Microsoft\.VisualStudioCode/);
  assert.match(setup, /anthropic\.claude-code/);
  assert.match(setup, /Anthropic\.Claude/);
  assert.doesNotMatch(setup, /Invoke-WingetUpgrade\s+"Anthropic\.ClaudeCode"/);
  assert.doesNotMatch(setup, /Invoke-WingetUpgrade\s+"Microsoft\.VisualStudioCode"/);
  assert.doesNotMatch(setup, /Invoke-WingetUpgrade\s+"Anthropic\.Claude"/);
  assert.match(setup, /claudeCode\.disableLoginPrompt/);
});

test("PowerShell installer never invokes the VS Code code CLI", async () => {
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");
  assert.match(setup, /function Test-VSCodeInstalled/);
  assert.match(setup, /Microsoft VS Code\\Code\.exe/);
  assert.match(setup, /Test-WingetPackageInstalled "Microsoft\.VisualStudioCode"/);
  assert.match(setup, /VS Code CLI automation intentionally skipped/);
  assert.match(setup, /install\/enable Claude Code \(anthropic\.claude-code\) manually/);
  assert.doesNotMatch(setup, /--list-extensions/);
  assert.doesNotMatch(setup, /--install-extension/);
  assert.doesNotMatch(setup, /Get-Command code(?:\.cmd)?/);
});

test("PowerShell native runner does not redirect stderr under Windows PowerShell 5.1", async () => {
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");
  assert.match(setup, /function Invoke-NativeConsole/);
  assert.match(setup, /& \$Command @Arguments \| Out-Host/);
  assert.match(setup, /\$nativeExitCode = \$LASTEXITCODE/);
  assert.match(setup, /return \[int\]\$nativeExitCode/);
  assert.doesNotMatch(setup, /& \$Command @Arguments 2>&1/);
  assert.match(setup, /Invoke-NativeConsole \$gitCommand @\("clone"/);
  assert.match(setup, /Invoke-NativeConsole \$gitCommand @\("-C", \$target, "pull"/);
  assert.match(setup, /return Invoke-NativeConsole \$Runner\.Command \$allArgs/);
});

test("PowerShell installer detects current Claude Desktop MSIX installs and waits for registration", async () => {
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");
  assert.match(setup, /Microsoft\\WindowsApps\\Claude\.exe/);
  assert.match(setup, /Get-AppxPackage/);
  assert.match(setup, /PackageFamilyName -like "Claude_\*"/);
  assert.match(setup, /Test-WingetPackageInstalled "Anthropic\.Claude"/);
  assert.match(setup, /function Wait-ClaudeDesktopRegistration/);
  assert.match(setup, /Wait-ClaudeDesktopRegistration 60/);
  assert.match(setup, /winget list --id Anthropic\.Claude --exact/);
});

test("PowerShell installer configures the shared token-efficiency stack and persistent gateway", async () => {
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");
  assert.match(setup, /Desktop\\Claude/);
  assert.match(setup, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  assert.match(setup, /850000/);
  assert.match(setup, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);
  assert.match(setup, /CLAUDE_CODE_USE_GATEWAY/);
  assert.match(setup, /typescript-language-server/);
  assert.match(setup, /typescript-lsp@claude-plugins-official/);
  assert.match(setup, /context-mode@context-mode/);
  assert.match(setup, /mksglu\/context-mode/);
  assert.match(setup, /rtk-x86_64-pc-windows-msvc\.zip/);
  assert.match(setup, /"init", "-g", "--auto-patch"/);
  assert.match(setup, /dist\/scripts\/configure-clients\.js/);
  assert.match(setup, /Invoke-NativeConsole \(Get-Command npm\)\.Source @\("ci", "--no-audit", "--no-fund"\)/);
  assert.doesNotMatch(setup, /Invoke-NativeConsole \(Get-Command npm\)\.Source @\("install", "--no-audit", "--no-fund"\)/);
  assert.match(setup, /OpenAI-CC Gateway\.lnk/);
  assert.match(setup, /\$GatewayBaseUrl\/healthz/);
  assert.match(setup, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP/);
  assert.match(setup, /deepseek-v4-flash-free/);
  assert.doesNotMatch(setup, /(?:OPENAI|NVIDIA|GEMINI|GOOGLE|ZEN|ANTHROPIC)_API_KEY\s*[=:]/i);
  assert.doesNotMatch(setup, /DISABLE_COMPACT\s*[=:]/);
});

test("shared Claude settings use gateway-aware aliases, 850k auto-compaction, and onboarding repair", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "claude-config.ts"), "utf8");
  assert.match(source, /claudeCodeModelAlias\(config, "fable"\)/);
  assert.match(source, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY/);
  assert.match(source, /CLAUDE_CODE_USE_GATEWAY/);
  assert.match(source, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  assert.match(source, /hasCompletedOnboarding = true/);
  assert.match(source, /hasSeenOnboarding = true/);
  assert.doesNotMatch(source, /DISABLE_COMPACT\s*[=:]/);
});

test("gateway startup honors persistent Claude Desktop opt-out", async () => {
  const index = await readFile(path.join(process.cwd(), "src", "index-replicated.ts"), "utf8");
  const launcher = await readFile(path.join(process.cwd(), "run-gateway.ps1"), "utf8");
  const clients = await readFile(path.join(process.cwd(), "scripts", "configure-clients.ts"), "utf8");
  assert.match(index, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0"/);
  assert.match(clients, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP !== "0"/);
  assert.match(clients, /OPENAI_CC_CONTEXT_WINDOW \|\| 850000/);
  assert.match(launcher, /dist\/src\/index-replicated\.js/);
  assert.match(launcher, /127\.0\.0\.1:8082\/healthz/);
});

async function writeJson(file: string, value: unknown): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}