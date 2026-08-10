import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
