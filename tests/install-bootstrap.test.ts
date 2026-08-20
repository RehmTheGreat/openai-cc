import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("deterministic bootstrap consumes a verified runtime bundle without Git", async () => {
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");

  assert.match(install, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$ManifestUrl/);
  assert.match(install, /bundleSha256/);
  assert.match(install, /Get-FileHash -Algorithm SHA256/);
  assert.match(install, /Corrupted\/hash-mismatched bundle/);
  assert.match(install, /runtime-manifest\.json/);
  assert.match(install, /Internal source SHA does not match distribution manifest/);
  assert.match(install, /installed build SHA mismatch/);
  assert.match(install, /running \/healthz build SHA mismatch/);
  assert.match(install, /expected source SHA = installed build SHA = running \/healthz SHA/);
  assert.doesNotMatch(install, /Git\.Git/);
  assert.doesNotMatch(install, /git\s+(clone|fetch|pull|reset|clean|rev-parse)/i);
  assert.doesNotMatch(install, /github\.com\/RehmTheGreat\/openai-cc\.git/i);
});

test("installer preserves .data and atomically swaps only the managed current runtime", async () => {
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");

  assert.match(install, /Join-Path \$script:ManagedRoot "\.data"/);
  assert.match(install, /Join-Path \$script:ManagedRoot "current"/);
  assert.match(install, /Refusing to modify path outside managed root/);
  assert.match(install, /Installer refuses to delete or replace \.data/);
  assert.match(install, /Get-DataFingerprint/);
  assert.match(install, /codex-homes\|accounts/);
  assert.match(install, /managed-oauth-session/);
  assert.match(install, /Migrate-PersistentData \$stage/);
  assert.match(install, /Persistent \.data migration failed/);
  const migration = install.indexOf("Migrate-PersistentData $stage");
  const fingerprint = install.indexOf("$preDataFingerprint = Get-DataFingerprint", migration);
  assert.ok(migration >= 0 && fingerprint > migration);
  assert.match(install, /Existing \.data, model routing, custom providers, credentials, pins, and status preserved; managed OAuth sessions may refresh in place/);
  assert.match(install, /Move-Item \$script:CurrentRuntime \$script:RollbackRuntime/);
  assert.match(install, /Move-Item \$stage \$script:CurrentRuntime/);
  assert.match(install, /Restore-PreviousRuntime/);
  assert.match(install, /Remove obsolete source-checkout runtime/);
  assert.match(install, /HadLegacyRuntime =\s*[\s\S]*ManagedRoot "\.git"[\s\S]*ManagedRoot "src"[\s\S]*ManagedRoot "package-lock\.json"/);
  assert.match(install, /"dist", "distribution", "node_modules"/);
  assert.doesNotMatch(install, /Remove-Item\s+\$script:DataDir/);

  assert.match(install, /Port 8082 is occupied by unrelated PID/);
  assert.match(install, /Refusing to terminate it/);
  assert.match(install, /taskkill\.exe \/PID \$pidValue \/T \/F/);
  assert.match(install, /health\.pid -ne \[int\]\$listener\.OwningProcess/);
});

test("B2 installer layers stream child output without collapsing stderr", async () => {
  for (const relative of [
    "distribution/b2/client-installer-template.ps1",
    "distribution/b2/bootstrap.ps1",
  ]) {
    const script = await readFile(path.join(process.cwd(), relative), "utf8");
    assert.doesNotMatch(script, /\$installerOutput\s*=\s*@\(/);
    assert.match(script, /\$ErrorActionPreference = "Continue"/);
    assert.match(script, /2>&1 \| ForEach-Object \{ \$_ \| Out-Host \}/);
  }

  const bootstrap = await readFile(path.join(process.cwd(), "distribution/b2/bootstrap.ps1"), "utf8");
  assert.match(bootstrap, /AddRange\(\$start, \$requestedEnd\)/);
  assert.match(bootstrap, /\$statusCode -eq 200/);
  assert.match(bootstrap, /B2 returned an unsafe full-object response to a byte-range request/);
  assert.match(bootstrap, /BeginRead\(\$readBuffer, 0, \$readSize/);
  assert.match(bootstrap, /WaitOne\(\$bodyReadTimeoutMs\)/);
  assert.match(bootstrap, /B2 response body stalled/);
  assert.match(bootstrap, /B2 download failed after \$maxAttempts attempts/);
  assert.match(bootstrap, /B2 transport SHA-1 verification failed/);

  const fixture = await readFile(path.join(process.cwd(), "distribution/b2/mock-server.mjs"), "utf8");
  assert.match(fixture, /start === 0 && requestedEnd >= size - 1/);
});

test("client installer refreshes an existing Claude Desktop profile unless explicitly skipped", async () => {
  const client = await readFile(path.join(process.cwd(), "distribution/b2/client-installer-template.ps1"), "utf8");

  assert.match(client, /if \(\$env:OPENAI_CC_CLIENT_SKIP_DESKTOP_CONFIG -eq "1"\) \{ \$bootstrapArgs \+= "-SkipDesktopConfig" \}/);
  assert.doesNotMatch(client, /-not \$wantClaudeDesktop\) \{ \$bootstrapArgs \+= "-SkipDesktopConfig" \}/);
  assert.match(client, /& \$rtk\.Source telemetry disable \| Out-Host/);
  assert.match(client, /& \$rtk\.Source init -g --auto-patch --no-trust-filters \| Out-Host/);
  assert.doesNotMatch(client, /& \$rtk\.Source init -g \| Out-Host/);
});

test("client distribution is 48-hour, link-first, bare-PC resilient, and optional tooling cannot fail core", async () => {
  const client = await readFile(path.join(process.cwd(), "distribution/b2/client-installer-template.ps1"), "utf8");
  const bootstrap = await readFile(path.join(process.cwd(), "distribution/b2/bootstrap.ps1"), "utf8");
  const generator = await readFile(path.join(process.cwd(), "distribution/b2/new-client-installer.ps1"), "utf8");
  const grant = await readFile(path.join(process.cwd(), "distribution/b2/grant-release.mjs"), "utf8");
  const revoke = await readFile(path.join(process.cwd(), "distribution/b2/revoke-grant.mjs"), "utf8");
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");

  assert.match(generator, /ValidateRange\(300, 172800\)/);
  assert.match(generator, /TtlSeconds = 172800/);
  assert.match(generator, /Google Drive recommended/);
  assert.match(generator, /do not email \.cmd attachments/);
  assert.match(generator, /\.openai-cc-private\\b2-issuer-credentials\.json/);
  assert.match(generator, /Automatic cleanup could not revoke failed client grant/);
  assert.match(grant, /ttlSeconds > 172800/);
  assert.match(revoke, /attempt <= 6/);
  assert.match(revoke, /status === 400 \|\| status === 404/);
  assert.match(revoke, /status === 429/);
  assert.match(bootstrap, /AddSeconds\(172860\)/);
  assert.match(client, /MaxGrantLifetimeSeconds = 172800/);
  assert.match(client, /Start-Transcript/);

  const bootstrapDownload = client.indexOf("Invoke-WebRequest -Uri $bootstrapUrl");
  const optionalClaude = client.indexOf("Install-ClaudeCodeBestEffort | Out-Null");
  assert.ok(bootstrapDownload >= 0 && optionalClaude > bootstrapDownload);

  assert.match(client, /Invoke-ProbeCommand \$git\.Source @\("--version"\)/);
  assert.match(client, /Invoke-ProbeCommand \$bash @\("--version"\)/);
  assert.match(client, /bad image\|0xc0e90002\|application control\|blocked\|msys-2\\\.0\\\.dll/i);
  assert.match(client, /CLAUDE_CODE_GIT_BASH_PATH/);
  assert.match(client, /api\.github\.com\/repos\/git-for-windows\/git\/releases\/latest/);
  assert.match(client, /Get-AuthenticodeSignature/);
  assert.match(client, /@anthropic-ai\/claude-code/);
  assert.match(client, /Optional RTK optimization skipped; OpenAI-CC remains installed/);
  assert.match(client, /Refresh-InstalledClientConfigBestEffort/);
  assert.match(client, /configure-clients\.js/);

  assert.match(install, /Install-PortableNodeLts/);
  assert.match(install, /https:\/\/nodejs\.org\/dist\/latest-v20\.x/);
  assert.match(install, /SHASUMS256\.txt/);
  assert.match(install, /Portable Node\.js download failed SHA-256 verification/);
  assert.match(install, /SetEnvironmentVariable\("Path", \$next, "User"\)/);

  assert.match(install, /Test-LegacyFccProcess/);
  assert.match(install, /FCC Server\.lnk/);
  assert.match(install, /Free Claude Code\.lnk/);
  assert.match(install, /never prevent the new OpenAI-CC runtime from installing/);
  assert.doesNotMatch(install, /uv\s+tool\s+uninstall\s+free-claude-code/i);
});

test("Windows startup repairs disabled state and has independent PowerShell logon paths", async () => {
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");
  const launcher = await readFile(path.join(process.cwd(), "run-gateway.ps1"), "utf8");
  const uninstall = await readFile(path.join(process.cwd(), "uninstall.ps1"), "utf8");
  const builder = await readFile(path.join(process.cwd(), "scripts", "build-runtime-bundle.ps1"), "utf8");

  assert.match(install, /Explorer\\StartupApproved\\Run/);
  assert.match(install, /\[byte\[\]\]\(0x02/);
  assert.match(install, /Register-ScheduledTask/);
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn -User/);
  assert.match(install, /LogonType Interactive/);
  assert.match(install, /PT15S/);
  assert.match(install, /Remove-OpenAiCcStartupRegistrations/);
  assert.match(install, /automatic startup disabled by installer option/);
  assert.doesNotMatch(install, /run-gateway\.vbs/);
  assert.doesNotMatch(install, /wscript\.exe/i);

  assert.match(launcher, /\[string\]\$NodePath/);
  assert.match(launcher, /function Resolve-NodeCommand/);
  assert.match(launcher, /tools\\node\\node\.exe/);
  assert.match(launcher, /GetEnvironmentVariable\("Path", "Machine"\)/);
  assert.match(launcher, /Programs\\nodejs\\node\.exe/);

  assert.match(uninstall, /Unregister-ScheduledTask/);
  assert.match(uninstall, /Explorer\\StartupApproved\\Run/);
  assert.doesNotMatch(builder, /Copy-RuntimeItem "run-gateway\.vbs"/);
});

test("B2 bootstrap bytes are canonical across Windows and Unix working-tree line endings", async () => {
  const grant = await readFile(path.join(process.cwd(), "distribution/b2/grant-release.mjs"), "utf8");
  const publish = await readFile(path.join(process.cwd(), "distribution/b2/publish-release.mjs"), "utf8");

  assert.match(grant, /canonicalBootstrap/);
  assert.match(grant, /replace\(\/\\r\\n\/g, "\\n"\)/);
  assert.match(grant, /createHash\("sha256"\)\.update\(canonicalBootstrap, "utf8"\)/);
  assert.match(publish, /bootstrapPublishPath/);
  assert.match(publish, /replace\(\/\\r\\n\/g, "\\n"\)/);
  assert.match(publish, /writeFile\(bootstrapPublishPath, canonicalBootstrap, "utf8"\)/);
});

test("fresh-install verification enforces current provider/model defaults without hardcoded model context", async () => {
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");

  assert.match(install, /default = @\{ provider = "chatgpt"; model = "gpt-5\.6-luna" \}/);
  assert.match(install, /fable = @\{ provider = "chatgpt"; model = "gpt-5\.6-luna" \}/);
  assert.match(install, /opus = @\{ provider = "zen"; model = "deepseek-v4-flash-free" \}/);
  assert.match(install, /sonnet = @\{ provider = "google"; model = "gemini-3\.5-flash-lite" \}/);
  assert.match(install, /haiku = @\{ provider = "google"; model = "gemini-3\.5-flash-lite" \}/);
  assert.doesNotMatch(install, /context = (?:200000|850000|1000000|1050000)/);
  assert.match(install, /model\.max_input_tokens -ne \[int64\]\$routeHealth\.contextWindow/);
  assert.match(install, /model\.max_tokens -ne \[int64\]\$route\.maxOutputTokens/);
  assert.match(install, /aliasModel\.display_name -ne \$title/);
  assert.match(install, /v1\/models\/\$encodedAlias/);
  assert.match(install, /gateway did not expose exactly four Claude Desktop-facing routes/);
  assert.match(install, /Admin endpoint did not return HTTP 200/);
  assert.match(install, /codex-doctor\.js/);
  assert.match(install, /No usable ChatGPT OAuth credential is present/);
  assert.match(install, /account\.status -eq "ready"/);
  assert.match(install, /doctorExitCode -eq 2/);

  const doctor = await readFile(path.join(process.cwd(), "scripts/codex-doctor.ts"), "utf8");
  assert.match(doctor, /store\.orderedReady\("chatgpt"\)/);
  assert.doesNotMatch(doctor, /gpt-5\.6-terra/);
  assert.doesNotMatch(doctor, /store\.preferredId\("chatgpt"\)/);
  assert.match(doctor, /process\.exitCode = isUsageLimited\(message\) \? 2 : 1/);
});

test("runtime bundle builder is production-only, manifest-driven, and independent of .data", async () => {
  const builder = await readFile(path.join(process.cwd(), "scripts", "build-runtime-bundle.ps1"), "utf8");

  assert.match(builder, /npm prune --omit=dev/);
  assert.match(builder, /Copy-RuntimeItem "dist\\src"/);
  assert.match(builder, /Copy-RuntimeItem "dist\\scripts\\configure-clients\.js"/);
  assert.match(builder, /Copy-RuntimeItem "dist\\scripts\\codex-doctor\.js"/);
  assert.match(builder, /Copy-RuntimeItem "dist\\scripts\\migrate-data\.js"/);
  assert.match(builder, /Copy-RuntimeItem "node_modules"/);
  assert.match(builder, /Copy-RuntimeItem "package\.json"/);
  assert.match(builder, /Copy-RuntimeItem "uninstall\.ps1"/);
  assert.match(builder, /runtime-manifest\.json/);
  assert.match(builder, /bundleSha256/);
  assert.match(builder, /contentSha256/);
  assert.match(builder, /sourceCommit/);
  assert.match(builder, /appVersion/);
  assert.match(builder, /buildTimestamp/);
  assert.match(builder, /forbidden in @\("\.data", "\.git", "src", "tests", "setup\.ps1", "install\.ps1", "package-lock\.json"\)/);
  assert.match(builder, /Source maps leaked into the runtime bundle/);
  assert.match(builder, /bootstrapNormalized/);
  assert.match(builder, /Replace\(\"`r`n\", \"`n\"\)/);
  assert.doesNotMatch(builder, /Copy-RuntimeItem "\.data/);
  assert.doesNotMatch(builder, /Copy-RuntimeItem "package-lock\.json"/);
});

test("uninstall requires explicit keep-data or purge-data mode and validates listener ownership", async () => {
  const uninstall = await readFile(path.join(process.cwd(), "uninstall.ps1"), "utf8");
  assert.match(uninstall, /\[switch\]\$KeepData/);
  assert.match(uninstall, /\[switch\]\$PurgeData/);
  assert.match(uninstall, /Choose an uninstall mode explicitly/);
  assert.match(uninstall, /Refusing to remove \.data without -PurgeData/);
  assert.match(uninstall, /health\.pid -eq \$listenerPid/);
  assert.match(uninstall, /Port 8082 is owned by unrelated PID/);
  assert.match(uninstall, /Runtime removed\. Persistent \.data was kept/);
  assert.match(uninstall, /Purging OpenAI-CC persistent credentials and configuration/);
});

test("default runtime and launcher both use the canonical inference entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  const launcher = await readFile(path.join(process.cwd(), "run-gateway.ps1"), "utf8");
  const claudeLauncher = await readFile(path.join(process.cwd(), "run-claude.ps1"), "utf8");
  const entrypoint = await readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");
  const buildInfo = await readFile(path.join(process.cwd(), "src", "build-info.ts"), "utf8");

  assert.equal(packageJson.scripts.start, "node dist/src/index.js");
  assert.equal(packageJson.scripts.dev, "tsx watch src/index.ts");
  assert.equal(packageJson.scripts["codex:doctor"], "tsx scripts/codex-doctor.ts");
  assert.match(launcher, /dist\\src\\index\.js/);
  assert.match(launcher, /OPENAI_CC_HOME/);
  assert.match(launcher, /OPENAI_CC_RUNTIME_ROOT/);
  assert.match(claudeLauncher, /Microsoft\\WindowsApps\\Claude\.exe/);
  assert.match(entrypoint, /runtimeIdentity/);
  assert.match(entrypoint, /new Dispatcher/);
  assert.match(buildInfo, /appVersion/);
  assert.match(buildInfo, /runtimeRoot/);
});