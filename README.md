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

## Install or update

On Windows, run `install.ps1` for the deterministic install/update flow. It synchronizes the canonical checkout to `origin/main`, preserves ignored `.data`, rebuilds from a clean `dist`, starts the gateway, and verifies the running build SHA/root. `setup.ps1` is the interactive first-time setup and can also be run from a checkout.

Manual development install:

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

## Troubleshooting

- **Admin unavailable:** the Admin surface is loopback-only by default. Keep `HOST=127.0.0.1` unless you intentionally provide separate network protection.
- **Old build still running:** rerun `install.ps1`; it removes stale `dist`, frees port 8082, and verifies the live build SHA and install root.
- **Terra/Codex issue:** after adding a ChatGPT credential in Admin, run `npm run codex:doctor`.
- **Wrong Claude context:** rerun client configuration with `node dist/scripts/configure-clients.js`, then `node scripts/verify-claude-code-context.mjs` after a build.
- **Model not discoverable:** add the upstream model ID manually in Admin and configure conservative/verified limits.

## Development

```bash
npm ci
npm test
npm run build
npm start
npm run codex:doctor
```

CI runs the locked test suite on Windows and Ubuntu, verifies Claude Code context configuration, and parses both PowerShell installers on Windows.

For the canonical architecture, persistent-data contracts, tests, and invariants for coding agents, read [`AGENTS.md`](AGENTS.md).
