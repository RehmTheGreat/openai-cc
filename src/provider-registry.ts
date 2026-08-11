import { AccountRecord, ProviderKind } from "./account-store.js";
import { createChatGptOAuthBoundary } from "./chatgpt-oauth.js";
import { OpenAICCError } from "./errors.js";

export type ProviderApiStyle = "responses" | "chat-completions" | "mixed";

export interface ModelCapabilities {
  text: boolean;
  image: boolean;
  tools: boolean;
  streaming: boolean;
  reasoning: boolean;
}

export interface KnownModelMetadata {
  friendlyName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
}

export interface DiscoveredModel {
  provider: ProviderKind;
  friendlyName?: string;
  upstreamModelId: string;
  availability: "available";
  capabilities?: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderDefinition {
  id: ProviderKind;
  displayName: string;
  apiStyle: ProviderApiStyle;
  requiresAccountId: boolean;
  baseUrl(account: Pick<AccountRecord, "accountId">): string | undefined;
  discovery: "codex" | "openai-models" | "cloudflare-models";
}

const CHATGPT_CAPABILITIES: ModelCapabilities = {
  text: true,
  image: true,
  tools: true,
  streaming: true,
  reasoning: true,
};

const CLOUDFLARE_GEMMA_CAPABILITIES: ModelCapabilities = {
  text: true,
  image: true,
  tools: true,
  streaming: true,
  reasoning: true,
};

const PROVIDERS: Record<ProviderKind, ProviderDefinition> = {
  chatgpt: {
    id: "chatgpt",
    displayName: "ChatGPT OAuth",
    apiStyle: "responses",
    requiresAccountId: false,
    baseUrl: () => undefined,
    discovery: "codex",
  },
  zen: {
    id: "zen",
    displayName: "OpenCode Zen",
    apiStyle: "mixed",
    requiresAccountId: false,
    baseUrl: () => "https://opencode.ai/zen/v1",
    discovery: "openai-models",
  },
  nvidia: {
    id: "nvidia",
    displayName: "NVIDIA NIM",
    apiStyle: "chat-completions",
    requiresAccountId: false,
    baseUrl: () => "https://integrate.api.nvidia.com/v1",
    discovery: "openai-models",
  },
  google: {
    id: "google",
    displayName: "Google AI Studio",
    apiStyle: "chat-completions",
    requiresAccountId: false,
    baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai/",
    discovery: "openai-models",
  },
  cloudflare: {
    id: "cloudflare",
    displayName: "Cloudflare Workers AI",
    apiStyle: "chat-completions",
    requiresAccountId: true,
    baseUrl: (account) => account.accountId
      ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}/ai/v1`
      : undefined,
    discovery: "cloudflare-models",
  },
};

const KNOWN_MODELS = new Map<string, KnownModelMetadata>([
  [modelKey("chatgpt", "gpt-5.6-terra"), {
    friendlyName: "GPT-5.6 Terra",
    contextWindow: 1_050_000,
    capabilities: CHATGPT_CAPABILITIES,
  }],
  [modelKey("zen", "deepseek-v4-flash-free"), {
    friendlyName: "DeepSeek V4 Flash Free",
    contextWindow: 200_000,
    capabilities: { text: true, image: false, tools: true, streaming: true, reasoning: true },
  }],
  [modelKey("google", "gemini-3.6-flash"), {
    friendlyName: "Gemini 3.6 Flash",
    contextWindow: 1_048_576,
    capabilities: { text: true, image: true, tools: true, streaming: true, reasoning: false },
  }],
  [modelKey("cloudflare", "@cf/google/gemma-4-26b-a4b-it"), {
    friendlyName: "Gemma 4 26B A4B IT",
    // Operational cap: Cloudflare advertises a larger context for this model,
    // but OpenAI-CC stays at 131,072 until an authenticated deployment probe
    // proves the hosted endpoint reliably accepts more.
    contextWindow: 131_072,
    // This is an OpenAI-CC safety cap, not a claim about an upstream hard max.
    maxOutputTokens: 16_384,
    capabilities: CLOUDFLARE_GEMMA_CAPABILITIES,
  }],
]);

export function providerDefinition(provider: ProviderKind): ProviderDefinition {
  return PROVIDERS[provider];
}

export function providerDisplayName(provider: ProviderKind): string {
  return providerDefinition(provider).displayName;
}

export function providerBaseUrl(account: Pick<AccountRecord, "provider" | "accountId">): string {
  const definition = providerDefinition(account.provider);
  const baseUrl = definition.baseUrl(account);
  if (!baseUrl) {
    if (definition.requiresAccountId) {
      throw new OpenAICCError(`${definition.displayName} credential is missing its Account ID.`, 409, "missing_account_id");
    }
    throw new OpenAICCError(`${definition.displayName} does not use an API-key base URL.`, 409, "provider_base_url_unavailable");
  }
  return baseUrl;
}

export function knownModelMetadata(provider: ProviderKind, model: string): KnownModelMetadata | undefined {
  const metadata = KNOWN_MODELS.get(modelKey(provider, model));
  return metadata ? { ...metadata, capabilities: { ...metadata.capabilities } } : undefined;
}

export function verifiedModelContextWindow(provider: ProviderKind, model: string): number | undefined {
  return knownModelMetadata(provider, model)?.contextWindow;
}

export function modelCapabilities(provider: ProviderKind, model: string): ModelCapabilities {
  const known = knownModelMetadata(provider, model)?.capabilities;
  if (known) return known;
  // Preserve the existing conservative Claude-facing behavior for unknown
  // routes. Discovery responses omit capability metadata unless it is known.
  if (provider === "chatgpt") return { ...CHATGPT_CAPABILITIES };
  if (provider === "google") return { text: true, image: true, tools: true, streaming: true, reasoning: false };
  if (provider === "zen") return { text: true, image: false, tools: true, streaming: true, reasoning: true };
  return { text: true, image: false, tools: true, streaming: true, reasoning: false };
}

export async function discoverModelsForCredential(
  account: AccountRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  if (account.provider === "chatgpt") {
    if (!account.authFile) throw new OpenAICCError(`ChatGPT credential ${account.id} has no auth file.`, 409, "missing_auth_file");
    const ids = await createChatGptOAuthBoundary(account.authFile).listModels();
    return normalizeDiscovered(account.provider, ids);
  }

  if (!account.apiKey) throw new OpenAICCError(`${providerDisplayName(account.provider)} credential ${account.id} has no API key.`, 409, "missing_api_key");
  const definition = providerDefinition(account.provider);
  const url = definition.discovery === "cloudflare-models"
    ? cloudflareDiscoveryUrl(account)
    : `${providerBaseUrl(account).replace(/\/+$/, "")}/models`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = Object.assign(new Error(safeDiscoveryError(text, response.status)), {
      status: response.status,
      statusCode: response.status,
    });
    throw error;
  }

  let body: unknown;
  try { body = JSON.parse(text); }
  catch { throw new OpenAICCError(`${definition.displayName} returned invalid model discovery JSON.`, 502, "invalid_model_discovery"); }
  const ids = definition.discovery === "cloudflare-models"
    ? cloudflareModelIds(body)
    : openAiModelIds(body);
  return normalizeDiscovered(account.provider, ids);
}

function normalizeDiscovered(provider: ProviderKind, ids: string[]): DiscoveredModel[] {
  return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))].map((upstreamModelId) => {
    const known = knownModelMetadata(provider, upstreamModelId);
    return {
      provider,
      upstreamModelId,
      availability: "available" as const,
      ...(known?.friendlyName ? { friendlyName: known.friendlyName } : {}),
      ...(known?.capabilities ? { capabilities: known.capabilities } : {}),
      ...(known?.contextWindow !== undefined ? { contextWindow: known.contextWindow } : {}),
      ...(known?.maxOutputTokens !== undefined ? { maxOutputTokens: known.maxOutputTokens } : {}),
    };
  });
}

function cloudflareDiscoveryUrl(account: AccountRecord): string {
  if (!account.accountId) {
    throw new OpenAICCError("Cloudflare Workers AI credential is missing its Account ID.", 409, "missing_account_id");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}/ai/models/search`;
}

function openAiModelIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new OpenAICCError("Provider returned a malformed OpenAI-compatible models response.", 502, "invalid_model_discovery");
  }
  return body.data.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []);
}

function cloudflareModelIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.result)) {
    throw new OpenAICCError("Cloudflare returned a malformed Workers AI model catalog.", 502, "invalid_model_discovery");
  }
  return body.result.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    for (const key of ["name", "id", "model", "model_id"]) {
      if (typeof item[key] === "string" && item[key].trim()) return [item[key]];
    }
    return [];
  });
}

function safeDiscoveryError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const direct = typeof parsed.message === "string" ? parsed.message : undefined;
      if (direct) return redact(direct);
      if (Array.isArray(parsed.errors)) {
        const first = parsed.errors.find((item) => isRecord(item) && typeof item.message === "string") as Record<string, unknown> | undefined;
        if (first && typeof first.message === "string") return redact(first.message);
      }
      if (isRecord(parsed.error) && typeof parsed.error.message === "string") return redact(parsed.error.message);
    }
  } catch { /* omit arbitrary bodies */ }
  return `Provider model discovery failed with HTTP ${status}.`;
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .slice(0, 800);
}

function modelKey(provider: ProviderKind, model: string): string {
  return `${provider}:${String(model || "").trim().toLowerCase()}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
