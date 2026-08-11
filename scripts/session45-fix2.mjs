import { readFile, writeFile } from 'node:fs/promises';

async function edit(file, fn) {
  const before = await readFile(file, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`No change made to ${file}`);
  await writeFile(file, after, 'utf8');
}
function one(s, a, b, label) {
  if (!s.includes(a)) throw new Error(`Missing ${label}`);
  return s.replace(a, b);
}
function rex(s, re, b, label) {
  if (!re.test(s)) throw new Error(`Missing ${label}`);
  return s.replace(re, b);
}

await edit('src/model-config.ts', s => one(
  s,
  'const explicit = slotForClaudeCodeModel(this.state, id);',
  'const explicit = slotForClaudeCodeModel(this.state, id, this.providers);',
  'registry-aware alias lookup',
));

await edit('src/provider-registry.ts', s => {
  s = one(s,
    '  models: ManualModelDefinition[];\n}\nexport interface ProviderDefinition {',
    '  models: ManualModelDefinition[];\n  baseUrl?: string;\n}\nexport interface ProviderDefinition {',
    'public provider baseUrl type');
  s = one(s,
    '      custom: true, requiresAccountId: false, supportsModelDiscovery: true, models: record.models.map((model) => ({ ...model })),\n',
    '      custom: true, requiresAccountId: false, supportsModelDiscovery: true, models: record.models.map((model) => ({ ...model })), baseUrl: record.baseUrl,\n',
    'public custom provider baseUrl');
  s = rex(s,
    /private publicFor\(record: CustomProviderRecord\): PublicProviderDefinition \{ return \{([^}]+models:record\.models\.map\(\(m\)=>\(\{\.\.\.m\}\)\)) \}; \}/,
    'private publicFor(record: CustomProviderRecord): PublicProviderDefinition { return { $1,baseUrl:record.baseUrl }; }',
    'provider event public projection');
  return s;
});

await edit('scripts/configure-clients.ts', s => {
  s = one(s,
    'import { ModelConfigStore } from "../src/model-config.js";',
    'import { ModelConfigStore } from "../src/model-config.js";\nimport { ProviderRegistry } from "../src/provider-registry.js";',
    'configure clients provider import');
  s = one(s,
    'const models = new ModelConfigStore(dataDir, store);\nawait models.init();',
    'const providers = new ProviderRegistry(dataDir);\nawait providers.init();\nconst models = new ModelConfigStore(dataDir, store, providers);\nawait models.init();',
    'configure clients registry startup');
  s = one(s, 'const code = await configureClaudeCode(baseUrl, config);', 'const code = await configureClaudeCode(baseUrl, config, providers);', 'configure Claude Code registry');
  s = one(s, 'const desktop = await configureClaudeDesktop(baseUrl, config);', 'const desktop = await configureClaudeDesktop(baseUrl, config, providers);', 'configure Claude Desktop registry');
  return s;
});

await edit('src/admin/page.ts', s => rex(
  s,
  /<select id="key-provider"><option value="cloudflare">Cloudflare Workers AI<\/option><option value="zen">OpenCode Zen<\/option><option value="nvidia">NVIDIA NIM<\/option><option value="google">Google AI Studio<\/option><\/select>/,
  '<select id="key-provider"></select>',
  'backend-driven credential provider select',
));

await edit('tests/claude-desktop.test.ts', s => one(
  s,
  'assert.match(source, /claudeCodeModelAlias\\(config, "fable"\\)/);',
  'assert.match(source, /claudeCodeModelAlias\\(config, "fable", providers\\)/);',
  'Claude config source assertion',
));

await edit('tests/model-config.test.ts', s => one(
  s,
  'aboveVerified.routes.sonnet.maxOutputTokens = 16385;',
  'aboveVerified.routes.sonnet.maxOutputTokens = 65537;',
  'Gemini output cap assertion',
));

await edit('tests/provider-registry.test.ts', s => {
  const setup = '  const models = new ModelConfigStore(root, store); await models.init();\n';
  const routed = setup + '  const routeConfig = models.snapshot();\n  routeConfig.routes.sonnet = { provider: "cloudflare", model: CLOUDFLARE_GEMMA_MODEL, maxOutputTokens: 16384 };\n  await models.update(routeConfig);\n';
  const names = [
    'production dispatcher exposes clean Cloudflare metadata and sends exact model with output/tool/image contracts',
    'production Cloudflare route streams through the real replicated dispatcher',
  ];
  for (const name of names) {
    const start = s.indexOf(`test("${name}"`);
    if (start < 0) throw new Error(`Missing Cloudflare test ${name}`);
    const pos = s.indexOf(setup, start);
    if (pos < 0) throw new Error(`Missing fixture in ${name}`);
    s = s.slice(0, pos) + routed + s.slice(pos + setup.length);
  }
  return s;
});

await edit('tests/session45.test.ts', s => s + `

test("DeepSeek Default enforces the recorded 200K effective context before upstream dispatch",async()=>{const f=await fixture();await f.store.createApiKey({id:"z1",provider:"zen",apiKey:"secret"});let calls=0;const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers,clientFactory:()=>({chat:{completions:{create:async()=>{calls++;return{id:"x",choices:[{message:{content:"unexpected"},finish_reason:"stop"}]};}}}})});const base=await listen(server);try{const response=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"default",max_tokens:8,messages:[{role:"user",content:"x".repeat(730000)}]})});assert.equal(response.status,400);assert.match(await response.text(),/context_window_exceeded/);assert.equal(calls,0);}finally{await close(server);}});

test("Gemini Sonnet accepts long classifier-like traffic beyond 200K while Haiku aliases route as subagents",async()=>{const f=await fixture();await f.store.createApiKey({id:"g1",provider:"google",apiKey:"secret"});const seen:string[]=[];const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers,clientFactory:()=>({chat:{completions:{create:async(req:any)=>{seen.push(req.model);return{id:"ok",choices:[{message:{content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1}};}}}})});const base=await listen(server);try{let response=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"claude-sonnet-5",max_tokens:8,system:"Classify the requested task for Auto Mode.",messages:[{role:"user",content:"x".repeat(730000)}]})});assert.equal(response.status,200);response=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"claude-opus-4-7[1m]",max_tokens:8,messages:[{role:"user",content:"Haiku subagent continuation after compaction"}]})});assert.equal(response.status,200);assert.deepEqual(seen,[GEMINI_FLASH_LITE_MODEL,GEMINI_FLASH_LITE_MODEL]);}finally{await close(server);}});

test("custom Responses provider runs through the production dispatcher with tools and streaming",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"Responses Custom",baseUrl:"https://responses.invalid/v1",apiStyle:"responses"});await f.providers.upsertManualModel(p.id,{id:"resp-model",contextWindow:400000,maxOutputTokens:24000});await f.store.createApiKey({id:"r1",provider:p.id,apiKey:"secret"});const cfg=f.models.snapshot();cfg.routes.sonnet={provider:p.id,model:"resp-model",maxOutputTokens:24000};await f.models.update(cfg);const seen:any[]=[];const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers,clientFactory:()=>({responses:{create:async(req:any)=>{seen.push(req);if(req.stream)return(async function*(){yield{type:"response.output_text.delta",item_id:"msg",output_index:0,delta:"streamed"};yield{type:"response.completed",response:{id:"resp-stream",usage:{input_tokens:1,output_tokens:1}}};})();return{id:"resp",output:[{type:"message",content:[{type:"output_text",text:"done"}]}],usage:{input_tokens:1,output_tokens:1}};}}})});const base=await listen(server);try{let response=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"sonnet",max_tokens:99999,tools:[{name:"lookup",input_schema:{type:"object",properties:{}}}],messages:[{role:"user",content:"use tool"}]})});assert.equal(response.status,200);assert.equal((await response.json() as any).content[0].text,"done");assert.equal(seen[0].model,"resp-model");assert.equal(seen[0].max_output_tokens,24000);assert.equal(seen[0].tools[0].type,"function");response=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"sonnet",max_tokens:8,stream:true,messages:[{role:"user",content:"stream"}]})});assert.equal(response.status,200);assert.match(await response.text(),/streamed/);}finally{await close(server);}});

test("custom provider routes, credentials and explicit limits survive restart",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"Persistent",baseUrl:"https://persist.invalid/v1",apiStyle:"chat-completions"});await f.providers.upsertManualModel(p.id,{id:"persist-model",contextWindow:610000,maxOutputTokens:31000});await f.store.createApiKey({id:"persist-key",provider:p.id,apiKey:"secret"});const cfg=f.models.snapshot();cfg.routes.opus={provider:p.id,model:"persist-model",maxOutputTokens:31000};await f.models.update(cfg);f.store.close();const store2=new AccountStore(f.root);await store2.init();const providers2=new ProviderRegistry(f.root);await providers2.init();const models2=new ModelConfigStore(f.root,store2,providers2);await models2.init();assert.equal(models2.snapshot().routes.opus.provider,p.id);assert.equal(models2.snapshot().routes.opus.model,"persist-model");assert.equal(models2.contextWindowForRequestedModel("opus"),610000);assert.equal(models2.credentialForRequestedModel("opus")?.id,"persist-key");store2.close();});

test("custom provider 429 rotates only to another credential on the same provider",async()=>{const f=await fixture();const p=await f.providers.createCustom({displayName:"429 Custom",baseUrl:"https://limit.invalid/v1",apiStyle:"chat-completions"});await f.providers.upsertManualModel(p.id,{id:"m",contextWindow:300000,maxOutputTokens:16000});await f.store.createApiKey({id:"l1",provider:p.id,apiKey:"one"});await f.store.createApiKey({id:"l2",provider:p.id,apiKey:"two"});await f.store.createApiKey({id:"g-other",provider:"google",apiKey:"other"});const cfg=f.models.snapshot();cfg.routes.haiku={provider:p.id,model:"m",maxOutputTokens:16000};await f.models.update(cfg);const calls:string[]=[];const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers,clientFactory:(a)=>({chat:{completions:{create:async()=>{calls.push(a.id);if(a.id==="l1")throw Object.assign(new Error("429 quota"),{status:429});return{id:"ok",choices:[{message:{content:"ok"},finish_reason:"stop"}]};}}}})});const base=await listen(server);try{const response=await fetch(base+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"haiku",max_tokens:8,messages:[{role:"user",content:"hi"}]})});assert.equal(response.status,200);assert.deepEqual(calls,["l1","l2"]);assert.equal(f.store.publicGet("l1")?.status,"exhausted");}finally{await close(server);}});

test("Admin custom provider CRUD, manual fallback and credentials keep secrets out of state",async()=>{const f=await fixture();const server=createReplicatedServer(f.store,f.models,{bindHost:"127.0.0.1",providerRegistry:f.providers});const base=await listen(server);try{let response=await fetch(base+"/admin/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({displayName:"Admin Custom",baseUrl:"https://custom.invalid/v1",apiStyle:"responses"})});assert.equal(response.status,201);const provider=await response.json() as any;response=await fetch(base+"/admin/providers/"+provider.id,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({displayName:"Admin Custom 2",baseUrl:"https://custom2.invalid/v1",apiStyle:"chat-completions"})});assert.equal(response.status,200);response=await fetch(base+"/admin/providers/"+provider.id+"/models",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"manual",contextWindow:444000,maxOutputTokens:22222})});assert.equal(response.status,200);response=await fetch(base+"/admin/credentials",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:provider.id,apiKey:"never-return-this"})});assert.equal(response.status,201);const credential=await response.json() as any;assert.equal(JSON.stringify(credential).includes("never-return-this"),false);response=await fetch(base+"/admin/state");const stateText=await response.text();assert.equal(stateText.includes("never-return-this"),false);const state=JSON.parse(stateText);const publicProvider=state.providers.find((x:any)=>x.id===provider.id);assert.equal(publicProvider.baseUrl,"https://custom2.invalid/v1");assert.equal(publicProvider.models[0].contextWindow,444000);response=await fetch(base+"/admin/providers/"+provider.id,{method:"DELETE",headers:{"content-type":"application/json"},body:"{}"});assert.equal(response.status,409);response=await fetch(base+"/admin/credentials/"+credential.id,{method:"DELETE",headers:{"content-type":"application/json"},body:"{}"});assert.equal(response.status,200);response=await fetch(base+"/admin/providers/"+provider.id,{method:"DELETE",headers:{"content-type":"application/json"},body:"{}"});assert.equal(response.status,200);}finally{await close(server);}});
`);

console.log('Session 4.5 robust follow-up applied.');
