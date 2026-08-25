# install-windows.ps1 — bootstrap reproducible de Mobile Profiler para Windows.
#
# Soporta Windows 10 1809+ y Windows 11 de 64 bits. Instala y verifica:
#   Android: Bun + dependencias del repo + Android Platform-Tools (adb)
#   iOS:     Python 3.12 + pymobiledevice3 + Apple Devices/usbmux
#
# El teléfono no tiene que estar conectado durante la instalación. Si lo está, se verifica
# además el enlace USB y se informa el estado de Modo Desarrollador de iOS.

param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$managedRoot = Join-Path $env:USERPROFILE '.sample-profiler'
$venv = Join-Path $managedRoot 'pmd3-venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$script:WingetExe = $null

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machine, $user) -join ';'
}

function Add-UserPath($directory) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
  if ($entries -notcontains $directory) {
    $newPath = (@($entries) + $directory) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  }
  if (($env:Path -split ';') -notcontains $directory) { $env:Path = "$env:Path;$directory" }
}

function Find-Executable($commandName, $knownPaths) {
  $command = Get-Command $commandName -ErrorAction SilentlyContinue
  if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
    return $command.Source
  }
  foreach ($candidate in $knownPaths) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  return $null
}

function Find-Winget {
  return Find-Executable 'winget' @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\winget.exe')
  )
}

function Find-Bun {
  $candidate = Find-Executable 'bun' @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'),
    (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
  )
  if (-not $candidate) { return $null }
  try {
    & $candidate --version 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return $candidate }
  } catch {}
  return $null
}

function Find-Adb {
  $known = @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\adb.exe'),
    (Join-Path $env:LOCALAPPDATA 'Android\platform-tools\adb.exe'),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
  )
  if ($env:ANDROID_HOME) { $known += Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
  if ($env:ANDROID_SDK_ROOT) { $known += Join-Path $env:ANDROID_SDK_ROOT 'platform-tools\adb.exe' }
  $candidate = Find-Executable 'adb' $known
  if (-not $candidate) { return $null }
  try {
    & $candidate version 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return $candidate }
  } catch {}
  return $null
}

function Test-Python($command) {
  if (-not $command) { return $false }
  try {
    $versionText = (& $command --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '(\d+)\.(\d+)') { return $false }
    return ([version]"$($Matches[1]).$($Matches[2])") -ge ([version]'3.9')
  } catch { return $false }
}

function Find-Python {
  $fromPath = Get-Command python -ErrorAction SilentlyContinue
  if ($fromPath -and (Test-Python $fromPath.Source)) { return $fromPath.Source }

  $candidates = @()
  foreach ($parent in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\Python'),
      $env:ProgramFiles
    )) {
    if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) { continue }
    $dirs = Get-ChildItem -LiteralPath $parent -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending
    foreach ($dir in $dirs) { $candidates += Join-Path $dir.FullName 'python.exe' }
  }
  foreach ($candidate in $candidates) {
    if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Test-Python $candidate)) {
      return $candidate
    }
  }
  return $null
}

function Install-WingetPackage($id, $label, $source = $null) {
  $listedArgs = @('list', '--id', $id, '--exact', '--accept-source-agreements', '--disable-interactivity')
  if ($source) { $listedArgs += @('--source', $source) }
  $listed = (& $script:WingetExe @listedArgs 2>$null | Out-String)
  if ($LASTEXITCODE -eq 0 -and $listed -match [regex]::Escape($id)) {
    Write-Host "  ok  $label ya instalado" -ForegroundColor Green
    return $true
  }

  Write-Host "  →   instalando $label…" -ForegroundColor Cyan
  $installArgs = @(
    'install', '--id', $id, '--exact', '--silent', '--accept-source-agreements',
    '--accept-package-agreements', '--disable-interactivity'
  )
  if ($source) { $installArgs += @('--source', $source) }
  & $script:WingetExe @installArgs | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "winget no pudo instalar $label ($id) — exit code $LASTEXITCODE"
    return $false
  }
  Write-Host "  ok  $label instalado" -ForegroundColor Green
  return $true
}

function Install-PlatformToolsDirect {
  $destParent = Join-Path $env:LOCALAPPDATA 'Android'
  $dest = Join-Path $destParent 'platform-tools'
  $adb = Join-Path $dest 'adb.exe'
  if (Test-Path -LiteralPath $adb -PathType Leaf) {
    Add-UserPath $dest
    return $adb
  }

  $zip = Join-Path $env:TEMP 'mobile-profiler-platform-tools.zip'
  $url = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
  Write-Host '  →   descargando Platform-Tools oficial de Google…' -ForegroundColor Cyan
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  New-Item -ItemType Directory -Force -Path $destParent | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $destParent -Force
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $adb -PathType Leaf)) {
    throw "El paquete de Google no trajo adb.exe en $adb"
  }
  Add-UserPath $dest
  Write-Host "  ok  Platform-Tools instalado en $dest" -ForegroundColor Green
  return $adb
}

function Test-Usbmux {
  try {
    $probe = New-Object Net.Sockets.TcpClient
    $probe.Connect('127.0.0.1', 27015)
    $up = $probe.Connected
    $probe.Dispose()
    return $up
  } catch { return $false }
}

function Install-AppleDevices {
  if (Test-Usbmux) {
    Write-Host '  ok  usbmux de Apple escuchando en 127.0.0.1:27015' -ForegroundColor Green
    return $true
  }

  $service = Get-Service -Name 'Apple Mobile Device Service' -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Running') {
    try { Start-Service -Name $service.Name } catch {}
  }

  $pkg = Get-AppxPackage -Name 'AppleInc.AppleDevices' -ErrorAction SilentlyContinue
  if (-not $pkg -and -not $service) {
    if (-not (Install-WingetPackage '9NP83LWLPZ9K' 'Apple Devices' 'msstore')) { return $false }
    $pkg = Get-AppxPackage -Name 'AppleInc.AppleDevices' -ErrorAction SilentlyContinue
  }

  if ($pkg) {
    try {
      $appId = @((Get-AppxPackageManifest $pkg).Package.Applications.Application.Id)[0]
      if ($appId) {
        $aumid = "$($pkg.PackageFamilyName)!$appId"
        Write-Host '  →   abriendo Apple Devices para iniciar el enlace USB…' -ForegroundColor Cyan
        Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$aumid"
      }
    } catch {
      Write-Warning "Apple Devices está instalado pero no se pudo abrir automáticamente: $($_.Exception.Message)"
    }
  }

  for ($i = 0; $i -lt 30 -and -not (Test-Usbmux); $i++) { Start-Sleep -Seconds 1 }
  if (Test-Usbmux) {
    Write-Host '  ok  usbmux de Apple escuchando en 127.0.0.1:27015' -ForegroundColor Green
    return $true
  }

  Write-Warning @'
Apple Devices quedó instalado, pero el enlace USB todavía no está activo. Abrí la app a
mano, aceptá sus permisos y volvé a ejecutar INSTALAR.bat. Android ya puede funcionar.
'@
  return $false
}

function Show-IosDeviceStatus($pmdPython) {
  try {
    $json = (& $pmdPython -m pymobiledevice3 usbmux list 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $json) {
      Write-Warning 'pymobiledevice3 no pudo consultar usbmux; revisá Apple Devices.'
      return
    }
    $devices = @($json | ConvertFrom-Json)
    if ($devices.Count -eq 0) {
      Write-Host '  –   no hay iPhone/iPad conectado; se verificará al enchufarlo' -ForegroundColor DarkGray
      return
    }

    Write-Host "  ok  $($devices.Count) dispositivo(s) iOS visible(s) por USB" -ForegroundColor Green
    $oldUdid = $env:PYMOBILEDEVICE3_UDID
    try {
      foreach ($device in $devices) {
        $udid = if ($device.Identifier) { $device.Identifier } else { $device.UniqueDeviceID }
        if (-not $udid) { continue }
        $env:PYMOBILEDEVICE3_UDID = $udid
        $developerMode = (& $pmdPython -m pymobiledevice3 amfi developer-mode-status 2>$null |
          Out-String).Trim().ToLowerInvariant()
        $model = if ($device.ProductType) { $device.ProductType } else { 'iPhone/iPad' }
        if ($LASTEXITCODE -eq 0 -and $developerMode -eq 'true') {
          Write-Host "  ok  ${model}: Modo Desarrollador activado" -ForegroundColor Green
        } else {
          Write-Warning "${model}: activá Modo Desarrollador en Ajustes > Privacidad y seguridad."
        }
      }
    } finally {
      if ($null -eq $oldUdid) { Remove-Item Env:PYMOBILEDEVICE3_UDID -ErrorAction SilentlyContinue }
      else { $env:PYMOBILEDEVICE3_UDID = $oldUdid }
    }
  } catch {
    Write-Warning "No se pudo verificar el iPhone/iPad conectado: $($_.Exception.Message)"
  }
}

if ($CheckOnly) {
  Write-Host 'PowerShell syntax OK'
  exit 0
}

Write-Host "`nMobile Profiler — instalación para Windows`n" -ForegroundColor Magenta

$windows = [Environment]::OSVersion.Version
if ($windows.Major -lt 10 -or $windows.Build -lt 17763) {
  Write-Error 'Se necesita Windows 10 versión 1809 (build 17763) o posterior.'
  exit 1
}
if (-not [Environment]::Is64BitOperatingSystem) {
  Write-Error 'Se necesita Windows de 64 bits (x64 o ARM64).'
  exit 1
}
Write-Host "  ok  Windows build $($windows.Build) · $env:PROCESSOR_ARCHITECTURE" -ForegroundColor Green

Refresh-ProcessPath
$script:WingetExe = Find-Winget
if (-not $script:WingetExe) {
  Write-Error @'
No se encontró WinGet. Instalá o actualizá "App Installer" desde Microsoft Store
(https://aka.ms/getwinget) y volvé a ejecutar INSTALAR.bat.
'@
  exit 1
}
Write-Host "  ok  WinGet: $script:WingetExe" -ForegroundColor Green

Write-Host "`nAndroid y runtime:" -ForegroundColor Magenta
$null = Install-WingetPackage 'Oven-sh.Bun' 'Bun'
Refresh-ProcessPath
$bunExe = Find-Bun
if ($bunExe) { Write-Host "  ok  Bun $(& $bunExe --version)" -ForegroundColor Green }
else { Write-Warning 'Bun no responde después de instalarlo.' }

$null = Install-WingetPackage 'Google.PlatformTools' 'Android Platform-Tools'
Refresh-ProcessPath
$adbExe = Find-Adb
if (-not $adbExe) {
  try { $adbExe = Install-PlatformToolsDirect } catch { Write-Warning $_.Exception.Message }
}
if ($adbExe) {
  $adbVersion = (& $adbExe version | Select-Object -First 1)
  Write-Host "  ok  $adbVersion" -ForegroundColor Green
  & $adbExe start-server 2>&1 | Out-Null
} else {
  Write-Warning 'adb no quedó disponible; Android no funcionará.'
}

Write-Host "`niOS:" -ForegroundColor Magenta
$pythonExe = Find-Python
if (-not $pythonExe) {
  $pythonInstalled = Install-WingetPackage 'Python.Python.3.12' 'Python 3.12'
  Refresh-ProcessPath
  $pythonExe = Find-Python
  if (-not $pythonExe -and $pythonInstalled) {
    Write-Host '  →   reparando la instalación de Python 3.12…' -ForegroundColor Cyan
    & $script:WingetExe install --id Python.Python.3.12 --exact --silent --force `
      --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Host
    Refresh-ProcessPath
    $pythonExe = Find-Python
  }
}

$pmdOk = $false
if ($pythonExe) {
  Write-Host "  ok  $((& $pythonExe --version 2>&1 | Out-String).Trim())" -ForegroundColor Green
  if (-not (Test-Python $venvPy)) {
    Write-Host "  →   creando o reparando el entorno iOS en $venv…" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $managedRoot | Out-Null
    & $pythonExe -m venv --clear $venv 2>&1 | Out-Host
  }
  if (Test-Python $venvPy) {
    Write-Host '  →   instalando/actualizando pymobiledevice3…' -ForegroundColor Cyan
    $pipOutput = (& $venvPy -m pip install --disable-pip-version-check --quiet `
      --upgrade pip pymobiledevice3 2>&1 | Out-String).Trim()
    $pipExit = $LASTEXITCODE
    if ($pipExit -eq 0) {
      $pmdVersion = (& $venvPy -m pymobiledevice3 version 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and $pmdVersion) {
        Write-Host "  ok  pymobiledevice3 $pmdVersion" -ForegroundColor Green
        $pmdOk = $true
      }
    } elseif ($pipOutput) {
      Write-Warning "pip no pudo instalar pymobiledevice3:`n$pipOutput"
    }
  }
}
if (-not $pmdOk) { Write-Warning 'Python/pymobiledevice3 no quedó operativo; iOS no funcionará.' }

# Apple Devices es independiente de Python: se instala incluso si el venv falló, para que
# una segunda ejecución pueda reparar sólo la pieza que falta.
$appleOk = Install-AppleDevices
if ($pmdOk -and $appleOk) { Show-IosDeviceStatus $venvPy }

$depsOk = $false
if ($bunExe -and (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))) {
  Write-Host "`nDependencias del proyecto:" -ForegroundColor Magenta
  Push-Location $repoRoot
  try {
    & $bunExe install --frozen-lockfile
    $depsOk = $LASTEXITCODE -eq 0
  } finally { Pop-Location }
  if ($depsOk) { Write-Host '  ok  dependencias instaladas desde bun.lock' -ForegroundColor Green }
  else { Write-Warning 'bun install falló; el profiler no podrá arrancar.' }
}

$androidOk = [bool]($bunExe -and $adbExe -and $depsOk)
$iosOk = [bool]($pmdOk -and $appleOk)

Write-Host "`nResumen:" -ForegroundColor Magenta
if ($androidOk) { Write-Host '  ok  Android listo' -ForegroundColor Green }
else { Write-Host '  ERROR  Android incompleto' -ForegroundColor Red }
if ($iosOk) { Write-Host '  ok  iOS listo en Windows' -ForegroundColor Green }
else { Write-Host '  ERROR  iOS incompleto' -ForegroundColor Red }

Write-Host @'

Configuración única en los teléfonos:

ANDROID
  1. Ajustes > Acerca del teléfono > tocá 7 veces "Número de compilación".
  2. Opciones de desarrollador > activá "Depuración USB".
  3. Conectá por USB y aceptá "Permitir depuración USB".

iPHONE / iPAD
  1. Conectá por USB, desbloqueá y tocá "Confiar en este equipo".
  2. Ajustes > Privacidad y seguridad > Modo Desarrollador > activar.
  3. El teléfono se reinicia: confirmá "Activar" e ingresá el código.
  4. Dejá Apple Devices abierto la primera vez que conectes el dispositivo.

Después, ejecutá INICIAR.bat. El profiler detectará Android y iOS automáticamente.
'@ -ForegroundColor Magenta

if (-not $androidOk -or -not $iosOk) {
  Write-Host 'La instalación quedó incompleta. Corregí los ERROR y ejecutá INSTALAR.bat otra vez.' -ForegroundColor Red
  exit 1
}

Write-Host 'Instalación completa para Android e iOS.' -ForegroundColor Green
exit 0
