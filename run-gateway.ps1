[CmdletBinding()]
param(
  [string]$InstallRoot
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

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is not on PATH; OpenAI-CC cannot start." }

$env:OPENAI_CC_HOME = $InstallRoot
$env:DATA_DIR = Join-Path $InstallRoot ".data"
Set-Location $InstallRoot
& $node.Source $entrypoint
exit $LASTEXITCODE
