import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const root = path.join(process.cwd(), "dist", "tests");
const files = (await readdir(root, { recursive: true }))
  .filter((file) => typeof file === "string" && file.endsWith(".test.js"))
  .map((file) => path.join(root, file as string))
  .sort();
if (!files.length) {
  console.error("No compiled tests found under dist/tests.");
  process.exit(1);
}
const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit", shell: false });
child.once("error", (error) => { console.error(error); process.exit(1); });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
