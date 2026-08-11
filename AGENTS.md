# OpenAI-CC agent briefing

This file is the canonical architecture briefing for humans and AI coding agents. Start from the latest `main`. Preserve behavior before optimizing structure, and validate on both Windows and Ubuntu.

## Canonical production path

- `src/index.ts` is the single production entrypoint.
- `src/dispatcher.ts` is the single production inference dispatcher. It owns `POST /v1/messages` and route-specific context/output enforcement.
- `src/control-plane.ts` owns non-inference HTTP behavior: Admin UI/API, model discovery/detail, token counting, OAuth jobs, provider CRUD, credential CRUD, SSE state updates, and Admin security.
- `src/admin/page.ts` is the Admin frontend.
- `src/model-config.ts` resolves Claude-facing slots/aliases to provider/model routes and capabilities.
- `src/provider-registry.ts` is the provider metadata/discovery/custom-provider abstraction.
- `src/account-store.ts` owns persistent credentials, provider-local preference, lifecycle state, rotation inputs, and migrations.

`src/replicated-dispatcher.ts` is only a compatibility re-export for pre-Session-5 imports/tests. Do not add production logic there.

## Request architecture

```text
Claude Code / Claude Desktop
  -> Anthropic-compatible local gateway
  -> logical Claude route
  -> configured provider/model
  -> provider-local credential selection/rotation
  -> upstream API
```

Claude-facing names are aliases (`Default`, `Fable`, `Opus`, `Sonnet`, `Haiku` plus compatible Claude model IDs). Do not expose raw upstream IDs as the public Claude model identity.

Fresh defaults:

- Default -> OpenCode Zen / `deepseek-v4-flash-free`
- Fable -> ChatGPT OAuth / `gpt-5.6-terra`
- Opus -> OpenCode Zen / `deepseek-v4-flash-free`
- Sonnet -> Google AI Studio / `gemini-3.5-flash-lite`
- Haiku -> Google AI Studio / `gemini-3.5-flash-lite`

The gateway target is 850,000 context tokens where the upstream supports it. Current recorded effective limits include DeepSeek V4 Flash Free at 200,000 and Gemini 3.5 Flash-Lite at 1,048,576 upstream input / 65,536 output, capped by the configured gateway target. Never advertise or accept a route limit above known upstream capability. Unknown custom models remain conservative unless explicitly configured/verified.

## Provider architecture

The Session 4.5 dynamic provider abstraction is canonical.

Built-ins may carry provider-specific metadata, discovery, URL construction, or authentication adapters where required. Generic OpenAI-compatible providers must share the generic path instead of adding provider-name branches.

Custom providers are persistent dynamic records managed by `ProviderRegistry`. They support:

- generated stable `custom-...` IDs;
- user-defined display name and base URL;
- `chat-completions` or `responses` API style;
- `/models` discovery when available;
- manual model fallback;
- explicit per-model context/output limits and capabilities;
- multiple credentials stored separately from provider metadata.

Never reduce providers back to a fixed `ProviderKind` universe or a hard-coded frontend provider list. The type layer may distinguish built-ins from `custom-${string}`, but runtime custom providers remain first-class.

## ChatGPT / Terra invariant

ChatGPT is intentionally specialized and must stay this way:

```text
Anthropic request
  -> FCC-style Anthropic -> Responses conversion (`fcc-responses.ts`)
  -> raw Evan/openai-oauth-compatible transport (`chatgpt-oauth.ts`)
  -> Codex `/responses`
```

Credential acquisition uses the pinned official Codex CLI through `chatgpt-auth.ts`. Runtime consumption of `auth.json` uses the raw OAuth transport boundary.

**Do not insert OpenAI SDK serialization into the ChatGPT transport path.** The OpenAI SDK is for generic OpenAI-compatible API-key providers, not Terra's OAuth wire contract.

## Credentials and persistence

`.data` is persistent user state and must survive upgrades. Never delete, rewrite wholesale, bundle, or expose it for cleanup convenience.

Important persisted concepts include:

- API-key credentials and ChatGPT managed Codex homes in account storage;
- provider-local preferred credential selection;
- ready/exhausted/auth-error/disabled lifecycle state;
- model routing and route pins;
- custom provider definitions/manual model metadata (`providers.json`);
- migrations from older stored formats.

Existing user routing must survive upgrades. A fresh-install default migration must not overwrite a user's established route choices. `scripts/configure-clients.ts` must configure clients from the existing `ModelConfigStore.snapshot()`; do not turn client refresh into a route/default rewrite.

Credential rotation is provider-local. Auto routes can move only among eligible credentials for the configured provider. Pinned routes do not fall back. Preserve rate-limit cooldown/reset handling, preference rules, auth-error handling, and exact-secret redaction.

## Admin

Admin at `http://127.0.0.1:8082/admin` is the normal configuration surface.

Preserve:

- dynamic provider metadata in the UI;
- custom provider CRUD;
- credential creation with automatic internal IDs;
- ChatGPT OAuth jobs and re-authentication;
- discovery plus manual model fallback;
- route/provider/model/credential selection;
- unsaved-form/SSE behavior;
- secret omission/redaction.

Security invariants are not cosmetic. Keep loopback-only defaults, Host/Origin validation, CSRF protection, JSON-only mutations, body limits, CSP nonce, frame denial, no-store responses, and secret-safe public DTOs. Do not add remote Admin exposure without an explicit security design.

## Claude Code and Claude Desktop

`src/claude-config.ts` configures Claude Code gateway use, clean model aliases, gateway discovery, and auto-compaction budget. `src/claude-desktop.ts` configures the Claude Desktop third-party gateway profile without exposing upstream IDs.

Sonnet/Haiku must remain suitable for Claude Auto Mode classifier traffic, subagents, and compaction. Do not regress their alias mapping, tool/image behavior, streaming, or long-context route metadata.

Startup may auto-configure Claude Code/Desktop. Preserve `OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP` opt-out behavior and the route-specific context solution rather than replacing it with a global metadata-only number.

## Installer, runtime bundle, and build identity

Session 6A makes the Windows installed runtime independent of a source checkout.

Managed layout:

```text
%LOCALAPPDATA%\OpenAI-CC\
  .data\      # persistent user-owned state
  current\    # replaceable runtime bundle contents
  install-state.json
```

- `install.ps1` is the deterministic Windows bundle bootstrap. It consumes a supplied manifest/bundle URL, verifies bundle and per-file integrity, preserves `.data`, stops only the proven managed process tree, atomically swaps `current`, configures clients, starts the gateway, and verifies the live identity.
- `setup.ps1` is only a compatibility entrypoint into `install.ps1`; it must not revive Git checkout installation.
- `scripts/build-runtime-bundle.ps1` builds the Windows runtime artifact from an explicit allowlist after development dependencies are pruned.
- `run-gateway.ps1` launches `current/dist/src/index.js` while binding `DATA_DIR` to the managed root `.data`.
- `run-claude.ps1` launches Claude against the managed gateway; it never builds source on the target PC.
- `uninstall.ps1 -KeepData` removes runtime only. `uninstall.ps1 -PurgeData` is the explicit credential/config deletion path.
- `src/build-info.ts` plus `scripts/write-build-info.ts` provide application version/source SHA/build-time identity. `/healthz` reports both managed `installRoot` and active `runtimeRoot`.
- `scripts/codex-doctor.ts` is bundled as an operational diagnostic and must remain.

Runtime bundle contents are production-only: compiled gateway code, compiled client configuration, compiled Codex doctor, production `node_modules`, package metadata, launchers, uninstaller, and internal manifest. Never include `.git`, source/tests/dev tooling, `.data`, API keys, OAuth credentials, custom provider definitions, or user `model-config.json`.

The target PC must not need Git, cloning, GitHub authentication, or a PAT. Node.js 20+ is the runtime dependency. Do not reintroduce VS Code CLI extension automation or development tooling as a runtime requirement.

Update verification must prove:

1. expected distribution/source SHA = installed build SHA = running `/healthz` build SHA;
2. expected managed root and active `current` runtime;
3. health PID owns port 8082 and the process command line is the expected entrypoint;
4. Admin and Claude configuration are available;
5. Claude aliases, `/v1/models`, output caps, and route-specific effective context agree;
6. existing `.data` is unchanged on update;
7. fresh installs use Session 4.5 defaults, while existing model routing/custom providers/credentials/preferences/status survive.

If port 8082 belongs to an unrelated process, fail. Never kill it to make installation succeed. If a runtime swap fails after activation, roll back the previous `current` runtime. Legacy Git/source files may be removed only after the new runtime is fully verified, and `.data` remains outside that cleanup.

Do not upgrade dependencies as part of packaging unless the task explicitly requires it.

## Tests and CI

`npm test` builds first and executes all compiled `dist/tests/**/*.test.js` files.

Behavioral coverage must continue to protect:

- fresh defaults, aliases, routing, route persistence, and capability limits;
- dynamic custom providers, both API styles, discovery, and manual model fallback;
- built-in providers and provider URL/model metadata;
- credential preference, provider-local rotation, pins, `401`, `429`, and redaction;
- FCC conversion and raw ChatGPT OAuth transport;
- Gemini Sonnet/Haiku vision/tools/streaming/long-context behavior;
- Auto Mode classifier-like traffic, subagent aliases, and compaction contracts where testable;
- Admin CRUD, SSE behavior, security headers, Host/Origin/CSRF, and secret omission;
- Claude Code/Desktop configuration and context metadata;
- installer/bootstrap behavior and PowerShell parsing;
- deterministic build identity and Codex doctor dependencies.

Tests should assert behavior/contracts, not obsolete filenames. If a file is renamed, update or remove filename-only assertions rather than preserving fake architecture to satisfy them.

GitHub Actions keeps the locked suite on both `ubuntu-latest` and `windows-latest`. `Runtime Bundle CI` is Windows-specific and must cover bundle production plus clean-target fresh install/update/persistence/process/integrity/uninstall behavior. A change is not done until application and packaging workflows are green.

## Critical invariants

1. Terra uses FCC translation plus raw Evan/openai-oauth transport.
2. Never insert OpenAI SDK serialization into the ChatGPT transport path.
3. Dynamic custom providers are canonical and must not be reduced to a fixed provider list.
4. `.data` contains persistent user/provider configuration and credentials; preserve it across upgrades and exclude it from bundles.
5. Existing user routing survives upgrades; client refresh never replaces `model-config.json` with defaults.
6. Claude-facing names remain clean aliases independent of upstream IDs.
7. Context/output limits reflect actual upstream capability and the configured target.
8. Unknown custom models use conservative limits until explicitly configured or verified.
9. Admin security, secret omission, and redaction must survive refactors.
10. Windows installation is bundle-based, Git-free, fails on unrelated port ownership, and verifies exact build identity.
11. Start from latest `main` and validate Windows + Ubuntu before merge.
