[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestUrl,
  [string]$InstallRoot,
  [switch]$SkipDesktopConfig,
  [switch]$NoStartupShortcut
)

$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "install.ps1"
if (-not (Test-Path $installer)) { throw "install.ps1 is missing beside setup.ps1." }

Write-Host "setup.ps1 is now a compatibility entrypoint for the Session 6A runtime-bundle installer." -ForegroundColor Yellow
Write-Host "It does not clone the repository and does not require Git, GitHub authentication, or a PAT." -ForegroundColor DarkGray

$args = @("-ManifestUrl", $ManifestUrl)
if ($InstallRoot) { $args += @("-InstallRoot", $InstallRoot) }
if ($SkipDesktopConfig) { $args += "-SkipDesktopConfig" }
if ($NoStartupShortcut) { $args += "-NoStartupShortcut" }

& $installer @args
exit $LASTEXITCODE
