---
label: wayfinder:ticket
title: Installer y preflight iOS — Python, pymobiledevice3, wintun y tunneld como servicio
status: open
assignee:
blocked-by: [033, 034]
---

# 041 — Installer + preflight iOS

## Question

¿Cómo llega toda la cadena iOS a la máquina del QA sin que vea Python, y cómo se
diagnostica cuando algo falta?

## Contexto (grilling 2026-08-10)

La promesa de distribución es `INSTALAR.bat` → doble click → sin conocimientos técnicos.
Sumar iOS la rompe si no se diseña.

### Decisiones ya tomadas

1. **El installer baja todo.** `INSTALAR.bat` instala Python (winget) + `pymobiledevice3`
   (pip, **versión pineada**), además de Bun y platform-tools. El QA nunca ve Python. Se
   descartó vendorizar un binario congelado (PyInstaller — el proyecto tiene la receta pero
   **no publica assets** en sus releases, así que habría que mantener esa infra nosotros) y
   se descartó pedirle al QA que instale Python a mano.
   **`wintun.dll` ya no está en la lista**: el research del 044 encontró que viene
   empaquetado dentro de `pytun-pmd3`, dependencia de `pymobiledevice3`.
2. **El installer instala, el preflight diagnostica.** El preflight tiene que verificar
   la cadena en runtime y dar remedios en texto — es la red de contención de **R5**
   (drift de versión de Python o pip caído: fallas que un binario congelado no tendría).
3. **Privilegio: probablemente NINGUNO.** ⚠️ Esta decisión cambió después del grilling.
   El research del 044 encontró que en **iOS 17.4+ el túnel no necesita root**:
   `pymobiledevice3` levanta un túnel **userspace** (stack TCP/IP puro-Python) solo, y la
   limitación documentada — que el túnel vive dentro del proceso — no nos afecta, porque
   el profiler spawnea un `pymobiledevice3` de larga duración y lee su stdout, igual que
   `streamShell()` con `adb logcat`.

   ⇒ **El servicio `tunneld` pasa de requisito a fallback.** Si el camino A del spike 033
   funciona, este ticket se simplifica muchísimo: no hay servicio residente, no hay
   `DESINSTALAR.bat`, no hay adaptador TUN, no hay elevación. **No construir el servicio
   hasta que el 033 diga que hace falta.**

   Si el 033 obliga al fallback, vale lo decidido en el grilling: elevación en
   install-time (`INSTALAR.bat` ya corre elevado para winget) registrando
   `pymobiledevice3 remote tunneld` como servicio (Windows Service / LaunchDaemon),
   profiler sin privilegios pegándole a `127.0.0.1:49151`. Se descartó UAC por sesión:
   dejaría corriendo elevados el server HTTP local y el proxy MITM con CA propia.

### Lo que hay que construir

- Generalizar `src/core/preflight/` de "adb" a "toolchain": hoy tiene `discoverAdb`
  (config→PATH→SDK→managed), `installPlatformTools` con deps inyectadas, y una máquina
  de estados Start→…→Ready con remedios en texto que el CLI renderiza con ✓/✗/–. La
  cadena iOS entra como segunda herramienta gestionada en el mismo gate.
- Requisito que el installer **no** puede resolver solo: el servicio usbmux de Apple
  (`AppleMobileDeviceService`), que llega con iTunes o con la app "Apple Devices" de la
  Store. Es el `adb` de iOS y no se puede vendorizar — el preflight tiene que detectarlo
  y explicarlo.
- `DESINSTALAR.bat` — **sólo si se termina yendo por el fallback de tunneld**: ahí el
  servicio queda residente y consume un adaptador TUN, y tiene que poder pararse y
  desinstalarse limpio. En el camino userspace no hay nada que desinstalar.
- Pareo y montaje del DDI: decidir qué automatiza el installer y qué queda como checklist.
  `lockdown remotepairing --pair` corre sobre el USB ya confiado y **no muestra diálogo de
  Trust** en pantalla, así que es automatizable; el DDI puede que se auto-monte en iOS 18+
  (a confirmar en el 033).

## Riesgo despejado

**R2 cerrado (2026-08-10)**: el QA tiene permisos de administrador y las máquinas son
**personales**, no corporativas. El servicio `tunneld` se puede instalar sin pelear con
política de IT, y no hay proxy corporativo que rompa el `pip install` — R5 queda degradado
a drift de versión de Python, que el preflight cubre.

El camino de fallback (UAC por sesión) **no hace falta construirlo**. Si algún día la tool
sale a una máquina corporativa, vuelve a la mesa.
