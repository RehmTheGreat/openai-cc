import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { AuthJob, ChatGptAuthRunner, StartAuthOptions } from "../src/chatgpt-auth.js";
import { createServer } from "../src/dispatcher.js";
import { OpenAICCError } from "../src/errors.js";
import { ModelConfigStore } from "../src/model-config.js";
import { DiscoveredModel } from "../src/provider-registry.js";

class UiAuthRunner extends EventEmitter implements ChatGptAuthRunner {
  private jobs = new Map<string, AuthJob>();
  async start(options: StartAuthOptions): Promise<AuthJob> {
    if (this.activeJobs().length) throw new OpenAICCError("Another login is running.", 409, "auth_job_conflict");
    const job: AuthJob = { jobId: `job-${Date.now()}-${Math.random().toString(16).slice(2)}`, credentialId: options.credentialId, displayName: options.displayName, mode: options.mode ?? "create", loginMode: options.loginMode ?? "browser", status: options.loginMode === "device" ? "awaiting_user" : "awaiting_browser", startedAt: new Date().toISOString(), verificationUrl: options.loginMode === "device" ? "https://auth.openai.com/codex/device" : undefined, userCode: options.loginMode === "device" ? "ABCD-1234" : undefined, safeMessage: "Authentication started." };
    this.jobs.set(job.jobId, job); this.emit("job", { ...job }); return { ...job };
  }
  status(id: string): AuthJob { const job = this.jobs.get(id); if (!job) throw new OpenAICCError("Authentication job not found.", 404, "auth_job_not_found"); return { ...job }; }
  async cancel(id: string): Promise<void> { const job = this.jobs.get(id); if (!job) throw new OpenAICCError("Authentication job not found.", 404, "auth_job_not_found"); job.status = "cancelled"; job.finishedAt = new Date().toISOString(); this.emit("job", { ...job }); }
  activeJobs(): AuthJob[] { return [...this.jobs.values()].filter((job) => !["complete", "error", "cancelled"].includes(job.status)).map((job) => ({ ...job })); }
  async shutdown(): Promise<void> {}
}

async function fixture(modelDiscoverer?: (account: any) => Promise<DiscoveredModel[]>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-admin-ui-"));
  const store = new AccountStore(root); await store.init();
  const models = new ModelConfigStore(root, store); await models.init();
  const auth = new UiAuthRunner();
  const server = createServer(store, models, { authRunner: auth, bindHost: "127.0.0.1", ...(modelDiscoverer ? { modelDiscoverer } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/admin`); const html = await response.text();
  const match = html.match(/window\.__OPENAI_CC__=(\{[^;]+\});/); if (!match) throw new Error("csrf token missing");
  return { store, models, auth, server, base, csrf: JSON.parse(match[1]).csrfToken as string, html };
}
async function close(server: ReturnType<typeof createServer>) { await new Promise<void>((resolve) => server.close(() => resolve())); }
async function mutate(base: string, csrf: string, pathname: string, body: unknown) { return fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json", "x-openai-cc-csrf": csrf, origin: base }, body: JSON.stringify(body) }); }

test("Admin UI edits context and capabilities per route without inventing model limits", async () => {
  const f = await fixture();
  try {
    assert.match(f.html, /class="claude-mark"/); assert.match(f.html, /<h1>OpenAI-CC<\/h1>/); assert.match(f.html, /<h2>Routes<\/h2>/); assert.match(f.html, /<h2>Credentials<\/h2>/); assert.match(f.html, /<h2>Available models<\/h2>/); assert.match(f.html, /<h2>Custom providers<\/h2>/);
    assert.match(f.html, /id="key-provider"/); assert.match(f.html, /id="key-value" type="password"/); assert.match(f.html, /id="key-name"/); assert.doesNotMatch(f.html, /id="key-id"|id="oauth-name"/); assert.match(f.html, /<select class="route-model"/);
    assert.match(f.html, /for="ctx-'\+slot\+'">Context window/); assert.match(f.html, /class="route-context"/); assert.match(f.html, /contextWindow:Number\(document\.querySelector\('#ctx-'\+slot\)/); assert.doesNotMatch(f.html, /id="context-window"|Single Claude context target for all routes/);
    assert.doesNotMatch(f.html, /API reported:|Discovered context:/);
    assert.match(f.html, /capabilityField\(slot,'vision','Vision'/); assert.match(f.html, /capabilityField\(slot,'tools','Tools'/); assert.match(f.html, /capabilityField\(slot,'reasoning','Reasoning'/); assert.match(f.html, /data-capability=/); assert.match(f.html, /Auto — not reported/); assert.match(f.html, /Supported<\/option>/); assert.match(f.html, /Not supported<\/option>/);
    assert.doesNotMatch(f.html, /Manual model ID/i); assert.doesNotMatch(f.html, /data-manual-model|saveManualModel/); assert.match(f.html, /Models are discovered automatically from credentials/); assert.match(f.html, /id="provider-tier"/); assert.match(f.html, /@media\(max-width:900px\)/); assert.match(f.html, /@media\(max-width:620px\)/);
    assert.doesNotMatch(f.html, /authFile|refresh_token|bearer token/i);
  } finally { await close(f.server); }
});

test("simplified Admin credential creation generates internal IDs and does not require model IDs", async () => {
  const f = await fixture(); try {
    const apiKeyResponse = await mutate(f.base, f.csrf, "/admin/credentials", { provider: "nvidia", name: "Primary NIM", apiKey: "secret-value" });
    assert.equal(apiKeyResponse.status, 201); const credential = await apiKeyResponse.json() as any; assert.match(credential.id, /^nvidia-[a-z0-9]+$/); assert.equal(credential.name, "Primary NIM"); assert.equal(credential.model, undefined); assert.equal(JSON.stringify(credential).includes("secret-value"), false);
    const oauthResponse = await mutate(f.base, f.csrf, "/admin/chatgpt/auth", { loginMode: "device" }); assert.equal(oauthResponse.status, 202); const job = await oauthResponse.json() as AuthJob; assert.match(job.credentialId, /^chatgpt-[a-z0-9]+$/); assert.equal(job.displayName, "ChatGPT account"); await mutate(f.base, f.csrf, `/admin/auth-jobs/${job.jobId}/cancel`, {});
  } finally { await close(f.server); }
});

test("Admin route context is authoritative and Claude-facing names remain clean", async () => {
  const f = await fixture(); try {
    let state = await (await fetch(`${f.base}/admin/state`)).json() as any;
    assert.equal(state.modelConfig.routes.default.model, "gpt-5.6-luna"); assert.equal(state.modelConfig.routes.fable.model, "gpt-5.6-luna");
    for (const slot of ["default","fable","opus","sonnet","haiku"]) assert.equal(state.modelConfig.routes[slot].contextWindow, 1_050_000);
    const next = structuredClone(state.modelConfig); next.routes.sonnet.contextWindow = 360000; next.routes.sonnet.vision = false; next.routes.sonnet.tools = false; next.routes.sonnet.reasoning = false;
    assert.equal((await mutate(f.base, f.csrf, "/admin/model-config", next)).status, 200);
    state = await (await fetch(`${f.base}/admin/state`)).json() as any; assert.equal(state.modelConfig.contextWindow, 1_050_000); assert.equal(state.modelConfig.routes.sonnet.contextWindow, 360000); assert.equal(state.routeHealth.sonnet.contextWindow, 360000);
    const publicModels = await (await fetch(`${f.base}/v1/models`)).json() as any; assert.deepEqual(publicModels.data.map((m:any)=>m.id), ["default","fable","opus","sonnet","haiku"]); const sonnet = publicModels.data.find((m:any)=>m.id==="sonnet"); assert.equal(sonnet.max_input_tokens,360000); assert.equal(sonnet.capabilities.image_input.supported,false); assert.equal(sonnet.capabilities.thinking.supported,false);
    const publicJson=JSON.stringify(publicModels); assert.equal(publicJson.includes("gpt-5.6-luna"),false); assert.equal(publicJson.includes("gemini-3.5-flash-lite"),false); assert.doesNotMatch(publicJson,/\[1m\]|openai-cc-/);
    assert.match(f.html,/Actual upstream configuration/); assert.match(f.html,/r\.model/); assert.match(f.html,/a\.email\|\|a\.name/);
  } finally { await close(f.server); }
});

test("Admin model discovery returns exactly what the configured discoverer reports and preserves errors", async () => {
  const f = await fixture(async (account) => {
    if (account.name === "Discovery Error") throw new OpenAICCError("Provider catalog unavailable.", 502, "discovery_failed");
    return [{ provider: account.provider, upstreamModelId: "provider/test-model", availability: "available" }];
  });
  try {
    const credential = await (await mutate(f.base, f.csrf, "/admin/credentials", { provider: "nvidia", apiKey: "secret" })).json() as any;
    const catalog = await (await fetch(`${f.base}/admin/credentials/${encodeURIComponent(credential.id)}/models`)).json() as any; assert.deepEqual(catalog.models, [{ provider:"nvidia", upstreamModelId:"provider/test-model", availability:"available" }]);
    const badCredential = await (await mutate(f.base, f.csrf, "/admin/credentials", { provider: "google", name: "Discovery Error", apiKey: "secret" })).json() as any;
    const badDiscovery = await fetch(`${f.base}/admin/credentials/${encodeURIComponent(badCredential.id)}/models`); assert.equal(badDiscovery.status,502); assert.equal((await badDiscovery.json() as any).error.code,"discovery_failed");
    assert.match(f.html,/upstreamModelId/); assert.match(f.html,/Capabilities not reported/); assert.match(f.html,/discoveryErrors/);
  } finally { await close(f.server); }
});
