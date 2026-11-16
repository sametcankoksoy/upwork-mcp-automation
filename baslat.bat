@echo off
chcp 65001 >nul
title Upwork AI Radar & Video Otomasyonu
cd /d "%~dp0"

echo ===================================================================
echo   🚀 Upwork Akıllı İstihbarat & Video Teklif Sistemi Başlatılıyor
echo ===================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Node.js bulunamadı!
    pause
    exit /b 1
)

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Python bulunamadı!
    pause
    exit /b 1
)

echo [✓] Node.js ve Python hazır.
echo [✓] http://localhost:3050 adresine bağlanılıyor...
echo.

:: 2 saniye sonra tarayıcıyı otomatik aç
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3050"

:: Sunucuyu başlat
node src/server.js

pause
