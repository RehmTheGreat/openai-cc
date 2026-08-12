$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$DefaultAuthorizeUrl = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"
$KeyId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@KEY_ID_B64@@"))
$Key = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@KEY_B64@@"))
$BucketId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@BUCKET_ID_B64@@"))
$ReleasePrefix = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@RELEASE_PREFIX_B64@@"))
$BootstrapSha256 = "@@BOOTSTRAP_SHA256@@"
$ExpirationTimestamp = [int64]@@EXPIRATION_TIMESTAMP@@
$ExitCode = 1
$BootstrapPath = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-bootstrap-" + [Guid]::NewGuid().ToString("N") + ".ps1")

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

try {
  $now = [DateTimeOffset]::UtcNow
  $expires = [DateTimeOffset]::FromUnixTimeMilliseconds($ExpirationTimestamp)
  if ($expires -le $now) { throw "This client installer has expired. Ask for a new OpenAI-CC installer." }
  if ($expires -gt $now.AddSeconds(3660)) { throw "Client installer lifetime exceeds the one-hour maximum." }

  Write-Host "Installing OpenAI-CC..." -ForegroundColor Cyan
  $authorizeUrl = Get-AuthorizeUrl
  $authorizeUri = [Uri]$authorizeUrl
  $localFixture = $authorizeUri.IsLoopback
  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$KeyId`:$Key"))
  $auth = Invoke-RestMethod -Uri $authorizeUrl -Headers @{ Authorization = "Basic $basic" } -Method Get -TimeoutSec 60
  $storage = $auth.apiInfo.storageApi
  if (-not $auth.authorizationToken -or -not $storage -or -not $storage.allowed -or -not $storage.downloadUrl) {
    throw "Backblaze authorization response is incomplete."
  }

  $capabilities = @($storage.allowed.capabilities)
  if ($capabilities.Count -ne 1 -or [string]$capabilities[0] -ne "readFiles") {
    throw "Client installer grant must have exactly readFiles capability."
  }
  $buckets = @($storage.allowed.buckets)
  if ($buckets.Count -ne 1 -or [string]$buckets[0].id -ne $BucketId -or -not [string]$buckets[0].name) {
    throw "Client installer grant has the wrong bucket scope."
  }
  if ([string]$storage.allowed.namePrefix -ne $ReleasePrefix) {
    throw "Client installer grant has the wrong release scope."
  }
  if ([int64]$auth.applicationKeyExpirationTimestamp -ne $ExpirationTimestamp) {
    throw "Client installer grant expiry does not match Backblaze."
  }
  Assert-DownloadUrl ([string]$storage.downloadUrl) $localFixture

  $bootstrapName = Escape-B2Path ($ReleasePrefix + "bootstrap.ps1")
  $bucketName = [Uri]::EscapeDataString([string]$buckets[0].name)
  $bootstrapUrl = "$($storage.downloadUrl.TrimEnd('/'))/file/$bucketName/$bootstrapName"
  Invoke-WebRequest -Uri $bootstrapUrl -Headers @{ Authorization = [string]$auth.authorizationToken } -OutFile $BootstrapPath -UseBasicParsing -TimeoutSec 180
  $actualBootstrapSha = (Get-FileHash -Path $BootstrapPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualBootstrapSha -ne $BootstrapSha256.ToLowerInvariant()) { throw "Downloaded bootstrap failed SHA-256 verification." }

  $env:OPENAI_CC_DIST_KEY_ID = $KeyId
  $env:OPENAI_CC_DIST_KEY = $Key
  $env:OPENAI_CC_DIST_BOOTSTRAP_SHA256 = $BootstrapSha256
  $bootstrapArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BootstrapPath)
  if ($env:OPENAI_CC_CLIENT_INSTALL_ROOT) { $bootstrapArgs += @("-InstallRoot", [string]$env:OPENAI_CC_CLIENT_INSTALL_ROOT) }
  if ($env:OPENAI_CC_CLIENT_SKIP_DESKTOP_CONFIG -eq "1") { $bootstrapArgs += "-SkipDesktopConfig" }
  if ($env:OPENAI_CC_CLIENT_NO_STARTUP_SHORTCUT -eq "1") { $bootstrapArgs += "-NoStartupShortcut" }

  $installerOutput = @(& powershell.exe @bootstrapArgs 2>&1)
  $installerExitCode = $LASTEXITCODE
  $installerOutput | Out-Host
  if ($installerExitCode -ne 0) { throw "OpenAI-CC installation failed with exit code $installerExitCode." }

  Write-Host "[OK] OpenAI-CC installed successfully." -ForegroundColor Green
  Write-Host "Admin: http://127.0.0.1:8082/admin" -ForegroundColor Green
  if ($env:OPENAI_CC_CLIENT_NO_OPEN_ADMIN -ne "1") { Start-Process "http://127.0.0.1:8082/admin" }
  $ExitCode = 0
} catch {
  Write-Host ""
  Write-Host "OpenAI-CC installation failed: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode = 1
} finally {
  foreach ($name in @("OPENAI_CC_DIST_KEY_ID", "OPENAI_CC_DIST_KEY", "OPENAI_CC_DIST_BOOTSTRAP_SHA256", "OPENAI_CC_B2_AUTHORIZE_URL")) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $Key = $null
  $basic = $null
  $auth = $null
  Remove-Item $BootstrapPath -Force -ErrorAction SilentlyContinue
}

exit $ExitCode
