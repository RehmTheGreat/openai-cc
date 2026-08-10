import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import OpenAI from "openai";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";
import { AccountRecord, AccountStore, readAuthEmail, validateId } from "./account-store.js";
import { AnthropicRequest, AnthropicSseTranslator, anthropicToResponses, estimateAnthropicTokens, mapModel, responsesToAnthropic } from "./translator.js";

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

export class Dispatcher {
  private clients = new Map<string, OpenAI>();
  private eventStreams = new Set<ServerResponse>();
  private oauthJobs = new Map<string, OAuthJob>();

  constructor(private readonly store: AccountStore) {
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
        return void json(res, 200, { ok: true, activeAccountId: this.store.active()?.id ?? null });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return void json(res, 200, { object: "list", data: modelAliases().map((id) => ({ id, object: "model", created: 0, owned_by: "local-handoff" })) });
      }
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const body = await readJson<AnthropicRequest>(req);
        return void json(res, 200, { input_tokens: estimateAnthropicTokens(body) });
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        return void await this.handleMessages(req, res);
      }

      if (req.method === "GET" && url.pathname === "/admin") return void html(res, adminHtml());
      if (req.method === "GET" && url.pathname === "/admin/state") return void json(res, 200, this.store.snapshot());
      if (req.method === "GET" && url.pathname === "/admin/events") return void this.handleEventStream(req, res);
      if (req.method === "POST" && url.pathname === "/admin/accounts") {
        const body = await readJson<{ id?: string; name?: string }>(req);
        return void json(res, 202, await this.startBrowserOAuth(body));
      }
      if (req.method === "GET" && /^\/admin\/oauth\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        const job = this.oauthJobs.get(id);
        return void json(res, job ? 200 : 404, job ?? { error: { type: "not_found_error", message: "OAuth job not found" } });
      }
      if (req.method === "POST" && /^\/admin\/accounts\/[^/]+\/activate$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        return void json(res, 200, await this.store.activate(id));
      }
      if (req.method === "POST" && /^\/admin\/accounts\/[^/]+\/reset$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        return void json(res, 200, await this.store.reset(id));
      }
      return void json(res, 404, { error: { type: "not_found_error", message: "Not found" } });
    } catch (error: any) {
      return void json(res, 500, { error: { type: "api_error", message: error?.message ?? String(error) } });
    }
  };

  private async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<AnthropicRequest>(req);
    const upstream = anthropicToResponses(body) as any;
    let account = this.store.active() ?? this.store.suggestedNext();
    if (!account) {
      return void json(res, 409, {
        error: {
          type: "handoff_required",
          message: "No account is ready. Wait for a five-hour reset or add an account in the admin workflow.",
        },
      });
    }
    if (!this.store.active()) account = await this.store.activate(account.id);

    const attempted = new Set<string>();
    while (account && !attempted.has(account.id)) {
      attempted.add(account.id);
      await this.store.noteRequest(account.id);
      const client = this.clientFor(account);

      try {
        if (body.stream) {
          // Do not expose a successful streaming response until the upstream stream object exists.
          // A pre-stream 429 can therefore fail over without Claude Code ever seeing it.
          const stream = await client.responses.create({ ...upstream, stream: true });
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders();

          const translator = new AnthropicSseTranslator(body.model);
          for await (const event of stream as any) {
            for (const chunk of translator.accept(event)) res.write(chunk);
          }
          if (!res.writableEnded) res.end();
          return;
        }

        const response = await client.responses.create({ ...upstream, stream: false } as any);
        return void json(res, 200, responsesToAnthropic(response, body.model));
      } catch (error: any) {
        if (!isRateLimit(error)) throw error;

        // If streaming has already started, retrying the same prompt on another account can duplicate
        // tool calls or text. Only pre-response rate limits are transparently retried.
        if (res.headersSent) {
          await this.store.markRateLimited(account.id, error?.message ?? "429 rate limit", true);
          if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "The active account hit a limit after streaming began; the next teammate is active for the following request." } })}\n\n`);
            res.end();
          }
          return;
        }

        const next = await this.store.markRateLimited(account.id, error?.message ?? "429 rate limit", true);
        if (!next || attempted.has(next.id)) {
          return void json(res, 429, {
            error: {
              type: "rate_limit_error",
              message: "All ready teammate accounts are currently rate-limited. No upstream 429 was forwarded until failover options were exhausted.",
            },
          });
        }
        account = next;
      }
    }
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

    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(command, ["--yes", "openai-oauth@latest", "login", "--oauth-file", authFile], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      job.status = "error";
      job.error = message;
      job.finishedAt = new Date().toISOString();
    };

    child.once("error", (error) => fail(error.message));
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      void (async () => {
        if (code !== 0) {
          job.status = "error";
          job.error = `OAuth process exited with code ${code ?? "unknown"}.`;
          job.finishedAt = new Date().toISOString();
          return;
        }
        try {
          const email = await readAuthEmail(authFile);
          await this.store.upsert({ id, name, email, authFile });
          this.clients.delete(id);
          job.status = "complete";
          job.email = email;
          job.finishedAt = new Date().toISOString();
        } catch (error: any) {
          job.status = "error";
          job.error = error?.message ?? String(error);
          job.finishedAt = new Date().toISOString();
        }
      })();
    });

    return { ...job };
  }

  private clientFor(account: AccountRecord): OpenAI {
    const cached = this.clients.get(account.id);
    if (cached) return cached;
    const credentials = openaiCredentials({ authFilePath: account.authFile });
    const transport = createOpenAIOAuthTransport({ auth: () => credentials.getSession() });
    const client = new OpenAI({ apiKey: "openai-oauth", baseURL: transport.baseURL, fetch: transport.fetch });
    this.clients.set(account.id, client);
    return client;
  }

  private handleEventStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${JSON.stringify(this.store.snapshot())}\n\n`);
    this.eventStreams.add(res);
    req.on("close", () => this.eventStreams.delete(res));
  }
}

export function createServer(store: AccountStore): http.Server {
  const dispatcher = new Dispatcher(store);
  return http.createServer((req, res) => { void dispatcher.handler(req, res); });
}

function isRateLimit(error: any): boolean {
  return error?.status === 429 || error?.statusCode === 429 || /\b429\b|rate.?limit|usage.?limit|quota/i.test(error?.message ?? "");
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > 32 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.end(body);
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function html(res: ServerResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key,anthropic-version,anthropic-beta");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}
function modelAliases(): string[] {
  return ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", mapModel("default")];
}

function adminHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenAI-CC</title><style>
body{font:14px system-ui;margin:0;background:#0e1116;color:#e8edf3}.wrap{max-width:900px;margin:40px auto;padding:0 18px}h1{font-size:24px}.note,.add{background:#171c24;padding:14px;border-radius:10px;margin:16px 0}.card{display:grid;grid-template-columns:1fr auto;gap:12px;background:#171c24;margin:10px 0;padding:14px;border-radius:10px}.muted{color:#9aa6b2}.ready{color:#73d69c}.exhausted{color:#ff8f8f}.active{outline:2px solid #7aa2ff}button{background:#2b66d9;color:white;border:0;border-radius:7px;padding:8px 12px;cursor:pointer}button.secondary{background:#39414d}input{background:#0e1116;color:#e8edf3;border:1px solid #39414d;border-radius:7px;padding:9px;margin:4px 6px 4px 0}.toast{position:fixed;right:20px;bottom:20px;background:#242b36;padding:14px;border-radius:10px;max-width:360px;display:none}</style></head><body><div class="wrap"><h1>OpenAI-CC</h1><div class="note">Only one teammate is active at a time. Each teammate signs into their own ChatGPT account. If an upstream request hits a rate limit before output begins, OpenAI-CC marks that account exhausted, automatically activates the next ready teammate, and retries the same request before Claude Code sees the failure. A rate limit after streaming has already begun switches the next teammate for the following request instead of replaying partial work.</div><div class="add"><b>Add teammate with ChatGPT OAuth</b><div class="muted">Starts the same local OAuth login from this panel and opens sign-in in the machine's default browser.</div><form onsubmit="startOAuth(event)"><input id="oauth-id" required pattern="[A-Za-z0-9._-]{1,64}" placeholder="account id"><input id="oauth-name" required placeholder="display name"><button type="submit">Add account</button></form><div id="oauth-status" class="muted"></div></div><div id="status" class="muted"></div><div id="accounts"></div></div><div id="toast" class="toast"></div><script>
let currentState=null;
async function load(){const s=await fetch('/admin/state').then(r=>r.json());currentState=s;render(s)}
function remaining(iso){if(!iso)return'';const ms=Math.max(0,new Date(iso).getTime()-Date.now());const sec=Math.ceil(ms/1000),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;return h+'h '+m+'m '+s+'s'}
function render(s){const active=s.accounts.find(a=>a.id===s.activeAccountId);document.querySelector('#status').textContent='Active account: '+(active?(active.email||active.name)+' ('+active.id+')':'none')+' · Suggested next: '+(s.suggestedNextAccountId||'none');document.querySelector('#accounts').innerHTML=s.accounts.map(a=>'<div class="card '+(a.id===s.activeAccountId?'active':'')+'"><div><b>'+esc(a.name)+'</b> <span class="muted">('+esc(a.id)+')</span><div>'+esc(a.email||'Email unavailable')+'</div><div class="'+a.status+'">'+a.status+(a.exhaustedAt?' · exhausted '+new Date(a.exhaustedAt).toLocaleString():'')+'</div>'+(a.firstRequestAt?'<div class="muted">Window started '+new Date(a.firstRequestAt).toLocaleString()+'</div>':'')+(a.limitResetsAt?'<div class="muted">Fresh limits at '+new Date(a.limitResetsAt).toLocaleString()+' · '+remaining(a.limitResetsAt)+'</div>':'<div class="muted">Five-hour window starts on first request</div>')+'<div class="muted">'+esc(a.lastError||'')+'</div></div><div>'+(a.status==='ready'?'<button onclick="post(\'/admin/accounts/'+encodeURIComponent(a.id)+'/activate\')">Activate</button>':'<button class="secondary" '+(a.limitResetsAt&&new Date(a.limitResetsAt).getTime()>Date.now()?'disabled':'')+' onclick="post(\'/admin/accounts/'+encodeURIComponent(a.id)+'/reset\')">Reset</button>')+'</div></div>').join('')}
async function post(url){const r=await fetch(url,{method:'POST'});const d=await r.json().catch(()=>({}));if(!r.ok)toast(d.error?.message||'Request failed');await load()}
async function startOAuth(e){e.preventDefault();const id=document.querySelector('#oauth-id').value.trim(),name=document.querySelector('#oauth-name').value.trim(),status=document.querySelector('#oauth-status');status.textContent='Starting OAuth…';const r=await fetch('/admin/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,name})});const d=await r.json().catch(()=>({}));if(!r.ok){status.textContent=d.error?.message||'Could not start OAuth';return}status.textContent='OAuth started. Complete ChatGPT sign-in in the browser window.';watchOAuth(id)}
async function watchOAuth(id){const status=document.querySelector('#oauth-status');const r=await fetch('/admin/oauth/'+encodeURIComponent(id));const d=await r.json().catch(()=>({}));if(!r.ok){status.textContent='OAuth status unavailable';return}if(d.status==='complete'){status.textContent='Added '+(d.email||d.name)+'.';toast('Account added: '+(d.email||d.name));await load();return}if(d.status==='error'){status.textContent='OAuth failed: '+(d.error||'unknown error');return}setTimeout(()=>watchOAuth(id),1000)}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const es=new EventSource('/admin/events');['changed','activated','rate_limit','state'].forEach(t=>es.addEventListener(t,e=>{load();if(t==='rate_limit'){const d=JSON.parse(e.data);toast((d.account?.email||d.account?.name||'Account')+' hit its limit. '+(d.account?.limitResetsAt?'Fresh limits at '+new Date(d.account.limitResetsAt).toLocaleString()+'. ':'')+(d.activeAccountId?'Switched automatically to '+d.activeAccountId+'.':'No ready teammate remains.'));if(Notification.permission==='granted')new Notification('OpenAI-CC',{body:(d.account?.email||d.account?.name||'Account')+' exhausted; '+(d.activeAccountId?'switched to '+d.activeAccountId+'.':'no ready teammate remains.')})}}));
function toast(t){const x=document.querySelector('#toast');x.textContent=t;x.style.display='block';setTimeout(()=>x.style.display='none',8000)}
if('Notification'in window&&Notification.permission==='default')Notification.requestPermission();setInterval(()=>{if(currentState)render(currentState)},1000);load();</script></body></html>`;
}
