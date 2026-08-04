@echo off
REM Stops the editor started by start.bat.
REM
REM Matches on the LISTENING socket for the app's port rather than killing
REM every node.exe - this machine may run unrelated Node processes, and taking
REM those down to stop a save editor would be a nasty surprise.
REM
REM Port defaults to server.js's 3080. If you set KENSHI_MKII_PORT when
REM starting, pass the same port as the first argument here.
REM
REM Keep this file ASCII-only with CRLF line endings: cmd.exe misparses UTF-8
REM punctuation under the default codepage, and LF-only endings break REM.

setlocal
set PORT=%~1
if "%PORT%"=="" set PORT=3080

set FOUND=
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":%PORT% "') do (
  if not "%%P"=="0" (
    set FOUND=1
    echo Stopping Kenshi MKII Editor on port %PORT% ^(PID %%P^)...
    taskkill /PID %%P /F >nul 2>&1
    if errorlevel 1 (
      echo   Could not stop PID %%P. Try an elevated prompt.
    ) else (
      echo   Stopped.
    )
  )
)

if not defined FOUND echo Nothing is listening on port %PORT% - the editor is not running.

endlocal
