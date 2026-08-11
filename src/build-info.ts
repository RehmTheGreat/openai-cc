import { readFileSync } from "node:fs";

export interface BuildInfo {
  buildSha: string;
  buildTime: string;
}

let cached: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8"));
    cached = {
      buildSha: typeof parsed.buildSha === "string" ? parsed.buildSha : "unknown",
      buildTime: typeof parsed.buildTime === "string" ? parsed.buildTime : "unknown",
    };
  } catch {
    cached = { buildSha: "unknown", buildTime: "unknown" };
  }
  return cached;
}

export function runtimeIdentity(contextWindow: number): Record<string, unknown> {
  return {
    ok: true,
    contextWindow,
    ...buildInfo(),
    pid: process.pid,
    installRoot: process.cwd(),
    node: process.version,
  };
}
