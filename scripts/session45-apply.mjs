// Session 4.5 source transformer. This file is removed after it applies.
import { readFile, writeFile } from 'node:fs/promises';

async function text(file){ return readFile(file,'utf8'); }
async function save(file,value){ await writeFile(file,value,'utf8'); }
function once(value,from,to,label){
  if (!value.includes(from)) throw new Error(`Missing patch anchor: ${label}`);
  return value.replace(from,to);
}
function regexOnce(value,re,to,label){
  if (!re.test(value)) throw new Error(`Missing patch regex: ${label}`);
  return value.replace(re,to);
}

// AccountStore: preserve the existing storage/security implementation while allowing
// stable dynamic custom provider ids to participate in provider-local rotation.
{
  const file='src/account-store.ts'; let s=await text(file);
  s=once(s,
`export type AccountStatus = "ready" | "exhausted" | "auth_error" | "disabled";
export type ProviderKind = "chatgpt" | "zen" | "nvidia" | "google" | "cloudflare";
export type ApiProviderKind = Exclude<ProviderKind, "chatgpt">;`,
`export type AccountStatus = "ready" | "exhausted" | "auth_error" | "disabled";
export type BuiltInProviderKind = "chatgpt" | "zen" | "nvidia" | "google" | "cloudflare";
export type CustomProviderKind = \`custom-\${string}\`;
export type ProviderKind = BuiltInProviderKind | CustomProviderKind;
export type ApiProviderKind = Exclude<BuiltInProviderKind, "chatgpt"> | CustomProviderKind;`, 'account provider types');
  s=once(s,
`function defaultCredentialName(provider: ProviderKind): string {
  if (provider === "chatgpt") return "ChatGPT account";
  if (provider === "zen") return "OpenCode Zen";
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "google") return "Google AI Studio";
  return "Cloudflare Workers AI";
}`,
`function defaultCredentialName(provider: ProviderKind): string {
  if (provider === "chatgpt") return "ChatGPT account";
  if (provider === "zen") return "OpenCode Zen";
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "google") return "Google AI Studio";
  if (provider === "cloudflare") return "Cloudflare Workers AI";
  return "Custom provider credential";
}`, 'custom credential name');
  s=once(s,
`function isApiProvider(provider: string): provider is ApiProviderKind {
  return provider === "zen" || provider === "nvidia" || provider === "google" || provider === "cloudflare";
}`,
`function isApiProvider(provider: string): provider is ApiProviderKind {
  return provider === "zen" || provider === "nvidia" || provider === "google" || provider === "cloudflare" || /^custom-[a-f0-9]{12}$/.test(provider);
}`, 'dynamic api provider guard');
  await save(file,s);
}

// Persistent dynamic provider registry. No credentials or arbitrary headers are stored here.
await save('src/provider-registry.ts', `import { randomUUID } from "node:crypto";
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
  cloudflare: { id: "cloudflare", displayName: "Cloudflare Workers AI", apiStyle: "chat-completions", credentialType: "api-key", requiresAccountId: true, discovery: "cloudflare-models", custom: false, baseUrl: (account) => account.accountId ? \`https://api.cloudflare.com/client/v4/accounts/\${encodeURIComponent(account.accountId)}/ai/v1\` : undefined },
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
      custom: true, requiresAccountId: false, supportsModelDiscovery: true, models: record.models.map((model) => ({ ...model })),
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
    const index=this.customProviders.findIndex((item)=>item.id===id); if(index<0) throw notFound(\`Unknown custom provider: \${id}\`,"provider_not_found");
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
    const provider=this.requireCustom(id); const index=provider.models.findIndex((model)=>model.id===modelId); if(index<0) throw notFound(\`Unknown manual model: \${modelId}\`,"manual_model_not_found");
    provider.models.splice(index,1); provider.updatedAt=new Date().toISOString(); await this.persist(); this.emit("event",{type:"providers_changed",provider:this.publicFor(provider)});
  }
  definition(provider: ProviderKind): ProviderDefinition {
    const built=BUILT_INS[provider]; if(built) return built;
    const custom=this.customProviders.find((item)=>item.id===provider); if(!custom) throw new OpenAICCError(\`Unsupported provider: \${provider}\`,400,"invalid_provider");
    return { id:custom.id, displayName:custom.displayName, apiStyle:custom.apiStyle, credentialType:"api-key", requiresAccountId:false, discovery:"openai-models", custom:true, baseUrl:()=>custom.baseUrl };
  }
  displayName(provider: ProviderKind): string { return this.definition(provider).displayName; }
  baseUrl(account: Pick<AccountRecord,"provider"|"accountId">): string {
    const definition=this.definition(account.provider); const value=definition.baseUrl(account);
    if(!value){ if(definition.requiresAccountId) throw new OpenAICCError(\`\${definition.displayName} credential is missing its Account ID.\`,409,"missing_account_id"); throw new OpenAICCError(\`\${definition.displayName} does not use an API-key base URL.\`,409,"provider_base_url_unavailable"); }
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
    if(!account.apiKey) throw new OpenAICCError(\`\${this.displayName(account.provider)} credential \${account.id} has no API key.\`,409,"missing_api_key");
    const definition=this.definition(account.provider);
    const url=definition.discovery==="cloudflare-models" ? cloudflareDiscoveryUrl(account) : \`\${this.baseUrl(account).replace(/\\/+$/,"")}/models\`;
    const response=await fetchImpl(url,{headers:{Authorization:\`Bearer \${account.apiKey}\`,Accept:"application/json"}}); const responseText=await response.text();
    if(!response.ok) throw Object.assign(new Error(safeDiscoveryError(responseText,response.status)),{status:response.status,statusCode:response.status});
    let body:unknown; try{body=JSON.parse(responseText);}catch{throw new OpenAICCError(\`\${definition.displayName} returned invalid model discovery JSON.\`,502,"invalid_model_discovery");}
    const ids=definition.discovery==="cloudflare-models"?cloudflareModelIds(body):openAiModelIds(body);
    return normalizeDiscovered(account.provider,ids,this);
  }
  private publicFor(record: CustomProviderRecord): PublicProviderDefinition { return { id:record.id,displayName:record.displayName,apiStyle:record.apiStyle,credentialType:"api-key",custom:true,requiresAccountId:false,supportsModelDiscovery:true,models:record.models.map((m)=>({...m})) }; }
  private requireCustom(id:string): CustomProviderRecord { const record=this.customProviders.find((item)=>item.id===id); if(!record) throw notFound(\`Unknown custom provider: \${id}\`,"provider_not_found"); return record; }
  private generateId(): CustomProviderKind { for(let i=0;i<20;i++){const id=\`custom-\${randomUUID().replace(/-/g,"").slice(0,12)}\` as CustomProviderKind;if(!this.has(id))return id;} throw new OpenAICCError("Could not allocate custom provider id.",500,"provider_id_generation_failed"); }
  private async persist(): Promise<void> { if(!this.file)return; await mkdir(path.dirname(this.file),{recursive:true,mode:0o700}); const tmp=\`\${this.file}.\${process.pid}.tmp\`; await writeFile(tmp,\`\${JSON.stringify({version:1,providers:this.customProviders},null,2)}\\n\`,{mode:0o600}); await rename(tmp,this.file); }
}

// Backwards-compatible built-in helpers; dynamic callers pass their registry.
export function providerDefinition(provider: ProviderKind, registry?: ProviderRegistry): ProviderDefinition { return registry ? registry.definition(provider) : requireBuiltIn(provider); }
export function providerDisplayName(provider: ProviderKind, registry?: ProviderRegistry): string { return providerDefinition(provider,registry).displayName; }
export function providerBaseUrl(account: Pick<AccountRecord,"provider"|"accountId">, registry?: ProviderRegistry): string {
  if(registry) return registry.baseUrl(account); const definition=requireBuiltIn(account.provider); const value=definition.baseUrl(account);
  if(!value){ if(definition.requiresAccountId) throw new OpenAICCError(\`\${definition.displayName} credential is missing its Account ID.\`,409,"missing_account_id"); throw new OpenAICCError(\`\${definition.displayName} does not use an API-key base URL.\`,409,"provider_base_url_unavailable"); } return value;
}
export function knownModelMetadata(provider: ProviderKind, model: string, registry?: ProviderRegistry): KnownModelMetadata | undefined { return registry ? registry.metadata(provider,model) : cloneKnown(provider,model); }
export function verifiedModelContextWindow(provider: ProviderKind, model: string, registry?: ProviderRegistry): number | undefined { return knownModelMetadata(provider,model,registry)?.contextWindow; }
export function verifiedModelMaxOutputTokens(provider: ProviderKind, model: string, registry?: ProviderRegistry): number | undefined { return knownModelMetadata(provider,model,registry)?.maxOutputTokens; }
export function modelCapabilities(provider: ProviderKind, model: string, registry?: ProviderRegistry): ModelCapabilities { return registry ? registry.capabilities(provider,model) : cloneKnown(provider,model)?.capabilities ?? defaultCapabilities(provider); }
export async function discoverModelsForCredential(account: AccountRecord, fetchImpl: typeof fetch = fetch, registry?: ProviderRegistry): Promise<DiscoveredModel[]> {
  if(registry) return registry.discover(account,fetchImpl); if(account.provider==="chatgpt") return discoverChatGpt(account);
  if(!account.apiKey) throw new OpenAICCError(\`\${providerDisplayName(account.provider)} credential \${account.id} has no API key.\`,409,"missing_api_key");
  const definition=requireBuiltIn(account.provider); const url=definition.discovery==="cloudflare-models"?cloudflareDiscoveryUrl(account):\`\${providerBaseUrl(account).replace(/\\/+$/,"")}/models\`;
  const response=await fetchImpl(url,{headers:{Authorization:\`Bearer \${account.apiKey}\`,Accept:"application/json"}}); const responseText=await response.text();
  if(!response.ok) throw Object.assign(new Error(safeDiscoveryError(responseText,response.status)),{status:response.status,statusCode:response.status});
  let body:unknown; try{body=JSON.parse(responseText);}catch{throw new OpenAICCError(\`\${definition.displayName} returned invalid model discovery JSON.\`,502,"invalid_model_discovery");}
  return normalizeDiscovered(account.provider,definition.discovery==="cloudflare-models"?cloudflareModelIds(body):openAiModelIds(body));
}

async function discoverChatGpt(account: AccountRecord): Promise<DiscoveredModel[]> { const { createChatGptOAuthBoundary }=await import("./chatgpt-oauth.js"); if(!account.authFile)throw new OpenAICCError(\`ChatGPT credential \${account.id} has no auth file.\`,409,"missing_auth_file"); return normalizeDiscovered(account.provider,await createChatGptOAuthBoundary(account.authFile).listModels()); }
function normalizeDiscovered(provider: ProviderKind, ids:string[], registry?:ProviderRegistry):DiscoveredModel[]{return [...new Set(ids.map((id)=>String(id).trim()).filter(Boolean))].map((upstreamModelId)=>{const known=knownModelMetadata(provider,upstreamModelId,registry);return{provider,upstreamModelId,availability:"available" as const,...(known?.friendlyName?{friendlyName:known.friendlyName}:{}),...(known?.capabilities?{capabilities:known.capabilities}:{}),...(known?.contextWindow!==undefined?{contextWindow:known.contextWindow}:{}),...(known?.maxOutputTokens!==undefined?{maxOutputTokens:known.maxOutputTokens}:{})};});}
function requireBuiltIn(provider:ProviderKind):ProviderDefinition{const definition=BUILT_INS[provider];if(!definition)throw new OpenAICCError(\`Unsupported provider: \${provider}\`,400,"invalid_provider");return definition;}
function cloneKnown(provider:ProviderKind,model:string):KnownModelMetadata|undefined{const value=KNOWN_MODELS.get(modelKey(provider,model));return value?cloneMetadata(value):undefined;}
function cloneMetadata(value:KnownModelMetadata):KnownModelMetadata{return{...value,capabilities:{...value.capabilities}};}
function defaultCapabilities(provider:ProviderKind):ModelCapabilities{if(provider==="chatgpt")return{...CHATGPT_CAPABILITIES};if(provider==="google")return{...GEMINI_CAPABILITIES};if(provider==="zen")return{text:true,image:false,tools:true,streaming:true,reasoning:true};return{text:true,image:false,tools:true,streaming:true,reasoning:false};}
function cloudflareDiscoveryUrl(account:AccountRecord):string{if(!account.accountId)throw new OpenAICCError("Cloudflare Workers AI credential is missing its Account ID.",409,"missing_account_id");return \`https://api.cloudflare.com/client/v4/accounts/\${encodeURIComponent(account.accountId)}/ai/models/search\`;}
function openAiModelIds(body:unknown):string[]{if(!isRecord(body)||!Array.isArray(body.data))throw new OpenAICCError("Provider returned a malformed OpenAI-compatible models response.",502,"invalid_model_discovery");return body.data.flatMap((item)=>isRecord(item)&&typeof item.id==="string"?[item.id]:[]);}
function cloudflareModelIds(body:unknown):string[]{if(!isRecord(body)||!Array.isArray(body.result))throw new OpenAICCError("Cloudflare returned a malformed Workers AI model catalog.",502,"invalid_model_discovery");return body.result.flatMap((item)=>{if(typeof item==="string")return[item];if(!isRecord(item))return[];for(const key of["name","id","model","model_id"])if(typeof item[key]==="string"&&item[key].trim())return[item[key]];return[];});}
function safeDiscoveryError(value:string,status:number):string{try{const parsed=JSON.parse(value)as unknown;if(isRecord(parsed)){if(typeof parsed.message==="string")return redact(parsed.message);if(isRecord(parsed.error)&&typeof parsed.error.message==="string")return redact(parsed.error.message);if(Array.isArray(parsed.errors)){const first=parsed.errors.find((item)=>isRecord(item)&&typeof item.message==="string")as Record<string,unknown>|undefined;if(first&&typeof first.message==="string")return redact(first.message);}}}catch{}return\`Provider model discovery failed with HTTP \${status}.\`;}
function redact(value:string):string{return value.replace(/\\bBearer\\s+[^\\s,;]+/gi,"Bearer [redacted]").replace(/\\bsk-[A-Za-z0-9_-]{8,}/g,"[redacted]").replace(/\\bAIza[A-Za-z0-9_-]{20,}/g,"[redacted]").slice(0,800);}
function cleanDisplayName(value:unknown):string{const name=String(value??"").trim();if(!name)throw new OpenAICCError("Provider display name is required.",400,"provider_name_required");if(name.length>120)throw new OpenAICCError("Provider display name is too long.",400,"provider_name_too_long");return name;}
function cleanBaseUrl(value:unknown):string{const raw=String(value??"").trim();let url:URL;try{url=new URL(raw);}catch{throw new OpenAICCError("Provider base URL must be a valid HTTP(S) URL.",400,"invalid_provider_base_url");}if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new OpenAICCError("Provider base URL must be HTTP(S) without credentials, query parameters, or fragments.",400,"invalid_provider_base_url");return url.toString().replace(/\\/+$/,"");}
function cleanApiStyle(value:unknown):CustomProviderApiStyle{if(value!=="chat-completions"&&value!=="responses")throw new OpenAICCError("API style must be chat-completions or responses.",400,"invalid_api_style");return value;}
function cleanModelId(value:unknown):string{const id=String(value??"").trim();if(!id)throw new OpenAICCError("Model id is required.",400,"model_required");if(id.length>256)throw new OpenAICCError("Model id is too long.",400,"model_too_long");return id;}
function optionalInteger(value:unknown,name:string,min:number,max:number):number|undefined{if(value===undefined||value===null||value==="")return undefined;const number=Number(value);if(!Number.isInteger(number)||number<min||number>max)throw new OpenAICCError(\`\${name} must be an integer between \${min} and \${max}.\`,400,"invalid_number",{field:name,min,max});return number;}
function normalizeStoredProvider(raw:any):CustomProviderRecord{const id=String(raw?.id??"");if(!/^custom-[a-f0-9]{12}$/.test(id))throw new OpenAICCError("Stored custom provider has an invalid id.",500,"invalid_provider_store");return{id:id as CustomProviderKind,displayName:cleanDisplayName(raw.displayName),baseUrl:cleanBaseUrl(raw.baseUrl),apiStyle:cleanApiStyle(raw.apiStyle),models:Array.isArray(raw.models)?raw.models.map((m:any)=>({id:cleanModelId(m.id),...(optionalInteger(m.contextWindow,"contextWindow",1,10_000_000)?{contextWindow:Number(m.contextWindow)}:{}),...(optionalInteger(m.maxOutputTokens,"maxOutputTokens",1,1_000_000)?{maxOutputTokens:Number(m.maxOutputTokens)}:{})})):[],createdAt:String(raw.createdAt||new Date(0).toISOString()),updatedAt:String(raw.updatedAt||raw.createdAt||new Date(0).toISOString())};}
function modelKey(provider:ProviderKind,model:string):string{return\`\${provider}:\${String(model||"").trim().toLowerCase()}\`;}
function isRecord(value:unknown):value is Record<string,any>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
`);

// Upstream wire style is provider-definition driven for custom providers while
// retaining Zen's existing mixed API behavior.
await save('src/upstream-api.ts', `import { ProviderKind } from "./account-store.js";
import { ProviderRegistry } from "./provider-registry.js";
export type UpstreamApi = "responses" | "chat-completions";
export function upstreamApiFor(provider: ProviderKind, model: string, registry?: ProviderRegistry): UpstreamApi {
  if (registry) return registry.apiFor(provider, model);
  if (provider === "chatgpt") return "responses";
  if (provider === "zen" && /^gpt-/i.test(String(model).trim())) return "responses";
  return "chat-completions";
}
`);

// Route defaults, dynamic provider validation/caps and route-specific context.
{
  const file='src/model-config.ts'; let s=await text(file);
  s=once(s,
`import { verifiedModelContextWindow, verifiedModelMaxOutputTokens } from "./provider-registry.js";`,
`import { ProviderRegistry, verifiedModelContextWindow, verifiedModelMaxOutputTokens } from "./provider-registry.js";`, 'model provider import');
  s=once(s,
`  sonnet: 16384,
  haiku: 16384,`,
`  sonnet: 65536,
  haiku: 65536,`, 'gemini output defaults');
  s=once(s,
`export const CLOUDFLARE_GEMMA_MODEL = "@cf/google/gemma-4-26b-a4b-it";`,
`export const CLOUDFLARE_GEMMA_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const GEMINI_FLASH_LITE_MODEL = "gemini-3.5-flash-lite";`, 'gemini constant');
  s=regexOnce(s,/const DEFAULTS: ModelConfig = \{[\s\S]*?\n\};\n\nconst LEGACY_GEMINI_MODEL = "gemini-3\.6-flash";/,
`const DEFAULTS: ModelConfig = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  routes: {
    default: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.default },
    fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.fable },
    opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.opus },
    sonnet: { provider: "google", model: GEMINI_FLASH_LITE_MODEL, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.sonnet },
    haiku: { provider: "google", model: GEMINI_FLASH_LITE_MODEL, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS.haiku },
  },
};`, 'fresh route defaults');
  s=once(s,
`  constructor(dataDir: string, private readonly accounts: AccountStore) {`,
`  constructor(dataDir: string, private readonly accounts: AccountStore, private readonly providers?: ProviderRegistry) {`, 'model constructor registry');
  s=once(s,`      const normalized = normalizeForLoad(raw);`,`      const normalized = normalizeForLoad(raw, this.providers);`, 'load registry');
  s=once(s,`    const candidate = normalizeStrict({ ...this.state, ...input, routes: candidateRoutes });`,`    const candidate = normalizeStrict({ ...this.state, ...input, routes: candidateRoutes }, this.providers);`, 'strict registry');
  s=once(s,`    const contextWindow = contextWindowForRoute(this.state, slot);`,`    const contextWindow = contextWindowForRoute(this.state, slot, this.providers);`, 'health context registry');
  s=once(s,
`  routeForRequestedModel(model: string): ModelRoute {
    return { ...this.state.routes[this.slotForRequestedModel(model)] };
  }`,
`  routeForRequestedModel(model: string): ModelRoute {
    return { ...this.state.routes[this.slotForRequestedModel(model)] };
  }

  contextWindowForRequestedModel(model: string): number {
    return contextWindowForRoute(this.state, this.slotForRequestedModel(model), this.providers);
  }`, 'route context accessor');
  s=regexOnce(s,/export function contextWindowForRoute\(config: ModelConfig, slot: ModelSlot\): number \{[\s\S]*?function verifiedUpstreamContextWindow\(route: ModelRoute\): number \{\n  return verifiedModelContextWindow\(route\.provider, route\.model\) \?\? FALLBACK_CONTEXT_WINDOW;\n\}/,
`export function contextWindowForRoute(config: ModelConfig, slot: ModelSlot, providers?: ProviderRegistry): number {
  const configuredTarget = Math.max(FALLBACK_CONTEXT_WINDOW, Math.floor(Number(config.contextWindow) || FALLBACK_CONTEXT_WINDOW));
  return Math.min(configuredTarget, verifiedUpstreamContextWindow(config.routes[slot], providers));
}

export function claudeCodeModelAlias(config: ModelConfig, slot: ModelSlot, providers?: ProviderRegistry): string {
  return contextWindowForRoute(config, slot, providers) > FALLBACK_CONTEXT_WINDOW
    ? CLAUDE_CODE_EXTENDED_MODEL_IDS[slot]
    : CLAUDE_CODE_STANDARD_MODEL_IDS[slot];
}

export function slotForClaudeCodeModel(config: ModelConfig, model: string, providers?: ProviderRegistry): ModelSlot | undefined {
  const id = String(model || "").trim().toLowerCase();
  for (const slot of MODEL_SLOTS) {
    const alias = claudeCodeModelAlias(config, slot, providers).toLowerCase();
    const stripped = alias.replace(/\\[1m\\]$/i, "");
    if (id === alias || id === stripped) return slot;
  }
  return undefined;
}

function verifiedUpstreamContextWindow(route: ModelRoute, providers?: ProviderRegistry): number {
  return verifiedModelContextWindow(route.provider, route.model, providers) ?? FALLBACK_CONTEXT_WINDOW;
}`, 'context functions');
  s=s.replace(/function normalizeStrict\(input: Partial<ModelConfig>\): ModelConfig \{/,'function normalizeStrict(input: Partial<ModelConfig>, providers?: ProviderRegistry): ModelConfig {');
  s=s.replace(/if \(!isProvider\(candidate\.provider\)\)/,'if (!isProvider(candidate.provider, providers))');
  s=s.replace(/verifiedModelMaxOutputTokens\(candidate\.provider, model\)/,'verifiedModelMaxOutputTokens(candidate.provider, model, providers)');
  s=s.replace(/function normalizeForLoad\(input: Partial<ModelConfig>\): \{ config: ModelConfig; changed: boolean \} \{/,'function normalizeForLoad(input: Partial<ModelConfig>, providers?: ProviderRegistry): { config: ModelConfig; changed: boolean } {');
  s=once(s,
`    const original = input.routes?.[slot];
    const candidate = migrateLegacyGeminiRoute(slot, original) ?? original ?? fallback;
    if (original && candidate !== original) changed = true;
    const provider = isProvider(candidate.provider) ? candidate.provider : fallback.provider;`,
`    const original = input.routes?.[slot];
    const candidate = original ?? fallback;
    const provider = isProvider(candidate.provider, providers) ? candidate.provider : fallback.provider;
    if (original && provider !== candidate.provider) changed = true;`, 'preserve existing routes');
  s=s.replace(/verifiedModelMaxOutputTokens\(provider, model\)/,'verifiedModelMaxOutputTokens(provider, model, providers)');
  s=regexOnce(s,/\nfunction migrateLegacyGeminiRoute[\s\S]*?\n}\n\nfunction finiteInteger/, '\nfunction finiteInteger', 'remove destructive legacy route migration');
  s=regexOnce(s,/function isProvider\(value: unknown\): value is ProviderKind \{[\s\S]*?\n}/,
`function isProvider(value: unknown, providers?: ProviderRegistry): value is ProviderKind {
  if (value === "chatgpt" || value === "zen" || value === "nvidia" || value === "google" || value === "cloudflare") return true;
  return typeof value === "string" && Boolean(providers?.has(value));
}`, 'dynamic route provider validation');
  await save(file,s);
}

// Claude Code model aliases now receive the same provider registry used by the dispatcher.
{
 const file='src/claude-config.ts'; let s=await text(file);
 s=once(s,`import { ModelConfig, claudeCodeModelAlias } from "./model-config.js";`,`import { ModelConfig, claudeCodeModelAlias } from "./model-config.js";\nimport { ProviderRegistry } from "./provider-registry.js";`,'claude config registry import');
 s=once(s,`export async function configureClaudeCode(baseUrl: string, config: ModelConfig): Promise<ClaudeConfigureResult> {`,`export async function configureClaudeCode(baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Promise<ClaudeConfigureResult> {`,'claude config registry arg');
 s=s.replace(/claudeCodeModelAlias\(config, "(default|fable|opus|sonnet|haiku)"\)/g,'claudeCodeModelAlias(config, "$1", providers)');
 await save(file,s);
}

// Claude Desktop/public model metadata follows dynamic route capabilities and limits.
{
 const file='src/claude-desktop.ts'; let s=await text(file);
 s=once(s,`import { modelCapabilities } from "./provider-registry.js";`,`import { ProviderRegistry, modelCapabilities } from "./provider-registry.js";`,'desktop registry import');
 s=s.replace(/export function claudeDesktopModels\(config: ModelConfig\): ClaudeModelInfo\[\] \{\n  return DESKTOP_SLOTS\.map\(\(slot\) => modelInfo\(slot, config\)\);\n}/,`export function claudeDesktopModels(config: ModelConfig, providers?: ProviderRegistry): ClaudeModelInfo[] {\n  return DESKTOP_SLOTS.map((slot) => modelInfo(slot, config, providers));\n}`);
 s=s.replace(/export function claudeDesktopModel\(config: ModelConfig, modelId: string\): ClaudeModelInfo \| undefined \{/,'export function claudeDesktopModel(config: ModelConfig, modelId: string, providers?: ProviderRegistry): ClaudeModelInfo | undefined {');
 s=s.replace('const exact = claudeDesktopModels(config).find','const exact = claudeDesktopModels(config, providers).find');
 s=s.replace('const slot = slotForClaudeCodeModel(config, normalized) ?? desktopSlotForModel(normalized);','const slot = slotForClaudeCodeModel(config, normalized, providers) ?? desktopSlotForModel(normalized);');
 s=s.replace('return slot ? modelInfo(slot, config) : undefined;','return slot ? modelInfo(slot, config, providers) : undefined;');
 s=s.replace('  query: { afterId?: string; beforeId?: string; limit?: number } = {},\n): { data: ClaudeModelInfo[];', '  query: { afterId?: string; beforeId?: string; limit?: number } = {},\n  providers?: ProviderRegistry,\n): { data: ClaudeModelInfo[];');
 s=s.replace('  const all = claudeDesktopModels(config);','  const all = claudeDesktopModels(config, providers);');
 s=s.replace(/export function claudeDesktopProfile\(baseUrl: string, config: ModelConfig\): Record<string, unknown> \{/,'export function claudeDesktopProfile(baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Record<string, unknown> {');
 s=s.replace('const info = modelInfo(slot, config);','const info = modelInfo(slot, config, providers);');
 s=s.replace(/export async function configureClaudeDesktop\(baseUrl: string, config: ModelConfig\): Promise<ClaudeDesktopConfigureResult> \{/,'export async function configureClaudeDesktop(baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Promise<ClaudeDesktopConfigureResult> {');
 s=s.replace('await configureClaudeDesktopAtPaths(paths, baseUrl, config);','await configureClaudeDesktopAtPaths(paths, baseUrl, config, providers);');
 s=s.replace(/export async function configureClaudeDesktopAtPaths\(paths: ClaudeDesktopPaths, baseUrl: string, config: ModelConfig\): Promise<void> \{/,'export async function configureClaudeDesktopAtPaths(paths: ClaudeDesktopPaths, baseUrl: string, config: ModelConfig, providers?: ProviderRegistry): Promise<void> {');
 s=s.replace('await writeJson(paths.profileFile, claudeDesktopProfile(baseUrl, config));','await writeJson(paths.profileFile, claudeDesktopProfile(baseUrl, config, providers));');
 s=s.replace(/function modelInfo\(slot: ClaudeDesktopSlot, config: ModelConfig\): ClaudeModelInfo \{/,'function modelInfo(slot: ClaudeDesktopSlot, config: ModelConfig, providers?: ProviderRegistry): ClaudeModelInfo {');
 s=s.replace('id: claudeCodeModelAlias(config, slot),','id: claudeCodeModelAlias(config, slot, providers),');
 s=s.replace('max_input_tokens: contextWindowForRoute(config, slot),','max_input_tokens: contextWindowForRoute(config, slot, providers),');
 s=s.replace('capabilities: routeCapabilities(route),','capabilities: routeCapabilities(route, providers),');
 s=s.replace(/function routeCapabilities\(route: ModelRoute\): Record<string, unknown> \{\n  const capabilities = modelCapabilities\(route\.provider, route\.model\);/,`function routeCapabilities(route: ModelRoute, providers?: ProviderRegistry): Record<string, unknown> {\n  const capabilities = modelCapabilities(route.provider, route.model, providers);`);
 await save(file,s);
}

// Control plane: dynamic provider CRUD/manual models, secret-safe public metadata and custom clients.
{
 const file='src/dispatcher.ts'; let s=await text(file);
 s=once(s,`import { DiscoveredModel, discoverModelsForCredential, providerBaseUrl } from "./provider-registry.js";`,`import { DiscoveredModel, ProviderRegistry, discoverModelsForCredential, providerBaseUrl } from "./provider-registry.js";`,'dispatcher registry import');
 s=once(s,`  modelDiscoverer?: (account: AccountRecord) => Promise<DiscoveredModel[]>;`,`  modelDiscoverer?: (account: AccountRecord) => Promise<DiscoveredModel[]>;\n  providerRegistry?: ProviderRegistry;`,'dispatcher option');
 s=once(s,`  private readonly modelDiscoverer: (account: AccountRecord) => Promise<DiscoveredModel[]>;`,`  private readonly modelDiscoverer: (account: AccountRecord) => Promise<DiscoveredModel[]>;\n  private readonly providers: ProviderRegistry;`,'dispatcher member');
 s=once(s,`    this.clientFactory = options.clientFactory;
    this.modelDiscoverer = options.modelDiscoverer ?? ((account) => discoverModelsForCredential(account));`, `    this.clientFactory = options.clientFactory;\n    this.providers = options.providerRegistry ?? new ProviderRegistry();\n    this.modelDiscoverer = options.modelDiscoverer ?? ((account) => discoverModelsForCredential(account, fetch, this.providers));`,'dispatcher registry init');
 s=once(s,`    models.on("event", (event) => this.broadcast(event.type, event));`,`    models.on("event", (event) => this.broadcast(event.type, event));\n    this.providers.on("event", (event) => { this.clients.clear(); this.broadcast(event.type, event); });`,'dispatcher provider events');
 s=s.replace('claudeDesktopModelList(this.models.snapshot(), {\n          afterId:', 'claudeDesktopModelList(this.models.snapshot(), {\n          afterId:');
 s=s.replace('          limit,\n        }));','          limit,\n        }, this.providers));');
 s=s.replace('const model = claudeDesktopModel(this.models.snapshot(), modelId);','const model = claudeDesktopModel(this.models.snapshot(), modelId, this.providers);');
 s=once(s,`      if (req.method === "GET" && url.pathname === "/admin/events") return void this.handleEventStream(req, res);`, `      if (req.method === "GET" && url.pathname === "/admin/events") return void this.handleEventStream(req, res);\n      if (req.method === "POST" && url.pathname === "/admin/providers") {\n        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);\n        return void json(res, 201, await this.providers.createCustom(body));\n      }\n      if (req.method === "PATCH" && /^\\/admin\\/providers\\/[^/]+$/.test(url.pathname)) {\n        const id = providerIdFromPath(url.pathname);\n        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);\n        return void json(res, 200, await this.providers.updateCustom(id, body));\n      }\n      if (req.method === "DELETE" && /^\\/admin\\/providers\\/[^/]+$/.test(url.pathname)) {\n        await readJson(req, ADMIN_BODY_LIMIT, true);\n        const id = providerIdFromPath(url.pathname);\n        const credential = this.store.list().find((item) => item.provider === id);\n        if (credential) throw conflict(\`Provider \${id} still has credentials. Remove them first.\`, "provider_has_credentials");\n        const slots = this.models.slotsForProvider(id);\n        if (slots.length) throw conflict(\`Provider \${id} is routed by: \${slots.join(", ")}. Change those routes first.\`, "provider_in_use", { slots });\n        await this.providers.deleteCustom(id);\n        return void json(res, 200, { ok: true });\n      }\n      if (req.method === "POST" && /^\\/admin\\/providers\\/[^/]+\\/models$/.test(url.pathname)) {\n        const id = providerIdFromPath(url.pathname);\n        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);\n        return void json(res, 200, await this.providers.upsertManualModel(id, body));\n      }\n      if (req.method === "DELETE" && /^\\/admin\\/providers\\/[^/]+\\/models$/.test(url.pathname)) {\n        const id = providerIdFromPath(url.pathname);\n        const body = await readJson<any>(req, ADMIN_BODY_LIMIT, true);\n        await this.providers.deleteManualModel(id, String(body.id ?? ""));\n        return void json(res, 200, { ok: true });\n      }`,'provider admin endpoints');
 s=once(s,`  private adminState() {
    return { ...this.store.snapshot(), modelConfig: this.models.snapshot(), routeHealth: this.models.health() };
  }`,`  private adminState() {\n    return { ...this.store.snapshot(), providers: this.providers.listPublic(), modelConfig: this.models.snapshot(), routeHealth: this.models.health() };\n  }`,'provider state');
 s=once(s,`    const routedBody: AnthropicRequest = {
      ...body,
      max_tokens: Math.max(1, Math.min(Math.floor(requestedMaxTokens), route.maxOutputTokens)),
    };`,`    const routedBody: AnthropicRequest = {\n      ...body,\n      max_tokens: Math.max(1, Math.min(Math.floor(requestedMaxTokens), route.maxOutputTokens)),\n    };\n    enforceContextLimit(this.models.contextWindowForRequestedModel(body.model), body);`,'control context enforcement');
 s=s.replace('if (upstreamApiFor(account.provider, model) === "responses")','if (upstreamApiFor(account.provider, model, this.providers) === "responses")');
 s=regexOnce(s,/  private async addApiKey\(input: \{ id\?: string; name\?: string; provider\?: string; apiKey\?: string; model\?: string; accountId\?: string \}\): Promise<AccountRecord> \{[\s\S]*?\n  \}\n\n  private clientFor/,
`  private async addApiKey(input: { id?: string; name?: string; provider?: string; apiKey?: string; model?: string; accountId?: string }): Promise<AccountRecord> {\n    const provider = String(input.provider ?? "").trim().toLowerCase();\n    if (!this.providers.isApiKeyProvider(provider)) throw new OpenAICCError("Choose a configured API-key provider.", 400, "invalid_provider");\n    const record = await this.store.createApiKey({ id: String(input.id ?? "").trim() || undefined, name: String(input.name ?? "").trim() || undefined, provider: provider as ApiProviderKind, apiKey: String(input.apiKey ?? ""), model: input.model, accountId: input.accountId });\n    this.clients.delete(record.id);\n    return record;\n  }\n\n  private clientFor`, 'dynamic credential creation');
 s=s.replace('baseURL: providerBaseUrl(account)','baseURL: providerBaseUrl(account, this.providers)');
 s=regexOnce(s,/\nfunction isApiProvider\(value: string\): value is ApiProviderKind \{[\s\S]*?\n}\nfunction isAuthenticationError/, '\nfunction isAuthenticationError', 'remove hardcoded provider guard');
 s=once(s,`function credentialIdFromPath(pathname: string): string {
  const id = decodeURIComponent(pathname.split("/")[3]);
  validateId(id);
  return id;
}`,`function credentialIdFromPath(pathname: string): string {\n  const id = decodeURIComponent(pathname.split("/")[3]);\n  validateId(id);\n  return id;\n}\nfunction providerIdFromPath(pathname: string): string {\n  const id = decodeURIComponent(pathname.split("/")[3]);\n  if (!/^custom-[a-f0-9]{12}$/.test(id)) throw new OpenAICCError("Invalid custom provider id.", 400, "invalid_provider");\n  return id;\n}\nfunction enforceContextLimit(limit: number, body: AnthropicRequest): void {\n  const estimated = estimateAnthropicTokens(body);\n  if (estimated > limit) throw new OpenAICCError(\`Estimated input (\${estimated} tokens) exceeds this route's \${limit}-token context limit.\`, 400, "context_window_exceeded", { estimatedInputTokens: estimated, contextWindow: limit });\n}`,'dispatcher helpers');
 await save(file,s);
}

// Model store helper used to block custom provider deletion while routed.
{
 const file='src/model-config.ts'; let s=await text(file);
 s=once(s,`  pinnedSlotsForCredential(id: string): ModelSlot[] {
    return MODEL_SLOTS.filter((slot) => this.state.routes[slot].credentialId === id);
  }`,`  pinnedSlotsForCredential(id: string): ModelSlot[] {\n    return MODEL_SLOTS.filter((slot) => this.state.routes[slot].credentialId === id);\n  }\n\n  slotsForProvider(provider: string): ModelSlot[] {\n    return MODEL_SLOTS.filter((slot) => this.state.routes[slot].provider === provider);\n  }`,'provider route usage helper');
 await save(file,s);
}

// Production dispatcher keeps ChatGPT's raw boundary untouched; only generic upstreams consult provider metadata.
{
 const file='src/replicated-dispatcher.ts'; let s=await text(file);
 s=once(s,`import { providerBaseUrl } from "./provider-registry.js";`,`import { ProviderRegistry, providerBaseUrl } from "./provider-registry.js";`,'replicated registry import');
 s=once(s,`  private readonly clientFactory?: (account: AccountRecord) => any;`,`  private readonly clientFactory?: (account: AccountRecord) => any;\n  private readonly providers: ProviderRegistry;`,'replicated registry member');
 s=once(s,`    this.controlPlane = new Dispatcher(store, models, options);
    this.clientFactory = options.clientFactory;
    store.on("event", () => this.clients.clear());`,`    this.providers = options.providerRegistry ?? new ProviderRegistry();\n    this.controlPlane = new Dispatcher(store, models, { ...options, providerRegistry: this.providers });\n    this.clientFactory = options.clientFactory;\n    store.on("event", () => this.clients.clear());\n    this.providers.on("event", () => this.clients.clear());`,'replicated registry init');
 s=once(s,`import {
  AnthropicRequest,
  AnthropicSseTranslator,
  OpenAIToolNameCodec,
  responsesToAnthropic,
} from "./translator.js";`,`import {\n  AnthropicRequest,\n  AnthropicSseTranslator,\n  OpenAIToolNameCodec,\n  estimateAnthropicTokens,\n  responsesToAnthropic,\n} from "./translator.js";`,'replicated estimator import');
 s=once(s,`    const routedBody: AnthropicRequest = {
      ...body,
      max_tokens: Math.max(1, Math.min(Math.floor(requestedMaxTokens), route.maxOutputTokens)),
    };`,`    const routedBody: AnthropicRequest = {\n      ...body,\n      max_tokens: Math.max(1, Math.min(Math.floor(requestedMaxTokens), route.maxOutputTokens)),\n    };\n    const contextWindow = this.models.contextWindowForRequestedModel(body.model);\n    const estimatedInput = estimateAnthropicTokens(body);\n    if (estimatedInput > contextWindow) return void anthropicError(res, 400, "invalid_request_error", \`context_window_exceeded: estimated input \${estimatedInput} exceeds this route's \${contextWindow}-token limit.\`);`,'production context enforcement');
 s=s.replace('if (upstreamApiFor(account.provider, model) === "responses")','if (upstreamApiFor(account.provider, model, this.providers) === "responses")');
 s=s.replace('baseURL: providerBaseUrl(account)','baseURL: providerBaseUrl(account, this.providers)');
 await save(file,s);
}

// Production startup initializes providers before model config so custom routes survive restarts.
{
 const file='src/index-replicated.ts'; let s=await text(file);
 s=once(s,`import { ReplicatedDispatcher } from "./replicated-dispatcher.js";`,`import { ReplicatedDispatcher } from "./replicated-dispatcher.js";\nimport { ProviderRegistry } from "./provider-registry.js";`,'index registry import');
 s=once(s,`const store = new AccountStore(dataDir);
await store.init();
const modelConfig = new ModelConfigStore(dataDir, store);
await modelConfig.init();`,`const store = new AccountStore(dataDir);\nawait store.init();\nconst providers = new ProviderRegistry(dataDir);\nawait providers.init();\nconst modelConfig = new ModelConfigStore(dataDir, store, providers);\nawait modelConfig.init();`,'startup registry');
 s=s.replace('configureClaudeCode(baseUrl, modelConfig.snapshot())','configureClaudeCode(baseUrl, modelConfig.snapshot(), providers)');
 s=s.replace('configureClaudeDesktop(baseUrl, modelConfig.snapshot())','configureClaudeDesktop(baseUrl, modelConfig.snapshot(), providers)');
 s=s.replace('new ReplicatedDispatcher(store, modelConfig, { bindHost: host })','new ReplicatedDispatcher(store, modelConfig, { bindHost: host, providerRegistry: providers })');
 await save(file,s);
}

// Session 4 Admin UI: backend provider metadata drives provider selectors; custom provider workflow is added in-place.
{
 const file='src/admin/page.ts'; let s=await text(file);
 s=once(s,`<section id="models-section" class="surface">`,`<section class="surface" id="custom-providers-section"><div class="section-head"><h2>Custom providers</h2><span class="section-note">OpenAI-compatible endpoints</span></div><div class="section-note">Define reusable providers here. API keys remain separate credentials and are never returned to the browser.</div><div id="custom-providers" class="credentials"></div><form id="provider-form" class="form-card" style="margin-top:14px"><h3>Add custom provider</h3><div class="route-fields"><div class="field"><label for="provider-name">Display name</label><input id="provider-name" maxlength="120" required placeholder="My provider"></div><div class="field"><label for="provider-url">Base URL</label><input id="provider-url" required placeholder="https://example.com/v1"></div><div class="field"><label for="provider-style">API style</label><select id="provider-style"><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></div><div class="field"><button type="submit">Add provider</button></div></div><div id="provider-status" class="status"></div></form></section>\n<section id="models-section" class="surface">`,'custom provider UI section');
 s=once(s,`const boot=window.__OPENAI_CC__,primarySlots=['fable','opus','sonnet','haiku'],slots=['default',...primarySlots],providers=['chatgpt','zen','nvidia','google','cloudflare'];let state=null,modelFormDirty=false,activeJobId=null,jobTimer=null;const discovered=new Map(),discoveryErrors=new Map(),discoveryLoading=new Set();`,`const boot=window.__OPENAI_CC__,primarySlots=['fable','opus','sonnet','haiku'],slots=['default',...primarySlots];let state=null,modelFormDirty=false,activeJobId=null,jobTimer=null;const discovered=new Map(),discoveryErrors=new Map(),discoveryLoading=new Set();`,'remove frontend provider list');
 s=regexOnce(s,/function providerName\(p\)\{return p==='chatgpt'\?[\s\S]*?\}/,`function providerMeta(id){return (state?.providers||[]).find(p=>p.id===id)}\nfunction providerName(id){return providerMeta(id)?.displayName||id}\nfunction providerIds(){return (state?.providers||[]).map(p=>p.id)}`,'dynamic provider names');
 s=s.replace(`function renderAll(){renderSystem();renderRoutes();renderCredentials();renderCatalogs();`,`function renderAll(){renderSystem();renderProviderControls();renderRoutes();renderCredentials();renderCustomProviders();renderCatalogs();`);
 s=s.replace(`function providerOptions(selected){return providers.map(p=>'<option value="'+p+'" '+(p===selected?'selected':'')+'>'+providerName(p)+'</option>').join('')}`,`function providerOptions(selected){return providerIds().map(p=>'<option value="'+esc(p)+'" '+(p===selected?'selected':'')+'>'+esc(providerName(p))+'</option>').join('')}`);
 s=once(s,`function providerModels(provider){const byId=new Map();for(const a of state.accounts.filter(a=>a.provider===provider)){for(const m of discovered.get(a.id)||[]){if(!byId.has(m.upstreamModelId))byId.set(m.upstreamModelId,m)}}return [...byId.values()].sort((a,b)=>String(a.friendlyName||a.upstreamModelId).localeCompare(String(b.friendlyName||b.upstreamModelId)))}`,
`function providerModels(provider){const byId=new Map();const meta=providerMeta(provider);for(const m of meta?.models||[]){byId.set(m.id,{provider,upstreamModelId:m.id,friendlyName:m.id,availability:'available',contextWindow:m.contextWindow||200000,maxOutputTokens:m.maxOutputTokens||16384,capabilities:{text:true,image:false,tools:false,streaming:true,reasoning:false}})}for(const a of state.accounts.filter(a=>a.provider===provider)){for(const m of discovered.get(a.id)||[]){if(!byId.has(m.upstreamModelId))byId.set(m.upstreamModelId,m)}}return [...byId.values()].sort((a,b)=>String(a.friendlyName||a.upstreamModelId).localeCompare(String(b.friendlyName||b.upstreamModelId)))}`,'manual models into routes');
 s=once(s,`function syncAccountField(){const cloudflare=document.querySelector('#key-provider').value==='cloudflare',wrap=document.querySelector('#key-account-wrap'),field=document.querySelector('#key-account');wrap.classList.toggle('hidden',!cloudflare);field.required=cloudflare}`,
`function renderProviderControls(){const select=document.querySelector('#key-provider');if(!select||!state)return;const current=select.value;select.innerHTML=(state.providers||[]).filter(p=>p.credentialType==='api-key').map(p=>'<option value="'+esc(p.id)+'">'+esc(p.displayName)+'</option>').join('');if([...select.options].some(o=>o.value===current))select.value=current;syncAccountField()}\nfunction syncAccountField(){const cloudflare=document.querySelector('#key-provider').value==='cloudflare',wrap=document.querySelector('#key-account-wrap'),field=document.querySelector('#key-account');wrap.classList.toggle('hidden',!cloudflare);field.required=cloudflare}`,'dynamic credential provider selector');
 const insertBefore=`function relative(value){`;
 const customFns=`function renderCustomProviders(){const root=document.querySelector('#custom-providers');if(!root||!state)return;const items=(state.providers||[]).filter(p=>p.custom);root.innerHTML=items.length?items.map(customProviderCard).join(''):'<div class="empty">No custom providers configured.</div>';root.querySelectorAll('[data-provider-action]').forEach(btn=>btn.addEventListener('click',()=>providerAction(btn)));root.querySelectorAll('[data-manual-model]').forEach(form=>form.addEventListener('submit',saveManualModel))}\nfunction customProviderCard(p){const models=(p.models||[]).map(m=>'<div class="credential-line">'+esc(m.id)+' · '+Number(m.contextWindow||200000).toLocaleString()+' context · '+Number(m.maxOutputTokens||16384).toLocaleString()+' output</div>').join('');return '<article class="credential"><div class="credential-head"><div class="credential-title"><h3>'+esc(p.displayName)+'</h3><p>'+esc(p.id)+' · '+esc(p.apiStyle)+'</p></div></div><div class="actions"><button type="button" class="small secondary" data-provider-action="edit" data-id="'+esc(p.id)+'">Edit</button><button type="button" class="small danger" data-provider-action="delete" data-id="'+esc(p.id)+'">Remove</button></div>'+models+'<form class="replace form-stack" data-manual-model="'+esc(p.id)+'"><div class="field"><label>Manual model ID</label><input name="id" required maxlength="256" placeholder="model-id"></div><div class="field"><label>Context limit</label><input name="contextWindow" type="number" min="1" placeholder="Optional — defaults 200000"></div><div class="field"><label>Output limit</label><input name="maxOutputTokens" type="number" min="1" placeholder="Optional — defaults 16384"></div><button type="submit">Add / update model</button><span class="status"></span></form></article>'}\nasync function addProvider(event){event.preventDefault();const status=document.querySelector('#provider-status'),buttonEl=event.currentTarget.querySelector('button[type=submit]');setBusy(buttonEl,true,'Adding…');try{await api('/admin/providers',{method:'POST',body:JSON.stringify({displayName:document.querySelector('#provider-name').value,baseUrl:document.querySelector('#provider-url').value,apiStyle:document.querySelector('#provider-style').value})});event.currentTarget.reset();status.textContent='Provider added.';status.className='status success';await refreshAll()}catch(e){status.textContent=e.message;status.className='status error'}finally{setBusy(buttonEl,false)}}\nasync function providerAction(btn){const id=btn.dataset.id,p=providerMeta(id);if(btn.dataset.providerAction==='delete'){if(!confirm('Remove '+p.displayName+'?'))return;try{await api('/admin/providers/'+encodeURIComponent(id),{method:'DELETE',body:'{}'});await refreshAll()}catch(e){alert(e.message)}return}const name=prompt('Display name',p.displayName);if(name===null)return;const baseUrl=prompt('Base URL',p.baseUrl||'');if(baseUrl===null)return;const apiStyle=prompt('API style: chat-completions or responses',p.apiStyle);if(apiStyle===null)return;try{await api('/admin/providers/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({displayName:name,baseUrl,apiStyle})});await refreshAll()}catch(e){alert(e.message)}}\nasync function saveManualModel(event){event.preventDefault();const form=event.currentTarget,status=form.querySelector('.status'),buttonEl=form.querySelector('button');setBusy(buttonEl,true,'Saving…');try{await api('/admin/providers/'+encodeURIComponent(form.dataset.manualModel)+'/models',{method:'POST',body:JSON.stringify({id:form.id.value,contextWindow:form.contextWindow.value||undefined,maxOutputTokens:form.maxOutputTokens.value||undefined})});status.textContent='Model saved.';status.className='status success';form.reset();await refreshAll()}catch(e){status.textContent=e.message;status.className='status error'}finally{setBusy(buttonEl,false)}}\n`;
 s=once(s,insertBefore,customFns+insertBefore,'custom provider UI functions');
 s=s.replace(`document.querySelector('#key-provider').addEventListener('change',syncAccountField);`,`document.querySelector('#key-provider').addEventListener('change',syncAccountField);document.querySelector('#provider-form').addEventListener('submit',addProvider);`);
 s=s.replace(`['credentials_changed','credential_status_changed','preferred_changed','auth_job_changed']`,`['credentials_changed','credential_status_changed','preferred_changed','auth_job_changed','providers_changed']`);
 s=s.replace(`state=next;pruneDiscovery();renderSystem();renderCredentials();renderCatalogs();`,`state=next;pruneDiscovery();renderSystem();renderProviderControls();renderCredentials();renderCustomProviders();renderCatalogs();`);
 await save(file,s);
}

// Claude Code CI probes now match the new route-specific capability plan.
{
 const file='scripts/verify-claude-code-context.mjs'; let s=await text(file);
 s=regexOnce(s,/const probes = \[[\s\S]*?\n\];/,
`const probes = [\n  ["default/deepseek-free", configured.ANTHROPIC_MODEL, 0, 250000],\n  ["fable/terra", configured.ANTHROPIC_DEFAULT_FABLE_MODEL, 850000, Infinity],\n  ["opus/deepseek-free", configured.ANTHROPIC_DEFAULT_OPUS_MODEL, 0, 250000],\n  ["sonnet/gemini-flash-lite", configured.ANTHROPIC_DEFAULT_SONNET_MODEL, 850000, Infinity],\n  ["haiku/gemini-flash-lite", configured.ANTHROPIC_DEFAULT_HAIKU_MODEL, 850000, Infinity],\n];`,'client context probes');
 await save(file,s);
}

// Update existing assertions that encode the pre-4.5 defaults; add focused integration coverage separately.
{
 let f='tests/model-config.test.ts',s=await text(f);
 s=s.replace('default routing selects Cloudflare Gemma for Sonnet and Haiku with conservative caps','fresh routing uses DeepSeek Default/Opus, Terra Fable, and Gemini Flash-Lite Sonnet/Haiku');
 s=s.replace(`assert.deepEqual(config.routes.default, { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 });`,`assert.deepEqual(config.routes.default, { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 });`);
 s=s.replace(`assert.deepEqual(config.routes.sonnet, { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 16384 });\n  assert.deepEqual(config.routes.haiku, { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 16384 });`,`assert.deepEqual(config.routes.sonnet, { provider: "google", model: "gemini-3.5-flash-lite", maxOutputTokens: 65536 });\n  assert.deepEqual(config.routes.haiku, { provider: "google", model: "gemini-3.5-flash-lite", maxOutputTokens: 65536 });`);
 s=s.replace(`assert.equal(contextWindowForRoute(config, "default"), 850000);`,`assert.equal(contextWindowForRoute(config, "default"), 200000);`);
 s=s.replace(`assert.equal(contextWindowForRoute(config, "sonnet"), 200000);\n  assert.equal(contextWindowForRoute(config, "haiku"), 200000);`,`assert.equal(contextWindowForRoute(config, "sonnet"), 850000);\n  assert.equal(contextWindowForRoute(config, "haiku"), 850000);`);
 s=s.replace(`assert.equal(claudeCodeModelAlias(config, "default"), "claude-opus-4-8[1m]");`,`assert.equal(claudeCodeModelAlias(config, "default"), "claude-opus-4-8");`);
 s=s.replace(`assert.equal(claudeCodeModelAlias(config, "sonnet"), "claude-sonnet-4-6");\n  assert.equal(claudeCodeModelAlias(config, "haiku"), "claude-haiku-4-5");`,`assert.equal(claudeCodeModelAlias(config, "sonnet"), "claude-sonnet-5");\n  assert.equal(claudeCodeModelAlias(config, "haiku"), "claude-opus-4-7[1m]");`);
 s=s.replace(`assert.equal(models.slotForRequestedModel("claude-sonnet-4-6"), "sonnet");\n  assert.equal(models.slotForRequestedModel("claude-haiku-4-5"), "haiku");`,`assert.equal(models.slotForRequestedModel("claude-sonnet-5"), "sonnet");\n  assert.equal(models.slotForRequestedModel("claude-opus-4-7[1m]"), "haiku");`);
 s=regexOnce(s,/test\("load migration replaces only the old default Gemini Sonnet and Haiku routes"[\s\S]*?\n}\);\n?$/,
`test("existing user-selected routes survive upgrade unchanged", async () => {\n  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-model-preserve-"));\n  const accounts = new AccountStore(root); await accounts.init();\n  await writeFile(path.join(root, "model-config.json"), JSON.stringify({\n    contextWindow: 850000, routes: {\n      default: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },\n      fable: { provider: "chatgpt", model: "gpt-5.6-terra", maxOutputTokens: 128000 },\n      opus: { provider: "zen", model: "deepseek-v4-flash-free", maxOutputTokens: 128000 },\n      sonnet: { provider: "google", model: "gemini-3.6-flash", maxOutputTokens: 32000 },\n      haiku: { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 16384 },\n    },\n  }));\n  const models = new ModelConfigStore(root, accounts); await models.init();\n  assert.equal(models.snapshot().routes.sonnet.model, "gemini-3.6-flash");\n  assert.equal(models.snapshot().routes.sonnet.maxOutputTokens, 32000);\n  assert.equal(models.snapshot().routes.haiku.provider, "cloudflare");\n  accounts.close();\n});\n`,'preserve routes test');
 await save(f,s);
}
{
 let f='tests/admin-ui.test.ts',s=await text(f);
 s=s.replace(`assert.equal(state.modelConfig.routes.sonnet.provider, "cloudflare");\n    assert.equal(state.modelConfig.routes.sonnet.model, "@cf/google/gemma-4-26b-a4b-it");`,`assert.equal(state.modelConfig.routes.sonnet.provider, "google");\n    assert.equal(state.modelConfig.routes.sonnet.model, "gemini-3.5-flash-lite");`);
 s=s.replace(`assert.equal(publicJson.includes("@cf/google/gemma-4-26b-a4b-it"), false);`,`assert.equal(publicJson.includes("gemini-3.5-flash-lite"), false);`);
 s=s.replace(`assert.match(f.html, /<h2>Available models<\\/h2>/);`,`assert.match(f.html, /<h2>Available models<\\/h2>/);\n    assert.match(f.html, /<h2>Custom providers<\\/h2>/);`);
 await save(f,s);
}
{
 let f='tests/provider-registry.test.ts',s=await text(f);
 s=s.replace(`assert.equal(sonnet.max_input_tokens, 200000);\n  assert.equal(haiku.max_input_tokens, 200000);\n  assert.equal(sonnet.max_tokens, 16384);`,`assert.equal(sonnet.max_input_tokens, 850000);\n  assert.equal(haiku.max_input_tokens, 850000);\n  assert.equal(sonnet.max_tokens, 65536);`);
 await save(f,s);
}

// Focused Session 4.5 tests exercise persistence, manual discovery fallback, both custom wire APIs,
// production Gemini semantics, same-provider rotation and secret redaction without requiring external secrets.
await save('tests/session45.test.ts', `import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/account-store.js";
import { ModelConfigStore, contextWindowForRoute } from "../src/model-config.js";
import { GEMINI_FLASH_LITE_MODEL, ProviderRegistry, knownModelMetadata } from "../src/provider-registry.js";
import { createReplicatedServer } from "../src/replicated-dispatcher.js";
import { upstreamApiFor } from "../src/upstream-api.js";

async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),"openai-cc-s45-"));const store=new AccountStore(root);await store.init();const providers=new ProviderRegistry(root);await providers.init();const models=new ModelConfigStore(root,store,providers);await models.init();return{root,store,providers,models};}
async function listen(server:any){await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const a=server.address();if(!a||typeof a==="string")throw new Error("bad address");return \`http://127.0.0.1:\${a.port}\`;}
async function close(server:any){await new Promise<void>(r=>server.close(()=>r()));}

test("Gemini Flash-Lite metadata and fresh route contexts are capped correctly",async()=>{const f=await fixture();const meta=knownModelMetadata("google",GEMINI_FLASH_LITE_MODEL);assert.equal(meta?.contextWindow,1_048_576);assert.equal(meta?.maxOutputTokens,65_536);const c=f.models.snapshot();assert.equal(contextWindowForRoute(c,"default",f.providers),200_000);assert.equal(contextWindowForRoute(c,"opus",f.providers),200_000);assert.equal(contextWindowForRoute(c,"fable",f.providers),850_000);assert.equal(contextWindowForRoute(c,"sonnet",f.providers),850_000);assert.equal(contextWindowForRoute(c,"haiku",f.providers),850_000);f.store.close();});

test("custom providers persist with stable ids and conservative unknown limits",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"Local OpenAI",baseUrl:"https://example.invalid/v1/",apiStyle:"chat-completions"});assert.match(p.id,/^custom-[a-f0-9]{12}$/);await f.providers.upsertManualModel(p.id,{id:"manual/model",contextWindow:500000,maxOutputTokens:32000});const reloaded=new ProviderRegistry(f.root);await reloaded.init();assert.equal(reloaded.getCustom(p.id)?.baseUrl,"https://example.invalid/v1");assert.equal(reloaded.metadata(p.id,"manual/model")?.contextWindow,500000);assert.equal(reloaded.metadata(p.id,"unknown")?.contextWindow,200000);assert.equal(reloaded.metadata(p.id,"unknown")?.maxOutputTokens,16384);const disk=await readFile(path.join(f.root,"providers.json"),"utf8");assert.equal(/api.?key|secret/i.test(disk),false);f.store.close();});

test("custom /models discovery enriches manual limits and keeps Authorization out of results",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"Discovery",baseUrl:"https://provider.invalid/v1",apiStyle:"chat-completions"});await f.providers.upsertManualModel(p.id,{id:"m1",contextWindow:700000,maxOutputTokens:50000});const account=await f.store.createApiKey({provider:p.id,apiKey:"do-not-expose"});let auth="";const result=await f.providers.discover(account,(async(_u,init)=>{auth=new Headers(init?.headers).get("authorization")||"";return new Response(JSON.stringify({data:[{id:"m1"},{id:"m2"}]}),{status:200});})as typeof fetch);assert.equal(auth,"Bearer do-not-expose");assert.equal(result[0].contextWindow,700000);assert.equal(result[1].contextWindow,200000);assert.equal(JSON.stringify(result).includes("do-not-expose"),false);f.store.close();});

test("custom API style selects Chat Completions or Responses without touching ChatGPT",async()=>{const f=await fixture();const chat=await f.providers.createCustom({displayName:"Chat",baseUrl:"https://chat.invalid/v1",apiStyle:"chat-completions"});const responses=await f.providers.createCustom({displayName:"Responses",baseUrl:"https://responses.invalid/v1",apiStyle:"responses"});assert.equal(upstreamApiFor(chat.id,"m",f.providers),"chat-completions");assert.equal(upstreamApiFor(responses.id,"m",f.providers),"responses");assert.equal(upstreamApiFor("chatgpt","gpt-5.6-terra",f.providers),"responses");f.store.close();});

test("production Gemini Sonnet path carries vision, tools, multi-turn tool results, streaming and output cap",async()=>{const f=await fixture();await f.store.createApiKey({id:"g1",provider:"google",apiKey:"secret"});let captured:any;const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers,clientFactory:()=>({chat:{completions:{create:async(req:any)=>{captured=req;if(req.stream)return(async function*(){yield{id:"s",choices:[{delta:{content:"ok"}}]};yield{id:"s",choices:[{delta:{},finish_reason:"stop"}],usage:{completion_tokens:1}}})();return{id:"r",choices:[{message:{content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:1}};}}}})});const base=await listen(server);try{let r=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"sonnet",max_tokens:999999,tools:[{name:"lookup",input_schema:{type:"object",properties:{}}}],messages:[{role:"user",content:[{type:"text",text:"classify"},{type:"image",source:{type:"base64",media_type:"image/png",data:"aGVsbG8="}}]},{role:"assistant",content:[{type:"tool_use",id:"t1",name:"lookup",input:{}}]},{role:"user",content:[{type:"tool_result",tool_use_id:"t1",content:"done"}]}]})});assert.equal(r.status,200);assert.equal(captured.model,GEMINI_FLASH_LITE_MODEL);assert.equal(captured.max_tokens,65536);assert.equal(captured.messages[0].content[1].type,"image_url");assert.equal(captured.messages[1].tool_calls[0].id,"t1");assert.equal(captured.messages[2].role,"tool");r=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"haiku",max_tokens:16,stream:true,messages:[{role:"user",content:"subagent compacted continuation"}]})});assert.equal(r.status,200);assert.match(await r.text(),/message_stop/);}finally{await close(server);}});

test("production custom credential rotation stays provider-local for 401 and 429",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"Rotating",baseUrl:"https://rotate.invalid/v1",apiStyle:"chat-completions"});await f.store.createApiKey({id:"c1",provider:p.id,apiKey:"one"});await f.store.createApiKey({id:"c2",provider:p.id,apiKey:"two"});await f.providers.upsertManualModel(p.id,{id:"m",contextWindow:300000,maxOutputTokens:32000});const cfg=f.models.snapshot();cfg.routes.sonnet={provider:p.id,model:"m",maxOutputTokens:32000};await f.models.update(cfg);const calls:string[]=[];const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers,clientFactory:(a)=>({chat:{completions:{create:async()=>{calls.push(a.id);if(a.id==="c1")throw Object.assign(new Error("401 token=hidden"),{status:401});return{id:"ok",choices:[{message:{content:"ok"},finish_reason:"stop"}]};}}}})});const base=await listen(server);try{const r=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"sonnet",max_tokens:8,messages:[{role:"user",content:"hi"}]})});assert.equal(r.status,200);assert.deepEqual(calls,["c1","c2"]);assert.equal(f.store.publicGet("c1")?.status,"auth_error");}finally{await close(server);}});
`);

console.log('Session 4.5 source transformation applied.');
