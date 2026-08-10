import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { AuthJob, ChatGptAuthRunner, StartAuthOptions } from "../src/chatgpt-auth.js";
import { createServer } from "../src/dispatcher.js";
import { OpenAICCError } from "../src/errors.js";
import { ModelConfigStore } from "../src/model-config.js";

class FakeAuthRunner extends EventEmitter implements ChatGptAuthRunner {
  jobs = new Map<string, AuthJob>();
  constructor(private store: AccountStore) { super(); }
  async start(options: StartAuthOptions): Promise<AuthJob> {
    const running = this.activeJobs();
    if (running.length) throw new OpenAICCError("Another login is running.", 409, "auth_job_conflict");
    const job: AuthJob = {
      jobId: `job-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      credentialId: options.credentialId,
      displayName: options.displayName,
      mode: options.mode ?? "create",
      loginMode: options.loginMode ?? "browser",
      status: options.loginMode === "device" ? "awaiting_user" : "awaiting_browser",
      startedAt: new Date().toISOString(),
      verificationUrl: options.loginMode === "device" ? "https://auth.openai.com/codex/device" : undefined,
      userCode: options.loginMode === "device" ? "ABCD-1234" : undefined,
      safeMessage: options.loginMode === "device" ? "Open the official Codex device sign-in page and enter the one-time code." : "Browser opened. Finish signing in with ChatGPT.",
    };
    this.jobs.set(job.jobId, job);
    this.emit("job", { ...job });
    if (options.credentialId === "success") setTimeout(() => { void this.complete(job.jobId); }, 10);
    return { ...job };
  }
  status(id: string): AuthJob { const job = this.jobs.get(id); if (!job) throw new OpenAICCError("Authentication job not found.", 404, "auth_job_not_found"); return { ...job }; }
  async cancel(id: string): Promise<void> { const job = this.jobs.get(id)!; job.status = "cancelled"; job.finishedAt = new Date().toISOString(); this.emit("job", { ...job }); }
  activeJobs(): AuthJob[] { return [...this.jobs.values()].filter((j) => !["complete", "error", "cancelled"].includes(j.status)).map((j) => ({ ...j })); }
  async shutdown(): Promise<void> {}
  private async complete(id: string): Promise<void> {
    const job = this.jobs.get(id)!;
    const authFile = this.store.authFileFor(job.credentialId);
    await mkdir(path.dirname(authFile), { recursive: true });
    await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", email: "success@example.com", tokens: { access_token: "dummy" } }));
    await this.store.createChatGpt({ id: job.credentialId, name: job.displayName, authFile, email: "success@example.com" });
    job.status = "complete"; job.email = "success@example.com"; job.finishedAt = new Date().toISOString(); job.safeMessage = "ChatGPT authentication completed.";
    this.emit("job", { ...job });
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-admin-"));
  const store = new AccountStore(root); await store.init();
  const models = new ModelConfigStore(root, store); await models.init();
  const auth = new FakeAuthRunner(store);
  const server = createServer(store, models, { authRunner: auth, bindHost: "127.0.0.1" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(`${base}/admin`);
  const html = await page.text();
  const match = html.match(/window\.__OPENAI_CC__=(\{[^;]+\});/);
  if (!match) throw new Error("csrf token missing");
  const csrf = JSON.parse(match[1]).csrfToken as string;
  return { root, store, models, auth, server, base, csrf, pageHeaders: page.headers, html };
}

async function request(base: string, csrf: string, pathname: string, init: RequestInit = {}) {
  const body = init.body ?? (init.method && init.method !== "GET" ? "{}" : undefined);
  const headers = new Headers(init.headers);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (body !== undefined && !headers.has("x-openai-cc-csrf")) headers.set("x-openai-cc-csrf", csrf);
  if (body !== undefined && !headers.has("origin")) headers.set("origin", base);
  return fetch(base + pathname, { ...init, body, headers });
}

test("Admin page/state use security headers and never expose API keys or auth paths", async () => {
  const f = await fixture();
  try {
    await f.store.createApiKey({ id: "n1", name: "NVIDIA", provider: "nvidia", apiKey: "top-secret", model: "nim" });
    const authFile = f.store.authFileFor("c1"); await mkdir(path.dirname(authFile), { recursive: true }); await writeFile(authFile, JSON.stringify({ tokens: { access_token: "private" } }));
    await f.store.createChatGpt({ id: "c1", name: "ChatGPT", authFile });
    const response = await fetch(`${f.base}/admin/state`); const text = await response.text();
    assert.equal(text.includes("top-secret"), false); assert.equal(text.includes("auth.json"), false); assert.equal(text.includes("authFile"), false); assert.equal(text.includes("apiKey"), false);
    assert.equal(f.html.includes("authFile"), false);
    assert.equal(f.pageHeaders.get("cache-control"), "no-store");
    assert.equal(f.pageHeaders.get("x-content-type-options"), "nosniff");
    assert.match(f.pageHeaders.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(f.pageHeaders.get("referrer-policy"), "no-referrer");
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("Admin mutations reject missing CSRF, wrong Origin, wrong content type, and oversized body", async () => {
  const f = await fixture();
  try {
    let response = await fetch(`${f.base}/admin/credentials`, { method: "POST", headers: { "content-type": "application/json", origin: f.base }, body: "{}" });
    assert.equal(response.status, 403);
    response = await fetch(`${f.base}/admin/credentials`, { method: "POST", headers: { "content-type": "application/json", "x-openai-cc-csrf": f.csrf, origin: "http://evil.example" }, body: "{}" });
    assert.equal(response.status, 403);
    response = await fetch(`${f.base}/admin/credentials`, { method: "POST", headers: { "content-type": "text/plain", "x-openai-cc-csrf": f.csrf, origin: f.base }, body: "{}" });
    assert.equal(response.status, 415);
    response = await fetch(`${f.base}/admin/model-config`, { method: "POST", headers: { "content-type": "application/json", "x-openai-cc-csrf": f.csrf, origin: f.base }, body: JSON.stringify({ pad: "x".repeat(70 * 1024) }) });
    assert.equal(response.status, 413);
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("hostile Admin Host header is rejected even from loopback", async () => {
  const f = await fixture();
  try {
    const url = new URL(f.base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: url.hostname, port: url.port, path: "/admin/state", headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403);
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("Admin API has explicit credential lifecycle and useful conflicts", async () => {
  const f = await fixture();
  try {
    const add = await request(f.base, f.csrf, "/admin/credentials", { method: "POST", body: JSON.stringify({ id: "n1", name: "NVIDIA", provider: "nvidia", apiKey: "secret", model: "nim" }) });
    assert.equal(add.status, 201);
    const duplicate = await request(f.base, f.csrf, "/admin/credentials", { method: "POST", body: JSON.stringify({ id: "n1", name: "Google", provider: "google", apiKey: "other", model: "gemini" }) });
    assert.equal(duplicate.status, 409); assert.equal((await duplicate.json() as any).error.code, "duplicate_credential");
    assert.equal((await request(f.base, f.csrf, "/admin/credentials/n1/disable", { method: "POST" })).status, 200);
    assert.equal(f.store.publicGet("n1")?.status, "disabled");
    assert.equal((await request(f.base, f.csrf, "/admin/credentials/n1/enable", { method: "POST" })).status, 200);
    assert.equal((await request(f.base, f.csrf, "/admin/credentials/n1/prefer", { method: "POST" })).status, 200);
    const replace = await request(f.base, f.csrf, "/admin/credentials/n1/replace-key", { method: "POST", body: JSON.stringify({ apiKey: "new-secret", model: "nim2" }) });
    assert.equal(replace.status, 200); assert.equal(f.store.get("n1")?.apiKey, "new-secret");

    const cfg = f.models.snapshot(); cfg.routes.sonnet = { provider: "nvidia", model: "nim2", credentialId: "n1", maxOutputTokens: 64000 };
    const save = await request(f.base, f.csrf, "/admin/model-config", { method: "POST", body: JSON.stringify(cfg) }); assert.equal(save.status, 200);
    const del = await request(f.base, f.csrf, "/admin/credentials/n1", { method: "DELETE" });
    assert.equal(del.status, 409); assert.equal((await del.json() as any).error.code, "credential_pinned");
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("ChatGPT auth jobs start, poll, cancel, and complete through injectable runner", async () => {
  const f = await fixture();
  try {
    const start = await request(f.base, f.csrf, "/admin/chatgpt/auth", { method: "POST", body: JSON.stringify({ id: "pending", name: "Pending" }) });
    assert.equal(start.status, 202); const job = await start.json() as any;
    assert.equal((await fetch(`${f.base}/admin/auth-jobs/${job.jobId}`)).status, 200);
    const cancel = await request(f.base, f.csrf, `/admin/auth-jobs/${job.jobId}/cancel`, { method: "POST" }); assert.equal(cancel.status, 200); assert.equal((await cancel.json() as any).status, "cancelled");
    const success = await request(f.base, f.csrf, "/admin/chatgpt/auth", { method: "POST", body: JSON.stringify({ id: "success", name: "Success" }) });
    const successJob = await success.json() as any;
    for (let i = 0; i < 30 && f.auth.status(successJob.jobId).status !== "complete"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.auth.status(successJob.jobId).status, "complete");
    assert.equal(f.store.publicGet("success")?.email, "success@example.com");
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});


test("Admin auth conflicts and unknown jobs return structured 4xx errors", async () => {
  const f = await fixture();
  try {
    const first = await request(f.base, f.csrf, "/admin/chatgpt/auth", { method: "POST", body: JSON.stringify({ id: "one", name: "One" }) });
    assert.equal(first.status, 202);
    const second = await request(f.base, f.csrf, "/admin/chatgpt/auth", { method: "POST", body: JSON.stringify({ id: "two", name: "Two" }) });
    assert.equal(second.status, 409);
    assert.equal((await second.json() as any).error.code, "auth_job_conflict");
    const job = await first.json() as any;
    await request(f.base, f.csrf, `/admin/auth-jobs/${job.jobId}/cancel`, { method: "POST" });
    const missing = await fetch(`${f.base}/admin/auth-jobs/job-does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).error.code, "auth_job_not_found");
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("loopback JSON automation without a browser Origin remains supported", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/admin/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "automation", name: "Automation", provider: "nvidia", apiKey: "secret", model: "nim" }),
    });
    assert.equal(response.status, 201);
    assert.equal(f.store.publicGet("automation")?.provider, "nvidia");
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("Admin is refused when configured for non-loopback bind without explicit override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-remote-admin-"));
  const store = new AccountStore(root); await store.init();
  const models = new ModelConfigStore(root, store); await models.init();
  const auth = new FakeAuthRunner(store);
  const server = createServer(store, models, { authRunner: auth, bindHost: "0.0.0.0", allowRemoteAdmin: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/admin`);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as any).error.code, "remote_admin_disabled");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});


test("explicit remote-admin override permits only same-origin CSRF-protected browser mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-remote-override-"));
  const store = new AccountStore(root); await store.init();
  const models = new ModelConfigStore(root, store); await models.init();
  const auth = new FakeAuthRunner(store);
  const server = createServer(store, models, { authRunner: auth, bindHost: "0.0.0.0", allowRemoteAdmin: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  const port = address.port;
  const virtualHost = `admin.example.test:${port}`;
  try {
    const page = await rawAdminRequest(port, "/admin", "GET", { Host: virtualHost });
    assert.equal(page.status, 200);
    const match = page.body.match(/window\.__OPENAI_CC__=(\{[^;]+\});/);
    if (!match) throw new Error("csrf token missing");
    const csrf = JSON.parse(match[1]).csrfToken as string;
    const good = await rawAdminRequest(port, "/admin/credentials", "POST", {
      Host: virtualHost, Origin: `http://${virtualHost}`, "Content-Type": "application/json", "X-OpenAI-CC-CSRF": csrf,
    }, JSON.stringify({ id: "remote", name: "Remote", provider: "nvidia", apiKey: "secret", model: "nim" }));
    assert.equal(good.status, 201);
    const wrongOrigin = await rawAdminRequest(port, "/admin/credentials", "POST", {
      Host: virtualHost, Origin: `http://evil.example:${port}`, "Content-Type": "application/json", "X-OpenAI-CC-CSRF": csrf,
    }, JSON.stringify({ id: "bad-origin", name: "Bad", provider: "nvidia", apiKey: "secret", model: "nim" }));
    assert.equal(wrongOrigin.status, 403);
    const noOriginNoCsrf = await rawAdminRequest(port, "/admin/credentials", "POST", {
      Host: virtualHost, "Content-Type": "application/json",
    }, JSON.stringify({ id: "no-csrf", name: "Bad", provider: "nvidia", apiKey: "secret", model: "nim" }));
    assert.equal(noOriginNoCsrf.status, 403);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

async function rawAdminRequest(port: number, requestPath: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
