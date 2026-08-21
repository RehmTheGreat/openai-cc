[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestUrl,
  [string]$InstallRoot,
  [switch]$SkipDesktopConfig,
  [switch]$NoStartupShortcut
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$GatewayBaseUrl = "http://127.0.0.1:8082"
$MinimumNodeVersion = [Version]"20.0.0"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "This bootstrap installer targets native Windows PowerShell."
}

if (-not $InstallRoot) {
  $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $InstallRoot = Join-Path $local "OpenAI-CC"
}
$script:ManagedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$script:CurrentRuntime = Join-Path $script:ManagedRoot "current"
$script:DataDir = Join-Path $script:ManagedRoot ".data"
$script:HadCurrentRuntime = Test-Path $script:CurrentRuntime
$script:HadLegacyRuntime =
  (Test-Path (Join-Path $script:ManagedRoot ".git")) -or
  (Test-Path (Join-Path $script:ManagedRoot "src")) -or
  (Test-Path (Join-Path $script:ManagedRoot "package-lock.json"))
$script:FreshModelConfig = -not (Test-Path (Join-Path $script:DataDir "model-config.json"))
$script:RollbackRuntime = $null
$script:SwappedRuntime = $false

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Invoke-Native([string]$Command, [string[]]$Arguments, [string]$Failure) {
  & $Command @Arguments | Out-Host
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "$Failure (exit code $code)." }
}

function Get-Sha256([string]$PathValue) {
  return (Get-FileHash -Algorithm SHA256 -Path $PathValue).Hash.ToLowerInvariant()
}


function Add-UserPathEntry([string]$Entry) {
  if (-not $Entry) { return }
  $current = [string][Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($current -split ';' | Where-Object { $_ })
  if ($parts | Where-Object { $_.TrimEnd('\') -ieq $Entry.TrimEnd('\') }) { return }
  $next = (@($Entry) + $parts) -join ';'
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
}

function Install-PortableNodeLts {
  Write-Host "winget is unavailable/unusable; installing a verified portable Node.js LTS runtime..." -ForegroundColor Yellow
  $baseUrl = "https://nodejs.org/dist/latest-v20.x"
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-node-" + [Guid]::NewGuid().ToString("N"))
  $toolsRoot = Join-Path $script:ManagedRoot "tools"
  $nodeRoot = Join-Path $toolsRoot "node"
  New-Item -ItemType Directory -Force -Path $tempRoot, $toolsRoot | Out-Null
  try {
    $sumsPath = Join-Path $tempRoot "SHASUMS256.txt"
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sumsPath -UseBasicParsing -TimeoutSec 60
    $sums = Get-Content $sumsPath -Raw
    $match = [regex]::Match($sums, '(?mi)^([0-9a-f]{64})\s+(node-v20\.[0-9.]+-win-x64\.zip)$')
    if (-not $match.Success) { throw "Could not resolve the current Node.js 20 x64 archive from SHASUMS256.txt." }
    $expectedSha = $match.Groups[1].Value.ToLowerInvariant()
    $archiveName = $match.Groups[2].Value
    $archivePath = Join-Path $tempRoot $archiveName
    Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archivePath -UseBasicParsing -TimeoutSec 180
    if ((Get-Sha256 $archivePath) -ne $expectedSha) { throw "Portable Node.js download failed SHA-256 verification." }

    $extractRoot = Join-Path $tempRoot "extract"
    Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force
    $sourceDir = Get-ChildItem $extractRoot -Directory | Select-Object -First 1
    if (-not $sourceDir -or -not (Test-Path (Join-Path $sourceDir.FullName "node.exe"))) { throw "Portable Node.js archive layout is invalid." }
    if (Test-Path $nodeRoot) { Remove-Item $nodeRoot -Recurse -Force }
    Move-Item $sourceDir.FullName $nodeRoot
    Add-UserPathEntry $nodeRoot
    $env:Path = "$nodeRoot;$env:Path"
    Write-Host "[OK] Verified portable Node.js installed under OpenAI-CC tools" -ForegroundColor Green
  } finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-ContentDigest([object[]]$Files) {
  $canonical = (($Files | Sort-Object path | ForEach-Object { "$($_.path)|$($_.sha256)|$($_.size)" }) -join "`n") + "`n"
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally { $algorithm.Dispose() }
}

function Write-Utf8NoBom([string]$PathValue, [string]$Text) {
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($PathValue, $Text, $encoding)
}

function Ensure-Node {
  Write-Step "Runtime dependency"
  Refresh-ProcessPath
  $node = Get-Command node -ErrorAction SilentlyContinue
  $needsInstall = $false
  if (-not $node) {
    $needsInstall = $true
  } else {
    try { $version = [Version]((& $node.Source --version).Trim().TrimStart('v')) } catch { $needsInstall = $true }
    if (-not $needsInstall -and $version -lt $MinimumNodeVersion) { $needsInstall = $true }
  }

  if ($needsInstall) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      $verb = if ($node) { "upgrade" } else { "install" }
      try {
        Invoke-Native $winget.Source @($verb, "--id", "OpenJS.NodeJS.LTS", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent", "--disable-interactivity") "Node.js LTS $verb failed"
      } catch {
        Write-Warning "winget could not prepare Node.js: $($_.Exception.Message)"
      }
      Refresh-ProcessPath
      $node = Get-Command node -ErrorAction SilentlyContinue
      if ($node) {
        try {
          $candidateVersion = [Version]((& $node.Source --version).Trim().TrimStart('v'))
          if ($candidateVersion -lt $MinimumNodeVersion) { $node = $null }
        } catch { $node = $null }
      }
    }
    if (-not $node) {
      Install-PortableNodeLts
      Refresh-ProcessPath
      $node = Get-Command node -ErrorAction SilentlyContinue
    }
  }

  if (-not $node) { throw "Node.js is unavailable after both winget and portable fallback setup." }
  $version = [Version]((& $node.Source --version).Trim().TrimStart('v'))
  if ($version -lt $MinimumNodeVersion) { throw "Node.js $MinimumNodeVersion or newer is required; found $version." }
  $script:NodeCommand = $node.Source
  Write-Host "[OK] Node.js $version" -ForegroundColor Green
  if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "Git is present but is not used by this installer." -ForegroundColor DarkGray }
}

function Read-DistributionManifest([string]$Location) {
  if (Test-Path $Location) {
    $script:ManifestIsLocal = $true
    $script:ManifestBase = Split-Path ([IO.Path]::GetFullPath($Location)) -Parent
    return Get-Content ([IO.Path]::GetFullPath($Location)) -Raw | ConvertFrom-Json
  }
  $uri = $null
  if (-not [Uri]::TryCreate($Location, [UriKind]::Absolute, [ref]$uri) -or @("http", "https") -notcontains $uri.Scheme) {
    throw "ManifestUrl must be an existing local file or an absolute HTTP(S) URL."
  }
  $script:ManifestIsLocal = $false
  $script:ManifestBase = $uri
  $response = Invoke-WebRequest -Uri $uri.AbsoluteUri -UseBasicParsing -TimeoutSec 60
  return $response.Content | ConvertFrom-Json
}

function Resolve-BundleLocation([object]$Manifest) {
  $value = [string]$Manifest.bundleUrl
  if (-not $value) { throw "Distribution manifest is missing bundleUrl." }
  if ($script:ManifestIsLocal) {
    if ([IO.Path]::IsPathRooted($value)) { return [IO.Path]::GetFullPath($value) }
    return [IO.Path]::GetFullPath((Join-Path $script:ManifestBase $value))
  }
  $absolute = $null
  if ([Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$absolute)) { return $absolute.AbsoluteUri }
  return ([Uri]::new($script:ManifestBase, $value)).AbsoluteUri
}

function Copy-OrDownload([string]$Location, [string]$Destination) {
  if (Test-Path $Location) { Copy-Item ([IO.Path]::GetFullPath($Location)) $Destination -Force; return }
  Invoke-WebRequest -Uri $Location -OutFile $Destination -UseBasicParsing -TimeoutSec 180
}

function Assert-DistributionManifest([object]$Manifest) {
  if ([int]$Manifest.schemaVersion -ne 1) { throw "Unsupported distribution manifest schemaVersion: $($Manifest.schemaVersion)" }
  if ([string]$Manifest.platform -ne "win32-x64") { throw "This installer requires a win32-x64 runtime bundle; manifest has '$($Manifest.platform)'." }
  if ([string]$Manifest.sourceCommit -notmatch '^[0-9a-fA-F]{40}$') { throw "Manifest sourceCommit is invalid." }
  if ([string]$Manifest.bundleSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Manifest bundleSha256 is invalid." }
  if ([string]$Manifest.contentSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Manifest contentSha256 is invalid." }
  if (-not [string]$Manifest.appVersion) { throw "Manifest appVersion is missing." }
}

function Assert-ManagedChild([string]$PathValue) {
  $full = [IO.Path]::GetFullPath($PathValue)
  $prefix = $script:ManagedRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify path outside managed root: $full"
  }
  if ($full.TrimEnd('\') -ieq [IO.Path]::GetFullPath($script:DataDir).TrimEnd('\')) {
    throw "Installer refuses to delete or replace .data. Use uninstall.ps1 -PurgeData only for explicit credential deletion."
  }
}

function Remove-ManagedItem([string]$PathValue) {
  if (-not (Test-Path $PathValue)) { return }
  Assert-ManagedChild $PathValue
  Remove-Item $PathValue -Recurse -Force
}

function Get-DataFingerprint {
  if (-not (Test-Path $script:DataDir)) { return $null }
  $files = @(
    Get-ChildItem -Path $script:DataDir -File -Recurse -Force |
      ForEach-Object {
        $relative = $_.FullName.Substring($script:DataDir.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace([IO.Path]::DirectorySeparatorChar, '/')
        # The raw OAuth session is runtime-mutable: the transport may rotate
        # access/refresh tokens as soon as a waiting Claude request reconnects.
        # Keep its managed path in the inventory, but fingerprint every other
        # persistent byte so routes, providers, account records, API keys, and
        # unrelated state remain strictly protected during activation.
        if ($relative -match '(?i)^(?:codex-homes|accounts)/[^/]+/auth\.json$') {
          [pscustomobject]@{ path = $relative; sha256 = "managed-oauth-session"; size = [int64]0 }
        } else {
          [pscustomobject]@{ path = $relative; sha256 = Get-Sha256 $_.FullName; size = [int64]$_.Length }
        }
      } |
      Sort-Object path
  )
  return [pscustomobject]@{ count = $files.Count; digest = Get-ContentDigest $files }
}

function Migrate-PersistentData([string]$Stage) {
  if (-not (Test-Path $script:DataDir)) { return }
  $migration = Join-Path $Stage "dist\scripts\migrate-data.js"
  if (-not (Test-Path $migration -PathType Leaf)) { throw "Runtime bundle is missing the persistent-data migration helper." }
  Write-Step "Prepare persistent data"
  Invoke-Native $script:NodeCommand @($migration, $script:DataDir) "Persistent .data migration failed"
  Write-Host "[OK] Compatible .data migrations completed; credentials and configuration remain target-local" -ForegroundColor Green
}

function Verify-ExtractedRuntime([string]$Stage, [object]$Distribution) {
  $internalFile = Join-Path $Stage "runtime-manifest.json"
  if (-not (Test-Path $internalFile)) { throw "Bundle is missing runtime-manifest.json." }
  $internal = Get-Content $internalFile -Raw | ConvertFrom-Json
  if ([int]$internal.schemaVersion -ne 1) { throw "Unsupported internal runtime manifest schema." }
  if ([string]$internal.sourceCommit -ine [string]$Distribution.sourceCommit) { throw "Internal source SHA does not match distribution manifest." }
  if ([string]$internal.appVersion -ne [string]$Distribution.appVersion) { throw "Internal application version does not match distribution manifest." }
  if ([string]$internal.contentSha256 -ine [string]$Distribution.contentSha256) { throw "Internal content digest does not match distribution manifest." }

  $declared = @($internal.files)
  if ($declared.Count -lt 1) { throw "Internal runtime manifest has no files." }
  foreach ($entry in $declared) {
    $relative = [string]$entry.path
    if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') { throw "Unsafe runtime manifest path: $relative" }
    $candidate = [IO.Path]::GetFullPath((Join-Path $Stage ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
    $prefix = [IO.Path]::GetFullPath($Stage).TrimEnd('\') + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Runtime file escapes staging root: $relative" }
    if (-not (Test-Path $candidate -PathType Leaf)) { throw "Runtime file listed in manifest is missing: $relative" }
    if ([int64](Get-Item $candidate).Length -ne [int64]$entry.size) { throw "Runtime file size mismatch: $relative" }
    if ((Get-Sha256 $candidate) -ine [string]$entry.sha256) { throw "Runtime file hash mismatch: $relative" }
  }

  $actualFiles = @(Get-ChildItem -Path $Stage -File -Recurse -Force | Where-Object { $_.FullName -ne $internalFile })
  if ($actualFiles.Count -ne $declared.Count) { throw "Runtime bundle contains undeclared or missing files." }
  if ((Get-ContentDigest $declared) -ine [string]$Distribution.contentSha256) { throw "Runtime content digest verification failed." }

  $buildInfoFile = Join-Path $Stage "dist\build-info.json"
  if (-not (Test-Path $buildInfoFile)) { throw "Runtime build-info.json is missing." }
  $build = Get-Content $buildInfoFile -Raw | ConvertFrom-Json
  if ([string]$build.buildSha -ine [string]$Distribution.sourceCommit) { throw "Installed build SHA would not match expected source SHA." }
  if ([string]$build.appVersion -ne [string]$Distribution.appVersion) { throw "Installed build version would not match expected application version." }

  foreach ($required in @("dist\src\index.js", "dist\scripts\configure-clients.js", "dist\scripts\codex-doctor.js", "node_modules", "run-gateway.ps1", "run-claude.ps1", "uninstall.ps1")) {
    if (-not (Test-Path (Join-Path $Stage $required))) { throw "Runtime bundle is missing required item: $required" }
  }
  foreach ($forbidden in @(".data", ".git", "src", "tests", "setup.ps1", "install.ps1")) {
    if (Test-Path (Join-Path $Stage $forbidden)) { throw "Runtime bundle contains forbidden item: $forbidden" }
  }
  return $internal
}

function Get-ProcessInfo([int]$PidValue) {
  try { return Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction Stop } catch { return $null }
}

function Get-PortListener {
  try { return Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { return $null }
}

function Test-LegacyFccProcess([object]$Info) {
  if (-not $Info -or -not $Info.CommandLine) { return $false }
  return [bool]($Info.CommandLine -match '(?i)(?:free-claude-code|fcc-server|[\\/]\.local[\\/]bin[\\/]fcc(?:-server)?(?:\.exe)?\b)')
}

function Remove-LegacyFccStartupArtifacts {
  # Migration is intentionally file/registration based. Never execute the old
  # uv/free-claude-code binaries: App Control may block them, and cleanup must
  # never prevent the new OpenAI-CC runtime from installing.
  $startup = [Environment]::GetFolderPath("Startup")
  if ($startup) {
    foreach ($name in @("FCC Server.lnk", "Free Claude Code.lnk")) {
      $path = Join-Path $startup $name
      if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
  }

  $programs = [Environment]::GetFolderPath("Programs")
  if ($programs) {
    foreach ($name in @("FCC Server.lnk", "Free Claude Code.lnk")) {
      $path = Join-Path $programs $name
      if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
  }

  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  if (Test-Path $runKey) {
    foreach ($name in @("FCC Server", "Free Claude Code")) {
      Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
    }
  }
  Write-Host "[OK] Legacy FCC startup entries neutralized without running old executables" -ForegroundColor Green
}

function Stop-ManagedRuntime {
  Write-Step "Stop managed runtime"
  $listener = Get-PortListener
  if ($listener) {
    $pidValue = [int]$listener.OwningProcess
    $info = Get-ProcessInfo $pidValue
    $health = $null
    try { $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 2 } catch { }
    $managedByHealth = $false
    if ($health -and $health.ok -and $health.installRoot -and [int]$health.pid -eq $pidValue) {
      try { $managedByHealth = ([IO.Path]::GetFullPath([string]$health.installRoot).TrimEnd('\') -ieq $script:ManagedRoot) } catch { }
    }
    $managedByCommand = [bool]($info -and $info.CommandLine -and $info.CommandLine.IndexOf($script:ManagedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $info.CommandLine -match '(?i)dist[\\/]src[\\/]index\.js')
    $legacyFcc = Test-LegacyFccProcess $info
    if (-not $managedByHealth -and -not $managedByCommand -and -not $legacyFcc) {
      throw "Port 8082 is occupied by unrelated PID $pidValue. Refusing to terminate it."
    }
    if ($legacyFcc) {
      Write-Host "Stopping legacy FCC PID $pidValue so OpenAI-CC can take over port 8082" -ForegroundColor Yellow
    } else {
      Write-Host "Stopping managed OpenAI-CC PID $pidValue" -ForegroundColor Yellow
    }
    & taskkill.exe /PID $pidValue /T /F | Out-Null
  }

  # Also terminate stale managed process trees that no longer own the port.
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($script:ManagedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match '(?i)dist[\\/]src[\\/]index\.js' } |
      ForEach-Object { & taskkill.exe /PID ([int]$_.ProcessId) /T /F | Out-Null }
  } catch { }

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if (-not (Get-PortListener)) { Write-Host "[OK] Port 8082 is free" -ForegroundColor Green; return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  $remaining = Get-PortListener
  throw "Port 8082 is still occupied by PID $($remaining.OwningProcess) after stopping the managed runtime."
}

function Test-ClaudeDesktopInstalled {
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA "AnthropicClaude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Claude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Claude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\Claude.exe")
  )) { if ($candidate -and (Test-Path $candidate)) { return $true } }
  try {
    return [bool](Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "Claude" -or $_.PackageFamilyName -like "Claude_*" } | Select-Object -First 1)
  } catch { return $false }
}

function Test-ClaudeCodeInstalled {
  $native = Join-Path $HOME ".local\bin\claude.exe"
  if (Test-Path $native) { return $true }
  $command = Get-Command claude -ErrorAction SilentlyContinue
  return [bool]($command -and $command.Source -notlike "*\Microsoft\WindowsApps\Claude.exe")
}

function Configure-Clients {
  Write-Step "Configure clients"
  $env:OPENAI_CC_HOME = $script:ManagedRoot
  $env:OPENAI_CC_RUNTIME_ROOT = $script:CurrentRuntime
  $env:DATA_DIR = $script:DataDir
  $env:ANTHROPIC_BASE_URL = $GatewayBaseUrl
  $desktop = (-not $SkipDesktopConfig) -and (Test-ClaudeDesktopInstalled)
  $env:OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP = if ($desktop) { "1" } else { "0" }
  Push-Location $script:ManagedRoot
  try {
    Invoke-Native $script:NodeCommand @((Join-Path $script:CurrentRuntime "dist\scripts\configure-clients.js")) "Client configuration failed"
  } finally { Pop-Location }
  if (Test-ClaudeCodeInstalled) { Write-Host "[OK] Existing Claude Code configuration refreshed without replacing unrelated settings" -ForegroundColor Green }
  else { Write-Host "Claude Code is not installed; gateway settings were prepared for a future install." -ForegroundColor Yellow }
  if ($desktop) { Write-Host "[OK] Existing Claude Desktop integration refreshed" -ForegroundColor Green }
}

function Start-ManagedRuntime {
  Write-Step "Start runtime"
  $launcher = Join-Path $script:CurrentRuntime "run-gateway.ps1"
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $launcher, "-InstallRoot", $script:ManagedRoot
  ) -WindowStyle Hidden | Out-Null

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 2
      if ($health.ok) { return }
    } catch { }
  }
  throw "Gateway startup failure: OpenAI-CC did not become healthy at $GatewayBaseUrl/healthz."
}

function Remove-OpenAiCcStartupRegistrations {
  $valueName = "OpenAI-CC Gateway"
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  if (Test-Path $runKey) {
    Remove-ItemProperty -Path $runKey -Name $valueName -Force -ErrorAction SilentlyContinue
  }

  # Task Manager/Settings can leave a Run value present but silently disabled
  # through StartupApproved. Remove our stale approval state when disabling or
  # before writing a fresh enabled state.
  $approvedKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
  if (Test-Path $approvedKey) {
    Remove-ItemProperty -Path $approvedKey -Name $valueName -Force -ErrorAction SilentlyContinue
  }

  try {
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
      $task = Get-ScheduledTask -TaskName $valueName -ErrorAction SilentlyContinue
      if ($task) { Unregister-ScheduledTask -TaskName $valueName -Confirm:$false -ErrorAction Stop }
    }
  } catch {
    Write-Warning "Could not remove an older OpenAI-CC scheduled task: $($_.Exception.Message)"
  }

  $startup = [Environment]::GetFolderPath("Startup")
  if ($startup) {
    $shortcutPath = Join-Path $startup "OpenAI-CC Gateway.lnk"
    if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue }
  }
}

function Set-StartupApprovedEnabled([string]$ValueName) {
  $approvedKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
  New-Item -Path $approvedKey -Force | Out-Null
  $enabled = [byte[]](0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
  New-ItemProperty -Path $approvedKey -Name $ValueName -Value $enabled -PropertyType Binary -Force | Out-Null
  $saved = [byte[]](Get-ItemPropertyValue -Path $approvedKey -Name $ValueName -ErrorAction Stop)
  if ($saved.Length -lt 1 -or $saved[0] -ne 0x02) {
    throw "Windows StartupApproved state did not remain enabled for $ValueName."
  }
}

function Register-LogonTaskBestEffort([string]$PowerShellPath, [string]$Arguments) {
  $taskName = "OpenAI-CC Gateway"
  try {
    Import-Module ScheduledTasks -ErrorAction Stop
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if (-not $userId) { throw "Could not resolve the current Windows user for the logon task." }

    $action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $Arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    try { $trigger.Delay = "PT15S" } catch { }
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ([string]$task.State -eq "Disabled") {
      Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
      $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    $actions = @($task.Actions)
    $actualExecute = if ($actions.Count -eq 1) { [Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute) } else { "" }
    try { $actualExecute = [IO.Path]::GetFullPath($actualExecute) } catch { }
    $expectedExecute = [IO.Path]::GetFullPath($PowerShellPath)
    if ($actions.Count -ne 1 -or $actualExecute -ine $expectedExecute -or [string]$actions[0].Arguments -ne $Arguments) {
      throw "Scheduled task action does not match the installed OpenAI-CC launcher."
    }
    if ([string]$task.State -eq "Disabled") { throw "Scheduled task remained disabled after registration." }
    Write-Host "[OK] Delayed per-user logon task registered as an independent startup fallback" -ForegroundColor Green
    return $true
  } catch {
    Write-Warning "Task Scheduler fallback could not be registered; the enabled HKCU Run path remains active: $($_.Exception.Message)"
    return $false
  }
}

function Install-StartupShortcut {
  Remove-LegacyFccStartupArtifacts
  if ($NoStartupShortcut) {
    Remove-OpenAiCcStartupRegistrations
    Write-Host "[OK] OpenAI-CC automatic startup disabled by installer option" -ForegroundColor Green
    return
  }

  $valueName = "OpenAI-CC Gateway"
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path $powerShellPath -PathType Leaf)) {
    $powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
  }
  $launcher = Join-Path $script:CurrentRuntime "run-gateway.ps1"
  if (-not (Test-Path $launcher -PathType Leaf)) { throw "OpenAI-CC startup launcher is missing: $launcher" }
  # Use PowerShell directly. The previous WScript/VBS hop could exist on disk yet
  # still be blocked by Windows Script Host policy or application control. The
  # launcher infers InstallRoot from its own current\ directory, which keeps the
  # Windows Run command short and avoids repeating long user/profile paths.
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
  $command = "`"$powerShellPath`" $arguments"
  if ($command.Length -gt 260) {
    throw "OpenAI-CC startup command exceeds the Windows Run-key command-line limit. Choose a shorter install path."
  }

  New-Item -Path $runKey -Force | Out-Null
  New-ItemProperty -Path $runKey -Name $valueName -Value $command -PropertyType String -Force | Out-Null
  Set-StartupApprovedEnabled $valueName

  $saved = [string](Get-ItemPropertyValue -Path $runKey -Name $valueName -ErrorAction Stop)
  if ($saved -ne $command) { throw "OpenAI-CC HKCU Run registration could not be verified after writing it." }
  Write-Host "[OK] Per-user HKCU Run startup registered, explicitly enabled, and verified" -ForegroundColor Green

  # Register a second, delayed one-shot-at-logon path. This is not a watchdog:
  # if the Run entry already started the gateway, run-gateway.ps1 exits cleanly
  # after recognizing the healthy managed listener. If Task Scheduler is blocked
  # by local policy, the verified Run entry remains the primary mechanism.
  Register-LogonTaskBestEffort $powerShellPath $arguments | Out-Null

  # Remove the obsolete Startup-folder shortcut so there is no third shell-level
  # startup entry and no dependency on the old VBS launcher.
  $startup = [Environment]::GetFolderPath("Startup")
  if ($startup) {
    $shortcutPath = Join-Path $startup "OpenAI-CC Gateway.lnk"
    if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue }
  }
}

function Verify-Installation([object]$Distribution, [object]$InternalManifest, [object]$PreDataFingerprint) {
  Write-Step "Deterministic verification"
  $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 5
  $listener = Get-PortListener
  if (-not $listener) { throw "Verification failed: no listener on port 8082." }
  if (-not $health.ok) { throw "Verification failed: healthz did not report ok=true." }
  if ([int]$health.pid -ne [int]$listener.OwningProcess) { throw "Verification failed: health PID does not own port 8082." }
  if ([IO.Path]::GetFullPath([string]$health.installRoot).TrimEnd('\') -ine $script:ManagedRoot) { throw "Verification failed: health installRoot does not match managed root." }
  if ([IO.Path]::GetFullPath([string]$health.runtimeRoot).TrimEnd('\') -ine [IO.Path]::GetFullPath($script:CurrentRuntime).TrimEnd('\')) { throw "Verification failed: health runtimeRoot is not the active current runtime." }

  $processInfo = Get-ProcessInfo ([int]$health.pid)
  $entrypoint = Join-Path $script:CurrentRuntime "dist\src\index.js"
  if (-not $processInfo -or -not $processInfo.CommandLine -or $processInfo.CommandLine.IndexOf($entrypoint, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Verification failed: PID $($health.pid) is not running the expected OpenAI-CC entrypoint."
  }

  $installedBuild = Get-Content (Join-Path $script:CurrentRuntime "dist\build-info.json") -Raw | ConvertFrom-Json
  $expectedSha = ([string]$Distribution.sourceCommit).ToLowerInvariant()
  if (([string]$InternalManifest.sourceCommit).ToLowerInvariant() -ne $expectedSha) { throw "Verification failed: internal source SHA mismatch." }
  if (([string]$installedBuild.buildSha).ToLowerInvariant() -ne $expectedSha) { throw "Verification failed: installed build SHA mismatch." }
  if (([string]$health.buildSha).ToLowerInvariant() -ne $expectedSha) { throw "Verification failed: running /healthz build SHA mismatch." }
  if ([string]$health.appVersion -ne [string]$Distribution.appVersion) { throw "Verification failed: running application version mismatch." }

  $admin = Invoke-WebRequest -Uri "$GatewayBaseUrl/admin" -UseBasicParsing -TimeoutSec 5
  if ([int]$admin.StatusCode -ne 200) { throw "Verification failed: Admin endpoint did not return HTTP 200." }
  $state = Invoke-RestMethod -Uri "$GatewayBaseUrl/admin/state" -TimeoutSec 5
  $models = Invoke-RestMethod -Uri "$GatewayBaseUrl/v1/models" -TimeoutSec 5
  if (@($models.data).Count -ne 4) { throw "Verification failed: gateway did not expose exactly four Claude Desktop-facing routes." }

  $settingsFile = Join-Path $HOME ".claude\settings.json"
  if (-not (Test-Path $settingsFile)) { throw "Verification failed: Claude settings file is missing." }
  $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
  if (-not $settings.env) { throw "Verification failed: Claude settings env is missing." }
  if ([string]$settings.env.ANTHROPIC_BASE_URL -ne $GatewayBaseUrl) { throw "Verification failed: Claude ANTHROPIC_BASE_URL is inconsistent." }

  $envKeys = [ordered]@{
    default = "ANTHROPIC_MODEL"
    fable = "ANTHROPIC_DEFAULT_FABLE_MODEL"
    opus = "ANTHROPIC_DEFAULT_OPUS_MODEL"
    sonnet = "ANTHROPIC_DEFAULT_SONNET_MODEL"
    haiku = "ANTHROPIC_DEFAULT_HAIKU_MODEL"
  }
  foreach ($slot in $envKeys.Keys) {
    $title = $slot.Substring(0, 1).ToUpperInvariant() + $slot.Substring(1)
    $route = $state.modelConfig.routes.PSObject.Properties[$slot].Value
    $routeHealth = $state.routeHealth.PSObject.Properties[$slot].Value
    if ($slot -ne "default") {
      $model = @($models.data | Where-Object { [string]$_.display_name -eq $title }) | Select-Object -First 1
      if (-not $model) { throw "Verification failed: model discovery is missing $title." }
      if ([int64]$model.max_input_tokens -ne [int64]$routeHealth.contextWindow) { throw "Verification failed: $title context metadata disagrees with effective route context." }
      if ([int64]$model.max_tokens -ne [int64]$route.maxOutputTokens) { throw "Verification failed: $title output metadata disagrees with route configuration." }
    }
    $envKey = $envKeys[$slot]
    $configuredAlias = [string]$settings.env.PSObject.Properties[$envKey].Value
    if (-not $configuredAlias) { throw "Verification failed: Claude alias for $title is missing." }
    $encodedAlias = [Uri]::EscapeDataString($configuredAlias)
    $aliasModel = Invoke-RestMethod -Uri "$GatewayBaseUrl/v1/models/$encodedAlias" -TimeoutSec 5
    if ([string]$aliasModel.display_name -ne $title) { throw "Verification failed: Claude alias for $title does not resolve back to the expected logical route." }
    if ([int64]$aliasModel.max_input_tokens -ne [int64]$routeHealth.contextWindow -or [int64]$aliasModel.max_tokens -ne [int64]$route.maxOutputTokens) { throw "Verification failed: Claude alias for $title resolves with inconsistent route metadata." }
  }

  if ($script:FreshModelConfig) {
    $expected = @{
      default = @{ provider = "chatgpt"; model = "gpt-5.6-luna" }
      fable = @{ provider = "chatgpt"; model = "gpt-5.6-luna" }
      opus = @{ provider = "zen"; model = "deepseek-v4-flash-free" }
      sonnet = @{ provider = "google"; model = "gemini-3.5-flash-lite" }
      haiku = @{ provider = "google"; model = "gemini-3.5-flash-lite" }
    }
    foreach ($slot in $expected.Keys) {
      $route = $state.modelConfig.routes.PSObject.Properties[$slot].Value
      if ([string]$route.provider -ne [string]$expected[$slot].provider -or [string]$route.model -ne [string]$expected[$slot].model) {
        throw "Verification failed: fresh-install $slot route does not match the current default routing contract."
      }
    }
    Write-Host "[OK] Fresh provider/model defaults verified without hardcoded capability limits" -ForegroundColor Green
  }

  if ($PreDataFingerprint) {
    $postDataFingerprint = Get-DataFingerprint
    if (-not $postDataFingerprint -or $postDataFingerprint.count -ne $PreDataFingerprint.count -or $postDataFingerprint.digest -ne $PreDataFingerprint.digest) {
      throw "Verification failed: protected .data changed during update. Runtime was not allowed to rewrite account records, API keys, providers, routes, pins, status, or configuration."
    }
    Write-Host "[OK] Existing .data, model routing, custom providers, credentials, pins, and status preserved; managed OAuth sessions may refresh in place" -ForegroundColor Green
  }

  Write-Host "[OK] expected source SHA = installed build SHA = running /healthz SHA: $expectedSha" -ForegroundColor Green
  Write-Host "[OK] PID $($health.pid) owns the expected OpenAI-CC service on port 8082" -ForegroundColor Green
  Write-Host "[OK] Admin, Claude configuration, aliases, route-specific context, and output metadata are consistent" -ForegroundColor Green
  return $health
}

function Has-UsableChatGptCredential {
  $accountsFile = Join-Path $script:DataDir "accounts.json"
  if (-not (Test-Path $accountsFile)) { return $false }
  try {
    $accounts = Get-Content $accountsFile -Raw | ConvertFrom-Json
    foreach ($account in @($accounts.accounts)) {
      if ([string]$account.provider -eq "chatgpt" -and [string]$account.status -eq "ready" -and [string]$account.authFile) { return $true }
    }
  } catch { }
  return $false
}

function Run-CodexDoctorIfAvailable {
  Write-Step "ChatGPT/Codex verification"
  if (-not (Has-UsableChatGptCredential)) {
    Write-Host "No usable ChatGPT OAuth credential is present. Installation succeeds without credentials." -ForegroundColor Yellow
    Write-Host "Add credentials in $GatewayBaseUrl/admin; codex:doctor will be available from the installed runtime." -ForegroundColor Yellow
    return
  }
  $env:OPENAI_CC_HOME = $script:ManagedRoot
  $env:DATA_DIR = $script:DataDir
  Push-Location $script:ManagedRoot
  try {
    & $script:NodeCommand @((Join-Path $script:CurrentRuntime "dist\scripts\codex-doctor.js")) | Out-Host
    $doctorExitCode = $LASTEXITCODE
    if ($doctorExitCode -eq 2) {
      Write-Host "ChatGPT usage is currently exhausted or rate-limited. Local installation verification succeeded; rerun codex:doctor after quota resets." -ForegroundColor Yellow
      return
    }
    if ($doctorExitCode -ne 0) { throw "codex:doctor failed (exit code $doctorExitCode)." }
  } finally { Pop-Location }
}

function Remove-LegacyManagedFiles {
  if (-not $script:HadLegacyRuntime) { return }
  Write-Step "Remove obsolete source-checkout runtime"
  foreach ($relative in @(
    ".git", ".github", "src", "tests", "scripts", "dist", "distribution", "node_modules",
    ".env.example", ".gitignore", "AGENTS.md", "LICENSE", "README.md", "package.json", "package-lock.json",
    "setup.ps1", "install.ps1", "run-gateway.ps1", "run-claude.ps1", "tsconfig.json"
  )) {
    $pathValue = Join-Path $script:ManagedRoot $relative
    if (Test-Path $pathValue) { Remove-ManagedItem $pathValue }
  }
  Write-Host "[OK] Legacy Git/source runtime removed; .data remained untouched" -ForegroundColor Green
}

function Write-InstallState([Object]$Distribution, [object]$Health, [object]$DataFingerprint) {
  $state = [ordered]@{
    schemaVersion = 1
    appVersion = [string]$distribution.appVersion
    sourceCommit = ([string]$Distribution.sourceCommit).ToLowerInvariant()
    bundleSha256 = ([string]$Distribution.bundleSha256).ToLowerInvariant()
    contentSha256 = ([string]$distribution.contentSha256).ToLowerInvariant()
    installedAt = [DateTime]::UtcNow.ToString("o")
    installRoot = $script:ManagedRoot
    runtimeRoot = $script:CurrentRuntime
    pid = [int]$Health.pid
    dataFingerprint = if ($DataFingerprint) { [string]$DataFingerprint.digest } else { $null }
  }
  Write-Utf8NoBom (Join-Path $script:ManagedRoot "install-state.json") (($state | ConvertTo-Json -Depth 5) + "`n")
}

function Restore-PreviousRuntime {
  try { Stop-ManagedRuntime } catch { }
  try {
    if (Test-Path $script:CurrentRuntime) { Remove-ManagedItem $script:CurrentRuntime }
    if ($script:RollbackRuntime -and (Test-Path $script:RollbackRuntime)) {
      Move-Item $script:RollbackRuntime $script:CurrentRuntime
      $oldLauncher = Join-Path $script:CurrentRuntime "run-gateway.ps1"
      if (Test-Path $oldLauncher) {
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $oldLauncher, "-InstallRoot", $script:ManagedRoot) -WindowStyle Hidden | Out-Null
      }
    } elseif ($script:HadLegacyRuntime) {
      $legacyLauncher = Join-Path $script:ManagedRoot "run-gateway.ps1"
      if (Test-Path $legacyLauncher) {
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $legacyLauncher) -WindowStyle Hidden | Out-Null
      }
    }
  } catch { Write-Warning "Previous runtime rollback encountered an error: $($_.Exception.Message)" }
}

function Start-PreviousRuntime {
  $launcher = $null
  $arguments = @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass")
  if ($script:HadCurrentRuntime) {
    $launcher = Join-Path $script:CurrentRuntime "run-gateway.ps1"
    $arguments += @("-File", $launcher, "-InstallRoot", $script:ManagedRoot)
  } elseif ($script:HadLegacyRuntime) {
    $launcher = Join-Path $script:ManagedRoot "run-gateway.ps1"
    $arguments += @("-File", $launcher)
  }
  if ($launcher -and (Test-Path $launcher)) {
    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WindowStyle Hidden | Out-Null
  }
}

Write-Host "OpenAI-CC Session 6A deterministic bundle installer" -ForegroundColor Cyan
Write-Host "Managed root: $script:ManagedRoot" -ForegroundColor DarkGray
Write-Host "Git, repository cloning, GitHub authentication, and PATs are not used." -ForegroundColor DarkGray
Write-Host "Persistent .data is user-owned and is never part of the runtime swap." -ForegroundColor DarkGray

$tempDownloadRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-install-" + [Guid]::NewGuid().ToString("N"))
$stage = Join-Path $script:ManagedRoot ("._staging-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDownloadRoot | Out-Null
New-Item -ItemType Directory -Force -Path $script:ManagedRoot | Out-Null
$preDataFingerprint = $null

try {
  Write-Step "Download and verify distribution"
  $distribution = Read-DistributionManifest $ManifestUrl
  Assert-DistributionManifest $distribution
  $bundleLocation = Resolve-BundleLocation $distribution
  $bundleFile = Join-Path $tempDownloadRoot "runtime.zip"
  Copy-OrDownload $bundleLocation $bundleFile
  if ($distribution.bundleSize -and [int64](Get-Item $bundleFile).Length -ne [int64]$distribution.bundleSize) { throw "Downloaded bundle size does not match manifest." }
  $actualBundleSha = Get-Sha256 $bundleFile
  if ($actualBundleSha -ine [string]$distribution.bundleSha256) { throw "Corrupted/hash-mismatched bundle: expected $($distribution.bundleSha256), got $actualBundleSha." }
  Write-Host "[OK] Bundle SHA256 $actualBundleSha" -ForegroundColor Green

  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Expand-Archive -Path $bundleFile -DestinationPath $stage -Force
  $internalManifest = Verify-ExtractedRuntime $stage $distribution
  Write-Host "[OK] Internal file manifest and content digest verified" -ForegroundColor Green

  Ensure-Node
  Stop-ManagedRuntime

  try {
    Migrate-PersistentData $stage
    $preDataFingerprint = Get-DataFingerprint
    if ($preDataFingerprint) { Write-Host "[OK] Preserved pre-update .data fingerprint captured without printing secrets" -ForegroundColor Green }
    else { Write-Host "Fresh install: .data will be initialized by the runtime defaults." -ForegroundColor DarkGray }
  } catch {
    Start-PreviousRuntime
    throw
  }

  Write-Step "Atomic runtime install"
  if (Test-Path $script:CurrentRuntime) {
    $script:RollbackRuntime = Join-Path $script:ManagedRoot ("._rollback-" + [Guid]::NewGuid().ToString("N"))
    Move-Item $script:CurrentRuntime $script:RollbackRuntime
  }
  Move-Item $stage $script:CurrentRuntime
  $script:SwappedRuntime = $true
  Write-Host "[OK] current runtime swapped atomically; .data was not moved or deleted" -ForegroundColor Green
  Configure-Clients
  Start-ManagedRuntime
  $health = Verify-Installation $distribution $internalManifest $preDataFingerprint
  Run-CodexDoctorIfAvailable
  Install-StartupShortcut
  Write-InstallState $distribution $health (Get-DataFingerprint)
  Remove-LegacyManagedFiles

  if ($script:RollbackRuntime -and (Test-Path $script:RollbackRuntime)) { Remove-ManagedItem $script:RollbackRuntime }

  Write-Host ""
  Write-Host "Installation verified." -ForegroundColor Green
  Write-Host "Application version: $($distribution.appVersion)"
  Write-Host "Source/build SHA:    $($distribution.sourceCommit)"
  Write-Host "Bundle SHA256:       $($distribution.bundleSha256)"
  Write-Host "Install root:        $script:ManagedRoot"
  Write-Host "Gateway:             $GatewayBaseUrl"
  Write-Host "Admin:               $GatewayBaseUrl/admin"
  Write-Host "Update: rerun this installer with a newer -ManifestUrl; existing .data and model routing are preserved."
  Write-Host "Uninstall keep data: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $script:CurrentRuntime 'uninstall.ps1')`" -KeepData"
  Write-Host "Full purge:          powershell -ExecutionPolicy Bypass -File `"$(Join-Path $script:CurrentRuntime 'uninstall.ps1')`" -PurgeData"
} catch {
  $message = $_.Exception.Message
  if ($script:SwappedRuntime) { Restore-PreviousRuntime }
  throw $message
} finally {
  Remove-Item $tempDownloadRoot -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $stage) { try { Remove-ManagedItem $stage } catch { } }
}
