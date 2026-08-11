[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$RepositoryUrl = "https://github.com/RehmTheGreat/openai-cc.git"
$Target = Join-Path $env:LOCALAPPDATA "OpenAI-CC"
$GatewayBaseUrl = "http://127.0.0.1:8082"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Invoke-Native([string]$Command, [string[]]$Arguments, [string]$Failure) {
  & $Command @Arguments | Out-Host
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "$Failure (exit code $code)." }
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Ensure-Git {
  Refresh-Path
  if (Get-Command git -ErrorAction SilentlyContinue) { return }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw "Git is required. Install Git for Windows or Microsoft App Installer/winget, then rerun." }
  Invoke-Native $winget.Source @("install", "--id", "Git.Git", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent", "--disable-interactivity") "Git installation failed"
  Refresh-Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is still unavailable after installation." }
}

function Get-ProcessInfo([int]$PidValue) {
  try { return Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction Stop } catch { return $null }
}

function Stop-StaleGateways {
  Write-Step "Stop stale gateways"
  $pids = New-Object System.Collections.Generic.HashSet[int]

  try {
    Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { [void]$pids.Add([int]$_.OwningProcess) }
  } catch { }

  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and (
          $_.CommandLine -match '(?i)OpenAI-CC.*dist[\\/]src[\\/](index|index-replicated)\.js' -or
          $_.CommandLine -match '(?i)free-claude-code.*8082' -or
          $_.CommandLine -match '(?i)fcc-server.*8082'
        )
      } |
      ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }
  } catch { }

  if ($pids.Count -eq 0) {
    Write-Host "No existing gateway process detected." -ForegroundColor DarkGray
    return
  }

  foreach ($pidValue in $pids) {
    $info = Get-ProcessInfo $pidValue
    $exe = if ($info -and $info.ExecutablePath) { $info.ExecutablePath } else { "<unknown>" }
    $cmd = if ($info -and $info.CommandLine) { $info.CommandLine } else { "<unavailable>" }
    Write-Host "Stopping PID $pidValue" -ForegroundColor Yellow
    Write-Host "  exe: $exe" -ForegroundColor DarkGray
    Write-Host "  cmd: $cmd" -ForegroundColor DarkGray
    try {
      & taskkill.exe /PID $pidValue /T /F | Out-Host
    } catch {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $listener = Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { break }
  } while ([DateTime]::UtcNow -lt $deadline)

  $remaining = Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($remaining) { throw "Port 8082 is still occupied by PID $($remaining.OwningProcess) after cleanup." }
  Write-Host "Port 8082 is free." -ForegroundColor Green
}

function Backup-TrackedChanges([string]$Repo) {
  $dirty = (& git -C $Repo status --porcelain --untracked-files=no) -join "`n"
  if (-not $dirty) { return }
  $backupRoot = Join-Path $env:LOCALAPPDATA "OpenAI-CC-backups"
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $patch = Join-Path $backupRoot "tracked-$stamp.patch"
  & git -C $Repo diff --binary | Set-Content -Path $patch -Encoding UTF8
  Write-Host "Backed up tracked local changes to $patch" -ForegroundColor Yellow
}

function Sync-CanonicalCheckout {
  Write-Step "Canonical checkout"
  Ensure-Git
  $git = (Get-Command git).Source

  if (-not (Test-Path $Target)) {
    Write-Host "Cloning clean OpenAI-CC main to $Target..."
    Invoke-Native $git @("clone", "--branch", "main", "--single-branch", $RepositoryUrl, $Target) "OpenAI-CC clone failed"
  } elseif (-not (Test-Path (Join-Path $Target ".git"))) {
    $items = @(Get-ChildItem -Force -Path $Target -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) {
      Remove-Item $Target -Force -ErrorAction SilentlyContinue
      Invoke-Native $git @("clone", "--branch", "main", "--single-branch", $RepositoryUrl, $Target) "OpenAI-CC clone failed"
    } else {
      throw "$Target exists but is not a git checkout. Rename/move it first; credentials were not touched."
    }
  } else {
    Backup-TrackedChanges $Target
    Write-Host "Fetching origin/main..."
    Invoke-Native $git @("-C", $Target, "fetch", "--prune", "origin", "main") "git fetch failed"
    Write-Host "Forcing tracked source to origin/main..." -ForegroundColor Yellow
    Invoke-Native $git @("-C", $Target, "reset", "--hard", "origin/main") "git reset failed"
    # Remove only untracked non-ignored files. Ignored .data credentials are not
    # touched; -x is deliberately not used.
    Invoke-Native $git @("-C", $Target, "clean", "-fd", "-e", ".data/") "git clean failed"
  }

  # Dist is ignored, so git reset cannot remove stale compiled modules from old
  # versions. Always rebuild from an empty output directory.
  $dist = Join-Path $Target "dist"
  if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }

  $script:ExpectedSha = (& git -C $Target rev-parse HEAD).Trim()
  $branch = (& git -C $Target branch --show-current).Trim()
  Write-Host "Checkout: $branch $script:ExpectedSha" -ForegroundColor Green
  if ($branch -ne "main") { throw "Canonical checkout is unexpectedly on branch '$branch' instead of main." }
}

function Run-Setup {
  Write-Step "Run OpenAI-CC setup"
  $setup = Join-Path $Target "setup.ps1"
  if (-not (Test-Path $setup)) { throw "Canonical setup.ps1 is missing." }
  $powershell = (Get-Command powershell.exe).Source
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $setup
  if ($LASTEXITCODE -ne 0) { throw "setup.ps1 failed (exit code $LASTEXITCODE)." }
}

function Verify-ExactBuild {
  Write-Step "Verify exact running build"
  $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 5
  Write-Host ("healthz: " + ($health | ConvertTo-Json -Compress))
  if (-not $health.ok) { throw "Gateway health check did not report ok=true." }
  if (-not $health.buildSha) { throw "Running gateway does not expose buildSha; an old runtime is still serving port 8082." }
  if ($health.buildSha -ne $script:ExpectedSha) {
    throw "Running build SHA $($health.buildSha) does not match checkout SHA $script:ExpectedSha. A stale binary/process is still active."
  }
  $expectedRoot = [IO.Path]::GetFullPath($Target).TrimEnd('\')
  $actualRoot = [IO.Path]::GetFullPath([string]$health.installRoot).TrimEnd('\')
  if ($actualRoot -ine $expectedRoot) {
    throw "Running gateway root '$actualRoot' does not match canonical install '$expectedRoot'."
  }
  Write-Host "Exact build verified: $($health.buildSha), PID $($health.pid), $actualRoot" -ForegroundColor Green
}

function Has-ChatGptCredential {
  $accounts = Join-Path $Target ".data\accounts.json"
  if (-not (Test-Path $accounts)) { return $false }
  try {
    $parsed = Get-Content $accounts -Raw | ConvertFrom-Json
    return [bool](@($parsed.accounts | Where-Object { $_.provider -eq "chatgpt" -and $_.status -ne "disabled" }).Count)
  } catch { return $false }
}

function Run-CodexDoctorIfAvailable {
  Write-Step "GPT-5.6 Terra live verification"
  if (-not (Has-ChatGptCredential)) {
    Write-Host "No ChatGPT credential is configured yet; live doctor skipped." -ForegroundColor Yellow
    Write-Host "After adding ChatGPT in the Admin panel, run:" -ForegroundColor Yellow
    Write-Host "  cd `"$Target`"; npm run codex:doctor" -ForegroundColor Yellow
    return
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js is unavailable for the Codex doctor." }
  Push-Location $Target
  try {
    & $node.Source "dist/scripts/codex-doctor.js" --model "gpt-5.6-terra"
    if ($LASTEXITCODE -ne 0) {
      throw "Codex doctor failed. The output above identifies whether model visibility, direct OAuth, FCC translation, or tools failed."
    }
  } finally { Pop-Location }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "This bootstrap installer targets native Windows PowerShell."
}

Write-Host "OpenAI-CC deterministic Windows installer" -ForegroundColor Cyan
Write-Host "This preserves .data credentials, replaces tracked source with origin/main, removes stale dist, and proves the running SHA." -ForegroundColor DarkGray

Stop-StaleGateways
Sync-CanonicalCheckout
Run-Setup
Verify-ExactBuild
Run-CodexDoctorIfAvailable

Write-Host ""
Write-Host "Deterministic installation verified." -ForegroundColor Green
Write-Host "Gateway: $GatewayBaseUrl"
Write-Host "Admin: $GatewayBaseUrl/admin"
Write-Host "Checkout/build SHA: $script:ExpectedSha"
