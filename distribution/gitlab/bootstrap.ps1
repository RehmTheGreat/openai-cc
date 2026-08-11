[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageBaseUrl,
  [string]$InstallRoot,
  [switch]$SkipDesktopConfig,
  [switch]$NoStartupShortcut
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$token = [string]$env:OPENAI_CC_DIST_TOKEN
if (-not $token) {
  throw "OPENAI_CC_DIST_TOKEN is required. Use a temporary GitLab deploy token with read_package_registry only."
}

$baseUri = $null
if (-not [Uri]::TryCreate($PackageBaseUrl, [UriKind]::Absolute, [ref]$baseUri)) {
  throw "PackageBaseUrl must be an absolute URL."
}
$loopback = @("127.0.0.1", "localhost", "::1") -contains $baseUri.Host
if ($baseUri.Scheme -ne "https" -and -not ($baseUri.Scheme -eq "http" -and $loopback)) {
  throw "PackageBaseUrl must use HTTPS; plain HTTP is allowed only for loopback CI tests."
}
$packageBase = $baseUri.AbsoluteUri.TrimEnd('/')
$headers = @{ "DEPLOY-TOKEN" = $token }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-gitlab-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Assert-SafeLeafName([string]$Name) {
  if (-not $Name -or $Name -ne [IO.Path]::GetFileName($Name) -or $Name -match '[\\/]' -or $Name -in @('.', '..')) {
    throw "Distribution manifest contains an unsafe bundle filename."
  }
}

function Download-PackageFile([string]$Name, [string]$Destination) {
  Assert-SafeLeafName $Name
  $url = "$packageBase/$([Uri]::EscapeDataString($Name))"
  Invoke-WebRequest -Uri $url -Headers $headers -OutFile $Destination -UseBasicParsing -TimeoutSec 180
}

try {
  $installer = Join-Path $tempRoot "install.ps1"
  $manifestPath = Join-Path $tempRoot "openai-cc-runtime-manifest.json"
  Download-PackageFile "install.ps1" $installer
  Download-PackageFile "openai-cc-runtime-manifest.json" $manifestPath

  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $bundleName = [string]$manifest.bundleUrl
  Assert-SafeLeafName $bundleName
  $bundlePath = Join-Path $tempRoot $bundleName
  Download-PackageFile $bundleName $bundlePath

  # The distribution credential is only for transport. Do not let the installer,
  # gateway, Claude, or child processes inherit it.
  Remove-Item Env:OPENAI_CC_DIST_TOKEN -ErrorAction SilentlyContinue
  $token = $null
  $headers = @{}

  $args = @("-ManifestUrl", $manifestPath)
  if ($InstallRoot) { $args += @("-InstallRoot", $InstallRoot) }
  if ($SkipDesktopConfig) { $args += "-SkipDesktopConfig" }
  if ($NoStartupShortcut) { $args += "-NoStartupShortcut" }

  & $installer @args
} finally {
  Remove-Item Env:OPENAI_CC_DIST_TOKEN -ErrorAction SilentlyContinue
  $token = $null
  $headers = @{}
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
