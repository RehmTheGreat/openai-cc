# OpenAI-CC

OpenAI-CC is a local Node/TypeScript Anthropic-compatible gateway for ZCode and other compatible coding clients. It routes requests through ChatGPT/Codex OAuth by default. Claude Code and Claude Desktop integrations remain available.

```text
Claude Code / Claude Desktop
  -> http://127.0.0.1:8082
  -> Default / Fable / Opus / Sonnet / Haiku
  -> configured provider + model
  -> provider-local credential selection
  -> upstream
```

The Admin UI at `http://127.0.0.1:8082/admin` is the normal configuration surface. Secrets remain server-side under `.data` and are not returned by the Admin API.

## Core behavior

OpenAI-CC deliberately keeps model policy simple:

- The gateway exposes four versioned model IDs to ZCode and retains five internal logical routes, including the private `default` fallback.
- Admin has one Claude context-window number. The same value drives Claude's displayed context, `/v1/models`, and auto-compaction.
- The fresh context default is 1,050,000 tokens, with no arbitrary OpenAI-CC 1M ceiling.
- If a selected upstream supports less than the configured request, that upstream returns its own error; OpenAI-CC does not maintain a per-model clamp database.
- Per-route output limits remain configurable.
- OpenAI-CC does not maintain a hardcoded per-model friendly-name/context/output capability catalog.
- Provider model discovery returns the model IDs exposed by the provider.
- Inference is not blocked by a local character/token heuristic or local context estimator.
- Responses tool-result images remain structured multimodal content rather than being converted to base64 text.
- Auto routes use the preferred ready credential for that provider and can rotate only within that provider. Pinned routes never silently fall back.

Fresh routing defaults send every route through ChatGPT OAuth / Codex using `gpt-5.6-luna`:

| ZCode model ID | Display name | Gateway route |
| --- | --- | --- |
| `claude-fable-5-1` | Fable 5.1 | Fable |
| `claude-opus-5-5` | Opus 5.5 | Opus |
| `claude-sonnet-5-5` | Sonnet 5.5 | Sonnet |
| `claude-haiku-5-5` | Haiku 5.5 | Haiku |

In ZCode, add a custom Anthropic-compatible provider with base URL `http://127.0.0.1:8082` and any placeholder API key. Add the four model IDs above once. The gateway advertises image, PDF, structured-output, and reasoning-effort capabilities for its ChatGPT OAuth routes; ZCode can show its effort selector without creating separate model entries for each effort level. Existing saved routes and credentials remain unchanged on upgrade.

The 1,050,000-token fresh context value is configuration, not a claim by OpenAI-CC about any model's upstream capability. Existing user routing and context configuration survive upgrades.

## Claude context and compaction

Claude Code is configured from the same Admin value through its supported gateway environment:

- `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<Admin context>`
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<Admin context>`
- `DISABLE_COMPACT=0`

This keeps Claude's own compaction enabled while avoiding the generic 200K fallback for the five logical gateway routes. CI verifies the behavior against the pinned real Claude Code client rather than relying only on metadata tests.

OpenAI-CC does not create `[1m]` duplicate models, `supports1m` variants, or extra carrier rows to manipulate the model picker.

## ChatGPT OAuth

ChatGPT is intentionally specialized:

```text
Anthropic request
  -> FCC-style Anthropic -> Responses conversion
  -> raw Evan/openai-oauth-compatible transport
  -> Codex /responses
```

Do not insert OpenAI SDK request serialization into this path. ChatGPT rate-limit state follows upstream reset information when available, and an exhausted ChatGPT credential can be tested explicitly with **Retry** in Admin.

## Providers

Built-ins include ChatGPT OAuth, OpenCode Zen, NVIDIA NIM, Google AI Studio, and Cloudflare Workers AI. Admin can also create persistent OpenAI-compatible custom providers with a base URL, Chat Completions or Responses API style, optional service tier, provider model discovery, and multiple API-key credentials.

## Windows install/update

Production Windows installation uses a versioned runtime bundle rather than a Git checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ManifestUrl "https://distribution.example/openai-cc-runtime-manifest.json"
```

Managed layout:

```text
%LOCALAPPDATA%\OpenAI-CC\
  .data\      # persistent credentials/providers/routes/config
  current\    # replaceable verified runtime
  install-state.json
```

The installer verifies the bundle/build identity, preserves `.data`, stops only a process proven to be the managed OpenAI-CC gateway, atomically swaps `current`, refreshes client configuration, starts the new runtime, and verifies it. An unrelated process on port 8082 is never killed.

Windows startup uses an explicitly enabled per-user `HKCU\...\Run` entry that launches PowerShell directly, plus a delayed per-user Task Scheduler logon trigger as an independent fallback. Both are one-shot sign-in mechanisms, not crash watchdogs: manually killing the gateway leaves it stopped until the user starts it again or signs in again.

Uninstall:

```powershell
# Runtime only; keep credentials/configuration
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\OpenAI-CC\current\uninstall.ps1" -KeepData

# Runtime + persistent data
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\OpenAI-CC\current\uninstall.ps1" -PurgeData
```

## Development

```bash
git clone https://github.com/RehmTheGreat/openai-cc.git
cd openai-cc
npm ci
npm test
npm run build
npm run codex:doctor
```

Gateway: `http://127.0.0.1:8082`  
Admin: `http://127.0.0.1:8082/admin`

CI validates the application on Windows and Ubuntu plus the production runtime lifecycle. For the canonical architecture and invariants for coding agents, read [`AGENTS.md`](AGENTS.md).
