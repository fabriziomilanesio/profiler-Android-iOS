@echo off
title Evermore Android Profiler
cd /d "%~dp0"

rem Buscar bun: PATH, instalacion winget, o instalacion oficial de bun.sh
set "BUN=bun"
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe" (
    set "BUN=%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe"
  ) else if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
  ) else (
    echo No se encontro bun. Ejecuta primero INSTALAR.bat y proba de nuevo.
    pause
    exit /b 1
  )
)

echo Arrancando el profiler... el dashboard se abre solo en el navegador.
echo (Para cortar: cerra esta ventana o presiona Ctrl+C.)
echo.
"%BUN%" start
pause
