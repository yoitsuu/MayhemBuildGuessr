@echo off
rem Stops the background collector started by start_collector.bat.
cd /d "%~dp0"
if not exist collector.pid (
    echo No collector.pid found; the collector doesn't seem to be running.
    timeout /t 5
    exit /b 0
)
set /p PID=<collector.pid
taskkill /pid %PID% /f >nul 2>nul && echo Stopped collector (pid %PID%). || echo Collector wasn't running.
del collector.pid >nul 2>nul
timeout /t 5
