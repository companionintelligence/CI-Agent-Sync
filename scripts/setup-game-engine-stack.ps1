[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [string]$WorkspaceRoot,
    [string]$UnityEditorPath,
    [string]$UnrealEngineRoot,
    [string]$BlenderExecutable,
    [string]$UnityEditorVersion = "6000.3.19f1",
    [string]$UnityEditorRevision = "7689f4515d75",
    [string]$UnityMcpVersion = "10.3.0",
    [string]$BlenderMcpVersion = "2.2.7",
    [switch]$SkipPackageSmoke
)

$ErrorActionPreference = "Stop"

$AgentRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Split-Path -Parent $AgentRoot
}
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path

function Resolve-Executable {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Candidates = @()
    )

    foreach ($candidate in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
        return $command.Source
    }
    return $null
}

function Read-FileText {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.File]::ReadAllText($Path)
}

function Write-FileTextIfChanged {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Reason
    )

    $current = if (Test-Path -LiteralPath $Path -PathType Leaf) { Read-FileText $Path } else { $null }
    if ($current -ceq $Text) {
        Write-Host "unchanged  $Path"
        return
    }

    if ($WhatIfPreference) {
        Write-Host "WHATIF     $Reason -> $Path"
        return
    }

    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
    Write-Host "updated    $Path"
}

function Replace-FirstMatch {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][scriptblock]$Replacement,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $match = [System.Text.RegularExpressions.Regex]::Match($Text, $Pattern)
    if (-not $match.Success) {
        throw "Could not find $Description. The project file format may have changed."
    }
    $replacementText = & $Replacement $match
    return $Text.Remove($match.Index, $match.Length).Insert($match.Index, [string]$replacementText)
}

function Update-UnityProjectVersion {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $path = Join-Path $ProjectRoot "ProjectSettings\ProjectVersion.txt"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path" }
    $text = Read-FileText $path
    $text = [regex]::Replace($text, '(?m)^m_EditorVersion:\s*.*$', "m_EditorVersion: $UnityEditorVersion")
    if ($text -match '(?m)^m_EditorVersionWithRevision:') {
        $text = [regex]::Replace($text, '(?m)^m_EditorVersionWithRevision:\s*.*$', "m_EditorVersionWithRevision: $UnityEditorVersion ($UnityEditorRevision)")
    } else {
        $suffix = if ($text.EndsWith("`n") -or $text.EndsWith("`r")) { "" } else { "`r`n" }
        $text = "$text${suffix}m_EditorVersionWithRevision: $UnityEditorVersion ($UnityEditorRevision)`r`n"
    }
    Write-FileTextIfChanged $path $text "pin Unity editor $UnityEditorVersion"
}

function Update-UnityMcpPackage {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $packageUrl = "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v$UnityMcpVersion"
    $manifestPath = Join-Path $ProjectRoot "Packages\manifest.json"
    $lockPath = Join-Path $ProjectRoot "Packages\packages-lock.json"
    foreach ($path in @($manifestPath, $lockPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path" }
    }

    $manifest = Read-FileText $manifestPath
    $manifestPattern = '(?m)^(\s*)"com\.coplaydev\.unity-mcp"\s*:\s*"[^"]+"\s*(,?)\s*$'
    $manifest = Replace-FirstMatch $manifest $manifestPattern {
        param($match)
        $match.Groups[1].Value + '"com.coplaydev.unity-mcp": "' + $packageUrl + '"' + $match.Groups[2].Value
    } "com.coplaydev.unity-mcp in manifest.json"
    Write-FileTextIfChanged $manifestPath $manifest "pin Coplay Unity MCP $UnityMcpVersion"

    $lock = Read-FileText $lockPath
    $lockPattern = '(?ms)("com\.coplaydev\.unity-mcp"\s*:\s*\{.*?"version"\s*:\s*)"[^"]+"'
    $lock = Replace-FirstMatch $lock $lockPattern {
        param($match)
        $match.Groups[1].Value + '"' + $packageUrl + '"'
    } "com.coplaydev.unity-mcp version in packages-lock.json"
    Write-FileTextIfChanged $lockPath $lock "pin Coplay Unity MCP lock entry $UnityMcpVersion"
}

function Invoke-PackageSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$UvxPath,
        [Parameter(Mandatory = $true)][string]$Package,
        [Parameter(Mandatory = $true)][string]$Command
    )

    Write-Host "smoke      uvx --from $Package $Command --help"
    $null = & $UvxPath --from $Package $Command --help 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Package smoke failed for $Package (exit $LASTEXITCODE)."
    }
}

$unityDefault = Join-Path $env:USERPROFILE "Unity\Hub\Editor\$UnityEditorVersion\Editor\Unity.exe"
$unityPath = if ([string]::IsNullOrWhiteSpace($UnityEditorPath)) { Resolve-Executable "Unity.exe" @($unityDefault) } else { Resolve-Executable "Unity.exe" @($UnityEditorPath) }
$unrealDefault = "C:\Program Files\Epic Games\UE_5.8"
$unrealRoot = if ([string]::IsNullOrWhiteSpace($UnrealEngineRoot)) { @($unrealDefault) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1 } else { (Resolve-Path -LiteralPath $UnrealEngineRoot).Path }
$blenderDefault = "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"
$blenderPath = if ([string]::IsNullOrWhiteSpace($BlenderExecutable)) { Resolve-Executable "blender.exe" @($blenderDefault) } else { Resolve-Executable "blender.exe" @($BlenderExecutable) }
$uvxPath = Resolve-Executable "uvx.exe"

if (-not $unityPath) { throw "Unity $UnityEditorVersion was not found. Pass -UnityEditorPath explicitly." }
if (-not $unrealRoot) { throw "Unreal Engine 5.8 was not found. Pass -UnrealEngineRoot explicitly." }
if (-not $blenderPath) { throw "Blender was not found. Pass -BlenderExecutable explicitly." }
if (-not $uvxPath) { throw "uvx was not found. Install uv before running setup." }

$unrealBuildVersionPath = Join-Path $unrealRoot "Engine\Build\Build.version"
$unrealBuildVersion = if (Test-Path -LiteralPath $unrealBuildVersionPath -PathType Leaf) { Get-Content -LiteralPath $unrealBuildVersionPath -Raw | ConvertFrom-Json } else { $null }
if ($null -eq $unrealBuildVersion -or $unrealBuildVersion.MinorVersion -ne 8) {
    throw "Expected an Unreal 5.8 installation at $unrealRoot."
}

$unityProjects = @(
    (Join-Path $WorkspaceRoot "CI-Spatial-Companion-Unity"),
    (Join-Path $WorkspaceRoot "CI-XR-Scan-Web-Unity")
)
foreach ($projectRoot in $unityProjects) {
    if (-not (Test-Path -LiteralPath $projectRoot -PathType Container)) { throw "Missing Unity project $projectRoot" }
    Update-UnityProjectVersion $projectRoot
    Update-UnityMcpPackage $projectRoot
}

$metaHumanRoot = Join-Path $WorkspaceRoot "CI-MetaHuman"
$metaHumanProject = Join-Path $metaHumanRoot "MetaHumanLocalLLM.uproject"
if (-not (Test-Path -LiteralPath $metaHumanProject -PathType Leaf)) { throw "Missing $metaHumanProject" }
foreach ($plugin in @("VibeUE", "VibeMetaHumans")) {
    if (-not (Test-Path -LiteralPath (Join-Path $metaHumanRoot "Plugins\$plugin") -PathType Container)) {
        throw "Missing vendored Unreal plugin $plugin"
    }
}
$engineIni = Join-Path $metaHumanRoot "Config\DefaultEditorPerProjectUserSettings.ini"
$engineIniText = Read-FileText $engineIni
if ($engineIniText -notmatch '(?m)^ServerPortNumber=8000\r?$') { Write-Warning "CI-MetaHuman does not declare ServerPortNumber=8000 in DefaultEditorPerProjectUserSettings.ini." }

$blenderAddon = Join-Path $env:APPDATA "Blender Foundation\Blender\5.1\scripts\addons\addon.py"
if (-not (Test-Path -LiteralPath $blenderAddon -PathType Leaf)) {
    Write-Warning "Blender MCP add-on was not found at $blenderAddon. Install with: uvx mcp-for-blender install-addon"
}

if (-not $SkipPackageSmoke) {
    Invoke-PackageSmoke $uvxPath "mcpforunityserver==$UnityMcpVersion" "mcp-for-unity"
    Invoke-PackageSmoke $uvxPath "mcp-for-blender==$BlenderMcpVersion" "mcp-for-blender"
}

$profilePath = Join-Path $AgentRoot "profiles\machines\local.yaml"
if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
    $yamlRoot = $WorkspaceRoot -replace '\\', '/'
    $yamlUnity = $unityPath -replace '\\', '/'
    $yamlUnreal = $unrealRoot -replace '\\', '/'
    $yamlBlender = $blenderPath -replace '\\', '/'
    $profileText = @"
version: 1
name: windows-game-engine
platform: windows
architecture: x86_64
paths:
  ci_root: "$yamlRoot"
  ci_meta_human: "`$`{CI_ROOT`}/CI-MetaHuman"
  ci_spatial_unity: "`$`{CI_ROOT`}/CI-Spatial-Companion-Unity"
  ci_xr_scan_unity: "`$`{CI_ROOT`}/CI-XR-Scan-Web-Unity"
  unity_editor: "$yamlUnity"
  unreal_engine: "$yamlUnreal"
  blender_executable: "$yamlBlender"
capabilities:
  docker: true
  node: true
  python: true
  unity: true
  unreal: true
  blender: true
  vscode: true
"@
    Write-FileTextIfChanged $profilePath $profileText "create local Windows game-engine profile"
} else {
    Write-Host "unchanged  $profilePath"
}

$report = [ordered]@{
    generated_at = [DateTime]::UtcNow.ToString("o")
    workspace_root = $WorkspaceRoot
    unity_editor = $unityPath
    unity_version = $UnityEditorVersion
    unity_mcp = $UnityMcpVersion
    unreal_engine = $unrealRoot
    unreal_version = "$($unrealBuildVersion.MajorVersion).$($unrealBuildVersion.MinorVersion).$($unrealBuildVersion.PatchVersion)"
    blender = $blenderPath
    blender_mcp = $BlenderMcpVersion
    local_profile = $profilePath
    projects = @($unityProjects + $metaHumanRoot)
}
$reportPath = Join-Path $AgentRoot "local\game-engine-setup.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportPath) | Out-Null
Write-FileTextIfChanged $reportPath (($report | ConvertTo-Json -Depth 5) + "`r`n") "write local game-engine setup report"

Write-Host "Game-engine setup verification complete." -ForegroundColor Green
Write-Host "Unity:   $unityPath"
Write-Host "Unreal:  $unrealRoot"
Write-Host "Blender: $blenderPath"
