# install-windows.ps1 — bootstrap del Mobile Profiler en Windows 11.
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

# Get-Command/Test-Path no bastan para Python: los aliases de Microsoft Store y los venv
# sobreviven a veces a una actualización aunque el intérprete al que apuntan ya no exista.
function Test-Python($command) {
  if (-not $command) { return $false }
  try {
    & $command --version 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Find-Python {
  $fromPath = Get-Command python -ErrorAction SilentlyContinue
  if ($fromPath -and (Test-Python $fromPath.Source)) { return $fromPath.Source }

  # Ruta del instalador oficial de python.org vía winget. Usarla directamente cubre una
  # sesión cuyo PATH todavía no se refrescó después de instalar o actualizar Python.
  $roots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:ProgramFiles 'Python312\python.exe')
  )
  foreach ($candidate in $roots) {
    if ((Test-Path -LiteralPath $candidate) -and (Test-Python $candidate)) { return $candidate }
  }
  return $null
}

function Install-WingetPackage($id, $label) {
  $installed = winget list --id $id -e --accept-source-agreements 2>$null | Select-String $id
  if ($installed) {
    Write-Host "  ok  $label ya instalado ($id)" -ForegroundColor Green
    return $true
  }
  Write-Host "  →   instalando $label ($id)…" -ForegroundColor Cyan
  winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "winget no pudo instalar $label ($id) — exit code $LASTEXITCODE"
    return $false
  }
  Write-Host "  ok  $label instalado" -ForegroundColor Green
  return $true
}

# Descarga platform-tools directo de Google cuando winget falla (p. ej. hash del
# manifiesto desactualizado). Prueba varias URLs oficiales hasta que una funcione.
function Install-PlatformToolsDirect {
  $urls = @(
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
    'https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip'
    'https://dl.google.com/android/repository/platform-tools_r36.0.0-win.zip'
    'https://dl.google.com/android/repository/platform-tools_r35.0.2-win.zip'
  )
  $destParent = Join-Path $env:LOCALAPPDATA 'Android'
  $dest = Join-Path $destParent 'platform-tools'

  if (Test-Path (Join-Path $dest 'adb.exe')) {
    Write-Host "  ok  platform-tools ya estaba en $dest" -ForegroundColor Green
  } else {
    $zip = Join-Path $env:TEMP 'platform-tools-win.zip'
    $downloaded = $false
    foreach ($url in $urls) {
      Write-Host "  →   descargando $url…" -ForegroundColor Cyan
      try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        $downloaded = $true
        break
      } catch {
        Write-Warning "  no se pudo descargar ($($_.Exception.Message)) — probando la siguiente versión…"
      }
    }
    if (-not $downloaded) {
      throw 'No se pudo descargar platform-tools de ninguna de las URLs de Google. Revisá la conexión y volvé a correr el instalador.'
    }
    New-Item -ItemType Directory -Force -Path $destParent | Out-Null
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Expand-Archive -Path $zip -DestinationPath $destParent -Force
    Remove-Item $zip -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $dest 'adb.exe'))) {
      throw "El zip de platform-tools no trajo adb.exe (se esperaba en $dest)."
    }
    Write-Host "  ok  platform-tools instalado en $dest" -ForegroundColor Green
  }

  # Dejarlo en el PATH del usuario para sesiones futuras y en el de esta sesión.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$dest*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  }
  $env:Path = "$env:Path;$dest"
}

# ¿Hay alguien escuchando en el puerto del usbmux de Apple? Es LA señal de que el camino
# iOS funciona: es por donde pymobiledevice3 le habla al teléfono.
#
# Es deliberado no preguntar por el servicio Windows 'Apple Mobile Device Service': ese lo
# registra el iTunes clásico, pero la app "Apple Devices" (MSIX de la Store, lo que se
# instala hoy en Windows 11) no registra servicio alguno y corre AppleMobileDeviceProcess.exe
# como proceso de usuario. Buscar el servicio daba un "falta instalar Apple" con el usbmux
# perfectamente vivo.
function Test-Usbmux {
  try {
    $probe = New-Object Net.Sockets.TcpClient
    $probe.Connect('127.0.0.1', 27015)
    $up = $probe.Connected
    $probe.Close()
    return $up
  } catch { return $false }
}

# Instala "Apple Devices" (Microsoft Store) y lo deja EN MARCHA.
#
# Los dos pasos son necesarios: instalar el paquete no levanta el usbmux — la app tiene que
# abrirse una vez para que arranque AppleMobileDeviceProcess.exe, y recién ahí el puerto
# 27015 empieza a atender. Verificado en Windows 11: recién instalado y sin abrir la app,
# `pymobiledevice3 usbmux list` no ve ningún iPhone.
function Install-AppleDevices {
  if (Test-Usbmux) {
    Write-Host "  ok  usbmux de Apple escuchando en 127.0.0.1:27015" -ForegroundColor Green
    return
  }

  $pkg = Get-AppxPackage -Name 'AppleInc.AppleDevices' -ErrorAction SilentlyContinue
  if (-not $pkg -and -not (Get-Service -Name 'Apple Mobile Device Service' -ErrorAction SilentlyContinue)) {
    Write-Host "  →   instalando Apple Devices (Microsoft Store)…" -ForegroundColor Cyan
    # 9NP83LWLPZ9K = "Apple Devices". Sale de la fuente msstore, que necesita aceptar sus
    # términos aparte de los del paquete.
    winget install --id 9NP83LWLPZ9K --source msstore `
      --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Warning @'
  No se pudo instalar "Apple Devices" por winget (la Store puede pedir iniciar sesión).
  Instalala a mano desde la Microsoft Store, abrila una vez y volvé a correr el instalador.
  Android funciona igual: esto sólo hace falta para perfilar iPhone/iPad.
'@
      return
    }
    $pkg = Get-AppxPackage -Name 'AppleInc.AppleDevices' -ErrorAction SilentlyContinue
  }

  # Abrirla una vez para que levante el usbmux. El AUMID se resuelve del propio paquete en
  # vez de hardcodearlo: el sufijo del publisher cambia entre versiones del paquete.
  if ($pkg) {
    $appId = (Get-AppxPackageManifest $pkg).Package.Applications.Application.Id
    if ($appId) {
      Write-Host "  →   abriendo Apple Devices para que levante el usbmux…" -ForegroundColor Cyan
      Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!$appId"
      # Arranque en frío: tarda unos segundos en atender el puerto.
      for ($i = 0; $i -lt 30 -and -not (Test-Usbmux); $i++) { Start-Sleep -Seconds 1 }
    }
  }

  if (Test-Usbmux) {
    Write-Host "  ok  usbmux de Apple escuchando en 127.0.0.1:27015" -ForegroundColor Green
  } else {
    Write-Warning @'
  Apple Devices quedó instalado pero su usbmux todavía no atiende. Abrí la app a mano una
  vez (queda corriendo en segundo plano) y volvé a conectar el teléfono. Sin eso los iPhone
  no se detectan; Android no se ve afectado.
'@
  }
}

Write-Host "`nMobile Profiler — setup para Windows 11`n" -ForegroundColor Magenta

# 0. winget disponible (incluido en Windows 11)
if (-not (Test-Command 'winget')) {
  Write-Error @'
winget no está disponible. En Windows 11 viene de fábrica; si es Windows 10,
instalá "App Installer" desde la Microsoft Store y volvé a correr este script.
'@
  exit 1
}

# 1. Bun (runtime del CLI, tests y dashboard)
if (-not (Install-WingetPackage 'Oven-sh.Bun' 'Bun')) {
  throw 'winget no pudo instalar Bun. Instalalo manualmente desde https://bun.sh y volvé a correr el instalador.'
}

# 2. adb (Android SDK Platform-Tools, oficiales de Google)
#    winget primero; si falla (p. ej. "Installer hash does not match" porque Google
#    actualizó el zip y el manifiesto de winget quedó viejo), descarga directa.
if (-not (Install-WingetPackage 'Google.PlatformTools' 'adb / platform-tools')) {
  Write-Host "  →   winget falló — descargando platform-tools directo de Google…" -ForegroundColor Cyan
  Install-PlatformToolsDirect
}

# 3. Stack iOS: Python + pymobiledevice3 en un venv gestionado (ticket 041).
#    Opcional a propósito: si falla, el camino ANDROID queda intacto — no se aborta la
#    instalación por algo que sólo hace falta para perfilar iPhones.
Write-Host "`n  iOS (opcional — sólo si vas a perfilar iPhone/iPad):" -ForegroundColor Magenta
$pythonExe = Find-Python
if (-not $pythonExe) {
  # OJO: en Windows el ejecutable es `python`, NO `python3`.
  $pythonInstalled = Install-WingetPackage 'Python.Python.3.12' 'Python 3.12'
  if (-not $pythonInstalled) {
    Write-Warning '  no se pudo instalar Python: el camino iOS va a quedar sin configurar (Android no se ve afectado).'
  }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User')
  $pythonExe = Find-Python

  # winget puede decir "ya instalado" aunque una actualización de Microsoft Store haya
  # dejado sólo aliases o launchers rotos. En ese caso hay que reparar el paquete real.
  if (-not $pythonExe -and $pythonInstalled) {
    Write-Host "  →   reparando Python 3.12…" -ForegroundColor Cyan
    winget install --id Python.Python.3.12 -e --silent --force `
      --accept-source-agreements --accept-package-agreements | Out-Host
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
      [Environment]::GetEnvironmentVariable('Path', 'User')
    $pythonExe = Find-Python
  }
}

if ($pythonExe) {
  # Venv propio en vez de instalar en el Python del sistema: mismo criterio que
  # platform-tools (la tool se ocupa de su toolchain) y esquiva PEP 668.
  $venv = Join-Path $env:USERPROFILE '.sample-profiler\pmd3-venv'
  $venvPy = Join-Path $venv 'Scripts\python.exe'
  if (-not (Test-Python $venvPy)) {
    Write-Host "  →   creando o reparando venv en $venv…" -ForegroundColor Cyan
    # --clear sustituye launchers rotos que quedaron apuntando a una versión anterior del
    # Python de Microsoft Store. La carpeta es fija y exclusiva de esta aplicación.
    & $pythonExe -m venv --clear $venv 2>&1 | Out-Null
  }
  if (Test-Python $venvPy) {
    Write-Host "  →   instalando pymobiledevice3…" -ForegroundColor Cyan
    & $venvPy -m pip install --quiet --upgrade pip pymobiledevice3 2>&1 | Out-Null
    $pmdVer = (& $venvPy -m pymobiledevice3 version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  ok  pymobiledevice3 $pmdVer" -ForegroundColor Green
    } else {
      Write-Warning '  pip no pudo instalar pymobiledevice3 — el camino iOS queda sin configurar.'
    }
  } else {
    Write-Warning '  no se pudo crear el venv — el camino iOS queda sin configurar.'
  }

  # El usbmux de Apple — el `adb` de iOS. Se instala acá igual que adb y Python; es la
  # única pieza que no se puede vendorizar (viene firmada por Apple).
  Install-AppleDevices
} else {
  Write-Warning '  no hay un Python ejecutable — reinstalá Python 3.12 y ejecutá INSTALAR.bat otra vez.'
}

# 4. Refrescar PATH de esta sesión (winget lo agrega para sesiones nuevas)
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
  [Environment]::GetEnvironmentVariable('Path', 'User')

# 5. Verificación
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

# Estado del camino iOS de un vistazo: son DOS piezas independientes y fallan distinto
# (pymobiledevice3 lo instalamos nosotros; el usbmux viene de Apple y no se puede vendorizar).
# Verlas separadas evita el diagnóstico equivocado de "no se detecta el iPhone".
$venvPyCheck = Join-Path $env:USERPROFILE '.sample-profiler\pmd3-venv\Scripts\python.exe'
if (Test-Python $venvPyCheck) {
  $pmdCheck = (& $venvPyCheck -m pymobiledevice3 version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  ok  pymobiledevice3 $pmdCheck (iOS)" -ForegroundColor Green
  } else {
    Write-Warning '  pymobiledevice3 no responde — los iPhone no se van a detectar.'
  }
} else {
  Write-Host "  –   iOS sin configurar (no hay venv) — sólo Android" -ForegroundColor DarkGray
}
if (Test-Usbmux) {
  Write-Host "  ok  usbmux de Apple (iOS)" -ForegroundColor Green
} else {
  Write-Host "  –   usbmux de Apple no responde — abrí 'Apple Devices' una vez" -ForegroundColor DarkGray
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

En un ANDROID (una sola vez):
  1. Activá "Depuración USB": Ajustes → Acerca del teléfono → tocá 7 veces
     "Número de compilación" → volvé → Opciones de desarrollador → Depuración USB.
  2. Conectalo por USB y aceptá "¿Permitir depuración USB?" (marcá "Permitir siempre").

En un iPHONE / iPAD (una sola vez):
  1. Conectalo por USB, desbloqueá la pantalla y tocá "Confiar" en el diálogo del teléfono.
  2. Si no aparece, abrí la app "Apple Devices" en la PC y volvé a enchufarlo.
     (No hace falta jailbreak, ni Mac, ni permisos de administrador.)

No hace falta el teléfono para arrancar: el dashboard queda esperando y detecta solo lo que
enchufes, sea Android o iPhone.
'@ -ForegroundColor Magenta
