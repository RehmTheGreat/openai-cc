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
- `src/model-config.ts`: five logical routes and their configured context/output/capability values.
- `src/provider-registry.ts`: provider protocol/discovery/base-URL/custom-provider abstraction.
- `src/account-store.ts`: credentials, preference, lifecycle state, rotation inputs, persistence/migrations.
- `src/replicated-dispatcher.ts`: compatibility re-export only; add no production logic there.

## Fresh routing

- Default -> ChatGPT OAuth / `gpt-5.6-luna`
- Fable -> ChatGPT OAuth / `gpt-5.6-luna`
- Opus -> OpenCode Zen / `deepseek-v4-flash-free`
- Sonnet -> Google AI Studio / `gemini-3.5-flash-lite`
- Haiku -> Google AI Studio / `gemini-3.5-flash-lite`

Fresh route context values are currently 1,050,000, but they are configuration defaults, not OpenAI-CC claims about provider/model capability. Existing users' persisted routes and limits always win over fresh defaults.

## Context and model metadata

The Admin route value is authoritative for OpenAI-CC configuration:

- `/v1/models` advertises the configured route context/output values.
- Claude client configuration is generated from those same route values.
- Claude auto-compaction uses the largest configured route context because Claude exposes one process-level setting.
- Do not impose a second arbitrary 1M/850K/200K OpenAI-CC ceiling.
- Do not maintain hardcoded per-model friendly names, context windows, output caps, or capability catalogs.
- Provider discovery should report model IDs exposed by the provider.
- Do not reject inference using a local character/token heuristic. The upstream provider is authoritative if a configured request exceeds its actual capability.
- If Claude displays a context ceiling, it must not be a fabricated OpenAI-CC fallback. Omission is preferable to a false 200K value.

Route capability overrides remain useful where provider discovery does not report protocol capabilities, but do not infer model-specific limits from OpenAI-CC's own catalog.

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

Persisted concepts include credentials/Codex homes, preferred credentials, lifecycle status, routes/pins/limits/capability overrides, custom provider definitions, and compatible migrations.

Client refresh must read `ModelConfigStore.snapshot()`; it must not replace existing route choices with fresh defaults.

Account persistence is serialized and uses unique atomic temp files. Background reset-timer errors must remain caught so sleep/resume timer convergence cannot terminate Node through an unhandled rejection.

## Admin

Admin at `http://127.0.0.1:8082/admin` is a small configuration surface. Preserve provider/credential CRUD, ChatGPT OAuth and Retry, model discovery, routing, unsaved-form/SSE behavior, and secret omission.

Keep loopback defaults, Host/Origin checks, CSRF protection, JSON-only mutations, body limits, CSP nonce, frame denial, and no-store responses. Do not add remote Admin exposure or persistent diagnostics without an explicit design requirement.

Do not label locally supplied metadata as provider/API-reported. If the provider did not report a value, do not decorate it with a hardcoded model fact.

## Claude clients

`src/claude-config.ts` configures Claude Code. `src/claude-desktop.ts` configures Claude Desktop's third-party gateway profile.

Preserve exactly five logical routes and keep upstream IDs internal. Sonnet/Haiku must remain suitable for Auto Mode classifier traffic, subagents, and compaction. Context and auto-compaction settings follow Admin route configuration.

Do not create `[1m]` duplicate models or `supports1m` variants merely to influence Claude's UI.

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

Installer verification may assert the fresh provider/model routing contract, but must not hardcode upstream model capability limits. `codex:doctor` should probe the configured ChatGPT model rather than pinning a historical model name.

## Tests and CI

Protect at least:

- Luna fresh defaults and preservation of existing routes;
- arbitrary positive route context/output values without an OpenAI-CC 1M cap;
- exactly five public Claude route IDs;
- provider-authoritative model discovery with no hardcoded model catalog;
- FCC/raw ChatGPT transport and multimodal tool-result conversion;
- no heuristic inference context rejection;
- real upstream usage propagation and explicit empty-upstream response handling;
- provider-local rotation, pins, `401`, `429`, Retry, and redaction;
- account-store crash/sleep persistence hardening;
- Admin security and secret omission;
- Claude Code/Desktop configuration and compaction values;
- deterministic Windows/macOS runtime packaging, update preservation, process ownership, corruption rejection, and uninstall behavior.

`npm test` builds and runs all compiled tests. GitHub Actions application tests run on Ubuntu and Windows; production runtime workflows cover packaging/install/update behavior. A cross-cutting change is not complete until the relevant application and runtime workflows are green.

## Critical invariants

1. ChatGPT OAuth uses FCC translation plus raw Evan/openai-oauth transport.
2. No OpenAI SDK serialization in that path.
3. Exactly five public Claude routes; upstream IDs stay internal.
4. Admin route context/output values are configuration truth; no arbitrary OpenAI-CC model ceilings or hardcoded per-model capability catalog.
5. No local heuristic inference token gate.
6. Preserve structured multimodal tool results.
7. Dynamic custom providers remain first-class.
8. `.data` and established routing survive upgrades.
9. Rate-limit Retry and sleep/crash persistence fixes remain intact.
10. No watchdog or forced process resurrection.
11. Admin security and secret redaction survive refactors.
12. Windows installation remains deterministic, bundle-based, Git-free, and safe around unrelated port owners.
