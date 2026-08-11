# Gated runtime distribution

Session 6B uses a **private GitLab.com Free project as a Generic Package Registry**. The GitHub source repository and the GitLab distribution project are separate security domains.

```text
private GitHub source repo
  -> GitHub Actions builds exact-commit Windows runtime bundle
  -> private GitLab Generic Package Registry
  -> temporary read-only GitLab deploy token
  -> target-PC bootstrap
  -> local Session 6A installer
  -> %LOCALAPPDATA%\OpenAI-CC\.data remains untouched
```

This architecture intentionally does **not** use Cloudflare R2, S3, Azure Blob, or another service that requires a payment card for storage/egress overages.

## Why GitLab Free

GitLab's Free tier is $0 and does not require a credit card. Generic Packages are available on the Free tier and support private-project downloads authenticated with deploy tokens. GitLab documents that package-registry storage is separate from the 10 GiB Git-repository/LFS project storage limit.

Use a plain Free account/project. Do not enable a paid subscription, on-demand billing, or GitLab-hosted CI runners if your account flow asks for card verification. OpenAI-CC builds continue on the existing GitHub Actions workflow; GitLab is only the private package host/authentication boundary.

Service abuse/rate limits or future GitLab policy changes can still make downloads unavailable. They do not justify adding a payment method. The intended failure mode is **stop/blocked**, never automatic paid overage.

## Distribution project setup

Create one private GitLab project dedicated to binary distribution, for example `openai-cc-distribution`. It should not contain the OpenAI-CC source tree.

Record its numeric project ID. The package endpoint used by this repository is:

```text
https://gitlab.com/api/v4/projects/<PROJECT_ID>/packages/generic/openai-cc-runtime/<PACKAGE_VERSION>/<FILE>
```

If GitLab exposes the Generic Packages duplicate setting for the project, disable duplicate package uploads so a previously published version cannot be silently replaced. The package version produced by `publish-release.ps1` is:

```text
<appVersion>-<first-12-source-SHA>
```

The full 40-character source SHA is also stored in the Session 6A manifest and runtime build metadata.

## Credentials

There are two completely separate distribution credentials.

### CI publisher token

Create a GitLab **project deploy token** for the distribution project with only:

- `read_package_registry`
- `write_package_registry`

Store it only in the GitHub source repository as the Actions secret:

```text
GITLAB_PACKAGE_WRITE_TOKEN
```

Also create this GitHub Actions repository variable:

```text
GITLAB_PROJECT_ID=<numeric GitLab distribution project ID>
```

The publisher token is never included in runtime artifacts or sent to target PCs.

### Target download token

For each install/update, create a different GitLab **project deploy token** with only:

- `read_package_registry`

Prefer a per-install token. GitLab deploy-token expiry is date-based and expires at midnight UTC on the selected date, so it is not an hourly TTL. For the shortest practical authorization, create a token that expires the next day and revoke it immediately after the install succeeds.

The target token cannot publish packages and is unrelated to provider/inference credentials.

## Publish a release

The repository workflow `.github/workflows/publish-distribution.yml` builds from the exact selected source commit, runs the application tests, prunes development dependencies, creates the Session 6A runtime bundle, and uploads exactly four package files:

- `bootstrap.ps1`
- `install.ps1`
- `openai-cc-runtime-manifest.json`
- `openai-cc-runtime-<version>-<sha>-win-x64.zip`

It does not upload `.data`, source files, tests, provider credentials, OAuth state, custom-provider data, or user model configuration.

You can also publish an already-built Session 6A artifact directory from Windows:

```powershell
$env:GITLAB_PACKAGE_WRITE_TOKEN = '<publisher deploy token>'
.\distribution\gitlab\publish-release.ps1 -ArtifactDirectory .\artifacts -GitLabProjectId '<numeric project id>'
```

After publishing, remove the publisher token from the interactive environment.

## Fresh install

The distributor shares two values separately:

```powershell
$env:OPENAI_CC_DIST_TOKEN = '<temporary read_package_registry deploy token>'
$env:OPENAI_CC_DIST_URL = 'https://gitlab.com/api/v4/projects/<PROJECT_ID>/packages/generic/openai-cc-runtime/<PACKAGE_VERSION>'
```

Then the target runs this one-line bootstrap:

```powershell
$p="$env:TEMP\openai-cc-bootstrap.ps1"; irm -Headers @{'DEPLOY-TOKEN'=$env:OPENAI_CC_DIST_TOKEN} "$env:OPENAI_CC_DIST_URL/bootstrap.ps1" -OutFile $p; & $p -PackageBaseUrl $env:OPENAI_CC_DIST_URL
```

`bootstrap.ps1` uses the temporary token only to download `install.ps1`, the manifest, and the referenced ZIP into a temporary directory. Before invoking the Session 6A installer it removes `OPENAI_CC_DIST_TOKEN` from its environment, so the gateway and child processes do not inherit the distribution credential. The Session 6A installer then consumes only local files and does not know that GitLab exists.

The bootstrap accepts plain HTTP only for loopback CI fixtures. Real distribution must use HTTPS.

## Update

Publish the new immutable package version, create/share a new read-only deploy token, set `OPENAI_CC_DIST_URL` to the new package version, and run the same one-line bootstrap.

All Session 6A `.data` preservation rules remain unchanged. Existing ChatGPT OAuth credentials, API keys, custom providers, custom base URLs, model configuration, route pins, credential preference/status, and user-selected routing survive the update.

## Revocation and expiry

A download is authorized only by a valid GitLab deploy token with `read_package_registry` for the private distribution project.

Authorization is validated by GitLab.com at the Generic Package Registry endpoint on every package-file request.

To revoke access, delete/revoke that deploy token in the GitLab project. For per-install grants, revoke immediately after the target completes installation. An expiry date provides a second bound if revocation is forgotten.

If a target token leaks, an attacker can download package files available to that token until it expires or is revoked. A read-only package token does **not** grant:

- GitHub source-repository access;
- GitLab repository read access when it only has `read_package_registry`;
- package publishing rights;
- ChatGPT OAuth credentials;
- provider API keys;
- custom-provider configuration;
- target model routing/preferences.

## Encryption and secrecy

The bundle is access-controlled, not encrypted. This is not DRM. Anyone authorized to download and execute the runtime can inspect its compiled JavaScript, dependencies, scripts, and manifest.

Moving the source repository private reduces casual source exposure but cannot make distributed executable files secret.

## Integrity

Gating is not the integrity mechanism. Session 6A remains authoritative and verifies:

1. external bundle SHA-256;
2. expected bundle size;
3. internal per-file SHA-256 hashes and sizes;
4. aggregate runtime content digest;
5. internal/external manifest agreement;
6. manifest source commit = installed build SHA = running `/healthz` SHA.

A corrupted or substituted ZIP therefore fails even when downloaded with valid authorization.

## Application-state security boundary

The distribution side stores only:

- compiled runtime package files;
- source/build identity and hashes already present in the manifest;
- GitLab deploy tokens used for package authorization.

The following remain exclusively in target `%LOCALAPPDATA%\OpenAI-CC\.data` and must never be published:

- ChatGPT OAuth credentials;
- OpenCode Zen API keys;
- Google AI Studio API keys;
- other built-in provider API keys;
- custom-provider API keys;
- user-specific custom-provider base URLs/configuration;
- model routing/preferences and credential state.

The CI publisher token stays in GitHub Actions secrets. Target read tokens are temporary and are not persisted by OpenAI-CC. Distribution authorization never authorizes inference.

## Validation contract

`.github/workflows/distribution-ci.yml` locally validates the repository-side transport without pretending a live GitLab deployment exists. It covers:

- invalid download authorization rejection;
- valid gated clean-target install;
- token removal before application startup;
- repeat update through the gated bootstrap;
- existing `.data` survival;
- custom-provider/credential/routing fixture survival;
- corrupted gated bundle rejection;
- absence of the distribution token from installed persistent state.

A real GitLab deployment must additionally prove:

- live valid deploy-token download;
- live invalid token rejection;
- expiry after the configured expiry date;
- immediate revocation behavior;
- successful clean Windows install from GitLab only;
- successful existing-state update from GitLab only.

Do not make the GitHub source repository private until those live checks pass.

## Source-repository privacy transition

Once independent GitLab package installation/update has been proven from a clean target PC, change the GitHub source repository visibility to **Private**. The target installation command will continue to use only GitLab package URLs and a temporary package-read token; it never needs Git, a GitHub login, a PAT, or private GitHub repository access.
