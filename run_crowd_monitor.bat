@echo off
title QueueFlow Crowd Monitor
cd /d "%~dp0"
echo ============================================================
echo Starting QueueFlow CCTV Crowd Counter ^& Telemetry Ingestion
echo ============================================================
C:\Python314\python.exe crowd_monitor\crowd_counter.py %*
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Crowd Monitor exited with error code %ERRORLEVEL%.
    pause
)
