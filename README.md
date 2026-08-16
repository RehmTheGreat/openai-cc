# OpenAI-CC

OpenAI-CC is a small local Node/TypeScript Anthropic-compatible routing gateway for Claude Code and Claude Desktop.

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

- Claude sees exactly five logical routes: `default`, `fable`, `opus`, `sonnet`, `haiku`.
- Admin has one Claude context-window number. The same value drives Claude's displayed context, `/v1/models`, and auto-compaction.
- The fresh context default is 1,050,000 tokens, with no arbitrary OpenAI-CC 1M ceiling.
- If a selected upstream supports less than the configured request, that upstream returns its own error; OpenAI-CC does not maintain a per-model clamp database.
- Per-route output limits remain configurable.
- OpenAI-CC does not maintain a hardcoded per-model friendly-name/context/output capability catalog.
- Provider model discovery returns the model IDs exposed by the provider.
- Inference is not blocked by a local character/token heuristic or local context estimator.
- Responses tool-result images remain structured multimodal content rather than being converted to base64 text.
- Auto routes use the preferred ready credential for that provider and can rotate only within that provider. Pinned routes never silently fall back.

Fresh routing defaults are:

| Route | Provider | Model |
| --- | --- | --- |
| Default | ChatGPT OAuth | `gpt-5.6-luna` |
| Fable | ChatGPT OAuth | `gpt-5.6-luna` |
| Opus | OpenCode Zen | `deepseek-v4-flash-free` |
| Sonnet | Google AI Studio | `gemini-3.5-flash-lite` |
| Haiku | Google AI Studio | `gemini-3.5-flash-lite` |

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

The Windows Startup shortcut starts OpenAI-CC at sign-in. There is no crash watchdog that continually resurrects the process; manually killing the gateway leaves it stopped until the user starts it again or signs in again.

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
