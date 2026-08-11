import { readFile, writeFile } from 'node:fs/promises';
async function edit(file, fn){ const before=await readFile(file,'utf8'); const after=fn(before); if(after===before) throw new Error(`No change made to ${file}`); await writeFile(file,after,'utf8'); }
function one(s,a,b,label){ if(!s.includes(a)) throw new Error(`Missing ${label}`); return s.replace(a,b); }

await edit('src/model-config.ts', s => one(s,
  'const explicit = slotForClaudeCodeModel(this.state, id);',
  'const explicit = slotForClaudeCodeModel(this.state, id, this.providers);',
  'registry-aware alias lookup'));

await edit('src/provider-registry.ts', s => {
  s=one(s,'  models: ManualModelDefinition[];\n}\nexport interface ProviderDefinition {','  models: ManualModelDefinition[];\n  baseUrl?: string;\n}\nexport interface ProviderDefinition {','public base URL type');
  s=one(s,'      supportsModelDiscovery: true, models: record.models.map((model) => ({ ...model })),','      supportsModelDiscovery: true, models: record.models.map((model) => ({ ...model })), baseUrl: record.baseUrl,','public custom base URL');
  s=one(s,'private publicFor(record: CustomProviderRecord): PublicProviderDefinition { return { id:record.id,displayName:record.displayName,apiStyle:record.apiStyle,credentialType:"api-key",custom:true,requiresAccountId:false,supportsModelDiscovery:true,models:record.models.map((m)=>({...m})) }; }','private publicFor(record: CustomProviderRecord): PublicProviderDefinition { return { id:record.id,displayName:record.displayName,apiStyle:record.apiStyle,credentialType:"api-key",custom:true,requiresAccountId:false,supportsModelDiscovery:true,models:record.models.map((m)=>({...m})),baseUrl:record.baseUrl }; }','event public base URL');
  return s;
});

await edit('scripts/configure-clients.ts', s => {
  s=one(s,'import { ModelConfigStore } from "../src/model-config.js";','import { ModelConfigStore } from "../src/model-config.js";\nimport { ProviderRegistry } from "../src/provider-registry.js";','configure clients provider import');
  s=one(s,'const models = new ModelConfigStore(dataDir, store);\nawait models.init();','const providers = new ProviderRegistry(dataDir);\nawait providers.init();\nconst models = new ModelConfigStore(dataDir, store, providers);\nawait models.init();','configure clients registry startup');
  s=one(s,'const code = await configureClaudeCode(baseUrl, config);','const code = await configureClaudeCode(baseUrl, config, providers);','configure code registry');
  s=one(s,'const desktop = await configureClaudeDesktop(baseUrl, config);','const desktop = await configureClaudeDesktop(baseUrl, config, providers);','configure desktop registry');
  return s;
});

await edit('tests/claude-desktop.test.ts', s => one(s,
  'assert.match(source, /claudeCodeModelAlias\\(config, "fable"\\)/);',
  'assert.match(source, /claudeCodeModelAlias\\(config, "fable", providers\\)/);',
  'Claude config source assertion'));

await edit('tests/model-config.test.ts', s => one(s,
  'aboveVerified.routes.sonnet.maxOutputTokens = 16385;',
  'aboveVerified.routes.sonnet.maxOutputTokens = 65537;',
  'Gemini output cap assertion'));

await edit('tests/provider-registry.test.ts', s => {
  const anchor='  const models = new ModelConfigStore(root, store); await models.init();\n';
  let from=0, count=0, out='';
  while(true){ const i=s.indexOf(anchor,from); if(i<0){out+=s.slice(from);break;} out+=s.slice(from,i)+anchor; count++; if(count===3 || count===4){out+='  const routeConfig = models.snapshot();\n  routeConfig.routes.sonnet = { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 16384 };\n  await models.update(routeConfig);\n';} from=i+anchor.length; }
  if(count<4) throw new Error(`Expected at least four model fixtures, saw ${count}`);
  return out;
});

await edit('tests/session45.test.ts', s => s + `

test("DeepSeek Default enforces the recorded 200K effective context before upstream dispatch",async()=>{const f=await fixture();await f.store.createApiKey({id:"z1",provider:"zen",apiKey:"secret"});let calls=0;const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers,clientFactory:()=>({chat:{completions:{create:async()=>{calls++;return{id:"x",choices:[{message:{content:"unexpected"},finish_reason:"stop"}]};}}}})});const base=await listen(server);try{const response=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"default",max_tokens:8,messages:[{role:"user",content:"x".repeat(730000)}]})});assert.equal(response.status,400);assert.match(await response.text(),/context_window_exceeded/);assert.equal(calls,0);}finally{await close(server);}});

test("Admin custom provider CRUD, manual models and credentials keep secrets out of state",async()=>{const f=await fixture();const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers});const base=await listen(server);try{let response=await fetch(base+"/admin/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({displayName:"Admin Custom",baseUrl:"https://custom.invalid/v1",apiStyle:"responses"})});assert.equal(response.status,201);const provider=await response.json() as any;assert.match(provider.id,/^custom-/);response=await fetch(base+"/admin/providers/"+provider.id,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({displayName:"Admin Custom 2",baseUrl:"https://custom2.invalid/v1",apiStyle:"chat-completions"})});assert.equal(response.status,200);response=await fetch(base+"/admin/providers/"+provider.id+"/models",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"manual",contextWindow:444000,maxOutputTokens:22222})});assert.equal(response.status,200);response=await fetch(base+"/admin/credentials",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:provider.id,apiKey:"never-return-this"})});assert.equal(response.status,201);const credential=await response.json() as any;assert.equal(JSON.stringify(credential).includes("never-return-this"),false);response=await fetch(base+"/admin/state");const stateText=await response.text();assert.equal(stateText.includes("never-return-this"),false);const state=JSON.parse(stateText);const publicProvider=state.providers.find((p:any)=>p.id===provider.id);assert.equal(publicProvider.baseUrl,"https://custom2.invalid/v1");assert.equal(publicProvider.models[0].contextWindow,444000);response=await fetch(base+"/admin/providers/"+provider.id,{method:"DELETE",headers:{"content-type":"application/json"},body:"{}"});assert.equal(response.status,409);response=await fetch(base+"/admin/credentials/"+credential.id,{method:"DELETE",headers:{"content-type":"application/json"},body:"{}"});assert.equal(response.status,200);response=await fetch(base+"/admin/providers/"+provider.id,{method:"DELETE",headers:{"content-type":"application/json"},body:"{}"});assert.equal(response.status,200);}finally{await close(server);}});
`);

console.log('Session 4.5 follow-up fixes applied.');
