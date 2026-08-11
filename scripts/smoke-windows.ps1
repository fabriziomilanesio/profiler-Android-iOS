# smoke-windows.ps1 — validación del ticket 034: ¿el profiler funciona de verdad en una
# Windows real, con un Android conectado?
#
# Deuda que cierra: README.md dice que el .exe cross-compilado "tiene formato PE válido;
# falta validarlo corriendo en un Windows real". Nunca se ejecutó. Ahora Windows además es
# el host del camino iOS, así que esto pasa a ser prerequisito.
#
# Uso (PowerShell, en la raíz del repo, con el Android enchufado y con depuración USB):
#   powershell -ExecutionPolicy Bypass -File scripts\smoke-windows.ps1
#
# Opcional:
#   -SkipBuild        usa el dist\profiler.exe que ya exista
#   -Package <id>     app a profilear (default com.evermore.oda.qa)
#   -Seconds <n>      duración de la sesión en vivo (default 25)
#
# No modifica nada del repo: todo sale a .tmp\smoke-windows\<timestamp>\.
# Pegale el RESULTADO.md resultante a Ignacio/al ticket.

param(
  [switch]$SkipBuild,
  [string]$Package = "com.evermore.oda.qa",
  [int]$Seconds = 25
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $root ".tmp\smoke-windows\$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$results = @()
function Step($name, $status, $detail = "") {
  $script:results += [pscustomobject]@{ Paso = $name; Estado = $status; Detalle = $detail }
  $color = switch ($status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'DarkGray' } }
  Write-Host ("  {0,-6} {1}" -f $status, $name) -ForegroundColor $color
  if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray }
}

Write-Host "`nSmoke de Windows — ticket 034" -ForegroundColor Cyan
Write-Host "salida: $out`n"

# ─────────────────────────────────────────────────────────── 1. entorno
Write-Host "1. Entorno" -ForegroundColor White

$os = (Get-CimInstance Win32_OperatingSystem).Caption
Step "Windows" "INFO" $os

$bun = Get-Command bun -ErrorAction SilentlyContinue
if ($bun) { Step "bun en el PATH" "PASS" (& bun --version) }
else { Step "bun en el PATH" "FAIL" "corré INSTALAR.bat primero" }

$adb = Get-Command adb -ErrorAction SilentlyContinue
if ($adb) { Step "adb en el PATH" "PASS" ((& adb version) -split "`n")[0] }
else { Step "adb en el PATH" "FAIL" "winget install Google.PlatformTools" }

# ─────────────────────────────────────────────────────────── 2. device
Write-Host "`n2. Device Android" -ForegroundColor White

$devices = & adb devices -l 2>&1 | Out-String
$devices | Out-File "$out\adb-devices.txt"
if ($devices -match "device\s+product:") {
  Step "device conectado y autorizado" "PASS"
} elseif ($devices -match "unauthorized") {
  Step "device conectado" "FAIL" "aceptá el diálogo de depuración USB en el teléfono"
} else {
  Step "device conectado" "FAIL" "no hay device usable — el resto de los pasos van a fallar"
}

# ─────────────────────────────────────────────────────────── 3. build
Write-Host "`n3. Ejecutable" -ForegroundColor White

$exe = Join-Path $root "dist\profiler.exe"
if (-not $SkipBuild) {
  & bun run build 2>&1 | Out-File "$out\build.log"
  # `bun run build` produce dist\profiler (sin extensión) en el OS actual
  if (Test-Path (Join-Path $root "dist\profiler.exe")) { $exe = Join-Path $root "dist\profiler.exe" }
  elseif (Test-Path (Join-Path $root "dist\profiler")) { $exe = Join-Path $root "dist\profiler" }
}
if (Test-Path $exe) {
  $mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
  Step "ejecutable presente" "PASS" "$exe ($mb MB)"
} else {
  Step "ejecutable presente" "FAIL" "no se generó — ver build.log"
}

# ─────────────────────────────────────────────────────────── 4. preflight
Write-Host "`n4. Preflight (el comando default)" -ForegroundColor White

if (Test-Path $exe) {
  $pf = & $exe --package $Package 2>&1 | Out-String
  $pf | Out-File "$out\preflight.txt"
  if ($LASTEXITCODE -eq 0) { Step "preflight Ready" "PASS" }
  else { Step "preflight Ready" "FAIL" "exit $LASTEXITCODE — ver preflight.txt" }
}

# ─────────────────────────────────────────── 5. dashboard + UI embebida
Write-Host "`n5. Dashboard en vivo y UI embebida en el binario" -ForegroundColor White
Write-Host "   (esto es lo que la memoria del proyecto marcaba como dudoso:" -ForegroundColor DarkGray
Write-Host "    'bun build --compile no embebe src/ui')" -ForegroundColor DarkGray

$port = 7331
$proc = $null
if (Test-Path $exe) {
  $proc = Start-Process -FilePath $exe `
    -ArgumentList @("live", "--package", $Package, "--port", "$port", "--no-open") `
    -PassThru -RedirectStandardOutput "$out\live-stdout.txt" -RedirectStandardError "$out\live-stderr.txt"
  Start-Sleep -Seconds 8

  try {
    $html = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 10
    $html.Content | Out-File "$out\dashboard.html"
    if ($html.StatusCode -eq 200 -and $html.Content.Length -gt 2000) {
      Step "el binario sirve el dashboard" "PASS" "$($html.Content.Length) bytes"
    } else {
      Step "el binario sirve el dashboard" "FAIL" "status $($html.StatusCode), $($html.Content.Length) bytes"
    }
  } catch {
    Step "el binario sirve el dashboard" "FAIL" $_.Exception.Message
  }

  foreach ($ep in @("/api/devices", "/api/packages", "/api/config", "/api/sessions")) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port$ep" -UseBasicParsing -TimeoutSec 10
      $r.Content | Out-File "$out\api$($ep -replace '/','-').json"
      Step "GET $ep" "PASS" "$($r.StatusCode)"
    } catch {
      Step "GET $ep" "FAIL" $_.Exception.Message
    }
  }

  Write-Host "   corriendo una sesión de $Seconds s…" -ForegroundColor DarkGray
  Start-Sleep -Seconds $Seconds

  try {
    $rep = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/report" -UseBasicParsing -TimeoutSec 30
    $rep.Content | Out-File "$out\report.html"
    if ($rep.Content.Length -gt 5000) { Step "reporte HTML generado" "PASS" "$($rep.Content.Length) bytes" }
    else { Step "reporte HTML generado" "FAIL" "demasiado chico: $($rep.Content.Length) bytes" }
  } catch {
    Step "reporte HTML generado" "FAIL" $_.Exception.Message
  }

  try {
    $logs = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/logs" -UseBasicParsing -TimeoutSec 15
    $logs.Content | Out-File "$out\logs.json"
    Step "logs capturados" "PASS" "$($logs.Content.Length) bytes"
  } catch {
    Step "logs capturados" "FAIL" $_.Exception.Message
  }

  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}

# ─────────────────────────────────────────── 6. rutas con espacios
Write-Host "`n6. Rutas con espacios y perfil de usuario" -ForegroundColor White

$spaced = Join-Path $env:TEMP "carpeta con espacios\profiler test"
New-Item -ItemType Directory -Force -Path $spaced | Out-Null
if (Test-Path $exe) {
  Copy-Item $exe (Join-Path $spaced "profiler.exe") -Force
  $r = & (Join-Path $spaced "profiler.exe") --package $Package 2>&1 | Out-String
  $r | Out-File "$out\spaced-path.txt"
  if ($r -match "adb|Preflight|Ready|✓|✗") { Step "corre desde una ruta con espacios" "PASS" }
  else { Step "corre desde una ruta con espacios" "FAIL" "ver spaced-path.txt" }
}

$sessions = Join-Path $env:USERPROFILE ".evermore-profiler\sessions"
if (Test-Path $sessions) {
  $n = (Get-ChildItem $sessions -ErrorAction SilentlyContinue).Count
  Step "sesiones en el perfil del usuario" "PASS" "$sessions ($n entradas)"
} else {
  Step "sesiones en el perfil del usuario" "INFO" "todavía no existe $sessions"
}

# ─────────────────────────────────────────────────────────── resultado
$pass = ($results | Where-Object Estado -eq 'PASS').Count
$fail = ($results | Where-Object Estado -eq 'FAIL').Count

$md = @()
$md += "# Smoke de Windows — $stamp"
$md += ""
$md += "- **$pass PASS · $fail FAIL**"
$md += "- OS: $os"
$md += "- ejecutable: $exe"
$md += "- package: ``$Package`` · sesión: ${Seconds}s"
$md += ""
$md += "| Paso | Estado | Detalle |"
$md += "|---|---|---|"
foreach ($r in $results) { $md += "| $($r.Paso) | $($r.Estado) | $($r.Detalle) |" }
$md += ""
$md += "Archivos crudos en ``$out``."
$md -join "`n" | Out-File "$out\RESULTADO.md" -Encoding utf8

Write-Host ""
if ($fail -eq 0) { Write-Host "  $pass PASS · 0 FAIL" -ForegroundColor Green }
else { Write-Host "  $pass PASS · $fail FAIL" -ForegroundColor Red }
Write-Host "  resumen: $out\RESULTADO.md`n"
