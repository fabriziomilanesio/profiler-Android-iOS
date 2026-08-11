#!/usr/bin/env bash
# spike-ios.sh — harness del ticket 033 (spike de viabilidad iOS) para macOS/Linux.
#
# Con el iPhone enchufado y DESBLOQUEADO, esto es un solo comando. Prueba primero el
# camino SIN privilegios (túnel userspace, hallazgo del research 044) y sólo cae al
# camino elevado si el primero falla.
#
#   bash scripts/spike-ios.sh                 # corrida normal
#   bash scripts/spike-ios.sh --install       # crea el venv gestionado e instala pymobiledevice3
#   bash scripts/spike-ios.sh --seconds 300   # ventana de captura más larga (default 60)
#   bash scripts/spike-ios.sh --bundle com.otra.app
#   bash scripts/spike-ios.sh --process EvermoreArcade   # si el nombre de proceso difiere
#
# Guarda TODO crudo en .tmp/spike-ios/<timestamp>/ y escribe un SUMMARY.md al final.
# ⚠️ Esa salida tiene PII sin redactar (UDID, ECID, serial, IMEI, teléfono). `.tmp/` está
# en .gitignore. Antes de mover cualquier cosa a fixtures/, pasarla por
# `bun run scripts/scrub-fixtures.ts` (ticket 036).

set -uo pipefail

BUNDLE="com.evermoregames.evermorearcade.internal"
PROC=""
UDID="${PYMOBILEDEVICE3_UDID:-}"
# El túnel userspace tarda decenas de segundos en levantar y los samples empiezan después:
# 10 s daban archivo vacío y veredicto falso-negativo. 60 s es el piso razonable.
SECONDS_WINDOW=60
DO_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) DO_INSTALL=1; shift ;;
    --seconds) SECONDS_WINDOW="$2"; shift 2 ;;
    --bundle)  BUNDLE="$2"; shift 2 ;;
    --process) PROC="$2"; shift 2 ;;
    --udid)    UDID="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "opción desconocida: $1"; exit 2 ;;
  esac
done

# sysmontap filtra por NOMBRE DE PROCESO, no por bundle id (iOS 26 no expone
# bundleIdentifier). Para una app Unity el proceso suele llamarse como el último segmento
# del bundle; si no matchea, se pisa con --process.
[[ -z "$PROC" ]] && PROC="${BUNDLE##*.}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/.tmp/spike-ios/$STAMP"
mkdir -p "$OUT"

# Venv gestionado, al lado de las sesiones. Prefigura lo que hará el installer del ticket
# 041: una toolchain gestionada por la tool, igual que `installPlatformTools` con adb — sin
# ensuciar el Python del sistema ni pelear con PEP 668.
VENV="$HOME/.evermore-profiler/pmd3-venv"
if [[ -x "$VENV/bin/python" ]]; then
  PMD=("$VENV/bin/python" -m pymobiledevice3)
  PMD_SOURCE="venv gestionado ($VENV)"
else
  PMD=(python3 -m pymobiledevice3)
  PMD_SOURCE="python3 del sistema"
fi

ok()   { printf '  \033[32m✓\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m  %s\n' "$*"; }
skip() { printf '  \033[90m–\033[0m  %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Levantar el túnel userspace tarda ~15 s: contar la ventana desde el spawn deja el
# archivo vacío y hace creer que el canal no funciona (nos pasó en la primera corrida).
# Se espera la PRIMERA línea hasta TUNNEL_WAIT, y recién ahí arranca la ventana de captura.
TUNNEL_WAIT=60

capture_for() {
  local secs="$1" file="$2"; shift 2
  ( "$@" >"$OUT/$file" 2>"$OUT/${file%.*}.err" ) &
  local pid=$! waited=0
  while [[ ! -s "$OUT/$file" ]] && [[ $waited -lt $TUNNEL_WAIT ]] && kill -0 "$pid" 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
  done
  if [[ -s "$OUT/$file" ]]; then
    [[ $waited -gt 3 ]] && printf '     (túnel arriba en %ss)\n' "$waited"
    local captured=0
    while [[ $captured -lt $secs ]] && kill -0 "$pid" 2>/dev/null; do
      sleep 1; captured=$((captured + 1))
    done
  fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  [[ -s "$OUT/$file" ]]
}

run_json() {
  local file="$1"; shift
  if "$@" >"$OUT/$file" 2>"$OUT/${file%.json}.err"; then
    [[ -s "$OUT/$file" ]]
  else
    return 1
  fi
}

echo "Spike iOS — ticket 033"
echo "salida: $OUT"
echo "bundle: $BUNDLE   ventana: ${SECONDS_WINDOW}s"

# ─────────────────────────────────────────────────────────────── 1. dependencias
head_ "1. Dependencias del host"

if ! command -v python3 >/dev/null 2>&1; then
  bad "python3 no está en el PATH — instalalo y volvé a correr"
  exit 1
fi
ok "python3 $(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:3])))')"

if [[ $DO_INSTALL -eq 1 ]]; then
  echo "     creando venv gestionado en $VENV…"
  python3 -m venv "$VENV" >"$OUT/pip-install.log" 2>&1
  "$VENV/bin/python" -m pip install --upgrade pip pymobiledevice3 >>"$OUT/pip-install.log" 2>&1 \
    && { ok "pymobiledevice3 instalado en el venv"; PMD=("$VENV/bin/python" -m pymobiledevice3); \
         PMD_SOURCE="venv gestionado ($VENV)"; } \
    || bad "pip falló — ver pip-install.log"
fi

if ! "${PMD[@]}" version >"$OUT/pmd3-version.txt" 2>&1; then
  bad "pymobiledevice3 no responde. Corré: bash scripts/spike-ios.sh --install"
  exit 1
fi
ok "origen: $PMD_SOURCE"
PMD_VERSION="$(tr -d '\r\n' < "$OUT/pmd3-version.txt")"
ok "pymobiledevice3 $PMD_VERSION  ← ESTA es la versión a pinear (R4)"

# ───────────────────────────────────────────────────────────────── 2. el device
head_ "2. Device"

if run_json devices.json "${PMD[@]}" usbmux list; then
  ok "usbmux ve al menos un device"
  python3 - "$OUT/devices.json" <<'PY' || true
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for d in (data if isinstance(data, list) else [data]):
    print("     UDID {}  iOS {}  {}".format(
        (d.get("Identifier") or d.get("UniqueDeviceID") or "?")[:8] + "…",
        d.get("ProductVersion", "?"), d.get("DeviceName", "?")))
PY
else
  bad "usbmux no ve devices. ¿iPhone enchufado, desbloqueado y con Trust dado?"
  echo "     (en Windows además hace falta 'Apple Devices' o iTunes instalado)"
  exit 1
fi

# Con más de un device conectado (iPhone + iPad, o el mismo por USB y wifi) TODOS los
# comandos abortan pidiendo desambiguar: "interactive selection requires a terminal".
# Se fija el UDID por env para toda la corrida — aplica a cada subcomando sin pasar flags.
if [[ -z "$UDID" ]]; then
  UDID="$(python3 - "$OUT/devices.json" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
devs = data if isinstance(data, list) else [data]
seen, uniq = set(), []
for d in devs:
    u = d.get("Identifier") or d.get("UniqueDeviceID")
    if u and u not in seen:
        seen.add(u); uniq.append(d)
if not uniq:
    sys.exit(0)
# con varios, se prefiere un iPhone sobre un iPad/otro
phones = [d for d in uniq if str(d.get("ProductType", "")).startswith("iPhone")]
pick = (phones or uniq)[0]
print(pick.get("Identifier") or pick.get("UniqueDeviceID"))
PY
)"
fi

if [[ -n "$UDID" ]]; then
  export PYMOBILEDEVICE3_UDID="$UDID"
  ok "device fijado: …${UDID: -6} (pisalo con --udid <UDID> si es el equivocado)"
else
  skip "no se pudo fijar UDID — con varios devices los comandos van a abortar"
fi

if run_json pair.json "${PMD[@]}" lockdown remotepairing --pair; then
  ok "remotepairing --pair OK (sin diálogo de Trust — corre sobre el USB ya confiado)"
else
  skip "remotepairing --pair falló o no hizo falta — ver pair.err"
fi

if run_json ddi-mount.json "${PMD[@]}" mounter auto-mount; then
  ok "DDI montado (o ya estaba)"
else
  skip "mounter auto-mount falló — ver ddi-mount.err (en iOS 18+ puede no hacer falta)"
fi

# ──────────────────────────────────────────── 3. CAMINO A — sin privilegios
head_ "3. Camino A — túnel userspace, SIN sudo (el que queremos que funcione)"
echo "     Si esto anda, el ticket 041 se simplifica: no hay servicio, no hay elevación."

CAMINO_A_GRAPHICS=0
CAMINO_A_SYSMON=0

if capture_for "$SECONDS_WINDOW" graphics.jsonl "${PMD[@]}" developer dvt graphics; then
  CAMINO_A_GRAPHICS=1
  ok "graphics.opengl emitió $(wc -l < "$OUT/graphics.jsonl" | tr -d ' ') líneas"
  echo "     claves observadas (EL ENTREGABLE MÁS IMPORTANTE DEL SPIKE):"
  python3 - "$OUT/graphics.jsonl" <<'PY' || true
import json, sys
keys = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: obj = json.loads(line)
    except Exception: continue
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.setdefault(k, type(v).__name__)
for k in sorted(keys):
    print(f"       - {k}: {keys[k]}")
if not keys:
    print("       (no se pudo parsear JSON — mirar graphics.jsonl crudo)")
PY
else
  bad "graphics.opengl no emitió nada — ver graphics.err"
fi

# OJO (verificado contra el device, 2026-08-10): iOS 26 NO expone `bundleIdentifier` entre
# los atributos de sysmontap — hay que filtrar por `name` de proceso. Y `monitor process`
# exige que el filtro resuelva a UN solo proceso: sin `--choose first` aborta listando
# todos los matches. El nombre del proceso de una app Unity es el del ejecutable, no el
# bundle id; PROC se deriva del bundle pero se puede pisar con --process.
if capture_for "$SECONDS_WINDOW" sysmon.jsonl "${PMD[@]}" developer dvt sysmon process monitor process \
     --filter "name=$PROC" --choose first --key pid --key name \
     --key cpuUsage --key physFootprint --key memResidentSize --key powerScore; then
  CAMINO_A_SYSMON=1
  ok "sysmontap emitió $(wc -l < "$OUT/sysmon.jsonl" | tr -d ' ') líneas para '$PROC'"
  echo "     primeras líneas:"
  head -8 "$OUT/sysmon.jsonl" | sed 's/^/       /'
else
  bad "sysmontap no emitió nada para '$PROC' — ¿el juego está abierto en el iPhone?"
  echo "     Para ver los procesos vivos y sacar el nombre exacto:"
  echo "       ${PMD[*]} developer dvt sysmon process monitor process --key pid --key name"
  echo "     (aborta a propósito listando todos los matches — de ahí se lee el nombre)"
  echo "     y después:  bash scripts/spike-ios.sh --process <NOMBRE>"
fi

# La lista COMPLETA de atributos que soporta este device (insumo del ticket 037): el CLI la
# imprime cuando se le pide una clave inexistente. Es la forma más barata de capturarla.
"${PMD[@]}" developer dvt sysmon process monitor process --key __inexistente__ \
  >/dev/null 2>"$OUT/sysmon-attrs.txt" || true
if grep -q "Possible keys" "$OUT/sysmon-attrs.txt" 2>/dev/null; then
  ok "atributos soportados por el device guardados en sysmon-attrs.txt"
fi

# Pregunta abierta del research: ¿pueden correr los dos a la vez?
#
# OJO: si el juego no está instalado, sysmon queda mudo por FALTA DE PROCESO, no por
# contención — y este paso daría un "NO" falso que empujaría la arquitectura a un solo
# proceso sin necesidad. Por eso, cuando el filtro de la app no resolvió, se mide contra un
# proceso de control que siempre existe.
CONTROL_PROC=backboardd
if [[ $CAMINO_A_SYSMON -eq 1 ]]; then CC_PROC="$PROC"; else CC_PROC="$CONTROL_PROC"; fi

head_ "3b. ¿Sobreviven graphics y sysmon SIMULTÁNEOS?"
echo "     (dos procesos, dos túneles userspace contra el mismo device; sysmon sobre '$CC_PROC')"
( "${PMD[@]}" developer dvt graphics >"$OUT/concurrent-graphics.jsonl" 2>"$OUT/concurrent-graphics.err" ) &
CG=$!
( "${PMD[@]}" developer dvt sysmon process monitor process --filter "name=$CC_PROC" --choose first \
    --key cpuUsage --key physFootprint >"$OUT/concurrent-sysmon.jsonl" 2>"$OUT/concurrent-sysmon.err" ) &
CS=$!
# mismo cuidado que capture_for: los dos túneles tardan en levantar
CWAIT=0
while [[ $CWAIT -lt $((TUNNEL_WAIT + SECONDS_WINDOW)) ]]; do
  [[ -s "$OUT/concurrent-graphics.jsonl" && -s "$OUT/concurrent-sysmon.jsonl" ]] && break
  sleep 1; CWAIT=$((CWAIT + 1))
done
sleep "$SECONDS_WINDOW"
kill $CG $CS 2>/dev/null; wait $CG $CS 2>/dev/null
# El banner "Monitoring pid=…" cuenta como línea pero NO es un sample: se exige más de una.
CC_G=$(wc -l < "$OUT/concurrent-graphics.jsonl" | tr -d ' ')
CC_S=$(wc -l < "$OUT/concurrent-sysmon.jsonl" | tr -d ' ')
if [[ "$CC_G" -gt 1 && "$CC_S" -gt 1 ]]; then
  CONCURRENT=1; ok "SÍ — los dos emitieron en paralelo ($CC_G / $CC_S líneas). El sampler puede ser dos procesos."
else
  CONCURRENT=0
  bad "NO concluyente ($CC_G / $CC_S líneas) — subí la ventana con --seconds antes de sacar conclusiones."
  echo "     Los túneles tardan decenas de segundos; una ventana corta da un NO falso."
fi

# ────────────────────────────────────────────── 4. escalón 2 (lockdown, sin DTX)
head_ "4. Escalón 2 — lockdown (no depende del túnel ni del DDI)"

run_json device-information.json "${PMD[@]}" developer dvt device-information \
  && ok "device-information" || skip "device-information falló"

capture_for 5 battery.jsonl "${PMD[@]}" diagnostics battery monitor \
  && { ok "batería"; echo "     $(head -1 "$OUT/battery.jsonl")"; \
       echo "     ⚠️ verificar unidades: Temperature (¿centi-°C?) y CurrentCapacity (¿% o mAh?)"; } \
  || skip "batería falló — ver battery.err"

capture_for 5 syslog.txt "${PMD[@]}" syslog live --process-name "$(basename "$BUNDLE")" \
  && ok "syslog ($(wc -l < "$OUT/syslog.txt" | tr -d ' ') líneas)" \
  || skip "syslog sin líneas — puede ser normal si la app no logueó en esos 5s"

run_json crash-ls.json "${PMD[@]}" crash ls && ok "crash ls" || skip "crash ls falló"

# ─────────────────────────────────────────────────────────────── 5. veredicto
head_ "5. Veredicto"

# Que sysmon no encuentre el proceso de la app NO es una falla del canal: si la lista de
# atributos volvió, el canal DTX está vivo y lo único que falta es la app instalada.
SYSMON_CHANNEL_OK=0
grep -q "Possible keys" "$OUT/sysmon-attrs.txt" 2>/dev/null && SYSMON_CHANNEL_OK=1

VERDICT="INDETERMINADO"
if [[ $CAMINO_A_GRAPHICS -eq 1 && $CAMINO_A_SYSMON -eq 1 ]]; then
  VERDICT="VIABLE SIN PRIVILEGIOS"
  ok "$VERDICT — el camino A funciona entero. El servicio elevado del 041 NO hace falta."
elif [[ $CAMINO_A_GRAPHICS -eq 1 && $SYSMON_CHANNEL_OK -eq 1 ]]; then
  VERDICT="VIABLE SIN PRIVILEGIOS (falta la app)"
  ok "$VERDICT — los dos canales DTX responden sin sudo."
  echo "     sysmon no encontró '$PROC' porque la app no está instalada/corriendo,"
  echo "     no porque el canal falle. Instalá el juego y volvé a correr (ticket 045)."
elif [[ $CAMINO_A_GRAPHICS -eq 1 || $CAMINO_A_SYSMON -eq 1 ]]; then
  VERDICT="PARCIAL"
  bad "$VERDICT — uno de los dos canales anduvo. Mirar los .err antes de ir al fallback."
else
  VERDICT="CAMINO A FALLÓ"
  bad "$VERDICT — probar el fallback elevado:"
  echo "       sudo python3 -m pymobiledevice3 remote tunneld"
  echo "       curl http://127.0.0.1:49151/"
fi

cat > "$OUT/SUMMARY.md" <<EOF
# Spike iOS — $STAMP

- **Veredicto**: $VERDICT
- pymobiledevice3: \`$PMD_VERSION\` ← pinear esta (R4)
- bundle: \`$BUNDLE\` · ventana: ${SECONDS_WINDOW}s · host: $(uname -s) $(uname -r)

## Las 6 preguntas del research 044

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | Claves completas de \`graphics.opengl\` | ver \`graphics.jsonl\` y la lista impresa por el script |
| 2 | ¿El túnel userspace aguanta sesiones largas (30+ min)? | **NO MEDIDO** — correr con \`--seconds 1800\` |
| 3 | ¿graphics y sysmon simultáneos? | $([[ ${CONCURRENT:-0} -eq 1 ]] && echo "SÍ" || echo "NO") |
| 4 | Overhead en el device | **NO MEDIDO** — comparar FPS con y sin profiler |
| 5 | Unidades de batería / normalización de cpuUsage | ver \`battery.jsonl\` y \`sysmon.jsonl\` |
| 6 | ¿DDI auto-montado en iOS 18+? | ver \`ddi-mount.json\` / \`ddi-mount.err\` |

## Archivos

$(cd "$OUT" && ls -1 | sed 's/^/- /')

⚠️ Todo esto tiene PII sin redactar. Antes de mover a \`fixtures/\`:
\`bun run scripts/scrub-fixtures.ts $OUT\`
EOF

echo
ok "resumen en $OUT/SUMMARY.md"
echo
echo "Pendientes que este script NO mide solo:"
echo "  · sesión larga (30+ min):  bash scripts/spike-ios.sh --seconds 1800"
echo "  · overhead: comparar el FPS del juego con y sin el profiler corriendo"
