[CmdletBinding()]
param(
  [string]$CredentialFile,
  [string]$OutputPath,
  [ValidateRange(60, 3600)]
  [int]$TtlSeconds = 3600
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$DefaultAuthorizeUrl = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$TemplatePath = Join-Path $PSScriptRoot "client-installer-template.ps1"
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-client-installer-" + [Guid]::NewGuid().ToString("N"))
$Grant = $null
$Created = $false

function Encode-Text([string]$Value) {
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function Get-AuthorizeUrl {
  $candidate = [string]$env:OPENAI_CC_B2_AUTHORIZE_URL
  if (-not $candidate) { return $DefaultAuthorizeUrl }
  $uri = $null
  if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -or -not $uri.IsLoopback -or $uri.Scheme -notin @("http", "https")) {
    throw "OPENAI_CC_B2_AUTHORIZE_URL may only override Backblaze with a loopback HTTP(S) URL for local tests."
  }
  return $uri.AbsoluteUri
}

function Escape-B2Path([string]$Value) {
  return (($Value -split '/') | Where-Object { $_ -ne "" } | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
}

function Assert-DownloadUrl([string]$Value, [bool]$LocalFixture) {
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

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required only on this trusted administrator PC." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required only on this trusted administrator PC." }
if (-not (Test-Path $TemplatePath -PathType Leaf)) { throw "Client installer template is missing: $TemplatePath" }

if (-not $CredentialFile) {
  $CredentialFile = Get-ChildItem ([IO.Path]::GetTempPath()) -Filter "openai-cc-b2-credentials-*.json" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $CredentialFile -or -not (Test-Path $CredentialFile -PathType Leaf)) {
  throw "Could not find the private B2 provisioning JSON. Pass -CredentialFile <path>."
}

$Credentials = Get-Content ([IO.Path]::GetFullPath($CredentialFile)) -Raw | ConvertFrom-Json
$IssuerId = [string]$Credentials.issuer.applicationKeyId
$IssuerKey = [string]$Credentials.issuer.applicationKey
$BucketId = [string]$Credentials.bucketId
if (-not $IssuerId -or -not $IssuerKey -or -not $BucketId) { throw "Credential JSON is missing issuer or bucket values." }

$SourceCommit = (& git -C $RepoRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $SourceCommit -notmatch '^[0-9a-f]{40}$') { throw "Could not determine the exact checked-out source commit." }
$Package = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$AppVersion = [string]$Package.version
if (-not $AppVersion) { throw "package.json does not contain a version." }

if (-not $OutputPath) {
  $Desktop = [Environment]::GetFolderPath("Desktop")
  if (-not $Desktop) { $Desktop = (Get-Location).Path }
  $OutputPath = Join-Path $Desktop ("OpenAI-CC-Client-Installer-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".cmd")
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
$ManifestPath = Join-Path $TempRoot "grant-manifest.json"
$GrantPath = Join-Path $TempRoot "private-grant.json"
$DownloadedBootstrap = Join-Path $TempRoot "bootstrap.ps1"
$ManifestJson = @{ schemaVersion = 1; sourceCommit = $SourceCommit; appVersion = $AppVersion } | ConvertTo-Json
[IO.File]::WriteAllText($ManifestPath, $ManifestJson, [Text.UTF8Encoding]::new($false))

try {
  $authorizeUrl = Get-AuthorizeUrl
  $authorizeUri = [Uri]$authorizeUrl
  $localFixture = $authorizeUri.IsLoopback
  $issuerBasic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$IssuerId`:$IssuerKey"))
  $issuerAuth = Invoke-RestMethod -Uri $authorizeUrl -Headers @{ Authorization = "Basic $issuerBasic" } -Method Get -TimeoutSec 60
  $issuerCaps = @($issuerAuth.apiInfo.storageApi.allowed.capabilities | Sort-Object)
  if ($issuerCaps.Count -ne 2 -or $issuerCaps[0] -ne "deleteKeys" -or $issuerCaps[1] -ne "writeKeys") {
    throw "Issuer capability mismatch. Expected exactly deleteKeys and writeKeys."
  }

  $env:B2_ISSUER_KEY_ID = $IssuerId
  $env:B2_ISSUER_KEY = $IssuerKey
  $env:B2_BUCKET_ID = $BucketId
  Push-Location $RepoRoot
  try {
    node .\distribution\b2\grant-release.mjs --manifest $ManifestPath --output $GrantPath --ttl-seconds $TtlSeconds
    if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary client download grant." }
  } finally {
    Pop-Location
  }

  $Grant = Get-Content $GrantPath -Raw | ConvertFrom-Json
  $Created = $true
  $grantBasic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($Grant.applicationKeyId):$($Grant.applicationKey)"))
  $grantAuth = Invoke-RestMethod -Uri $authorizeUrl -Headers @{ Authorization = "Basic $grantBasic" } -Method Get -TimeoutSec 60
  $storage = $grantAuth.apiInfo.storageApi
  $grantCaps = @($storage.allowed.capabilities)
  $grantBuckets = @($storage.allowed.buckets)
  if ($grantCaps.Count -ne 1 -or [string]$grantCaps[0] -ne "readFiles") { throw "Generated client grant is not readFiles-only." }
  if ($grantBuckets.Count -ne 1 -or [string]$grantBuckets[0].id -ne $BucketId -or -not [string]$grantBuckets[0].name) { throw "Generated client grant has the wrong bucket scope." }
  if ([string]$storage.allowed.namePrefix -ne [string]$Grant.releasePrefix) { throw "Generated client grant has the wrong release prefix." }
  if ([int64]$grantAuth.applicationKeyExpirationTimestamp -ne [int64]$Grant.expirationTimestamp) { throw "Generated client grant expiry mismatch." }
  Assert-DownloadUrl ([string]$storage.downloadUrl) $localFixture

  $bootstrapName = Escape-B2Path ([string]$Grant.releasePrefix + "bootstrap.ps1")
  $bucketName = [Uri]::EscapeDataString([string]$grantBuckets[0].name)
  $bootstrapUrl = "$($storage.downloadUrl.TrimEnd('/'))/file/$bucketName/$bootstrapName"
  Invoke-WebRequest -Uri $bootstrapUrl -Headers @{ Authorization = [string]$grantAuth.authorizationToken } -OutFile $DownloadedBootstrap -UseBasicParsing -TimeoutSec 180
  $downloadedSha = (Get-FileHash $DownloadedBootstrap -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadedSha -ne ([string]$Grant.bootstrapSha256).ToLowerInvariant()) {
    throw "Published bootstrap does not match this checkout. Publish the current main release before creating client installers."
  }

  $clientScript = Get-Content $TemplatePath -Raw
  $replacements = [ordered]@{
    "@@KEY_ID_B64@@" = Encode-Text ([string]$Grant.applicationKeyId)
    "@@KEY_B64@@" = Encode-Text ([string]$Grant.applicationKey)
    "@@BUCKET_ID_B64@@" = Encode-Text $BucketId
    "@@RELEASE_PREFIX_B64@@" = Encode-Text ([string]$Grant.releasePrefix)
    "@@BOOTSTRAP_SHA256@@" = ([string]$Grant.bootstrapSha256).ToLowerInvariant()
    "@@EXPIRATION_TIMESTAMP@@" = [string]$Grant.expirationTimestamp
  }
  foreach ($item in $replacements.GetEnumerator()) { $clientScript = $clientScript.Replace([string]$item.Key, [string]$item.Value) }
  if ($clientScript -match '@@[A-Z0-9_]+@@') { throw "Client installer template still contains unresolved placeholders." }

  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($clientScript))
  $cmdLines = @(
    "@echo off",
    "setlocal",
    "title OpenAI-CC Client Installer",
    "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand",
    'set "OPENAI_CC_INSTALL_EXIT=%ERRORLEVEL%"',
    'echo.',
    'if not "%OPENAI_CC_INSTALL_EXIT%"=="0" (',
    '  echo Installation failed. Send this window output to your OpenAI-CC administrator.',
    ') else (',
    '  echo Installation finished successfully.',
    ')',
    'if not defined OPENAI_CC_CLIENT_NONINTERACTIVE pause',
    'if "%OPENAI_CC_INSTALL_EXIT%"=="0" if not defined OPENAI_CC_CLIENT_KEEP_INSTALLER del /f /q "%~f0" >nul 2>&1',
    'exit /b %OPENAI_CC_INSTALL_EXIT%'
  )
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
  [IO.File]::WriteAllText($OutputPath, (($cmdLines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)

  $expiresLocal = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Grant.expirationTimestamp).ToLocalTime()
  Write-Host ""
  Write-Host "[OK] One-click client installer created." -ForegroundColor Green
  Write-Host "File:    $OutputPath"
  Write-Host "Expires: $($expiresLocal.ToString('yyyy-MM-dd HH:mm:ss zzz'))"
  Write-Host "Send this one file privately and have the client double-click it before expiry."
  Write-Host "It contains only a temporary one-release read grant and deletes itself after a successful install."
} catch {
  if ($Created -and $Grant -and $Grant.applicationKeyId) {
    try {
      Push-Location $RepoRoot
      try { node .\distribution\b2\revoke-grant.mjs --key-id ([string]$Grant.applicationKeyId) | Out-Null } finally { Pop-Location }
    } catch { }
  }
  throw
} finally {
  foreach ($name in @("B2_ISSUER_KEY_ID", "B2_ISSUER_KEY", "B2_BUCKET_ID")) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $IssuerKey = $null
  $issuerBasic = $null
  $issuerAuth = $null
  $grantBasic = $null
  $grantAuth = $null
  $Grant = $null
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
