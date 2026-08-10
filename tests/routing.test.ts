import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { createServer } from "../src/dispatcher.js";
import { ModelConfigStore } from "../src/model-config.js";

async function routeFixture(clientFactory: (id: string) => any) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-route-"));
  const accounts = new AccountStore(root); await accounts.init();
  await accounts.createApiKey({ id: "n1", name: "N1", provider: "nvidia", apiKey: "one", model: "unused" });
  await accounts.createApiKey({ id: "n2", name: "N2", provider: "nvidia", apiKey: "two", model: "unused" });
  const models = new ModelConfigStore(root, accounts); await models.init();
  const config = models.snapshot(); config.routes.sonnet = { provider: "nvidia", model: "nim-model", maxOutputTokens: 64000 };
  await models.update(config);
  const server = createServer(accounts, models, { bindHost: "127.0.0.1", clientFactory: (account) => clientFactory(account.id) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");
  return { accounts, models, server, base: `http://127.0.0.1:${address.port}` };
}

function requestBody(stream = false) {
  return { model: "claude-sonnet-5", max_tokens: 32, stream, messages: [{ role: "user", content: "hello" }] };
}

test("pre-output 429 transparently retries the next same-provider credential", async () => {
  const calls: string[] = [];
  const f = await routeFixture((id) => ({ chat: { completions: { create: async () => {
    calls.push(id);
    if (id === "n1") throw Object.assign(new Error("429 rate limit"), { status: 429 });
    return { id: "ok", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } } } }));
  try {
    const response = await fetch(`${f.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(false)) });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["n1", "n2"]);
    assert.equal(f.accounts.publicGet("n1")?.status, "exhausted");
    assert.equal((await response.json() as any).content[0].text, "done");
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("stream 429 before first upstream chunk retries the next credential", async () => {
  const calls: string[] = [];
  const f = await routeFixture((id) => ({ chat: { completions: { create: async ({ stream }: any) => {
    calls.push(id);
    if (!stream) throw new Error("expected stream");
    if (id === "n1") return (async function*(){ throw Object.assign(new Error("429 before output"), { status: 429 }); })();
    return (async function*(){
      yield { id: "two", choices: [{ delta: { content: "fallback" } }] };
      yield { id: "two", choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 1 } };
    })();
  } } } }));
  try {
    const response = await fetch(`${f.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(true)) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /fallback/);
    assert.deepEqual(calls, ["n1", "n2"]);
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

test("stream 429 after output does not replay partial response and next request uses fallback", async () => {
  const calls: string[] = [];
  const f = await routeFixture((id) => ({ chat: { completions: { create: async ({ stream }: any) => {
    calls.push(id);
    if (!stream) throw new Error("expected stream");
    if (id === "n1") return (async function*(){
      yield { id: "one", choices: [{ delta: { content: "partial" } }] };
      throw Object.assign(new Error("429 after output"), { status: 429 });
    })();
    return (async function*(){
      yield { id: "two", choices: [{ delta: { content: "fallback" } }] };
      yield { id: "two", choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 1 } };
    })();
  } } } }));
  try {
    let response = await fetch(`${f.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(true)) });
    let text = await response.text();
    assert.match(text, /partial/);
    assert.match(text, /no partial response was replayed/i);
    assert.deepEqual(calls, ["n1"]);
    assert.equal(f.accounts.publicGet("n1")?.status, "exhausted");

    calls.length = 0;
    response = await fetch(`${f.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(true)) });
    text = await response.text();
    assert.match(text, /fallback/);
    assert.deepEqual(calls, ["n2"]);
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});
