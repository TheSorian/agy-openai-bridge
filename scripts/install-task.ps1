# Registers agy-openai-bridge as a hidden scheduled task that starts at logon.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall
#
# Why a scheduled task instead of a Startup shortcut: Task Scheduler starts the process without
# a console window, while a shortcut to node.exe leaves a minimized console in the taskbar.
# Pointing a startup entry at a .cmd/.vbs instead tends to get the script quarantined by
# antivirus software, which is what happened during development.
param(
  [string]$TaskName = "agy-openai-bridge",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
  schtasks /delete /tn $TaskName /f | Out-Null
  "removed task $TaskName"
  return
}

$user   = "$env:USERDOMAIN\$env:USERNAME"
$node   = (Get-Command node -ErrorAction Stop).Source
$root   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot "supervise.mjs"

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>agy-openai-bridge: the Antigravity CLI as an OpenAI-compatible endpoint on 127.0.0.1:8799</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$node</Command>
      <Arguments>"$script" --start</Arguments>
      <WorkingDirectory>$root</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$tmp = Join-Path $env:TEMP "agy-bridge-task.xml"
[IO.File]::WriteAllText($tmp, $xml, [Text.Encoding]::Unicode)
schtasks /create /tn $TaskName /xml $tmp /f | Out-Null
$code = $LASTEXITCODE
Remove-Item $tmp -Force
if ($code -ne 0) { throw "schtasks failed with $code" }

"registered $TaskName"
"  runs  : $node `"$script`" --start"
"  at    : logon of $user, hidden, no console window, single instance"
"  stop  : 'npm run stop' keeps it down until the next logon or manual start"
""
"Verify with:  schtasks /query /tn $TaskName /v /fo LIST"
