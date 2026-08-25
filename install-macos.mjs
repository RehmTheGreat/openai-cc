import { createHash } from "node:crypto";
import { createReadStream, openSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { provisionMacClients } from "./macos-provision-clients.mjs";

const GATEWAY = "http://127.0.0.1:8082";

function fail(message) { throw new Error(message); }
function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function has(name) { return process.argv.includes(name); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
function safeLeaf(value, label) {
  if (!value || basename(value) !== value || /[\\/]/.test(value)) fail(`${label} must be a safe leaf filename.`);
  return value;
}
async function sha256File(path) {
  return await new Promise((ok, bad) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", bad);
    stream.on("end", () => ok(hash.digest("hex")));
  });
}
async function walkFiles(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) fail(`Symlink is not allowed in managed runtime: ${relative(root, full)}`);
      if (info.isDirectory()) await visit(full);
      else if (info.isFile()) out.push(full);
      else fail(`Unsupported runtime entry type: ${relative(root, full)}`);
    }
  }
  await visit(root);
  return out;
}
function contentDigest(files) {
  const canonical = files.slice().sort((a,b)=>a.path.localeCompare(b.path))
    .map((file)=>`${file.path}|${file.sha256}|${file.size}`).join("\n") + "\n";
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
async function jsonFile(path) { return JSON.parse(await readFile(path, "utf8")); }
async function readJsonSafe(path) { try { return await jsonFile(path); } catch { return {}; } }
function normalized(path) { return resolve(path); }
function managedChild(root, candidate) {
  const managed = normalized(root), target = normalized(candidate);
  if (!target.startsWith(managed + sep)) fail(`Refusing path outside managed root: ${target}`);
  return target;
}
function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_PLUGIN_PREFER_HTTPS",
  "CLAUDE_CODE_CONTEXT_WINDOW", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_COMPACT",
];
function snapshotKey(object, key) {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? { present:true, value:object[key] } : { present:false };
}
async function captureManagedClientConfig(home) {
  const settings = await readJsonSafe(join(home, ".claude", "settings.json"));
  const state = await readJsonSafe(join(home, ".claude.json"));
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env : {};
  const overrides = settings.modelOverrides && typeof settings.modelOverrides === "object" && !Array.isArray(settings.modelOverrides) ? settings.modelOverrides : {};
  const support = join(home, "Library", "Application Support");
  const normalFile = join(support, "Claude", "claude_desktop_config.json");
  const threepDir = join(support, "Claude-3p");
  const threepFile = join(threepDir, "claude_desktop_config.json");
  const profileFile = join(threepDir, "configLibrary", "00000000-0000-4000-8000-000000008082.json");
  const metaFile = join(threepDir, "configLibrary", "_meta.json");
  const normal = await readJsonSafe(normalFile), threep = await readJsonSafe(threepFile), profile = await readJsonSafe(profileFile), meta = await readJsonSafe(metaFile);
  const priorEntry = Array.isArray(meta.entries) ? meta.entries.find((entry) => entry?.id === "00000000-0000-4000-8000-000000008082") : undefined;
  return {
    claudeCode: {
      availableModels:snapshotKey(settings, "availableModels"),
      env:Object.fromEntries(CLAUDE_ENV_KEYS.map((key)=>[key, snapshotKey(env, key)])),
      modelOverrides:{
        "claude-fable-5":snapshotKey(overrides, "claude-fable-5"),
        "claude-sonnet-5":snapshotKey(overrides, "claude-sonnet-5"),
      },
      state:{
        hasCompletedOnboarding:snapshotKey(state, "hasCompletedOnboarding"),
        hasSeenOnboarding:snapshotKey(state, "hasSeenOnboarding"),
        numStartups:snapshotKey(state, "numStartups"),
      },
    },
    claudeDesktop: {
      normalDeploymentMode:snapshotKey(normal, "deploymentMode"),
      threepDeploymentMode:snapshotKey(threep, "deploymentMode"),
      profile:{ present:await exists(profileFile), value:profile },
      metaEntry:{ present:Boolean(priorEntry), value:priorEntry },
      metaAppliedId:snapshotKey(meta, "appliedId"),
    },
  };
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail(`This installer supports Apple Silicon macOS only (darwin-arm64); got ${process.platform}-${process.arch}.`);
}
if (Number(process.versions.node.split(".")[0]) < 20) fail(`Node.js 20+ is required; found ${process.version}.`);

const manifestArg = arg("--manifest");
const bundleArg = arg("--bundle");
if (!manifestArg) fail("--manifest must point to a local distribution manifest.");
if (!bundleArg) fail("--bundle must point to a local runtime ZIP.");
const manifestPath = resolve(manifestArg);
const bundlePath = resolve(bundleArg);
if (!(await exists(manifestPath))) fail("--manifest must point to a local distribution manifest.");
if (!(await exists(bundlePath))) fail("--bundle must point to a local runtime ZIP.");
const skipDesktop = has("--skip-desktop-config");
const skipClientProvision = has("--skip-client-provision") || process.env.OPENAI_CC_SKIP_CLIENT_PROVISION === "1";
const noLaunchAgent = has("--no-launch-agent");
const installRoot = resolve(arg("--install-root", join(os.homedir(), "Library", "Application Support", "OpenAI-CC")));
const bootstrapNodeRootArg = arg("--bootstrap-node-root");
const bootstrapNodeRoot = resolve(bootstrapNodeRootArg || dirname(dirname(process.execPath)));
const current = join(installRoot, "current");
const dataDir = join(installRoot, ".data");
const rollbackDir = join(installRoot, "rollbacks");
const failedDir = join(installRoot, "failed");
const logDir = join(os.homedir(), "Library", "Logs", "OpenAI-CC");
const launchAgent = join(os.homedir(), "Library", "LaunchAgents", "com.openai-cc.gateway.plist");
const toolchainRoot = join(installRoot, "toolchain");
const privateNodeRoot = join(installRoot, "toolchain", "node");
const privateNode = join(privateNodeRoot, "bin", "node");
const installStateFile = join(installRoot, "install-state.json");
for (const path of [current, dataDir, rollbackDir, failedDir, toolchainRoot, privateNodeRoot]) managedChild(installRoot, path);
await mkdir(installRoot, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(rollbackDir, { recursive: true });
await mkdir(failedDir, { recursive: true });
await mkdir(logDir, { recursive: true });
await mkdir(toolchainRoot, { recursive: true });
await mkdir(dirname(launchAgent), { recursive: true });

const distribution = await jsonFile(manifestPath);
if (distribution.schemaVersion !== 1) fail(`Unsupported distribution manifest schemaVersion: ${distribution.schemaVersion}`);
if (distribution.platform !== "darwin-arm64") fail(`This installer requires darwin-arm64; manifest has '${distribution.platform}'.`);
if (!/^[0-9a-f]{40}$/i.test(String(distribution.sourceCommit || ""))) fail("Manifest sourceCommit is invalid.");
if (!/^[0-9a-f]{64}$/i.test(String(distribution.bundleSha256 || ""))) fail("Manifest bundleSha256 is invalid.");
if (!/^[0-9a-f]{64}$/i.test(String(distribution.contentSha256 || ""))) fail("Manifest contentSha256 is invalid.");
if (!Number.isSafeInteger(distribution.bundleSize) || distribution.bundleSize <= 0) fail("Manifest bundleSize is invalid.");
if (!String(distribution.appVersion || "")) fail("Manifest appVersion is missing.");
safeLeaf(String(distribution.bundleUrl || ""), "Manifest bundleUrl");

const bundleInfo = await stat(bundlePath);
if (bundleInfo.size !== distribution.bundleSize) fail("Corrupted/hash-mismatched bundle: size mismatch.");
if ((await sha256File(bundlePath)).toLowerCase() !== String(distribution.bundleSha256).toLowerCase()) {
  fail("Corrupted/hash-mismatched bundle: SHA-256 mismatch.");
}

async function verifyRuntime(root) {
  const internalPath = join(root, "runtime-manifest.json");
  if (!(await exists(internalPath))) fail("Bundle is missing runtime-manifest.json.");
  const internal = await jsonFile(internalPath);
  if (internal.schemaVersion !== 1 || internal.platform !== "darwin-arm64") fail("Unsupported internal runtime manifest.");
  if (String(internal.sourceCommit).toLowerCase() !== String(distribution.sourceCommit).toLowerCase()) fail("Internal source SHA does not match distribution manifest.");
  if (String(internal.appVersion) !== String(distribution.appVersion)) fail("Internal application version does not match distribution manifest.");
  if (String(internal.contentSha256).toLowerCase() !== String(distribution.contentSha256).toLowerCase()) fail("Internal content digest does not match distribution manifest.");
  const declared = [...(internal.files || [])].sort((a,b)=>String(a.path).localeCompare(String(b.path)));
  if (!declared.length) fail("Internal runtime manifest has no files.");
  const actual = [];
  for (const file of await walkFiles(root)) {
    if (resolve(file) === resolve(internalPath)) continue;
    const rel = relative(root, file).split(sep).join("/");
    actual.push(rel);
  }
  const declaredPaths = declared.map((entry)=>String(entry.path));
  if (JSON.stringify(actual.sort()) !== JSON.stringify(declaredPaths.slice().sort())) fail("Runtime bundle contains undeclared or missing files.");
  for (const entry of declared) {
    const rel = String(entry.path || "");
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) fail(`Unsafe runtime manifest path: ${rel}`);
    const candidate = managedChild(root, join(root, ...rel.split("/")));
    const info = await stat(candidate);
    if (!info.isFile()) fail(`Runtime file listed in manifest is missing: ${rel}`);
    if (info.size !== Number(entry.size)) fail(`Runtime file size mismatch: ${rel}`);
    if ((await sha256File(candidate)).toLowerCase() !== String(entry.sha256).toLowerCase()) fail(`Runtime file hash mismatch: ${rel}`);
  }
  if (contentDigest(declared).toLowerCase() !== String(distribution.contentSha256).toLowerCase()) fail("Runtime content digest verification failed.");
  const build = await jsonFile(join(root, "dist", "build-info.json"));
  if (String(build.buildSha).toLowerCase() !== String(distribution.sourceCommit).toLowerCase()) fail("Installed build SHA mismatch.");
  if (String(build.appVersion) !== String(distribution.appVersion)) fail("Installed build version mismatch.");
  for (const required of ["dist/src/index.js", "dist/scripts/configure-clients.js", "dist/scripts/codex-doctor.js", "dist/scripts/migrate-data.js", "package.json", "run-gateway.sh", "run-claude.sh", "uninstall-macos.mjs", "uninstall.command"]) {
    if (!(await exists(join(root, ...required.split("/"))))) fail(`Runtime bundle is missing required item: ${required}`);
  }
  return internal;
}

async function fingerprintData() {
  const files = [];
  if (!(await exists(dataDir))) return { count: 0, digest: "" };
  for (const file of await walkFiles(dataDir)) {
    const rel = relative(dataDir, file).split(sep).join("/");
    const info = await stat(file);
    const oauth = /^(?:codex-homes|accounts)\/[^/]+\/auth\.json$/i.test(rel);
    files.push({ path: rel, sha256: oauth ? "managed-oauth-session" : await sha256File(file), size: oauth ? 0 : info.size });
  }
  return { count: files.length, digest: contentDigest(files) };
}

async function health() {
  try {
    const response = await fetch(`${GATEWAY}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch { return undefined; }
}
function listenerPid() {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-tiTCP:8082", "-sTCP:LISTEN"], { encoding: "utf8" });
  return String(result.stdout || "").trim().split(/\s+/)[0] || "";
}
async function assertPortOwnership() {
  const pid = listenerPid();
  if (!pid) return;
  const state = await health();
  if (!state?.ok || Number(state.pid) !== Number(pid) || resolve(String(state.installRoot || "")) !== installRoot) {
    fail(`Port 8082 is occupied by unrelated PID ${pid}. Refusing to replace or terminate it.`);
  }
}

function nodeMajor(nodePath) {
  const result = spawnSync(nodePath, ["-p", "Number(process.versions.node.split(\".\")[0])"], { encoding: "utf8" });
  return result.status === 0 ? Number(String(result.stdout || "").trim()) : 0;
}
async function installPrivateNode() {
  const sourceNode = join(bootstrapNodeRoot, "bin", "node");
  if (!(await exists(sourceNode)) || nodeMajor(sourceNode) < 20) fail(`--bootstrap-node-root does not contain a working Node 20+: ${bootstrapNodeRoot}`);
  if (resolve(bootstrapNodeRoot) === resolve(privateNodeRoot)) return privateNode;
  const stageParent = await mkdtemp(join(toolchainRoot, ".node-stage-"));
  const staged = join(stageParent, "node");
  const backup = join(toolchainRoot, `.node-old-${Date.now()}`);
  let backedUp = false;
  try {
    if (bootstrapNodeRootArg) {
      await cp(bootstrapNodeRoot, staged, { recursive: true, force: true, dereference: false });
    } else {
      await mkdir(join(staged, "bin"), { recursive: true });
      await cp(sourceNode, join(staged, "bin", "node"), { force: true, dereference: true });
      await chmod(join(staged, "bin", "node"), 0o755);
    }
    const stagedNode = join(staged, "bin", "node");
    if (!(await exists(stagedNode)) || nodeMajor(stagedNode) < 20) fail("Staged private Node failed verification.");
    if (await exists(privateNodeRoot)) { await rename(privateNodeRoot, backup); backedUp = true; }
    try { await rename(staged, privateNodeRoot); }
    catch (error) {
      if (backedUp && await exists(backup) && !(await exists(privateNodeRoot))) await rename(backup, privateNodeRoot);
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
  if (!(await exists(privateNode)) || nodeMajor(privateNode) < 20) fail("Persistent private Node verification failed.");
  return privateNode;
}

const freshModelConfig = !(await exists(join(dataDir, "model-config.json")));
const previousInstallState = await readJsonSafe(installStateFile);
await assertPortOwnership();
let internal;
let staged = "";
let rollback = "";
let swapped = false;
let reusedCurrent = false;

try {
  if (await exists(current)) {
    try {
      const existing = await jsonFile(join(current, "runtime-manifest.json"));
      if (String(existing.sourceCommit).toLowerCase() === String(distribution.sourceCommit).toLowerCase() &&
          String(existing.contentSha256).toLowerCase() === String(distribution.contentSha256).toLowerCase()) {
        internal = await verifyRuntime(current);
        reusedCurrent = true;
      }
    } catch { /* a damaged current runtime is replaced by the verified bundle */ }
  }

  if (!reusedCurrent) {
    staged = managedChild(installRoot, await mkdtemp(join(installRoot, ".stage-")));
    const unzip = spawnSync("/usr/bin/unzip", ["-q", bundlePath, "-d", staged], { encoding: "utf8" });
    if (unzip.status !== 0) fail(`Runtime bundle extraction failed: ${unzip.stderr || unzip.stdout || "unzip exited nonzero"}`);
    internal = await verifyRuntime(staged);

    if (await exists(current)) {
      let oldSha = "unknown";
      try { oldSha = String((await jsonFile(join(current, "runtime-manifest.json"))).sourceCommit || "unknown").slice(0, 12); } catch {}
      rollback = managedChild(installRoot, join(rollbackDir, `${oldSha}-${timestamp()}`));
      await rename(current, rollback);
    }
    await rename(staged, current);
    staged = "";
    swapped = true;
  }

  const persistentNode = await installPrivateNode();
  const nodeVersion = String(spawnSync(persistentNode, ["--version"], { encoding: "utf8" }).stdout || "").trim();
  const migration = join(current, "dist", "scripts", "migrate-data.js");
  const migrate = spawnSync(persistentNode, [migration, dataDir], { stdio: "inherit", env: { ...process.env, OPENAI_CC_HOME: installRoot, OPENAI_CC_RUNTIME_ROOT: current, DATA_DIR: dataDir } });
  if (migrate.status !== 0) fail(`Persistent .data migration failed (exit code ${migrate.status}).`);
  const beforeData = freshModelConfig ? undefined : await fingerprintData();

  let managedDependencies = { ...(previousInstallState.managedDependencies || {}), node: { path: persistentNode, version: nodeVersion, installedByOpenAICC: true } };
  if (!managedDependencies.configurationBeforeOpenAICC) managedDependencies.configurationBeforeOpenAICC = await captureManagedClientConfig(os.homedir());
  if (!skipClientProvision) {
    const clients = await provisionMacClients({ previous: managedDependencies, skipDesktop });
    managedDependencies = { ...managedDependencies, ...clients };
  }

  const configure = spawnSync(persistentNode, [join(current, "dist", "scripts", "configure-clients.js")], {
    stdio: "inherit",
    cwd: installRoot,
    env: {
      ...process.env,
      OPENAI_CC_HOME: installRoot,
      OPENAI_CC_RUNTIME_ROOT: current,
      DATA_DIR: dataDir,
      ANTHROPIC_BASE_URL: GATEWAY,
      OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP: skipDesktop ? "0" : "1",
    },
  });
  if (configure.status !== 0) fail(`Client configuration failed (exit code ${configure.status}).`);

  if (!noLaunchAgent) {
    const esc = (value) => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.openai-cc.gateway</string>\n<key>ProgramArguments</key><array><string>/bin/bash</string><string>${esc(join(current,"run-gateway.sh"))}</string><string>--install-root</string><string>${esc(installRoot)}</string></array>\n<key>EnvironmentVariables</key><dict><key>OPENAI_CC_NODE</key><string>${esc(persistentNode)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>\n<key>StandardOutPath</key><string>${esc(join(logDir,"gateway.log"))}</string>\n<key>StandardErrorPath</key><string>${esc(join(logDir,"gateway.err.log"))}</string>\n</dict></plist>\n`;
    await writeFile(launchAgent, plist, { encoding: "utf8", mode: 0o600 });
  }

  let state = await health();
  if (!state?.ok || resolve(String(state.installRoot || "")) !== installRoot) {
    const stdout = openSync(join(logDir, "gateway.log"), "a");
    const stderr = openSync(join(logDir, "gateway.err.log"), "a");
    const child = spawn("/bin/bash", [join(current, "run-gateway.sh"), "--install-root", installRoot], {
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: { ...process.env, OPENAI_CC_NODE: persistentNode },
    });
    child.unref();
  }

  const deadline = Date.now() + 20000;
  do {
    await new Promise((done)=>setTimeout(done, 250));
    state = await health();
    if (state?.ok && String(state.buildSha).toLowerCase() === String(distribution.sourceCommit).toLowerCase()) break;
  } while (Date.now() < deadline);
  if (!state?.ok) fail("Gateway startup failure: healthz did not report ok=true.");
  if (String(state.buildSha).toLowerCase() !== String(distribution.sourceCommit).toLowerCase()) fail("Verification failed: running /healthz build SHA mismatch.");
  if (String(state.appVersion) !== String(distribution.appVersion)) fail("Verification failed: running application version mismatch.");
  if (resolve(String(state.installRoot || "")) !== installRoot) fail("Verification failed: health installRoot does not match managed root.");
  if (resolve(String(state.runtimeRoot || "")) !== current) fail("Verification failed: health runtimeRoot is not the active current runtime.");

  const rootResponse = await fetch(`${GATEWAY}/`, { redirect: "manual" });
  if (rootResponse.status !== 302 || rootResponse.headers.get("location") !== "/admin") fail("Verification failed: gateway root did not redirect to /admin.");
  const admin = await fetch(`${GATEWAY}/admin`);
  if (!admin.ok) fail("Verification failed: Admin endpoint did not return HTTP 200.");
  if (!skipClientProvision) {
    if (!managedDependencies.claudeCode?.path || !(await exists(managedDependencies.claudeCode.path))) fail("Verification failed: Claude Code executable is missing.");
    if (!skipDesktop && (!managedDependencies.claudeDesktop?.path || !(await exists(managedDependencies.claudeDesktop.path)))) fail("Verification failed: Claude Desktop application is missing.");
  }
  const adminState = await (await fetch(`${GATEWAY}/admin/state`)).json();
  const models = await (await fetch(`${GATEWAY}/v1/models`)).json();
  if (!Array.isArray(models.data) || models.data.length !== 4) fail("Verification failed: gateway did not expose exactly four Claude Desktop-facing routes.");

  const settingsFile = join(os.homedir(), ".claude", "settings.json");
  if (!(await exists(settingsFile))) fail("Verification failed: Claude settings file is missing.");
  const settings = await jsonFile(settingsFile);
  if (String(settings.env?.ANTHROPIC_BASE_URL || "") !== GATEWAY) fail("Verification failed: Claude ANTHROPIC_BASE_URL is inconsistent.");
  const envKeys = {
    default:"ANTHROPIC_MODEL", fable:"ANTHROPIC_DEFAULT_FABLE_MODEL", opus:"ANTHROPIC_DEFAULT_OPUS_MODEL",
    sonnet:"ANTHROPIC_DEFAULT_SONNET_MODEL", haiku:"ANTHROPIC_DEFAULT_HAIKU_MODEL",
  };
  for (const [slot, envKey] of Object.entries(envKeys)) {
    const title = slot[0].toUpperCase() + slot.slice(1);
    const route = adminState.modelConfig.routes[slot], routeHealth = adminState.routeHealth[slot];
    if (slot !== "default") {
      const model = models.data.find((item)=>item.display_name === title);
      if (!model) fail(`Verification failed: model discovery is missing ${title}.`);
      if (Number(model.max_input_tokens) !== Number(routeHealth.contextWindow)) fail(`Verification failed: ${title} context metadata disagrees with effective route context.`);
      if (Number(model.max_tokens) !== Number(route.maxOutputTokens)) fail(`Verification failed: ${title} output metadata disagrees with route configuration.`);
    }
    const configuredAlias = String(settings.env?.[envKey] || "");
    if (!configuredAlias) fail(`Verification failed: Claude alias for ${title} is missing.`);
    const aliasResponse = await fetch(`${GATEWAY}/v1/models/${encodeURIComponent(configuredAlias)}`);
    if (!aliasResponse.ok) fail(`Verification failed: Claude alias for ${title} is not accepted by the gateway.`);
    const aliasModel = await aliasResponse.json();
    if (String(aliasModel.display_name) !== title) fail(`Verification failed: Claude alias for ${title} does not resolve back to the expected logical route.`);
    if (Number(aliasModel.max_input_tokens) !== Number(routeHealth.contextWindow) || Number(aliasModel.max_tokens) !== Number(route.maxOutputTokens)) fail(`Verification failed: Claude alias for ${title} resolves with inconsistent route metadata.`);
  }

  if (freshModelConfig) {
    const expected = {
      default:{provider:"chatgpt",model:"gpt-5.6-luna"},
      fable:{provider:"chatgpt",model:"gpt-5.6-luna"},
      opus:{provider:"zen",model:"deepseek-v4-flash-free"},
      sonnet:{provider:"google",model:"gemini-3.5-flash-lite"},
      haiku:{provider:"google",model:"gemini-3.5-flash-lite"},
    };
    for (const [slot, contract] of Object.entries(expected)) {
      const route = adminState.modelConfig.routes[slot];
      if (route.provider !== contract.provider || route.model !== contract.model) {
        fail(`Verification failed: fresh-install ${slot} route does not match the current default routing contract.`);
      }
    }
  }

  if (beforeData) {
    const afterData = await fingerprintData();
    if (afterData.count !== beforeData.count || afterData.digest !== beforeData.digest) fail("Verification failed: protected .data changed during update.");
  }

  const uninstallLauncher = join(installRoot, "uninstall.command");
  await cp(join(current, "uninstall.command"), uninstallLauncher, { force: true });
  await chmod(uninstallLauncher, 0o700);

  const installState = {
    schemaVersion:1,
    platform:"darwin-arm64",
    appVersion:String(distribution.appVersion),
    sourceCommit:String(distribution.sourceCommit).toLowerCase(),
    bundleSha256:String(distribution.bundleSha256).toLowerCase(),
    contentSha256:String(distribution.contentSha256).toLowerCase(),
    installedAt:new Date().toISOString(),
    installRoot,
    runtimeRoot:current,
    pid:Number(state.pid),
    dataFingerprint:beforeData?.digest || null,
    managedDependencies,
  };
  await writeFile(installStateFile, JSON.stringify(installState, null, 2) + "\n", "utf8");

  console.log(`[OK] OpenAI-CC ${distribution.appVersion} installed for Apple Silicon macOS.`);
  console.log(`[OK] Source SHA = installed build SHA = running /healthz SHA: ${distribution.sourceCommit}`);
  console.log(`[OK] Persistent state: ${dataDir}`);
  console.log(`[OK] Admin: ${GATEWAY}/admin`);
} catch (error) {
  if (swapped && rollback && await exists(rollback)) {
    const failedCurrent = managedChild(installRoot, join(failedDir, `${String(distribution.sourceCommit).slice(0,12)}-${timestamp()}`));
    if (await exists(current)) await rename(current, failedCurrent);
    await rename(rollback, current);
    console.error("Installation failed; previous runtime directory was restored. Restart OpenAI-CC to use the restored runtime.");
  }
  throw error;
}