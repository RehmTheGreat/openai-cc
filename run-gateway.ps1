[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$NodePath
)

$ErrorActionPreference = "Stop"
$GatewayBaseUrl = "http://127.0.0.1:8082"
$RuntimeRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if (-not $InstallRoot) { $InstallRoot = Split-Path $RuntimeRoot -Parent }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$entrypoint = Join-Path $RuntimeRoot "dist\src\index.js"
$manifestFile = Join-Path $RuntimeRoot "runtime-manifest.json"

if (-not (Test-Path $entrypoint)) { throw "OpenAI-CC runtime entrypoint is missing: $entrypoint" }
if (-not (Test-Path $manifestFile)) { throw "OpenAI-CC runtime manifest is missing: $manifestFile" }

function Get-GatewayHealth {
  try { return Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 2 } catch { return $null }
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Resolve-NodeCommand {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($NodePath) { $candidates.Add($NodePath) }
  $candidates.Add((Join-Path $InstallRoot "tools\node\node.exe"))

  Refresh-ProcessPath
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { $candidates.Add([string]$command.Source) }

  foreach ($root in @($env:ProgramFiles, $env:LOCALAPPDATA)) {
    if ($root) {
      $candidates.Add((Join-Path $root "nodejs\node.exe"))
      $candidates.Add((Join-Path $root "Programs\nodejs\node.exe"))
    }
  }

  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    try {
      $full = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($candidate))
      if (-not (Test-Path $full -PathType Leaf)) { continue }
      $versionText = (& $full --version 2>$null).Trim().TrimStart('v')
      $version = [Version]$versionText
      if ($version -ge [Version]"20.0.0") { return $full }
    } catch { }
  }
  throw "Node.js 20+ could not be resolved from the installer-pinned path, OpenAI-CC portable tools, persisted PATH, or standard install locations."
}

try {
  $listener = Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
} catch { $listener = $null }
if ($listener) {
  $health = Get-GatewayHealth
  $expectedRoot = $InstallRoot.TrimEnd('\')
  $actualRoot = if ($health -and $health.installRoot) { [IO.Path]::GetFullPath([string]$health.installRoot).TrimEnd('\') } else { "" }
  if ($health -and $health.ok -and $actualRoot -ieq $expectedRoot -and [int]$health.pid -eq [int]$listener.OwningProcess) { exit 0 }
  throw "Port 8082 is already occupied by PID $($listener.OwningProcess), and it is not the managed OpenAI-CC runtime at $InstallRoot."
}

$resolvedNode = Resolve-NodeCommand
$env:OPENAI_CC_HOME = $InstallRoot
$env:OPENAI_CC_RUNTIME_ROOT = $RuntimeRoot
$env:DATA_DIR = Join-Path $InstallRoot ".data"
Set-Location $InstallRoot
& $resolvedNode $entrypoint
exit $LASTEXITCODE
