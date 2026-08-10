$ErrorActionPreference = "Stop"

if (-not (Test-Path "dist/src/index.js")) { npm run build }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw "Claude Code CLI was not found on PATH. Install Claude Code first."
}

$hostName = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }
$port = if ($env:PORT) { $env:PORT } else { "8082" }
$baseUrl = "http://${hostName}:${port}"

$proxy = Start-Process -FilePath "node" -ArgumentList "dist/src/index.js" -PassThru
Start-Sleep -Milliseconds 800

try {
  Start-Process "${baseUrl}/admin"
  $env:ANTHROPIC_BASE_URL = $baseUrl
  $env:ANTHROPIC_AUTH_TOKEN = "local-not-used"
  & claude
} finally {
  if ($proxy -and -not $proxy.HasExited) { Stop-Process -Id $proxy.Id -Force }
}
