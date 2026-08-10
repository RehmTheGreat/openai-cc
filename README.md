# OpenAI-CC

A local Node/TypeScript gateway that exposes the Anthropic endpoints Claude Code and Claude Desktop expect, translates requests to supported upstream APIs, and rotates to the next ready credential when an upstream credential is rate-limited before output begins.

## Supported clients

- **Claude Code CLI** through the Anthropic-compatible endpoint at `http://127.0.0.1:8082`.
- **Claude Code for VS Code** through the same shared Claude Code configuration.
- **Claude Desktop Code** through the same Claude Code engine/configuration plus Claude Desktop's `Claude-3p` / third-party inference gateway profile.

Claude Desktop is intentionally given Claude-compatible public route names rather than raw upstream model ids:

| OpenAI-CC slot | Claude public route |
| --- | --- |
| Fable | `claude-fable-5` |
| Opus | `claude-opus-5` |
| Sonnet | `claude-sonnet-5` |
| Haiku | `claude-haiku-4-5` |

Those names are public aliases only. Requests are still routed internally to the provider/model selected for each OpenAI-CC slot in the admin panel. Raw GPT, Gemini, DeepSeek, NVIDIA, or other upstream ids are not exposed through Claude model discovery.

`GET /v1/models` and `GET /v1/models/{model_id}` return Claude-compatible model metadata including the configured context window, per-route maximum output tokens, and conservative gateway capabilities. The default model configuration advertises a 700,000-token input context. Output ceilings default to 128,000 tokens for Default/Fable/Opus/Sonnet and 64,000 for Haiku, and can be changed in the admin panel. Message requests are clamped to the configured per-route output ceiling.

## Supported upstream credentials

- **ChatGPT/Codex OAuth** through the existing local OAuth flow.
- **OpenCode Zen API keys** through `https://opencode.ai/zen/v1` using the OpenAI Responses API.
- **NVIDIA NIM API keys** through `https://integrate.api.nvidia.com/v1` using OpenAI-compatible Chat Completions.
- **Google AI Studio / Gemini API keys** through `https://generativelanguage.googleapis.com/v1beta/openai/` using OpenAI-compatible Chat Completions.

OpenAI-CC never asks the Windows installer for provider credentials. API keys and OAuth setup belong exclusively in the local admin panel.

## Windows installer

Run `setup.ps1` from a checkout, or download/run the script by itself and it will clone OpenAI-CC into `%LOCALAPPDATA%\OpenAI-CC`.

The installer is idempotent and asks three explicit **Y/N** questions:

1. Install Claude Code CLI?
2. Install VS Code and the Claude Code extension?
3. Install and configure Claude Desktop?

The input routine drains pending console keystrokes before every question and accepts only an explicit `Y` or `N`; stray or repeated Enter presses cannot submit an empty choice.

### What it installs/configures

Required dependencies are checked first. Missing Git, Node.js, and ripgrep are installed with WinGet. Node is brought to at least 22.5 because the installed Context Mode release requires Node 22.5 or newer.

For optional apps, the user's Y/N choice controls installation. An existing Claude Code, VS Code, Claude Code VS Code extension, or Claude Desktop installation is left at its installed version rather than being unnecessarily upgraded/reinstalled.

The installer then:

- installs/builds OpenAI-CC;
- creates `~/Desktop/Claude` as the default projects directory;
- persists the local gateway/model environment for future PowerShell and app sessions;
- repairs Claude Code's `hasCompletedOnboarding` / `hasSeenOnboarding` state so a third-party gateway does not loop back to the login/onboarding screen;
- enables gateway model discovery and uses the Claude-safe public aliases above;
- sets Claude Code's auto-compaction capacity to **700,000 tokens** on routes whose actual model context permits it, instead of disabling compaction;
- installs **RTK** and initializes its global Claude Code integration;
- installs the official **TypeScript LSP** Claude plugin plus `typescript-language-server`;
- installs **Context Mode** as a user-scoped Claude Code plugin;
- configures `claudeCode.disableLoginPrompt` for the VS Code extension when VS Code support was selected;
- configures Claude Desktop's `Claude-3p` profile when Desktop support was selected;
- creates a per-user Startup shortcut so the local gateway is available after future Windows logins;
- starts/verifies the proxy and validates Claude-compatible model discovery and 700k gateway metadata.

Claude Code CLI, its VS Code extension, and the local Code tab in Claude Desktop share Claude Code's user configuration. The token-efficiency plugins/hooks are therefore installed once at user scope rather than duplicated per client.

### 700k context behavior

OpenAI-CC advertises a 700,000-token gateway context. Claude Code is configured with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000`, which keeps automatic compaction enabled while allowing up to 700k working capacity on a 1M-capable Claude route. Claude Code still caps that value at the actual context limit of the selected public model family, so a lower-context model such as Haiku cannot be forced beyond its own client-side limit merely by changing the gateway metadata.

### Credentials

After installation, open:

```text
http://127.0.0.1:8082/admin
```

Add provider API keys or complete ChatGPT OAuth there. The installer never asks for, embeds, or stores provider credentials. The local Claude-facing bearer token is the non-secret placeholder `local-not-used`.

## Manual install

If you only want the gateway itself, Node.js 20+ is sufficient:

```bash
git clone https://github.com/RehmTheGreat/openai-cc.git
cd openai-cc
npm install
npm run build
npm start
```

The full Windows installer requires Node.js 22.5+ because it also installs Context Mode.

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
6. `src/claude-config.ts` — shared Claude Code gateway aliases, model discovery, auto-compaction capacity, and onboarding state.
7. `src/dispatcher.ts` — Anthropic HTTP surface, provider routing, transparent pre-output failover, browser OAuth, API-key setup, and the admin UI.
8. `setup.ps1` — idempotent native-Windows installer/configurator.

## Add credentials

### ChatGPT OAuth

In the admin panel, under **Add teammate with ChatGPT OAuth**, enter a unique credential id and display name, then finish sign-in in the browser.

You can also use the terminal flow:

```bash
npm run account:add -- --id my-account --name "My Account"
```

### API keys

Under **Add API key**:

1. Select `OpenCode Zen`, `NVIDIA NIM`, or `Google AI Studio`.
2. Enter a unique credential id.
3. Enter a display name.
4. Enter the exact provider model id that this credential should use.
5. Paste the API key.
6. Repeat for every additional key you want in rotation.

The selected credential's model can be overridden by the slot's configured route. This makes cross-provider routing possible even though each provider names models differently.

## Endpoints

- Anthropic base URL: `http://127.0.0.1:8082`
- Claude model discovery: `GET http://127.0.0.1:8082/v1/models`
- Claude model detail: `GET http://127.0.0.1:8082/v1/models/{model_id}`
- Messages: `POST http://127.0.0.1:8082/v1/messages`
- Token estimate: `POST http://127.0.0.1:8082/v1/messages/count_tokens`
- Admin: `http://127.0.0.1:8082/admin`
- Health: `http://127.0.0.1:8082/healthz`

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

The test suite covers Claude-safe alias discovery, configured context/output metadata, Desktop `Claude-3p` profile merging, installer Y/N input invariants, token-efficiency stack configuration, persistent gateway settings, and Desktop opt-out behavior.

## Security

- Keep the service bound to loopback unless you add real authentication and TLS.
- The Claude-facing gateway token is the non-secret local placeholder `local-not-used`; provider credentials remain inside OpenAI-CC.
- Never commit `.data/`.
- API keys are stored locally in `.data/accounts.json`; filesystem permissions are tightened where the OS supports it.
- Use only API keys/accounts you are authorized to use and stay within each provider's applicable terms and quota rules.
