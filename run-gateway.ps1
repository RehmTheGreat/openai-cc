$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Test-OpenAICCProxy {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8082/healthz" -TimeoutSec 2
    return [bool]$health.ok
  } catch {
    return $false
  }
}

if (Test-OpenAICCProxy) { exit 0 }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is not on PATH; OpenAI-CC cannot start." }
& $node.Source "dist/src/index-replicated.js"
