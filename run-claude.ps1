[CmdletBinding()]
param(
  [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$RuntimeRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if (-not $InstallRoot) { $InstallRoot = Split-Path $RuntimeRoot -Parent }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$GatewayBaseUrl = "http://127.0.0.1:8082"

$claude = Get-Command claude -ErrorAction SilentlyContinue
# Claude Desktop can expose WindowsApps\Claude.exe under the same command name;
# that is not the Claude Code CLI this launcher is meant to execute.
if ($claude -and $claude.Source -like "*\Microsoft\WindowsApps\Claude.exe") { $claude = $null }
if (-not $claude) {
  $native = Join-Path $HOME ".local\bin\claude.exe"
  if (Test-Path $native) { $claude = Get-Item $native }
}
if (-not $claude) { throw "Claude Code CLI was not found. Install Claude Code, then rerun this launcher." }

$gateway = Join-Path $RuntimeRoot "run-gateway.ps1"
Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $gateway, "-InstallRoot", $InstallRoot
) -WindowStyle Hidden | Out-Null

$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 2
    if ($health.ok -and ([IO.Path]::GetFullPath([string]$health.installRoot).TrimEnd('\') -ieq $InstallRoot.TrimEnd('\'))) { $healthy = $true; break }
  } catch { }
}
if (-not $healthy) { throw "OpenAI-CC did not become healthy at $GatewayBaseUrl/healthz." }

Start-Process "$GatewayBaseUrl/admin" | Out-Null
& $claude.FullName
exit $LASTEXITCODE
