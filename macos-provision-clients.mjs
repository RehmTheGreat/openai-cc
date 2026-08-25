import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

export const CLAUDE_DESKTOP_DMG_URL = "https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect";
export const CLAUDE_CODE_INSTALL_URL = "https://claude.ai/install.sh";
export const OPENAI_CC_ZSH_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

async function exists(path) { try { await lstat(path); return true; } catch { return false; } }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: options.stdio ?? "pipe", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout || "no output"}`);
  return result;
}
function checkedUrl(value, official) {
  const url = new URL(value || official);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname) || url.hostname.startsWith("127.");
  if (url.href !== official && !(loopback && ["http:", "https:"].includes(url.protocol))) throw new Error(`Unsafe download URL override: ${url.href}`);
  if (!loopback && url.protocol !== "https:") throw new Error(`HTTPS is required: ${url.href}`);
  return url.href;
}
function findCommand(name) {
  const result = spawnSync("/bin/zsh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}
async function verifyClaude(path) {
  if (!(await exists(path))) return false;
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  return result.status === 0;
}
async function latestClaudeVersionExecutable(home) {
  const root = join(home, ".local", "share", "claude", "versions");
  if (!(await exists(root))) return "";
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!entries.length) return "";
  return join(root, entries.at(-1));
}
async function hasPathLine(home) {
  const file = join(home, ".zshrc");
  let text = "";
  try { text = await readFile(file, "utf8"); } catch {}
  return text.split(/\r?\n/).some((line) => line.trim() === OPENAI_CC_ZSH_PATH_LINE);
}
async function ensurePathLine(home) {
  const file = join(home, ".zshrc");
  let text = "";
  try { text = await readFile(file, "utf8"); } catch {}
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => line.trim() === OPENAI_CC_ZSH_PATH_LINE)) return false;
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${text}${prefix}${OPENAI_CC_ZSH_PATH_LINE}\n`, "utf8");
  return true;
}

async function provisionClaudeDesktop(home, previous = {}) {
  const system = "/Applications/Claude.app";
  const user = join(home, "Applications", "Claude.app");
  for (const candidate of [system, user]) {
    if (await exists(candidate)) {
      return { path: candidate, installedByOpenAICC: Boolean(previous.installedByOpenAICC && resolve(previous.path || "") === resolve(candidate)) };
    }
  }

  const temp = await mkdtemp(join(os.tmpdir(), "openai-cc-claude-desktop-"));
  const dmg = join(temp, "Claude.dmg");
  const mount = join(temp, "mount");
  await mkdir(mount, { recursive: true });
  const url = checkedUrl(process.env.OPENAI_CC_CLAUDE_DESKTOP_DMG_URL, CLAUDE_DESKTOP_DMG_URL);
  try {
    const proto = new URL(url).protocol === "http:" ? "=http,https" : "=https";
    run("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error", "--proto", proto, "--tlsv1.2", "--output", dmg, url]);
    run("/usr/bin/hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount]);
    const source = join(mount, "Claude.app");
    if (!(await exists(source))) throw new Error("Claude Desktop DMG did not contain Claude.app");
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
    await mkdir(join(home, "Applications"), { recursive: true });
    run("/usr/bin/ditto", [source, user]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", user]);
    return { path: user, installedByOpenAICC: true };
  } finally {
    spawnSync("/usr/bin/hdiutil", ["detach", mount, "-quiet"], { encoding: "utf8" });
    await rm(temp, { recursive: true, force: true });
  }
}

async function provisionClaudeCode(home, previous = {}) {
  const local = join(home, ".local", "bin", "claude");
  const found = findCommand("claude") || (await exists(local) ? local : "");
  if (found && await verifyClaude(found)) {
    return {
      path: found,
      installedByOpenAICC: Boolean(previous.installedByOpenAICC && resolve(previous.path || "") === resolve(found)),
      pathLineAdded: Boolean(previous.pathLineAdded),
    };
  }

  const temp = await mkdtemp(join(os.tmpdir(), "openai-cc-claude-code-"));
  const script = join(temp, "install.sh");
  const url = checkedUrl(process.env.OPENAI_CC_CLAUDE_CODE_INSTALL_URL, CLAUDE_CODE_INSTALL_URL);
  const hadPathLine = await hasPathLine(home);
  try {
    const proto = new URL(url).protocol === "http:" ? "=http,https" : "=https";
    run("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error", "--proto", proto, "--tlsv1.2", "--output", script, url]);
    await chmod(script, 0o700);
    run("/bin/bash", [script], { stdio: "inherit", env: { ...process.env, HOME: home } });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  if (!(await verifyClaude(local))) {
    const versioned = await latestClaudeVersionExecutable(home);
    if (!versioned) throw new Error("Claude Code installer completed but no executable was found.");
    await mkdir(dirname(local), { recursive: true });
    await rm(local, { force: true });
    await symlink(versioned, local);
  }
  if (!(await verifyClaude(local))) throw new Error("Claude Code verification failed after installation.");
  await ensurePathLine(home);
  const pathLineAdded = Boolean(previous.pathLineAdded || (!hadPathLine && await hasPathLine(home)));
  return { path: local, installedByOpenAICC: true, pathLineAdded };
}

export async function provisionMacClients({ home = os.homedir(), previous = {}, skipDesktop = false } = {}) {
  const claudeDesktop = skipDesktop
    ? { ...(previous.claudeDesktop || {}), skipped: true }
    : await provisionClaudeDesktop(home, previous.claudeDesktop || {});
  const claudeCode = await provisionClaudeCode(home, previous.claudeCode || {});
  return { claudeDesktop, claudeCode };
}
