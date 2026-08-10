# OpenAI-CC

A small local Node/TypeScript service that exposes the Anthropic endpoints Claude Code expects and sends one explicitly active teammate's requests through their own ChatGPT/Codex OAuth session.

## Important behavior

- **One active teammate at a time.**
- Every teammate authenticates their **own** ChatGPT account into a separate local auth file.
- A `429` marks that account `exhausted`, emits an admin/browser notification, clears the active account, and returns the error to Claude Code.
- It **does not retry that request under another account**. The next teammate must open `/admin` and explicitly click **Activate**.
- Tokens live only under `.data/accounts/<id>/auth.json`; `.data/` is gitignored. Treat those files like passwords.
- The service binds to `127.0.0.1` by default.

This intentional handoff behavior avoids turning multiple individual accounts into one pooled quota. OpenAI's current business terms prohibit sharing individual credentials and configuring services to avoid usage limits, and the `openai-oauth` project itself says not to pool/share access tokens.

## Pieces

1. `src/account-store.ts` — account metadata, per-user auth paths, active-account state, exhausted state and events.
2. `src/translator.ts` — Anthropic messages/tools/tool-results ↔ OpenAI Responses payloads and Anthropic SSE events.
3. `src/dispatcher.ts` — `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, upstream dispatch and the tiny admin surface.

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

Add each teammate one at a time on the shared PC:

```bash
npm run account:add -- --id faseeh --name "Faseeh"
npm run account:add -- --id teammate2 --name "Teammate 2"
```

Each command opens the ChatGPT/Codex OAuth flow and writes that person's credentials to a separate local file.

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

## 429 handoff flow

1. Faseeh is active and uses Claude Code.
2. Upstream returns `429`.
3. The proxy marks Faseeh exhausted, clears `activeAccountId`, and notifies `/admin`.
4. The current Claude Code request receives `429`; it is not replayed elsewhere.
5. Teammate 2 sits down, opens the admin panel and clicks **Activate** on their own account.
6. New Claude Code requests now use Teammate 2's OAuth session.

When an account's provider quota has actually reset, click **Reset** and it becomes eligible for activation again.

## Compatibility notes

- `POST /v1/messages`: text, images, tools, tool results, streaming text, function-call argument deltas, and OpenAI reasoning **summaries** are translated.
- Claude `thinking` history is never converted into OpenAI hidden chain-of-thought. It is carried only as visible prior context when supplied by the client.
- `POST /v1/messages/count_tokens` is a local conservative estimate, not Anthropic's exact tokenizer.
- The translator is stateless; Claude Code should send full conversation history on each request.
- `openai-oauth` is an unofficial community package that uses Codex/ChatGPT OAuth and an underlying ChatGPT Codex endpoint. That interface can change without notice.

## Security

- Keep this loopback-only unless you add real authentication and TLS.
- Never commit `.data/`.
- Do not copy one teammate's auth file to another person/device.
- Revoke a teammate by deleting their local auth directory and disconnecting/revoking Codex access from their OpenAI account as appropriate.
