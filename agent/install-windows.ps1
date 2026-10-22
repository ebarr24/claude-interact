# Registers the claude-interact agent as a logon task for the current user: hidden window,
# restarts if it crashes, output appended to agent.log next to this script.
# Usage: pwsh -File install-windows.ps1        (re-run to update; -Uninstall to remove)
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$taskName = 'claude-interact-agent'
$here = $PSScriptRoot

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task $taskName"
  return
}

if (-not (Test-Path "$here\config.json")) { throw "Create $here\config.json first (see config.example.json)." }
$node = (Get-Command node -ErrorAction Stop).Source

# wscript runs the agent with no console window and waits on it, so Task Scheduler sees the
# agent's exit code and can restart it.
$launcher = "$here\run-hidden.vbs"
@"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$here"
WScript.Quit sh.Run("cmd /c """"$node"" ""$here\agent.mjs"" >> ""$here\agent.log"" 2>&1""", 0, True)
"@ | Set-Content -Path $launcher -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'claude-interact machine agent (Claude Duet connector)' -Force | Out-Null

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started $taskName. Log: $here\agent.log"
