@echo off
REM Stop the bridge and its supervisor.
setlocal
if "%AGY_BRIDGE_STATE%"=="" set "AGY_BRIDGE_STATE=%LOCALAPPDATA%\agy-bridge"
if not exist "%AGY_BRIDGE_STATE%" mkdir "%AGY_BRIDGE_STATE%"
echo stopped > "%AGY_BRIDGE_STATE%\stopped"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:8799 .*LISTENING"') do (
  taskkill /pid %%p /f >nul 2>&1
)
echo agy-openai-bridge stopped. Start it again with scripts\start.cmd
endlocal
