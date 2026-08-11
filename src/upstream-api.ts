import { ProviderKind } from "./account-store.js";

export type UpstreamApi = "responses" | "chat-completions";

/**
 * Pick the wire API required by the configured upstream model.
 *
 * ChatGPT/Codex always uses Responses. OpenCode Zen exposes its GPT family on
 * /responses, while DeepSeek/GLM/Kimi/MiniMax/Grok and other OpenAI-compatible
 * models are exposed on /chat/completions. Provider-only routing is therefore
 * insufficient for Zen.
 */
export function upstreamApiFor(provider: ProviderKind, model: string): UpstreamApi {
  if (provider === "chatgpt") return "responses";
  if (provider === "zen" && /^gpt-/i.test(String(model).trim())) return "responses";
  return "chat-completions";
}
