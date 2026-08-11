[CmdletBinding()]
param(
  [string]$OutputDirectory = "artifacts",
  [string]$BundleUrl
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "The Session 6A runtime bundle is Windows-specific and must be built on Windows."
}

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$buildInfoFile = Join-Path $RepoRoot "dist\build-info.json"
$packageFile = Join-Path $RepoRoot "package.json"
$nodeModules = Join-Path $RepoRoot "node_modules"

if (-not (Test-Path $buildInfoFile)) { throw "dist/build-info.json is missing. Run npm run build first." }
if (-not (Test-Path $nodeModules)) { throw "node_modules is missing. Install dependencies before building the runtime bundle." }

$buildInfo = Get-Content $buildInfoFile -Raw | ConvertFrom-Json
$packageJson = Get-Content $packageFile -Raw | ConvertFrom-Json
$appVersion = [string]$packageJson.version
$sourceCommit = [string]$buildInfo.buildSha
$buildTimestamp = [string]$buildInfo.buildTime
if (-not $appVersion) { throw "package.json version is missing." }
if ($sourceCommit -notmatch '^[0-9a-fA-F]{40}$') { throw "A real 40-character source commit SHA is required; got '$sourceCommit'. Set OPENAI_CC_SOURCE_SHA before npm run build." }
try { $fixedTime = [DateTimeOffset]::Parse($buildTimestamp).UtcDateTime } catch { throw "Invalid build timestamp '$buildTimestamp'." }

# The runtime artifact must contain production dependencies only. This catches
# accidental developer bundles before anything is published.
foreach ($property in $packageJson.devDependencies.PSObject.Properties) {
  $relative = $property.Name.Replace('/', [IO.Path]::DirectorySeparatorChar)
  if (Test-Path (Join-Path $nodeModules $relative)) {
    throw "Dev dependency '$($property.Name)' is still installed. Run 'npm prune --omit=dev' before building the runtime bundle."
  }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-bundle-" + [Guid]::NewGuid().ToString("N"))
$stage = Join-Path $tempRoot "runtime"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Copy-RuntimeItem([string]$RelativePath) {
  $source = Join-Path $RepoRoot $RelativePath
  if (-not (Test-Path $source)) { throw "Required runtime item is missing: $RelativePath" }
  $destination = Join-Path $stage $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
  Copy-Item $source $destination -Recurse -Force
}

function Get-Sha256([string]$PathValue) {
  return (Get-FileHash -Algorithm SHA256 -Path $PathValue).Hash.ToLowerInvariant()
}

function Get-ContentDigest([object[]]$Files) {
  $canonical = (($Files | Sort-Object path | ForEach-Object { "$($_.path)|$($_.sha256)|$($_.size)" }) -join "`n") + "`n"
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally { $algorithm.Dispose() }
}

function Write-Utf8NoBom([string]$PathValue, [string]$Text) {
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($PathValue, $Text, $encoding)
}

try {
  # Explicit allowlist: no source tree, tests, Git metadata, .data, developer
  # provider files, API keys, OAuth material, or build-machine model config.
  Copy-RuntimeItem "dist\src"
  Copy-RuntimeItem "dist\build-info.json"
  Copy-RuntimeItem "dist\scripts\configure-clients.js"
  Copy-RuntimeItem "dist\scripts\codex-doctor.js"
  Copy-RuntimeItem "node_modules"
  # package.json is required at runtime because the compiled .js tree relies on
  # its `type: module`; package-lock.json is intentionally not bundled.
  Copy-RuntimeItem "package.json"
  Copy-RuntimeItem "run-gateway.ps1"
  Copy-RuntimeItem "run-claude.ps1"
  Copy-RuntimeItem "uninstall.ps1"

  # Source maps and npm's install-state lock are useful for development/install
  # bookkeeping, not for executing the already-built runtime.
  Get-ChildItem -Path (Join-Path $stage "dist") -File -Filter "*.map" -Recurse -ErrorAction SilentlyContinue |
    Remove-Item -Force
  Remove-Item (Join-Path $stage "node_modules\.package-lock.json") -Force -ErrorAction SilentlyContinue

  foreach ($forbidden in @(".data", ".git", "src", "tests", "setup.ps1", "install.ps1", "package-lock.json")) {
    if (Test-Path (Join-Path $stage $forbidden)) { throw "Forbidden item leaked into runtime bundle: $forbidden" }
  }
  if (Get-ChildItem -Path (Join-Path $stage "dist") -File -Filter "*.map" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1) {
    throw "Source maps leaked into the runtime bundle."
  }

  $files = @(
    Get-ChildItem -Path $stage -File -Recurse -Force |
      ForEach-Object {
        $relative = $_.FullName.Substring($stage.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace([IO.Path]::DirectorySeparatorChar, '/')
        [pscustomobject]@{ path = $relative; sha256 = Get-Sha256 $_.FullName; size = [int64]$_.Length }
      } |
      Sort-Object path
  )
  if ($files.Count -lt 1) { throw "Runtime staging directory is unexpectedly empty." }
  $contentSha256 = Get-ContentDigest $files
  $internalManifest = [ordered]@{
    schemaVersion = 1
    appVersion = $appVersion
    sourceCommit = $sourceCommit.ToLowerInvariant()
    buildTimestamp = ([DateTimeOffset]::Parse($buildTimestamp)).UtcDateTime.ToString("o")
    platform = "win32-x64"
    contentSha256 = $contentSha256
    files = $files
  }
  $internalManifestFile = Join-Path $stage "runtime-manifest.json"
  Write-Utf8NoBom $internalManifestFile (($internalManifest | ConvertTo-Json -Depth 8) + "`n")

  # Normalize staged timestamps so developer-machine file mtimes do not become
  # part of the runtime identity.
  Get-ChildItem -Path $stage -Recurse -Force | ForEach-Object { $_.LastWriteTimeUtc = $fixedTime }
  (Get-Item $stage).LastWriteTimeUtc = $fixedTime

  $shortSha = $sourceCommit.Substring(0, 12).ToLowerInvariant()
  $bundleName = "openai-cc-runtime-$appVersion-$shortSha-win-x64.zip"
  $bundlePath = Join-Path $OutputDirectory $bundleName
  if (Test-Path $bundlePath) { Remove-Item $bundlePath -Force }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $bundlePath, [IO.Compression.CompressionLevel]::Optimal, $false)
  $bundleSha256 = Get-Sha256 $bundlePath
  $bundleSize = [int64](Get-Item $bundlePath).Length

  $bootstrapSource = Join-Path $RepoRoot "install.ps1"
  $bootstrapOutput = Join-Path $OutputDirectory "install.ps1"
  Copy-Item $bootstrapSource $bootstrapOutput -Force
  $bootstrapSha256 = Get-Sha256 $bootstrapOutput

  if (-not $BundleUrl) { $BundleUrl = $bundleName }
  $externalManifest = [ordered]@{
    schemaVersion = 1
    appVersion = $appVersion
    sourceCommit = $sourceCommit.ToLowerInvariant()
    buildTimestamp = ([DateTimeOffset]::Parse($buildTimestamp)).UtcDateTime.ToString("o")
    platform = "win32-x64"
    bundleUrl = $BundleUrl
    bundleSha256 = $bundleSha256
    bundleSize = $bundleSize
    contentSha256 = $contentSha256
    bootstrapSha256 = $bootstrapSha256
  }
  $manifestPath = Join-Path $OutputDirectory "openai-cc-runtime-manifest.json"
  Write-Utf8NoBom $manifestPath (($externalManifest | ConvertTo-Json -Depth 6) + "`n")

  Write-Host "Runtime bundle: $bundlePath" -ForegroundColor Green
  Write-Host "Manifest:       $manifestPath" -ForegroundColor Green
  Write-Host "Source SHA:     $sourceCommit"
  Write-Host "Bundle SHA256:  $bundleSha256"
  Write-Host "Content SHA256: $contentSha256"
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
