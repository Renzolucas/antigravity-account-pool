param(
    [Parameter(Mandatory)][ValidateSet('Login','Project')][string]$Mode,
    [string]$ProjectPath,
    [int]$Port = 18454,
    [switch]$ContinueConversation,
    [switch]$SkipPermissions
)

$ErrorActionPreference = 'Stop'
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
$launchScript = Join-Path $PSScriptRoot 'Launch-Agy.ps1'
$argsForWindow = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
    '-File', ('"' + $launchScript + '"'), '-Mode', $Mode
)
if ($Mode -eq 'Project') {
    $argsForWindow += @('-ProjectPath', ('"' + $ProjectPath + '"'), '-Port', [string]$Port)
    if ($ContinueConversation) { $argsForWindow += '-ContinueConversation' }
    if ($SkipPermissions) { $argsForWindow += '-SkipPermissions' }
}
$workingDirectory = if ($Mode -eq 'Project') { $ProjectPath } else { $PSScriptRoot }
$process = Start-Process -FilePath $pwshPath -ArgumentList $argsForWindow `
    -WorkingDirectory $workingDirectory -WindowStyle Normal -PassThru
Write-Output $process.Id
