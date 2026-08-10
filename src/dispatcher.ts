import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import OpenAI from "openai";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";
import { AccountRecord, AccountStore, ProviderKind, readAuthEmail, validateId } from "./account-store.js";
import { claudeDesktopModel, claudeDesktopModelList } from "./claude-desktop.js";
import { AnthropicRequest, AnthropicSseTranslator, anthropicToResponses, estimateAnthropicTokens, responsesToAnthropic } from "./translator.js";
import { AnthropicChatSseTranslator, anthropicToChatCompletions, chatCompletionToAnthropic } from "./chat-translator.js";
import { ModelConfigStore } from "./model-config.js";

type OAuthJobStatus = "pending" | "complete" | "error";
interface OAuthJob {
  id: string;
  name: string;
  status: OAuthJobStatus;
  startedAt: string;
  finishedAt?: string;
  email?: string;
  error?: string;
}

type ApiProvider = Exclude<ProviderKind, "chatgpt">;

export class Dispatcher {
  private clients = new Map<string, OpenAI>();
  private eventStreams = new Set<ServerResponse>();
  private oauthJobs = new Map<string, OAuthJob>();

  constructor(private readonly store: AccountStore, private readonly models: ModelConfigStore) {
    store.on("event", (event) => {
      const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of this.eventStreams) res.write(payload);
    });
  }

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return void send(res, 204, "");
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return void json(res, 200, { ok: true, contextWindow: this.models.snapshot().contextWindow });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        return void json(res, 200, claudeDesktopModelList(this.models.snapshot(), {
          afterId: url.searchParams.get("after_id") ?? undefined,
          beforeId: url.searchParams.get("before_id") ?? undefined,
          limit,
        }));
      }
      if (req.method === "GET" && /^\/v1\/models\/[^/]+$/.test(url.pathname)) {
        const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
        const model = claudeDesktopModel(this.models.snapshot(), modelId);
        return void json(res, model ? 200 : 404, model ?? { error: { type: "not_found_error", message: `Model not found: ${modelId}` } });
      }
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const body = await readJson<AnthropicRequest>(req);
        return void json(res, 200, { input_tokens: estimateAnthropicTokens(body) });
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") return void await this.handleMessages(req, res);

      if (req.method === "GET" && url.pathname === "/admin") return void html(res, adminHtml());
      if (req.method === "GET" && url.pathname === "/admin/state") return void json(res, 200, { ...this.store.snapshot(), modelConfig: this.models.snapshot() });
      if (req.method === "POST" && url.pathname === "/admin/model-config") {
        const body = await readJson<any>(req);
        return void json(res, 200, await this.models.update(body));
      }
      if (req.method === "GET" && url.pathname === "/admin/events") return void this.handleEventStream(req, res);
      if (req.method === "POST" && url.pathname === "/admin/accounts") {
        const body = await readJson<{ id?: string; name?: string }>(req);
        return void json(res, 202, await this.startBrowserOAuth(body));
      }
      if (req.method === "POST" && url.pathname === "/admin/keys") {
        const body = await readJson<{ id?: string; name?: string; provider?: string; apiKey?: string; model?: string }>(req);
        const record = await this.addApiKey(body);
        return void json(res, 201, publicCredential(record));
      }
      if (req.method === "GET" && /^\/admin\/oauth\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        const job = this.oauthJobs.get(id);
        return void json(res, job ? 200 : 404, job ?? { error: { type: "not_found_error", message: "OAuth job not found" } });
      }
      if (req.method === "POST" && /^\/admin\/accounts\/[^/]+\/activate$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        return void json(res, 200, publicCredential(await this.store.activate(id)));
      }
      if (req.method === "POST" && /^\/admin\/accounts\/[^/]+\/reset$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        return void json(res, 200, publicCredential(await this.store.reset(id)));
      }
      return void json(res, 404, { error: { type: "not_found_error", message: "Not found" } });
    } catch (error: any) {
      return void json(res, 500, { error: { type: "api_error", message: error?.message ?? String(error) } });
    }
  };

  private async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<AnthropicRequest>(req);
    const route = this.models.routeForRequestedModel(body.model);
    const requestedMaxTokens = Number(body.max_tokens) || route.maxOutputTokens;
    const routedBody: AnthropicRequest = {
      ...body,
      max_tokens: Math.max(1, Math.min(Math.floor(requestedMaxTokens), route.maxOutputTokens)),
    };
    const attempted = new Set<string>();
    let account = this.models.credentialForRequestedModel(body.model, attempted);
    if (!account) {
      return void json(res, 409, { error: { type: "handoff_required", message: `No ready ${route.provider} credential is available for ${this.models.slotForRequestedModel(body.model)}.` } });
    }

    while (account && !attempted.has(account.id)) {
      attempted.add(account.id);
      await this.store.noteRequest(account.id);
      const client = this.clientFor(account);
      const model = route.model || account.model || body.model;
      try {
        if (usesResponsesApi(account)) {
          const upstream = { ...anthropicToResponses(routedBody), model } as any;
          if (body.stream) {
            const stream = await client.responses.create({ ...upstream, stream: true });
            beginSse(res);
            const translator = new AnthropicSseTranslator(body.model);
            for await (const event of stream as any) for (const chunk of translator.accept(event)) res.write(chunk);
            if (!res.writableEnded) res.end();
            return;
          }
          const response = await client.responses.create({ ...upstream, stream: false } as any);
          return void json(res, 200, responsesToAnthropic(response, body.model));
        }

        const upstream = anthropicToChatCompletions(routedBody, model) as any;
        if (body.stream) {
          const stream = await client.chat.completions.create({ ...upstream, stream: true });
          beginSse(res);
          const translator = new AnthropicChatSseTranslator(body.model);
          for await (const chunk of stream as any) for (const out of translator.accept(chunk)) res.write(out);
          if (!res.writableEnded) res.end();
          return;
        }
        const response = await client.chat.completions.create({ ...upstream, stream: false } as any);
        return void json(res, 200, chatCompletionToAnthropic(response, body.model));
      } catch (error: any) {
        if (!isRateLimit(error)) throw error;
        const cooldown = rateLimitCooldownMs(error, account);
        if (res.headersSent) {
          await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);
          if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "The configured credential hit a limit after streaming began; a same-provider credential will be used for the next request." } })}\n\n`);
            res.end();
          }
          return;
        }
        account = await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);
        if (!account) return void json(res, 429, { error: { type: "rate_limit_error", message: `All ready ${route.provider} credentials for this model slot are rate-limited.` } });
      }
    }
  }

  private async addApiKey(input: { id?: string; name?: string; provider?: string; apiKey?: string; model?: string }): Promise<AccountRecord> {
    const id = String(input.id ?? "").trim();
    const name = String(input.name ?? id).trim();
    const provider = String(input.provider ?? "").trim().toLowerCase();
    const apiKey = String(input.apiKey ?? "").trim();
    const model = String(input.model ?? "").trim();
    if (!id) throw new Error("Credential id is required.");
    if (!name) throw new Error("Display name is required.");
    validateId(id);
    if (!isApiProvider(provider)) throw new Error("Provider must be zen, nvidia, or google.");
    const record = await this.store.upsertApiKey({ id, name, provider, apiKey, model });
    this.clients.delete(id);
    return record;
  }

  private async startBrowserOAuth(input: { id?: string; name?: string }): Promise<OAuthJob> {
    const id = String(input.id ?? "").trim();
    const name = String(input.name ?? id).trim();
    if (!id) throw new Error("Account id is required.");
    if (!name) throw new Error("Account name is required.");
    validateId(id);
    const existing = this.oauthJobs.get(id);
    if (existing?.status === "pending") throw new Error(`OAuth is already running for ${id}.`);
    const authFile = this.store.authFileFor(id);
    await mkdir(path.dirname(authFile), { recursive: true, mode: 0o700 });
    const job: OAuthJob = { id, name, status: "pending", startedAt: new Date().toISOString() };
    this.oauthJobs.set(id, job);
    const npxArgs = ["--yes", "openai-oauth@latest", "login", "--oauth-file", authFile];
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npx", ...npxArgs], { stdio: "ignore", windowsHide: true })
      : spawn("npx", npxArgs, { stdio: "ignore", windowsHide: true });
    let settled = false;
    const fail = (message: string): void => { if (settled) return; settled = true; job.status = "error"; job.error = message; job.finishedAt = new Date().toISOString(); };
    child.once("error", (error) => fail(error.message));
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      void (async () => {
        if (code !== 0) { job.status = "error"; job.error = `OAuth process exited with code ${code ?? "unknown"}.`; job.finishedAt = new Date().toISOString(); return; }
        try {
          const email = await readAuthEmail(authFile);
          await this.store.upsert({ id, name, email, authFile });
          this.clients.delete(id);
          job.status = "complete"; job.email = email; job.finishedAt = new Date().toISOString();
        } catch (error: any) { job.status = "error"; job.error = error?.message ?? String(error); job.finishedAt = new Date().toISOString(); }
      })();
    });
    return { ...job };
  }

  private clientFor(account: AccountRecord): OpenAI {
    const cached = this.clients.get(account.id);
    if (cached) return cached;
    const provider = account.provider ?? "chatgpt";
    let client: OpenAI;
    if (provider === "chatgpt") {
      if (!account.authFile) throw new Error(`ChatGPT credential ${account.id} has no auth file.`);
      const credentials = openaiCredentials({ authFilePath: account.authFile });
      const transport = createOpenAIOAuthTransport({ auth: () => credentials.getSession() });
      client = new OpenAI({ apiKey: "openai-oauth", baseURL: transport.baseURL, fetch: transport.fetch });
    } else {
      if (!account.apiKey || account.apiKey === "********") throw new Error(`${provider} credential ${account.id} has no API key.`);
      client = new OpenAI({ apiKey: account.apiKey, baseURL: providerBaseUrl(provider) });
    }
    this.clients.set(account.id, client);
    return client;
  }

  private handleEventStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify({ ...this.store.snapshot(), modelConfig: this.models.snapshot() })}\n\n`);
    this.eventStreams.add(res);
    req.on("close", () => this.eventStreams.delete(res));
  }
}

export function createServer(store: AccountStore, models: ModelConfigStore): http.Server {
  const dispatcher = new Dispatcher(store, models);
  return http.createServer((req, res) => { void dispatcher.handler(req, res); });
}

function providerBaseUrl(provider: ApiProvider): string {
  if (provider === "zen") return "https://opencode.ai/zen/v1";
  if (provider === "nvidia") return "https://integrate.api.nvidia.com/v1";
  return "https://generativelanguage.googleapis.com/v1beta/openai/";
}
function usesResponsesApi(account: AccountRecord): boolean { const provider = account.provider ?? "chatgpt"; return provider === "chatgpt" || provider === "zen"; }
function isApiProvider(value: string): value is ApiProvider { return value === "zen" || value === "nvidia" || value === "google"; }
function isRateLimit(error: any): boolean { return error?.status === 429 || error?.statusCode === 429 || /\b429\b|rate.?limit|usage.?limit|quota/i.test(error?.message ?? ""); }
function rateLimitCooldownMs(error: any, account: AccountRecord): number | undefined {
  if ((account.provider ?? "chatgpt") === "chatgpt") return undefined;
  const retryAfter = headerValue(error?.headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter); if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter); if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  const text = `${error?.message ?? ""} ${JSON.stringify(error?.error ?? {})}`;
  const secondsMatch = text.match(/(?:retry|try again)[^\d]{0,20}(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  if (secondsMatch) return Math.ceil(Number(secondsMatch[1]) * 1000);
  return undefined;
}
function headerValue(headers: any, name: string): string | undefined {
  if (!headers) return undefined; if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? String(value[0]) : value !== undefined ? String(value) : undefined;
}
function publicCredential(account: AccountRecord): AccountRecord { const copy = { ...account }; if (copy.apiKey) copy.apiKey = "********"; return copy; }
function beginSse(res: ServerResponse): void { res.statusCode = 200; res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive"); res.flushHeaders(); }
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buf.length; if (bytes > 32 * 1024 * 1024) throw new Error("Request body too large"); chunks.push(buf); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
function send(res: ServerResponse, status: number, body: string): void { res.statusCode = status; res.end(body); }
function json(res: ServerResponse, status: number, body: unknown): void { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }
function html(res: ServerResponse, body: string): void { res.statusCode = 200; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(body); }
function setCors(res: ServerResponse): void { res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1"); res.setHeader("Access-Control-Allow-Headers", "authorization,content-type,x-api-key,anthropic-version,anthropic-beta"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); }

function adminHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenAI-CC</title><style>
body{font:14px system-ui;margin:0;background:#0e1116;color:#e8edf3}.wrap{max-width:1150px;margin:36px auto;padding:0 18px}h1{font-size:24px}.note,.add{background:#171c24;padding:14px;border-radius:10px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:7px 0}.card{display:grid;grid-template-columns:1fr auto;gap:12px;background:#171c24;margin:10px 0;padding:14px;border-radius:10px}.muted{color:#9aa6b2}.ready{color:#73d69c}.exhausted{color:#ff8f8f}button{background:#2b66d9;color:white;border:0;border-radius:7px;padding:8px 12px;cursor:pointer}button.secondary{background:#39414d}input,select{background:#0e1116;color:#e8edf3;border:1px solid #39414d;border-radius:7px;padding:9px;margin:4px 6px 4px 0;min-width:0}.toast{position:fixed;right:20px;bottom:20px;background:#242b36;padding:14px;border-radius:10px;max-width:420px;display:none}@media(max-width:900px){.grid{grid-template-columns:1fr}}</style></head><body><div class="wrap"><h1>OpenAI-CC</h1><div class="note">Claude Code uses <b>Default, Fable, Opus, Sonnet, Haiku</b>. Claude Desktop exposes only Claude-safe aliases for Fable, Opus, Sonnet and Haiku and routes them to the same configured upstream slots.</div><div class="add"><b>Model config</b><div class="muted">Choose a provider, exact upstream model id, output ceiling, and optionally pin a credential id. Leave credential blank to use the first ready credential for that provider.</div><div id="model-config"></div><button onclick="saveModels()">Save model config</button><div id="model-status" class="muted"></div></div><div class="add"><b>Add teammate with ChatGPT OAuth</b><form onsubmit="startOAuth(event)"><input id="oauth-id" required pattern="[A-Za-z0-9._-]{1,64}" placeholder="credential id"><input id="oauth-name" required placeholder="display name"><button type="submit">Add ChatGPT account</button></form><div id="oauth-status" class="muted"></div></div><div class="add"><b>Add API key</b><form onsubmit="addKey(event)"><select id="key-provider"><option value="zen">OpenCode Zen</option><option value="nvidia">NVIDIA NIM</option><option value="google">Google AI Studio</option></select><input id="key-id" required pattern="[A-Za-z0-9._-]{1,64}" placeholder="credential id"><input id="key-name" required placeholder="display name"><input id="key-model" required placeholder="provider model id"><input id="key-value" required type="password" autocomplete="off" placeholder="API key"><button type="submit">Add API key</button></form><div id="key-status" class="muted"></div></div><div id="status" class="muted"></div><div id="accounts"></div></div><div id="toast" class="toast"></div><script>
const slots=['default','fable','opus','sonnet','haiku'];let currentState=null;
async function load(){const s=await fetch('/admin/state').then(r=>r.json());currentState=s;render(s)}
function render(s){document.querySelector('#status').textContent='Credentials: '+s.accounts.length+' · Context: '+s.modelConfig.contextWindow.toLocaleString();document.querySelector('#accounts').innerHTML=s.accounts.map(a=>'<div class="card"><div><b>'+esc(a.name)+'</b> <span class="muted">('+esc(a.id)+')</span><div>'+esc(providerName(a.provider||'chatgpt'))+(a.model?' · '+esc(a.model):'')+(a.email?' · '+esc(a.email):'')+'</div><div class="'+a.status+'">'+a.status+'</div><div class="muted">'+esc(a.lastError||'')+'</div></div><div>'+(a.status==='ready'?'<button onclick="post(\'/admin/accounts/'+encodeURIComponent(a.id)+'/activate\')">Activate</button>':'<button class="secondary" onclick="post(\'/admin/accounts/'+encodeURIComponent(a.id)+'/reset\')">Reset</button>')+'</div></div>').join('');renderModels(s)}
function renderModels(s){const c=s.modelConfig;document.querySelector('#model-config').innerHTML='<div class="grid"><label>Context window<input id="context-window" type="number" min="200000" max="1000000" value="'+c.contextWindow+'"></label></div>'+slots.map(slot=>{const r=c.routes[slot];return '<div class="grid"><b>'+slot[0].toUpperCase()+slot.slice(1)+'</b><select id="p-'+slot+'">'+['chatgpt','zen','nvidia','google'].map(p=>'<option value="'+p+'" '+(p===r.provider?'selected':'')+'>'+providerName(p)+'</option>').join('')+'</select><input id="m-'+slot+'" value="'+esc(r.model)+'" placeholder="upstream model id"><input id="o-'+slot+'" type="number" min="1" max="1000000" value="'+Number(r.maxOutputTokens||64000)+'" placeholder="max output"><input id="c-'+slot+'" value="'+esc(r.credentialId||'')+'" placeholder="credential id (optional)"></div>'}).join('')}
async function saveModels(){const routes={};for(const slot of slots)routes[slot]={provider:document.querySelector('#p-'+slot).value,model:document.querySelector('#m-'+slot).value.trim(),maxOutputTokens:Number(document.querySelector('#o-'+slot).value),credentialId:document.querySelector('#c-'+slot).value.trim()||undefined};const r=await fetch('/admin/model-config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contextWindow:Number(document.querySelector('#context-window').value),routes})});document.querySelector('#model-status').textContent=r.ok?'Saved. Model discovery updates immediately; restart the proxy to refresh Claude Desktop profile labels.':'Save failed';await load()}
function providerName(p){return p==='chatgpt'?'ChatGPT OAuth':p==='zen'?'OpenCode Zen':p==='nvidia'?'NVIDIA NIM':'Google AI Studio'}
async function post(url){await fetch(url,{method:'POST'});load()}
async function addKey(e){e.preventDefault();const provider=document.querySelector('#key-provider').value,id=document.querySelector('#key-id').value.trim(),name=document.querySelector('#key-name').value.trim(),model=document.querySelector('#key-model').value.trim(),apiKey=document.querySelector('#key-value').value.trim(),status=document.querySelector('#key-status');const r=await fetch('/admin/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider,id,name,model,apiKey})});const d=await r.json().catch(()=>({}));status.textContent=r.ok?'Added '+name+'.':(d.error?.message||'Could not add key');if(r.ok)document.querySelector('#key-value').value='';await load()}
async function startOAuth(e){e.preventDefault();const id=document.querySelector('#oauth-id').value.trim(),name=document.querySelector('#oauth-name').value.trim(),status=document.querySelector('#oauth-status');const r=await fetch('/admin/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,name})});const d=await r.json().catch(()=>({}));if(!r.ok){status.textContent=d.error?.message||'Could not start OAuth';return}status.textContent='OAuth started. Complete sign-in in the browser.';watchOAuth(id)}
async function watchOAuth(id){const status=document.querySelector('#oauth-status');const r=await fetch('/admin/oauth/'+encodeURIComponent(id));const d=await r.json().catch(()=>({}));if(d.status==='complete'){status.textContent='Added '+(d.email||d.name)+'.';await load();return}if(d.status==='error'){status.textContent='OAuth failed: '+(d.error||'unknown error');return}setTimeout(()=>watchOAuth(id),1000)}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const es=new EventSource('/admin/events');['changed','activated','rate_limit','state'].forEach(t=>es.addEventListener(t,load));load();</script></body></html>`;
}
