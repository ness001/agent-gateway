#Requires -Version 7
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Invoke-Step([string]$Name, [string[]]$Arguments) {
    Write-Host "==> pnpm $($Arguments -join ' ')" -ForegroundColor Cyan
    & pnpm @Arguments
    if ($LASTEXITCODE -ne 0) { Write-Error "$Name failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
}

if (-not (Test-Path node_modules)) { Invoke-Step 'install' @('install', '--frozen-lockfile') }
Invoke-Step 'check-types' @('run', 'check-types')
Invoke-Step 'lint' @('run', 'lint')
Write-Host '==> node --test scripts/scripts.test.mjs' -ForegroundColor Cyan
& node --test scripts/scripts.test.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "script tests failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
Invoke-Step 'build-tests' @('run', 'build-tests')
Invoke-Step 'build' @('run', 'build')
Write-Host '==> node scripts/check-bundle.mjs' -ForegroundColor Cyan
& node scripts/check-bundle.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "check-bundle failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
Invoke-Step 'test' @('test')
# The budget applies to the minified production bundle, not the dev build above.
Invoke-Step 'build:prod' @('run', 'build:prod')
Write-Host '==> node scripts/bundle-budget.mjs --strict' -ForegroundColor Cyan
& node scripts/bundle-budget.mjs --strict
if ($LASTEXITCODE -ne 0) { Write-Error "bundle-budget failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
Write-Host 'All extension checks passed.' -ForegroundColor Green
