# OpenAI-CC

A local Node/TypeScript gateway that exposes the Anthropic endpoints Claude Code and Claude Desktop expect, translates requests to supported upstream APIs, and rotates to the next ready credential when an upstream credential is rate-limited before output begins.

## Supported clients

- **Claude Code** through the Anthropic-compatible endpoint at `http://127.0.0.1:8082`.
- **Claude Desktop** through its `Claude-3p` / third-party inference gateway mode. `setup.ps1` configures the Desktop profile automatically on Windows and the gateway also re-applies the profile on startup.

Claude Desktop is intentionally given Claude-compatible public route names rather than raw upstream model ids:

| OpenAI-CC slot | Claude Desktop route |
| --- | --- |
| Fable | `claude-fable-5` |
| Opus | `claude-opus-5` |
| Sonnet | `claude-sonnet-5` |
| Haiku | `claude-haiku-4-5` |

Those names are public aliases only. Requests are still routed internally to the provider/model selected for each OpenAI-CC slot in the admin panel. Raw GPT, Gemini, DeepSeek, NVIDIA, or other upstream ids are not exposed through Claude Desktop model discovery.

`GET /v1/models` and `GET /v1/models/{model_id}` return Claude-compatible model metadata including the configured context window, per-route maximum output tokens, and conservative gateway capabilities. The default model configuration advertises a 700,000-token input context. Output ceilings default to 128,000 tokens for Default/Fable/Opus/Sonnet and 64,000 for Haiku, and can be changed in the admin panel. Message requests are clamped to the configured per-route output ceiling.

## Supported upstream credentials

- **ChatGPT/Codex OAuth** through the existing local OAuth flow.
- **OpenCode Zen API keys** through `https://opencode.ai/zen/v1` using the OpenAI Responses API.
- **NVIDIA NIM API keys** through `https://integrate.api.nvidia.com/v1` using OpenAI-compatible Chat Completions.
- **Google AI Studio / Gemini API keys** through `https://generativelanguage.googleapis.com/v1beta/openai/` using OpenAI-compatible Chat Completions.

OpenCode Zen's public documentation describes Zen as a billed gateway rather than a guaranteed free-quota service. OpenAI-CC supports Zen API keys regardless of the billing/quota attached to a particular key.

## Rotation behavior

All ChatGPT OAuth accounts and API-key entries live in one ordered credential list.

- One credential is active at a time.
- You can add multiple keys for Zen, NVIDIA NIM, Google AI Studio, or any mixture of those providers.
- If a request gets a `429` **before Claude receives any output**, OpenAI-CC marks that credential exhausted, activates the next ready credential, and retries the same request internally.
- It keeps walking the ready credential list until the request succeeds or all ready credentials have been tried.
- If a rate limit occurs after streaming output has already started, the request is not replayed because replaying partial agent output could duplicate text or tool calls. The next ready credential becomes active for the following request.
- ChatGPT OAuth accounts retain the persisted five-hour window behavior.
- API-key providers use the upstream `Retry-After` value when available. Otherwise they use a 15-minute cooldown by default. Override it with `API_KEY_RATE_LIMIT_COOLDOWN_MS`.
- When a cooldown/reset time expires, the credential automatically returns to `ready`.

Credentials are stored only under `.data/`, which is gitignored. API keys are masked in the admin API/UI and event payloads. Treat `.data/accounts.json` and OAuth files as secrets.

## Pieces

1. `src/account-store.ts` — unified ChatGPT/API-key credential records, active state, cooldown/reset timers, rotation, and persistence.
2. `src/model-config.ts` — slot routing, configured context window, and output ceilings.
3. `src/translator.ts` — Anthropic Messages ↔ OpenAI Responses translation for ChatGPT OAuth and OpenCode Zen.
4. `src/chat-translator.ts` — Anthropic Messages ↔ OpenAI-compatible Chat Completions translation for NVIDIA NIM and Google AI Studio, including tools and streaming.
5. `src/claude-desktop.ts` — Claude-safe model discovery plus minimal Claude Desktop `Claude-3p` gateway/profile configuration.
6. `src/dispatcher.ts` — Anthropic HTTP surface, provider routing, transparent pre-output failover, browser OAuth, API-key setup, and the admin UI.

## Install

Prerequisites: Node.js 20+ and a browser if you use ChatGPT OAuth.

```bash
git clone https://github.com/RehmTheGreat/openai-cc.git
cd openai-cc
npm install
npm run build
npm start
```

### Windows setup and Claude Desktop

Run:

```powershell
.\setup.ps1
```

The setup script:

- leaves an existing Claude Desktop installation untouched;
- installs Claude Desktop with the official `Anthropic.Claude` winget package only when the app is missing;
- installs/builds OpenAI-CC;
- writes the minimal `Claude` and `Claude-3p` deployment-mode configuration and an `OpenAI-CC` inference-gateway profile;
- points Claude Desktop at `http://127.0.0.1:8082` with a local placeholder bearer token (never a provider credential);
- starts the local gateway if it is not already healthy.

If Claude Desktop was already running while setup changed its profile, restart the Desktop app once so it reloads the `3p` deployment configuration.

Provider credentials are **not** requested by `setup.ps1`. Add them only through the OpenAI-CC admin panel.

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

The selected credential's `model` can be overridden by the slot's configured route. This makes cross-provider routing possible even though each provider names models differently.

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
- Claude model discovery: `GET http://127.0.0.1:8082/v1/models`
- Claude model detail: `GET http://127.0.0.1:8082/v1/models/{model_id}`
- Messages: `POST http://127.0.0.1:8082/v1/messages`
- Token estimate: `POST http://127.0.0.1:8082/v1/messages/count_tokens`
- Admin: `http://127.0.0.1:8082/admin`
- Health: `http://127.0.0.1:8082/healthz`

## Model mapping

ChatGPT OAuth credentials without a credential-specific model still use the configured OpenAI-CC slot routing. The admin panel exposes five internal slots for Claude Code: `Default`, `Fable`, `Opus`, `Sonnet`, and `Haiku`.

Claude Desktop does not expose `Default`; it exposes only the four Claude-safe public aliases listed above. The existing role matcher maps those aliases (including date-suffixed Claude family names) back to the correct internal slot.

## Compatibility notes

- `POST /v1/messages`: text, images, tools, tool results, non-streaming responses, and streaming are translated.
- `GET /v1/models` and `GET /v1/models/{model_id}` use Claude-style model metadata and do not reveal raw upstream ids as callable model names.
- ChatGPT OAuth and Zen use the OpenAI Responses path.
- NVIDIA NIM and Google AI Studio use the OpenAI-compatible Chat Completions path.
- Tool definitions, assistant tool calls, tool results, and streamed tool-call argument deltas are translated in both paths.
- Claude `thinking` history is never converted into hidden provider chain-of-thought. When present in history it is preserved only as visible prior context.
- The advertised `thinking` capability is conservative: it is enabled only for routes using the Responses translation path; adaptive thinking is not advertised.
- Image input is advertised only for ChatGPT and Google routes. PDF input, citations, built-in code execution, context-management controls, effort controls, and structured outputs are not advertised because the gateway does not provide those Claude-native features end-to-end.
- `POST /v1/messages/count_tokens` remains a conservative local estimate rather than Anthropic's exact tokenizer.
- Provider-specific model capabilities still matter. A model that lacks tools, vision, long context, or reliable streaming cannot gain those capabilities through protocol translation.

## Test

```bash
npm test
```

The test suite covers Claude-safe alias discovery, configured context/output metadata, model retrieval, idempotent `Claude-3p` profile merging, and installer invariants that prevent an existing Claude Desktop installation from being upgraded/reinstalled.

## Security

- Keep the service bound to loopback unless you add real authentication and TLS.
- The Claude Desktop gateway token is the non-secret local placeholder `local-not-used`; provider credentials remain inside OpenAI-CC.
- Never commit `.data/`.
- API keys are stored locally in `.data/accounts.json`; filesystem permissions are tightened where the OS supports it.
- Use only API keys/accounts you are authorized to use and stay within each provider's applicable terms and quota rules.
