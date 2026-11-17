# Registers agy-openai-bridge as a hidden scheduled task that starts at logon.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall
#
# The task runs wscript, which is a GUI host: no console window is ever created, and it in turn
# starts node with a hidden window (see scripts\start-hidden.vbs). Starting node.exe directly from
# Task Scheduler does create a console, and Windows Terminal shows it even though the task is
# marked hidden.
#
# A shortcut or a .cmd/.vbs inside shell:startup is not used: script files there get quarantined
# (Bitdefender removed this project's .vbs and then its .cmd during development).
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

$user    = "$env:USERDOMAIN\$env:USERNAME"
$root    = Split-Path -Parent $PSScriptRoot
$vbs     = Join-Path $PSScriptRoot "start-hidden.vbs"
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"

if (-not (Test-Path $vbs)) { throw "missing launcher: $vbs" }

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
      <Command>$wscript</Command>
      <Arguments>//B "$vbs"</Arguments>
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
"  runs  : wscript //B $vbs"
"  at    : logon of $user, single instance, no console window"
"  stop  : 'npm run stop' keeps it down until the next logon or manual start"
""
"Verify with:  schtasks /query /tn $TaskName /v /fo LIST"
