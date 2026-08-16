import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatGptUpstreamError,
  chatGptRateLimitReset,
  requireSuccessfulChatGptResponse,
} from "../src/chatgpt-oauth.js";

async function upstream429(headers: Record<string, string>): Promise<ChatGptUpstreamError> {
  const request = { model: "gpt-test", stream: false, input: "ping" };
  try {
    await requireSuccessfulChatGptResponse(new Response(JSON.stringify({ error: { message: "usage limit reached" } }), {
      status: 429,
      headers,
    }), request);
  } catch (error) {
    assert.ok(error instanceof ChatGptUpstreamError);
    return error;
  }
  throw new Error("expected 429 error");
}

test("Codex 429 uses the later reset when both primary and secondary windows are exhausted", async () => {
  const now = Date.UTC(2026, 7, 16, 9, 0, 0);
  const primaryReset = Math.floor((now + 5 * 60 * 60 * 1000) / 1000);
  const secondaryReset = Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000);
  const error = await upstream429({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(primaryReset),
    "x-codex-secondary-used-percent": "100",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(secondaryReset),
  });
  const reset = chatGptRateLimitReset(error, now);
  assert.equal(reset?.window, "both");
  assert.equal(reset?.resetAt, new Date(secondaryReset * 1000).toISOString());
  assert.equal(reset?.cooldownMs, secondaryReset * 1000 - now);
});

test("Codex 429 honors the reached-type header when it identifies the primary window", async () => {
  const now = Date.UTC(2026, 7, 16, 9, 0, 0);
  const primaryReset = Math.floor((now + 90 * 60 * 1000) / 1000);
  const secondaryReset = Math.floor((now + 5 * 24 * 60 * 60 * 1000) / 1000);
  const error = await upstream429({
    "x-codex-rate-limit-reached-type": "primary",
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-at": String(primaryReset),
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-reset-at": String(secondaryReset),
  });
  const reset = chatGptRateLimitReset(error, now);
  assert.equal(reset?.window, "primary");
  assert.equal(reset?.resetAt, new Date(primaryReset * 1000).toISOString());
});

test("Codex 429 with no reset metadata stays unknown instead of inventing a cooldown", async () => {
  const error = await upstream429({});
  assert.equal(chatGptRateLimitReset(error, Date.UTC(2026, 7, 16)), undefined);
});
