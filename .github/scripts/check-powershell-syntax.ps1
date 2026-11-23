# Parse-only check for the PowerShell scripts under scripts/. Nothing is executed.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path (Join-Path $PSScriptRoot '..') '..')).ProviderPath
$files = @(Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -Filter '*.ps1' -File -Recurse)
if ($files.Count -eq 0) {
    Write-Output 'no PowerShell scripts found under scripts/'
    exit 1
}
$problems = 0
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in $parseErrors) {
        $problems++
        Write-Output ('{0}:{1}: {2}' -f $file.Name, $parseError.Extent.StartLineNumber, $parseError.Message)
    }
}
if ($problems -gt 0) {
    Write-Output ('PowerShell syntax errors: {0}' -f $problems)
    exit 1
}
Write-Output ('PowerShell syntax ok: {0} files' -f $files.Count)
