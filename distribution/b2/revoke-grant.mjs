import { authorize, apiJson } from "./b2-client.mjs";

function fail(message) { throw new Error(message); }
const index = process.argv.indexOf("--key-id");
const applicationKeyId = index >= 0 ? process.argv[index + 1] : undefined;
if (!applicationKeyId) fail("Usage: node distribution/b2/revoke-grant.mjs --key-id <applicationKeyId>");

const issuerId = process.env.B2_ISSUER_KEY_ID;
const issuerKey = process.env.B2_ISSUER_KEY;
if (!issuerId || !issuerKey) fail("B2_ISSUER_KEY_ID and B2_ISSUER_KEY are required on the trusted admin machine.");

const issuer = await authorize(issuerId, issuerKey);
const capabilities = new Set(issuer.storage.allowed?.capabilities || []);
if (!capabilities.has("deleteKeys")) fail("Issuer key requires deleteKeys capability.");

const deleted = await apiJson(issuer, "b2_delete_key", { applicationKeyId });
if (deleted.applicationKeyId && deleted.applicationKeyId !== applicationKeyId) {
  fail("Backblaze deleted an unexpected application key ID.");
}
console.log(`Revoked distribution grant ${applicationKeyId}.`);
