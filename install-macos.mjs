import { createHash } from "node:crypto";
import { createReadStream, openSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

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
function normalized(path) { return resolve(path); }
function managedChild(root, candidate) {
  const managed = normalized(root), target = normalized(candidate);
  if (!target.startsWith(managed + sep)) fail(`Refusing path outside managed root: ${target}`);
  return target;
}
function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

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
const noLaunchAgent = has("--no-launch-agent");
const installRoot = resolve(arg("--install-root", join(os.homedir(), "Library", "Application Support", "OpenAI-CC")));
const current = join(installRoot, "current");
const dataDir = join(installRoot, ".data");
const rollbackDir = join(installRoot, "rollbacks");
const failedDir = join(installRoot, "failed");
const logDir = join(os.homedir(), "Library", "Logs", "OpenAI-CC");
const launchAgent = join(os.homedir(), "Library", "LaunchAgents", "com.openai-cc.gateway.plist");
for (const path of [current, dataDir, rollbackDir, failedDir]) managedChild(installRoot, path);
await mkdir(installRoot, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(rollbackDir, { recursive: true });
await mkdir(failedDir, { recursive: true });
await mkdir(logDir, { recursive: true });
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
  for (const required of ["dist/src/index.js", "dist/scripts/configure-clients.js", "dist/scripts/codex-doctor.js", "dist/scripts/migrate-data.js", "package.json", "run-gateway.sh", "run-claude.sh"]) {
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

const freshModelConfig = !(await exists(join(dataDir, "model-config.json")));
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

  const migration = join(current, "dist", "scripts", "migrate-data.js");
  const migrate = spawnSync(process.execPath, [migration, dataDir], { stdio: "inherit", env: { ...process.env, OPENAI_CC_HOME: installRoot, OPENAI_CC_RUNTIME_ROOT: current, DATA_DIR: dataDir } });
  if (migrate.status !== 0) fail(`Persistent .data migration failed (exit code ${migrate.status}).`);
  const beforeData = freshModelConfig ? undefined : await fingerprintData();

  const desktopInstalled = await exists("/Applications/Claude.app") || await exists(join(os.homedir(), "Applications", "Claude.app"));
  const configure = spawnSync(process.execPath, [join(current, "dist", "scripts", "configure-clients.js")], {
    stdio: "inherit",
    cwd: installRoot,
    env: {
      ...process.env,
      OPENAI_CC_HOME: installRoot,
      OPENAI_CC_RUNTIME_ROOT: current,
      DATA_DIR: dataDir,
      ANTHROPIC_BASE_URL: GATEWAY,
      OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP: !skipDesktop && desktopInstalled ? "1" : "0",
    },
  });
  if (configure.status !== 0) fail(`Client configuration failed (exit code ${configure.status}).`);

  if (!noLaunchAgent) {
    const esc = (value) => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.openai-cc.gateway</string>\n<key>ProgramArguments</key><array><string>/bin/bash</string><string>${esc(join(current,"run-gateway.sh"))}</string><string>--install-root</string><string>${esc(installRoot)}</string></array>\n<key>EnvironmentVariables</key><dict><key>OPENAI_CC_NODE</key><string>${esc(process.execPath)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${esc(join(logDir,"gateway.log"))}</string>\n<key>StandardErrorPath</key><string>${esc(join(logDir,"gateway.err.log"))}</string>\n</dict></plist>\n`;
    await writeFile(launchAgent, plist, { encoding: "utf8", mode: 0o600 });
  }

  let state = await health();
  if (!state?.ok || resolve(String(state.installRoot || "")) !== installRoot || String(state.buildSha).toLowerCase() !== String(distribution.sourceCommit).toLowerCase()) {
    const stdout = openSync(join(logDir, "gateway.log"), "a");
    const stderr = openSync(join(logDir, "gateway.err.log"), "a");
    const child = spawn("/bin/bash", [join(current, "run-gateway.sh"), "--install-root", installRoot], {
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: { ...process.env, OPENAI_CC_NODE: process.execPath },
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

  const admin = await fetch(`${GATEWAY}/admin`);
  if (!admin.ok) fail("Verification failed: Admin endpoint did not return HTTP 200.");
  const adminState = await (await fetch(`${GATEWAY}/admin/state`)).json();
  const models = await (await fetch(`${GATEWAY}/v1/models`)).json();
  if (!Array.isArray(models.data) || models.data.length !== 5) fail("Verification failed: gateway did not expose exactly five Claude-facing routes.");

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
    const model = models.data.find((item)=>item.display_name === title);
    if (!model) fail(`Verification failed: model discovery is missing ${title}.`);
    const route = adminState.modelConfig.routes[slot], routeHealth = adminState.routeHealth[slot];
    if (Number(model.max_input_tokens) !== Number(routeHealth.contextWindow)) fail(`Verification failed: ${title} context metadata disagrees with effective route context.`);
    if (Number(model.max_tokens) !== Number(route.maxOutputTokens)) fail(`Verification failed: ${title} output metadata disagrees with route configuration.`);
    if (String(settings.env?.[envKey] || "") !== String(model.id)) fail(`Verification failed: Claude alias for ${title} disagrees with gateway model discovery.`);
  }

  if (freshModelConfig) {
    const expected = {
      default:{provider:"chatgpt",model:"gpt-5.6-luna",context:1000000},
      fable:{provider:"chatgpt",model:"gpt-5.6-luna",context:1000000},
      opus:{provider:"zen",model:"deepseek-v4-flash-free",context:200000},
      sonnet:{provider:"google",model:"gemini-3.5-flash-lite",context:1000000},
      haiku:{provider:"google",model:"gemini-3.5-flash-lite",context:1000000},
    };
    for (const [slot, contract] of Object.entries(expected)) {
      const route = adminState.modelConfig.routes[slot], routeHealth = adminState.routeHealth[slot];
      if (route.provider !== contract.provider || route.model !== contract.model || Number(routeHealth.contextWindow) !== contract.context) {
        fail(`Verification failed: fresh-install ${slot} route does not match the current default routing contract.`);
      }
    }
  }

  if (beforeData) {
    const afterData = await fingerprintData();
    if (afterData.count !== beforeData.count || afterData.digest !== beforeData.digest) fail("Verification failed: protected .data changed during update.");
  }

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
  };
  await writeFile(join(installRoot, "install-state.json"), JSON.stringify(installState, null, 2) + "\n", "utf8");

  console.log(`[OK] OpenAI-CC ${distribution.appVersion} installed for Apple Silicon macOS.`);
  console.log(`[OK] Source SHA = installed build SHA = running /healthz SHA: ${distribution.sourceCommit}`);
  console.log(`[OK] Persistent state: ${dataDir}`);
  console.log(`[OK] Admin: ${GATEWAY}/admin`);
} catch (error) {
  if (swapped && rollback && await exists(rollback)) {
    const failedCurrent = managedChild(installRoot, join(failedDir, `${String(distribution.sourceCommit).slice(0,12)}-${timestamp()}`));
    if (await exists(current)) await rename(current, failedCurrent);
    await rename(rollback, current);
    console.error("Installation failed; previous runtime directory was restored. The supervisor will return to it automatically.");
  }
  throw error;
}
