import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("deterministic bootstrap eliminates stale checkout, build, and port ambiguity", async () => {
  const install = await readFile(path.join(process.cwd(), "install.ps1"), "utf8");

  assert.match(install, /Get-NetTCPConnection -LocalPort 8082 -State Listen/);
  assert.match(install, /taskkill\.exe \/PID \$pidValue \/T \/F/);
  assert.match(install, /Port 8082 is still occupied/);

  assert.match(install, /"fetch", "--prune", "origin", "main"/);
  assert.match(install, /"reset", "--hard", "origin\/main"/);
  assert.match(install, /"clean", "-fd", "-e", "\.data\/"/);
  assert.doesNotMatch(install, /"clean"[^\n]*"-fdx"/);
  assert.match(install, /Backed up tracked local changes/);

  assert.match(install, /Remove-Item \$dist -Recurse -Force/);
  assert.match(install, /rev-parse HEAD/);
  assert.match(install, /\$health\.buildSha -ne \$script:ExpectedSha/);
  assert.match(install, /\$health\.installRoot/);
  assert.match(install, /dist\/scripts\/codex-doctor\.js/);
  assert.match(install, /gpt-5\.6-terra/);
});

test("default runtime and launcher both use the canonical inference entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  const launcher = await readFile(path.join(process.cwd(), "run-gateway.ps1"), "utf8");
  const entrypoint = await readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");

  assert.equal(packageJson.scripts.start, "node dist/src/index.js");
  assert.equal(packageJson.scripts.dev, "tsx watch src/index.ts");
  assert.equal(packageJson.scripts["codex:doctor"], "tsx scripts/codex-doctor.ts");
  assert.match(launcher, /dist\/src\/index\.js/);
  assert.match(entrypoint, /runtimeIdentity/);
  assert.match(entrypoint, /buildSha/);
  assert.match(entrypoint, /new Dispatcher/);
});
