[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$RepositoryUrl = "https://github.com/RehmTheGreat/openai-cc.git"
$GatewayBaseUrl = "http://127.0.0.1:8082"
$ContextWindow = 700000
$MinimumNodeVersion = [Version]"22.5.0"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Invoke-NativeConsole([string]$Command, [string[]]$Arguments) {
  # Do not redirect native stderr in Windows PowerShell 5.1. Redirecting 2>&1
  # converts ordinary native stderr progress into ErrorRecords. With the
  # installer's global Stop preference that can abort on harmless Git output.
  # Send stdout to the host so it stays visible without becoming function output.
  & $Command @Arguments | Out-Host
  $nativeExitCode = $LASTEXITCODE
  return [int]$nativeExitCode
}

function Clear-PendingConsoleInput {
  try {
    if (-not [Console]::IsInputRedirected) {
      while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
    }
  } catch { }
}

function Read-YesNo([string]$Prompt) {
  Clear-PendingConsoleInput
  while ($true) {
    Write-Host -NoNewline "$Prompt [Y/N]: "
    try {
      if (-not [Console]::IsInputRedirected) {
        while ($true) {
          $key = [Console]::ReadKey($true)
          if (($key.Modifiers -band [ConsoleModifiers]::Control) -and $key.Key -eq [ConsoleKey]::C) {
            throw [System.OperationCanceledException]::new("Cancelled by user.")
          }
          if ($key.Key -eq [ConsoleKey]::Y) { Write-Host "Y"; return $true }
          if ($key.Key -eq [ConsoleKey]::N) { Write-Host "N"; return $false }
          # Ignore Enter and all other buffered keys. Only Y or N completes this prompt.
        }
      }
    } catch [System.OperationCanceledException] {
      throw
    } catch { }

    $answer = (Read-Host).Trim()
    if ($answer -match '^(?i:y|yes)$') { return $true }
    if ($answer -match '^(?i:n|no)$') { return $false }
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
}

function Add-UserPath([string]$Directory, [switch]$Prepend) {
  if (-not $Directory) { return }
  $Directory = [IO.Path]::GetFullPath($Directory)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
  $entries = @($entries | Where-Object { $_.TrimEnd('\') -ine $Directory.TrimEnd('\') })
  if ($Prepend) { $entries = @($Directory) + $entries } else { $entries += $Directory }
  [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
  Refresh-ProcessPath
}

function Set-PersistentEnvironment([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Set-Item -Path "Env:$Name" -Value $Value
}

function Remove-OldOpenAICCContextOverrides {
  foreach ($name in @("CLAUDE_CODE_CONTEXT_WINDOW", "CLAUDE_CODE_MAX_CONTEXT_TOKENS")) {
    $userValue = [Environment]::GetEnvironmentVariable($name, "User")
    if ($userValue -eq [string]$ContextWindow) {
      [Environment]::SetEnvironmentVariable($name, $null, "User")
    }
    $current = Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    if ($current -and $current.Value -eq [string]$ContextWindow) {
      Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
  }
}

function Get-Winget {
  $command = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "WinGet is required to install missing Windows dependencies/apps. Install Microsoft App Installer, then rerun setup.ps1."
  }
  return $command.Source
}

function Invoke-WingetInstall([string]$Id, [string]$Label) {
  $winget = Get-Winget
  Write-Host "Installing $Label..."
  $exitCode = Invoke-NativeConsole $winget @("install", "--id", $Id, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent", "--disable-interactivity")
  if ($exitCode -ne 0) { throw "$Label installation failed (WinGet exit code $exitCode)." }
  Refresh-ProcessPath
}

function Invoke-WingetUpgrade([string]$Id, [string]$Label) {
  $winget = Get-Winget
  Write-Host "Upgrading $Label because the installed version is below the required minimum..."
  $exitCode = Invoke-NativeConsole $winget @("upgrade", "--id", $Id, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent", "--disable-interactivity")
  if ($exitCode -ne 0) { throw "$Label upgrade failed (WinGet exit code $exitCode)." }
  Refresh-ProcessPath
}

function Test-WingetPackageInstalled([string]$Id) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { return $false }

  $stdout = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-winget-" + [Guid]::NewGuid().ToString("N") + ".out")
  $stderr = "$stdout.err"
  try {
    $process = Start-Process -FilePath $winget.Source -ArgumentList @(
      "list", "--id", $Id, "--exact", "--accept-source-agreements", "--disable-interactivity"
    ) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($process.ExitCode -ne 0) { return $false }
    $text = if (Test-Path $stdout) { Get-Content $stdout -Raw -ErrorAction SilentlyContinue } else { "" }
    return ($text -match [Regex]::Escape($Id))
  } catch {
    return $false
  } finally {
    Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
  }
}

function Test-ClaudeDesktopInstalled {
  # Legacy/Squirrel paths plus the MSIX app-execution alias used by current Windows builds.
  $knownPaths = @(
    (Join-Path $env:LOCALAPPDATA "AnthropicClaude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Claude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Claude\Claude.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\Claude.exe")
  )
  if ($knownPaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1) { return $true }

  # Current Claude Desktop is commonly MSIX. PackageFamilyName is typically Claude_<publisher id>.
  try {
    $package = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {
      ($_.Name -eq "Claude") -or ($_.PackageFamilyName -like "Claude_*") -or ($_.PackageFullName -like "Claude_*")
    } | Select-Object -First 1
    if ($package) { return $true }
  } catch { }

  foreach ($root in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )) {
    try {
      $entry = Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object {
        ($_.DisplayName -match "^Claude( Desktop)?$") -or ($_.UninstallString -match "AnthropicClaude|Claude")
      } | Select-Object -First 1
      if ($entry) { return $true }
    } catch { }
  }

  # WinGet's installed-package inventory is authoritative for the package the installer just installed.
  if (Test-WingetPackageInstalled "Anthropic.Claude") { return $true }
  return $false
}

function Wait-ClaudeDesktopRegistration([int]$TimeoutSeconds = 60) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (Test-ClaudeDesktopInstalled) { return $true }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Test-VSCodeInstalled {
  # Deliberately detect VS Code without invoking its `code` CLI. On Windows,
  # code.cmd may launch the full Electron GUI and hang instead of behaving as a CLI.
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\Code.exe")
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft VS Code\Code.exe") }
  if ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1) { return $true }
  return (Test-WingetPackageInstalled "Microsoft.VisualStudioCode")
}

function Get-ClaudeCliCommand {
  # Prefer the real native Claude Code CLI over the Claude Desktop WindowsApps alias.
  $native = Join-Path $HOME ".local\bin\claude.exe"
  if (Test-Path $native) { return $native }

  $command = Get-Command claude -ErrorAction SilentlyContinue
  if ($command -and $command.Source -notlike "*\Microsoft\WindowsApps\Claude.exe") { return $command.Source }
  return $null
}

function Test-OpenAICCProxy {
  try {
    $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 2
    return [bool]$health.ok
  } catch { return $false }
}

function Ensure-CoreDependencies {
  Write-Step "Dependencies"

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Invoke-WingetInstall "Git.Git" "Git for Windows" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is still unavailable after installation." }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Invoke-WingetInstall "OpenJS.NodeJS.LTS" "Node.js LTS"
  } else {
    $version = [Version]((& node --version).Trim().TrimStart('v'))
    if ($version -lt $MinimumNodeVersion) { Invoke-WingetUpgrade "OpenJS.NodeJS.LTS" "Node.js LTS" }
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is unavailable after installation." }
  if ([Version]((& node --version).Trim().TrimStart('v')) -lt $MinimumNodeVersion) {
    throw "Node.js $MinimumNodeVersion or newer is required for the installed token-optimization stack; found $(& node --version)."
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is unavailable after installing Node.js." }

  if (-not (Get-Command rg -ErrorAction SilentlyContinue)) { Invoke-WingetInstall "BurntSushi.ripgrep.MSVC" "ripgrep" }
}

function Resolve-GatewayDirectory {
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "package.json")) -and (Test-Path (Join-Path $PSScriptRoot "src"))) {
    return [IO.Path]::GetFullPath($PSScriptRoot)
  }

  $target = Join-Path $env:LOCALAPPDATA "OpenAI-CC"
  $gitCommand = (Get-Command git).Source
  if (-not (Test-Path $target)) {
    Write-Host "Cloning OpenAI-CC to $target..."
    $exitCode = Invoke-NativeConsole $gitCommand @("clone", $RepositoryUrl, $target)
    if ($exitCode -ne 0) { throw "Could not clone OpenAI-CC (git exit code $exitCode)." }
  } elseif (-not (Test-Path (Join-Path $target ".git"))) {
    $existingItems = @(Get-ChildItem -Force -Path $target -ErrorAction SilentlyContinue)
    if ($existingItems.Count -eq 0) {
      Remove-Item $target -Force -ErrorAction SilentlyContinue
      Write-Host "Recovering an empty interrupted OpenAI-CC clone at $target..." -ForegroundColor Yellow
      $exitCode = Invoke-NativeConsole $gitCommand @("clone", $RepositoryUrl, $target)
      if ($exitCode -ne 0) { throw "Could not clone OpenAI-CC (git exit code $exitCode)." }
    } else {
      throw "$target already exists but is not an OpenAI-CC git checkout. Move/rename it and rerun the installer."
    }
  } else {
    $dirty = (& git -C $target status --porcelain) -join "`n"
    if (-not $dirty) {
      Write-Host "Refreshing existing OpenAI-CC checkout..." -ForegroundColor DarkGray
      $exitCode = Invoke-NativeConsole $gitCommand @("-C", $target, "pull", "--ff-only", "origin", "main")
      if ($exitCode -ne 0) { throw "Could not fast-forward the existing OpenAI-CC checkout (git exit code $exitCode)." }
    } else {
      Write-Host "Existing OpenAI-CC checkout has local changes; leaving them untouched." -ForegroundColor Yellow
    }
  }
  return [IO.Path]::GetFullPath($target)
}

function Ensure-ClaudeCode([bool]$Requested) {
  if (-not $Requested) { Write-Host "Claude Code CLI: skipped by user." -ForegroundColor DarkGray; return }

  $cli = Get-ClaudeCliCommand
  if ($cli) {
    Add-UserPath (Split-Path $cli -Parent) -Prepend
    Write-Host "Claude Code CLI already installed; leaving the installed version untouched." -ForegroundColor DarkGray
    return
  }

  Invoke-WingetInstall "Anthropic.ClaudeCode" "Claude Code"
  $nativeDir = Join-Path $HOME ".local\bin"
  if (Test-Path (Join-Path $nativeDir "claude.exe")) { Add-UserPath $nativeDir -Prepend }
  if (-not (Get-ClaudeCliCommand)) { throw "Claude Code installation completed but the native Claude Code CLI could not be found." }
}

function Configure-VSCodeClaudeSettings {
  $settingsFile = Join-Path $env:APPDATA "Code\User\settings.json"
  New-Item -ItemType Directory -Force -Path (Split-Path $settingsFile -Parent) | Out-Null
  $raw = if (Test-Path $settingsFile) { Get-Content $settingsFile -Raw } else { "{}" }
  if (-not $raw.Trim()) { $raw = "{}" }

  $pattern = '("claudeCode\.disableLoginPrompt"\s*:\s*)(true|false)'
  if ($raw -match $pattern) {
    $raw = [Regex]::Replace($raw, $pattern, '${1}true', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  } else {
    $brace = $raw.IndexOf('{')
    if ($brace -lt 0) {
      $raw = "{`r`n  `"claudeCode.disableLoginPrompt`": true`r`n}"
    } else {
      $raw = $raw.Insert($brace + 1, "`r`n  `"claudeCode.disableLoginPrompt`": true,")
    }
  }
  Set-Content -Path $settingsFile -Value $raw -Encoding UTF8
}

function Ensure-VSCode([bool]$Requested) {
  if (-not $Requested) { Write-Host "VS Code: skipped by user." -ForegroundColor DarkGray; return }
  if (Test-VSCodeInstalled) {
    Write-Host "VS Code already installed; leaving the installed version untouched." -ForegroundColor DarkGray
  } else {
    Invoke-WingetInstall "Microsoft.VisualStudioCode" "Visual Studio Code"
    if (-not (Test-VSCodeInstalled)) { throw "VS Code installation completed but VS Code could not be detected." }
  }

  Configure-VSCodeClaudeSettings
  Write-Host "VS Code CLI automation intentionally skipped to avoid the known Windows code.cmd/GUI hang." -ForegroundColor Yellow
  Write-Host "After setup, open VS Code > Extensions and install/enable Claude Code (anthropic.claude-code) manually." -ForegroundColor Yellow
}

function Ensure-ClaudeDesktop([bool]$Requested) {
  if (-not $Requested) { Write-Host "Claude Desktop: skipped by user." -ForegroundColor DarkGray; return }
  if (Test-ClaudeDesktopInstalled) {
    Write-Host "Claude Desktop already installed; leaving the installed version untouched." -ForegroundColor DarkGray
    return
  }

  Invoke-WingetInstall "Anthropic.Claude" "Claude Desktop"
  Write-Host "Waiting for Claude Desktop MSIX/package registration..." -ForegroundColor DarkGray
  if (-not (Wait-ClaudeDesktopRegistration 60)) {
    throw "Claude Desktop install completed, but Windows did not register the app/package within 60 seconds. Check 'winget list --id Anthropic.Claude --exact' and 'Get-AppxPackage -Name Claude'."
  }
}

function Install-RTK {
  Write-Step "RTK"
  $rtk = Get-Command rtk -ErrorAction SilentlyContinue
  if (-not $rtk) {
    $binDir = Join-Path $HOME ".local\bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/rtk-ai/rtk/releases/latest" -Headers @{ "User-Agent" = "openai-cc-installer" }
    $asset = $release.assets | Where-Object { $_.name -eq "rtk-x86_64-pc-windows-msvc.zip" } | Select-Object -First 1
    if (-not $asset) { throw "The latest RTK release does not contain rtk-x86_64-pc-windows-msvc.zip." }
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openai-cc-rtk-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    try {
      $zip = Join-Path $tempRoot "rtk.zip"
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
      Expand-Archive -Path $zip -DestinationPath $tempRoot -Force
      $exe = Get-ChildItem -Path $tempRoot -Filter rtk.exe -Recurse | Select-Object -First 1
      if (-not $exe) { throw "rtk.exe was not found in the downloaded RTK archive." }
      Copy-Item $exe.FullName (Join-Path $binDir "rtk.exe") -Force
    } finally {
      Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Add-UserPath $binDir -Prepend
    $rtk = Get-Command rtk -ErrorAction SilentlyContinue
  } else {
    Write-Host "RTK already installed; leaving the binary version untouched." -ForegroundColor DarkGray
  }
  if (-not $rtk) { throw "RTK could not be installed." }

  $exitCode = Invoke-NativeConsole $rtk.Source @("init", "-g", "--auto-patch")
  if ($exitCode -ne 0) { throw "RTK Claude Code integration failed." }
  $exitCode = Invoke-NativeConsole $rtk.Source @("init", "--show")
  if ($exitCode -ne 0) { throw "RTK integration verification failed." }
}

function Get-ClaudeRunner {
  $claude = Get-ClaudeCliCommand
  if ($claude) { return @{ Command = $claude; Prefix = @() } }
  $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npx) { $npx = Get-Command npx -ErrorAction SilentlyContinue }
  if (-not $npx) { throw "Neither Claude Code nor npx is available to configure Claude Code plugins." }
  return @{ Command = $npx.Source; Prefix = @("--yes", "@anthropic-ai/claude-code@latest") }
}

function Invoke-ClaudeRunner([hashtable]$Runner, [string[]]$Arguments) {
  $allArgs = @($Runner.Prefix) + @($Arguments)
  return Invoke-NativeConsole $Runner.Command $allArgs
}

function Test-PluginEnabled([string]$PluginId) {
  $settingsFile = Join-Path $HOME ".claude\settings.json"
  if (-not (Test-Path $settingsFile)) { return $false }
  try {
    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
    if (-not $settings.enabledPlugins) { return $false }
    $property = $settings.enabledPlugins.PSObject.Properties[$PluginId]
    return ($null -ne $property -and [bool]$property.Value)
  } catch { return $false }
}

function Install-ClaudePlugin([hashtable]$Runner, [string]$PluginId, [string]$MarketplaceSource) {
  if (Test-PluginEnabled $PluginId) { Write-Host "$PluginId already enabled; leaving it installed." -ForegroundColor DarkGray; return }

  $exit = Invoke-ClaudeRunner $Runner @("plugin", "install", $PluginId, "--scope", "user")
  if ($exit -ne 0 -and $MarketplaceSource) {
    Write-Host "Registering plugin marketplace $MarketplaceSource..."
    $marketExit = Invoke-ClaudeRunner $Runner @("plugin", "marketplace", "add", $MarketplaceSource, "--scope", "user")
    if ($marketExit -ne 0) { [void](Invoke-ClaudeRunner $Runner @("plugin", "marketplace", "update")) }
    $exit = Invoke-ClaudeRunner $Runner @("plugin", "install", $PluginId, "--scope", "user")
  }
  if ($exit -ne 0) { throw "Failed to install Claude Code plugin $PluginId." }
}

function Install-TokenOptimizationStack {
  Write-Step "Claude Code token optimization"
  if (-not (Get-Command typescript-language-server -ErrorAction SilentlyContinue)) {
    Write-Host "Installing TypeScript language server..."
    $exitCode = Invoke-NativeConsole (Get-Command npm).Source @("install", "-g", "typescript", "typescript-language-server")
    if ($exitCode -ne 0) { throw "typescript-language-server installation failed." }
    $npmPrefix = (& npm config get prefix).Trim()
    if ($npmPrefix) { Add-UserPath $npmPrefix }
    Refresh-ProcessPath
  } else {
    Write-Host "TypeScript language server already installed; leaving it untouched." -ForegroundColor DarkGray
  }

  $runner = Get-ClaudeRunner
  Install-ClaudePlugin $runner "typescript-lsp@claude-plugins-official" "anthropics/claude-plugins-official"
  Install-ClaudePlugin $runner "context-mode@context-mode" "mksglu/context-mode"
  Install-RTK
}

function Configure-PersistentClaudeEnvironment([bool]$DesktopRequested) {
  Write-Step "Persistent gateway configuration"
  Set-PersistentEnvironment "OPENAI_CC_HOME" $script:GatewayDirectory
  Set-PersistentEnvironment "OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP" ($(if ($DesktopRequested) { "1" } else { "0" }))
  Set-PersistentEnvironment "ANTHROPIC_BASE_URL" $GatewayBaseUrl
  Set-PersistentEnvironment "ANTHROPIC_AUTH_TOKEN" "local-not-used"
  Set-PersistentEnvironment "ANTHROPIC_MODEL" "claude-fable-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_FABLE_MODEL" "claude-fable-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_OPUS_MODEL" "claude-opus-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_SONNET_MODEL" "claude-sonnet-5"
  Set-PersistentEnvironment "ANTHROPIC_DEFAULT_HAIKU_MODEL" "claude-haiku-4-5"
  Set-PersistentEnvironment "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" "1"
  Set-PersistentEnvironment "CLAUDE_CODE_AUTO_COMPACT_WINDOW" ([string]$ContextWindow)
  Set-PersistentEnvironment "CLAUDE_CODE_PLUGIN_PREFER_HTTPS" "1"
  Remove-OldOpenAICCContextOverrides
}

function Build-AndConfigureGateway([bool]$DesktopRequested) {
  Write-Step "OpenAI-CC"
  Push-Location $script:GatewayDirectory
  try {
    $exitCode = Invoke-NativeConsole (Get-Command npm).Source @("install", "--no-audit", "--no-fund")
    if ($exitCode -ne 0) { throw "npm install failed." }
    $exitCode = Invoke-NativeConsole (Get-Command npm).Source @("run", "build")
    if ($exitCode -ne 0) { throw "OpenAI-CC build failed." }

    $env:OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP = $(if ($DesktopRequested) { "1" } else { "0" })
    $env:OPENAI_CC_CONTEXT_WINDOW = [string]$ContextWindow
    $exitCode = Invoke-NativeConsole (Get-Command node).Source @("dist/scripts/configure-clients.js")
    if ($exitCode -ne 0) { throw "OpenAI-CC client configuration failed." }
  } finally { Pop-Location }
}

function Start-OrVerifyGateway {
  Write-Step "Gateway startup"
  if (-not (Test-OpenAICCProxy)) {
    $runScript = Join-Path $script:GatewayDirectory "run-gateway.ps1"
    if (-not (Test-Path $runScript)) { throw "Missing run-gateway.ps1." }
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $runScript) -WindowStyle Hidden | Out-Null
  } else { Write-Host "OpenAI-CC proxy already running; leaving it in place." -ForegroundColor DarkGray }

  $healthy = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-OpenAICCProxy) { $healthy = $true; break }
  }
  if (-not $healthy) { throw "OpenAI-CC did not become healthy at $GatewayBaseUrl/healthz." }

  $payload = @{ contextWindow = $ContextWindow } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$GatewayBaseUrl/admin/model-config" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 5 | Out-Null
  $models = Invoke-RestMethod -Uri "$GatewayBaseUrl/v1/models" -TimeoutSec 5
  $publicModels = @($models.data)
  if ($publicModels.Count -lt 4) { throw "Gateway model discovery returned fewer than four Claude-compatible routes." }
  foreach ($model in $publicModels) {
    if ($model.id -notmatch '^claude-') { throw "Gateway exposed an unsafe model id: $($model.id)" }
    if ([int64]$model.max_input_tokens -ne $ContextWindow) { throw "Gateway model $($model.id) does not advertise $ContextWindow input tokens." }
  }
}

function Install-GatewayStartupShortcut {
  $startup = [Environment]::GetFolderPath("Startup")
  if (-not $startup) { return }
  $shortcutPath = Join-Path $startup "OpenAI-CC Gateway.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = (Get-Command powershell.exe).Source
  $runScript = Join-Path $script:GatewayDirectory "run-gateway.ps1"
  $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runScript`""
  $shortcut.WorkingDirectory = $script:GatewayDirectory
  $shortcut.Description = "Start the local OpenAI-CC Claude gateway"
  $shortcut.Save()
}

function Verify-Installation([bool]$ClaudeCodeRequested, [bool]$VSCodeRequested, [bool]$DesktopRequested) {
  Write-Step "Verification"
  $checks = New-Object System.Collections.Generic.List[string]

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Verification failed: git missing." }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Verification failed: node missing." }
  if (-not (Get-Command rtk -ErrorAction SilentlyContinue)) { throw "Verification failed: RTK missing." }
  if (-not (Get-Command typescript-language-server -ErrorAction SilentlyContinue)) { throw "Verification failed: TypeScript language server missing." }
  if (-not (Test-PluginEnabled "typescript-lsp@claude-plugins-official")) { throw "Verification failed: official TypeScript LSP plugin is not enabled." }
  if (-not (Test-PluginEnabled "context-mode@context-mode")) { throw "Verification failed: Context Mode plugin is not enabled." }
  if (-not (Test-OpenAICCProxy)) { throw "Verification failed: OpenAI-CC proxy is not healthy." }
  $checks.Add("OpenAI-CC proxy + 700k model metadata")
  $checks.Add("RTK global integration")
  $checks.Add("TypeScript LSP plugin + language server")
  $checks.Add("Context Mode plugin")

  if ($ClaudeCodeRequested) {
    if (-not (Get-ClaudeCliCommand)) { throw "Verification failed: Claude Code was requested but the native CLI is unavailable." }
    $checks.Add("Claude Code CLI")
  }
  if ($VSCodeRequested) {
    if (-not (Test-VSCodeInstalled)) { throw "Verification failed: VS Code was requested but is unavailable." }
    $checks.Add("VS Code (Claude Code extension installation is manual)")
  }
  if ($DesktopRequested) {
    if (-not (Wait-ClaudeDesktopRegistration 10)) { throw "Verification failed: Claude Desktop was requested but is not registered." }
    $profile = Join-Path $env:LOCALAPPDATA "Claude-3p\configLibrary\00000000-0000-4000-8000-000000008082.json"
    if (-not (Test-Path $profile)) {
      $candidate = Get-ChildItem $env:LOCALAPPDATA -Directory -Filter "Claude*-3p*" -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "configLibrary\00000000-0000-4000-8000-000000008082.json" } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
      if (-not $candidate) { throw "Verification failed: Claude Desktop OpenAI-CC gateway profile missing." }
    }
    $checks.Add("Claude Desktop + Claude-3p gateway profile")
  }

  foreach ($check in $checks) { Write-Host "[OK] $check" -ForegroundColor Green }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "This installer targets native Windows PowerShell."
}

Write-Host "OpenAI-CC Windows installer" -ForegroundColor Cyan
Write-Host "Provider API keys and OAuth credentials are NOT requested here; add them later only in the OpenAI-CC admin panel." -ForegroundColor DarkGray

Clear-PendingConsoleInput
$installClaudeCode = Read-YesNo "Install Claude Code CLI?"
$installVSCode = Read-YesNo "Install/configure VS Code (Claude Code extension is manual)?"
$installClaudeDesktop = Read-YesNo "Install and configure Claude Desktop?"

$claudeDesktopWasRunning = $false
if ($installClaudeDesktop) { $claudeDesktopWasRunning = [bool](Get-Process -Name "Claude" -ErrorAction SilentlyContinue | Select-Object -First 1) }

Ensure-CoreDependencies
$script:GatewayDirectory = Resolve-GatewayDirectory

$projectsDirectory = Join-Path $HOME "Desktop\Claude"
New-Item -ItemType Directory -Force -Path $projectsDirectory | Out-Null
Write-Host "Projects directory: $projectsDirectory"

Ensure-ClaudeCode $installClaudeCode
Ensure-VSCode $installVSCode
Ensure-ClaudeDesktop $installClaudeDesktop
Configure-PersistentClaudeEnvironment $installClaudeDesktop
Build-AndConfigureGateway $installClaudeDesktop
Install-TokenOptimizationStack
Install-GatewayStartupShortcut
Start-OrVerifyGateway
Verify-Installation $installClaudeCode $installVSCode $installClaudeDesktop

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Gateway: $GatewayBaseUrl"
Write-Host "Admin panel: $GatewayBaseUrl/admin"
Write-Host "Projects: $projectsDirectory"
Write-Host "Claude Code token stack: RTK + official TypeScript LSP + Context Mode"
Write-Host "Effective auto-compaction capacity on 1M Claude-compatible routes: $ContextWindow tokens"
Write-Host "Provider credentials remain exclusively in the OpenAI-CC admin panel."
if ($installVSCode) {
  Write-Host "VS Code extension: install/enable anthropic.claude-code manually from Extensions; no VS Code code CLI command was run." -ForegroundColor Yellow
}
if ($installClaudeDesktop -and $claudeDesktopWasRunning) {
  Write-Host "Claude Desktop was running while its gateway profile changed. Restart Claude Desktop once before using the Code tab." -ForegroundColor Yellow
}
