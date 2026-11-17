<#
.SYNOPSIS
  Registers a per-user scheduled task that starts auto-push-git-app at logon.
.EXAMPLE
  # Single executable (no Node needed)
  .\install-task.ps1 -ExePath 'C:\Program Files\autopush\autopush-win-x64.exe'
.EXAMPLE
  # From a source checkout (needs Node 22.18+)
  .\install-task.ps1 -AppDir 'C:\Program Files\auto-push-git-app'
.NOTES
  Runs as the signed-in user (no elevation), which is what git credential
  helpers, the tray icon and the popup window need. Deploy via Intune/SCCM as the user.
#>
[CmdletBinding(DefaultParameterSetName = 'Exe')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Exe')]    [string] $ExePath,
  [Parameter(Mandatory, ParameterSetName = 'Source')] [string] $AppDir,
  [Parameter(ParameterSetName = 'Source')]            [string] $NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [string] $TaskName = 'AutoPushGitApp'
)
$ErrorActionPreference = 'Stop'

if ($PSCmdlet.ParameterSetName -eq 'Exe') {
  if (-not (Test-Path -LiteralPath $ExePath)) { throw "Not found: $ExePath" }
  $command = "& '$ExePath' run"
  $workDir = Split-Path -Parent (Resolve-Path -LiteralPath $ExePath)
} else {
  $cli = Join-Path $AppDir 'src\cli.ts'
  if (-not (Test-Path -LiteralPath $cli)) { throw "Not found: $cli" }
  $command = "& '$NodePath' '$cli' run"
  $workDir = $AppDir
}

# Hidden PowerShell wrapper so no console window stays open.
$arg = "-NoProfile -WindowStyle Hidden -Command `"$command`""
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $workDir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName'. It starts at next logon; start now with: Start-ScheduledTask -TaskName $TaskName"
