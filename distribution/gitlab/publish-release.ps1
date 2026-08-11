[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactDirectory,
  [Parameter(Mandatory = $true)]
  [string]$GitLabProjectId,
  [string]$PackageName = "openai-cc-runtime"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($GitLabProjectId -notmatch '^\d+$') {
  throw "GitLabProjectId must be the numeric ID of the private GitLab distribution project."
}
$token = [string]$env:GITLAB_PACKAGE_WRITE_TOKEN
if (-not $token) {
  throw "GITLAB_PACKAGE_WRITE_TOKEN is required. Use a GitLab deploy token scoped only to read_package_registry + write_package_registry for the distribution project."
}

$artifactRoot = [IO.Path]::GetFullPath($ArtifactDirectory)
$manifestPath = Join-Path $artifactRoot "openai-cc-runtime-manifest.json"
$installerPath = Join-Path $artifactRoot "install.ps1"
$bootstrapPath = Join-Path $PSScriptRoot "bootstrap.ps1"
foreach ($required in @($manifestPath, $installerPath, $bootstrapPath)) {
  if (-not (Test-Path $required -PathType Leaf)) { throw "Required distribution file is missing: $required" }
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ([string]$manifest.sourceCommit -notmatch '^[0-9a-fA-F]{40}$') { throw "Manifest sourceCommit is invalid." }
if (-not [string]$manifest.appVersion) { throw "Manifest appVersion is missing." }
$bundleName = [string]$manifest.bundleUrl
if (-not $bundleName -or $bundleName -ne [IO.Path]::GetFileName($bundleName) -or $bundleName -match '[\\/]') {
  throw "Manifest bundleUrl must be a local leaf filename for gated distribution."
}
$bundlePath = Join-Path $artifactRoot $bundleName
if (-not (Test-Path $bundlePath -PathType Leaf)) { throw "Runtime bundle is missing: $bundlePath" }

$shortSha = ([string]$manifest.sourceCommit).Substring(0, 12).ToLowerInvariant()
$versionPart = ([string]$manifest.appVersion) -replace '[^0-9A-Za-z._+-]', '-'
$packageVersion = "$versionPart-$shortSha"
$baseUrl = "https://gitlab.com/api/v4/projects/$GitLabProjectId/packages/generic/$PackageName/$packageVersion"
$headers = @{ "DEPLOY-TOKEN" = $token }

$files = @(
  @{ Name = "bootstrap.ps1"; Path = $bootstrapPath },
  @{ Name = "install.ps1"; Path = $installerPath },
  @{ Name = "openai-cc-runtime-manifest.json"; Path = $manifestPath },
  @{ Name = $bundleName; Path = $bundlePath }
)

foreach ($file in $files) {
  $name = [string]$file.Name
  $path = [string]$file.Path
  $url = "$baseUrl/$([Uri]::EscapeDataString($name))"
  Write-Host "Publishing $name" -ForegroundColor Cyan
  $response = Invoke-WebRequest -Method Put -Uri $url -Headers $headers -InFile $path -ContentType "application/octet-stream" -UseBasicParsing -TimeoutSec 300
  if ([int]$response.StatusCode -notin @(200, 201)) {
    throw "GitLab package upload failed for $name with HTTP $($response.StatusCode)."
  }
}

Write-Host "" 
Write-Host "Published gated runtime package." -ForegroundColor Green
Write-Host "Package version: $packageVersion"
Write-Host "Source commit:   $($manifest.sourceCommit)"
Write-Host "Package base:    $baseUrl"
Write-Host "The write token was not embedded in any artifact or printed."
