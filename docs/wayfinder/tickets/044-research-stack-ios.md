---
label: wayfinder:ticket
title: Research del stack iOS — RemoteXPC, DTX y pymobiledevice3
status: closed
assignee: claude
blocked-by: []
---

# 044 — Research del stack iOS

## Question

Antes de gastar el device y el timebox del spike 033: ¿qué da exactamente cada canal iOS,
con qué comando, qué campos, y qué requisitos reales tiene en Windows? Desriesgar el spike
para que a la mañana sea correr algo, no investigar.

## Contexto

Ticket creado y resuelto la noche del 2026-08-10, con el frontier (033 y 034) bloqueado
por hardware que no estaba enchufado. Es AFK puro: leer fuente y documentación, sin device.

## Entregado

[`docs/research/ios-instruments-stack.md`](../../research/ios-instruments-stack.md) —
equivalente iOS del `dumpsys-formats.md`. Fuente de `pymobiledevice3` leída directo en el
commit `e371828` (2026-08-10), más las guías oficiales. Registro de lib en
[`docs/references/libs.md`](../../references/libs.md) como manda la regla 3 del DevWorkflow
(Context7 MCP no estaba disponible en la sesión; se fue a fuente primaria).

### Tres hallazgos que cambian decisiones ya tomadas

1. **El túnel NO necesita root en iOS 17.4+.** `pymobiledevice3` levanta un túnel
   **userspace** (stack TCP/IP puro-Python) automáticamente, sin que el usuario pida nada.
   La limitación documentada — el túnel vive dentro del proceso y no es alcanzable desde
   afuera — **no nos afecta**: nuestro modelo es spawnear un `pymobiledevice3` de larga
   duración y leer su stdout, igual que `AdbTransport.streamShell()` con `adb logcat`.
   ⇒ El servicio elevado del ticket 041 pasa de **requisito** a **fallback**.
2. **`wintun` viene adentro del `pip install`** (empaquetado en `pytun-pmd3`), y sólo hace
   falta para el túnel kernel. Un paso menos en `INSTALAR.bat`, o cero si va userspace.
3. **`crash watch` existe**: hay stream de crashes en vivo. ⇒ El problema de timing que el
   ticket 039 daba por seguro (crash como archivo post-mortem, sin marca en vivo sobre el
   timeline) **no existe**; el modelo del 027 se traslada casi tal cual.

### Otros hallazgos que bajan trabajo

- **El descriptor de capacidades del ticket 037 no hay que inventarlo**: `Sysmontap.create()`
  le pregunta al device qué atributos soporta (`DeviceInfo.sysmon_process_attributes()`).
  En Android las capacidades se descubren probando y fallando; en iOS se preguntan.
- Todos los comandos emiten **JSON por línea**, que es exactamente lo que consume el
  `streamLines` de `src/runtime/spawn.ts`. El adapter de runtime no cambia.
- `bundleIdentifier` está entre los campos de proceso ⇒ se matchea
  `com.evermoregames.evermorearcade.internal` sin adivinar nombres de proceso.
- Batería por lockdown da `InstantAmperage`/`Temperature`/`Voltage`/`IsCharging`/
  `CurrentCapacity` — casi 1:1 contra el `BatterySample` de Android.
- **Trampa a copiar del CLI oficial**: descarta la primera muestra de `SystemCPUUsage`
  (siempre da 100 o 0). Sin eso, el primer tick de cada sesión miente.
- No hay binario prebuilt oficial (el release v10.7.2 no publica assets) ⇒ la decisión (b)
  del grilling (installer instala Python + pip) queda confirmada.

## Lo que el research NO pudo contestar

Queda como trabajo del 033, y está listado al final del documento: el set completo de
claves de `graphics.opengl` (sólo se conoce contra el device), si el túnel userspace
aguanta sesiones largas, si `graphics` y `sysmon` pueden correr simultáneos como dos
procesos separados, el overhead real, las unidades de batería y si el DDI se auto-monta
en iOS 18+.
