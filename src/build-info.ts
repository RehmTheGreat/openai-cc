import { readFileSync } from "node:fs";

export interface BuildInfo {
  appVersion: string;
  buildSha: string;
  buildTime: string;
}

let cached: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8"));
    cached = {
      appVersion: typeof parsed.appVersion === "string" ? parsed.appVersion : "unknown",
      buildSha: typeof parsed.buildSha === "string" ? parsed.buildSha : "unknown",
      buildTime: typeof parsed.buildTime === "string" ? parsed.buildTime : "unknown",
    };
  } catch {
    cached = { appVersion: "unknown", buildSha: "unknown", buildTime: "unknown" };
  }
  return cached;
}

export function runtimeIdentity(contextWindow: number): Record<string, unknown> {
  const managedRoot = process.env.OPENAI_CC_HOME?.trim() || process.cwd();
  return {
    ok: true,
    contextWindow,
    ...buildInfo(),
    pid: process.pid,
    installRoot: managedRoot,
    runtimeRoot: process.cwd(),
    node: process.version,
  };
}
