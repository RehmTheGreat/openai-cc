# OpenAI-CC agent briefing

This is the canonical architecture briefing for humans and coding agents. Start from latest `main`, preserve existing user state, and validate application behavior on Windows and Ubuntu plus the production runtime lifecycle before merging.

## Purpose

OpenAI-CC is a minimal local Anthropic-compatible router/proxy for Claude Code and Claude Desktop. Its job is routing, credential selection, protocol translation, and a small Admin configuration surface. Avoid turning it into a model-policy database, telemetry product, process supervisor, or general-purpose inference framework.

```text
Claude Code / Claude Desktop
  -> http://127.0.0.1:8082
  -> Default / Fable / Opus / Sonnet / Haiku
  -> configured provider + model
  -> provider-local credential selection
  -> upstream
```

## Canonical production path

- `src/index.ts`: single production entrypoint.
- `src/dispatcher.ts`: `POST /v1/messages` inference routing.
- `src/control-plane.ts`: Admin/model discovery/OAuth/provider/credential HTTP surface.
- `src/admin/page.ts`: Admin frontend.
- `src/model-config.ts`: one Claude context setting plus five logical provider/model routes, output caps, pins, and optional capability overrides.
- `src/provider-registry.ts`: provider protocol/discovery/base-URL/custom-provider abstraction.
- `src/account-store.ts`: credentials, preference, lifecycle state, rotation inputs, persistence/migrations.
- `src/replicated-dispatcher.ts`: compatibility re-export only; add no production logic there.

## Fresh routing

- Default -> ChatGPT OAuth / `gpt-5.6-luna`
- Fable -> ChatGPT OAuth / `gpt-5.6-luna`
- Opus -> OpenCode Zen / `deepseek-v4-flash-free`
- Sonnet -> Google AI Studio / `gemini-3.5-flash-lite`
- Haiku -> Google AI Studio / `gemini-3.5-flash-lite`

The fresh **Claude context window** is 1,050,000 tokens. It is a user-editable configuration default, not an OpenAI-CC claim about any upstream model. Existing persisted routing and context configuration wins on upgrade.

## Context and model metadata

There is one authoritative context-window number in Admin. Do not create a second route-specific, provider-specific, or model-specific context policy inside OpenAI-CC.

- `ModelConfig.contextWindow` is the single source of truth.
- `/v1/models` exposes that same `max_input_tokens` value for each of the five logical Claude routes.
- Claude Code receives the same number as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- `DISABLE_COMPACT` stays false so Claude's own compaction remains enabled.
- Claude Desktop's gateway model metadata uses the same Admin context.
- If a selected upstream cannot support the configured request, the upstream is authoritative and returns its own error.
- Do not impose an arbitrary 1M/850K/200K OpenAI-CC ceiling.
- Do not maintain hardcoded per-model friendly names, context windows, output caps, or capability catalogs.
- Provider discovery should report model IDs exposed by the provider.
- Do not reject inference using a local character/token heuristic.
- Do not add a local inference token-count estimator merely to preflight context.

Older persisted per-route context values may be migrated into the one global setting for compatibility, but new state must not persist or expose separate route context values.

Route capability overrides remain useful for protocol behavior where provider discovery does not report capabilities, but they must not become a model-capability database.

## Claude-facing identity

Claude-facing public model IDs are exactly the five logical routes:

`default`, `fable`, `opus`, `sonnet`, `haiku`.

Do not expose upstream model IDs, `[1m]` variants, or private `openai-cc-*` carrier IDs as additional picker rows. Old carrier IDs may remain accepted internally only to keep already-open sessions routable.

## ChatGPT/Codex invariant

ChatGPT OAuth is intentionally specialized:

```text
Anthropic request
  -> FCC-style Anthropic -> Responses conversion (`fcc-responses.ts`)
  -> raw Evan/openai-oauth-compatible transport (`chatgpt-oauth.ts`)
  -> Codex `/responses`
```

Credential acquisition uses the pinned official Codex CLI through `chatgpt-auth.ts`. Runtime consumption of `auth.json` uses the raw OAuth transport boundary.

**Never insert OpenAI SDK request serialization into the ChatGPT OAuth inference path.** Generic API-key providers may use the OpenAI SDK.

Preserve multimodal semantics: images, including images inside Anthropic `tool_result`, must reach Responses as structured image content rather than JSON/base64 text.

A successful Responses call with no usable text/tool output is an explicit upstream failure, not a normal empty assistant response. Preserve real upstream input/output usage when the wire format permits it.

## Providers

Dynamic custom providers are first-class. Preserve generated `custom-...` IDs, base URL, API style, optional service tier, model discovery, and independent credentials.

Built-ins may have provider-specific authentication, URL construction, discovery mechanics, or protocol selection where required. Do not add per-model knowledge merely for convenience.

Credential rotation is provider-local. Auto routes can move only among ready credentials for the configured provider. Pinned routes do not fall back. Preserve upstream-driven ChatGPT rate-limit reset handling, the Admin Retry probe, authentication-error handling, and secret redaction.

## Persistence

`.data` is persistent user state and must survive upgrades. Never delete, bundle, expose, or wholesale rewrite it for cleanup convenience.

Persisted concepts include credentials/Codex homes, preferred credentials, lifecycle status, one Claude context setting, routes/pins/output caps/capability overrides, custom provider definitions, and compatible migrations.

Client refresh must read `ModelConfigStore.snapshot()`; it must not replace existing route choices with fresh defaults.

Account persistence is serialized and uses unique atomic temp files. Background reset-timer errors must remain caught so sleep/resume timer convergence cannot terminate Node through an unhandled rejection.

## Admin

Admin at `http://127.0.0.1:8082/admin` is a small configuration surface. Preserve provider/credential CRUD, ChatGPT OAuth and Retry, model discovery, routing, the single Claude context control, unsaved-form/SSE behavior, and secret omission.

Keep loopback defaults, Host/Origin checks, CSRF protection, JSON-only mutations, body limits, CSP nonce, frame denial, and no-store responses. Do not add remote Admin exposure or persistent diagnostics without an explicit design requirement.

Do not label locally supplied metadata as provider/API-reported. If the provider did not report a value, do not decorate it with a hardcoded model fact.

## Claude clients

`src/claude-config.ts` configures Claude Code. `src/claude-desktop.ts` configures Claude Desktop's third-party gateway profile.

Preserve exactly five logical routes and keep upstream IDs internal. Sonnet/Haiku must remain suitable for Auto Mode classifier traffic, subagents, and compaction. Claude's displayed context and auto-compaction follow the one Admin context setting.

Do not create `[1m]` duplicate models or `supports1m` variants merely to influence Claude's UI. Do not patch the Claude client when its supported environment configuration can express the requested context cleanly.

## Process lifetime

OpenAI-CC is not an unkillable service.

- Windows may start it through the existing Startup shortcut at sign-in.
- macOS may load it at login, but the LaunchAgent must not use `KeepAlive=true`.
- Do not add a watchdog, polling supervisor, wake-triggered resurrection task, or restart loop.
- If the user deliberately kills the gateway process, it stays stopped until explicitly launched again or the next normal login-start behavior occurs.

## Installer/runtime

Windows production installation is bundle-based and Git-free:

```text
%LOCALAPPDATA%\OpenAI-CC\
  .data\
  current\
  install-state.json
```

`install.ps1` verifies bundle/build identity, protects `.data`, stops only a proven managed process tree, atomically swaps `current`, configures clients, starts and verifies the new gateway, and rolls back on activation failure. Never kill an unrelated process on port 8082.

Runtime bundles contain compiled production code/dependencies, launchers, package metadata, migration/client configuration helpers, and Codex doctor. Never include Git history, source/tests/dev tooling, `.data`, credentials, or user configuration.

Installer verification may assert the fresh provider/model routing contract and the configured global context, but must not hardcode upstream model capability limits. `codex:doctor` should probe the configured ChatGPT model rather than pinning a historical model name.

## Tests and CI

Protect at least:

- Luna fresh defaults and preservation of existing routes;
- one arbitrary positive Admin context setting without an OpenAI-CC 1M cap;
- exactly five public Claude route IDs;
- real Claude Code context display and auto-compaction using the Admin value while compaction remains enabled;
- provider-authoritative model discovery with no hardcoded model catalog;
- FCC/raw ChatGPT transport and multimodal tool-result conversion;
- no heuristic inference context rejection;
- real upstream usage propagation and explicit empty-upstream response handling;
- provider-local rotation, pins, `401`, `429`, Retry, and redaction;
- account-store crash/sleep persistence hardening;
- Admin security and secret omission;
- deterministic Windows/macOS runtime packaging, update preservation, process ownership, corruption rejection, and uninstall behavior.

`npm test` builds and runs all compiled tests. GitHub Actions application tests run on Ubuntu and Windows; production runtime workflows cover packaging/install/update behavior. A cross-cutting change is not complete until the relevant application and runtime workflows are green.

## Critical invariants

1. ChatGPT OAuth uses FCC translation plus raw Evan/openai-oauth transport.
2. No OpenAI SDK serialization in that path.
3. Exactly five public Claude routes; upstream IDs stay internal.
4. One Admin context number is configuration truth for Claude UI, gateway metadata, and compaction; no arbitrary OpenAI-CC model ceilings or hardcoded per-model capability catalog.
5. No local heuristic inference token gate.
6. Preserve structured multimodal tool results.
7. Dynamic custom providers remain first-class.
8. `.data` and established routing survive upgrades.
9. Rate-limit Retry and sleep/crash persistence fixes remain intact.
10. No watchdog or forced process resurrection.
11. Admin security and secret redaction survive refactors.
12. Windows installation remains deterministic, bundle-based, Git-free, and safe around unrelated port owners.
