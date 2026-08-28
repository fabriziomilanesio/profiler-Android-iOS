@echo off
setlocal
chcp 65001 >nul
title Mobile Profiler - Instalador
echo.
echo  Instalando Mobile Profiler para Android e iOS...
echo  Esto puede tardar unos minutos. No cierres esta ventana.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" -ProjectRoot "%~dp0."
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" (
  echo.
  echo  La instalacion no quedo completa. Revisa los pasos marcados como ERROR.
) else (
  echo.
  echo  Instalacion completada correctamente.
)
echo.
pause
exit /b %INSTALL_EXIT%
