import { ProviderKind } from "./account-store.js";
import { ModelCapabilities, ProviderRegistry } from "./provider-registry.js";

/**
 * OpenAI-compatible /models catalogs usually do not report tool/reasoning
 * capabilities. Keep those two capabilities request-driven for custom providers:
 * Claude sends tools when it has tools, and its thinking/effort setting controls
 * reasoning. Model ids still come only from provider discovery.
 */
export class RequestDrivenProviderRegistry extends ProviderRegistry {
  override capabilities(provider: ProviderKind, model: string): ModelCapabilities {
    const capabilities = super.capabilities(provider, model);
    if (!this.definition(provider).custom) return capabilities;
    return { ...capabilities, tools: true, reasoning: true };
  }

  override requestBodyDefaults(provider: ProviderKind): Record<string, unknown> {
    const defaults = super.requestBodyDefaults(provider);
    if (this.definition(provider).custom) return defaults;
    return { ...defaults, reasoning_effort: undefined };
  }
}
