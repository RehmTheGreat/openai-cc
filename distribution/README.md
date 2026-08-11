# Session 6B gated runtime distribution

OpenAI-CC uses **Backblaze B2 Cloud Storage** as a private, card-free distribution host. Backblaze currently allows B2 account creation without a credit card and includes the first 10 GB of storage free. This design deliberately does not add a billing method and does not use Cloudflare R2, S3, Azure Blob, GitLab Packages, or another host that would require a payment card for this deployment.

```text
private GitHub source repo
  -> exact-commit GitHub Actions Windows build
  -> private Backblaze B2 bucket
  -> short-lived readFiles-only application key
  -> target bootstrap
  -> unchanged Session 6A deterministic installer
  -> %LOCALAPPDATA%\OpenAI-CC\.data remains target-local
```

## Hard-free contract

This distribution is intended to stop working before it becomes paid.

- Do not add a payment method to the Backblaze account used for OpenAI-CC.
- Keep the private B2 bucket below the current free storage allowance; remove obsolete release versions before approaching it.
- Use B2 Caps & Alerts as an additional safety control. Do not raise a cap or add billing merely to keep distribution running.
- If Backblaze requires a payment method to increase storage, bandwidth, transactions, or another limit, stop and reduce usage instead.
- After the GitHub source repository becomes private, GitHub-hosted Actions consume the account's included private-repository allowance. Keep the GitHub billing account without a valid payment method, or configure an Actions budget with **Stop usage when budget limit is reached**. Never enable paid Actions overage for this project.
- Do not use GitHub larger runners.

Backblaze's current pricing and free allowances can change. Re-check them before any infrastructure change. The repository never provisions or changes billing.

## Storage layout

Create one B2 bucket with **Files in Bucket: Private (`allPrivate`)**, for example a randomly suffixed name such as:

```text
openai-cc-distribution-<random>
```

Each release is immutable by source identity:

```text
releases/<appVersion>-<full-40-character-source-SHA>/
  bootstrap.ps1
  install.ps1
  openai-cc-runtime-manifest.json
  openai-cc-runtime-<version>-<sha>-win-x64.zip
```

The full source SHA is also embedded in the Session 6A distribution manifest and runtime build metadata.

## Distribution credentials

Distribution authorization is completely separate from provider/inference credentials.

### 1. CI publisher key

Create one B2 application key for GitHub Actions with exactly:

- bucket: the private OpenAI-CC distribution bucket;
- file prefix: `releases/`;
- capability: `writeFiles` only.

Store only these values in the GitHub source repository:

```text
Repository secret: B2_PUBLISH_KEY_ID
Repository secret: B2_PUBLISH_KEY
Repository variable: B2_BUCKET_ID
```

`distribution/b2/publish-release.mjs` refuses a publisher key whose authorized bucket, prefix, or capabilities are broader/different than that contract.

The publisher key cannot create target download grants and never goes to target PCs.

### 2. Trusted grant issuer

On a trusted administrator PC, use a B2 key with the key-management capabilities required by the two local helpers:

- `writeKeys` to create grants;
- `deleteKeys` to revoke grants.

Set it only in that administrator shell:

```powershell
$env:B2_ISSUER_KEY_ID = '<issuer key id>'
$env:B2_ISSUER_KEY = '<issuer secret>'
$env:B2_BUCKET_ID = '<private distribution bucket id>'
```

Do **not** store this issuer credential in the runtime bundle, target `.data`, GitHub Actions, public commands, or hosted metadata.

### 3. Per-install target grant

`grant-release.mjs` creates a fresh application key with exactly:

- capability: `readFiles`;
- bucket: the one distribution bucket;
- `namePrefix`: one exact release directory;
- expiry: 60–3600 seconds, default 900 seconds.

The target grant cannot list unrelated files, upload/delete files, create keys, access GitHub, or authorize inference.

## Publish a release

The workflow `.github/workflows/publish-distribution.yml`:

1. checks out the selected exact source commit;
2. installs locked dependencies;
3. runs `npm test` with deterministic source/build identity;
4. prunes development dependencies;
5. builds the existing Session 6A Windows runtime bundle;
6. scans the distributable ZIP for forbidden target/provider state;
7. uploads exactly four release files to the private B2 prefix.

The workflow does not contain the grant issuer credential.

An already-built Session 6A artifact directory can also be published from a trusted machine:

```powershell
$env:B2_PUBLISH_KEY_ID = '<writeFiles-only key id>'
$env:B2_PUBLISH_KEY = '<writeFiles-only key>'
$env:B2_BUCKET_ID = '<bucket id>'
node distribution/b2/publish-release.mjs .\artifacts
Remove-Item Env:B2_PUBLISH_KEY_ID,Env:B2_PUBLISH_KEY -ErrorAction SilentlyContinue
```

## Create a short-lived authorization grant

Use the exact manifest for the published release:

```powershell
node distribution/b2/grant-release.mjs `
  --manifest .\artifacts\openai-cc-runtime-manifest.json `
  --output "$env:TEMP\openai-cc.grant.json" `
  --ttl-seconds 900
```

The helper writes a private JSON file containing the temporary key ID, temporary key secret, expiry, release prefix, bucket ID, and expected SHA-256 of `bootstrap.ps1`. The secret is intentionally not printed.

Do not commit or upload the grant JSON. Share its values with the intended target through a private channel and revoke the key after installation.

## Fresh install on the target PC

Load the three temporary values from the private grant into the target shell:

```powershell
$env:OPENAI_CC_DIST_KEY_ID = '<temporary applicationKeyId>'
$env:OPENAI_CC_DIST_KEY = '<temporary applicationKey>'
$env:OPENAI_CC_DIST_BOOTSTRAP_SHA256 = '<bootstrapSha256>'
```

Then run this one-line bootstrap:

```powershell
$p="$env:TEMP\openai-cc-bootstrap.ps1";try{$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$env:OPENAI_CC_DIST_KEY_ID`:$env:OPENAI_CC_DIST_KEY"));$a=irm -Headers @{Authorization="Basic $b"} https://api.backblazeb2.com/b2api/v4/b2_authorize_account;$s=$a.apiInfo.storageApi;$k=@($s.allowed.buckets);if($k.Count-ne1){throw 'Invalid distribution grant scope'};$q=((($s.allowed.namePrefix+'bootstrap.ps1')-split '/')|%{[Uri]::EscapeDataString($_)})-join '/';irm -Headers @{Authorization=$a.authorizationToken} "$($s.downloadUrl)/file/$([Uri]::EscapeDataString([string]$k[0].name))/$q" -OutFile $p;if((Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant()-ne $env:OPENAI_CC_DIST_BOOTSTRAP_SHA256.ToLowerInvariant()){throw 'Bootstrap integrity verification failed'};powershell -NoProfile -ExecutionPolicy Bypass -File $p;if($LASTEXITCODE-ne0){throw "Bootstrap failed with exit code $LASTEXITCODE"}}finally{Remove-Item Env:OPENAI_CC_DIST_KEY_ID,Env:OPENAI_CC_DIST_KEY,Env:OPENAI_CC_DIST_BOOTSTRAP_SHA256 -ErrorAction SilentlyContinue;Remove-Item $p -Force -ErrorAction SilentlyContinue}
```

The first line authorizes directly with Backblaze, downloads only `bootstrap.ps1` from the key's server-enforced private bucket/prefix, verifies the bootstrap SHA-256 supplied with the grant, executes it, then removes the temporary credentials from the parent shell.

`bootstrap.ps1` performs stricter checks before it downloads the actual release:

- key capability is exactly `readFiles`;
- exactly one bucket is authorized;
- the prefix matches one source-SHA-scoped OpenAI-CC release;
- key expiry exists, is still in the future, and is no more than one hour away;
- production download URL is HTTPS on a Backblaze domain;
- B2 download SHA-1 headers are checked when present;
- downloaded `install.ps1` SHA-256 equals the Session 6A manifest's `bootstrapSha256`;
- bundle filename is a safe local leaf name.

Before launching the existing Session 6A installer, the bootstrap removes all distribution credentials and its B2 authorization token from process state. The installer then consumes only local files.

## Update

Publish the new source-SHA-scoped release, issue a new short-lived read-only grant for that exact release, and run the same target bootstrap.

The Session 6A update path remains unchanged. Existing `.data` is fingerprinted and must remain unchanged across the runtime swap, including:

- ChatGPT OAuth credentials;
- OpenCode Zen API keys;
- Google AI Studio API keys;
- other built-in provider keys;
- custom-provider API keys;
- custom-provider URLs/configuration;
- model routes and user selections;
- credential preference/status/pins.

## Revoke a grant

Immediately after the install/update succeeds:

```powershell
node distribution/b2/revoke-grant.mjs --key-id '<temporary applicationKeyId>'
```

Backblaze also expires the key automatically at the seconds-level expiry set during creation. Deleting the key is the explicit immediate revocation mechanism.

If a target grant leaks before revocation/expiry, it can download only files whose names begin with that one release prefix in the one authorized private bucket. It cannot read the GitHub source repository or access provider credentials.

## Security contract

**What authorizes a download:** a Backblaze B2 application key created specifically for one install/update.

**Where authorization is validated:** Backblaze validates the key during `b2_authorize_account` and enforces its bucket/prefix/capability restriction on private file downloads. The local bootstrap independently rejects overbroad/expired grants.

**Lifetime:** 15 minutes by default; repository helper allows 60 seconds to one hour.

**Revocation:** delete the application key with `b2_delete_key`; expiry is the automatic fallback.

**Leaked token/key effect:** read-only access to the one exact release prefix until revocation/expiry. It is not a GitHub credential and not an inference credential.

**Encryption:** the runtime bundle is access-controlled, not DRM-encrypted. HTTPS protects transport. A user who can execute the runtime can inspect its compiled files.

**Integrity:** access control is not the integrity mechanism. Session 6A still verifies bundle SHA-256, bundle size, internal per-file hashes/sizes, aggregate content digest, manifest agreement, and source commit = installed build SHA = running `/healthz` SHA. Session 6B additionally verifies bootstrap/installer transport hashes.

**Distribution-side credentials:** publisher key in GitHub Actions; grant issuer key on the trusted administrator PC; short-lived read key on a target only during installation.

**Target-only credentials/config:** all inference/provider state remains exclusively under `%LOCALAPPDATA%\OpenAI-CC\.data`.

**Never permanently stored on targets:** publisher key, issuer key, temporary B2 read key, B2 account authorization token.

## Validation

`.github/workflows/distribution-ci.yml` uses a local private-B2 protocol fixture and proves the repository-side behavior without pretending that a live Backblaze account has been deployed. It tests:

- invalid authorization;
- revoked-key behavior;
- expired authorization;
- rejection of an overbroad key;
- valid gated clean-target install;
- repeat gated update;
- existing `.data` survival;
- custom provider/credential/routing survival;
- distribution credentials not persisted;
- corrupted bundle rejection without replacing the installed runtime;
- no GitHub/raw-source/git-clone dependency in the target bootstrap;
- no provider/user-state files in the distributable runtime.

Before source-repository privacy is changed, the real external deployment must additionally prove against Backblaze itself:

1. valid short-lived key downloads and installs;
2. invalid key rejection;
3. actual seconds-level expiry;
4. actual deletion/revocation;
5. corrupted-object rejection;
6. clean Windows target installation;
7. update of an existing target with `.data` intact;
8. custom-provider state surviving the update;
9. no target/provider secrets in B2 objects;
10. no GitHub source/raw-file/git-clone access during install/update.

## Private source transition

Do **not** make the GitHub source repository private until the live Backblaze distribution path above has been proven and the GitHub Actions hard-free billing guardrail is configured.

After those checks pass, changing the source repository to Private does not change the target flow. The target uses only Backblaze B2 and the short-lived read grant; it never needs Git, a GitHub login, a PAT, or private repository access.
