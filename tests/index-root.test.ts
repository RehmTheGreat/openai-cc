import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("loopback gateway root redirects to Admin", async () => {
  const index = await readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");
  assert.match(index, /pathname === "\/"/);
  assert.match(index, /statusCode = 302/);
  assert.match(index, /setHeader\("Location", "\/admin"\)/);
  assert.match(index, /isLoopback\(host\).*OPENAI_CC_UNSAFE_REMOTE_ADMIN/s);
});
