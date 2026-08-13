import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

function fail(message) { throw new Error(message); }
function arg(name, fallback = "") { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function sha256File(path) {
  return await new Promise((ok, bad) => {
    const hash = createHash("sha256"), stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", bad);
    stream.on("end", () => ok(hash.digest("hex")));
  });
}
async function walkFiles(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`Symlink is not allowed in runtime bundle: ${relative(root, full)}`);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
      else fail(`Unsupported runtime entry: ${relative(root, full)}`);
    }
  }
  await visit(root);
  return out;
}
function contentDigest(files) {
  const canonical = files.slice().sort((a,b)=>a.path.localeCompare(b.path)).map((f)=>`${f.path}|${f.sha256}|${f.size}`).join("\n") + "\n";
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

if (process.platform !== "darwin" || process.arch !== "arm64") fail(`macOS runtime bundle must be built natively on darwin-arm64; got ${process.platform}-${process.arch}.`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(arg("--output", "artifacts"));
const buildInfoFile = join(repoRoot, "dist", "build-info.json");
const packageFile = join(repoRoot, "package.json");
const nodeModules = join(repoRoot, "node_modules");
if (!(await exists(buildInfoFile))) fail("dist/build-info.json is missing. Run npm run build first.");
if (!(await exists(nodeModules))) fail("node_modules is missing. Install dependencies before building the runtime bundle.");

const buildInfo = JSON.parse(await readFile(buildInfoFile, "utf8"));
const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
const appVersion = String(packageJson.version || "");
const sourceCommit = String(buildInfo.buildSha || "").toLowerCase();
const buildTime = new Date(String(buildInfo.buildTime || ""));
if (!appVersion) fail("package.json version is missing.");
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail(`A real 40-character source commit SHA is required; got '${sourceCommit}'.`);
if (Number.isNaN(buildTime.getTime())) fail(`Invalid build timestamp '${buildInfo.buildTime}'.`);
for (const name of Object.keys(packageJson.devDependencies || {})) {
  if (await exists(join(nodeModules, ...name.split("/")))) fail(`Dev dependency '${name}' is still installed. Run npm prune --omit=dev before packaging.`);
}

await mkdir(outputDirectory, { recursive: true });
const tempRoot = await mkdtemp(join(os.tmpdir(), "openai-cc-mac-bundle-"));
const stage = join(tempRoot, "runtime");
await mkdir(stage, { recursive: true });

async function copyItem(rel) {
  const source = join(repoRoot, rel), destination = join(stage, rel);
  if (!(await exists(source))) fail(`Required runtime item is missing: ${rel}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (candidate) => {
      const leaf = basename(candidate);
      if (candidate.endsWith(".map")) return false;
      if (leaf === ".package-lock.json") return false;
      return true;
    },
  });
}

for (const rel of [
  "dist/src", "dist/build-info.json", "dist/scripts/configure-clients.js", "dist/scripts/codex-doctor.js",
  "dist/scripts/migrate-data.js", "node_modules", "package.json", "run-gateway.sh", "run-claude.sh",
]) await copyItem(rel);

for (const forbidden of [".data", ".git", "src", "tests", "setup.ps1", "install.ps1", "package-lock.json"]) {
  if (await exists(join(stage, forbidden))) fail(`Forbidden item leaked into runtime bundle: ${forbidden}`);
}

const files = [];
for (const full of await walkFiles(stage)) {
  const info = await stat(full);
  files.push({ path: relative(stage, full).split(sep).join("/"), sha256: await sha256File(full), size: info.size });
}
if (!files.length) fail("Runtime staging directory is unexpectedly empty.");
const digest = contentDigest(files);
const internalManifest = { schemaVersion:1, appVersion, sourceCommit, buildTimestamp:buildTime.toISOString(), platform:"darwin-arm64", contentSha256:digest, files };
await writeFile(join(stage, "runtime-manifest.json"), JSON.stringify(internalManifest, null, 2) + "\n", "utf8");

async function normalizeTimes(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await normalizeTimes(full);
    await utimes(full, buildTime, buildTime);
  }
}
await normalizeTimes(stage);
await utimes(stage, buildTime, buildTime);

const bundleName = `openai-cc-runtime-${appVersion}-${sourceCommit.slice(0,12)}-darwin-arm64.zip`;
const bundlePath = join(outputDirectory, bundleName);
if (await exists(bundlePath)) fail(`Refusing to overwrite existing bundle: ${bundlePath}`);
const zipFiles = (await walkFiles(stage)).map((f)=>relative(stage,f).split(sep).join("/")).sort();
const zipped = spawnSync("/usr/bin/zip", ["-X", "-q", bundlePath, "-@"], { cwd: stage, input: zipFiles.join("\n") + "\n", encoding: "utf8" });
if (zipped.status !== 0) fail(`zip failed: ${zipped.stderr || zipped.stdout || "nonzero exit"}`);

const installSource = join(repoRoot, "install.sh");
const installerSource = join(repoRoot, "install-macos.mjs");
const installOutput = join(outputDirectory, "install.sh");
const installerOutput = join(outputDirectory, "install-macos.mjs");
await cp(installSource, installOutput, { force: false });
await cp(installerSource, installerOutput, { force: false });

const externalManifest = {
  schemaVersion:1,
  appVersion,
  sourceCommit,
  buildTimestamp:buildTime.toISOString(),
  platform:"darwin-arm64",
  bundleUrl:bundleName,
  bundleSha256:await sha256File(bundlePath),
  bundleSize:(await stat(bundlePath)).size,
  contentSha256:digest,
  bootstrapSha256:await sha256File(installOutput),
  installerSha256:await sha256File(installerOutput),
};
const manifestPath = join(outputDirectory, "openai-cc-runtime-manifest-darwin-arm64.json");
if (await exists(manifestPath)) fail(`Refusing to overwrite existing manifest: ${manifestPath}`);
await writeFile(manifestPath, JSON.stringify(externalManifest, null, 2) + "\n", "utf8");

console.log(`Runtime bundle: ${bundlePath}`);
console.log(`Manifest:       ${manifestPath}`);
console.log(`Source SHA:     ${sourceCommit}`);
console.log(`Bundle SHA256:  ${externalManifest.bundleSha256}`);
console.log(`Content SHA256: ${digest}`);
