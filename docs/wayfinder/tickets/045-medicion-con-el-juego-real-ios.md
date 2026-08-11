---
label: wayfinder:ticket
title: Medición iOS con el juego real — overhead, sesión larga y unidades bajo carga
status: open
assignee:
blocked-by: [033]
---

# 045 — Lo que el spike no pudo medir sin el juego

## Question

El spike 033 contestó la pregunta de viabilidad (**sí, sin privilegios**) pero midió contra
procesos del sistema, no contra evermorearcade. Quedan tres cosas que sólo se responden con
el juego instalado y corriendo en el iPhone.

## Contexto

Graduado del 033 la noche del 2026-08-10. El juego **no estaba instalado en el iPhone**
durante el spike, así que todo se validó contra `backboardd` y compañía. Eso alcanzó para
probar los canales, no para calibrar.

## Lo que falta medir

1. **Overhead en el device.** Es la restricción transversal que la iteración 2 se puso como
   regla dura ("cero overhead nuevo"), y en iOS todavía no se midió nada. Método: FPS del
   juego con y sin las dos suscripciones corriendo, misma escena. En Android esto motivó
   el rediseño de dos carriles del ticket 023 — acá puede no hacer falta, pero hay que
   verlo, no suponerlo.
2. **Sesión larga.** El túnel userspace es un stack TCP/IP en Python; se probó ~3 minutos
   sin degradarse. Falta una corrida de 30+ minutos, que es la duración real de una sesión
   de QA. Si se degrada, el fallback es `tunneld` (que sí exige elevación) y eso reabre
   el ticket 041.
3. **Unidades y semántica bajo carga.** `cpuUsage` de `backboardd` en reposo dio `0.324`:
   no se puede saber si es 0-1 o porcentaje sin un proceso que consuma CPU de verdad.
   De esto depende la normalización del ticket 037 y, por lo tanto, si el CPU% de iOS es
   comparable con el de Android.
4. **El nombre de proceso del juego.** iOS 26 **no expone `bundleIdentifier`** entre los
   atributos de sysmontap (verificado), así que el filtro va por `name`. Hay que confirmar
   con qué nombre aparece una build Unity de evermorearcade, y si levanta procesos hijos
   (el sampler de Android agrega main + hijos; en iOS habría que hacer lo mismo vía
   `ppid`/`parentUniqueID`).

## Prerequisito humano

⚠️ **Corrección (2026-08-10, misma noche)**: el spike concluyó "el juego no está instalado"
y era **falso**. Está instalado como **`com.evermoregames.evermorearcade`** (producción);
lo que no está es el `.internal` de `ProjectSettings`, que era el bundle que se filtraba.
El canal sysmontap enumera 338 procesos sin problema — sólo hay que **abrir la app** en el
iPhone para que su proceso aparezca.

La build de producción alcanza para todo lo de este ticket (CPU, memoria, FPS, GPU,
overhead): son métricas que reporta el sistema operativo, no instrumentación interna.
Sólo el SDK Unity futuro necesitaría una build propia.

Con el juego abierto, el harness ya existe:

```
bash scripts/spike-ios.sh --seconds 1800 --process <NOMBRE>
```
