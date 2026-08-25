import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

const PROFILE_ID = "00000000-0000-4000-8000-000000008082";
const GATEWAY = "http://127.0.0.1:8082";
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const OPENAI_ENV_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_PLUGIN_PREFER_HTTPS",
  "CLAUDE_CODE_CONTEXT_WINDOW", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_COMPACT",
];
function arg(name, fallback = "") { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; } }
async function writeJsonOrRemove(path, value) {
  if (!value || typeof value !== "object" || !Object.keys(value).length) await rm(path, { force: true });
  else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8"); }
}
function restoreKey(object, key, snapshot) {
  if (snapshot?.present) object[key] = snapshot.value;
  else delete object[key];
}
async function restoreClaudeCodeConfig(home, backup = {}) {
  const settingsFile = join(home, ".claude", "settings.json");
  const settings = await readJson(settingsFile);
  const prior = backup.claudeCode || {};
  restoreKey(settings, "availableModels", prior.availableModels);
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env : {};
  for (const key of OPENAI_ENV_KEYS) restoreKey(env, key, prior.env?.[key]);
  if (Object.keys(env).length) settings.env = env; else delete settings.env;
  const overrides = settings.modelOverrides && typeof settings.modelOverrides === "object" && !Array.isArray(settings.modelOverrides) ? settings.modelOverrides : {};
  for (const key of ["claude-fable-5", "claude-sonnet-5"]) restoreKey(overrides, key, prior.modelOverrides?.[key]);
  if (Object.keys(overrides).length) settings.modelOverrides = overrides; else delete settings.modelOverrides;
  await writeJsonOrRemove(settingsFile, settings);

  const stateFile = join(home, ".claude.json");
  const state = await readJson(stateFile);
  for (const key of ["hasCompletedOnboarding", "hasSeenOnboarding", "numStartups"]) restoreKey(state, key, prior.state?.[key]);
  await writeJsonOrRemove(stateFile, state);
}
async function restoreDesktopConfig(home, backup = {}) {
  const prior = backup.claudeDesktop || {};
  const support = join(home, "Library", "Application Support");
  const normalFile = join(support, "Claude", "claude_desktop_config.json");
  const threepDir = join(support, "Claude-3p");
  const threepFile = join(threepDir, "claude_desktop_config.json");
  const profileFile = join(threepDir, "configLibrary", `${PROFILE_ID}.json`);
  const metaFile = join(threepDir, "configLibrary", "_meta.json");

  const normal = await readJson(normalFile);
  restoreKey(normal, "deploymentMode", prior.normalDeploymentMode);
  await writeJsonOrRemove(normalFile, normal);
  const threep = await readJson(threepFile);
  restoreKey(threep, "deploymentMode", prior.threepDeploymentMode);
  await writeJsonOrRemove(threepFile, threep);

  if (prior.profile?.present) await writeJsonOrRemove(profileFile, prior.profile.value || {});
  else await rm(profileFile, { force: true });
  const meta = await readJson(metaFile);
  const entries = Array.isArray(meta.entries) ? meta.entries.filter((entry) => entry?.id !== PROFILE_ID) : [];
  if (prior.metaEntry?.present) entries.push(prior.metaEntry.value);
  if (entries.length) meta.entries = entries; else delete meta.entries;
  restoreKey(meta, "appliedId", prior.metaAppliedId);
  await writeJsonOrRemove(metaFile, meta);
}
async function supervisorOwned(installRoot) {
  const pidFile = join(installRoot, ".gateway-supervisor.pid");
  if (!(await exists(pidFile))) return "";
  const pid = String(await readFile(pidFile, "utf8")).trim();
  if (!/^\d+$/.test(pid)) return "";
  const result = spawnSync("/bin/ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
  const command = String(result.stdout || "").trim();
  if (result.status !== 0 || !command.includes("run-gateway.sh") || !command.includes(installRoot)) return "";
  return pid;
}
async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = spawnSync("/bin/kill", ["-0", pid], { encoding: "utf8" });
    if (probe.status !== 0) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}
async function listenerOwned(installRoot) {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-tiTCP:8082", "-sTCP:LISTEN"], { encoding: "utf8" });
  const pid = String(result.stdout || "").trim().split(/\s+/)[0];
  if (!pid) return "";
  try {
    const response = await fetch(`${GATEWAY}/healthz`, { signal: AbortSignal.timeout(1500) });
    const state = response.ok ? await response.json() : undefined;
    if (state?.ok && Number(state.pid) === Number(pid) && resolve(String(state.installRoot || "")) === installRoot) return pid;
  } catch {}
  return "";
}
async function removePathLine(home) {
  const file = join(home, ".zshrc");
  if (!(await exists(file))) return;
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== PATH_LINE);
  let next = lines.join("\n");
  if (next && !next.endsWith("\n")) next += "\n";
  if (next !== text) await writeFile(file, next, "utf8");
}

if (process.platform !== "darwin") throw new Error("macOS uninstaller can only run on macOS.");
const home = os.homedir();
const expectedRoot = resolve(join(home, "Library", "Application Support", "OpenAI-CC"));
const installRoot = resolve(arg("--install-root", expectedRoot));
if (installRoot !== expectedRoot && process.env.OPENAI_CC_ALLOW_CUSTOM_UNINSTALL_ROOT !== "1") {
  throw new Error(`Refusing unexpected install root: ${installRoot}`);
}
const state = await readJson(join(installRoot, "install-state.json"));
const managedDependencies = state.managedDependencies || {};
const backup = managedDependencies.configurationBeforeOpenAICC || {};
const launchAgent = join(home, "Library", "LaunchAgents", "com.openai-cc.gateway.plist");

spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, launchAgent], { encoding: "utf8" });
const supervisorPid = await supervisorOwned(installRoot);
if (supervisorPid) {
  spawnSync("/bin/kill", ["-TERM", supervisorPid], { encoding: "utf8" });
  if (!(await waitForPidExit(supervisorPid))) throw new Error(`OpenAI-CC gateway supervisor PID ${supervisorPid} did not stop.`);
}
const pid = await listenerOwned(installRoot);
if (pid) {
  spawnSync("/bin/kill", ["-TERM", pid], { encoding: "utf8" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && await listenerOwned(installRoot)) await new Promise((done) => setTimeout(done, 100));
}

await restoreClaudeCodeConfig(home, backup);
await restoreDesktopConfig(home, backup);

if (managedDependencies.claudeDesktop?.installedByOpenAICC && managedDependencies.claudeDesktop.path) {
  const desktopPath = resolve(managedDependencies.claudeDesktop.path);
  const allowed = resolve(join(home, "Applications", "Claude.app"));
  if (desktopPath === allowed) await rm(desktopPath, { recursive: true, force: true });
}
if (managedDependencies.claudeCode?.installedByOpenAICC && managedDependencies.claudeCode.path) {
  const claudePath = resolve(managedDependencies.claudeCode.path);
  const allowed = resolve(join(home, ".local", "bin", "claude"));
  if (claudePath === allowed) await rm(claudePath, { force: true });
  await rm(join(home, ".local", "share", "claude"), { recursive: true, force: true });
}
if (managedDependencies.claudeCode?.pathLineAdded) await removePathLine(home);

await rm(launchAgent, { force: true });
await rm(join(home, "Library", "Logs", "OpenAI-CC"), { recursive: true, force: true });
await rm(installRoot, { recursive: true, force: true });
console.log("[OK] OpenAI-CC removed. Pre-existing Claude configuration was preserved.");
