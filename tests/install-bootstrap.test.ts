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

test("fresh-install verification enforces current defaults and route-specific context", async () => {
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");

  assert.match(install, /default = @\{ provider = "chatgpt"; model = "gpt-5\.6-luna"; context = 1000000 \}/);
  assert.match(install, /fable = @\{ provider = "chatgpt"; model = "gpt-5\.6-luna"; context = 1000000 \}/);
  assert.match(install, /opus = @\{ provider = "zen"; model = "deepseek-v4-flash-free"; context = 200000 \}/);
  assert.match(install, /sonnet = @\{ provider = "google"; model = "gemini-3\.5-flash-lite"; context = 1000000 \}/);
  assert.match(install, /haiku = @\{ provider = "google"; model = "gemini-3\.5-flash-lite"; context = 1000000 \}/);
  assert.match(install, /model\.max_input_tokens -ne \[int64\]\$routeHealth\.contextWindow/);
  assert.match(install, /model\.max_tokens -ne \[int64\]\$route\.maxOutputTokens/);
  assert.match(install, /configuredAlias -ne \[string\]\$model\.id/);
  assert.match(install, /Admin endpoint did not return HTTP 200/);
  assert.match(install, /codex-doctor\.js/);
  assert.match(install, /No usable ChatGPT OAuth credential is present/);
  assert.match(install, /account\.status -eq "ready"/);
  assert.match(install, /doctorExitCode -eq 2/);

  const doctor = await readFile(path.join(process.cwd(), "scripts/codex-doctor.ts"), "utf8");
  assert.match(doctor, /store\.orderedReady\("chatgpt"\)/);
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
