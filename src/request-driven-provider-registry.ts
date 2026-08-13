import { ProviderKind } from "./account-store.js";
import { KnownModelMetadata, ProviderRegistry, PublicProviderDefinition } from "./provider-registry.js";

/**
 * Custom OpenAI-compatible providers do not expose reliable tool/reasoning
 * capability metadata from /models. Treat those capabilities as request-driven:
 * Claude sends tools when it has tools, and its thinking/effort setting controls
 * reasoning. Manual model metadata remains useful only for context/output limits.
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

  override listPublic(): PublicProviderDefinition[] {
    return super.listPublic().map((provider) => provider.custom ? {
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        tools: true,
        reasoning: true,
      })),
    } : provider);
  }

  override requestBodyDefaults(provider: ProviderKind): Record<string, unknown> {
    const defaults = super.requestBodyDefaults(provider);
    if (this.definition(provider).custom) return defaults;
    return { ...defaults, reasoning_effort: undefined };
  }
}
