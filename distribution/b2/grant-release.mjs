import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { authorize, apiJson, sha256File } from "./b2-client.mjs";

function fail(message) { throw new Error(message); }
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const manifestPath = arg("--manifest");
const outputPath = arg("--output");
const ttlRaw = arg("--ttl-seconds") || "900";
if (!manifestPath || !outputPath) fail("Usage: node distribution/b2/grant-release.mjs --manifest <manifest.json> --output <private-grant.json> [--ttl-seconds 900]");

const ttlSeconds = Number(ttlRaw);
if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) fail("Grant TTL must be an integer from 60 to 3600 seconds.");

const issuerId = process.env.B2_ISSUER_KEY_ID;
const issuerKey = process.env.B2_ISSUER_KEY;
const bucketId = process.env.B2_BUCKET_ID;
if (!issuerId || !issuerKey || !bucketId) fail("B2_ISSUER_KEY_ID, B2_ISSUER_KEY, and B2_BUCKET_ID are required on the trusted admin machine.");

const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
if (!/^[0-9a-f]{40}$/i.test(String(manifest.sourceCommit || ""))) fail("Manifest sourceCommit must be a 40-character Git SHA.");
if (!String(manifest.appVersion || "")) fail("Manifest appVersion is missing.");
const versionPart = String(manifest.appVersion).replace(/[^0-9A-Za-z._+-]/g, "-");
const releasePrefix = `releases/${versionPart}-${String(manifest.sourceCommit).toLowerCase()}/`;

const issuer = await authorize(issuerId, issuerKey);
const capabilities = new Set(issuer.storage.allowed?.capabilities || []);
if (!capabilities.has("writeKeys")) fail("Issuer key requires writeKeys capability.");

const keyName = `openai-cc-${String(manifest.sourceCommit).slice(0, 12)}-${randomBytes(4).toString("hex")}`;
const created = await apiJson(issuer, "b2_create_key", {
  capabilities: ["readFiles"],
  keyName,
  validDurationInSeconds: ttlSeconds,
  bucketIds: [bucketId],
  namePrefix: releasePrefix,
});

if (!created.applicationKeyId || !created.applicationKey || !created.expirationTimestamp) {
  fail("b2_create_key returned incomplete grant data.");
}

const bootstrapSha256 = await sha256File(resolve("distribution/b2/bootstrap.ps1"));
const output = {
  schemaVersion: 1,
  applicationKeyId: created.applicationKeyId,
  applicationKey: created.applicationKey,
  expirationTimestamp: created.expirationTimestamp,
  bucketId,
  releasePrefix,
  bootstrapSha256,
};

const destination = resolve(outputPath);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Created read-only distribution grant ${created.applicationKeyId}.`);
console.log(`Release prefix: ${releasePrefix}`);
console.log(`TTL: ${ttlSeconds} seconds`);
console.log(`Private grant written to: ${destination}`);
console.log("The application key was not printed. Revoke it after the install/update succeeds.");
