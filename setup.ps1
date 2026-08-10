$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20+ is required. Install Node.js, then run this script again."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required. Install Node.js with npm, then run this script again."
}

$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20+ is required; found $(node --version)." }

npm install
npm run build

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host 'Add a teammate with: npm run account:add -- --id faseeh --name "Faseeh"'
Write-Host 'Then run: .\run-claude.ps1'
