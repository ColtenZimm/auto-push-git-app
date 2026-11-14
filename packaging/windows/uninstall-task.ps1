[CmdletBinding()]
param([string] $TaskName = 'AutoPushGitApp')
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed '$TaskName'."
} else {
  Write-Host "Task '$TaskName' not found."
}
