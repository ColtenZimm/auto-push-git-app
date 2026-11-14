<#
.SYNOPSIS
  Registers a per-user scheduled task that starts auto-push-git-app at logon.
.EXAMPLE
  .\install-task.ps1 -AppDir 'C:\Program Files\auto-push-git-app'
.NOTES
  Runs as the signed-in user (no elevation), which is what git credential
  helpers and the popup window need. Deploy via Intune/SCCM as the user.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $AppDir,
  [string] $NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [string] $TaskName = 'AutoPushGitApp'
)
$ErrorActionPreference = 'Stop'

$cli = Join-Path $AppDir 'src\cli.ts'
if (-not (Test-Path -LiteralPath $cli)) { throw "Not found: $cli" }

# Hidden PowerShell wrapper so no console window stays open.
$arg = "-NoProfile -WindowStyle Hidden -Command `"& '$NodePath' '$cli' run`""
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $AppDir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName'. It starts at next logon; start now with: Start-ScheduledTask -TaskName $TaskName"
