import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { authorize, requireBucketScope, requireExactCapabilities, uploadFileWithRetry } from "./b2-client.mjs";

function fail(message) { throw new Error(message); }
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const artifactDirectory = process.argv[2];
if (!artifactDirectory) fail("Usage: node distribution/b2/publish-release.mjs <artifact-directory> [--platform win32-x64|darwin-arm64]");
const platform = option("--platform", "win32-x64");
if (!["win32-x64", "darwin-arm64"].includes(platform)) fail(`Unsupported publish platform: ${platform}`);

const keyId = process.env.B2_PUBLISH_KEY_ID;
const key = process.env.B2_PUBLISH_KEY;
const bucketId = process.env.B2_BUCKET_ID;
if (!keyId || !key || !bucketId) fail("B2_PUBLISH_KEY_ID, B2_PUBLISH_KEY, and B2_BUCKET_ID are required.");

const artifactRoot = resolve(artifactDirectory);
const manifestName = platform === "darwin-arm64" ? "openai-cc-runtime-manifest-darwin-arm64.json" : "openai-cc-runtime-manifest.json";
const installName = platform === "darwin-arm64" ? "install.sh" : "install.ps1";
const bootstrapName = "bootstrap.ps1";
const manifestPath = join(artifactRoot, manifestName);
const installerPath = join(artifactRoot, installName);
const bootstrapPath = resolve("distribution/b2", bootstrapName);
const bootstrapPublishPath = join(artifactRoot, bootstrapName);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (platform === "win32-x64") {
  const canonicalBootstrap = (await readFile(bootstrapPath, "utf8")).replace(/\r\n/g, "\n");
  await writeFile(bootstrapPublishPath, canonicalBootstrap, "utf8");
}

if (String(manifest.platform || "") !== platform) fail(`Manifest platform '${manifest.platform}' does not match requested publish platform '${platform}'.`);
if (!/^[0-9a-f]{40}$/i.test(String(manifest.sourceCommit || ""))) fail("Manifest sourceCommit must be a 40-character Git SHA.");
if (!String(manifest.appVersion || "")) fail("Manifest appVersion is missing.");
const currentSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
if (currentSha !== String(manifest.sourceCommit).toLowerCase()) fail("Artifact sourceCommit does not match the checked-out source. Publish from the exact release commit.");
const bundleName = String(manifest.bundleUrl || "");
if (!bundleName || basename(bundleName) !== bundleName || /[\\/]/.test(bundleName)) fail("Manifest bundleUrl must be a local leaf filename.");
const bundlePath = join(artifactRoot, bundleName);

const versionPart = String(manifest.appVersion).replace(/[^0-9A-Za-z._+-]/g, "-");
const releasePrefix = `releases/${versionPart}-${String(manifest.sourceCommit).toLowerCase()}/`;

const auth = await authorize(keyId, key);
const actualCapabilities = [...(auth.storage.allowed?.capabilities || [])];
if (actualCapabilities.includes("writeFiles") && (actualCapabilities.length !== 1 || actualCapabilities[0] !== "writeFiles")) {
  fail(
    "B2_PUBLISH_KEY_* is overbroad (a Master Application Key produces this exact symptom). " +
    "Do not store a master/issuer key in GitHub. Run distribution/b2/provision-keys.ps1 locally with the master key, " +
    "then set GitHub B2_PUBLISH_KEY_ID/B2_PUBLISH_KEY from the generated publisher.* values only."
  );
}
requireExactCapabilities(auth.storage.allowed, ["writeFiles"]);
requireBucketScope(auth.storage.allowed, bucketId, "releases/");

const files = platform === "darwin-arm64"
  ? [
      ["install.sh", installerPath],
      ["install-macos.mjs", join(artifactRoot, "install-macos.mjs")],
      [manifestName, manifestPath],
      [bundleName, bundlePath],
    ]
  : [
      [bootstrapName, bootstrapPublishPath],
      [installName, installerPath],
      [manifestName, manifestPath],
      [bundleName, bundlePath],
    ];

for (const [name, path] of files) {
  console.log(`Publishing ${name}`);
  await uploadFileWithRetry(auth, bucketId, `${releasePrefix}${name}`, path, {
    maxAttempts: 5,
    baseDelayMs: 500,
    onRetry: ({ nextAttempt, maxAttempts, delayMs, error }) => {
      console.warn(
        `Transient Backblaze upload failure (${error?.status || "5xx"}: ${error?.message || "server error"}). ` +
        `Discarding the upload URL and retrying with a fresh one in ${delayMs}ms ` +
        `(attempt ${nextAttempt}/${maxAttempts}).`
      );
    },
  });
}

console.log("");
console.log(`Published gated Backblaze B2 runtime package (${platform}).`);
console.log(`Release prefix: ${releasePrefix}`);
console.log(`Source commit:  ${manifest.sourceCommit}`);
console.log("Publisher credentials were not embedded in or printed with the release.");
