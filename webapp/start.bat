@echo off
cd /d "%~dp0."
if not exist node_modules (
  echo Installing dependencies...
  call npm install || exit /b 1
)
start "" http://127.0.0.1:3080
node server.js
