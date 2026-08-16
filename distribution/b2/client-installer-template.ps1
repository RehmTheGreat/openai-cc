$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$DefaultAuthorizeUrl = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"
$KeyId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@KEY_ID_B64@@"))
$Key = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@KEY_B64@@"))
$BucketId = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@BUCKET_ID_B64@@"))
$ReleasePrefix = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("@@RELEASE_PREFIX_B64@@"))
$BootstrapSha256 = "@@BOOTSTRAP_SHA256@@"
$ExpirationTimestamp = [int64]"@@EXPIRATION_TIMESTAMP@@"
$ExitCode = 1
$BootstrapPath = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-bootstrap-" + [Guid]::NewGuid().ToString("N") + ".ps1")
$BackupRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-claude-backup-" + [Guid]::NewGuid().ToString("N"))
$BackupCreated = $false
$InstallSucceeded = $false

function Get-AuthorizeUrl {
  $candidate = [string]$env:OPENAI_CC_B2_AUTHORIZE_URL
  if (-not $candidate) { return $DefaultAuthorizeUrl }
  $uri = $null
  if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -or -not $uri.IsLoopback -or $uri.Scheme -notin @("http", "https")) {
    throw "OPENAI_CC_B2_AUTHORIZE_URL may only override Backblaze with a loopback HTTP(S) URL for local tests."
  }
  return $uri.AbsoluteUri
}

function Escape-B2Path([string]$Value) {
  return (($Value -split '/') | Where-Object { $_ -ne "" } | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
}

function Assert-DownloadUrl([string]$Value, [bool]$LocalFixture) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) { throw "Backblaze returned an invalid download URL." }
  if ($LocalFixture) {
    if (-not $uri.IsLoopback -or $uri.Scheme -notin @("http", "https")) { throw "Local B2 fixture returned a non-loopback download URL." }
    return
  }
  if ($uri.Scheme -ne "https" -or $uri.Port -ne 443 -or $uri.Host -notmatch '(^|\.)backblazeb2\.com$') {
    throw "Backblaze returned an unexpected production download host."
  }
}

function Read-YesNo([string]$Prompt, [bool]$Default = $true) {
  $suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $answer = ([string](Read-Host "$Prompt $suffix")).Trim().ToLowerInvariant()
    if (-not $answer) { return $Default }
    if ($answer -in @("y", "yes")) { return $true }
    if ($answer -in @("n", "no")) { return $false }
    Write-Host "Please enter y or n." -ForegroundColor Yellow
  }
}

function Get-Choice([string]$EnvironmentName, [string]$Prompt) {
  $raw = [string][Environment]::GetEnvironmentVariable($EnvironmentName)
  if ($raw -eq "1") { return $true }
  if ($raw -eq "0") { return $false }
  if ([string]$env:CI -eq "true") { return $false }
  return Read-YesNo $Prompt $true
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Get-Winget {
  Refresh-ProcessPath
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw "Windows Package Manager (winget) is required for client/tool setup." }
  return $winget.Source
}

function Install-WingetPackage([string]$Id, [string]$Label) {
  $winget = Get-Winget
  Write-Host "Installing $Label..." -ForegroundColor Cyan
  & $winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Label installation failed (winget exit code $LASTEXITCODE)." }
  Refresh-ProcessPath
}

function Test-ClaudeCodeInstalled {
  if (Test-Path (Join-Path $HOME ".local\bin\claude.exe")) { return $true }
  Refresh-ProcessPath
  $command = Get-Command claude -ErrorAction SilentlyContinue
  return [bool]($command -and $command.Source -notlike "*\Microsoft\WindowsApps\Claude.exe" -and $command.Source -notmatch '(?i)AnthropicClaude|Programs\\Claude')
}

function Test-ClaudeDesktopInstalled {
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA "AnthropicClaude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Claude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Claude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\Claude.exe")
  )) { if ($candidate -and (Test-Path $candidate)) { return $true } }
  try { return [bool](Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "Claude" -or $_.PackageFamilyName -like "Claude_*" } | Select-Object -First 1) }
  catch { return $false }
}

function Find-CodeCli {
  Refresh-ProcessPath
  $command = Get-Command code -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\Code.exe")
  )) { if ($candidate -and (Test-Path $candidate)) { return $candidate } }
  return $null
}

function Invoke-CodeCommand([string]$CodePath, [string[]]$Arguments, [int]$TimeoutSeconds) {
  $stdout = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-code-" + [Guid]::NewGuid().ToString("N") + ".out")
  $stderr = "$stdout.err"
  $process = $null
  try {
    $process = Start-Process -FilePath $CodePath -ArgumentList $Arguments -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      return [pscustomobject]@{ timedOut = $true; exitCode = $null; output = "" }
    }
    $text = ((Get-Content $stdout -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $stderr -Raw -ErrorAction SilentlyContinue)).Trim()
    return [pscustomobject]@{ timedOut = $false; exitCode = $process.ExitCode; output = $text }
  } finally {
    Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
    if ($process) { $process.Dispose() }
  }
}

function Install-ClaudeVsCode {
  $code = Find-CodeCli
  if ($code) {
    $probe = Invoke-CodeCommand $code @("--version") 8
    $badAgent = [bool]($probe.output -match '(?i)agent\s*:?[\s.]*?(?:unkown|unknown)')
    if ($probe.timedOut -or $badAgent -or $probe.exitCode -ne 0) {
      Write-Host "VS Code CLI is hung/unhealthy (including agent :unknown/unkown); skipping VS Code automatically." -ForegroundColor Yellow
      return
    }
  } else {
    Install-WingetPackage "Microsoft.VisualStudioCode" "Visual Studio Code"
    $code = Find-CodeCli
  }

  if (-not $code) {
    Write-Host "VS Code installed but code CLI is unavailable; skipping Claude Code extension." -ForegroundColor Yellow
    return
  }

  $install = Invoke-CodeCommand $code @("--install-extension", "anthropic.claude-code", "--force") 60
  if ($install.timedOut -or $install.output -match '(?i)agent\s*:?[\s.]*?(?:unkown|unknown)' -or $install.exitCode -ne 0) {
    Write-Host "VS Code extension install hung/failed; skipped without failing OpenAI-CC." -ForegroundColor Yellow
    return
  }
  Write-Host "[OK] VS Code + Claude Code extension ready" -ForegroundColor Green
}

function Ensure-CoreTools {
  if ([string]$env:CI -eq "true") { return }
  Refresh-ProcessPath
  if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "[OK] Git already installed" -ForegroundColor Green }
  else { Install-WingetPackage "Git.Git" "Git for Windows" }

  if (Get-Command rg -ErrorAction SilentlyContinue) { Write-Host "[OK] ripgrep already installed" -ForegroundColor Green }
  else { Install-WingetPackage "BurntSushi.ripgrep.MSVC" "ripgrep" }

  if (Get-Command rtk -ErrorAction SilentlyContinue) { Write-Host "[OK] RTK already installed" -ForegroundColor Green }
  else { Install-WingetPackage "rtk-ai.rtk" "RTK" }

  Refresh-ProcessPath
  $rtk = Get-Command rtk -ErrorAction SilentlyContinue
  if (-not $rtk) { throw "RTK installed but rtk is not available on PATH." }
  # Default RTK telemetry consent to No and keep client installs fully noninteractive.
  & $rtk.Source telemetry disable | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "RTK telemetry opt-out failed (exit code $LASTEXITCODE)." }
  & $rtk.Source init -g --auto-patch --no-trust-filters | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "RTK initialization failed (exit code $LASTEXITCODE)." }
  Write-Host "[OK] RTK initialized" -ForegroundColor Green
}

function Copy-Tree([string]$Source, [string]$Destination) {
  if (-not (Test-Path $Source)) { return }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Failed to copy Claude state from $Source (robocopy exit code $LASTEXITCODE)." }
}

function Backup-ClaudeData {
  New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
  $claudeDir = Join-Path $HOME ".claude"
  $state = Join-Path $HOME ".claude.json"
  if (Test-Path $state) { Copy-Item $state (Join-Path $BackupRoot "claude.json") -Force }
  foreach ($relative in @("settings.json", "history.jsonl")) {
    $source = Join-Path $claudeDir $relative
    if (Test-Path $source) {
      New-Item -ItemType Directory -Force -Path (Join-Path $BackupRoot "claude") | Out-Null
      Copy-Item $source (Join-Path $BackupRoot "claude\$relative") -Force
    }
  }
  foreach ($relative in @("projects", "sessions")) { Copy-Tree (Join-Path $claudeDir $relative) (Join-Path $BackupRoot "claude\$relative") }
  if ($env:APPDATA) { Copy-Tree (Join-Path $env:APPDATA "Code\User\globalStorage\anthropic.claude-code") (Join-Path $BackupRoot "vscode-claude") }
  $script:BackupCreated = $true
  Write-Host "[OK] Claude user state and chat history backed up temporarily" -ForegroundColor Green
}

function Merge-ClaudeState {
  $backup = Join-Path $BackupRoot "claude.json"
  $currentPath = Join-Path $HOME ".claude.json"
  if (-not (Test-Path $backup) -or -not (Test-Path $currentPath)) { return }
  try {
    $original = Get-Content $backup -Raw | ConvertFrom-Json
    $current = Get-Content $currentPath -Raw | ConvertFrom-Json
    foreach ($name in @("hasCompletedOnboarding", "hasSeenOnboarding", "numStartups")) {
      $property = $current.PSObject.Properties[$name]
      if ($property) { $original | Add-Member -NotePropertyName $name -NotePropertyValue $property.Value -Force }
    }
    $original | ConvertTo-Json -Depth 100 | Set-Content $currentPath -Encoding UTF8
  } catch { Write-Warning "Claude state merge failed; keeping installer-generated state: $($_.Exception.Message)" }
}

function Restore-ClaudeData([bool]$Rollback) {
  if (-not $script:BackupCreated -or -not (Test-Path $BackupRoot)) { return }
  $claudeDir = Join-Path $HOME ".claude"
  New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
  foreach ($relative in @("projects", "sessions")) { Copy-Tree (Join-Path $BackupRoot "claude\$relative") (Join-Path $claudeDir $relative) }
  $history = Join-Path $BackupRoot "claude\history.jsonl"
  if (Test-Path $history) { Copy-Item $history (Join-Path $claudeDir "history.jsonl") -Force }
  if ($env:APPDATA) { Copy-Tree (Join-Path $BackupRoot "vscode-claude") (Join-Path $env:APPDATA "Code\User\globalStorage\anthropic.claude-code") }

  if ($Rollback) {
    $settings = Join-Path $BackupRoot "claude\settings.json"
    if (Test-Path $settings) { Copy-Item $settings (Join-Path $claudeDir "settings.json") -Force }
    $state = Join-Path $BackupRoot "claude.json"
    if (Test-Path $state) { Copy-Item $state (Join-Path $HOME ".claude.json") -Force }
  } else { Merge-ClaudeState }

  Remove-Item $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
  $script:BackupCreated = $false
  Write-Host "[OK] Claude chats/state restored; temporary backup deleted" -ForegroundColor Green
}

try {
  $now = [DateTimeOffset]::UtcNow
  $expires = [DateTimeOffset]::FromUnixTimeMilliseconds($ExpirationTimestamp)
  if ($expires -le $now) { throw "This client installer has expired. Ask for a new OpenAI-CC installer." }
  if ($expires -gt $now.AddSeconds(3660)) { throw "Client installer lifetime exceeds the one-hour maximum." }

  $wantClaudeCode = Get-Choice "OPENAI_CC_CLIENT_INSTALL_CLAUDE_CODE" "Install/ensure Claude Code?"
  $wantClaudeDesktop = Get-Choice "OPENAI_CC_CLIENT_INSTALL_CLAUDE_DESKTOP" "Install/ensure Claude Desktop?"
  $wantVsCode = Get-Choice "OPENAI_CC_CLIENT_INSTALL_VSCODE" "Install/ensure VS Code + Claude Code extension?"

  Write-Host "Installing OpenAI-CC..." -ForegroundColor Cyan
  Backup-ClaudeData
  Ensure-CoreTools

  if ($wantClaudeCode) {
    if (Test-ClaudeCodeInstalled) { Write-Host "[OK] Claude Code already installed" -ForegroundColor Green }
    else { Install-WingetPackage "Anthropic.ClaudeCode" "Claude Code" }
  }
  if ($wantClaudeDesktop) {
    if (Test-ClaudeDesktopInstalled) { Write-Host "[OK] Claude Desktop already installed" -ForegroundColor Green }
    else { Install-WingetPackage "Anthropic.Claude" "Claude Desktop" }
  }
  if ($wantVsCode) { Install-ClaudeVsCode }

  $authorizeUrl = Get-AuthorizeUrl
  $authorizeUri = [Uri]$authorizeUrl
  $localFixture = $authorizeUri.IsLoopback
  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$KeyId`:$Key"))
  $auth = Invoke-RestMethod -Uri $authorizeUrl -Headers @{ Authorization = "Basic $basic" } -Method Get -TimeoutSec 60
  $storage = $auth.apiInfo.storageApi
  if (-not $auth.authorizationToken -or -not $storage -or -not $storage.allowed -or -not $storage.downloadUrl) { throw "Backblaze authorization response is incomplete." }

  $capabilities = @($storage.allowed.capabilities)
  if ($capabilities.Count -ne 1 -or [string]$capabilities[0] -ne "readFiles") { throw "Client installer grant must have exactly readFiles capability." }
  $buckets = @($storage.allowed.buckets)
  if ($buckets.Count -ne 1 -or [string]$buckets[0].id -ne $BucketId -or -not [string]$buckets[0].name) { throw "Client installer grant has the wrong bucket scope." }
  if ([string]$storage.allowed.namePrefix -ne $ReleasePrefix) { throw "Client installer grant has the wrong release scope." }
  if ([int64]$auth.applicationKeyExpirationTimestamp -ne $ExpirationTimestamp) { throw "Client installer grant expiry does not match Backblaze." }
  Assert-DownloadUrl ([string]$storage.downloadUrl) $localFixture

  $bootstrapName = Escape-B2Path ($ReleasePrefix + "bootstrap.ps1")
  $bucketName = [Uri]::EscapeDataString([string]$buckets[0].name)
  $bootstrapUrl = "$($storage.downloadUrl.TrimEnd('/'))/file/$bucketName/$bootstrapName"
  Invoke-WebRequest -Uri $bootstrapUrl -Headers @{ Authorization = [string]$auth.authorizationToken } -OutFile $BootstrapPath -UseBasicParsing -TimeoutSec 180
  $actualBootstrapSha = (Get-FileHash -Path $BootstrapPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualBootstrapSha -ne $BootstrapSha256.ToLowerInvariant()) { throw "Downloaded bootstrap failed SHA-256 verification." }

  $env:OPENAI_CC_DIST_KEY_ID = $KeyId
  $env:OPENAI_CC_DIST_KEY = $Key
  $env:OPENAI_CC_DIST_BOOTSTRAP_SHA256 = $BootstrapSha256
  $bootstrapArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BootstrapPath)
  if ($env:OPENAI_CC_CLIENT_INSTALL_ROOT) { $bootstrapArgs += @("-InstallRoot", [string]$env:OPENAI_CC_CLIENT_INSTALL_ROOT) }
  if ($env:OPENAI_CC_CLIENT_SKIP_DESKTOP_CONFIG -eq "1") { $bootstrapArgs += "-SkipDesktopConfig" }
  if ($env:OPENAI_CC_CLIENT_NO_STARTUP_SHORTCUT -eq "1") { $bootstrapArgs += "-NoStartupShortcut" }

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & powershell.exe @bootstrapArgs 2>&1 | ForEach-Object { $_ | Out-Host }
    $installerExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousErrorActionPreference }
  if ($installerExitCode -ne 0) { throw "OpenAI-CC installation failed with exit code $installerExitCode." }

  $script:InstallSucceeded = $true
  Restore-ClaudeData $false
  Write-Host "[OK] OpenAI-CC installed successfully." -ForegroundColor Green
  Write-Host "Admin: http://127.0.0.1:8082/admin" -ForegroundColor Green
  if ($wantVsCode -and $wantClaudeDesktop) { Write-Host "VS Code and Desktop session histories are separate by Anthropic design; both were preserved." -ForegroundColor DarkGray }
  if ($env:OPENAI_CC_CLIENT_NO_OPEN_ADMIN -ne "1") { Start-Process "http://127.0.0.1:8082/admin" }
  $ExitCode = 0
} catch {
  Write-Host ""
  Write-Host "OpenAI-CC installation failed: $($_.Exception.Message)" -ForegroundColor Red
  $ExitCode = 1
} finally {
  try { if ($script:BackupCreated) { Restore-ClaudeData (-not $script:InstallSucceeded) } } catch { Write-Warning "Claude backup restore failed: $($_.Exception.Message)" }
  foreach ($name in @("OPENAI_CC_DIST_KEY_ID", "OPENAI_CC_DIST_KEY", "OPENAI_CC_DIST_BOOTSTRAP_SHA256", "OPENAI_CC_B2_AUTHORIZE_URL")) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $Key = $null
  $basic = $null
  $auth = $null
  Remove-Item $BootstrapPath -Force -ErrorAction SilentlyContinue
  Remove-Item $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
}

exit $ExitCode
