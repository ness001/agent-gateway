#Requires -Version 7
<#
.SYNOPSIS
    Builds and installs the Agent Gateway extension for the current user (no admin rights).
.PARAMETER CodeCommand
    VS Code CLI to install with, e.g. 'code' (default) or 'code-insiders'.
.PARAMETER Dev
    Build and install the side-by-side dev variant (ness001.agent-gateway-dev, port 24445).
.PARAMETER PackageOnly
    Build the VSIX but do not install it.
#>
[CmdletBinding()]
param(
    [string]$CodeCommand = 'code',
    [switch]$Dev,
    [switch]$PackageOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Invoke-Native([string]$Name, [string]$Command, [string[]]$Arguments) {
    Write-Host "==> $Command $($Arguments -join ' ')" -ForegroundColor Cyan
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)." }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22 or later is required (node not found on PATH).' }
$nodeVersion = [version]((& node --version).TrimStart('v'))
if ($nodeVersion.Major -lt 22) { throw "Node.js 22 or later is required (found $nodeVersion)." }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm is required. Install it with: corepack enable pnpm  (or npm install -g pnpm)'
}
if (-not $PackageOnly -and -not (Get-Command $CodeCommand -ErrorAction SilentlyContinue)) {
    throw "VS Code CLI '$CodeCommand' not found on PATH. Use -CodeCommand or -PackageOnly."
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Invoke-Native 'install' 'pnpm' @('install', '--frozen-lockfile')
if ($Dev) {
    Invoke-Native 'package dev variant' 'pnpm' @('run', 'package:dev')
    $vsix = Join-Path $root "agent-gateway-dev-$version.vsix"
}
else {
    Invoke-Native 'build' 'pnpm' @('run', 'build:prod')
    $vsix = Join-Path $root "agent-gateway-$version.vsix"
    Invoke-Native 'package' 'pnpm' @('exec', 'vsce', 'package', '--no-dependencies', '-o', $vsix)
}
if (-not (Test-Path $vsix)) { throw "Expected VSIX not found: $vsix" }
Write-Host "Packaged $vsix" -ForegroundColor Green

if ($PackageOnly) {
    Write-Host "Install later with: $CodeCommand --install-extension `"$vsix`" --force"
    return
}
Invoke-Native 'install extension' $CodeCommand @('--install-extension', $vsix, '--force')

if ($Dev) {
    # Running dev builds watch this file and restart their extension host.
    $trigger = Join-Path ([IO.Path]::GetTempPath()) 'agent-gateway-dev.reload'
    Set-Content -Path $trigger -Value (Get-Date -Format o)
    Write-Host 'Signalled running dev windows to restart their extension host.' -ForegroundColor Green
}

$port = if ($Dev) { 24445 } else { 24444 }
Write-Host ''
Write-Host 'Installed. Next steps:' -ForegroundColor Green
Write-Host '  1. Reload VS Code (Developer: Reload Window) or restart it.'
Write-Host '  2. Approve the GitHub Copilot language-model access prompt when it appears.'
Write-Host "  3. Run 'Agent Gateway: Status' and check it is Ready on http://127.0.0.1:$port."
