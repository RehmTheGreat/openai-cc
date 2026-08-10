from pathlib import Path
import re


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrence(s), found {actual}: {old[:120]!r}")
    p.write_text(text.replace(old, new), encoding="utf-8")


def append_if_missing(path: str, marker: str, text: str) -> None:
    p = Path(path)
    current = p.read_text(encoding="utf-8")
    if marker not in current:
        p.write_text(current + text, encoding="utf-8")


# The test fixture is itself emitted from a TypeScript template literal. Avoid nested newline escapes
# so the generated .mjs remains valid JavaScript on every platform.
p = Path("tests/chatgpt-auth.test.ts")
text = p.read_text(encoding="utf-8")
replacement = """if(mode==='device'||mode==='device-fail'){
  console.log('Follow these steps to sign in with ChatGPT using device code authorization:');
  console.log('1. Open this link in your browser and sign in to your account');
  console.log(' https://auth.openai.com/codex/device');
  console.log('2. Enter this one-time code (expires in 15 minutes)');
  console.log(' ABCD-1234');
  if(mode==='device-fail') process.exit(7);
  await new Promise(resolve=>setTimeout(resolve,180));
}
await mkdir"""
text, matches = re.subn(r"if\(mode==='device'\)\{.*?\}\nawait mkdir", replacement, text, count=1, flags=re.S)
if matches != 1:
    raise RuntimeError(f"tests/chatgpt-auth.test.ts: expected one transformed device fixture block, found {matches}")
p.write_text(text, encoding="utf-8")

# Device user codes are intentionally exposed only while active; captured diagnostics redact them.
replace_exact(
    "src/chatgpt-auth.ts",
    '''    .replace(/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted-jwt]");''',
    '''    .replace(/\\b[A-Z0-9]{4}-[A-Z0-9]{4}\\b/g, "[redacted-device-code]")\n    .replace(/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted-jwt]");''',
)

append_if_missing(
    "tests/chatgpt-auth.test.ts",
    "failed device auth never retains its one-time user code in safe diagnostics",
    '''\n\ntest("failed device auth never retains its one-time user code in safe diagnostics", async () => {\n  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-device-fail-"));\n  const store = new AccountStore(path.join(root, "data"));\n  await store.init();\n  const entrypoint = await fakeCodex(root);\n  const previous = process.env.FAKE_CODEX_BEHAVIOR;\n  process.env.FAKE_CODEX_BEHAVIOR = "device-fail";\n  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 5_000 });\n  const started = await runner.start({ credentialId: "device-fail", displayName: "Device Fail", loginMode: "device" });\n  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;\n  const done = await waitTerminal(runner, started);\n  assert.equal(done.status, "error");\n  assert.equal(done.safeError?.includes("ABCD-1234"), false);\n  assert.equal(done.userCode, undefined);\n  assert.equal(done.verificationUrl, undefined);\n  await runner.shutdown();\n  store.close();\n});\n''',
)
