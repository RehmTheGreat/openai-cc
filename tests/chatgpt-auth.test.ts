import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { AuthJob, OfficialCodexAuthRunner } from "../src/chatgpt-auth.js";
import { OpenAICCError } from "../src/errors.js";

async function fakeCodex(root: string): Promise<string> {
  const file = path.join(root, "fake-codex.mjs");
  await writeFile(file, `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const home=process.env.CODEX_HOME;
const mode=process.env.FAKE_CODEX_BEHAVIOR||'success';
if(mode==='fail'){console.error('login failed safely');process.exit(7)}
if(mode==='hang'){console.error('Open this URL: https://example.invalid/?state=secret&code_verifier=secret');setInterval(()=>{},1000)}
await mkdir(home,{recursive:true});
if(mode==='malformed') await writeFile(path.join(home,'auth.json'),'not-json');
else await writeFile(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',email:'person@example.com',tokens:{access_token:'dummy-access',refresh_token:'dummy-refresh'}}));
console.error('Open this URL: https://example.invalid/?state=secret&code=secret');
`, "utf8");
  return file;
}

async function waitTerminal(runner: OfficialCodexAuthRunner, job: AuthJob): Promise<AuthJob> {
  for (let i = 0; i < 100; i++) {
    const current = runner.status(job.jobId);
    if (["complete", "error", "cancelled"].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("job did not settle");
}

test("official Codex runner creates isolated managed auth and never exposes captured OAuth URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-auth-"));
  const store = new AccountStore(path.join(root, "data"));
  await store.init();
  const entrypoint = await fakeCodex(root);
  const previous = process.env.FAKE_CODEX_BEHAVIOR;
  process.env.FAKE_CODEX_BEHAVIOR = "success";
  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 5_000 });
  const started = await runner.start({ credentialId: "main", displayName: "Main", mode: "create" });
  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;
  const done = await waitTerminal(runner, started);
  assert.equal(done.status, "complete");
  assert.equal(done.email, "person@example.com");
  assert.equal(JSON.stringify(done).includes("state=secret"), false);
  const internal = store.get("main");
  assert.equal(internal?.authFile, store.authFileFor("main"));
  assert.match(await readFile(store.authFileFor("main"), "utf8"), /dummy-access/);
  assert.equal("authFile" in (store.publicGet("main") as object), false);
  await runner.shutdown();
  store.close();
});

test("failed re-auth leaves the existing working auth file unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-reauth-"));
  const store = new AccountStore(path.join(root, "data"));
  await store.init();
  const oldAuth = store.authFileFor("main");
  await mkdir(path.dirname(oldAuth), { recursive: true });
  const oldContents = JSON.stringify({ auth_mode: "chatgpt", email: "old@example.com", tokens: { access_token: "old-token" } });
  await writeFile(oldAuth, oldContents, "utf8");
  await store.createChatGpt({ id: "main", name: "Main", authFile: oldAuth, email: "old@example.com" });
  const entrypoint = await fakeCodex(root);
  const previous = process.env.FAKE_CODEX_BEHAVIOR;
  process.env.FAKE_CODEX_BEHAVIOR = "fail";
  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 5_000 });
  const started = await runner.start({ credentialId: "main", displayName: "Main", mode: "reauth" });
  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;
  const done = await waitTerminal(runner, started);
  assert.equal(done.status, "error");
  assert.equal(await readFile(oldAuth, "utf8"), oldContents);
  assert.equal(store.publicGet("main")?.email, "old@example.com");
  await runner.shutdown();
  store.close();
});

test("only one official browser/device login job runs at once and cancellation settles it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-cancel-"));
  const store = new AccountStore(path.join(root, "data"));
  await store.init();
  const entrypoint = await fakeCodex(root);
  const previous = process.env.FAKE_CODEX_BEHAVIOR;
  process.env.FAKE_CODEX_BEHAVIOR = "hang";
  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 10_000 });
  const first = await runner.start({ credentialId: "one", displayName: "One" });
  await assert.rejects(
    () => runner.start({ credentialId: "two", displayName: "Two" }),
    (error: unknown) => error instanceof OpenAICCError && error.status === 409 && error.code === "auth_job_conflict",
  );
  await runner.cancel(first.jobId);
  const cancelled = runner.status(first.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(JSON.stringify(cancelled).includes("state=secret"), false);
  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;
  await runner.shutdown();
  store.close();
});

test("auth timeout terminates a hung official Codex process without changing credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-timeout-"));
  const store = new AccountStore(path.join(root, "data"));
  await store.init();
  const entrypoint = await fakeCodex(root);
  const previous = process.env.FAKE_CODEX_BEHAVIOR;
  process.env.FAKE_CODEX_BEHAVIOR = "hang";
  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 80 });
  const started = await runner.start({ credentialId: "timeout", displayName: "Timeout" });
  const done = await waitTerminal(runner, started);
  assert.equal(done.status, "error");
  assert.equal(done.errorCode, "auth_timeout");
  assert.equal(store.has("timeout"), false);
  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;
  await runner.shutdown();
  store.close();
});

test("malformed Codex auth artifact is rejected without creating a credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-malformed-"));
  const store = new AccountStore(path.join(root, "data"));
  await store.init();
  const entrypoint = await fakeCodex(root);
  const previous = process.env.FAKE_CODEX_BEHAVIOR;
  process.env.FAKE_CODEX_BEHAVIOR = "malformed";
  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 5_000 });
  const started = await runner.start({ credentialId: "bad", displayName: "Bad" });
  const done = await waitTerminal(runner, started);
  assert.equal(done.status, "error");
  assert.equal(store.has("bad"), false);
  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;
  await runner.shutdown();
  store.close();
});

test("re-auth rolls back a promoted auth file when account metadata persistence fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-rollback-"));
  const store = new AccountStore(path.join(root, "data"));
  await store.init();
  const oldAuth = store.authFileFor("main");
  await mkdir(path.dirname(oldAuth), { recursive: true });
  const oldContents = JSON.stringify({ auth_mode: "chatgpt", email: "old@example.com", tokens: { access_token: "old-token" } });
  await writeFile(oldAuth, oldContents, "utf8");
  await store.createChatGpt({ id: "main", name: "Main", authFile: oldAuth, email: "old@example.com" });
  const originalPersist = (store as any).persist.bind(store);
  let failPersist = true;
  (store as any).persist = async () => {
    if (failPersist) { failPersist = false; throw new Error("simulated metadata persistence failure"); }
    return originalPersist();
  };
  const entrypoint = await fakeCodex(root);
  const previous = process.env.FAKE_CODEX_BEHAVIOR;
  process.env.FAKE_CODEX_BEHAVIOR = "success";
  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 5_000 });
  const started = await runner.start({ credentialId: "main", displayName: "Main", mode: "reauth" });
  const done = await waitTerminal(runner, started);
  assert.equal(done.status, "error");
  assert.equal(await readFile(oldAuth, "utf8"), oldContents);
  (store as any).persist = originalPersist;
  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;
  await runner.shutdown();
  store.close();
});


test("bundled official Codex accepts isolated file-credential-store login status", async (t) => {
  let packageJson: string;
  try {
    const require = createRequire(import.meta.url);
    packageJson = require.resolve("@openai/codex/package.json");
  } catch {
    t.skip("bundled Codex package is not installed in the offline local harness");
    return;
  }
  const codex = path.join(path.dirname(packageJson), "bin", "codex.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "openai-cc-real-codex-status-"));
  const result = spawnSync(process.execPath, [codex, "-c", 'cli_auth_credentials_store="file"', "login", "status"], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ""} ${result.stderr ?? ""}`;
  assert.equal(result.status, 1);
  assert.doesNotMatch(output, /unknown.*cli_auth_credentials_store|invalid.*config/i);
  assert.match(output, /not logged in|login/i);
});
