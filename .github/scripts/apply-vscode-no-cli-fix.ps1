$ErrorActionPreference = "Stop"

function Replace-ExactlyOnce([string]$Text, [string]$Pattern, [string]$Replacement, [string]$Label) {
  $options = [Text.RegularExpressions.RegexOptions]::Multiline -bor [Text.RegularExpressions.RegexOptions]::Singleline
  $regex = [regex]::new($Pattern, $options)
  $matches = $regex.Matches($Text)
  if ($matches.Count -ne 1) { throw "$Label: expected exactly one match, found $($matches.Count)." }
  return $regex.Replace($Text, $Replacement, 1)
}

$setupPath = Join-Path $PSScriptRoot "..\..\setup.ps1"
$setupPath = [IO.Path]::GetFullPath($setupPath)
$setup = [IO.File]::ReadAllText($setupPath)

$newResolver = @'
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

'@
$setup = Replace-ExactlyOnce $setup '^function Get-VSCodeCommand \{.*?(?=^function Get-ClaudeCliCommand)' $newResolver 'Get-VSCodeCommand'

$newEnsure = @'
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

'@
$setup = Replace-ExactlyOnce $setup '^function Ensure-VSCode\(\[bool\]\$Requested\) \{.*?(?=^function Ensure-ClaudeDesktop)' $newEnsure 'Ensure-VSCode'

$newVerify = @'
  if ($VSCodeRequested) {
    if (-not (Test-VSCodeInstalled)) { throw "Verification failed: VS Code was requested but is unavailable." }
    $checks.Add("VS Code (Claude Code extension installation is manual)")
  }
'@
$setup = Replace-ExactlyOnce $setup '^  if \(\$VSCodeRequested\) \{.*?^  \}\r?\n(?=  if \(\$DesktopRequested\))' ($newVerify + "`r`n") 'VS Code verification'

$oldPrompt = '$installVSCode = Read-YesNo "Install VS Code and the Claude Code extension?"'
$newPrompt = '$installVSCode = Read-YesNo "Install/configure VS Code (Claude Code extension is manual)?"'
if (-not $setup.Contains($oldPrompt)) { throw "VS Code prompt not found." }
$setup = $setup.Replace($oldPrompt, $newPrompt)

$summaryAnchor = 'Write-Host "Provider credentials remain exclusively in the OpenAI-CC admin panel."'
if (-not $setup.Contains($summaryAnchor)) { throw "Final summary anchor not found." }
$summaryReplacement = @'
Write-Host "Provider credentials remain exclusively in the OpenAI-CC admin panel."
if ($installVSCode) {
  Write-Host "VS Code extension: install/enable anthropic.claude-code manually from Extensions; no VS Code code CLI command was run." -ForegroundColor Yellow
}
'@
$setup = $setup.Replace($summaryAnchor, $summaryReplacement.TrimEnd())
[IO.File]::WriteAllText($setupPath, $setup, [Text.UTF8Encoding]::new($false))

$testPath = Join-Path $PSScriptRoot "..\..\tests\claude-desktop.test.ts"
$testPath = [IO.Path]::GetFullPath($testPath)
$tests = [IO.File]::ReadAllText($testPath)
$oldPromptAssertion = 'assert.match(setup, /Install VS Code and the Claude Code extension\?/);'
$newPromptAssertion = 'assert.match(setup, /Install\/configure VS Code \(Claude Code extension is manual\)\?/);'
if (-not $tests.Contains($oldPromptAssertion)) { throw "Old VS Code prompt assertion not found." }
$tests = $tests.Replace($oldPromptAssertion, $newPromptAssertion)

$newCliTest = @'
test("PowerShell installer never invokes the VS Code code CLI", async () => {
  const setup = await readFile(path.join(process.cwd(), "setup.ps1"), "utf8");
  assert.match(setup, /function Test-VSCodeInstalled/);
  assert.match(setup, /Microsoft VS Code\\Code\.exe/);
  assert.match(setup, /Test-WingetPackageInstalled "Microsoft\.VisualStudioCode"/);
  assert.match(setup, /VS Code CLI automation intentionally skipped/);
  assert.match(setup, /install\/enable Claude Code \(anthropic\.claude-code\) manually/);
  assert.doesNotMatch(setup, /--list-extensions/);
  assert.doesNotMatch(setup, /--install-extension/);
  assert.doesNotMatch(setup, /Get-Command code(?:\.cmd)?/);
});

'@
$tests = Replace-ExactlyOnce $tests '^test\("PowerShell installer resolves the VS Code CLI shim instead of the GUI executable".*?(?=^test\("PowerShell native runner)' $newCliTest 'VS Code regression test'
[IO.File]::WriteAllText($testPath, $tests, [Text.UTF8Encoding]::new($false))

$setupCheck = [IO.File]::ReadAllText($setupPath)
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($setupPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) { throw "setup.ps1 parser errors: $($parseErrors.Message -join '; ')" }
foreach ($forbidden in @('--list-extensions', '--install-extension', 'Get-Command code ', 'Get-Command code.cmd')) {
  if ($setupCheck.Contains($forbidden)) { throw "Forbidden VS Code CLI usage remains: $forbidden" }
}
if ($setupCheck -notmatch 'function Test-VSCodeInstalled') { throw "Test-VSCodeInstalled missing." }
if ($setupCheck -notmatch 'extension installation is manual') { throw "Manual VS Code extension verification text missing." }

Write-Host "VS Code no-CLI installer patch applied and validated." -ForegroundColor Green
