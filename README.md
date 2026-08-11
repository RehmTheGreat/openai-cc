# OpenAI-CC

OpenAI-CC is a local Node/TypeScript Anthropic-compatible gateway for Claude Code and Claude Desktop. The Admin UI is the normal configuration surface: Claude-facing route aliases map to a provider/model, then OpenAI-CC selects a ready credential only from that provider and sends the request upstream.

```text
Claude Code / Claude Desktop
  -> http://127.0.0.1:8082
  -> logical route (Default/Fable/Opus/Sonnet/Haiku)
  -> configured provider + model
  -> provider-local credential rotation
  -> upstream
```

## Install or update on Windows

Session 6A installs from a versioned runtime bundle, not from a Git checkout. A distribution consists of:

- `install.ps1` — small bootstrap;
- `openai-cc-runtime-manifest.json` — application/source/build identity plus bundle integrity metadata;
- `openai-cc-runtime-<version>-<sha>-win-x64.zip` — compiled runtime and production dependencies only.

Given a manifest URL supplied by the distributor:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ManifestUrl "https://distribution.example/openai-cc-runtime-manifest.json"
```

Rerun the same command with a newer manifest URL to update. Git, cloning the source repository, GitHub authentication, and a GitHub PAT are not required on the target PC.

The managed layout is:

```text
%LOCALAPPDATA%\OpenAI-CC\
  .data\      # user-owned persistent credentials/providers/routes/config
  current\    # replaceable verified runtime
  install-state.json
```

The installer downloads, verifies, fingerprints existing `.data`, stops only the managed OpenAI-CC process tree, swaps `current` atomically, refreshes Claude client configuration, starts the gateway, and verifies expected source SHA = installed build SHA = `/healthz` build SHA. It refuses to kill an unrelated process on port 8082 and rolls back the runtime swap on failure. Existing `model-config.json`, custom providers, provider credentials, route pins/selections, preferred credentials, and credential status are preserved on updates.

If Claude Code is absent, installation still succeeds. If Claude Desktop is already installed, its supported gateway integration is refreshed unless `-SkipDesktopConfig` is supplied. The runtime itself requires Node.js 20+; the installer can use WinGet for a missing/outdated Node.js installation. It does not automate the unreliable VS Code CLI extension path.

Uninstall is explicit:

```powershell
# Remove runtime, keep credentials/configuration
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\OpenAI-CC\current\uninstall.ps1" -KeepData

# Permanently remove runtime and .data credentials/configuration
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\OpenAI-CC\current\uninstall.ps1" -PurgeData
```

Full credential deletion therefore requires the explicit `-PurgeData` action.

Manual development checkout remains available for contributors:

```bash
git clone https://github.com/RehmTheGreat/openai-cc.git
cd openai-cc
npm ci
npm run build
npm start
```

Gateway: `http://127.0.0.1:8082`  
Admin: `http://127.0.0.1:8082/admin`

Add credentials, discover or enter model IDs, create custom providers, and edit routes in Admin. Secrets stay server-side under `.data` and are not returned by the Admin API.

## Fresh-install routing

| Route | Provider | Model | Effective input context |
| --- | --- | --- | ---: |
| Default | OpenCode Zen | `deepseek-v4-flash-free` | 200,000 |
| Fable | ChatGPT OAuth | `gpt-5.6-terra` | up to configured 850,000 target |
| Opus | OpenCode Zen | `deepseek-v4-flash-free` | 200,000 |
| Sonnet | Google AI Studio | `gemini-3.5-flash-lite` | up to configured 850,000 target |
| Haiku | Google AI Studio | `gemini-3.5-flash-lite` | up to configured 850,000 target |

Gemini Flash-Lite is recorded with 1,048,576 upstream input and 65,536 output. OpenAI-CC caps advertised/enforced limits to the route target and the known upstream capability. Unknown custom models stay conservative until explicit limits are configured or verified.

Claude-facing names remain clean aliases; upstream provider/model IDs are internal routing details.

## Providers

Built-ins include ChatGPT OAuth, OpenCode Zen, NVIDIA NIM, Google AI Studio, and Cloudflare Workers AI. Admin can also create persistent OpenAI-compatible custom providers with:

- custom base URLs;
- Chat Completions or Responses API style;
- model discovery when the provider exposes it;
- manual model IDs when discovery is unavailable;
- explicit context/output capability limits;
- multiple API-key credentials with provider-local preference and failover.

ChatGPT is intentionally special. Terra uses the FCC-style Anthropic -> Responses conversion and the raw Evan/openai-oauth-compatible Codex transport. Do not route ChatGPT through OpenAI SDK request serialization.

## Context and routing behavior

The global target is 850,000 tokens, but each route is capped by its configured provider/model capability. `/v1/models`, Claude Code/Desktop configuration, input enforcement, and output caps use the same route-specific metadata. A route never advertises more context/output than its known upstream can support.

Auto routes try the preferred ready credential for that provider, then other ready credentials from the same provider. `401` and pre-output `429` handling can rotate provider-locally. Pinned routes never silently fall back to another credential.

## Runtime bundle production

On a Windows build target after the normal build, prune development dependencies and produce the runtime artifact:

```powershell
$env:OPENAI_CC_SOURCE_SHA = (git rev-parse HEAD).Trim()
$env:OPENAI_CC_BUILD_TIME = (git show -s --format=%cI HEAD).Trim()
npm run build
npm prune --omit=dev --no-audit --no-fund
.\scripts\build-runtime-bundle.ps1 -OutputDirectory .\artifacts
```

The bundle allowlist contains compiled gateway code, compiled client configuration and `codex:doctor`, production `node_modules`, package metadata, launchers, and the uninstaller. It excludes Git history, source/tests/dev tooling, `.data`, API keys, OAuth credentials, custom providers, and user model configuration. Session 6B is responsible for gated/private distribution hosting; Session 6A is URL-agnostic.

## Troubleshooting

- **Admin unavailable:** the Admin surface is loopback-only by default. Keep `HOST=127.0.0.1` unless you intentionally provide separate network protection.
- **Port 8082 occupied:** the installer stops only a process it can prove belongs to the managed OpenAI-CC root. It fails instead of killing an unrelated service.
- **Terra/Codex issue:** if usable ChatGPT OAuth already exists, installation runs bundled `codex:doctor`. Without credentials, installation succeeds and directs configuration to Admin.
- **Wrong Claude context:** inspect `/v1/models` and `/admin/state`; install verification checks Claude aliases against route-specific effective context instead of assuming every route is 850K.
- **Model not discoverable:** add the upstream model ID manually in Admin and configure conservative/verified limits.

## Development

```bash
npm ci
npm test
npm run build
npm run codex:doctor
```

CI keeps the locked application suite on Windows and Ubuntu. Windows runtime-bundle CI also builds the production artifact and performs clean-target fresh install, idempotent update, persistent-state update, managed/unrelated process handling, corruption/download rejection, and both uninstall modes.

For the canonical architecture, persistent-data contracts, tests, and invariants for coding agents, read [`AGENTS.md`](AGENTS.md).
