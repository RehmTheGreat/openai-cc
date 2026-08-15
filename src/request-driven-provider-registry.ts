import { ProviderKind } from "./account-store.js";
import { KnownModelMetadata, ProviderRegistry } from "./provider-registry.js";

/**
 * OpenAI-compatible /models catalogs usually do not report tool/reasoning
 * capabilities. Keep those two capabilities request-driven for custom providers:
 * Claude sends tools when it has tools, and its thinking/effort setting controls
 * reasoning. The Admin route editor can explicitly override either capability.
 * Model ids themselves always come from provider API discovery; there is no
 * manual custom-model catalog.
 */
export class RequestDrivenProviderRegistry extends ProviderRegistry {
  override metadata(provider: ProviderKind, model: string): KnownModelMetadata | undefined {
    const metadata = super.metadata(provider, model);
    if (!metadata || !this.definition(provider).custom) return metadata;
    return {
      ...metadata,
      capabilities: {
        ...metadata.capabilities,
        tools: true,
        reasoning: true,
      },
    };
  }

  override requestBodyDefaults(provider: ProviderKind): Record<string, unknown> {
    const defaults = super.requestBodyDefaults(provider);
    if (this.definition(provider).custom) return defaults;
    return { ...defaults, reasoning_effort: undefined };
  }
}
