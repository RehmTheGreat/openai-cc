import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";

test("pinned transport consumes the current official Codex auth.json shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-transport-"));
  const authFile = path.join(root, "auth.json");
  const accessToken = "synthetic-access-token";
  const refreshToken = "synthetic-refresh-token";
  const idToken = "synthetic-id-token";
  const accountId = "acct_transport_test";

  await writeFile(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  }), "utf8");

  let refreshFetchCalled = false;
  const credentials = openaiCredentials({
    authFilePath: authFile,
    fetch: async () => {
      refreshFetchCalled = true;
      throw new Error("fresh synthetic credentials must not attempt a token refresh");
    },
  });
  const session = await credentials.getSession();
  assert.equal(refreshFetchCalled, false);
  assert.equal(session?.accessToken, accessToken);
  assert.equal(session?.refreshToken, refreshToken);
  assert.equal(session?.idToken, idToken);
  assert.equal(session?.accountId, accountId);

  let capturedAuthorization: string | null = null;
  let capturedAccountId: string | null = null;
  const transport = createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      capturedAuthorization = headers.get("authorization");
      capturedAccountId = headers.get("chatgpt-account-id");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await transport.request("/v1/openai-cc-transport-compat", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(capturedAuthorization, `Bearer ${accessToken}`);
  assert.equal(capturedAccountId, accountId);
});

test("openai-oauth owns Codex Responses normalization", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  let capturedHeaders: Headers | undefined;
  const transport = createOpenAIOAuthTransport({
    auth: {
      accessToken: "synthetic-access-token",
      accountId: "acct_transport_test",
    },
    responsesState: false,
    codexVersion: "0.146.0",
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/models?client_version=")) {
        return new Response(JSON.stringify({
          models: [{
            slug: "gpt-5.6-terra",
            visibility: "list",
            supported_in_api: true,
          }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/responses")) {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response("event: response.completed\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const response = await transport.request("/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-terra",
      input: "Say ok",
      max_output_tokens: 128000,
      stream: true,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(capturedHeaders?.get("authorization"), "Bearer synthetic-access-token");
  assert.equal(capturedHeaders?.get("chatgpt-account-id"), "acct_transport_test");
  assert.equal(capturedBody?.model, "gpt-5.6-terra");
  assert.equal(capturedBody?.store, false);
  assert.equal("max_output_tokens" in (capturedBody ?? {}), false);
  assert.ok(Array.isArray(capturedBody?.include));
  assert.ok((capturedBody?.include as string[]).includes("reasoning.encrypted_content"));
});

test("canonical dispatcher keeps Terra on FCC translation plus the raw OAuth boundary", async () => {
  const source = await readFile(path.resolve("src/dispatcher.ts"), "utf8");

  assert.match(source, /anthropicToFccResponses\(routedBody, toolNames\)/);
  assert.match(source, /createChatGptOAuthBoundary\(account\.authFile\)/);
  assert.match(source, /await boundary\.responses\(requestBody\)/);
  assert.doesNotMatch(source, /createOpenAIOAuthTransport/);
  assert.doesNotMatch(source, /openaiCredentials/);
  assert.doesNotMatch(source, /new OpenAI\(\{\s*apiKey:\s*["']openai-oauth["']/s);
  assert.doesNotMatch(source, /CODEX_CLIENT_VERSION|prepareChatGptCodexRequest|originator:\s*["']codex_cli_rs["']/);
});
