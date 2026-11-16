@echo off
REM agy-openai-bridge supervisor: runs the bridge and restarts it if it exits.
REM Stop it with scripts\stop.cmd, which drops a flag so it does not come back.
setlocal
set "ROOT=%~dp0.."
if "%AGY_BRIDGE_STATE%"=="" set "AGY_BRIDGE_STATE=%LOCALAPPDATA%\agy-bridge"
if not exist "%AGY_BRIDGE_STATE%" mkdir "%AGY_BRIDGE_STATE%"
del "%AGY_BRIDGE_STATE%\stopped" >nul 2>&1

:loop
if exist "%AGY_BRIDGE_STATE%\stopped" (
  echo agy-openai-bridge: stop flag found, exiting.
  goto :done
)
pushd "%ROOT%"
node server.mjs
popd
timeout /t 2 /nobreak >nul
goto loop

:done
endlocal
