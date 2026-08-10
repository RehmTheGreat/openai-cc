import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Admin frontend keeps secrets out, scopes SSE refreshes, and surfaces API failures", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "admin", "page.ts"), "utf8");
  assert.doesNotMatch(source, /authFile/);
  assert.match(source, /class ApiError/);
  assert.match(source, /if\(!response\.ok\)throw new ApiError/);
  assert.match(source, /modelFormDirty/);
  assert.match(source, /credentials_changed/);
  assert.match(source, /model_config_changed/);
  assert.match(source, /Configuration changed elsewhere/);
  assert.match(source, /Auto — preferred \+ rotation/);
  assert.match(source, /state\.accounts\.filter\(a=>a\.provider===provider\)/);
  assert.match(source, /oauth-cancel/);
  assert.match(source, /oauth-device-link/);
  assert.match(source, /verificationUrl/);
  assert.match(source, /userCode/);
  assert.match(source, /deviceCode\.textContent=job\.userCode/);
  assert.match(source, /button\.disabled=true/);
  assert.match(source, /statusLabel/);
  assert.match(source, /auth-error/);
  assert.doesNotMatch(source, /onclick=/);
});
