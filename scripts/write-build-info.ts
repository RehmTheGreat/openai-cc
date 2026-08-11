import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function sourceSha(): string {
  if (process.env.OPENAI_CC_SOURCE_SHA) return process.env.OPENAI_CC_SOURCE_SHA.trim();
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function buildTime(): string {
  const supplied = process.env.OPENAI_CC_BUILD_TIME?.trim();
  if (supplied) {
    const parsed = new Date(supplied);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version?: unknown };
const appVersion = typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version.trim() : "unknown";
const output = path.resolve("dist", "build-info.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({
  appVersion,
  buildSha: sourceSha(),
  buildTime: buildTime(),
}, null, 2) + "\n", "utf8");
