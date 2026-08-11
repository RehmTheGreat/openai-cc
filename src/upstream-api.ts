import { ProviderKind } from "./account-store.js";
import { ProviderRegistry } from "./provider-registry.js";
export type UpstreamApi = "responses" | "chat-completions";
export function upstreamApiFor(provider: ProviderKind, model: string, registry?: ProviderRegistry): UpstreamApi {
  if (registry) return registry.apiFor(provider, model);
  if (provider === "chatgpt") return "responses";
  if (provider === "zen" && /^gpt-/i.test(String(model).trim())) return "responses";
  return "chat-completions";
}
