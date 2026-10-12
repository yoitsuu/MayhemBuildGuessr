@echo off
rem Starts the Mayhem collector in the background (no console window).
rem This window closes after a few seconds; the collector keeps running.
rem To run it at login: Win+R -> shell:startup -> put a shortcut to this file there.
rem Set PUSH=--push below to also publish to GitHub Pages after each update.
set PUSH=
cd /d "%~dp0"

where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw collect.py %PUSH%
) else (
    where pyw >nul 2>nul
    if errorlevel 1 (
        echo Couldn't find pythonw or pyw. Is Python installed and on PATH?
        pause
        exit /b 1
    )
    start "" pyw collect.py %PUSH%
)

timeout /t 3 /nobreak >nul
echo Collector launched. Latest log lines:
echo ----------------------------------------
powershell -NoProfile -Command "if (Test-Path collect.log) { Get-Content collect.log -Tail 6 }"
echo ----------------------------------------
echo It runs in the background; close this window any time.
echo To stop it, run stop_collector.bat.
timeout /t 10
