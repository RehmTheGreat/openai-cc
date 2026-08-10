import http, { IncomingMessage, ServerResponse } from "node:http";
import OpenAI from "openai";
import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";
import { AccountRecord, AccountStore } from "./account-store.js";
import { AnthropicRequest, AnthropicSseTranslator, anthropicToResponses, estimateAnthropicTokens, mapModel, responsesToAnthropic } from "./translator.js";

export class Dispatcher {
  private clients = new Map<string, OpenAI>();
  private eventStreams = new Set<ServerResponse>();

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
    const account = this.store.active();
    if (!account) {
      const next = this.store.suggestedNext();
      return void json(res, 409, {
        error: {
          type: "handoff_required",
          message: next
            ? `No active account. ${next.name} (${next.id}) is ready; activate that teammate from http://127.0.0.1:${process.env.PORT || 8082}/admin.`
            : "No active account is ready. Reset or add an account in the admin workflow.",
        },
      });
    }

    const client = this.clientFor(account);
    const upstream = anthropicToResponses(body) as any;

    try {
      if (body.stream) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        const stream = await client.responses.create({ ...upstream, stream: true });
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
      if (isRateLimit(error)) {
        await this.store.markRateLimited(account.id, error?.message ?? "429 rate limit");
        if (!res.headersSent) {
          return void json(res, 429, {
            error: {
              type: "rate_limit_error",
              message: `${account.name}'s account hit its current limit. The request was not retried under another teammate. Activate the next teammate in /admin.`,
            },
          });
        }
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Active teammate hit a rate limit; manual handoff required." } })}\n\n`);
          res.end();
        }
        return;
      }
      throw error;
    }
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
body{font:14px system-ui;margin:0;background:#0e1116;color:#e8edf3}.wrap{max-width:900px;margin:40px auto;padding:0 18px}h1{font-size:24px}.note{background:#171c24;padding:14px;border-radius:10px;margin:16px 0}.card{display:grid;grid-template-columns:1fr auto;gap:12px;background:#171c24;margin:10px 0;padding:14px;border-radius:10px}.muted{color:#9aa6b2}.ready{color:#73d69c}.exhausted{color:#ff8f8f}.active{outline:2px solid #7aa2ff}button{background:#2b66d9;color:white;border:0;border-radius:7px;padding:8px 12px;cursor:pointer}button.secondary{background:#39414d}.toast{position:fixed;right:20px;bottom:20px;background:#242b36;padding:14px;border-radius:10px;max-width:360px;display:none}</style></head><body><div class="wrap"><h1>OpenAI-CC</h1><div class="note">Only one teammate is active at a time. A 429 marks that account exhausted and stops the request. The next teammate must explicitly click <b>Activate</b>; the proxy never retries a request under another person's account.</div><div id="status" class="muted"></div><div id="accounts"></div></div><div id="toast" class="toast"></div><script>
async function load(){const s=await fetch('/admin/state').then(r=>r.json());render(s)}
function render(s){document.querySelector('#status').textContent='Active account: '+(s.activeAccountId||'none')+' · Suggested next: '+(s.suggestedNextAccountId||'none');document.querySelector('#accounts').innerHTML=s.accounts.map(a=>'<div class="card '+(a.id===s.activeAccountId?'active':'')+'"><div><b>'+esc(a.name)+'</b> <span class="muted">('+esc(a.id)+')</span><div class="'+a.status+'">'+a.status+(a.exhaustedAt?' · since '+new Date(a.exhaustedAt).toLocaleString():'')+'</div><div class="muted">'+esc(a.lastError||'')+'</div></div><div>'+(a.status==='ready'?'<button onclick="post(\'/admin/accounts/'+encodeURIComponent(a.id)+'/activate\')">Activate</button>':'<button class="secondary" onclick="post(\'/admin/accounts/'+encodeURIComponent(a.id)+'/reset\')">Reset</button>')+'</div></div>').join('')}
async function post(url){await fetch(url,{method:'POST'});load()}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const es=new EventSource('/admin/events');es.onmessage=load;['changed','activated','rate_limit','state'].forEach(t=>es.addEventListener(t,e=>{load();if(t==='rate_limit'){const d=JSON.parse(e.data);toast((d.account?.name||'Account')+' hit its limit. Activate '+(d.suggestedNextAccountId||'the next teammate')+'.');if(Notification.permission==='granted')new Notification('OpenAI-CC',{body:(d.account?.name||'Account')+' exhausted; manual handoff required.'})}}));
function toast(t){const x=document.querySelector('#toast');x.textContent=t;x.style.display='block';setTimeout(()=>x.style.display='none',8000)}
if('Notification'in window&&Notification.permission==='default')Notification.requestPermission();load();</script></body></html>`;
}
