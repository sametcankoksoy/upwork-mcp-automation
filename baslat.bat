@echo off
chcp 65001 >nul
title Upwork AI Radar & Video Otomasyonu
cd /d "%~dp0"

echo ===================================================================
echo   Upwork AI Radar, Oto-Proposal ^& Loom Watchdog Baslatiliyor
echo ===================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Node.js bulunamadi!
    pause
    exit /b 1
)

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Python bulunamadi!
    pause
    exit /b 1
)

echo [+] Watchdog arka planda baslatiliyor...
start "" powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\watchdog.ps1"

timeout /t 3 /nobreak >nul

echo [+] http://localhost:3050/health kontrol ediliyor...
powershell.exe -NoProfile -Command "try { $r = Invoke-RestMethod http://localhost:3050/health -TimeoutSec 4; Write-Host ('[OK] ' + ($r | ConvertTo-Json -Compress)) } catch { Write-Host '[UYARI] Sunucu baslatiliyor, loglar logs\ altinda...' }"

start "" http://localhost:3050
echo.
echo [OK] Watchdog arka planda 7/24 aktif. Bu pencereyi kapatabilirsiniz.
timeout /t 3 /nobreak >nul
