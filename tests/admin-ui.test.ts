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
      safeMessage: "Authentication started.",
    };
    this.jobs.set(job.jobId, job);
    this.emit("job", { ...job });
    return { ...job };
  }

  status(id: string): AuthJob {
    const job = this.jobs.get(id);
    if (!job) throw new OpenAICCError("Authentication job not found.", 404, "auth_job_not_found");
    return { ...job };
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new OpenAICCError("Authentication job not found.", 404, "auth_job_not_found");
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    this.emit("job", { ...job });
  }

  activeJobs(): AuthJob[] {
    return [...this.jobs.values()]
      .filter((job) => !["complete", "error", "cancelled"].includes(job.status))
      .map((job) => ({ ...job }));
  }

  async shutdown(): Promise<void> {}
}

async function fixture(modelDiscoverer?: (account: any) => Promise<DiscoveredModel[]>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-admin-ui-"));
  const store = new AccountStore(root);
  await store.init();
  const models = new ModelConfigStore(root, store);
  await models.init();
  const auth = new UiAuthRunner();
  const server = createServer(store, models, {
    authRunner: auth,
    bindHost: "127.0.0.1",
    ...(modelDiscoverer ? { modelDiscoverer } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/admin`);
  const html = await response.text();
  const match = html.match(/window\.__OPENAI_CC__=(\{[^;]+\});/);
  if (!match) throw new Error("csrf token missing");
  const csrf = JSON.parse(match[1]).csrfToken as string;
  return { store, models, auth, server, base, csrf, html };
}

async function close(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function mutate(base: string, csrf: string, pathname: string, body: unknown) {
  return fetch(base + pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openai-cc-csrf": csrf,
      origin: base,
    },
    body: JSON.stringify(body),
  });
}

test("Admin UI is lean, responsive, and does not expose manual credential/model ID fields", async () => {
  const f = await fixture();
  try {
    assert.match(f.html, /class="claude-mark"/);
    assert.match(f.html, /<h1>OpenAI-CC<\/h1>/);
    assert.match(f.html, /<h2>Routes<\/h2>/);
    assert.match(f.html, /<h2>Credentials<\/h2>/);
    assert.match(f.html, /<h2>Available models<\/h2>/);
    assert.match(f.html, /<h2>Custom providers<\/h2>/);

    assert.match(f.html, /id="key-provider"/);
    assert.match(f.html, /id="key-value" type="password"/);
    assert.match(f.html, /id="key-name"/);
    assert.doesNotMatch(f.html, /id="key-id"/);
    assert.doesNotMatch(f.html, /id="oauth-name"/);
    assert.doesNotMatch(f.html, /<input[^>]+id="m-/);
    assert.match(f.html, /<select class="route-model"/);

    assert.match(f.html, /Context: <strong>/);
    assert.match(f.html, /Vision: <strong>/);
    assert.match(f.html, /Tools: <strong>/);
    assert.match(f.html, /@media\(max-width:900px\)/);
    assert.match(f.html, /@media\(max-width:620px\)/);

    assert.doesNotMatch(f.html, /authFile/);
    assert.doesNotMatch(f.html, /refresh_token/);
    assert.doesNotMatch(f.html, /bearer token/i);
  } finally {
    await close(f.server);
  }
});

test("simplified Admin credential creation generates internal IDs and does not require model IDs", async () => {
  const f = await fixture();
  try {
    const apiKeyResponse = await mutate(f.base, f.csrf, "/admin/credentials", {
      provider: "nvidia",
      name: "Primary NIM",
      apiKey: "secret-value",
    });
    assert.equal(apiKeyResponse.status, 201);
    const credential = await apiKeyResponse.json() as any;
    assert.match(credential.id, /^nvidia-[a-z0-9]+$/);
    assert.equal(credential.name, "Primary NIM");
    assert.equal(credential.model, undefined);
    assert.equal(JSON.stringify(credential).includes("secret-value"), false);

    const oauthResponse = await mutate(f.base, f.csrf, "/admin/chatgpt/auth", { loginMode: "device" });
    assert.equal(oauthResponse.status, 202);
    const job = await oauthResponse.json() as AuthJob;
    assert.match(job.credentialId, /^chatgpt-[a-z0-9]+$/);
    assert.equal(job.displayName, "ChatGPT account");
    await mutate(f.base, f.csrf, `/admin/auth-jobs/${job.jobId}/cancel`, {});
  } finally {
    await close(f.server);
  }
});

test("Admin exposes technical upstream routing while Claude-facing names remain clean", async () => {
  const f = await fixture();
  try {
    const stateResponse = await fetch(`${f.base}/admin/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as any;
    assert.equal(state.modelConfig.routes.fable.provider, "chatgpt");
    assert.equal(state.modelConfig.routes.fable.model, "gpt-5.6-terra");
    assert.equal(state.modelConfig.routes.sonnet.provider, "google");
    assert.equal(state.modelConfig.routes.sonnet.model, "gemini-3.5-flash-lite");
    assert.equal(typeof state.routeHealth.fable.contextWindow, "number");

    const publicModels = await (await fetch(`${f.base}/v1/models`)).json() as any;
    assert.deepEqual(publicModels.data.map((model: any) => model.display_name), ["Default", "Fable", "Opus", "Sonnet", "Haiku"]);
    const publicJson = JSON.stringify(publicModels);
    assert.equal(publicJson.includes("gpt-5.6-terra"), false);
    assert.equal(publicJson.includes("gemini-3.5-flash-lite"), false);

    assert.match(f.html, /Actual upstream configuration/);
    assert.match(f.html, /r\.model/);
    assert.match(f.html, /a\.email\|\|a\.name/);
  } finally {
    await close(f.server);
  }
});

test("Admin model discovery preserves provider-reported IDs, limits, capabilities, and errors", async () => {
  const f = await fixture(async (account) => {
    if (account.name === "Discovery Error") throw new OpenAICCError("Provider catalog unavailable.", 502, "discovery_failed");
    return [{
      provider: account.provider,
      friendlyName: "Discovered Test Model",
      upstreamModelId: "provider/test-model",
      availability: "available",
      capabilities: { text: true, image: true, tools: true, streaming: true, reasoning: false },
      contextWindow: 321000,
      maxOutputTokens: 8192,
    }];
  });
  try {
    const added = await mutate(f.base, f.csrf, "/admin/credentials", { provider: "nvidia", apiKey: "secret" });
    const credential = await added.json() as any;
    const discoveredResponse = await fetch(`${f.base}/admin/credentials/${encodeURIComponent(credential.id)}/models`);
    assert.equal(discoveredResponse.status, 200);
    const catalog = await discoveredResponse.json() as any;
    assert.equal(catalog.models[0].upstreamModelId, "provider/test-model");
    assert.equal(catalog.models[0].contextWindow, 321000);
    assert.equal(catalog.models[0].maxOutputTokens, 8192);
    assert.equal(catalog.models[0].capabilities.image, true);
    assert.equal(catalog.models[0].capabilities.tools, true);

    const bad = await mutate(f.base, f.csrf, "/admin/credentials", { provider: "google", name: "Discovery Error", apiKey: "secret" });
    const badCredential = await bad.json() as any;
    const badDiscovery = await fetch(`${f.base}/admin/credentials/${encodeURIComponent(badCredential.id)}/models`);
    assert.equal(badDiscovery.status, 502);
    assert.equal((await badDiscovery.json() as any).error.code, "discovery_failed");

    assert.match(f.html, /friendlyName/);
    assert.match(f.html, /upstreamModelId/);
    assert.match(f.html, /Capabilities not reported/);
    assert.match(f.html, /discoveryErrors/);
  } finally {
    await close(f.server);
  }
});
