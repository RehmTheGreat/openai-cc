# OpenAI-CC

A local Node/TypeScript gateway that exposes the Anthropic endpoints Claude Code expects, translates requests to supported upstream APIs, and rotates to the next ready credential when an upstream credential is rate-limited before output begins.

## Supported upstream credentials

- **ChatGPT/Codex OAuth** through the existing local OAuth flow.
- **OpenCode Zen API keys** through `https://opencode.ai/zen/v1` using the OpenAI Responses API.
- **NVIDIA NIM API keys** through `https://integrate.api.nvidia.com/v1` using OpenAI-compatible Chat Completions.
- **Google AI Studio / Gemini API keys** through `https://generativelanguage.googleapis.com/v1beta/openai/` using OpenAI-compatible Chat Completions.

OpenCode Zen's current public documentation describes Zen as a billed gateway rather than a guaranteed free-quota service. The gateway supports Zen API keys regardless of the billing/quota attached to a particular key.

## Rotation behavior

All ChatGPT OAuth accounts and API-key entries live in one ordered credential list.

- One credential is active at a time.
- You can add multiple keys for Zen, NVIDIA NIM, Google AI Studio, or any mixture of those providers.
- If a request gets a `429` **before Claude Code receives any output**, OpenAI-CC marks that credential exhausted, activates the next ready credential, and retries the same request internally.
- It keeps walking the ready credential list until the request succeeds or all ready credentials have been tried.
- If a rate limit occurs after streaming output has already started, the request is not replayed because replaying partial agent output could duplicate text or tool calls. The next ready credential becomes active for the following request.
- ChatGPT OAuth accounts retain the persisted five-hour window behavior.
- API-key providers use the upstream `Retry-After` value when available. Otherwise they use a 15-minute cooldown by default. Override it with `API_KEY_RATE_LIMIT_COOLDOWN_MS`.
- When a cooldown/reset time expires, the credential automatically returns to `ready`.

Credentials are stored only under `.data/`, which is gitignored. API keys are masked in the admin API/UI and event payloads. Treat `.data/accounts.json` and OAuth files as secrets.

## Pieces

1. `src/account-store.ts` — unified ChatGPT/API-key credential records, active state, cooldown/reset timers, rotation, and persistence.
2. `src/translator.ts` — Anthropic Messages ↔ OpenAI Responses translation for ChatGPT OAuth and OpenCode Zen.
3. `src/chat-translator.ts` — Anthropic Messages ↔ OpenAI-compatible Chat Completions translation for NVIDIA NIM and Google AI Studio, including tools and streaming.
4. `src/dispatcher.ts` — Anthropic HTTP surface, provider routing, transparent pre-output failover, browser OAuth, API-key setup, and the admin UI.

## Install

Prerequisites: Node.js 20+ and a browser if you use ChatGPT OAuth.

```bash
git clone https://github.com/RehmTheGreat/openai-cc.git
cd openai-cc
npm install
npm run build
npm start
```

On Windows you can also use:

```powershell
.\setup.ps1
```

## Add credentials

Open:

```text
http://127.0.0.1:8082/admin
```

### ChatGPT OAuth

Under **Add teammate with ChatGPT OAuth**, enter a unique credential id and display name, then finish sign-in in the browser.

You can also use the terminal flow:

```bash
npm run account:add -- --id faseeh --name "Faseeh"
```

### API keys

Under **Add API key**:

1. Select `OpenCode Zen`, `NVIDIA NIM`, or `Google AI Studio`.
2. Enter a unique credential id.
3. Enter a display name.
4. Enter the exact provider model id that this credential should use.
5. Paste the API key.
6. Repeat for every additional key you want in rotation.

Examples of model-id sources:

- OpenCode Zen: use a model id shown by Zen, such as one from its `/zen/v1/responses` model list/documentation.
- NVIDIA NIM: use the exact model id shown on NVIDIA Build for the endpoint you want.
- Google AI Studio: use a Gemini model supported by Google's OpenAI-compatibility endpoint.

The selected credential's `model` overrides the normal Claude-to-OpenAI model mapping, which makes cross-provider failover possible even though each provider names models differently.

## Point Claude Code at it

### PowerShell

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
$env:ANTHROPIC_AUTH_TOKEN="local-not-used"
claude
```

### bash/zsh

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
export ANTHROPIC_AUTH_TOKEN="local-not-used"
claude
```

Endpoints:

- Anthropic base URL: `http://127.0.0.1:8082`
- Admin: `http://127.0.0.1:8082/admin`
- Health: `http://127.0.0.1:8082/healthz`

## Model mapping

ChatGPT OAuth credentials without a credential-specific model still use the existing mapping:

```bash
DEFAULT_OPENAI_MODEL=gpt-5.6-sol
```

or:

```bash
MODEL_MAP_JSON='{"claude-opus":"gpt-5.6-sol","claude-sonnet":"gpt-5.6-sol","claude-haiku":"gpt-5.4-mini"}'
```

API-key credentials currently require a provider model id when they are added. This avoids accidentally sending a Zen model id to Gemini or an NVIDIA model id to Zen during rotation.

## Compatibility notes

- `POST /v1/messages`: text, images, tools, tool results, non-streaming responses, and streaming are translated.
- ChatGPT OAuth and Zen use the OpenAI Responses path.
- NVIDIA NIM and Google AI Studio use the OpenAI-compatible Chat Completions path.
- Tool definitions, assistant tool calls, tool results, and streamed tool-call argument deltas are translated in both paths.
- Claude `thinking` history is never converted into hidden provider chain-of-thought. When present in history it is preserved only as visible prior context.
- `POST /v1/messages/count_tokens` remains a conservative local estimate rather than Anthropic's exact tokenizer.
- Provider-specific model capabilities still matter. A model that lacks tools, vision, long context, or reliable streaming cannot gain those capabilities through protocol translation.

## Security

- Keep the service bound to loopback unless you add real authentication and TLS.
- Never commit `.data/`.
- API keys are stored locally in `.data/accounts.json`; filesystem permissions are tightened where the OS supports it.
- Use only API keys/accounts you are authorized to use and stay within each provider's applicable terms and quota rules.
