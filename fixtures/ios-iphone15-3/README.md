# Fixtures: iPhone15,3 (iOS 26.5.2)

Salida **cruda** de `pymobiledevice3`, sin procesar, capturada el 2026-08-10 con
**Evermore Arcade corriendo** (`com.evermoregames.evermorearcade`, pid 63819) en un
iPhone 14 Pro Max con iOS 26.5.2 y `pymobiledevice3` 10.7.2. Son la fuente de verdad de
los parsers iOS (tests capa 1). No editar a mano.

**PII**: estos archivos NO tienen. Sólo hay métricas de proceso, pid y nombre de app — ni
UDID, ni serial, ni nombre del device. Igual pasaron por el gate
(`bun run scripts/scrub-fixtures.ts --check fixtures/`), que es obligatorio para cualquier
captura nueva. La ficha del device y el pareo SÍ traen PII y por eso no están acá.

## Archivos

- `graphics.jsonl` — `pymobiledevice3 developer dvt graphics`. Un JSON por línea.
- `sysmon-pretty.txt` — `pymobiledevice3 developer dvt sysmon process monitor process
  --filter name=EvermoreArcade --choose first --key …`. **JSON pretty multi-línea**, no
  JSON-lines, precedido por el banner `Monitoring pid=…`. Esa diferencia es la razón de
  que exista `SysmonAssembler`.

## Lo que estos datos enseñan

- El juego corre a **57–60 FPS** y le sobra GPU (12,5 % promedio de `Device Utilization`).
- **`physFootprint` ≈ 1 GB**, del cual **más de la mitad es `memCompressed`** (578 MB de
  1023 MB): iOS está comprimiendo páginas agresivamente. El footprint es el número que
  mira el jetsam, así que ese perfil es el que termina en cierres en devices más chicos.
- **`CoreAnimationFramesPerSecond` vale 0** cuando no se compone ningún frame (app en
  segundo plano, pantalla quieta). Es un cero legítimo, no un N/A: de 149 muestras de la
  captura completa, 107 fueron ceros y el promedio crudo daba 16 FPS contra 57 reales.
  Los parsers y el sampler tienen que distinguirlos.

## Comandos que NO existen en este device

- `bundleIdentifier` no está entre los atributos de sysmontap en iOS 26 ⇒ el filtro va por
  `name` de proceso.
- No hay histograma de frame-times en `graphics.opengl` ⇒ p50/p90/p99 y jank son N/A en
  iOS (ver `src/core/platform.ts`).
