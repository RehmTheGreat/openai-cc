import { readFile, writeFile, rm } from "node:fs/promises";

async function edit(path, before, after, label) {
  const source = await readFile(path, "utf8");
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing anchor: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Anchor not unique: ${label}`);
  await writeFile(path, source.slice(0, first) + after + source.slice(first + before.length), "utf8");
}

await edit("src/model-config.ts", `const CLAUDE_CODE_STANDARD_MODEL_IDS: Record<ModelSlot, string> = {
  default: "claude-sonnet-4-5",
  fable: "claude-opus-4-8",
  opus: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-opus-4-7",
};

const CLAUDE_CODE_EXTENDED_MODEL_IDS: Record<ModelSlot, string> = {
  // Sonnet 5 is natively 1M on the gateway provider path when
  // CLAUDE_CODE_USE_GATEWAY=1 is present. The other ids use Claude Code's
  // explicit [1m] variant because its current 3P catalog still downgrades their
  // bare forms to 200K.
  default: "claude-sonnet-5",
  fable: "claude-opus-4-8[1m]",
  opus: "claude-haiku-4-5[1m]",
  sonnet: "claude-sonnet-4-6[1m]",
  haiku: "claude-opus-4-7[1m]",
};`, `const CLAUDE_CODE_STANDARD_MODEL_IDS: Record<ModelSlot, string> = {
  default: "claude-opus-4-8",
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

const CLAUDE_CODE_EXTENDED_MODEL_IDS: Record<ModelSlot, string> = {
  // Keep the public Sonnet id stable so existing Sonnet routing remains intact.
  // Sonnet 5 becomes native-1M when Claude Code resolves provider=gateway;
  // the other extended carriers use raw [1m] ids whose suffix is client-side.
  default: "claude-opus-4-8[1m]",
  fable: "claude-fable-5[1m]",
  opus: "claude-opus-5[1m]",
  sonnet: "claude-sonnet-5",
  haiku: "claude-opus-4-7[1m]",
};`, "model carrier ids");

await edit("setup.ps1", `  Set-PersistentEnvironment "ANTHROPIC_MODEL" "claude-sonnet-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_FABLE_MODEL" "claude-opus-4-8[1m]"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_OPUS_MODEL" "claude-haiku-4-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_SONNET_MODEL" "claude-sonnet-4-6[1m]"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_HAIKU_MODEL" "claude-opus-4-7[1m]"`, `  Set-PersistentEnvironment "ANTHROPIC_MODEL" "claude-opus-4-8[1m]"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_FABLE_MODEL" "claude-fable-5[1m]"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_OPUS_MODEL" "claude-opus-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_SONNET_MODEL" "claude-sonnet-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_HAIKU_MODEL" "claude-opus-4-7[1m]"`, "installer carrier ids");

await edit("setup.ps1", `  if ($publicModels.Count -lt 4) { throw "Gateway model discovery returned fewer than four Claude-compatible routes." }
  foreach ($model in $publicModels) {
    if ($model.id -notmatch '^claude-') { throw "Gateway exposed an unsafe model id: $($model.id)" }
    if ([int64]$model.max_input_tokens -ne $ContextWindow) { throw "Gateway model $($model.id) does not advertise $ContextWindow input tokens." }
  }`, `  if ($publicModels.Count -lt 5) { throw "Gateway model discovery returned fewer than five Claude-compatible routes." }
  foreach ($model in $publicModels) {
    if ($model.id -notmatch '^claude-') { throw "Gateway exposed an unsafe model id: $($model.id)" }
    if ([int64]$model.max_input_tokens -gt $ContextWindow) { throw "Gateway model $($model.id) advertises above the configured context target." }
  }
  $terraModels = @($publicModels | Where-Object { $_.display_name -match 'gpt-5\\.6-terra' })
  if ($terraModels.Count -lt 2) { throw "Gateway discovery did not expose both Terra routes." }
  foreach ($model in $terraModels) {
    if ([int64]$model.max_input_tokens -ne $ContextWindow) { throw "Terra route $($model.id) does not advertise the configured context target." }
  }
  $geminiModels = @($publicModels | Where-Object { $_.display_name -match 'gemini-3\\.6-flash' })
  if ($geminiModels.Count -lt 2) { throw "Gateway discovery did not expose both Gemini routes." }
  foreach ($model in $geminiModels) {
    if ([int64]$model.max_input_tokens -ne $ContextWindow) { throw "Gemini route $($model.id) does not advertise the configured context target." }
  }
  $deepSeekModels = @($publicModels | Where-Object { $_.display_name -match 'deepseek-v4-flash-free' })
  if ($deepSeekModels.Count -lt 1) { throw "Gateway discovery did not expose the DeepSeek Free route." }
  foreach ($model in $deepSeekModels) {
    if ([int64]$model.max_input_tokens -gt 200000) { throw "DeepSeek Free route $($model.id) advertises above its verified 200K limit." }
  }`, "installer route-specific context validation");

await edit("setup.ps1", '$checks.Add("OpenAI-CC proxy + 700k model metadata")', '$checks.Add("OpenAI-CC proxy + route-specific context metadata")', "installer verification label");

await edit("tests/model-config.test.ts", `  assert.equal(claudeCodeModelAlias(config, "default"), "claude-sonnet-5");
  assert.equal(claudeCodeModelAlias(config, "fable"), "claude-opus-4-8[1m]");
  assert.equal(claudeCodeModelAlias(config, "opus"), "claude-haiku-4-5");
  assert.equal(models.slotForRequestedModel("claude-opus-4-8"), "fable");
  assert.equal(models.slotForRequestedModel("claude-opus-4-7"), "haiku");`, `  assert.equal(claudeCodeModelAlias(config, "default"), "claude-opus-4-8[1m]");
  assert.equal(claudeCodeModelAlias(config, "fable"), "claude-fable-5[1m]");
  assert.equal(claudeCodeModelAlias(config, "opus"), "claude-opus-5");
  assert.equal(claudeCodeModelAlias(config, "sonnet"), "claude-sonnet-5");
  assert.equal(models.slotForRequestedModel("claude-opus-4-8"), "default");
  assert.equal(models.slotForRequestedModel("claude-fable-5"), "fable");
  assert.equal(models.slotForRequestedModel("claude-sonnet-5"), "sonnet");
  assert.equal(models.slotForRequestedModel("claude-opus-4-7"), "haiku");`, "model routing regression assertions");

await edit("tests/model-config.test.ts", `  assert.equal(claudeCodeModelAlias(conservative, "haiku"), "claude-opus-4-7");`, `  assert.equal(claudeCodeModelAlias(conservative, "haiku"), "claude-haiku-4-5");`, "conservative haiku alias");

await edit("tests/claude-desktop.test.ts", `  assert.match(setup, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP/);
  assert.doesNotMatch(setup, /(?:OPENAI|NVIDIA|GEMINI|GOOGLE|ZEN|ANTHROPIC)_API_KEY\\s*[=:]/i);`, `  assert.match(setup, /OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP/);
  assert.match(setup, /deepseek-v4-flash-free/);
  assert.doesNotMatch(setup, /(?:OPENAI|NVIDIA|GEMINI|GOOGLE|ZEN|ANTHROPIC)_API_KEY\\s*[=:]/i);`, "installer metadata assertions");

await rm("scripts/apply-agent-context-fix-phase2.mjs", { force: true });
console.log("Applied semantic route-preserving context refinements.");
