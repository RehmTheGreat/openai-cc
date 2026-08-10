# OpenAI-CC

OpenAI-CC is a local Node/TypeScript gateway that exposes the Anthropic endpoints expected by Claude Code and Claude Desktop, translates them to configured upstream providers, and performs deterministic provider-local credential failover.

The gateway and Admin UI bind to `127.0.0.1:8082` by default.

## Supported clients

- **Claude Code CLI** through `http://127.0.0.1:8082`.
- **Claude Code for VS Code** through the same shared Claude Code configuration.
- **Claude Desktop Code** through Claude Desktop's `Claude-3p` third-party inference gateway profile.

Claude-facing model discovery exposes only Claude-compatible public route aliases. Raw upstream model ids remain internal:

| OpenAI-CC slot | Claude public route |
| --- | --- |
| Fable | `claude-fable-5` |
| Opus | `claude-opus-5` |
| Sonnet | `claude-sonnet-5` |
| Haiku | `claude-haiku-4-5` |

`GET /v1/models` and `GET /v1/models/{model_id}` immediately reflect the saved server-side route/context/output configuration.

## Credential providers

OpenAI-CC supports:

- **ChatGPT/Codex OAuth** credentials acquired by the official OpenAI Codex CLI.
- **OpenCode Zen** API keys.
- **NVIDIA NIM** API keys.
- **Google AI Studio / Gemini** API keys.

### ChatGPT authentication architecture

OpenAI-CC does **not** construct OpenAI's browser authorization URL and does not use the third-party `openai-oauth` CLI to acquire credentials.

Credential acquisition is delegated to the official `@openai/codex` CLI package pinned by OpenAI-CC. The currently tested package version is **0.146.0**. Browser login is the default; the official Codex device-auth flow is available as a fallback.

Each ChatGPT credential has its own managed Codex home:

```text
.data/
  codex-homes/
    chatgpt-main/
      auth.json
    chatgpt-backup/
      auth.json
  auth-jobs/
    <temporary-login-job>/
```

OpenAI-CC starts Codex with a per-job `CODEX_HOME` and forces Codex's file credential store so a successful login produces a managed `auth.json`. A successful login is validated and then atomically promoted into that credential's permanent Codex home. Re-authentication always happens in a temporary home first; a failed/cancelled login leaves the previous working credential untouched.

Only one browser/device login job is allowed at a time because current Codex browser authentication uses a small fixed loopback callback-port set. Jobs have cancellation, timeout, process-tree cleanup, and bounded/redacted output capture. OAuth URLs, authorization codes, PKCE state/verifiers, and tokens are never returned through the Admin API.

The existing `@openai-oauth/local` + `@openai-oauth/core` transport is retained only to **consume** a valid Codex `auth.json` and send Codex-backed Responses requests. Those packages are pinned; they are not the login implementation.

## Credential routing

There is no longer one ambiguous global "active" credential. Preferences are provider-local:

```text
chatgpt -> Personal Plus
zen     -> Zen Primary
nvidia  -> NIM Main
google  -> Google Main
```

For an **Auto** route:

1. use the route's configured provider;
2. try that provider's preferred **READY** credential first;
3. if it is unavailable, try the other READY credentials for the same provider in stable order;
4. on a pre-output `429`, mark that credential exhausted and retry the next same-provider credential;
5. once any streaming output has been sent to Claude, never replay the partial response. The exhausted credential is skipped on the next request instead.

For a **Pinned** route, only the exact credential is used. If that credential is exhausted or disabled, the route is explicitly unavailable; pins do not silently fall back.

Route pins are validated server-side. A pin cannot reference a missing credential or a credential belonging to another provider. Disabled/exhausted credentials may remain intentionally pinned so the configuration is preserved while route health clearly shows it as unavailable.

## Credential lifecycle

The Admin UI supports explicit operations rather than implicit ID replacement:

- Add ChatGPT account.
- Add API-key credential.
- Make preferred for that provider.
- Re-authenticate ChatGPT account.
- Replace an API key.
- Disable / enable.
- Rename.
- Remove.

Creating a credential with an existing ID returns `409 Conflict`; it never silently changes provider. Deleting a credential that is pinned to model slots also returns `409` and identifies the blocking slots.

Statuses are:

- `READY`
- `EXHAUSTED`
- `DISABLED`
- `AUTH ERROR`

A `401` from an upstream credential marks it `AUTH ERROR`; Auto routing may continue with the next ready credential from the same provider, while pinned routes remain unavailable until the exact credential is re-authenticated or its API key is replaced.

An exhausted credential with a known future reset displays the reset time/countdown instead of a misleading Reset button. A disabled credential remains disabled when an old rate-limit timer expires.

## Admin UI

Open:

```text
http://127.0.0.1:8082/admin
```

The Admin UI has separate Overview, Model Routes, Credentials, and Add Credential areas. Provider changes immediately rebuild the route's credential selector from real matching credentials. Route health is derived by the same server-side routing rules used by the dispatcher.

Credential/SSE updates refresh credential state without destroying unsaved model-route form edits. If model configuration changes in another tab while the local form is dirty, the page shows a conflict banner instead of silently overwriting the edits.

All mutations use a shared structured API client that checks `response.ok`, parses server error objects, applies a timeout, and disables pending buttons.

## Admin security

Admin access is loopback-only by default.

- The default bind is `127.0.0.1`.
- If `HOST` is changed to a non-loopback address, `/admin` is refused unless `OPENAI_CC_UNSAFE_REMOTE_ADMIN=1` is explicitly set. That override does **not** add TLS or user authentication; provide your own network protections if you deliberately use it.
- Admin requests require a loopback `Host` by default.
- Browser mutations require same-origin `Origin` plus a per-process CSRF token embedded in the Admin page.
- Non-browser loopback automation (including the Windows installer) may send JSON mutations without an `Origin`; browsers cannot use a simple cross-site form to send `application/json`.
- Admin mutation bodies must be `application/json` and are limited to 64 KiB.
- Anthropic message bodies use their own separate larger limit.
- Admin responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame denial, and a nonce-based Content Security Policy.

Public Admin objects are deliberate DTOs. They never contain API keys or local auth-file paths.

## Windows installer

Run `setup.ps1` from a checkout, or run the script by itself and it will clone OpenAI-CC into `%LOCALAPPDATA%\OpenAI-CC`.

The installer remains native-PowerShell and idempotent. It does **not** invoke the VS Code `code` CLI. If VS Code support is selected, VS Code is installed/configured and the Claude Code extension is installed/enabled manually from the Extensions UI to avoid the known Windows `code.cmd` GUI/hang behavior.

The installer:

- checks/installs required Git, Node.js and ripgrep;
- builds OpenAI-CC with its pinned npm dependency set, including the official Codex CLI package used for ChatGPT login;
- creates the shared Claude projects/configuration;
- keeps automatic compaction enabled at the configured gateway capacity;
- installs/configures the existing token-efficiency tooling;
- configures Claude Desktop when selected;
- creates the per-user gateway Startup shortcut;
- starts/verifies the local gateway and Claude-safe model discovery.

The installer never asks for or embeds provider credentials.

## Manual install

```bash
git clone https://github.com/RehmTheGreat/openai-cc.git
cd openai-cc
npm ci
npm run build
npm start
```

For development:

```bash
npm install
npm test
```

## Add ChatGPT credentials from the terminal

The terminal flow uses exactly the same `OfficialCodexAuthRunner` as the Admin UI:

```bash
npm run account:add -- --id chatgpt-main --name "Personal Plus"
```

Re-authenticate an existing ChatGPT credential atomically:

```bash
npm run account:add -- --id chatgpt-main --name "Personal Plus" --reauth
```

Use the official device-auth fallback deliberately:

```bash
npm run account:add -- --id chatgpt-main --name "Personal Plus" --device-auth
```

The terminal command reports only safe job state and identifying metadata; it does not print `auth.json` or its path/content.

List credentials without secrets or auth paths:

```bash
npm run account:list
```

## API-key credentials

In the Admin UI select `OpenCode Zen`, `NVIDIA NIM`, or `Google AI Studio`, then provide a unique ID, display name, provider model id, and key. A route's configured model id is the model actually requested upstream; the model recorded on an API-key credential is useful identifying/default metadata for that credential.

## Persistence

Credentials are stored under `.data/`, which is gitignored.

`accounts.json` currently uses schema version 2 and stores `preferredCredentialByProvider`. Existing pre-v2 data migrates conservatively: if an old `activeAccountId` still exists, it becomes the preference only for that credential's provider. No preference is guessed for unrelated providers.

API keys and OAuth files are secrets even though the Admin API masks/omits them. Do not commit `.data/`.

## Endpoints

- Anthropic base URL: `http://127.0.0.1:8082`
- Claude model discovery: `GET /v1/models`
- Claude model detail: `GET /v1/models/{model_id}`
- Messages: `POST /v1/messages`
- Token estimate: `POST /v1/messages/count_tokens`
- Admin: `GET /admin`
- Admin state: `GET /admin/state`
- Health: `GET /healthz`

Credential-control endpoints include:

```text
POST   /admin/chatgpt/auth
GET    /admin/auth-jobs/:jobId
POST   /admin/auth-jobs/:jobId/cancel
POST   /admin/credentials
PATCH  /admin/credentials/:id
DELETE /admin/credentials/:id
POST   /admin/credentials/:id/prefer
POST   /admin/credentials/:id/disable
POST   /admin/credentials/:id/enable
POST   /admin/credentials/:id/reauth
POST   /admin/credentials/:id/replace-key
```

Invalid requests return structured `4xx` errors such as `400`, `403`, `404`, `409`, `413`, `415`, or `422` instead of being collapsed into generic `500` responses.

## Compatibility notes

- ChatGPT OAuth and Zen use the OpenAI Responses translation path.
- NVIDIA NIM and Google AI Studio use OpenAI-compatible Chat Completions.
- Text, images where supported, tools/tool results, non-streaming, and streaming are translated by the existing gateway translators.
- Provider/model capabilities still apply. Routing cannot make an upstream model support tools, vision, context length, or output length that the provider itself does not support.
- `POST /v1/messages/count_tokens` is a conservative local estimate rather than Anthropic's exact tokenizer.

## Tests

`npm test` builds the repository and runs **all** compiled `dist/tests/**/*.test.js` files using a Node-based test enumerator, so Windows does not depend on shell glob expansion.

The suite covers, among other things:

- account-store schema migration/persistence and explicit lifecycle operations;
- public credential secrecy;
- provider preference/rotation and route pin validation;
- pre-output and post-output rate-limit behavior;
- upstream authentication-error state/failover and secret redaction;
- official-Codex auth runner success/failure/cancel/concurrency using fake CLI processes;
- atomic failed re-auth preservation;
- Admin HTTP lifecycle/status codes;
- Host/Origin/CSRF/content-type/body-limit/security-header protections;
- critical Admin frontend invariants and dirty-form SSE behavior;
- existing Claude Desktop and Windows installer regressions.

## Security and terms

Keep the gateway on loopback unless you deliberately add appropriate network authentication/TLS protections. Treat `.data/accounts.json` and all Codex auth files as password-equivalent secrets.

Use only accounts/API keys you are authorized to use, and comply with each upstream provider's applicable terms, policies, quotas, and account restrictions.
