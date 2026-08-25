# Frictionless macOS Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one durable public Apple-Silicon macOS installer that provisions OpenAI-CC, private Node, Claude Desktop, Claude Code, safe configuration, verification, and uninstall without requiring a second installer run.

**Architecture:** Keep the deterministic runtime bundle, but add a public self-contained `.command` packager so macOS distribution no longer depends on expiring B2 grants. The shell bootstrap uses only macOS system tools until a verified Node 22 bootstrap runtime is available; `install-macos.mjs` then owns atomic runtime/toolchain/client provisioning and records ownership for a surgical uninstaller.

**Tech Stack:** Bash/zsh-compatible shell, Node.js 22+ ESM, TypeScript, macOS launchd/hdiutil/ditto/codesign, GitHub Actions macos-14, Google Drive.

**Spec:** `docs/superpowers/specs/2026-08-22-macos-frictionless-installer-design.md`

## Global Constraints

- Apple Silicon macOS only (`darwin-arm64`).
- No prerequisite Node, npm, Homebrew, Git, Claude Code, or Claude Desktop on target Macs.
- Never use `sudo` or global npm for Claude Code.
- Never delete pre-existing Claude software or unrelated Claude configuration.
- Public installer must not contain B2 credentials, B2 grants, API keys, OAuth state, `.data`, or an expiry timer.
- Windows distribution behavior remains unchanged.
- Every behavior change starts with a failing automated test and is verified green before the next behavior.

---

### Task 1: Lock regressions in macOS tests

**Files:**
- Modify: `tests/macos-distribution.test.ts`
- Create: `tests/macos-uninstall.test.ts`
- Create: `tests/index-root.test.ts`

**Interfaces:**
- Consumes: current installer/runtime source text and gateway HTTP behavior.
- Produces: failing assertions for durable self-contained distribution, private Node, client provisioning order/ownership, root redirect, and safe uninstall.

- [ ] **Step 1: Add a failing bootstrap/distribution test** asserting the generated public installer builder exists, uses Node `--input-type=module` or pure ESM, contains no `require("node:` in the top-level-await bootstrap, contains no B2 grant variables, embeds manifest/runtime payloads, and references official Node 22 SHASUMS verification.
- [ ] **Step 2: Add a failing macOS install-source test** asserting `install-macos.mjs` accepts a bootstrap Node root, installs `toolchain/node`, points LaunchAgent `OPENAI_CC_NODE` at that persistent path, provisions Claude Desktop/Code before configuring clients, and records `installedByOpenAICC` ownership.
- [ ] **Step 3: Add a failing uninstall test** asserting a native macOS uninstaller exists and surgically edits Claude settings/profile data while conditioning Claude app/CLI removal on ownership flags.
- [ ] **Step 4: Add a failing gateway integration/unit test** proving `GET /` redirects to `/admin` on loopback.
- [ ] **Step 5: Run `npm test` and confirm the new tests fail specifically because these capabilities are absent.**
- [ ] **Step 6: Commit tests only.**

### Task 2: Add loopback root redirect

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index-root.test.ts`

**Interfaces:**
- Produces: loopback `GET / -> 302 Location: /admin`; all existing `/healthz` and dispatcher behavior unchanged.

- [ ] **Step 1: Implement the minimal `GET /` redirect before dispatcher handling, gated by the same loopback/remote-admin rule used for Admin exposure.**
- [ ] **Step 2: Run the focused root test and then `npm test`; confirm green.**
- [ ] **Step 3: Commit.**

### Task 3: Make install-macos own the persistent Node toolchain

**Files:**
- Modify: `install-macos.mjs`
- Modify: `install.sh`
- Modify: `scripts/build-runtime-bundle-macos.mjs`
- Test: `tests/macos-distribution.test.ts`

**Interfaces:**
- New installer arg: `--bootstrap-node-root <directory>`.
- Persistent executable: `<installRoot>/toolchain/node/bin/node`.
- LaunchAgent `OPENAI_CC_NODE` always references the persistent executable.

- [ ] **Step 1: Extend `install.sh` to accept an explicitly supplied `OPENAI_CC_NODE` bootstrap executable without requiring a system `node`.**
- [ ] **Step 2: In `install-macos.mjs`, validate the bootstrap Node root contains an executable Node >=20, stage/copy the complete Node distribution atomically into `toolchain/node`, then use that persistent path for migration/configuration/gateway processes and the LaunchAgent.**
- [ ] **Step 3: Include any new installer/uninstaller files in the macOS runtime manifest and required-file verification.**
- [ ] **Step 4: Run focused macOS tests and full `npm test`.**
- [ ] **Step 5: Commit.**

### Task 4: Provision Claude Desktop and Claude Code safely

**Files:**
- Create: `macos-provision-clients.mjs`
- Modify: `install-macos.mjs`
- Modify: `scripts/build-runtime-bundle-macos.mjs`
- Test: `tests/macos-distribution.test.ts`

**Interfaces:**
- `provisionMacClients(options)` returns `{ claudeDesktop: { path, installedByOpenAICC }, claudeCode: { path, installedByOpenAICC, pathLineAdded } }`.
- Environment URL overrides are accepted only for loopback fixture testing; production defaults remain official HTTPS Anthropic endpoints.

- [ ] **Step 1: Implement Claude Desktop detection; preserve `/Applications/Claude.app` or `~/Applications/Claude.app` when present.**
- [ ] **Step 2: When absent, download the official DMG with HTTPS-only redirects, mount read-only, verify `Claude.app` with `codesign --verify --deep --strict`, copy via `ditto` into `~/Applications`, verify again, unmount, and record ownership.**
- [ ] **Step 3: Implement Claude Code detection; when absent, download/run the official native installer as the current user, verify `~/.local/bin/claude --version`, repair the user-local symlink only if the upstream versions directory exists, and add one idempotent `.zshrc` PATH line.**
- [ ] **Step 4: Change `install-macos.mjs` ordering so provisioning completes before `configure-clients.js`; never gate Desktop config on prior app existence.**
- [ ] **Step 5: Preserve prior ownership flags from existing `install-state.json` across updates.**
- [ ] **Step 6: Run focused tests and full `npm test`.**
- [ ] **Step 7: Commit.**

### Task 5: Add ownership-aware macOS uninstall

**Files:**
- Create: `uninstall-macos.mjs`
- Create: `uninstall.command`
- Modify: `scripts/build-runtime-bundle-macos.mjs`
- Modify: `install-macos.mjs`
- Test: `tests/macos-uninstall.test.ts`

**Interfaces:**
- Installed launcher: `<installRoot>/uninstall.command`.
- Reads `install-state.json.managedDependencies`.

- [ ] **Step 1: Implement listener ownership verification using `/healthz` plus installRoot before terminating PID 8082.**
- [ ] **Step 2: Implement surgical removal of OpenAI-CC env/model fields from `~/.claude/settings.json`; preserve all unrelated keys and delete the file only when it becomes empty.**
- [ ] **Step 3: Remove only the fixed OpenAI-CC Claude Desktop profile ID and matching `_meta.json` entry/appliedId; preserve all other Desktop configuration.**
- [ ] **Step 4: Remove Claude Desktop, Claude Code, and the zsh PATH line only when their ownership flags say OpenAI-CC installed them.**
- [ ] **Step 5: Unload LaunchAgent and remove OpenAI-CC runtime/log/state files idempotently.**
- [ ] **Step 6: Have installation copy/write the uninstaller and verify it exists.**
- [ ] **Step 7: Run uninstall tests and full `npm test`.**
- [ ] **Step 8: Commit.**

### Task 6: Build a durable self-contained public `.command`

**Files:**
- Create: `scripts/build-public-macos-installer.mjs`
- Modify: `tests/macos-distribution.test.ts`
- Modify: `.github/workflows/macos-runtime-ci.yml`

**Interfaces:**
- Input: macOS bundle output directory.
- Output: `OpenAI-CC-Mac-Installer.command` plus SHA-256 metadata.

- [ ] **Step 1: Implement a packager that reads the deterministic manifest, `install.sh`, `install-macos.mjs`, and runtime ZIP and emits a Bash `.command` with base64 payload heredocs.**
- [ ] **Step 2: Bootstrap shell validates `Darwin/arm64`, materializes payloads, verifies their manifest hashes, downloads the exact latest-v22.x darwin-arm64 Node archive named in official `SHASUMS256.txt`, verifies SHA-256, extracts it, and invokes the installer with `--bootstrap-node-root`.**
- [ ] **Step 3: Ensure the generated file contains no B2 key/grant names and no TTL/expiry contract.**
- [ ] **Step 4: Update macOS CI to build the public installer, `bash -n` it, verify it contains the exact source SHA, and upload it as a GitHub Actions artifact.**
- [ ] **Step 5: Run focused tests and full `npm test`.**
- [ ] **Step 6: Commit.**

### Task 7: Strengthen macOS CI end-to-end verification

**Files:**
- Modify: `.github/workflows/macos-runtime-ci.yml`

**Interfaces:**
- Produces a CI artifact only after deterministic bundle, install/reinstall, redirect, private-node, state-preservation, and uninstall checks pass.

- [ ] **Step 1: In the existing isolated `--skip-client-provision` bundle smoke test, assert persistent private Node exists and `/` redirects to `/admin`.**
- [ ] **Step 2: Add fixture-driven client-provision tests that exercise existing-vs-installed ownership without requiring interactive login.**
- [ ] **Step 3: Run `uninstall.command` against the isolated CI root and verify the LaunchAgent/root are removed while fixture-owned external Claude paths are preserved.**
- [ ] **Step 4: Verify generated public installer size/hash and upload artifact with `actions/upload-artifact@v4`.**
- [ ] **Step 5: Push branch and wait for macOS ARM64 Runtime CI plus control-plane tests to pass.**
- [ ] **Step 6: Commit any CI-only corrections, rerun until green.**

### Task 8: Review, merge, and produce release artifact

**Files:**
- No new production files unless review finds a defect.

**Interfaces:**
- Exact merged `main` SHA is the release identity.

- [ ] **Step 1: Run `npm test` and static checks one final time on the reviewed branch.**
- [ ] **Step 2: Compare branch to `main` and verify only scoped installer/runtime/tests/docs/workflow files changed.**
- [ ] **Step 3: Open and merge the pull request only after required CI is green.**
- [ ] **Step 4: Run macOS ARM64 workflow on the merged SHA and download `OpenAI-CC-Mac-Installer.command` artifact.**
- [ ] **Step 5: Calculate SHA-256 and verify `bash -n`, absence of B2 secrets/grants/expiry strings, and embedded source SHA.**

### Task 9: Upload to Google Drive and verify public access

**Files:**
- Artifact only: `OpenAI-CC-Mac-Installer.command`.

**Interfaces:**
- Produces: Google Drive file with `anyone` + `reader` permission and a public link.

- [ ] **Step 1: Upload the verified `.command` to Google Drive.**
- [ ] **Step 2: Set sharing permission to anyone with the link, reader.**
- [ ] **Step 3: Read file metadata/permissions back and verify the public permission is active.**
- [ ] **Step 4: Return the public Drive link, exact merged source SHA, artifact SHA-256, and any remaining limitation that could not be verified on a real client Mac.**
