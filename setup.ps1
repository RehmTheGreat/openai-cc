$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Test-ClaudeDesktopInstalled {
  $knownPaths = @(
    (Join-Path $env:LOCALAPPDATA "AnthropicClaude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Claude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Claude\Claude.exe")
  )
  if ($knownPaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1) { return $true }

  try {
    $package = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {
      ($_.Name -match "Claude") -and (($_.PublisherDisplayName -match "Anthropic") -or ($_.PackageFamilyName -like "Claude_*"))
    } | Select-Object -First 1
    if ($package) { return $true }
  } catch { }

  $uninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($root in $uninstallRoots) {
    try {
      $entry = Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object {
        ($_.DisplayName -match "^Claude( Desktop)?$") -and (($_.Publisher -match "Anthropic") -or ($_.UninstallString -match "AnthropicClaude"))
      } | Select-Object -First 1
      if ($entry) { return $true }
    } catch { }
  }
  return $false
}

function Test-OpenAICCProxy {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8082/healthz" -TimeoutSec 2
    return [bool]$health.ok
  } catch {
    return $false
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20+ is required. Install Node.js, then run this script again."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required. Install Node.js with npm, then run this script again."
}

$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20+ is required; found $(node --version)." }

$isWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$claudeWasRunning = $false
if ($isWindows) {
  $claudeWasRunning = [bool](Get-Process -Name "Claude" -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (Test-ClaudeDesktopInstalled) {
    Write-Host "Claude Desktop already installed; leaving the installed version untouched." -ForegroundColor DarkGray
  } else {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
      throw "Claude Desktop is missing and winget is unavailable. Install Microsoft App Installer (winget), then rerun setup.ps1."
    }
    Write-Host "Installing Claude Desktop..."
    & winget install --id Anthropic.Claude --exact --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Claude Desktop installation failed with winget exit code $LASTEXITCODE." }
  }
}

npm install
npm run build
node dist/scripts/configure-claude-desktop.js

if (-not (Test-OpenAICCProxy)) {
  Write-Host "Starting openai-cc proxy..."
  $proxy = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("dist/src/index.js") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
  $ready = $false
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-OpenAICCProxy) { $ready = $true; break }
    if ($proxy.HasExited) { break }
  }
  if (-not $ready) { throw "openai-cc did not become healthy at http://127.0.0.1:8082/healthz." }
} else {
  Write-Host "openai-cc proxy already running; leaving it in place." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Claude Desktop third-party gateway: http://127.0.0.1:8082"
Write-Host "Admin panel: http://127.0.0.1:8082/admin"
if ($claudeWasRunning) {
  Write-Host "Claude Desktop was already running. Restart the Claude Desktop app once so it reloads the new 3P gateway profile." -ForegroundColor Yellow
}
Write-Host 'Provider credentials are configured only in the openai-cc admin panel.'
