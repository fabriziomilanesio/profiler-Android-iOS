# install-windows.ps1 — bootstrap del Evermore Android Profiler en Windows 11.
# Instala los dos requisitos (Bun + adb/platform-tools) vía winget y deja el repo listo.
#
# Uso (desde la raíz del repo, en PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#
# Idempotente: si algo ya está instalado, lo saltea. winget viene incluido en Windows 11;
# en Windows 10 requiere "App Installer" de la Microsoft Store.

$ErrorActionPreference = 'Stop'

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Install-WingetPackage($id, $label) {
  $installed = winget list --id $id -e --accept-source-agreements 2>$null | Select-String $id
  if ($installed) {
    Write-Host "  ok  $label ya instalado ($id)" -ForegroundColor Green
    return
  }
  Write-Host "  →   instalando $label ($id)…" -ForegroundColor Cyan
  winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget no pudo instalar $label ($id) — exit code $LASTEXITCODE"
  }
  Write-Host "  ok  $label instalado" -ForegroundColor Green
}

Write-Host "`nEvermore Android Profiler — setup para Windows 11`n" -ForegroundColor Magenta

# 0. winget disponible (incluido en Windows 11)
if (-not (Test-Command 'winget')) {
  Write-Error @'
winget no está disponible. En Windows 11 viene de fábrica; si es Windows 10,
instalá "App Installer" desde la Microsoft Store y volvé a correr este script.
'@
  exit 1
}

# 1. Bun (runtime del CLI, tests y dashboard)
Install-WingetPackage 'Oven-sh.Bun' 'Bun'

# 2. adb (Android SDK Platform-Tools, oficiales de Google)
Install-WingetPackage 'Google.PlatformTools' 'adb / platform-tools'

# 3. Refrescar PATH de esta sesión (winget lo agrega para sesiones nuevas)
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
  [Environment]::GetEnvironmentVariable('Path', 'User')

# 4. Verificación
Write-Host "`nVerificando:" -ForegroundColor Magenta
if (Test-Command 'bun') {
  Write-Host "  ok  bun $(bun --version)" -ForegroundColor Green
} else {
  Write-Warning 'bun no está en el PATH de esta sesión — abrí una terminal nueva y listo.'
}
if (Test-Command 'adb') {
  $adbVersion = (adb --version | Select-Object -First 1)
  Write-Host "  ok  $adbVersion" -ForegroundColor Green
} else {
  Write-Warning 'adb no está en el PATH de esta sesión — abrí una terminal nueva y listo.'
}

# 5. Dependencias del repo (si se corre desde el clon)
$repoRoot = Split-Path -Parent $PSScriptRoot
if (Test-Path (Join-Path $repoRoot 'package.json')) {
  Write-Host "`nInstalando dependencias del repo (bun install)…" -ForegroundColor Cyan
  Push-Location $repoRoot
  try {
    bun install
  } finally {
    Pop-Location
  }
}

Write-Host @'

Listo. Para usar el profiler:

  → Doble click en INICIAR.bat (en la carpeta del proyecto).
    El dashboard se abre solo en el navegador.

En el teléfono (una sola vez):
  1. Activá "Depuración USB": Ajustes → Acerca del teléfono → tocá 7 veces
     "Número de compilación" → volvé → Opciones de desarrollador → Depuración USB.
  2. Conectalo por USB y aceptá "¿Permitir depuración USB?" (marcá "Permitir siempre").

No hace falta el teléfono para arrancar: el dashboard queda esperando y lo detecta solo.
'@ -ForegroundColor Magenta
