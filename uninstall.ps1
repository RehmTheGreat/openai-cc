[CmdletBinding()]
param(
  [switch]$KeepData,
  [switch]$PurgeData,
  [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$GatewayBaseUrl = "http://127.0.0.1:8082"
if ($KeepData -and $PurgeData) { throw "Choose exactly one uninstall mode: -KeepData or -PurgeData." }
if (-not $KeepData -and -not $PurgeData) { throw "Choose an uninstall mode explicitly: -KeepData keeps .data; -PurgeData permanently deletes .data credentials/configuration." }

if (-not $InstallRoot) {
  $runtimeRoot = [IO.Path]::GetFullPath($PSScriptRoot)
  $InstallRoot = Split-Path $runtimeRoot -Parent
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$dataDir = Join-Path $InstallRoot ".data"

function Test-PathInsideManagedRoot([string]$PathValue) {
  $full = [IO.Path]::GetFullPath($PathValue)
  $prefix = $InstallRoot + [IO.Path]::DirectorySeparatorChar
  return $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Remove-ManagedItem([string]$PathValue, [switch]$AllowData) {
  if (-not (Test-Path $PathValue)) { return }
  if (-not (Test-PathInsideManagedRoot $PathValue)) { throw "Refusing to remove path outside managed root: $PathValue" }
  $full = [IO.Path]::GetFullPath($PathValue).TrimEnd('\')
  if (-not $AllowData -and $full -ieq [IO.Path]::GetFullPath($dataDir).TrimEnd('\')) { throw "Refusing to remove .data without -PurgeData." }
  Remove-Item $PathValue -Recurse -Force
}

function Get-ProcessInfo([int]$PidValue) {
  try { return Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction Stop } catch { return $null }
}

function Stop-ManagedRuntime {
  try { $listener = Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { $listener = $null }
  if ($listener) {
    $listenerPid = [int]$listener.OwningProcess
    $health = $null
    try { $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 2 } catch { }
    $info = Get-ProcessInfo $listenerPid
    $managedByHealth = $false
    if ($health -and $health.ok -and $health.installRoot -and [int]$health.pid -eq $listenerPid) {
      try { $managedByHealth = ([IO.Path]::GetFullPath([string]$health.installRoot).TrimEnd('\') -ieq $InstallRoot) } catch { }
    }
    $managedByCommand = [bool]($info -and $info.CommandLine -and $info.CommandLine.IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $info.CommandLine -match '(?i)dist[\\/]src[\\/]index\.js')
    if (-not $managedByHealth -and -not $managedByCommand) {
      throw "Port 8082 is owned by unrelated PID $listenerPid; refusing to terminate it."
    }
    & taskkill.exe /PID $listenerPid /T /F | Out-Null
  }

  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match '(?i)dist[\\/]src[\\/]index\.js' } |
      ForEach-Object { & taskkill.exe /PID ([int]$_.ProcessId) /T /F | Out-Null }
  } catch { }
}

function Remove-StartupShortcut {
  $valueName = "OpenAI-CC Gateway"
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  if (Test-Path $runKey) {
    Remove-ItemProperty -Path $runKey -Name $valueName -Force -ErrorAction SilentlyContinue
    $remaining = Get-ItemProperty -Path $runKey -Name $valueName -ErrorAction SilentlyContinue
    if ($null -ne $remaining) { throw "Failed to remove OpenAI-CC HKCU startup registration." }
  }

  $approvedKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
  if (Test-Path $approvedKey) {
    Remove-ItemProperty -Path $approvedKey -Name $valueName -Force -ErrorAction SilentlyContinue
  }

  try {
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
      $task = Get-ScheduledTask -TaskName $valueName -ErrorAction SilentlyContinue
      if ($task) { Unregister-ScheduledTask -TaskName $valueName -Confirm:$false -ErrorAction Stop }
      if (Get-ScheduledTask -TaskName $valueName -ErrorAction SilentlyContinue) {
        throw "Failed to remove OpenAI-CC scheduled logon task."
      }
    }
  } catch {
    throw "Failed to remove OpenAI-CC Task Scheduler startup registration: $($_.Exception.Message)"
  }

  # Also clean Startup-folder artifacts from older releases.
  $startup = [Environment]::GetFolderPath("Startup")
  if ($startup) {
    $shortcut = Join-Path $startup "OpenAI-CC Gateway.lnk"
    if (Test-Path $shortcut) { Remove-Item $shortcut -Force }
  }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw "This uninstaller targets native Windows PowerShell." }

Stop-ManagedRuntime
Remove-StartupShortcut
Remove-ManagedItem (Join-Path $InstallRoot "current")
Remove-ManagedItem (Join-Path $InstallRoot "install-state.json")
Get-ChildItem -Path $InstallRoot -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '._staging-*' -or $_.Name -like '._rollback-*' } |
  ForEach-Object { Remove-ManagedItem $_.FullName }

if ($PurgeData) {
  Write-Host "Purging OpenAI-CC persistent credentials and configuration (.data)." -ForegroundColor Yellow
  Remove-ManagedItem $dataDir -AllowData
} else {
  Write-Host "Runtime removed. Persistent .data was kept at $dataDir" -ForegroundColor Green
}

try {
  if (Test-Path $InstallRoot) {
    $remaining = @(Get-ChildItem -Path $InstallRoot -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) { Remove-Item $InstallRoot -Force }
  }
} catch { }

Write-Host "OpenAI-CC uninstall complete." -ForegroundColor Green
