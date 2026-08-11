import assert from "node:assert/strict";
import test from "node:test";
import { upstreamApiFor } from "../src/upstream-api.js";

test("ChatGPT/Codex always uses Responses", () => {
  assert.equal(upstreamApiFor("chatgpt", "gpt-5.6-terra"), "responses");
});

test("OpenCode Zen GPT models use Responses", () => {
  assert.equal(upstreamApiFor("zen", "gpt-5.6-terra"), "responses");
  assert.equal(upstreamApiFor("zen", "gpt-5.6-sol"), "responses");
});

test("OpenCode Zen DeepSeek and other compatible models use Chat Completions", () => {
  assert.equal(upstreamApiFor("zen", "deepseek-v4-flash-free"), "chat-completions");
  assert.equal(upstreamApiFor("zen", "deepseek-v4-flash"), "chat-completions");
  assert.equal(upstreamApiFor("zen", "glm-5.2"), "chat-completions");
  assert.equal(upstreamApiFor("zen", "kimi-k2.5"), "chat-completions");
});

test("Google and NVIDIA remain on Chat Completions", () => {
  assert.equal(upstreamApiFor("google", "gemini-3.6-flash"), "chat-completions");
  assert.equal(upstreamApiFor("nvidia", "moonshotai/kimi-k2.5"), "chat-completions");
});
