import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { AccountStore, validateId } from "../src/account-store.js";

const args = parseArgs(process.argv.slice(2));
const id = args.id;
const name = args.name || id;
if (!id) {
  console.error("Usage: npm run account:add -- --id alice --name \"Alice\"");
  process.exit(2);
}
validateId(id);
const store = new AccountStore(process.env.DATA_DIR || ".data");
await store.init();
const authFile = store.authFileFor(id);
await mkdir(path.dirname(authFile), { recursive: true, mode: 0o700 });

console.log(`Signing in ${name}. The OAuth callback stays on this machine.`);
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "openai-oauth@latest", "login", "--oauth-file", authFile], { stdio: "inherit" });
const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
if (code !== 0) process.exit(code);
await store.upsert({ id, name, authFile });
console.log(`Added ${name} (${id}). Auth file: ${authFile}`);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}
