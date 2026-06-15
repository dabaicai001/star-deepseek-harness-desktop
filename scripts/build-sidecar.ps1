#!/usr/bin/env pwsh
# Build Go sidecar for current platform
# Usage: pwsh scripts/build-sidecar.ps1 [-Release]

param(
    [switch]$Release
)

$ErrorActionPreference = "Stop"

$sidecarDir = Join-Path $PSScriptRoot ".." "sidecar"
$binDir = Join-Path $sidecarDir "bin"

# Ensure bin directory exists
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir | Out-Null
}

# Respect cross-compilation targets when provided.
$targetOS = if ($env:GOOS) { $env:GOOS } elseif ($IsWindows -or $env:OS -eq "Windows_NT") { "windows" } elseif ($IsMacOS) { "darwin" } else { "linux" }
$outputName = "starhub-sidecar"
if ($targetOS -eq "windows") {
    $outputName += ".exe"
}

$outputPath = Join-Path $binDir $outputName

# Build flags
$ldflags = "-s -w"
if ($Release -and $targetOS -eq "windows") {
    $ldflags += " -H windowsgui"
}

Write-Host "Building sidecar..." -ForegroundColor Cyan
Write-Host "  Source: $sidecarDir"
Write-Host "  Output: $outputPath"

Push-Location $sidecarDir
try {
    $env:CGO_ENABLED = "0"
    & go build -ldflags $ldflags -o $outputPath .
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Go build failed with exit code $LASTEXITCODE"
        exit 1
    }
    Write-Host "Sidecar built successfully: $outputPath" -ForegroundColor Green

    # 同步到 Tauri target 目录(dev 模式用)
    $projectRoot = Join-Path $PSScriptRoot ".."
    $targetDebug = Join-Path $projectRoot "src-tauri" "target" "debug"
    if (Test-Path $targetDebug) {
        Copy-Item $outputPath (Join-Path $targetDebug $outputName) -Force
        Write-Host "  Synced to $targetDebug" -ForegroundColor DarkGray
    }
} finally {
    Pop-Location
}
