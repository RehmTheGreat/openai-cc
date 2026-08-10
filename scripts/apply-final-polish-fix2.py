from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrence(s), found {actual}: {old[:140]!r}")
    p.write_text(text.replace(old, new), encoding="utf-8")


# Never allow terminal job state to become observable while device-login material is still attached.
replace_exact(
    "src/chatgpt-auth.ts",
    '''    const capture = (chunk: Buffer | string): void => {\n      const text = String(chunk);''',
    '''    const capture = (chunk: Buffer | string): void => {\n      if (job.settled) return;\n      const text = String(chunk);''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''    await terminateChild(job.child);\n    job.status = "cancelled";''',
    '''    await terminateChild(job.child);\n    this.clearTransientAuth(job);\n    job.status = "cancelled";''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''      job.settled = true;\n      job.status = "complete";''',
    '''      job.settled = true;\n      this.clearTransientAuth(job);\n      job.status = "complete";''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''    job.settled = true;\n    await terminateChild(job.child);\n    job.status = "error";\n    job.errorCode = "auth_timeout";''',
    '''    job.settled = true;\n    await terminateChild(job.child);\n    this.clearTransientAuth(job);\n    job.status = "error";\n    job.errorCode = "auth_timeout";''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''    const message = error instanceof Error ? error.message : String(error);\n    job.status = "error";''',
    '''    const message = error instanceof Error ? error.message : String(error);\n    this.clearTransientAuth(job);\n    job.status = "error";''',
)
replace_exact(
    "src/chatgpt-auth.ts",
    '''  private async cleanup(job: InternalJob): Promise<void> {\n    try { await rm(job.tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }\n    delete job.child;\n    delete job.timer;\n    job.output = "";\n    job.devicePromptBuffer = "";\n    delete job.verificationUrl;\n    delete job.userCode;\n  }''',
    '''  private clearTransientAuth(job: InternalJob): void {\n    job.devicePromptBuffer = "";\n    delete job.verificationUrl;\n    delete job.userCode;\n  }\n\n  private async cleanup(job: InternalJob): Promise<void> {\n    try { await rm(job.tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }\n    delete job.child;\n    delete job.timer;\n    job.output = "";\n    this.clearTransientAuth(job);\n  }''',
)
