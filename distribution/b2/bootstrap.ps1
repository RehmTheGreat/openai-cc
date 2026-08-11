[CmdletBinding()]
param(
  [string]$InstallRoot,
  [switch]$SkipDesktopConfig,
  [switch]$NoStartupShortcut
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$DefaultAuthorizeUrl = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"

function Get-AuthorizeUrl {
  $candidate = [string]$env:OPENAI_CC_B2_AUTHORIZE_URL
  if (-not $candidate) { return $DefaultAuthorizeUrl }
  $uri = $null
  if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -or -not $uri.IsLoopback -or $uri.Scheme -notin @("http", "https")) {
    throw "OPENAI_CC_B2_AUTHORIZE_URL may only override Backblaze with a loopback HTTP(S) URL for local CI tests."
  }
  return $uri.AbsoluteUri
}

function Get-Sha256([string]$PathValue) {
  return (Get-FileHash -Algorithm SHA256 -Path $PathValue).Hash.ToLowerInvariant()
}

function Get-Sha1([string]$PathValue) {
  return (Get-FileHash -Algorithm SHA1 -Path $PathValue).Hash.ToLowerInvariant()
}

function Escape-Path([string]$Value) {
  return (($Value -split '/') | Where-Object { $_ -ne "" } | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
}

function Assert-ProductionDownloadUrl([string]$Value, [bool]$LocalFixture) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) { throw "Backblaze returned an invalid download URL." }
  if ($LocalFixture) {
    if (-not $uri.IsLoopback -or $uri.Scheme -notin @("http", "https")) { throw "Local B2 fixture returned a non-loopback download URL." }
    return
  }
  if ($uri.Scheme -ne "https" -or $uri.Port -ne 443 -or $uri.Host -notmatch '(^|\.)backblazeb2\.com$') {
    throw "Backblaze returned an unexpected production download host."
  }
}

function Download-B2File([string]$DownloadBase, [string]$BucketName, [string]$FileName, [string]$AuthorizationToken, [string]$Destination) {
  $bucket = [Uri]::EscapeDataString($BucketName)
  $file = Escape-Path $FileName
  $url = "$($DownloadBase.TrimEnd('/'))/file/$bucket/$file"
  $response = Invoke-WebRequest -Uri $url -Headers @{ Authorization = $AuthorizationToken } -OutFile $Destination -UseBasicParsing -TimeoutSec 180 -PassThru
  $declaredSha1 = [string]$response.Headers["X-Bz-Content-Sha1"]
  if ($declaredSha1 -and $declaredSha1 -ne "none") {
    $actualSha1 = Get-Sha1 $Destination
    if ($actualSha1 -ine $declaredSha1) { throw "B2 transport SHA-1 verification failed for $FileName." }
  }
}

$keyId = [string]$env:OPENAI_CC_DIST_KEY_ID
$key = [string]$env:OPENAI_CC_DIST_KEY
if (-not $keyId -or -not $key) {
  throw "OPENAI_CC_DIST_KEY_ID and OPENAI_CC_DIST_KEY are required. Use a short-lived read-only B2 application key."
}

$authorizeUrl = Get-AuthorizeUrl
$authorizeUri = [Uri]$authorizeUrl
$localFixture = $authorizeUri.IsLoopback
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-b2-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$keyId`:$key"))
  $auth = Invoke-RestMethod -Uri $authorizeUrl -Headers @{ Authorization = "Basic $basic" } -Method Get -UseBasicParsing -TimeoutSec 60
  $storage = $auth.apiInfo.storageApi
  if (-not $auth.authorizationToken -or -not $storage -or -not $storage.downloadUrl -or -not $storage.allowed) {
    throw "B2 authorization response is incomplete."
  }

  $capabilities = @($storage.allowed.capabilities)
  if ($capabilities.Count -ne 1 -or [string]$capabilities[0] -ne "readFiles") {
    throw "Distribution key must have exactly readFiles capability."
  }

  $buckets = @($storage.allowed.buckets)
  if ($buckets.Count -ne 1 -or -not [string]$buckets[0].id -or -not [string]$buckets[0].name) {
    throw "Distribution key must be restricted to exactly one named B2 bucket."
  }
  $bucketName = [string]$buckets[0].name

  $releasePrefix = [string]$storage.allowed.namePrefix
  if ($releasePrefix -notmatch '^releases/[0-9A-Za-z._+-]+-[0-9a-fA-F]{40}/$') {
    throw "Distribution key must be restricted to one immutable OpenAI-CC release prefix."
  }

  $expirationRaw = $auth.applicationKeyExpirationTimestamp
  if (-not $expirationRaw) { throw "Distribution key must have an expiration timestamp." }
  $expiration = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$expirationRaw)
  $now = [DateTimeOffset]::UtcNow
  if ($expiration -le $now) { throw "Distribution key is expired." }
  if ($expiration -gt $now.AddSeconds(3660)) { throw "Distribution key lifetime exceeds the one-hour maximum." }

  Assert-ProductionDownloadUrl ([string]$storage.downloadUrl) $localFixture

  $manifestPath = Join-Path $tempRoot "openai-cc-runtime-manifest.json"
  Download-B2File ([string]$storage.downloadUrl) $bucketName ($releasePrefix + "openai-cc-runtime-manifest.json") ([string]$auth.authorizationToken) $manifestPath
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.sourceCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "Downloaded distribution manifest is invalid."
  }

  $expectedPrefixSuffix = ("-" + ([string]$manifest.sourceCommit).ToLowerInvariant() + "/")
  if (-not $releasePrefix.ToLowerInvariant().EndsWith($expectedPrefixSuffix)) {
    throw "Distribution key release prefix does not match the manifest source commit."
  }

  $installerPath = Join-Path $tempRoot "install.ps1"
  Download-B2File ([string]$storage.downloadUrl) $bucketName ($releasePrefix + "install.ps1") ([string]$auth.authorizationToken) $installerPath
  if ([string]$manifest.bootstrapSha256 -notmatch '^[0-9a-fA-F]{64}$' -or (Get-Sha256 $installerPath) -ine [string]$manifest.bootstrapSha256) {
    throw "Downloaded Session 6A installer failed SHA-256 verification."
  }

  $bundleName = [string]$manifest.bundleUrl
  if (-not $bundleName -or [IO.Path]::GetFileName($bundleName) -ne $bundleName -or $bundleName -match '[\\/]') {
    throw "Distribution manifest contains an unsafe bundle filename."
  }
  $bundlePath = Join-Path $tempRoot $bundleName
  Download-B2File ([string]$storage.downloadUrl) $bucketName ($releasePrefix + $bundleName) ([string]$auth.authorizationToken) $bundlePath

  # Distribution credentials are transport-only. The Session 6A installer,
  # gateway, Claude clients, and provider configuration must never inherit them.
  foreach ($name in @("OPENAI_CC_DIST_KEY_ID", "OPENAI_CC_DIST_KEY", "OPENAI_CC_DIST_BOOTSTRAP_SHA256", "OPENAI_CC_B2_AUTHORIZE_URL")) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $keyId = $null
  $key = $null
  $basic = $null
  $auth = $null

  $installerArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installerPath, "-ManifestUrl", $manifestPath)
  if ($InstallRoot) { $installerArgs += @("-InstallRoot", $InstallRoot) }
  if ($SkipDesktopConfig) { $installerArgs += "-SkipDesktopConfig" }
  if ($NoStartupShortcut) { $installerArgs += "-NoStartupShortcut" }

  & powershell.exe @installerArgs
  if ($LASTEXITCODE -ne 0) { throw "Session 6A installer failed with exit code $LASTEXITCODE." }
} finally {
  foreach ($name in @("OPENAI_CC_DIST_KEY_ID", "OPENAI_CC_DIST_KEY", "OPENAI_CC_DIST_BOOTSTRAP_SHA256", "OPENAI_CC_B2_AUTHORIZE_URL")) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $keyId = $null
  $key = $null
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
