@echo off
title Evermore Android Profiler - Instalador
echo.
echo  Instalando Evermore Android Profiler (Bun + adb via winget)...
echo  Esto puede tardar unos minutos. No cierres esta ventana.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo  Hubo un problema con la instalacion. Revisa los mensajes de arriba.
)
echo.
pause
