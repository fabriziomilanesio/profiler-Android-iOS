# spike-ios.ps1 — la mitad Windows del ticket 033. Gemelo de spike-ios.sh.
#
# Responde la pregunta que quedó abierta desde el grilling: ¿el camino iOS funciona desde
# Windows? En macOS ya está verificado (túnel userspace SIN root en iOS 26.5.2); acá falta.
#
# Uso (PowerShell, en la raíz del repo, con el iPhone enchufado y DESBLOQUEADO):
#   powershell -ExecutionPolicy Bypass -File scripts\spike-ios.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\spike-ios.ps1 -Install
#   powershell -ExecutionPolicy Bypass -File scripts\spike-ios.ps1 -Seconds 120
#
# Guarda todo crudo en .tmp\spike-ios\<timestamp>\ y escribe un RESULTADO.md.
# ⚠️ Esa salida tiene PII sin redactar (UDID, ECID, serial). `.tmp\` está en .gitignore.
# Antes de mover cualquier cosa a fixtures\: bun run scripts/scrub-fixtures.ts <ruta>

param(
  [switch]$Install,
  [int]$Seconds = 60,
  [string]$Bundle = "com.evermoregames.evermorearcade",
  [string]$Process = "",
  [string]$Udid = ""
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $root ".tmp\spike-ios\$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$results = @()
function Step($name, $status, $detail = "") {
  $script:results += [pscustomobject]@{ Paso = $name; Estado = $status; Detalle = $detail }
  $color = switch ($status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'DarkGray' } }
  Write-Host ("  {0,-6} {1}" -f $status, $name) -ForegroundColor $color
  if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray }
}

# Venv gestionado, igual que en macOS: la tool se ocupa de su toolchain en vez de
# ensuciar el Python del sistema. En Windows el intérprete vive en Scripts\, no en bin\.
$venv = Join-Path $env:USERPROFILE ".evermore-profiler\pmd3-venv"
$venvPy = Join-Path $venv "Scripts\python.exe"

Write-Host "`nSpike iOS en Windows — ticket 033" -ForegroundColor Cyan
Write-Host "salida: $out`n"

# ───────────────────────────────────────────────────────── 1. dependencias
Write-Host "1. Dependencias del host" -ForegroundColor White

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if ($py) { Step "python en el PATH" "PASS" (& $py.Source --version 2>&1) }
else { Step "python en el PATH" "FAIL" "winget install Python.Python.3.12" }

# El usbmux de Apple es el `adb` de iOS y NO se puede vendorizar: llega con iTunes o con
# la app "Apple Devices" de la Store.
#
# Ojo con cómo se detecta: el iTunes clásico registra el servicio Windows "Apple Mobile
# Device Service", pero la app "Apple Devices" (MSIX de la Store, lo que se instala hoy en
# Windows 11) NO registra servicio alguno — corre AppleMobileDeviceProcess.exe como proceso
# de usuario. Buscar sólo el servicio daba un FAIL falso con el usbmux perfectamente vivo.
# Lo que de verdad importa es que alguien escuche en el puerto 27015, que es por donde
# pymobiledevice3 le habla; el resto es diagnóstico para el mensaje de error.
$muxUp = $false
try {
  $probe = New-Object Net.Sockets.TcpClient
  $probe.Connect('127.0.0.1', 27015)
  $muxUp = $probe.Connected
  $probe.Close()
} catch { $muxUp = $false }

$appleSvc = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
$appleProc = Get-Process -Name "AppleMobileDeviceProcess" -ErrorAction SilentlyContinue
if ($muxUp) {
  $via = if ($appleSvc) { "servicio de iTunes ($($appleSvc.Status))" }
         elseif ($appleProc) { "app Apple Devices (proceso de usuario)" }
         else { "origen desconocido" }
  Step "usbmux de Apple (puerto 27015)" "PASS" $via
} elseif ($appleSvc -or $appleProc) {
  Step "usbmux de Apple (puerto 27015)" "FAIL" "Apple está instalado pero nadie escucha en 27015 — abrí la app 'Apple Devices' una vez para que levante"
} else {
  Step "usbmux de Apple (puerto 27015)" "FAIL" "instalá 'Apple Devices' de la Microsoft Store (winget install --id 9NP83LWLPZ9K --source msstore) o iTunes"
}

if ($Install) {
  Write-Host "     creando venv gestionado en $venv…" -ForegroundColor DarkGray
  & $py.Source -m venv $venv 2>&1 | Out-File "$out\pip-install.log"
  & $venvPy -m pip install --upgrade pip pymobiledevice3 2>&1 | Out-File -Append "$out\pip-install.log"
}

$pmd = if (Test-Path $venvPy) { $venvPy } elseif ($py) { $py.Source } else { $null }
if (-not $pmd) { Step "pymobiledevice3" "FAIL" "sin python no se puede seguir"; exit 1 }

$ver = & $pmd -m pymobiledevice3 version 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) {
  Step "pymobiledevice3" "PASS" "$($ver.Trim())  ← versión a pinear (R4)"
  $ver | Out-File "$out\pmd3-version.txt"
} else {
  Step "pymobiledevice3" "FAIL" "corré con -Install"
  exit 1
}

# ───────────────────────────────────────────────────────────── 2. el device
Write-Host "`n2. Device" -ForegroundColor White

& $pmd -m pymobiledevice3 usbmux list 2>$null | Out-File "$out\devices.json"
$devices = @()
try { $devices = Get-Content "$out\devices.json" -Raw | ConvertFrom-Json } catch {}
if ($devices -and $devices.Count -gt 0) {
  Step "usbmux ve devices" "PASS" "$($devices.Count) entrada(s)"
  foreach ($d in $devices) {
    Write-Host "         $($d.ProductType)  iOS $($d.ProductVersion)  $($d.ConnectionType)" -ForegroundColor DarkGray
  }
} else {
  Step "usbmux ve devices" "FAIL" "¿iPhone enchufado, desbloqueado y con Trust dado?"
  exit 1
}

# Con más de un device TODOS los comandos abortan pidiendo desambiguar: se fija por env.
if (-not $Udid) {
  $phone = $devices | Where-Object { $_.ProductType -like 'iPhone*' } | Select-Object -First 1
  if (-not $phone) { $phone = $devices | Select-Object -First 1 }
  $Udid = $phone.Identifier
}
$env:PYMOBILEDEVICE3_UDID = $Udid
# Sin esto Python bufferea stdout contra un pipe y los canales quedan mudos.
$env:PYTHONUNBUFFERED = "1"
Step "device fijado" "PASS" "…$($Udid.Substring([Math]::Max(0,$Udid.Length-6)))"

if (-not $Process) { $Process = ($Bundle -split '\.')[-1] }

# ────────────────────────────────── 3. camino A — SIN privilegios
Write-Host "`n3. Camino A — túnel userspace, SIN admin (el que queremos)" -ForegroundColor White
Write-Host "   En macOS ya funciona en iOS 26.5.2. Esto es lo que falta confirmar." -ForegroundColor DarkGray

function Capture($file, $argList, $secs) {
  $psi = Start-Process -FilePath $pmd -ArgumentList $argList -PassThru -NoNewWindow `
    -RedirectStandardOutput "$out\$file" -RedirectStandardError "$out\$($file).err"
  # El túnel tarda decenas de segundos: se espera la PRIMERA línea y recién ahí la ventana.
  $waited = 0
  while ($waited -lt 90 -and -not (Test-Path "$out\$file" -PathType Leaf -ErrorAction SilentlyContinue)) {
    Start-Sleep -Seconds 1; $waited++
  }
  while ($waited -lt 90 -and (Get-Item "$out\$file" -ErrorAction SilentlyContinue).Length -eq 0) {
    Start-Sleep -Seconds 1; $waited++
  }
  Start-Sleep -Seconds $secs
  if (-not $psi.HasExited) { Stop-Process -Id $psi.Id -Force -ErrorAction SilentlyContinue }
  return (Get-Item "$out\$file" -ErrorAction SilentlyContinue).Length -gt 0
}

$okGraphics = Capture "graphics.jsonl" @("-m","pymobiledevice3","developer","dvt","graphics") $Seconds
if ($okGraphics) {
  $lines = (Get-Content "$out\graphics.jsonl" | Measure-Object -Line).Lines
  Step "graphics.opengl (FPS + GPU)" "PASS" "$lines líneas"
  $first = Get-Content "$out\graphics.jsonl" -TotalCount 1
  Write-Host "         $($first.Substring(0, [Math]::Min(120, $first.Length)))" -ForegroundColor DarkGray
} else {
  Step "graphics.opengl (FPS + GPU)" "FAIL" "ver graphics.jsonl.err"
}

$okSysmon = Capture "sysmon.txt" @("-m","pymobiledevice3","developer","dvt","sysmon","process","monitor","process","--filter","name=$Process","--choose","first","--key","pid","--key","name","--key","cpuUsage","--key","physFootprint") $Seconds
if ($okSysmon) {
  Step "sysmontap (CPU + memoria)" "PASS" "proceso '$Process'"
} else {
  Step "sysmontap (CPU + memoria)" "INFO" "sin datos para '$Process' — ¿el juego está abierto?"
}

# ──────────────────────────────────── 4. escalón 2 (lockdown)
Write-Host "`n4. Escalón 2 — lockdown (no depende del túnel)" -ForegroundColor White
if (Capture "battery.jsonl" @("-m","pymobiledevice3","diagnostics","battery","monitor") 8) {
  Step "batería" "PASS" (Get-Content "$out\battery.jsonl" -TotalCount 1)
} else { Step "batería" "FAIL" "ver battery.jsonl.err" }

# ────────────────────────────────────────────────────── veredicto
Write-Host "`n5. Veredicto" -ForegroundColor White
$pass = ($results | Where-Object Estado -eq 'PASS').Count
$fail = ($results | Where-Object Estado -eq 'FAIL').Count

if ($okGraphics) {
  Step "VIABLE EN WINDOWS SIN ADMIN" "PASS" "el túnel userspace levantó igual que en macOS"
} else {
  Step "camino A falló en Windows" "FAIL" "probar el fallback elevado (consola como Admin):"
  Write-Host "         $pmd -m pymobiledevice3 remote tunneld" -ForegroundColor DarkGray
  Write-Host "         luego: curl http://127.0.0.1:49151/" -ForegroundColor DarkGray
}

$md = @("# Spike iOS en Windows — $stamp", "",
  "- **$pass PASS · $fail FAIL**",
  "- OS: $((Get-CimInstance Win32_OperatingSystem).Caption)",
  "- pymobiledevice3: $($ver.Trim())",
  "- device: $($phone.ProductType) iOS $($phone.ProductVersion)", "",
  "| Paso | Estado | Detalle |", "|---|---|---|")
foreach ($r in $results) { $md += "| $($r.Paso) | $($r.Estado) | $($r.Detalle) |" }
$md += @("", "Archivos crudos en ``$out`` (con PII — pasarlos por el scrub antes de commitear).")
$md -join "`n" | Out-File "$out\RESULTADO.md" -Encoding utf8

Write-Host "`n  resumen: $out\RESULTADO.md`n"
