import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { OpenAICCError } from "../src/errors.js";

async function tempStore(): Promise<{ root: string; store: AccountStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-store-"));
  const store = new AccountStore(root);
  await store.init();
  return { root, store };
}

test("credential creation is explicit, duplicate ids conflict, and public state has no secrets", async () => {
  const { store } = await tempStore();
  await store.createApiKey({ id: "nvidia-main", name: "NVIDIA Main", provider: "nvidia", apiKey: "super-secret", model: "model-a" });
  await assert.rejects(
    () => store.createApiKey({ id: "nvidia-main", name: "Other", provider: "google", apiKey: "other-secret", model: "model-b" }),
    (error: unknown) => error instanceof OpenAICCError && error.status === 409 && error.code === "duplicate_credential",
  );
  const snapshot = store.snapshot();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.accounts[0].provider, "nvidia");
  assert.equal("apiKey" in snapshot.accounts[0], false);
  assert.equal("authFile" in snapshot.accounts[0], false);
  assert.equal(snapshot.preferredCredentialByProvider.nvidia, "nvidia-main");
  store.close();
});

test("legacy activeAccountId migrates only to its provider preference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-migrate-"));
  await writeFile(path.join(root, "accounts.json"), JSON.stringify({
    activeAccountId: "g-main",
    accounts: [
      { id: "g-main", name: "Google", provider: "google", apiKey: "x", model: "gemini", status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: "n-main", name: "NVIDIA", provider: "nvidia", apiKey: "y", model: "nim", status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ],
  }), "utf8");
  const store = new AccountStore(root);
  await store.init();
  const snapshot = store.snapshot();
  assert.equal(snapshot.preferredCredentialByProvider.google, "g-main");
  assert.equal(snapshot.preferredCredentialByProvider.nvidia, undefined);
  const disk = JSON.parse(await readFile(path.join(root, "accounts.json"), "utf8"));
  assert.equal(disk.version, 2);
  assert.equal("activeAccountId" in disk, false);
  store.close();
});

test("provider preference is tried first and disabled credentials never route", async () => {
  const { store } = await tempStore();
  await store.createApiKey({ id: "n1", name: "First", provider: "nvidia", apiKey: "a", model: "m" });
  await store.createApiKey({ id: "n2", name: "Second", provider: "nvidia", apiKey: "b", model: "m" });
  await store.prefer("n2");
  assert.deepEqual(store.orderedReady("nvidia").map((a) => a.id), ["n2", "n1"]);
  await store.disable("n2");
  assert.deepEqual(store.orderedReady("nvidia").map((a) => a.id), ["n1"]);
  await store.enable("n2");
  assert.equal(store.publicGet("n2")?.status, "ready");
  store.close();
});

test("disabled state survives an exhausted timer becoming due", async () => {
  const { root, store } = await tempStore();
  await store.createApiKey({ id: "g1", name: "Google", provider: "google", apiKey: "a", model: "m" });
  await store.markRateLimited("g1", "quota", 1000);
  await store.disable("g1");
  store.close();
  const file = path.join(root, "accounts.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  data.accounts[0].limitResetsAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(file, JSON.stringify(data), "utf8");
  const reloaded = new AccountStore(root);
  await reloaded.init();
  const credential = reloaded.publicGet("g1");
  assert.equal(credential?.status, "disabled");
  assert.equal(credential?.limitResetsAt, undefined);
  reloaded.close();
});

test("API-key replacement cannot change provider and path traversal ids are rejected", async () => {
  const { store } = await tempStore();
  await store.createApiKey({ id: "z1", name: "Zen", provider: "zen", apiKey: "old", model: "m1" });
  await store.replaceApiKey("z1", { apiKey: "new", model: "m2" });
  const internal = store.get("z1");
  assert.equal(internal?.provider, "zen");
  assert.equal(internal?.apiKey, "new");
  assert.throws(() => store.codexHomeFor(".."), (error: unknown) => error instanceof OpenAICCError && error.code === "invalid_credential_id");
  store.close();
});

test("deleting migrated external auth paths never recursively deletes outside managed data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-delete-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "openai-cc-outside-"));
  const auth = path.join(outside, "auth.json");
  await writeFile(auth, JSON.stringify({ tokens: { access_token: "dummy" } }), "utf8");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "accounts.json"), JSON.stringify({
    version: 2,
    preferredCredentialByProvider: {},
    accounts: [{ id: "legacy", name: "Legacy", provider: "chatgpt", authFile: auth, status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  }), "utf8");
  const store = new AccountStore(root);
  await store.init();
  await store.delete("legacy");
  assert.match(await readFile(auth, "utf8"), /dummy/);
  store.close();
});
