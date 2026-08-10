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
  # Windows PowerShell 5.1 turns native stderr redirected with 2>&1 into
  # non-terminating ErrorRecords. With the installer's global Stop preference,
  # ordinary progress such as Git's "Cloning into..." can otherwise abort setup.
  # Temporarily use Continue here and decide success only from the process exit code.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Command @Arguments 2>&1 | Out-Host
    return [int]$LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Clear-PendingConsoleInput {
  try {
    if (-not [Console]::IsInputRedirected) {
      while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
    }
  } catch {
    # Some hosts do not expose KeyAvailable. Read-YesNo still rejects blank input.
  }
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
          # Ignore Enter and every other buffered/accidental key. Only Y or N completes the prompt.
        }
      }
    } catch [System.OperationCanceledException] {
      throw
    } catch {
      # Fall back for hosts such as ISE or redirected terminals.
    }

    $answer = (Read-Host).Trim()
    if ($answer -match '^(?i:y|yes)$') { return $true }
    if ($answer -match '^(?i:n|no)$') { return $false }
    # Empty strings (including stray Enter presses) are intentionally ignored.
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($machinePath, $userPath) | Where-Object { $_ }
  $env:Path = ($parts -join ";")
}

function Add-UserPath([string]$Directory) {
  if (-not $Directory) { return }
  $Directory = [IO.Path]::GetFullPath($Directory)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
  if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') })) {
    $newPath = (@($entries) + $Directory) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  }
  Refresh-ProcessPath
}

function Set-PersistentEnvironment([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Set-Item -Path "Env:$Name" -Value $Value
}

function Remove-OldOpenAICCContextOverrides {
  foreach ($name in @("CLAUDE_CODE_CONTEXT_WINDOW", "CLAUDE_CODE_MAX_CONTEXT_TOKENS")) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if ($value -eq [string]$ContextWindow) {
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
  & $winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "$Label installation failed (WinGet exit code $LASTEXITCODE)." }
  Refresh-ProcessPath
}

function Invoke-WingetUpgrade([string]$Id, [string]$Label) {
  $winget = Get-Winget
  Write-Host "Upgrading $Label because the installed version is below the required minimum..."
  & $winget upgrade --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "$Label upgrade failed (WinGet exit code $LASTEXITCODE)." }
  Refresh-ProcessPath
}

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

  foreach ($root in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )) {
    try {
      $entry = Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object {
        ($_.DisplayName -match "^Claude( Desktop)?$") -and (($_.Publisher -match "Anthropic") -or ($_.UninstallString -match "AnthropicClaude"))
      } | Select-Object -First 1
      if ($entry) { return $true }
    } catch { }
  }
  return $false
}

function Get-VSCodeCommand {
  $command = Get-Command code -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\bin\code.cmd")
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft VS Code\bin\code.cmd") }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Test-OpenAICCProxy {
  try {
    $health = Invoke-RestMethod -Uri "$GatewayBaseUrl/healthz" -TimeoutSec 2
    return [bool]$health.ok
  } catch {
    return $false
  }
}

function Ensure-CoreDependencies {
  Write-Step "Dependencies"

  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) { Invoke-WingetInstall "Git.Git" "Git for Windows" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is still unavailable after installation." }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Invoke-WingetInstall "OpenJS.NodeJS.LTS" "Node.js LTS"
  } else {
    $versionText = (& node --version).Trim().TrimStart('v')
    $version = [Version]$versionText
    if ($version -lt $MinimumNodeVersion) {
      Invoke-WingetUpgrade "OpenJS.NodeJS.LTS" "Node.js LTS"
    }
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is unavailable after installation." }
  if ([Version]((& node --version).Trim().TrimStart('v')) -lt $MinimumNodeVersion) {
    throw "Node.js $MinimumNodeVersion or newer is required for the installed token-optimization stack; found $(& node --version)."
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is unavailable after installing Node.js." }

  if (-not (Get-Command rg -ErrorAction SilentlyContinue)) {
    Invoke-WingetInstall "BurntSushi.ripgrep.MSVC" "ripgrep"
  }
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
  if (-not $Requested) {
    Write-Host "Claude Code CLI: skipped by user." -ForegroundColor DarkGray
    return
  }
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "Claude Code CLI already installed; leaving the installed version untouched." -ForegroundColor DarkGray
    return
  }
  Invoke-WingetInstall "Anthropic.ClaudeCode" "Claude Code"
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    $nativeClaude = Join-Path $HOME ".local\bin\claude.exe"
    if (Test-Path $nativeClaude) { Add-UserPath (Split-Path $nativeClaude -Parent) }
  }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code installation completed but 'claude' is not on PATH." }
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
  if (-not $Requested) {
    Write-Host "VS Code + Claude Code extension: skipped by user." -ForegroundColor DarkGray
    return
  }
  $code = Get-VSCodeCommand
  if (-not $code) {
    Invoke-WingetInstall "Microsoft.VisualStudioCode" "Visual Studio Code"
    $code = Get-VSCodeCommand
  } else {
    Write-Host "VS Code already installed; leaving the installed version untouched." -ForegroundColor DarkGray
  }
  if (-not $code) { throw "VS Code is installed but code.cmd could not be found." }

  $extensions = @(& $code --list-extensions 2>$null)
  if ($extensions -contains "anthropic.claude-code") {
    Write-Host "Claude Code VS Code extension already installed; leaving it untouched." -ForegroundColor DarkGray
  } else {
    Write-Host "Installing Claude Code VS Code extension..."
    & $code --install-extension anthropic.claude-code
    if ($LASTEXITCODE -ne 0) { throw "Claude Code VS Code extension installation failed." }
  }
  Configure-VSCodeClaudeSettings
}

function Ensure-ClaudeDesktop([bool]$Requested) {
  if (-not $Requested) {
    Write-Host "Claude Desktop: skipped by user." -ForegroundColor DarkGray
    return
  }
  if (Test-ClaudeDesktopInstalled) {
    Write-Host "Claude Desktop already installed; leaving the installed version untouched." -ForegroundColor DarkGray
  } else {
    Invoke-WingetInstall "Anthropic.Claude" "Claude Desktop"
  }
  if (-not (Test-ClaudeDesktopInstalled)) { throw "Claude Desktop is still not detectable after installation." }
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
    Add-UserPath $binDir
    $rtk = Get-Command rtk -ErrorAction SilentlyContinue
  } else {
    Write-Host "RTK already installed; leaving the binary version untouched." -ForegroundColor DarkGray
  }
  if (-not $rtk) { throw "RTK could not be installed." }

  & $rtk.Source init -g --auto-patch
  if ($LASTEXITCODE -ne 0) { throw "RTK Claude Code integration failed." }
  & $rtk.Source init --show
  if ($LASTEXITCODE -ne 0) { throw "RTK integration verification failed." }
}

function Get-ClaudeRunner {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if ($claude) { return @{ Command = $claude.Source; Prefix = @() } }
  $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npx) { $npx = Get-Command npx -ErrorAction SilentlyContinue }
  if (-not $npx) { throw "Neither Claude Code nor npx is available to configure Claude Code plugins." }
  # Transient runner only; this does not install Claude Code globally when the user answered N.
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
  } catch {
    return $false
  }
}

function Install-ClaudePlugin([hashtable]$Runner, [string]$PluginId, [string]$MarketplaceSource) {
  if (Test-PluginEnabled $PluginId) {
    Write-Host "$PluginId already enabled; leaving it installed." -ForegroundColor DarkGray
    return
  }

  $exit = Invoke-ClaudeRunner $Runner @("plugin", "install", $PluginId, "--scope", "user")
  if ($exit -ne 0 -and $MarketplaceSource) {
    Write-Host "Registering plugin marketplace $MarketplaceSource..."
    $marketExit = Invoke-ClaudeRunner $Runner @("plugin", "marketplace", "add", $MarketplaceSource, "--scope", "user")
    if ($marketExit -ne 0) {
      # It may already exist but be stale; updating is safe and idempotent.
      [void](Invoke-ClaudeRunner $Runner @("plugin", "marketplace", "update"))
    }
    $exit = Invoke-ClaudeRunner $Runner @("plugin", "install", $PluginId, "--scope", "user")
  }
  if ($exit -ne 0) { throw "Failed to install Claude Code plugin $PluginId." }
}

function Install-TokenOptimizationStack {
  Write-Step "Claude Code token optimization"

  if (-not (Get-Command typescript-language-server -ErrorAction SilentlyContinue)) {
    Write-Host "Installing TypeScript language server..."
    & npm install -g typescript typescript-language-server
    if ($LASTEXITCODE -ne 0) { throw "typescript-language-server installation failed." }
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
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "OpenAI-CC build failed." }

    $env:OPENAI_CC_CONFIGURE_CLAUDE_DESKTOP = $(if ($DesktopRequested) { "1" } else { "0" })
    $env:OPENAI_CC_CONTEXT_WINDOW = [string]$ContextWindow
    & node dist/scripts/configure-clients.js
    if ($LASTEXITCODE -ne 0) { throw "OpenAI-CC client configuration failed." }
  } finally {
    Pop-Location
  }
}

function Start-OrVerifyGateway {
  Write-Step "Gateway startup"
  if (-not (Test-OpenAICCProxy)) {
    $runScript = Join-Path $script:GatewayDirectory "run-gateway.ps1"
    if (-not (Test-Path $runScript)) { throw "Missing run-gateway.ps1." }
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $runScript) -WindowStyle Hidden | Out-Null
  } else {
    Write-Host "OpenAI-CC proxy already running; leaving it in place." -ForegroundColor DarkGray
  }

  $healthy = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-OpenAICCProxy) { $healthy = $true; break }
  }
  if (-not $healthy) { throw "OpenAI-CC did not become healthy at $GatewayBaseUrl/healthz." }

  # Ensure an already-running proxy also persists the requested 700k gateway metadata.
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
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Verification failed: Claude Code was requested but is unavailable." }
    $checks.Add("Claude Code CLI")
  }
  if ($VSCodeRequested) {
    $code = Get-VSCodeCommand
    if (-not $code) { throw "Verification failed: VS Code was requested but is unavailable." }
    $extensions = @(& $code --list-extensions 2>$null)
    if ($extensions -notcontains "anthropic.claude-code") { throw "Verification failed: Claude Code VS Code extension missing." }
    $checks.Add("VS Code + Claude Code extension")
  }
  if ($DesktopRequested) {
    if (-not (Test-ClaudeDesktopInstalled)) { throw "Verification failed: Claude Desktop was requested but is unavailable." }
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

# Flush stale keystrokes before the first choice, then accept only explicit Y or N for every choice.
Clear-PendingConsoleInput
$installClaudeCode = Read-YesNo "Install Claude Code CLI?"
$installVSCode = Read-YesNo "Install VS Code and the Claude Code extension?"
$installClaudeDesktop = Read-YesNo "Install and configure Claude Desktop?"

$claudeDesktopWasRunning = $false
if ($installClaudeDesktop) {
  $claudeDesktopWasRunning = [bool](Get-Process -Name "Claude" -ErrorAction SilentlyContinue | Select-Object -First 1)
}

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
if ($installClaudeDesktop -and $claudeDesktopWasRunning) {
  Write-Host "Claude Desktop was running while its gateway profile changed. Restart Claude Desktop once before using the Code tab." -ForegroundColor Yellow
}
