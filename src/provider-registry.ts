import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountRecord, CustomProviderKind, ProviderKind } from "./account-store.js";
import { OpenAICCError, conflict, notFound } from "./errors.js";

export type ProviderApiStyle = "responses" | "chat-completions" | "mixed";
export type CustomProviderApiStyle = Exclude<ProviderApiStyle, "mixed">;

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
export interface ManualModelDefinition {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}
export interface CustomProviderRecord {
  id: CustomProviderKind;
  displayName: string;
  baseUrl: string;
  apiStyle: CustomProviderApiStyle;
  models: ManualModelDefinition[];
  createdAt: string;
  updatedAt: string;
}
export interface PublicProviderDefinition {
  id: ProviderKind;
  displayName: string;
  apiStyle: ProviderApiStyle;
  credentialType: "oauth" | "api-key";
  custom: boolean;
  requiresAccountId: boolean;
  supportsModelDiscovery: boolean;
  models: ManualModelDefinition[];
  baseUrl?: string;
}
export interface ProviderDefinition {
  id: ProviderKind;
  displayName: string;
  apiStyle: ProviderApiStyle;
  credentialType: "oauth" | "api-key";
  requiresAccountId: boolean;
  discovery: "codex" | "openai-models" | "cloudflare-models";
  custom: boolean;
  baseUrl(account: Pick<AccountRecord, "accountId">): string | undefined;
}

const CHATGPT_CAPABILITIES: ModelCapabilities = { text: true, image: true, tools: true, streaming: true, reasoning: true };
const GEMINI_CAPABILITIES: ModelCapabilities = { text: true, image: true, tools: true, streaming: true, reasoning: true };
const CLOUDFLARE_GEMMA_CAPABILITIES: ModelCapabilities = { text: true, image: true, tools: true, streaming: true, reasoning: true };
const CUSTOM_CAPABILITIES: ModelCapabilities = { text: true, image: false, tools: false, streaming: true, reasoning: false };
export const CONSERVATIVE_CUSTOM_CONTEXT_WINDOW = 200_000;
export const CONSERVATIVE_CUSTOM_MAX_OUTPUT_TOKENS = 16_384;
export const GEMINI_FLASH_LITE_MODEL = "gemini-3.5-flash-lite";

const BUILT_INS: Record<string, ProviderDefinition> = {
  chatgpt: { id: "chatgpt", displayName: "ChatGPT OAuth", apiStyle: "responses", credentialType: "oauth", requiresAccountId: false, discovery: "codex", custom: false, baseUrl: () => undefined },
  zen: { id: "zen", displayName: "OpenCode Zen", apiStyle: "mixed", credentialType: "api-key", requiresAccountId: false, discovery: "openai-models", custom: false, baseUrl: () => "https://opencode.ai/zen/v1" },
  nvidia: { id: "nvidia", displayName: "NVIDIA NIM", apiStyle: "chat-completions", credentialType: "api-key", requiresAccountId: false, discovery: "openai-models", custom: false, baseUrl: () => "https://integrate.api.nvidia.com/v1" },
  google: { id: "google", displayName: "Google AI Studio", apiStyle: "chat-completions", credentialType: "api-key", requiresAccountId: false, discovery: "openai-models", custom: false, baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai/" },
  cloudflare: { id: "cloudflare", displayName: "Cloudflare Workers AI", apiStyle: "chat-completions", credentialType: "api-key", requiresAccountId: true, discovery: "cloudflare-models", custom: false, baseUrl: (account) => account.accountId ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}/ai/v1` : undefined },
};

const KNOWN_MODELS = new Map<string, KnownModelMetadata>([
  [modelKey("chatgpt", "gpt-5.6-terra"), { friendlyName: "GPT-5.6 Terra", contextWindow: 1_050_000, capabilities: CHATGPT_CAPABILITIES }],
  [modelKey("zen", "deepseek-v4-flash-free"), { friendlyName: "DeepSeek V4 Flash Free", contextWindow: 200_000, capabilities: { text: true, image: false, tools: true, streaming: true, reasoning: true } }],
  [modelKey("google", GEMINI_FLASH_LITE_MODEL), { friendlyName: "Gemini 3.5 Flash-Lite", contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: GEMINI_CAPABILITIES }],
  // Retain metadata for existing user-selected routes. Upgrades do not rewrite them.
  [modelKey("google", "gemini-3.6-flash"), { friendlyName: "Gemini 3.6 Flash", contextWindow: 1_048_576, capabilities: { text: true, image: true, tools: true, streaming: true, reasoning: false } }],
  [modelKey("cloudflare", "@cf/google/gemma-4-26b-a4b-it"), { friendlyName: "Gemma 4 26B A4B IT", contextWindow: 200_000, maxOutputTokens: 16_384, capabilities: CLOUDFLARE_GEMMA_CAPABILITIES }],
]);

interface ProviderStoreFile { version: 1; providers: CustomProviderRecord[]; }

export class ProviderRegistry extends EventEmitter {
  private readonly file?: string;
  private customProviders: CustomProviderRecord[] = [];
  constructor(dataDir?: string) { super(); this.file = dataDir ? path.join(path.resolve(dataDir), "providers.json") : undefined; }
  async init(): Promise<void> {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<ProviderStoreFile>;
      const providers = Array.isArray(parsed.providers) ? parsed.providers.map(normalizeStoredProvider) : [];
      this.customProviders = providers;
      if (parsed.version !== 1) await this.persist();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.customProviders = [];
      await this.persist();
    }
  }
  has(provider: string): provider is ProviderKind { return Boolean(BUILT_INS[provider]) || this.customProviders.some((item) => item.id === provider); }
  isApiKeyProvider(provider: string): provider is ProviderKind { return this.has(provider) && provider !== "chatgpt"; }
  listPublic(): PublicProviderDefinition[] {
    const built = Object.values(BUILT_INS).map((definition) => ({
      id: definition.id, displayName: definition.displayName, apiStyle: definition.apiStyle,
      credentialType: definition.credentialType, custom: false, requiresAccountId: definition.requiresAccountId,
      supportsModelDiscovery: true, models: [] as ManualModelDefinition[],
    }));
    const custom = this.customProviders.map((record) => ({
      id: record.id, displayName: record.displayName, apiStyle: record.apiStyle, credentialType: "api-key" as const,
      custom: true, requiresAccountId: false, supportsModelDiscovery: true, models: record.models.map((model) => ({ ...model })), baseUrl: record.baseUrl,
    }));
    return [...built, ...custom];
  }
  getCustom(id: string): CustomProviderRecord | undefined { const value=this.customProviders.find((item)=>item.id===id); return value ? structuredClone(value) : undefined; }
  async createCustom(input: { displayName?: string; baseUrl?: string; apiStyle?: string }): Promise<CustomProviderRecord> {
    const now=new Date().toISOString();
    const record: CustomProviderRecord = { id: this.generateId(), displayName: cleanDisplayName(input.displayName), baseUrl: cleanBaseUrl(input.baseUrl), apiStyle: cleanApiStyle(input.apiStyle), models: [], createdAt: now, updatedAt: now };
    this.customProviders.push(record); await this.persist(); this.emit("event", { type: "providers_changed", provider: this.publicFor(record) }); return structuredClone(record);
  }
  async updateCustom(id: string, input: { displayName?: string; baseUrl?: string; apiStyle?: string }): Promise<CustomProviderRecord> {
    const record=this.requireCustom(id); const before=structuredClone(record);
    try {
      if (input.displayName !== undefined) record.displayName=cleanDisplayName(input.displayName);
      if (input.baseUrl !== undefined) record.baseUrl=cleanBaseUrl(input.baseUrl);
      if (input.apiStyle !== undefined) record.apiStyle=cleanApiStyle(input.apiStyle);
      record.updatedAt=new Date().toISOString(); await this.persist();
    } catch (error) { Object.assign(record,before); throw error; }
    this.emit("event", { type: "providers_changed", provider: this.publicFor(record) }); return structuredClone(record);
  }
  async deleteCustom(id: string): Promise<void> {
    const index=this.customProviders.findIndex((item)=>item.id===id); if(index<0) throw notFound(`Unknown custom provider: ${id}`,"provider_not_found");
    this.customProviders.splice(index,1); await this.persist(); this.emit("event", { type:"providers_changed", providerId:id });
  }
  async upsertManualModel(id: string, input: { id?: string; contextWindow?: unknown; maxOutputTokens?: unknown }): Promise<ManualModelDefinition> {
    const provider=this.requireCustom(id); const modelId=cleanModelId(input.id);
    const contextWindow=optionalInteger(input.contextWindow,"contextWindow",1,10_000_000);
    const maxOutputTokens=optionalInteger(input.maxOutputTokens,"maxOutputTokens",1,1_000_000);
    const next: ManualModelDefinition = { id:modelId, ...(contextWindow?{contextWindow}:{}), ...(maxOutputTokens?{maxOutputTokens}:{}) };
    const index=provider.models.findIndex((model)=>model.id===modelId); if(index>=0) provider.models[index]=next; else provider.models.push(next);
    provider.updatedAt=new Date().toISOString(); await this.persist(); this.emit("event",{type:"providers_changed",provider:this.publicFor(provider)}); return {...next};
  }
  async deleteManualModel(id: string, modelId: string): Promise<void> {
    const provider=this.requireCustom(id); const index=provider.models.findIndex((model)=>model.id===modelId); if(index<0) throw notFound(`Unknown manual model: ${modelId}`,"manual_model_not_found");
    provider.models.splice(index,1); provider.updatedAt=new Date().toISOString(); await this.persist(); this.emit("event",{type:"providers_changed",provider:this.publicFor(provider)});
  }
  definition(provider: ProviderKind): ProviderDefinition {
    const built=BUILT_INS[provider]; if(built) return built;
    const custom=this.customProviders.find((item)=>item.id===provider); if(!custom) throw new OpenAICCError(`Unsupported provider: ${provider}`,400,"invalid_provider");
    return { id:custom.id, displayName:custom.displayName, apiStyle:custom.apiStyle, credentialType:"api-key", requiresAccountId:false, discovery:"openai-models", custom:true, baseUrl:()=>custom.baseUrl };
  }
  displayName(provider: ProviderKind): string { return this.definition(provider).displayName; }
  baseUrl(account: Pick<AccountRecord,"provider"|"accountId">): string {
    const definition=this.definition(account.provider); const value=definition.baseUrl(account);
    if(!value){ if(definition.requiresAccountId) throw new OpenAICCError(`${definition.displayName} credential is missing its Account ID.`,409,"missing_account_id"); throw new OpenAICCError(`${definition.displayName} does not use an API-key base URL.`,409,"provider_base_url_unavailable"); }
    return value;
  }
  metadata(provider: ProviderKind, model: string): KnownModelMetadata | undefined {
    const known=KNOWN_MODELS.get(modelKey(provider,model)); if(known) return cloneMetadata(known);
    const custom=this.customProviders.find((item)=>item.id===provider); if(!custom) return undefined;
    const manual=custom.models.find((item)=>item.id===model);
    return { friendlyName:model, contextWindow:manual?.contextWindow ?? CONSERVATIVE_CUSTOM_CONTEXT_WINDOW, maxOutputTokens:manual?.maxOutputTokens ?? CONSERVATIVE_CUSTOM_MAX_OUTPUT_TOKENS, capabilities:{...CUSTOM_CAPABILITIES} };
  }
  contextWindow(provider: ProviderKind, model: string): number | undefined { return this.metadata(provider,model)?.contextWindow; }
  maxOutputTokens(provider: ProviderKind, model: string): number | undefined { return this.metadata(provider,model)?.maxOutputTokens; }
  capabilities(provider: ProviderKind, model: string): ModelCapabilities { return this.metadata(provider,model)?.capabilities ?? defaultCapabilities(provider); }
  apiFor(provider: ProviderKind, model: string): "responses"|"chat-completions" {
    if(provider==="chatgpt") return "responses";
    const definition=this.definition(provider);
    if(definition.apiStyle==="responses") return "responses";
    if(definition.apiStyle==="chat-completions") return "chat-completions";
    return provider==="zen" && /^gpt-/i.test(String(model).trim()) ? "responses" : "chat-completions";
  }
  async discover(account: AccountRecord, fetchImpl: typeof fetch = fetch): Promise<DiscoveredModel[]> {
    if(account.provider==="chatgpt") return discoverChatGpt(account);
    if(!account.apiKey) throw new OpenAICCError(`${this.displayName(account.provider)} credential ${account.id} has no API key.`,409,"missing_api_key");
    const definition=this.definition(account.provider);
    const url=definition.discovery==="cloudflare-models" ? cloudflareDiscoveryUrl(account) : `${this.baseUrl(account).replace(/\/+$/,"")}/models`;
    const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${account.apiKey}`,Accept:"application/json"}}); const responseText=await response.text();
    if(!response.ok) throw Object.assign(new Error(safeDiscoveryError(responseText,response.status)),{status:response.status,statusCode:response.status});
    let body:unknown; try{body=JSON.parse(responseText);}catch{throw new OpenAICCError(`${definition.displayName} returned invalid model discovery JSON.`,502,"invalid_model_discovery");}
    const ids=definition.discovery==="cloudflare-models"?cloudflareModelIds(body):openAiModelIds(body);
    return normalizeDiscovered(account.provider,ids,this);
  }
  private publicFor(record: CustomProviderRecord): PublicProviderDefinition { return {  id:record.id,displayName:record.displayName,apiStyle:record.apiStyle,credentialType:"api-key",custom:true,requiresAccountId:false,supportsModelDiscovery:true,models:record.models.map((m)=>({...m})),baseUrl:record.baseUrl }; }
  private requireCustom(id:string): CustomProviderRecord { const record=this.customProviders.find((item)=>item.id===id); if(!record) throw notFound(`Unknown custom provider: ${id}`,"provider_not_found"); return record; }
  private generateId(): CustomProviderKind { for(let i=0;i<20;i++){const id=`custom-${randomUUID().replace(/-/g,"").slice(0,12)}` as CustomProviderKind;if(!this.has(id))return id;} throw new OpenAICCError("Could not allocate custom provider id.",500,"provider_id_generation_failed"); }
  private async persist(): Promise<void> { if(!this.file)return; await mkdir(path.dirname(this.file),{recursive:true,mode:0o700}); const tmp=`${this.file}.${process.pid}.tmp`; await writeFile(tmp,`${JSON.stringify({version:1,providers:this.customProviders},null,2)}\n`,{mode:0o600}); await rename(tmp,this.file); }
}

// Backwards-compatible built-in helpers; dynamic callers pass their registry.
export function providerDefinition(provider: ProviderKind, registry?: ProviderRegistry): ProviderDefinition { return registry ? registry.definition(provider) : requireBuiltIn(provider); }
export function providerDisplayName(provider: ProviderKind, registry?: ProviderRegistry): string { return providerDefinition(provider,registry).displayName; }
export function providerBaseUrl(account: Pick<AccountRecord,"provider"|"accountId">, registry?: ProviderRegistry): string {
  if(registry) return registry.baseUrl(account); const definition=requireBuiltIn(account.provider); const value=definition.baseUrl(account);
  if(!value){ if(definition.requiresAccountId) throw new OpenAICCError(`${definition.displayName} credential is missing its Account ID.`,409,"missing_account_id"); throw new OpenAICCError(`${definition.displayName} does not use an API-key base URL.`,409,"provider_base_url_unavailable"); } return value;
}
export function knownModelMetadata(provider: ProviderKind, model: string, registry?: ProviderRegistry): KnownModelMetadata | undefined { return registry ? registry.metadata(provider,model) : cloneKnown(provider,model); }
export function verifiedModelContextWindow(provider: ProviderKind, model: string, registry?: ProviderRegistry): number | undefined { return knownModelMetadata(provider,model,registry)?.contextWindow; }
export function verifiedModelMaxOutputTokens(provider: ProviderKind, model: string, registry?: ProviderRegistry): number | undefined { return knownModelMetadata(provider,model,registry)?.maxOutputTokens; }
export function modelCapabilities(provider: ProviderKind, model: string, registry?: ProviderRegistry): ModelCapabilities { return registry ? registry.capabilities(provider,model) : cloneKnown(provider,model)?.capabilities ?? defaultCapabilities(provider); }
export async function discoverModelsForCredential(account: AccountRecord, fetchImpl: typeof fetch = fetch, registry?: ProviderRegistry): Promise<DiscoveredModel[]> {
  if(registry) return registry.discover(account,fetchImpl); if(account.provider==="chatgpt") return discoverChatGpt(account);
  if(!account.apiKey) throw new OpenAICCError(`${providerDisplayName(account.provider)} credential ${account.id} has no API key.`,409,"missing_api_key");
  const definition=requireBuiltIn(account.provider); const url=definition.discovery==="cloudflare-models"?cloudflareDiscoveryUrl(account):`${providerBaseUrl(account).replace(/\/+$/,"")}/models`;
  const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${account.apiKey}`,Accept:"application/json"}}); const responseText=await response.text();
  if(!response.ok) throw Object.assign(new Error(safeDiscoveryError(responseText,response.status)),{status:response.status,statusCode:response.status});
  let body:unknown; try{body=JSON.parse(responseText);}catch{throw new OpenAICCError(`${definition.displayName} returned invalid model discovery JSON.`,502,"invalid_model_discovery");}
  return normalizeDiscovered(account.provider,definition.discovery==="cloudflare-models"?cloudflareModelIds(body):openAiModelIds(body));
}

async function discoverChatGpt(account: AccountRecord): Promise<DiscoveredModel[]> { const { createChatGptOAuthBoundary }=await import("./chatgpt-oauth.js"); if(!account.authFile)throw new OpenAICCError(`ChatGPT credential ${account.id} has no auth file.`,409,"missing_auth_file"); return normalizeDiscovered(account.provider,await createChatGptOAuthBoundary(account.authFile).listModels()); }
function normalizeDiscovered(provider: ProviderKind, ids:string[], registry?:ProviderRegistry):DiscoveredModel[]{return [...new Set(ids.map((id)=>String(id).trim()).filter(Boolean))].map((upstreamModelId)=>{const known=knownModelMetadata(provider,upstreamModelId,registry);return{provider,upstreamModelId,availability:"available" as const,...(known?.friendlyName?{friendlyName:known.friendlyName}:{}),...(known?.capabilities?{capabilities:known.capabilities}:{}),...(known?.contextWindow!==undefined?{contextWindow:known.contextWindow}:{}),...(known?.maxOutputTokens!==undefined?{maxOutputTokens:known.maxOutputTokens}:{})};});}
function requireBuiltIn(provider:ProviderKind):ProviderDefinition{const definition=BUILT_INS[provider];if(!definition)throw new OpenAICCError(`Unsupported provider: ${provider}`,400,"invalid_provider");return definition;}
function cloneKnown(provider:ProviderKind,model:string):KnownModelMetadata|undefined{const value=KNOWN_MODELS.get(modelKey(provider,model));return value?cloneMetadata(value):undefined;}
function cloneMetadata(value:KnownModelMetadata):KnownModelMetadata{return{...value,capabilities:{...value.capabilities}};}
function defaultCapabilities(provider:ProviderKind):ModelCapabilities{if(provider==="chatgpt")return{...CHATGPT_CAPABILITIES};if(provider==="google")return{...GEMINI_CAPABILITIES};if(provider==="zen")return{text:true,image:false,tools:true,streaming:true,reasoning:true};return{text:true,image:false,tools:true,streaming:true,reasoning:false};}
function cloudflareDiscoveryUrl(account:AccountRecord):string{if(!account.accountId)throw new OpenAICCError("Cloudflare Workers AI credential is missing its Account ID.",409,"missing_account_id");return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}/ai/models/search`;}
function openAiModelIds(body:unknown):string[]{if(!isRecord(body)||!Array.isArray(body.data))throw new OpenAICCError("Provider returned a malformed OpenAI-compatible models response.",502,"invalid_model_discovery");return body.data.flatMap((item)=>isRecord(item)&&typeof item.id==="string"?[item.id]:[]);}
function cloudflareModelIds(body:unknown):string[]{if(!isRecord(body)||!Array.isArray(body.result))throw new OpenAICCError("Cloudflare returned a malformed Workers AI model catalog.",502,"invalid_model_discovery");return body.result.flatMap((item)=>{if(typeof item==="string")return[item];if(!isRecord(item))return[];for(const key of["name","id","model","model_id"])if(typeof item[key]==="string"&&item[key].trim())return[item[key]];return[];});}
function safeDiscoveryError(value:string,status:number):string{try{const parsed=JSON.parse(value)as unknown;if(isRecord(parsed)){if(typeof parsed.message==="string")return redact(parsed.message);if(isRecord(parsed.error)&&typeof parsed.error.message==="string")return redact(parsed.error.message);if(Array.isArray(parsed.errors)){const first=parsed.errors.find((item)=>isRecord(item)&&typeof item.message==="string")as Record<string,unknown>|undefined;if(first&&typeof first.message==="string")return redact(first.message);}}}catch{}return`Provider model discovery failed with HTTP ${status}.`;}
function redact(value:string):string{return value.replace(/\bBearer\s+[^\s,;]+/gi,"Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]{8,}/g,"[redacted]").replace(/\bAIza[A-Za-z0-9_-]{20,}/g,"[redacted]").slice(0,800);}
function cleanDisplayName(value:unknown):string{const name=String(value??"").trim();if(!name)throw new OpenAICCError("Provider display name is required.",400,"provider_name_required");if(name.length>120)throw new OpenAICCError("Provider display name is too long.",400,"provider_name_too_long");return name;}
function cleanBaseUrl(value:unknown):string{const raw=String(value??"").trim();let url:URL;try{url=new URL(raw);}catch{throw new OpenAICCError("Provider base URL must be a valid HTTP(S) URL.",400,"invalid_provider_base_url");}if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new OpenAICCError("Provider base URL must be HTTP(S) without credentials, query parameters, or fragments.",400,"invalid_provider_base_url");return url.toString().replace(/\/+$/,"");}
function cleanApiStyle(value:unknown):CustomProviderApiStyle{if(value!=="chat-completions"&&value!=="responses")throw new OpenAICCError("API style must be chat-completions or responses.",400,"invalid_api_style");return value;}
function cleanModelId(value:unknown):string{const id=String(value??"").trim();if(!id)throw new OpenAICCError("Model id is required.",400,"model_required");if(id.length>256)throw new OpenAICCError("Model id is too long.",400,"model_too_long");return id;}
function optionalInteger(value:unknown,name:string,min:number,max:number):number|undefined{if(value===undefined||value===null||value==="")return undefined;const number=Number(value);if(!Number.isInteger(number)||number<min||number>max)throw new OpenAICCError(`${name} must be an integer between ${min} and ${max}.`,400,"invalid_number",{field:name,min,max});return number;}
function normalizeStoredProvider(raw:any):CustomProviderRecord{const id=String(raw?.id??"");if(!/^custom-[a-f0-9]{12}$/.test(id))throw new OpenAICCError("Stored custom provider has an invalid id.",500,"invalid_provider_store");return{id:id as CustomProviderKind,displayName:cleanDisplayName(raw.displayName),baseUrl:cleanBaseUrl(raw.baseUrl),apiStyle:cleanApiStyle(raw.apiStyle),models:Array.isArray(raw.models)?raw.models.map((m:any)=>({id:cleanModelId(m.id),...(optionalInteger(m.contextWindow,"contextWindow",1,10_000_000)?{contextWindow:Number(m.contextWindow)}:{}),...(optionalInteger(m.maxOutputTokens,"maxOutputTokens",1,1_000_000)?{maxOutputTokens:Number(m.maxOutputTokens)}:{})})):[],createdAt:String(raw.createdAt||new Date(0).toISOString()),updatedAt:String(raw.updatedAt||raw.createdAt||new Date(0).toISOString())};}
function modelKey(provider:ProviderKind,model:string):string{return`${provider}:${String(model||"").trim().toLowerCase()}`;}
function isRecord(value:unknown):value is Record<string,any>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
