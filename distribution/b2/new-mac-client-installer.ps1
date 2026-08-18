[CmdletBinding()]
param(
  [string]$CredentialFile,
  [string]$OutputPath,
  [ValidateRange(300, 172800)]
  [int]$TtlSeconds = 172800
)

$ErrorActionPreference = "Stop"
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-mac-client-" + [Guid]::NewGuid().ToString("N"))
$ManifestPath = Join-Path $TempRoot "grant-manifest.json"
$GrantPath = Join-Path $TempRoot "private-grant.json"
$Grant = $null
$Created = $false

function Encode-Text([string]$Value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value)) }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required on the trusted administrator PC." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required on the trusted administrator PC." }
if (-not $CredentialFile) {
  $CredentialFile = Get-ChildItem ([IO.Path]::GetTempPath()) -Filter "openai-cc-b2-credentials-*.json" -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $CredentialFile -or -not (Test-Path $CredentialFile -PathType Leaf)) { throw "Could not find the private B2 provisioning JSON. Pass -CredentialFile <path>." }

$Credentials = Get-Content ([IO.Path]::GetFullPath($CredentialFile)) -Raw | ConvertFrom-Json
$IssuerId = [string]$Credentials.issuer.applicationKeyId
$IssuerKey = [string]$Credentials.issuer.applicationKey
$BucketId = [string]$Credentials.bucketId
if (-not $IssuerId -or -not $IssuerKey -or -not $BucketId) { throw "Credential JSON is missing issuer or bucket values." }
$SourceCommit = (& git -C $RepoRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $SourceCommit -notmatch '^[0-9a-f]{40}$') { throw "Could not determine the exact checked-out source commit." }
$AppVersion = [string](Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json).version
if (-not $AppVersion) { throw "package.json does not contain a version." }

if (-not $OutputPath) {
  $Desktop = [Environment]::GetFolderPath("Desktop")
  if (-not $Desktop) { $Desktop = (Get-Location).Path }
  $OutputPath = Join-Path $Desktop ("OpenAI-CC-Mac-Client-Installer-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".command")
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
[IO.File]::WriteAllText($ManifestPath, (@{ schemaVersion = 1; sourceCommit = $SourceCommit; appVersion = $AppVersion } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

try {
  $env:B2_ISSUER_KEY_ID = $IssuerId
  $env:B2_ISSUER_KEY = $IssuerKey
  $env:B2_BUCKET_ID = $BucketId
  Push-Location $RepoRoot
  try {
    node .\distribution\b2\grant-release.mjs --manifest $ManifestPath --output $GrantPath --ttl-seconds $TtlSeconds
    if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary client download grant." }
  } finally { Pop-Location }
  $Grant = Get-Content $GrantPath -Raw | ConvertFrom-Json
  $Created = $true

  $ClientScript = @'
#!/bin/bash
set -euo pipefail
NODE_BIN="${OPENAI_CC_NODE:-$(command -v node 2>/dev/null || true)}"
[[ -n "$NODE_BIN" ]] || { echo "Node.js 20+ is required. Install Node.js, then rerun this installer." >&2; exit 1; }
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo "This installer supports Apple Silicon macOS only." >&2; exit 1; }
export OPENAI_CC_MAC_KEY_ID_B64='@@KEY_ID_B64@@'
export OPENAI_CC_MAC_KEY_B64='@@KEY_B64@@'
export OPENAI_CC_MAC_BUCKET_ID_B64='@@BUCKET_ID_B64@@'
export OPENAI_CC_MAC_PREFIX_B64='@@RELEASE_PREFIX_B64@@'
export OPENAI_CC_MAC_EXPIRY='@@EXPIRATION_TIMESTAMP@@'
"$NODE_BIN" <<'NODE'
const { createHash } = require("node:crypto");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const dec=(n)=>Buffer.from(process.env[n],"base64").toString("utf8");
const keyId=dec("OPENAI_CC_MAC_KEY_ID_B64"), key=dec("OPENAI_CC_MAC_KEY_B64"), bucketId=dec("OPENAI_CC_MAC_BUCKET_ID_B64"), prefix=dec("OPENAI_CC_MAC_PREFIX_B64");
const expiry=Number(process.env.OPENAI_CC_MAC_EXPIRY), now=Date.now();
if(!expiry||expiry<=now||expiry>now+172860000) throw new Error("This client installer is expired or has an invalid lifetime.");
const authorizeUrl=process.env.OPENAI_CC_B2_AUTHORIZE_URL||"https://api.backblazeb2.com/b2api/v4/b2_authorize_account";
const authorize=new URL(authorizeUrl), local=["localhost","127.0.0.1","::1"].includes(authorize.hostname)||authorize.hostname.startsWith("127.");
if(authorizeUrl!=="https://api.backblazeb2.com/b2api/v4/b2_authorize_account" && (!local||!["http:","https:"].includes(authorize.protocol))) throw new Error("Invalid B2 authorize URL override.");
const checked=async(r,label)=>{const t=await r.text();if(!r.ok)throw new Error(`${label} failed: ${t||r.status}`);return t;};
const auth=JSON.parse(await checked(await fetch(authorizeUrl,{headers:{Authorization:`Basic ${Buffer.from(`${keyId}:${key}`).toString("base64")}`}}),"B2 authorization"));
const s=auth.apiInfo?.storageApi,a=s?.allowed,c=a?.capabilities||[],b=a?.buckets||[];
if(!auth.authorizationToken||!s?.downloadUrl||!a) throw new Error("Backblaze authorization response is incomplete.");
if(c.length!==1||c[0]!=="readFiles") throw new Error("Client grant must have exactly readFiles capability.");
if(b.length!==1||String(b[0].id)!==bucketId||!b[0].name) throw new Error("Client grant has the wrong bucket scope.");
if(String(a.namePrefix)!==prefix) throw new Error("Client grant has the wrong release scope.");
if(Number(auth.applicationKeyExpirationTimestamp)!==expiry) throw new Error("Client grant expiry mismatch.");
const d=new URL(s.downloadUrl);
if(local){const dl=["localhost","127.0.0.1","::1"].includes(d.hostname)||d.hostname.startsWith("127.");if(!dl||!["http:","https:"].includes(d.protocol))throw new Error("Invalid local download URL.");}
else if(d.protocol!=="https:"||d.port&&d.port!=="443"||!(d.hostname==="backblazeb2.com"||d.hostname.endsWith(".backblazeb2.com"))) throw new Error("Unexpected Backblaze download host.");
const root=join(tmpdir(),`openai-cc-mac-${process.pid}-${Date.now()}`);mkdirSync(root,{recursive:true});
const download=async(name)=>{const path=join(root,name.split("/").at(-1));const url=`${s.downloadUrl.replace(/\/$/,"")}/file/${encodeURIComponent(b[0].name)}/${(prefix+name).split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;const response=await fetch(url,{headers:{Authorization:auth.authorizationToken}});if(!response.ok)throw new Error(`B2 download ${name} failed: HTTP ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());writeFileSync(path,bytes);return path;};
const manifestPath=await download("openai-cc-runtime-manifest-darwin-arm64.json");
const manifest=JSON.parse(readFileSync(manifestPath,"utf8"));
if(manifest.schemaVersion!==1||manifest.platform!=="darwin-arm64")throw new Error("Invalid macOS distribution manifest.");
if(!prefix.toLowerCase().endsWith(`-${String(manifest.sourceCommit).toLowerCase()}/`))throw new Error("Release prefix/source SHA mismatch.");
const leaf=String(manifest.bundleUrl||"");if(!leaf||/[\\/]/.test(leaf))throw new Error("Unsafe bundle filename.");
const install=await download("install.sh"), installer=await download("install-macos.mjs"), bundle=await download(leaf);
const sha=(p)=>createHash("sha256").update(readFileSync(p)).digest("hex");
if(sha(install)!==String(manifest.bootstrapSha256).toLowerCase())throw new Error("install.sh integrity check failed.");
if(sha(installer)!==String(manifest.installerSha256).toLowerCase())throw new Error("install-macos.mjs integrity check failed.");
if(sha(bundle)!==String(manifest.bundleSha256).toLowerCase())throw new Error("Runtime bundle integrity check failed.");
const env={...process.env};for(const n of ["OPENAI_CC_MAC_KEY_ID_B64","OPENAI_CC_MAC_KEY_B64","OPENAI_CC_MAC_BUCKET_ID_B64","OPENAI_CC_MAC_PREFIX_B64","OPENAI_CC_MAC_EXPIRY"])delete env[n];
const args=[install,"--manifest",manifestPath,"--bundle",bundle];
if(process.env.OPENAI_CC_CLIENT_INSTALL_ROOT)args.push("--install-root",process.env.OPENAI_CC_CLIENT_INSTALL_ROOT);
if(process.env.OPENAI_CC_CLIENT_SKIP_DESKTOP_CONFIG==="1")args.push("--skip-desktop-config");
if(process.env.OPENAI_CC_CLIENT_NO_STARTUP_SHORTCUT==="1")args.push("--no-launch-agent");
const child=spawnSync("/bin/bash",args,{stdio:"inherit",env});if(child.status!==0)process.exit(child.status||1);
NODE
unset OPENAI_CC_MAC_KEY_ID_B64 OPENAI_CC_MAC_KEY_B64 OPENAI_CC_MAC_BUCKET_ID_B64 OPENAI_CC_MAC_PREFIX_B64 OPENAI_CC_MAC_EXPIRY
echo "[OK] OpenAI-CC installed successfully. Admin: http://127.0.0.1:8082/admin"
echo "Delete this temporary .command file after installation; its read grant expires automatically."
if [[ "${OPENAI_CC_CLIENT_NO_OPEN_ADMIN:-0}" != "1" ]]; then /usr/bin/open "http://127.0.0.1:8082/admin"; fi
'@
  $Replacements = [ordered]@{
    "@@KEY_ID_B64@@" = Encode-Text ([string]$Grant.applicationKeyId)
    "@@KEY_B64@@" = Encode-Text ([string]$Grant.applicationKey)
    "@@BUCKET_ID_B64@@" = Encode-Text $BucketId
    "@@RELEASE_PREFIX_B64@@" = Encode-Text ([string]$Grant.releasePrefix)
    "@@EXPIRATION_TIMESTAMP@@" = [string]$Grant.expirationTimestamp
  }
  foreach ($Item in $Replacements.GetEnumerator()) { $ClientScript = $ClientScript.Replace([string]$Item.Key, [string]$Item.Value) }
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
  [IO.File]::WriteAllText($OutputPath, $ClientScript, [Text.UTF8Encoding]::new($false))
  $Expires = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Grant.expirationTimestamp).ToLocalTime()
  Write-Host "[OK] Apple Silicon macOS installer created: $OutputPath" -ForegroundColor Green
  Write-Host "Expires: $($Expires.ToString('yyyy-MM-dd HH:mm:ss zzz'))"
  Write-Host "Client runs: bash `"$OutputPath`""
} catch {
  if ($Created -and $Grant -and $Grant.applicationKeyId) {
    try { Push-Location $RepoRoot; try { node .\distribution\b2\revoke-grant.mjs --key-id ([string]$Grant.applicationKeyId) | Out-Null } finally { Pop-Location } } catch { }
  }
  throw
} finally {
  foreach ($Name in @("B2_ISSUER_KEY_ID","B2_ISSUER_KEY","B2_BUCKET_ID")) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
  $IssuerKey = $null
  $Grant = $null
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
