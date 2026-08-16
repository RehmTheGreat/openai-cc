import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Admin exposes a manual Retry probe only for exhausted ChatGPT credentials", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "admin", "page.ts"), "utf8");
  assert.match(source, /a\.provider==='chatgpt'&&a\.status==='exhausted'\?button\('retry',a\.id,'Retry'\)/);
  assert.match(source, /\/admin\/credentials\/.*\/retry/);
  assert.match(source, /Testing…/);
  assert.match(source, /Reset time not reported by Codex\. Use Retry to test this account now\./);
});
