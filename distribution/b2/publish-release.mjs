import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { authorize, apiJson, requireBucketScope, requireExactCapabilities, uploadFile } from "./b2-client.mjs";

function fail(message) { throw new Error(message); }

const artifactDirectory = process.argv[2];
if (!artifactDirectory) fail("Usage: node distribution/b2/publish-release.mjs <artifact-directory>");

const keyId = process.env.B2_PUBLISH_KEY_ID;
const key = process.env.B2_PUBLISH_KEY;
const bucketId = process.env.B2_BUCKET_ID;
if (!keyId || !key || !bucketId) fail("B2_PUBLISH_KEY_ID, B2_PUBLISH_KEY, and B2_BUCKET_ID are required.");

const artifactRoot = resolve(artifactDirectory);
const manifestPath = join(artifactRoot, "openai-cc-runtime-manifest.json");
const installerPath = join(artifactRoot, "install.ps1");
const bootstrapPath = resolve("distribution/b2/bootstrap.ps1");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

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
requireExactCapabilities(auth.storage.allowed, ["writeFiles"]);
requireBucketScope(auth.storage.allowed, bucketId, "releases/");

const upload = await apiJson(auth, "b2_get_upload_url", { bucketId });
if (!upload.uploadUrl || !upload.authorizationToken) fail("b2_get_upload_url returned incomplete upload metadata.");

const files = [
  ["bootstrap.ps1", bootstrapPath],
  ["install.ps1", installerPath],
  ["openai-cc-runtime-manifest.json", manifestPath],
  [bundleName, bundlePath],
];

for (const [name, path] of files) {
  console.log(`Publishing ${name}`);
  await uploadFile(upload.uploadUrl, upload.authorizationToken, `${releasePrefix}${name}`, path);
}

console.log("");
console.log("Published gated Backblaze B2 runtime package.");
console.log(`Release prefix: ${releasePrefix}`);
console.log(`Source commit:  ${manifest.sourceCommit}`);
console.log("Publisher credentials were not embedded in or printed with the release.");
