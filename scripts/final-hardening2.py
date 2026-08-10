from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrence(s), found {actual}: {old[:100]!r}")
    p.write_text(text.replace(old, new), encoding="utf-8")


def append_if_missing(path: str, marker: str, text: str) -> None:
    p = Path(path)
    current = p.read_text(encoding="utf-8")
    if marker not in current:
        p.write_text(current + text, encoding="utf-8")


# Account store: explicit AUTH ERROR status, transactional credential writes, and stronger redaction.
replace_exact(
    "src/account-store.ts",
    'export type AccountStatus = "ready" | "exhausted" | "disabled";',
    'export type AccountStatus = "ready" | "exhausted" | "auth_error" | "disabled";',
)
replace_exact(
    "src/account-store.ts",
    '''    this.state.accounts.push(record);\n    if (!this.state.preferredCredentialByProvider.chatgpt) this.state.preferredCredentialByProvider.chatgpt = record.id;\n    await this.persist();\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(record) });\n    return { ...record };''',
    '''    const previousState = structuredClone(this.state);\n    this.state.accounts.push(record);\n    if (!this.state.preferredCredentialByProvider.chatgpt) this.state.preferredCredentialByProvider.chatgpt = record.id;\n    try {\n      await this.persist();\n    } catch (error) {\n      this.state = previousState;\n      throw error;\n    }\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(record) });\n    return { ...record };''',
)
replace_exact(
    "src/account-store.ts",
    '''    account.authFile = authFile;\n    account.email = input.email ?? await readAuthEmail(authFile) ?? account.email;\n    if (input.name !== undefined) account.name = cleanName(input.name);\n    this.clearUsageWindow(account);\n    account.status = "ready";\n    delete account.disabledAt;\n    account.updatedAt = new Date().toISOString();\n    await this.persist();\n    this.scheduleReset(account);\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(account) });\n    return { ...account };''',
    '''    const previousState = structuredClone(this.state);\n    account.authFile = authFile;\n    account.email = input.email ?? await readAuthEmail(authFile) ?? account.email;\n    if (input.name !== undefined) account.name = cleanName(input.name);\n    account.status = "ready";\n    delete account.firstRequestAt;\n    delete account.limitResetsAt;\n    delete account.exhaustedAt;\n    delete account.lastError;\n    delete account.disabledAt;\n    account.updatedAt = new Date().toISOString();\n    try {\n      await this.persist();\n    } catch (error) {\n      this.state = previousState;\n      throw error;\n    }\n    this.clearResetTimer(id);\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(account) });\n    return { ...account };''',
)
replace_exact(
    "src/account-store.ts",
    '''    this.state.accounts.push(record);\n    if (!this.state.preferredCredentialByProvider[input.provider]) this.state.preferredCredentialByProvider[input.provider] = record.id;\n    await this.persist();\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(record) });\n    return { ...record };''',
    '''    const previousState = structuredClone(this.state);\n    this.state.accounts.push(record);\n    if (!this.state.preferredCredentialByProvider[input.provider]) this.state.preferredCredentialByProvider[input.provider] = record.id;\n    try {\n      await this.persist();\n    } catch (error) {\n      this.state = previousState;\n      throw error;\n    }\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(record) });\n    return { ...record };''',
)
replace_exact(
    "src/account-store.ts",
    '''    account.apiKey = apiKey;\n    if (input.model !== undefined) {\n      const model = String(input.model).trim();\n      if (!model) throw new OpenAICCError("Provider model id is required.", 400, "model_required");\n      account.model = model;\n    }\n    if (input.name !== undefined) account.name = cleanName(input.name);\n    this.clearUsageWindow(account);\n    account.status = "ready";\n    delete account.disabledAt;\n    account.updatedAt = new Date().toISOString();\n    await this.persist();\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(account) });\n    return { ...account };''',
    '''    const previousState = structuredClone(this.state);\n    account.apiKey = apiKey;\n    if (input.model !== undefined) {\n      const model = String(input.model).trim();\n      if (!model) throw new OpenAICCError("Provider model id is required.", 400, "model_required");\n      account.model = model;\n    }\n    if (input.name !== undefined) account.name = cleanName(input.name);\n    account.status = "ready";\n    delete account.firstRequestAt;\n    delete account.limitResetsAt;\n    delete account.exhaustedAt;\n    delete account.lastError;\n    delete account.disabledAt;\n    account.updatedAt = new Date().toISOString();\n    try {\n      await this.persist();\n    } catch (error) {\n      this.state = previousState;\n      throw error;\n    }\n    this.clearResetTimer(id);\n    this.emitEvent({ type: "credentials_changed", credential: publicCredential(account) });\n    return { ...account };''',
)
replace_exact(
    "src/account-store.ts",
    '    if (account.status === "disabled") throw conflict(`Credential ${id} is disabled and cannot be preferred.`, "credential_disabled");',
    '    if (account.status !== "ready") throw conflict(`Credential ${id} is ${account.status} and cannot be preferred until it is ready.`, "credential_unavailable");',
)
replace_exact(
    "src/account-store.ts",
    '''    const futureReset = account.limitResetsAt && Date.parse(account.limitResetsAt) > Date.now();\n    account.status = futureReset ? "exhausted" : "ready";\n    if (!futureReset) this.clearUsageWindow(account);\n    delete account.disabledAt;''',
    '''    const futureReset = account.limitResetsAt && Date.parse(account.limitResetsAt) > Date.now();\n    account.status = futureReset ? "exhausted" : account.lastError ? "auth_error" : "ready";\n    if (!futureReset && account.status === "ready") this.clearUsageWindow(account);\n    delete account.disabledAt;''',
)
replace_exact(
    "src/account-store.ts",
    '''  async resetIfDue(id: string): Promise<AccountRecord> {''',
    '''  async markAuthError(id: string, message: string): Promise<AccountRecord> {\n    const account = this.requireAccount(id);\n    if (account.status === "disabled") return { ...account };\n    const previousState = structuredClone(this.state);\n    account.status = "auth_error";\n    delete account.firstRequestAt;\n    delete account.limitResetsAt;\n    delete account.exhaustedAt;\n    account.lastError = sanitizeError(message || "Authentication failed.");\n    account.updatedAt = new Date().toISOString();\n    try {\n      await this.persist();\n    } catch (error) {\n      this.state = previousState;\n      throw error;\n    }\n    this.clearResetTimer(id);\n    this.emitEvent({ type: "credential_status_changed", credential: publicCredential(account) });\n    return { ...account };\n  }\n\n  async resetIfDue(id: string): Promise<AccountRecord> {''',
)
replace_exact(
    "src/account-store.ts",
    '''    const timer = this.resetTimers.get(account.id);\n    if (timer) clearTimeout(timer);\n    this.resetTimers.delete(account.id);\n  }\n\n  private scheduleReset(account: AccountRecord): void {''',
    '''    this.clearResetTimer(account.id);\n  }\n\n  private clearResetTimer(id: string): void {\n    const timer = this.resetTimers.get(id);\n    if (timer) clearTimeout(timer);\n    this.resetTimers.delete(id);\n  }\n\n  private scheduleReset(account: AccountRecord): void {''',
)
replace_exact(
    "src/account-store.ts",
    '''function sanitizeError(value: string): string {\n  return String(value ?? "").replace(/https?:\\/\\/\\S+/gi, "[redacted-url]").slice(0, 1000);\n}''',
    '''function sanitizeError(value: string): string {\n  return String(value ?? "")\n    .replace(/https?:\\/\\/\\S+/gi, "[redacted-url]")\n    .replace(/\\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key|authorization)\\b\\s*[:=]\\s*[^\\s,]+/gi, "$1=[redacted]")\n    .replace(/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted-jwt]")\n    .slice(0, 1000);\n}''',
)

# Routing: authentication failures are durable credential health, not blind retries.
replace_exact(
    "src/model-config.ts",
    '''  async markRateLimitedAndNext(model: string, account: AccountRecord, message: string, cooldownMs?: number, attempted = new Set<string>()): Promise<AccountRecord | undefined> {\n    await this.accounts.markRateLimited(account.id, message, cooldownMs);\n    const route = this.routeForRequestedModel(model);\n    if (route.credentialId) return undefined;\n    return this.credentialForRequestedModel(model, attempted);\n  }''',
    '''  async markRateLimitedAndNext(model: string, account: AccountRecord, message: string, cooldownMs?: number, attempted = new Set<string>()): Promise<AccountRecord | undefined> {\n    await this.accounts.markRateLimited(account.id, message, cooldownMs);\n    const route = this.routeForRequestedModel(model);\n    if (route.credentialId) return undefined;\n    return this.credentialForRequestedModel(model, attempted);\n  }\n\n  async markAuthErrorAndNext(model: string, account: AccountRecord, message: string, attempted = new Set<string>()): Promise<AccountRecord | undefined> {\n    await this.accounts.markAuthError(account.id, message);\n    const route = this.routeForRequestedModel(model);\n    if (route.credentialId) return undefined;\n    return this.credentialForRequestedModel(model, attempted);\n  }''',
)
replace_exact(
    "src/dispatcher.ts",
    '''      } catch (error: any) {\n        if (!isRateLimit(error)) throw error;\n        const cooldown = rateLimitCooldownMs(error, account);\n        if (res.headersSent) {\n          await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);\n          if (!res.writableEnded) {\n            res.write(`event: error\\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "The configured credential hit a limit after streaming began; no partial response was replayed. The next request will use the next eligible credential." } })}\\n\\n`);\n            res.end();\n          }\n          return;\n        }\n        account = await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);\n        if (!account) {\n          const message = route.credentialId ? "The pinned credential is rate-limited; pinned routes do not fall back." : `All ready ${route.provider} credentials for this model slot are rate-limited.`;\n          return void json(res, 429, { error: { type: "rate_limit_error", message } });\n        }\n      }''',
    '''      } catch (error: any) {\n        if (isAuthenticationError(error)) {\n          const upstreamMessage = error?.message ?? "Upstream authentication failed.";\n          if (res.headersSent) {\n            await this.models.markAuthErrorAndNext(body.model, account, upstreamMessage, attempted);\n            if (!res.writableEnded) {\n              res.write(`event: error\\ndata: ${JSON.stringify({ type: "error", error: { type: "authentication_error", message: "The configured credential failed authentication after streaming began; no partial response was replayed. Re-authenticate or replace the credential. The next request may use another eligible credential." } })}\\n\\n`);\n              res.end();\n            }\n            return;\n          }\n          account = await this.models.markAuthErrorAndNext(body.model, account, upstreamMessage, attempted);\n          if (!account) {\n            const message = route.credentialId ? "The pinned credential failed authentication; pinned routes do not fall back." : `All ready ${route.provider} credentials for this model slot failed authentication or are unavailable.`;\n            return void json(res, 401, { error: { type: "authentication_error", message } });\n          }\n          continue;\n        }\n        if (!isRateLimit(error)) throw error;\n        const cooldown = rateLimitCooldownMs(error, account);\n        if (res.headersSent) {\n          await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);\n          if (!res.writableEnded) {\n            res.write(`event: error\\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "The configured credential hit a limit after streaming began; no partial response was replayed. The next request will use the next eligible credential." } })}\\n\\n`);\n            res.end();\n          }\n          return;\n        }\n        account = await this.models.markRateLimitedAndNext(body.model, account, error?.message ?? "429 rate limit", cooldown, attempted);\n        if (!account) {\n          const message = route.credentialId ? "The pinned credential is rate-limited; pinned routes do not fall back." : `All ready ${route.provider} credentials for this model slot are rate-limited.`;\n          return void json(res, 429, { error: { type: "rate_limit_error", message } });\n        }\n      }''',
)
replace_exact(
    "src/dispatcher.ts",
    '''    const message = error instanceof Error ? error.message : String(error);\n    json(res, 500, { error: { code: "internal_error", message: sanitizeServerError(message) } });''',
    '''    json(res, 500, { error: { code: "internal_error", message: "Internal server error." } });''',
)
replace_exact(
    "src/dispatcher.ts",
    '''function isRateLimit(error: any): boolean { return error?.status === 429 || error?.statusCode === 429 || /\\b429\\b|rate.?limit|usage.?limit|quota/i.test(error?.message ?? ""); }''',
    '''function isAuthenticationError(error: any): boolean { return error?.status === 401 || error?.statusCode === 401; }\nfunction isRateLimit(error: any): boolean { return error?.status === 429 || error?.statusCode === 429 || /\\b429\\b|rate.?limit|usage.?limit|quota/i.test(error?.message ?? ""); }''',
)
replace_exact(
    "src/dispatcher.ts",
    '''function sanitizeServerError(value: string): string {\n  return String(value ?? "")\n    .replace(/https?:\\/\\/\\S+/gi, "[redacted-url]")\n    .replace(/\\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key)\\b\\s*[:=]\\s*[^\\s,]+/gi, "$1=[redacted]")\n    .slice(0, 1200);\n}\n''',
    '''''',
)

# Auth jobs must not leak managed filesystem paths in safe errors.
replace_exact(
    "src/chatgpt-auth.ts",
    '''    job.safeError = redactSensitive(message).slice(0, 1200);''',
    '''    job.safeError = this.redactError(message);''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''  private async cleanup(job: InternalJob): Promise<void> {''',
    '''  private redactError(message: string): string {\n    const managedRoot = this.store.dataDir;\n    return redactSensitive(message)\n      .split(managedRoot).join("[managed-data]")\n      .split(managedRoot.replace(/\\\\/g, "/")).join("[managed-data]")\n      .slice(0, 1200);\n  }\n\n  private async cleanup(job: InternalJob): Promise<void> {''',
)

# UI: AUTH ERROR is human-readable and only READY credentials can become preferred.
replace_exact(
    "src/admin/page.ts",
    "function title(v){return v.charAt(0).toUpperCase()+v.slice(1)}\n",
    "function title(v){return v.charAt(0).toUpperCase()+v.slice(1)}\nfunction statusLabel(v){return String(v).replace(/_/g,' ').toUpperCase()}\nfunction statusClass(v){return String(v).replace(/_/g,'-')}\n",
)
replace_exact("src/admin/page.ts", "a.status.toUpperCase()", "statusLabel(a.status)", count=2)
replace_exact("src/admin/page.ts", "class=\"badge '+a.status+'\"", "class=\"badge '+statusClass(a.status)+'\"")
replace_exact(
    "src/admin/page.ts",
    "const common=(a.status!=='disabled'&&!isPreferred?button('prefer',a.id,'Make preferred'):'')",
    "const common=(a.status==='ready'&&!isPreferred?button('prefer',a.id,'Make preferred'):'')",
)

# Regression coverage.
append_if_missing(
    "tests/account-store.test.ts",
    "authentication errors are sticky, secret-safe, and excluded from routing",
    '''\n\ntest("authentication errors are sticky, secret-safe, and excluded from routing", async () => {\n  const { store } = await tempStore();\n  await store.createApiKey({ id: "g1", name: "Google 1", provider: "google", apiKey: "a", model: "m" });\n  await store.createApiKey({ id: "g2", name: "Google 2", provider: "google", apiKey: "b", model: "m" });\n  const jwt = "eyJaaaaaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccc";\n  await store.markAuthError("g1", `401 access_token=very-secret https://auth.example.invalid ${jwt}`);\n  const failed = store.publicGet("g1");\n  assert.equal(failed?.status, "auth_error");\n  assert.equal(failed?.lastError?.includes("very-secret"), false);\n  assert.equal(failed?.lastError?.includes("auth.example.invalid"), false);\n  assert.equal(failed?.lastError?.includes(jwt), false);\n  assert.deepEqual(store.orderedReady("google").map((a) => a.id), ["g2"]);\n  await assert.rejects(() => store.prefer("g1"), (error: unknown) => error instanceof OpenAICCError && error.code === "credential_unavailable");\n  await store.disable("g1");\n  await store.enable("g1");\n  assert.equal(store.publicGet("g1")?.status, "auth_error");\n  store.close();\n});\n\ntest("failed API-key replacement rolls in-memory state back before returning", async () => {\n  const { store } = await tempStore();\n  await store.createApiKey({ id: "n1", name: "NVIDIA", provider: "nvidia", apiKey: "old-key", model: "old-model" });\n  const originalPersist = (store as any).persist.bind(store);\n  (store as any).persist = async () => { throw new Error("simulated disk failure"); };\n  await assert.rejects(() => store.replaceApiKey("n1", { apiKey: "new-key", model: "new-model" }), /simulated disk failure/);\n  (store as any).persist = originalPersist;\n  const record = store.get("n1");\n  assert.equal(record?.apiKey, "old-key");\n  assert.equal(record?.model, "old-model");\n  assert.equal(record?.status, "ready");\n  store.close();\n});\n''',
)
append_if_missing(
    "tests/routing.test.ts",
    "pre-output 401 marks AUTH ERROR",
    '''\n\ntest("pre-output 401 marks AUTH ERROR and retries the next same-provider credential", async () => {\n  const calls: string[] = [];\n  const f = await routeFixture((id) => ({ chat: { completions: { create: async () => {\n    calls.push(id);\n    if (id === "n1") throw Object.assign(new Error("401 invalid credential access_token=do-not-expose"), { status: 401 });\n    return { id: "ok", choices: [{ message: { content: "authenticated fallback" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };\n  } } } }));\n  try {\n    const response = await fetch(`${f.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(false)) });\n    assert.equal(response.status, 200);\n    assert.deepEqual(calls, ["n1", "n2"]);\n    assert.equal(f.accounts.publicGet("n1")?.status, "auth_error");\n    assert.equal(f.accounts.publicGet("n1")?.lastError?.includes("do-not-expose"), false);\n    assert.equal((await response.json() as any).content[0].text, "authenticated fallback");\n  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }\n});\n''',
)
replace_exact(
    "tests/chatgpt-auth.test.ts",
    'import assert from "node:assert/strict";\n',
    'import assert from "node:assert/strict";\nimport { spawnSync } from "node:child_process";\nimport { createRequire } from "node:module";\n',
)
replace_exact(
    "tests/chatgpt-auth.test.ts",
    '''  const originalReplace = store.replaceChatGptAuth.bind(store);\n  (store as any).replaceChatGptAuth = async () => { throw new Error("simulated metadata persistence failure"); };''',
    '''  const originalPersist = (store as any).persist.bind(store);\n  let failPersist = true;\n  (store as any).persist = async () => {\n    if (failPersist) { failPersist = false; throw new Error("simulated metadata persistence failure"); }\n    return originalPersist();\n  };''',
)
replace_exact(
    "tests/chatgpt-auth.test.ts",
    '''  (store as any).replaceChatGptAuth = originalReplace;''',
    '''  (store as any).persist = originalPersist;''',
)
append_if_missing(
    "tests/chatgpt-auth.test.ts",
    "bundled official Codex accepts isolated file-credential-store login status",
    '''\n\ntest("bundled official Codex accepts isolated file-credential-store login status", async (t) => {\n  let packageJson: string;\n  try {\n    const require = createRequire(import.meta.url);\n    packageJson = require.resolve("@openai/codex/package.json");\n  } catch {\n    t.skip("bundled Codex package is not installed in the offline local harness");\n    return;\n  }\n  const codex = path.join(path.dirname(packageJson), "bin", "codex.js");\n  const home = await mkdtemp(path.join(os.tmpdir(), "openai-cc-real-codex-status-"));\n  const result = spawnSync(process.execPath, [codex, "-c", 'cli_auth_credentials_store="file"', "login", "status"], {\n    env: { ...process.env, CODEX_HOME: home },\n    encoding: "utf8",\n    timeout: 15_000,\n  });\n  const output = `${result.stdout ?? ""} ${result.stderr ?? ""}`;\n  assert.equal(result.status, 1);\n  assert.doesNotMatch(output, /unknown.*cli_auth_credentials_store|invalid.*config/i);\n  assert.match(output, /not logged in|login/i);\n});\n''',
)
replace_exact(
    "tests/admin-page.test.ts",
    '''  assert.match(source, /button\\.disabled=true/);''',
    '''  assert.match(source, /button\\.disabled=true/);\n  assert.match(source, /statusLabel/);\n  assert.match(source, /auth-error/);''',
)
replace_exact(
    "README.md",
    '''- `DISABLED`\n\nAn exhausted credential''',
    '''- `DISABLED`\n- `AUTH ERROR`\n\nA `401` from an upstream credential marks it `AUTH ERROR`; Auto routing may continue with the next ready credential from the same provider, while pinned routes remain unavailable until the exact credential is re-authenticated or its API key is replaced.\n\nAn exhausted credential''',
)
replace_exact(
    "README.md",
    '''- pre-output and post-output rate-limit behavior;''',
    '''- pre-output and post-output rate-limit behavior;\n- upstream authentication-error state/failover and secret redaction;''',
)
