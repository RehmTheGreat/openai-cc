import { readFile, writeFile } from 'node:fs/promises';
async function edit(file, fn){const before=await readFile(file,'utf8');const after=fn(before);if(after===before)throw new Error(`No change: ${file}`);await writeFile(file,after,'utf8');}
function one(s,a,b,label){if(!s.includes(a))throw new Error(`Missing ${label}`);return s.replace(a,b);}

await edit('src/account-store.ts', s => {
  s = s.replace('account.lastError = sanitizeError(message);', 'account.lastError = sanitizeError(message, account.apiKey ? [account.apiKey] : []);');
  if ((s.match(/sanitizeError\(message, account\.apiKey \? \[account\.apiKey\] : \[\]\)/g)||[]).length !== 2) throw new Error('Expected exact-secret sanitization at both status writes');
  s = one(s,
`  private repairPreferences(): void {
    for (const provider of PROVIDERS) {
      const id = this.state.preferredCredentialByProvider[provider];
      if (id && !this.state.accounts.some((account) => account.id === id && account.provider === provider)) {
        delete this.state.preferredCredentialByProvider[provider];
      }
    }
  }`,
`  private repairPreferences(): void {
    for (const [rawProvider, id] of Object.entries(this.state.preferredCredentialByProvider)) {
      const provider = rawProvider as ProviderKind;
      if (id && !this.state.accounts.some((account) => account.id === id && account.provider === provider)) {
        delete this.state.preferredCredentialByProvider[provider];
      }
    }
  }`, 'dynamic preference repair');
  s = one(s,
`function sanitizeError(value: string): string {
  return String(value ?? "")
    .replace(/https?:\\/\\/\\S+/gi, "[redacted-url]")
    .replace(/\\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key|authorization)\\b\\s*[:=]\\s*[^\\s,]+/gi, "$1=[redacted]")
    .replace(/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted-jwt]")
    .slice(0, 1000);
}`,
`function sanitizeError(value: string, exactSecrets: string[] = []): string {
  let safe = String(value ?? "");
  for (const secret of exactSecrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/https?:\\/\\/\\S+/gi, "[redacted-url]")
    .replace(/\\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key|authorization)\\b\\s*[:=]\\s*[^\\s,]+/gi, "$1=[redacted]")
    .replace(/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted-jwt]")
    .slice(0, 1000);
}`, 'secret-aware error sanitizer');
  s = s.replace('\nconst PROVIDERS: ProviderKind[] = ["chatgpt", "zen", "nvidia", "google", "cloudflare"];', '');
  return s;
});

await edit('src/provider-registry.ts', s => {
  s = s.replace('import { OpenAICCError, conflict, notFound } from "./errors.js";', 'import { OpenAICCError, notFound } from "./errors.js";');
  s = s.replace('safeDiscoveryError(responseText,response.status)', 'safeDiscoveryError(responseText,response.status,account.apiKey)');
  if ((s.match(/safeDiscoveryError\(responseText,response\.status,account\.apiKey\)/g)||[]).length !== 2) throw new Error('Expected secret-aware discovery errors in registry and compatibility helper');
  s = one(s,
`function safeDiscoveryError(value:string,status:number):string{try{const parsed=JSON.parse(value)as unknown;if(isRecord(parsed)){if(typeof parsed.message==="string")return redact(parsed.message);if(isRecord(parsed.error)&&typeof parsed.error.message==="string")return redact(parsed.error.message);if(Array.isArray(parsed.errors)){const first=parsed.errors.find((item)=>isRecord(item)&&typeof item.message==="string")as Record<string,unknown>|undefined;if(first&&typeof first.message==="string")return redact(first.message);}}}catch{}return\`Provider model discovery failed with HTTP \${status}.\`;}
function redact(value:string):string{return value.replace(/\\bBearer\\s+[^\\s,;]+/gi,"Bearer [redacted]").replace(/\\bsk-[A-Za-z0-9_-]{8,}/g,"[redacted]").replace(/\\bAIza[A-Za-z0-9_-]{20,}/g,"[redacted]").slice(0,800);}`,
`function safeDiscoveryError(value:string,status:number,exactSecret?:string):string{try{const parsed=JSON.parse(value)as unknown;if(isRecord(parsed)){if(typeof parsed.message==="string")return redact(parsed.message,exactSecret);if(isRecord(parsed.error)&&typeof parsed.error.message==="string")return redact(parsed.error.message,exactSecret);if(Array.isArray(parsed.errors)){const first=parsed.errors.find((item)=>isRecord(item)&&typeof item.message==="string")as Record<string,unknown>|undefined;if(first&&typeof first.message==="string")return redact(first.message,exactSecret);}}}catch{}return\`Provider model discovery failed with HTTP \${status}.\`;}
function redact(value:string,exactSecret?:string):string{let safe=String(value);if(exactSecret)safe=safe.split(exactSecret).join("[redacted]");return safe.replace(/\\bBearer\\s+[^\\s,;]+/gi,"Bearer [redacted]").replace(/\\bsk-[A-Za-z0-9_-]{8,}/g,"[redacted]").replace(/\\bAIza[A-Za-z0-9_-]{20,}/g,"[redacted]").slice(0,800);}`, 'exact discovery secret redaction');
  return s;
});

await edit('src/admin/page.ts', s => one(s,
`async function refreshCredentialState(){const next=await api('/admin/state');state={...(state||{}),...next,modelConfig:state?.modelConfig||next.modelConfig,routeHealth:next.routeHealth};pruneDiscovery();renderSystem();renderCredentials();renderCatalogs();if(!modelFormDirty)renderRoutes();discoverAll(false)}`,
`async function refreshCredentialState(){const next=await api('/admin/state');state={...(state||{}),...next,modelConfig:state?.modelConfig||next.modelConfig,routeHealth:next.routeHealth};pruneDiscovery();renderSystem();renderProviderControls();renderCredentials();renderCustomProviders();renderCatalogs();if(!modelFormDirty)renderRoutes();discoverAll(false)}`, 'provider SSE refresh'));

await edit('tests/session45.test.ts', s => s + `

test("custom preferred credential survives restart and remains first in provider-local rotation",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"Preferred",baseUrl:"https://preferred.invalid/v1",apiStyle:"chat-completions"});await f.store.createApiKey({id:"pref-a",provider:p.id,apiKey:"a"});await f.store.createApiKey({id:"pref-b",provider:p.id,apiKey:"b"});await f.store.prefer("pref-b");f.store.close();const store2=new AccountStore(f.root);await store2.init();assert.equal(store2.preferredId(p.id),"pref-b");assert.deepEqual(store2.orderedReady(p.id).map(x=>x.id),["pref-b","pref-a"]);store2.close();});

test("custom arbitrary API keys are redacted from discovery and stored auth errors",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"Secrets",baseUrl:"https://secrets.invalid/v1",apiStyle:"chat-completions"});const secret="totally-arbitrary-secret-format-42";const account=await f.store.createApiKey({id:"secret-key",provider:p.id,apiKey:secret});await assert.rejects(()=>f.providers.discover(account,(async()=>new Response(JSON.stringify({error:{message:"invalid credential "+secret}}),{status:401}))as typeof fetch),(error:any)=>{assert.equal(String(error.message).includes(secret),false);assert.match(String(error.message),/\\[redacted\\]/);return true;});await f.store.markAuthError(account.id,"upstream echoed "+secret);const publicState=JSON.stringify(f.store.snapshot());assert.equal(publicState.includes(secret),false);assert.equal(f.store.publicGet(account.id)?.lastError?.includes(secret),false);f.store.close();});
`);
console.log('Session 4.5 security finalization applied.');
