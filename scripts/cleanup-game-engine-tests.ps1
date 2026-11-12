[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [string]$WorkspaceRoot,
    [switch]$RemoveTestReports,
    [switch]$RemovePythonCaches
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Split-Path -Parent $AgentRoot
}
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path

function Remove-SafeFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    if ($WhatIfPreference) {
        Write-Host "WHATIF     remove $Path"
        return
    }
    Remove-Item -LiteralPath $Path -Force
    Write-Host "removed    $Path"
}

function Remove-SafeDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $allowedRoots = @(
        [System.IO.Path]::GetFullPath((Join-Path $AgentRoot "local")).TrimEnd('\'),
        [System.IO.Path]::GetFullPath((Join-Path $WorkspaceRoot "_mcp-tools\mcp-for-blender")).TrimEnd('\')
    )
    $allowed = @($allowedRoots | Where-Object { $fullPath.StartsWith($_ + '\', [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    if (-not $allowed) {
        throw "Refusing recursive cleanup outside the approved local/cache roots: $fullPath"
    }
    if ($WhatIfPreference) {
        Write-Host "WHATIF     remove directory $Path"
        return
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
    Write-Host "removed    $Path"
}

# These are known one-off logs from the earlier editor smoke/upgrade pass. The
# cleanup intentionally does not touch Unity Library, Unreal Intermediate,
# DerivedDataCache, Saved, generated stage content, or any Git-tracked source.
$knownFiles = @(
    (Join-Path $WorkspaceRoot "CI-Spatial-Companion-Unity\mcp-editor-smoke.log"),
    (Join-Path $WorkspaceRoot "CI-Spatial-Companion-Unity\upgrade-6000.3.19f1.log"),
    (Join-Path $WorkspaceRoot "CI-Spatial-Companion-Unity\upgrade-6000.6.9f1.log"),
    (Join-Path $WorkspaceRoot "CI-XR-Scan-Web-Unity\mcp-editor-smoke.log"),
    (Join-Path $WorkspaceRoot "CI-XR-Scan-Web-Unity\upgrade-6000.3.19f1.log"),
    (Join-Path $WorkspaceRoot "CI-XR-Scan-Web-Unity\upgrade-6000.6.9f1.log")
)
foreach ($path in $knownFiles) { Remove-SafeFile $path }

if ($RemovePythonCaches) {
    Remove-SafeDirectory (Join-Path $WorkspaceRoot "_mcp-tools\mcp-for-blender\.pytest_cache")
    Get-ChildItem -LiteralPath (Join-Path $WorkspaceRoot "_mcp-tools\mcp-for-blender") -Directory -Filter __pycache__ -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-SafeDirectory $_.FullName }
}

if ($RemoveTestReports) {
    Remove-SafeDirectory (Join-Path $AgentRoot "local\game-engine-tests")
}

Write-Host "Cleanup complete. Engine caches, generated stage content, backups, and existing user changes were preserved." -ForegroundColor Green
