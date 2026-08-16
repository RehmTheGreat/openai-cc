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

test("ChatGPT no longer starts a synthetic five-hour window and unknown 429 resets stay exhausted", async () => {
  const { store } = await tempStore();
  await store.createChatGpt({ id: "c1", name: "ChatGPT" });
  await store.noteRequest("c1");
  assert.equal(store.publicGet("c1")?.firstRequestAt, undefined);
  assert.equal(store.publicGet("c1")?.limitResetsAt, undefined);

  await store.markRateLimited("c1", "429 usage limit");
  let account = store.publicGet("c1");
  assert.equal(account?.status, "exhausted");
  assert.equal(account?.limitResetsAt, undefined);
  assert.equal(account?.limitResetSource, undefined);

  await store.markRetrySucceeded("c1");
  account = store.publicGet("c1");
  assert.equal(account?.status, "ready");
  assert.equal(account?.lastError, undefined);
  store.close();
});

test("ChatGPT persists an upstream-reported reset and clears it after a successful Retry", async () => {
  const { store } = await tempStore();
  await store.createChatGpt({ id: "c1", name: "ChatGPT" });
  const cooldown = 7 * 24 * 60 * 60 * 1000;
  const before = Date.now();
  await store.markRateLimited("c1", "429 weekly limit", cooldown);
  let account = store.publicGet("c1");
  assert.equal(account?.status, "exhausted");
  assert.equal(account?.limitResetSource, "upstream");
  const reset = Date.parse(account?.limitResetsAt ?? "");
  assert.ok(reset >= before + cooldown && reset <= Date.now() + cooldown + 1000);

  await store.markRetrySucceeded("c1");
  account = store.publicGet("c1");
  assert.equal(account?.status, "ready");
  assert.equal(account?.limitResetsAt, undefined);
  assert.equal(account?.limitResetSource, undefined);
  store.close();
});

test("legacy synthetic ChatGPT five-hour timestamps are discarded without falsely re-enabling an exhausted account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-chatgpt-limit-migrate-"));
  const now = Date.now();
  await writeFile(path.join(root, "accounts.json"), JSON.stringify({
    version: 2,
    preferredCredentialByProvider: { chatgpt: "c1" },
    accounts: [{
      id: "c1",
      name: "ChatGPT",
      provider: "chatgpt",
      status: "exhausted",
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
      firstRequestAt: new Date(now - 60_000).toISOString(),
      limitResetsAt: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
      exhaustedAt: new Date(now - 30_000).toISOString(),
      lastError: "429 usage limit",
    }],
  }), "utf8");
  const store = new AccountStore(root);
  await store.init();
  const account = store.publicGet("c1");
  assert.equal(account?.status, "exhausted");
  assert.equal(account?.firstRequestAt, undefined);
  assert.equal(account?.limitResetsAt, undefined);
  assert.equal(account?.lastError, "429 usage limit");
  store.close();
});

test("serialized account-store writes remain valid when mutations overlap", async () => {
  const { root, store } = await tempStore();
  await store.createApiKey({ id: "g1", name: "G1", provider: "google", apiKey: "a", model: "m" });
  await store.createApiKey({ id: "g2", name: "G2", provider: "google", apiKey: "b", model: "m" });
  await Promise.all([store.rename("g1", "Google One"), store.rename("g2", "Google Two")]);
  const disk = JSON.parse(await readFile(path.join(root, "accounts.json"), "utf8"));
  assert.equal(disk.accounts.find((a: any) => a.id === "g1")?.name, "Google One");
  assert.equal(disk.accounts.find((a: any) => a.id === "g2")?.name, "Google Two");
  store.close();
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


test("authentication errors are sticky, secret-safe, and excluded from routing", async () => {
  const { store } = await tempStore();
  await store.createApiKey({ id: "g1", name: "Google 1", provider: "google", apiKey: "a", model: "m" });
  await store.createApiKey({ id: "g2", name: "Google 2", provider: "google", apiKey: "b", model: "m" });
  const jwt = "eyJaaaaaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccc";
  await store.markAuthError("g1", `401 access_token=very-secret https://auth.example.invalid ${jwt}`);
  const failed = store.publicGet("g1");
  assert.equal(failed?.status, "auth_error");
  assert.equal(failed?.lastError?.includes("very-secret"), false);
  assert.equal(failed?.lastError?.includes("auth.example.invalid"), false);
  assert.equal(failed?.lastError?.includes(jwt), false);
  assert.deepEqual(store.orderedReady("google").map((a) => a.id), ["g2"]);
  await assert.rejects(() => store.prefer("g1"), (error: unknown) => error instanceof OpenAICCError && error.code === "credential_unavailable");
  await store.disable("g1");
  await store.enable("g1");
  assert.equal(store.publicGet("g1")?.status, "auth_error");
  store.close();
});

test("failed API-key replacement rolls in-memory state back before returning", async () => {
  const { store } = await tempStore();
  await store.createApiKey({ id: "n1", name: "NVIDIA", provider: "nvidia", apiKey: "old-key", model: "old-model" });
  const originalPersist = (store as any).persist.bind(store);
  (store as any).persist = async () => { throw new Error("simulated disk failure"); };
  await assert.rejects(() => store.replaceApiKey("n1", { apiKey: "new-key", model: "new-model" }), /simulated disk failure/);
  (store as any).persist = originalPersist;
  const record = store.get("n1");
  assert.equal(record?.apiKey, "old-key");
  assert.equal(record?.model, "old-model");
  assert.equal(record?.status, "ready");
  store.close();
});
