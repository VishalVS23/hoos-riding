# Runs the demo recorder from a Windows scheduled task (see CLAUDE.md, Decisions).
# Shows a pop-up, keeps the laptop awake while recording (30 min), records, then shows "done".
# Log: demo/record-log.txt
# Test with a short run:  powershell -File scripts\scheduled-record.ps1 -Minutes 1

param([int]$Minutes = 30, [string]$Name = '')  # -Name gameday saves demo/recording-gameday.json

$project = Split-Path -Parent $PSScriptRoot
Set-Location $project
Add-Type -AssemblyName PresentationFramework

function Show-Note($text) {
  # A separate window so the recording doesn't wait for you to click OK.
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-Command',
    "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('$text', 'HooMaps demo recording') | Out-Null"
  )
}

# Ask Windows not to sleep while this runs (cleared automatically when the script ends).
Add-Type -Namespace Win32 -Name Power -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
'@
# (Plain numbers: PowerShell reads 0x80000001 as negative, which Windows refuses.)
# DISPLAY_REQUIRED too: this laptop uses "Modern Standby", which ignores SYSTEM_REQUIRED once the
# screen turns off (game day 2026-11-14: standby cut the internet after 5 min). Keeping the screen on
# prevents that, but only while plugged in: on battery Windows can still force standby.
[Win32.Power]::SetThreadExecutionState(2147483651) | Out-Null  # CONTINUOUS | SYSTEM_REQUIRED | DISPLAY_REQUIRED

Show-Note "Recording $Minutes min of live UVA bus data for demo mode. Leave the laptop on (lid open, plugged in) and do NOT close the black window. You will get another pop-up when it is done."

& npm.cmd run record -- $Minutes $Name *> 'demo\record-log.txt'
$ok = $LASTEXITCODE -eq 0

[Win32.Power]::SetThreadExecutionState(2147483648) | Out-Null  # CONTINUOUS only = back to normal

if ($ok) {
  Show-Note 'Demo recording finished. Ask Claude Code to check demo/recording.json and commit it.'
} else {
  Show-Note 'Demo recording had a problem. Ask Claude Code to look at demo/record-log.txt.'
}
