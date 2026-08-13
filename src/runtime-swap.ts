import { statSync } from "node:fs";
import path from "node:path";

export function watchManagedRuntimeSwap(onSwap: () => void): void {
  if (process.env.OPENAI_CC_WATCH_RUNTIME_SWAP !== "1") return;
  const installRoot = process.env.OPENAI_CC_HOME?.trim();
  const runtimeRoot = process.env.OPENAI_CC_RUNTIME_ROOT?.trim();
  if (!installRoot || !runtimeRoot) return;
  let expected: { dev: number; ino: number };
  try {
    const info = statSync(runtimeRoot);
    expected = { dev: info.dev, ino: info.ino };
  } catch { return; }
  const timer = setInterval(() => {
    try {
      const active = statSync(path.join(installRoot, "current"));
      if (active.dev === expected.dev && active.ino === expected.ino) return;
      clearInterval(timer);
      onSwap();
    } catch { /* atomic rename can briefly leave current absent */ }
  }, 500);
  timer.unref();
}
