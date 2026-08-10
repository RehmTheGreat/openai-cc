# OpenAI-CC

A small local Node/TypeScript service that exposes the Anthropic endpoints Claude Code expects and sends one explicitly active teammate's requests through their own ChatGPT/Codex OAuth session.

## Important addition implemented

- **One active teammate at a time, with their account in rotation and email displayed on the admin panel.**
- Every teammate authenticates their **own** ChatGPT account from either the terminal or the browser admin panel.
- The first upstream request made by an account starts a persisted five-hour usage window. The admin panel shows when that window started, the exact stored reset time, and a live countdown.
- A `429` marks that account `exhausted`, clears it as the active account, and shows the exhaustion/reset state on the admin panel so that teammate can stop working.
- The next ready teammate is suggested in the admin panel and must be explicitly activated before work continues. Requests are not silently replayed under another person's account.
- When the stored five-hour reset time arrives, the account automatically becomes `ready` again and its next request starts a fresh five-hour window.
- Tokens live only under `.data/accounts/<id>/auth.json`; `.data/` is gitignored. Treat those files like passwords.
- The service binds to `127.0.0.1` by default.

This intentional admin-panel handoff avoids turning multiple individual accounts into one pooled quota. OpenAI's current business terms prohibit sharing individual credentials and configuring services to avoid usage limits, so each teammate uses their own account only.

## Pieces

1. `src/account-store.ts` — account metadata, email discovery, per-user auth paths, active-account state, exhaustion state, five-hour window timestamps/timers, and events.
2. `src/translator.ts` — Anthropic messages/tools/tool-results ↔ OpenAI Responses payloads and Anthropic SSE events.
3. `src/dispatcher.ts` — `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, upstream dispatch, browser OAuth account setup, and the admin surface.

`src/index.ts` only wires those pieces together.

## Install (Windows / macOS / Linux)

Prerequisites: Node.js 20+ and a browser.

```bash
git clone https://github.com/RehmTheGreat/openai-cc.git
cd openai-cc
npm install
```

On Windows, the shortest setup is instead:

```powershell
.\setup.ps1
```

Add each teammate one at a time on the shared PC from the terminal:

```bash
npm run account:add -- --id faseeh --name "Faseeh"
npm run account:add -- --id teammate2 --name "Teammate 2"
```

Each command opens the ChatGPT/Codex OAuth flow and writes that person's credentials to a separate local file.

Or start the proxy, open `http://127.0.0.1:8082/admin`, enter an account id and display name under **Add teammate with ChatGPT OAuth**, and complete the browser sign-in. The authenticated email is read from the local OAuth data when available and displayed in the admin panel.

Start the proxy:

```bash
npm run build
npm start
```

On Windows, `./run-claude.ps1` starts the proxy, opens the admin panel, points that Claude Code process at the local gateway, and stops the proxy when Claude exits.

Endpoints:

- Anthropic base URL: `http://127.0.0.1:8082`
- Admin: `http://127.0.0.1:8082/admin`
- Health: `http://127.0.0.1:8082/healthz`

## Point Claude Code at it

For a shell session:

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

Claude Code documents `ANTHROPIC_BASE_URL` for Anthropic-compatible gateways and `ANTHROPIC_AUTH_TOKEN` for a static bearer token. This proxy ignores the placeholder token and authenticates upstream with the active teammate's local ChatGPT OAuth session.

## Model mapping

By default every Claude model id maps to `gpt-5.6-sol`. Override with:

```bash
DEFAULT_OPENAI_MODEL=gpt-5.6-sol
```

or a JSON mapping, where exact ids are checked first and prefixes second:

```bash
MODEL_MAP_JSON='{"claude-opus":"gpt-5.6-sol","claude-sonnet":"gpt-5.6-sol","claude-haiku":"gpt-5.4-mini"}'
```

## Compatibility notes

- `POST /v1/messages`: text, images, tools, tool results, streaming text, function-call argument deltas, and OpenAI reasoning **summaries** are translated.
- Claude `thinking` history is never converted into OpenAI hidden chain-of-thought. It is carried only as visible prior context when supplied by the client.
- `POST /v1/messages/count_tokens` is a local conservative estimate, not Anthropic's exact tokenizer.
- The translator is stateless; Claude Code should send full conversation history on each request.
- `openai-oauth` is an unofficial community package that uses Codex/ChatGPT OAuth and an underlying ChatGPT Codex endpoint. That interface can change without notice.

## Security

- Keep this loopback-only unless you add real authentication and TLS.
- Never commit `.data/`.
