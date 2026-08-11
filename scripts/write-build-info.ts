import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

const output = path.resolve("dist", "build-info.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({
  buildSha: gitSha(),
  buildTime: new Date().toISOString(),
}, null, 2) + "\n", "utf8");
