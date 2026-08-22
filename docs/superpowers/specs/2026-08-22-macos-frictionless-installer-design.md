# Frictionless macOS Installer Design

## Goal

Ship one durable public `.command` installer that turns a bare Apple Silicon Mac into a working OpenAI-CC + Claude environment with one run: provision private runtime dependencies, install OpenAI-CC, install/configure Claude Desktop and Claude Code, verify the real execution path, open Admin for API-key setup, and provide a safe uninstall path.

## Root causes being fixed

1. The generated macOS client bootstrap used CommonJS `require()` together with top-level `await`, which Node 24 rejects as ambiguous module syntax.
2. The bootstrap required Node 20+ to already exist, so a bare Mac could not install OpenAI-CC.
3. Claude Code and Claude Desktop were treated as external prerequisites instead of client-facing dependencies.
4. Claude Desktop configuration was gated on `Claude.app` already existing before OpenAI-CC installation, making the install order backwards.
5. `GET /` returned a not-found response even though the user naturally expected the local OpenAI-CC UI there.
6. There was no native macOS uninstaller or ownership tracking, forcing destructive manual cleanup.
7. The existing generated macOS installer embeds a 48-hour B2 read grant. Uploading that file publicly produces a link whose installer expires, which is unsuitable for client distribution.

## Distribution architecture

The public macOS installer will be self-contained and non-expiring. A new macOS build step creates the normal deterministic runtime bundle, then emits a single `.command` file containing the exact `install.sh`, `install-macos.mjs`, runtime manifest, and runtime ZIP as embedded base64 payloads. The wrapper validates the embedded manifest/bundle hashes before installation.

This public artifact contains no B2 publisher/issuer credentials, no account/provider state, and no user secrets. Windows gated-B2 distribution remains unchanged.

## Bare-Mac dependency provisioning

The `.command` wrapper must work without Node, Homebrew, npm, Git, or Claude installed. It uses only macOS system tools (`bash`, `curl`, `shasum`, `tar`, `hdiutil`, `ditto`, `codesign`, `open`).

For Node, the wrapper downloads the current official Node 22 LTS Apple-Silicon archive from `https://nodejs.org/dist/latest-v22.x/`, obtains the exact archive filename/hash from `SHASUMS256.txt`, verifies SHA-256, and extracts it to a temporary bootstrap directory. `install-macos.mjs` receives that Node root and atomically copies it into `~/Library/Application Support/OpenAI-CC/toolchain/node`. The LaunchAgent always references this persistent private Node executable, never a temporary/system Node path.

Existing system Node installations are irrelevant to correctness and are not modified.

## Claude provisioning

### Claude Desktop

If `/Applications/Claude.app` or `~/Applications/Claude.app` already exists, OpenAI-CC records it as user-owned and leaves it in place. Otherwise the installer downloads Anthropic's official universal macOS DMG from `https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect`, mounts it read-only, verifies the application with `codesign --verify --deep --strict`, copies `Claude.app` into `~/Applications`, verifies the copied signature, and records that OpenAI-CC installed it.

Claude Desktop is provisioned before OpenAI-CC writes the managed 3P gateway profile. Configuration therefore succeeds on both fresh and existing Macs without rerunning the installer.

### Claude Code

If `claude` already exists, it is preserved and recorded as user-owned. Otherwise the installer downloads Anthropic's official `https://claude.ai/install.sh`, runs it as the current user, then verifies `~/.local/bin/claude --version`. If the upstream installer populated `~/.local/share/claude/versions` but failed to create the launcher, OpenAI-CC repairs the user-local symlink. The installer never runs `npm install -g` and never uses `sudo`.

A single idempotent PATH line for `$HOME/.local/bin` is added to `~/.zshrc` only when OpenAI-CC installed Claude Code and only if no equivalent line is already present.

## Installation order

1. Validate Apple Silicon macOS.
2. Create a temporary workspace with cleanup trap.
3. Materialize and hash-check embedded OpenAI-CC payloads.
4. Download and hash-check temporary Node 22 bootstrap runtime.
5. Run `install-macos.mjs` with the verified bootstrap Node root.
6. Atomically install/update OpenAI-CC runtime and persistent private Node.
7. Start/verify the gateway.
8. Provision Claude Desktop and Claude Code when missing.
9. Configure Claude Code and Claude Desktop against `http://127.0.0.1:8082`.
10. Verify `/healthz`, `/admin`, `/`, four Claude-facing routes, Claude settings/profile files, persistent Node executable, Claude Code executable, and Claude Desktop app.
11. Write ownership-aware `install-state.json` and install the uninstaller.
12. Open `http://127.0.0.1:8082/admin` for API-key setup. Do not require another OpenAI-CC run.

## Local web behavior

When bound to loopback, `GET /` returns an HTTP redirect to `/admin`. Remote/non-loopback safety remains unchanged.

## Uninstall design

The runtime includes `uninstall-macos.mjs` and installs an executable `~/Library/Application Support/OpenAI-CC/uninstall.command`.

The uninstaller:

- validates it is operating on the expected OpenAI-CC root;
- unloads `com.openai-cc.gateway`;
- terminates port 8082 only when `/healthz` proves the listener belongs to that install root;
- surgically removes only OpenAI-CC-owned keys from `~/.claude/settings.json` and preserves unrelated Claude settings;
- removes only the OpenAI-CC Claude Desktop profile/meta entry rather than deleting Claude's whole Application Support tree;
- removes Claude Desktop only if `install-state.json` says OpenAI-CC installed it;
- removes Claude Code and the PATH line only if OpenAI-CC installed them;
- removes OpenAI-CC logs, LaunchAgent, runtime, private Node, and state;
- is idempotent and safe to rerun.

## State and ownership

`install-state.json` gains a `managedDependencies` object recording:

- persistent Node path/version (always OpenAI-CC owned),
- Claude Desktop path and `installedByOpenAICC`,
- Claude Code path and `installedByOpenAICC`,
- whether OpenAI-CC added the zsh PATH line.

Updates preserve these ownership facts so software that became pre-existing is never incorrectly claimed.

## Testing

TDD coverage must prove each regression before implementation:

- generated mac bootstrap contains no CommonJS/top-level-await ambiguity and passes Node 24 syntax execution;
- public installer has no B2 credential/grant/expiry dependency;
- bootstrap can provision Node when no `node` is on PATH and verifies SHA-256 metadata;
- LaunchAgent points to persistent private Node, not a temporary path;
- fresh install provisions/configures Desktop after installation rather than gating config on pre-existence;
- existing Claude Desktop/Claude Code are preserved and marked user-owned;
- `GET /` redirects to `/admin`;
- uninstall removes only OpenAI-CC-owned state and preserves unrelated Claude config/software;
- bundle remains free of `.data`, credentials, auth files, and Git metadata;
- complete `npm test` remains green;
- macOS ARM64 CI performs bundle install/reinstall tests and produces the self-contained installer artifact.

## Release and delivery

After branch verification, merge the changes to `main`, run the macOS release workflow on the exact merged SHA, download the generated `.command` artifact, calculate SHA-256, upload it to Google Drive, set permission to `anyone`/reader, read the permission back, and return the public Drive link plus checksum.
