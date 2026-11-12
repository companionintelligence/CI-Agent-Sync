[CmdletBinding()]
param(
    [string]$WorkspaceRoot,
    [string]$UnityEditorPath,
    [string]$UnrealEngineRoot = "C:\Program Files\Epic Games\UE_5.8",
    [int]$TimeoutSeconds = 900,
    [switch]$SkipAgentSync,
    [switch]$SkipUnity,
    [switch]$SkipUnreal,
    [switch]$SkipBlender,
    [switch]$SkipMetaHumanAutomation,
    [switch]$SkipCompanionAI
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Split-Path -Parent $AgentRoot
}
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path

$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$reportRoot = Join-Path $AgentRoot "local\game-engine-tests\$runId"
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
$script:failed = $false

function Resolve-Executable {
    param([Parameter(Mandatory = $true)][string]$Name, [string[]]$Candidates = @())
    foreach ($candidate in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command -and $command.Source) { return $command.Source }
    return $null
}

function Invoke-LoggedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [int]$Timeout = $TimeoutSeconds
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FilePath
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$psi.ArgumentList.Add([string]$argument) }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $startedAt = [DateTime]::UtcNow
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $completed = $process.WaitForExit($Timeout * 1000)
        if (-not $completed) {
            try { $process.Kill($true) } catch { }
            $process.WaitForExit()
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $exitCode = if ($completed) { $process.ExitCode } else { 124 }
        $logText = "COMMAND: $FilePath $($Arguments -join ' ')`r`nEXIT_CODE: $exitCode`r`n`r`n--- STDOUT ---`r`n$stdout`r`n--- STDERR ---`r`n$stderr`r`n"
        [System.IO.File]::WriteAllText($LogPath, $logText, [System.Text.UTF8Encoding]::new($false))
        return [pscustomobject]@{
            ExitCode = $exitCode
            TimedOut = (-not $completed)
            DurationSeconds = [math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 1)
            LogPath = $LogPath
        }
    } finally {
        $process.Dispose()
    }
}

function Add-Result {
    param([string]$Name, [string]$Status, [string]$Detail, [string]$LogPath = "")
    [void]$results.Add([pscustomobject]@{
        name = $Name
        status = $Status
        detail = $Detail
        log = $LogPath
    })
    $color = if ($Status -eq "pass") { "Green" } elseif ($Status -eq "fail") { "Red" } else { "Yellow" }
    Write-Host ("{0,-28} {1,-7} {2}" -f $Name, $Status.ToUpperInvariant(), $Detail) -ForegroundColor $color
    if ($Status -eq "fail") { $script:failed = $true }
}

function Run-ProcessCheck {
    param([string]$Name, [string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [string]$LogName, [int]$Timeout = $TimeoutSeconds)
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        Add-Result $Name "fail" "executable not found: $FilePath"
        return
    }
    $logPath = Join-Path $reportRoot $LogName
    $result = Invoke-LoggedProcess $FilePath $Arguments $WorkingDirectory $logPath $Timeout
    if ($result.TimedOut) {
        Add-Result $Name "fail" "timed out after $Timeout seconds" $logPath
    } elseif ($result.ExitCode -ne 0) {
        Add-Result $Name "fail" "exit $($result.ExitCode)" $logPath
    } else {
        Add-Result $Name "pass" "exit 0 ($($result.DurationSeconds)s)" $logPath
    }
}

function Run-UnityProject {
    param([string]$Name, [string]$ProjectRoot, [string]$UnityPath)
    if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
        Add-Result $Name "fail" "project missing: $ProjectRoot"
        return
    }
    $result = Invoke-LoggedProcess $UnityPath @("-batchmode", "-nographics", "-quit", "-logFile", "-", "-projectPath", $ProjectRoot) $ProjectRoot (Join-Path $reportRoot "$Name-unity-batch.log") $TimeoutSeconds
    $logText = if (Test-Path -LiteralPath $result.LogPath) { Get-Content -LiteralPath $result.LogPath -Raw } else { "" }
    $compileError = [regex]::Match($logText, '(?im)(error CS\d+|compilation failed|aborting batchmode due to failure)')
    if ($result.TimedOut) {
        Add-Result $Name "fail" "Unity timed out" $result.LogPath
    } elseif ($result.ExitCode -ne 0) {
        Add-Result $Name "fail" "Unity exit $($result.ExitCode)" $result.LogPath
    } elseif ($compileError.Success) {
        Add-Result $Name "fail" "Unity log contains compile failure: $($compileError.Value.Trim())" $result.LogPath
    } else {
        Add-Result $Name "pass" "batch import/compile completed" $result.LogPath
    }
}

function Run-UnrealLoad {
    param([string]$Name, [string]$ProjectPath, [string]$EditorCmd)
    if (-not (Test-Path -LiteralPath $ProjectPath -PathType Leaf)) {
        Add-Result $Name "fail" "project missing: $ProjectPath"
        return
    }
    # A bare -ExecCmds=Quit can still wait on Unreal's post-load asset-registry
    # and Derived Data Cache maintenance for several minutes. A Python commandlet
    # gives us a bounded project/module load probe that exits after initialization.
    $smokeScript = Join-Path $reportRoot "$Name.py"
    $smokeText = "import unreal`nunreal.log('CI_AGENT_SYNC_PROJECT_LOAD_OK')`n"
    [System.IO.File]::WriteAllText($smokeScript, $smokeText, [System.Text.UTF8Encoding]::new($false))
    $args = @(
        $ProjectPath,
        "-run=pythonscript",
        "-script=$smokeScript",
        "-unattended",
        "-nullrhi",
        "-nosplash",
        "-stdout",
        "-utf8output",
        "-NoLogTimes",
        "-NoSound",
        "-NoP4",
        "-ini:EditorPerProjectUserSettings:[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]:bAutoStartServer=False"
    )
    $result = Invoke-LoggedProcess $EditorCmd $args (Split-Path -Parent $ProjectPath) (Join-Path $reportRoot "$Name-unreal-load.log") $TimeoutSeconds
    $logText = if (Test-Path -LiteralPath $result.LogPath) { Get-Content -LiteralPath $result.LogPath -Raw } else { "" }
    $fatal = [regex]::Match($logText, '(?im)(LowLevelFatalError|Fatal error:|Assertion failed|Unhandled Exception)')
    if ($result.TimedOut) {
        Add-Result $Name "fail" "Unreal timed out" $result.LogPath
    } elseif ($result.ExitCode -ne 0) {
        Add-Result $Name "fail" "Unreal exit $($result.ExitCode)" $result.LogPath
    } elseif ($fatal.Success) {
        Add-Result $Name "fail" "fatal marker in Unreal log: $($fatal.Value.Trim())" $result.LogPath
    } else {
        Add-Result $Name "pass" "editor commandlet loaded project and quit" $result.LogPath
    }
}

$unityDefault = Join-Path $env:USERPROFILE "Unity\Hub\Editor\6000.3.19f1\Editor\Unity.exe"
$unityPath = if ([string]::IsNullOrWhiteSpace($UnityEditorPath)) { Resolve-Executable "Unity.exe" @($unityDefault) } else { Resolve-Executable "Unity.exe" @($UnityEditorPath) }
$unrealRoot = (Resolve-Path -LiteralPath $UnrealEngineRoot -ErrorAction SilentlyContinue).Path
$editorCmd = if ($unrealRoot) { Join-Path $unrealRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe" } else { $null }
$pwshPath = Resolve-Executable "pwsh.exe" @($PSHOME + "\pwsh.exe")
$uvxPath = Resolve-Executable "uvx.exe"
$npmPath = Resolve-Executable "npm.cmd"

if (-not $SkipAgentSync) {
    if ($npmPath) {
        $checks = @(
            @("agent-sync-test", @("test")),
            @("agent-sync-check", @("run", "check")),
            @("agent-sync-build", @("run", "build"))
        )
        foreach ($check in $checks) {
            Run-ProcessCheck $check[0] $npmPath $check[1] $AgentRoot ($check[0] + ".log") 300
        }
    } else {
        Add-Result "agent-sync" "fail" "npm.cmd not found"
    }
}

if (-not $SkipUnity) {
    if ($unityPath) {
        Run-UnityProject "unity-spatial" (Join-Path $WorkspaceRoot "CI-Spatial-Companion-Unity") $unityPath
        Run-UnityProject "unity-xr-scan" (Join-Path $WorkspaceRoot "CI-XR-Scan-Web-Unity") $unityPath
    } else {
        Add-Result "unity" "fail" "Unity 6000.3.19f1 not found"
    }
}

if (-not $SkipBlender) {
    $blenderRoot = Join-Path $WorkspaceRoot "_mcp-tools\mcp-for-blender"
    $pythonPath = Join-Path $blenderRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $pythonPath -PathType Leaf) {
        Run-ProcessCheck "blender-pytest" $pythonPath @("-m", "pytest", "-q") $blenderRoot "blender-pytest.log" 900
    } else {
        Add-Result "blender-pytest" "fail" "local virtualenv missing: $pythonPath"
    }
    if ($uvxPath) {
        Run-ProcessCheck "blender-mcp-cli" $uvxPath @("--from", "mcp-for-blender==2.2.7", "mcp-for-blender", "--help") $blenderRoot "blender-mcp-cli.log" 180
        Run-ProcessCheck "unity-mcp-cli" $uvxPath @("--from", "mcpforunityserver==10.3.0", "mcp-for-unity", "--help") $AgentRoot "unity-mcp-cli.log" 180
    } else {
        Add-Result "mcp-cli-smoke" "fail" "uvx not found"
    }
}

if (-not $SkipUnreal) {
    if ($editorCmd -and (Test-Path -LiteralPath $editorCmd -PathType Leaf)) {
        $metaHumanRoot = Join-Path $WorkspaceRoot "CI-MetaHuman"
        if ($SkipMetaHumanAutomation) {
            Add-Result "metahuman-automation" "skip" "disabled by -SkipMetaHumanAutomation"
        } elseif ($pwshPath) {
            Run-ProcessCheck "metahuman-backend" $pwshPath @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $metaHumanRoot "Scripts\RunBackendTests.ps1"), "-EngineDir", $unrealRoot) $metaHumanRoot "metahuman-backend.log" 1200
            Run-ProcessCheck "metahuman-frontend" $pwshPath @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $metaHumanRoot "Scripts\RunFrontendTests.ps1"), "-EngineDir", $unrealRoot) $metaHumanRoot "metahuman-frontend.log" 1200
        } else {
            Add-Result "metahuman-tests" "fail" "pwsh not found"
        }
        Run-UnrealLoad "metahuman-project-load" (Join-Path $metaHumanRoot "MetaHumanLocalLLM.uproject") $editorCmd
    } else {
        Add-Result "unreal" "fail" "UnrealEditor-Cmd.exe not found under $unrealRoot"
    }
}

$vibeRoot = Join-Path $WorkspaceRoot "VibeMetaHumans"
$vibePlugin = Join-Path $vibeRoot "VibeMetaHumans.uplugin"
if ((Test-Path -LiteralPath $vibePlugin -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $vibeRoot "Source") -PathType Container)) {
    Add-Result "vibemetahumans-source" "pass" "plugin source present; compiled by CI-MetaHuman tests"
} else {
    Add-Result "vibemetahumans-source" "fail" "plugin checkout is incomplete"
}

$propsRoot = Join-Path $WorkspaceRoot "CI-MetaHuman-Props\glb"
$glbCount = if (Test-Path -LiteralPath $propsRoot -PathType Container) { @(Get-ChildItem -LiteralPath $propsRoot -Filter *.glb -File).Count } else { 0 }
if ($glbCount -gt 0) { Add-Result "metahuman-props" "pass" "$glbCount local GLB assets present" } else { Add-Result "metahuman-props" "fail" "local GLB asset set missing" }

if (-not $SkipCompanionAI) {
    if ($editorCmd -and (Test-Path -LiteralPath $editorCmd -PathType Leaf)) {
        Run-UnrealLoad "companionai-project-load" (Join-Path $WorkspaceRoot "companionai\companionai.uproject") $editorCmd
    } else {
        Add-Result "companionai-project-load" "fail" "UnrealEditor-Cmd.exe unavailable"
    }
}

$summary = [ordered]@{
    generated_at = [DateTime]::UtcNow.ToString("o")
    report_root = $reportRoot
    passed = @($results | Where-Object status -eq "pass").Count
    failed = @($results | Where-Object status -eq "fail").Count
    skipped = @($results | Where-Object status -eq "skip").Count
    checks = @($results)
}
$summaryPath = Join-Path $reportRoot "summary.json"
[System.IO.File]::WriteAllText($summaryPath, (($summary | ConvertTo-Json -Depth 8) + "`r`n"), [System.Text.UTF8Encoding]::new($false))
Write-Host "Test report: $summaryPath"
if ($script:failed) { exit 1 }
exit 0
