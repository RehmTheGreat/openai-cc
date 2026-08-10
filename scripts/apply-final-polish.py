from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrence(s), found {actual}: {old[:140]!r}")
    p.write_text(text.replace(old, new), encoding="utf-8")


def append_if_missing(path: str, marker: str, text: str) -> None:
    p = Path(path)
    current = p.read_text(encoding="utf-8")
    if marker not in current:
        p.write_text(current + text, encoding="utf-8")


# --- Official Codex device-code fallback: transient, explicit UX. ---
replace_exact(
    "src/chatgpt-auth.ts",
    '''  email?: string;\n  safeMessage?: string;''',
    '''  email?: string;\n  verificationUrl?: string;\n  userCode?: string;\n  safeMessage?: string;''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''  settled: boolean;\n  output: string;''',
    '''  settled: boolean;\n  output: string;\n  devicePromptBuffer: string;''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''      settled: false,\n      output: "",''',
    '''      settled: false,\n      output: "",\n      devicePromptBuffer: "",''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''    const capture = (chunk: Buffer | string): void => {\n      const text = String(chunk);\n      job.output = (job.output + "\\n" + redactSensitive(text)).slice(-MAX_CAPTURE);\n      if (/device|enter.*code|verification/i.test(text) && job.loginMode === "device") {\n        this.setStatus(job, "awaiting_user", "Complete the device sign-in in your browser.");\n      } else if (/browser|sign.?in|login/i.test(text) && job.loginMode === "browser") {\n        this.setStatus(job, "awaiting_browser", "Browser opened. Finish signing in with ChatGPT.");\n      }\n    };''',
    '''    const capture = (chunk: Buffer | string): void => {\n      const text = String(chunk);\n      if (job.loginMode === "device") {\n        job.devicePromptBuffer = (job.devicePromptBuffer + "\\n" + text).slice(-4096);\n        const prompt = extractDevicePrompt(job.devicePromptBuffer);\n        if (prompt) {\n          job.verificationUrl = prompt.verificationUrl;\n          job.userCode = prompt.userCode;\n          this.setStatus(job, "awaiting_user", "Open the official Codex device sign-in page and enter the one-time code.");\n        } else if (/device|enter.*code|verification/i.test(text)) {\n          this.setStatus(job, "awaiting_user", "Waiting for the official Codex device sign-in instructions…");\n        }\n      } else if (/browser|sign.?in|login/i.test(text)) {\n        this.setStatus(job, "awaiting_browser", "Browser opened. Finish signing in with ChatGPT.");\n      }\n      job.output = (job.output + "\\n" + redactSensitive(text)).slice(-MAX_CAPTURE);\n    };''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''    job.output = "";\n  }''',
    '''    job.output = "";\n    job.devicePromptBuffer = "";\n    delete job.verificationUrl;\n    delete job.userCode;\n  }''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''    email: job.email,\n    safeMessage: job.safeMessage,''',
    '''    email: job.email,\n    verificationUrl: job.verificationUrl,\n    userCode: job.userCode,\n    safeMessage: job.safeMessage,''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''function isTerminal(status: AuthJobStatus): boolean {\n  return status === "complete" || status === "cancelled" || status === "error";\n}\n\nfunction redactSensitive''',
    '''function isTerminal(status: AuthJobStatus): boolean {\n  return status === "complete" || status === "cancelled" || status === "error";\n}\n\nfunction extractDevicePrompt(value: string): { verificationUrl: string; userCode: string } | undefined {\n  const clean = value.replace(/\\x1b\\[[0-9;]*m/g, "");\n  const url = clean.match(/https:\\/\\/auth\\.openai\\.com\\/codex\\/device\\b/i)?.[0];\n  const code = clean.match(/Enter this one-time code[\\s\\S]{0,180}?\\n\\s*([A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+|[A-Z0-9]{6,16})\\b/i)?.[1];\n  if (!url || !code) return undefined;\n  return { verificationUrl: url, userCode: code.toUpperCase() };\n}\n\nfunction redactSensitive''',
)

replace_exact(
    "scripts/account-add.ts",
    '''  let last = "";\n  while (!terminal(job)) {''',
    '''  let last = "";\n  let lastDevice = "";\n  while (!terminal(job)) {''',
)
replace_exact(
    "scripts/account-add.ts",
    '''    if (message !== last) { console.log(message); last = message; }\n    await new Promise((resolve) => setTimeout(resolve, 500));''',
    '''    if (message !== last) { console.log(message); last = message; }\n    if (job.verificationUrl && job.userCode) {\n      const device = `Open: ${job.verificationUrl}\\nOne-time code: ${job.userCode}`;\n      if (device !== lastDevice) { console.log(device); lastDevice = device; }\n    }\n    await new Promise((resolve) => setTimeout(resolve, 500));''',
)

# Admin UI shows the official device URL/code using DOM text/href only.
replace_exact(
    "src/admin/page.ts",
    '''.status{min-height:20px;margin-top:9px}.error''',
    '''.status{min-height:20px;margin-top:9px}a{color:#84adff}code{font-size:16px;font-weight:700;letter-spacing:.08em}.error''',
)
replace_exact(
    "src/admin/page.ts",
    '''<button type="submit">Add ChatGPT account</button><div id="oauth-status" class="status muted"></div><button id="oauth-cancel"''',
    '''<button type="submit">Add ChatGPT account</button><div id="oauth-device" class="replace hidden"><a id="oauth-device-link" href="#" target="_blank" rel="noreferrer noopener">Open official sign-in</a><div>One-time code: <code id="oauth-device-code"></code></div></div><div id="oauth-status" class="status muted"></div><button id="oauth-cancel"''',
)
replace_exact(
    "src/admin/page.ts",
    '''async function startOAuth(event){event.preventDefault();const form=event.currentTarget,buttonEl=form.querySelector('button[type=submit]'),status=document.querySelector('#oauth-status');setBusy(buttonEl,true,'Starting login…');try{''',
    '''async function startOAuth(event){event.preventDefault();const form=event.currentTarget,buttonEl=form.querySelector('button[type=submit]'),status=document.querySelector('#oauth-status');document.querySelector('#oauth-device').classList.add('hidden');setBusy(buttonEl,true,'Starting login…');try{''',
)
replace_exact(
    "src/admin/page.ts",
    '''async function watchAuth(jobId){clearTimeout(jobTimer);const status=document.querySelector('#oauth-status'),buttonEl=document.querySelector('#oauth-form button[type=submit]'),cancel=document.querySelector('#oauth-cancel');try{const job=await api('/admin/auth-jobs/'+encodeURIComponent(jobId));status.textContent=job.safeError?((job.safeMessage||'Authentication failed')+' '+job.safeError):(job.safeMessage||job.status);status.className='status '+(job.status==='complete'?'success':job.status==='error'?'error':'muted');if(['complete','error','cancelled'].includes(job.status)){activeJobId=null;cancel.classList.add('hidden');setBusy(buttonEl,false);if(job.status==='complete'){document.querySelector('#oauth-id').value='';document.querySelector('#oauth-name').value='';await refreshCredentialState()}return}jobTimer=setTimeout(()=>watchAuth(jobId),900)}catch(e){status.textContent=e.message;status.className='status error';setBusy(buttonEl,false)}}''',
    '''async function watchAuth(jobId){clearTimeout(jobTimer);const status=document.querySelector('#oauth-status'),buttonEl=document.querySelector('#oauth-form button[type=submit]'),cancel=document.querySelector('#oauth-cancel'),device=document.querySelector('#oauth-device'),deviceLink=document.querySelector('#oauth-device-link'),deviceCode=document.querySelector('#oauth-device-code');try{const job=await api('/admin/auth-jobs/'+encodeURIComponent(jobId));if(job.verificationUrl&&job.userCode){deviceLink.href=job.verificationUrl;deviceCode.textContent=job.userCode;device.classList.remove('hidden')}else{device.classList.add('hidden');deviceLink.removeAttribute('href');deviceCode.textContent=''}status.textContent=job.safeError?((job.safeMessage||'Authentication failed')+' '+job.safeError):(job.safeMessage||job.status);status.className='status '+(job.status==='complete'?'success':job.status==='error'?'error':'muted');if(['complete','error','cancelled'].includes(job.status)){activeJobId=null;cancel.classList.add('hidden');device.classList.add('hidden');deviceLink.removeAttribute('href');deviceCode.textContent='';setBusy(buttonEl,false);if(job.status==='complete'){document.querySelector('#oauth-id').value='';document.querySelector('#oauth-name').value='';await refreshCredentialState()}return}jobTimer=setTimeout(()=>watchAuth(jobId),900)}catch(e){status.textContent=e.message;status.className='status error';setBusy(buttonEl,false)}}''',
)

# --- Remote-admin override: same-origin + CSRF still required, while default local automation remains compatible. ---
replace_exact(
    "src/dispatcher.ts",
    '''    const origin = req.headers.origin;\n    if (origin) {\n      let parsed: URL;\n      try { parsed = new URL(origin); } catch { throw new OpenAICCError("Invalid Origin header.", 403, "invalid_origin"); }\n      if (!isLoopbackHost(parsed.hostname) || parsed.protocol !== "http:") throw new OpenAICCError("Cross-origin Admin mutation rejected.", 403, "invalid_origin");\n      const requestHost = String(req.headers.host ?? "").toLowerCase();\n      if (requestHost && parsed.host.toLowerCase() !== requestHost) throw new OpenAICCError("Cross-origin Admin mutation rejected.", 403, "invalid_origin");\n      if (req.headers["x-openai-cc-csrf"] !== this.csrfToken) throw new OpenAICCError("Missing or invalid Admin anti-CSRF token.", 403, "invalid_csrf");\n    } else if (req.headers["x-openai-cc-csrf"] && req.headers["x-openai-cc-csrf"] !== this.csrfToken) {\n      throw new OpenAICCError("Invalid Admin anti-CSRF token.", 403, "invalid_csrf");\n    }''',
    '''    const origin = req.headers.origin;\n    const csrfValid = req.headers["x-openai-cc-csrf"] === this.csrfToken;\n    if (origin) {\n      let parsed: URL;\n      try { parsed = new URL(origin); } catch { throw new OpenAICCError("Invalid Origin header.", 403, "invalid_origin"); }\n      const requestHost = String(req.headers.host ?? "").toLowerCase();\n      if (!requestHost || parsed.host.toLowerCase() !== requestHost) throw new OpenAICCError("Cross-origin Admin mutation rejected.", 403, "invalid_origin");\n      if (!this.allowRemoteAdmin && (!isLoopbackHost(parsed.hostname) || parsed.protocol !== "http:")) {\n        throw new OpenAICCError("Cross-origin Admin mutation rejected.", 403, "invalid_origin");\n      }\n      if (this.allowRemoteAdmin && parsed.protocol !== "http:" && parsed.protocol !== "https:") {\n        throw new OpenAICCError("Unsupported Admin Origin scheme.", 403, "invalid_origin");\n      }\n      if (!csrfValid) throw new OpenAICCError("Missing or invalid Admin anti-CSRF token.", 403, "invalid_csrf");\n    } else if (this.allowRemoteAdmin) {\n      if (!csrfValid) throw new OpenAICCError("Remote Admin mutations require the anti-CSRF token.", 403, "invalid_csrf");\n    } else if (req.headers["x-openai-cc-csrf"] && !csrfValid) {\n      throw new OpenAICCError("Invalid Admin anti-CSRF token.", 403, "invalid_csrf");\n    }''',
)

# --- Installer reproducibility: exact committed dependency graph. ---
replace_exact(
    "setup.ps1",
    '''$exitCode = Invoke-NativeConsole (Get-Command npm).Source @("install", "--no-audit", "--no-fund")\n    if ($exitCode -ne 0) { throw "npm install failed." }''',
    '''$exitCode = Invoke-NativeConsole (Get-Command npm).Source @("ci", "--no-audit", "--no-fund")\n    if ($exitCode -ne 0) { throw "npm ci failed against the committed package-lock.json." }''',
)

# --- Tests. ---
replace_exact(
    "tests/chatgpt-auth.test.ts",
    '''if(mode==='hang'){console.error('Open this URL: https://example.invalid/?state=secret&code_verifier=secret');setInterval(()=>{},1000)}\nawait mkdir(home,{recursive:true});''',
    '''if(mode==='hang'){console.error('Open this URL: https://example.invalid/?state=secret&code_verifier=secret');setInterval(()=>{},1000)}\nif(mode==='device'){\n  console.log('Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n https://auth.openai.com/codex/device\\n\\n2. Enter this one-time code (expires in 15 minutes)\\n ABCD-1234');\n  await new Promise(resolve=>setTimeout(resolve,180));\n}\nawait mkdir(home,{recursive:true});''',
)
append_if_missing(
    "tests/chatgpt-auth.test.ts",
    "device-code fallback exposes only the official transient verification URL and user code",
    '''\n\ntest("device-code fallback exposes only the official transient verification URL and user code", async () => {\n  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-device-"));\n  const store = new AccountStore(path.join(root, "data"));\n  await store.init();\n  const entrypoint = await fakeCodex(root);\n  const previous = process.env.FAKE_CODEX_BEHAVIOR;\n  process.env.FAKE_CODEX_BEHAVIOR = "device";\n  const runner = new OfficialCodexAuthRunner(store, { codexEntrypoint: entrypoint, timeoutMs: 5_000 });\n  const started = await runner.start({ credentialId: "device", displayName: "Device", loginMode: "device" });\n  if (previous === undefined) delete process.env.FAKE_CODEX_BEHAVIOR; else process.env.FAKE_CODEX_BEHAVIOR = previous;\n  let active = started;\n  for (let i = 0; i < 60 && (!active.verificationUrl || !active.userCode); i++) {\n    await new Promise((resolve) => setTimeout(resolve, 10));\n    active = runner.status(started.jobId);\n  }\n  assert.equal(active.status, "awaiting_user");\n  assert.equal(active.verificationUrl, "https://auth.openai.com/codex/device");\n  assert.equal(active.userCode, "ABCD-1234");\n  assert.equal(JSON.stringify(active).includes("auth.json"), false);\n  const done = await waitTerminal(runner, started);\n  assert.equal(done.status, "complete");\n  assert.equal(done.verificationUrl, undefined);\n  assert.equal(done.userCode, undefined);\n  await runner.shutdown();\n  store.close();\n});\n''',
)

replace_exact(
    "tests/admin.test.ts",
    '''      status: "awaiting_browser",\n      startedAt: new Date().toISOString(),\n      safeMessage: "Browser opened. Finish signing in with ChatGPT.",''',
    '''      status: options.loginMode === "device" ? "awaiting_user" : "awaiting_browser",\n      startedAt: new Date().toISOString(),\n      verificationUrl: options.loginMode === "device" ? "https://auth.openai.com/codex/device" : undefined,\n      userCode: options.loginMode === "device" ? "ABCD-1234" : undefined,\n      safeMessage: options.loginMode === "device" ? "Open the official Codex device sign-in page and enter the one-time code." : "Browser opened. Finish signing in with ChatGPT.",''',
)
append_if_missing(
    "tests/admin.test.ts",
    "explicit remote-admin override permits only same-origin CSRF-protected browser mutations",
    '''\n\ntest("explicit remote-admin override permits only same-origin CSRF-protected browser mutations", async () => {\n  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-remote-override-"));\n  const store = new AccountStore(root); await store.init();\n  const models = new ModelConfigStore(root, store); await models.init();\n  const auth = new FakeAuthRunner(store);\n  const server = createServer(store, models, { authRunner: auth, bindHost: "0.0.0.0", allowRemoteAdmin: true });\n  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));\n  const address = server.address(); if (!address || typeof address === "string") throw new Error("bad address");\n  const port = address.port;\n  const virtualHost = `admin.example.test:${port}`;\n  try {\n    const page = await rawAdminRequest(port, "/admin", "GET", { Host: virtualHost });\n    assert.equal(page.status, 200);\n    const match = page.body.match(/window\\.__OPENAI_CC__=(\\{[^;]+\\});/);\n    if (!match) throw new Error("csrf token missing");\n    const csrf = JSON.parse(match[1]).csrfToken as string;\n    const good = await rawAdminRequest(port, "/admin/credentials", "POST", {\n      Host: virtualHost, Origin: `http://${virtualHost}`, "Content-Type": "application/json", "X-OpenAI-CC-CSRF": csrf,\n    }, JSON.stringify({ id: "remote", name: "Remote", provider: "nvidia", apiKey: "secret", model: "nim" }));\n    assert.equal(good.status, 201);\n    const wrongOrigin = await rawAdminRequest(port, "/admin/credentials", "POST", {\n      Host: virtualHost, Origin: `http://evil.example:${port}`, "Content-Type": "application/json", "X-OpenAI-CC-CSRF": csrf,\n    }, JSON.stringify({ id: "bad-origin", name: "Bad", provider: "nvidia", apiKey: "secret", model: "nim" }));\n    assert.equal(wrongOrigin.status, 403);\n    const noOriginNoCsrf = await rawAdminRequest(port, "/admin/credentials", "POST", {\n      Host: virtualHost, "Content-Type": "application/json",\n    }, JSON.stringify({ id: "no-csrf", name: "Bad", provider: "nvidia", apiKey: "secret", model: "nim" }));\n    assert.equal(noOriginNoCsrf.status, 403);\n  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }\n});\n\nasync function rawAdminRequest(port: number, requestPath: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {\n  return new Promise((resolve, reject) => {\n    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers }, (res) => {\n      const chunks: Buffer[] = [];\n      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));\n      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));\n    });\n    req.on("error", reject);\n    if (body !== undefined) req.write(body);\n    req.end();\n  });\n}\n''',
)

replace_exact(
    "tests/admin-page.test.ts",
    '''  assert.match(source, /oauth-cancel/);''',
    '''  assert.match(source, /oauth-cancel/);\n  assert.match(source, /oauth-device-link/);\n  assert.match(source, /verificationUrl/);\n  assert.match(source, /userCode/);\n  assert.match(source, /deviceCode\\.textContent=job\\.userCode/);''',
)
replace_exact(
    "tests/claude-desktop.test.ts",
    '''  assert.match(setup, /dist\\/scripts\\/configure-clients\\.js/);''',
    '''  assert.match(setup, /dist\\/scripts\\/configure-clients\\.js/);\n  assert.match(setup, /Invoke-NativeConsole \\(Get-Command npm\\)\\.Source @\\("ci", "--no-audit", "--no-fund"\\)/);\n  assert.doesNotMatch(setup, /Invoke-NativeConsole \\(Get-Command npm\\)\\.Source @\\("install", "--no-audit", "--no-fund"\\)/);''',
)

# Documentation matches the final behavior.
replace_exact(
    "README.md",
    '''Browser login is the default; the official Codex device-auth flow is available as a fallback.''',
    '''Browser login is the default; the official Codex device-auth flow is available as a fallback. In device mode the Admin UI and terminal show the official transient verification URL and one-time user code, then discard both when the auth job finishes.''',
)
replace_exact(
    "README.md",
    '''- If `HOST` is changed to a non-loopback address, `/admin` is refused unless `OPENAI_CC_UNSAFE_REMOTE_ADMIN=1` is explicitly set. That override does **not** add TLS or user authentication; provide your own network protections if you deliberately use it.''',
    '''- If `HOST` is changed to a non-loopback address, `/admin` is refused unless `OPENAI_CC_UNSAFE_REMOTE_ADMIN=1` is explicitly set. With that override, browser mutations still require exact same-origin Host/Origin matching plus the per-process CSRF token, and non-browser mutations require the CSRF token. The override does **not** add TLS or user authentication; provide your own network protections if you deliberately use it.''',
)
replace_exact(
    "README.md",
    '''- builds OpenAI-CC with its pinned npm dependency set, including the official Codex CLI package used for ChatGPT login;''',
    '''- installs OpenAI-CC with `npm ci` from the committed lockfile and builds it, including the pinned official Codex CLI package used for ChatGPT login;''',
)
