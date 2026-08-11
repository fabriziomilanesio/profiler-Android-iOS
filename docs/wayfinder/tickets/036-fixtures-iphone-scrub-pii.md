---
label: wayfinder:ticket
title: Fixtures del iPhone real + gate automatizado de scrub de PII
status: open
assignee:
blocked-by: [033]
---

# 036 — Fixtures del iPhone + gate de scrub

## Question

Capturar los payloads crudos del iPhone real con evermorearcade corriendo, y dejarlos
commiteables sin filtrar PII. ¿Qué se captura, y cómo se garantiza el scrub?

## Contexto (grilling 2026-08-10)

- Es el calco del ticket 001, que salió bien: capturar primero, escribir parsers
  después. Los parsers del 038 se testean contra estos fixtures.
- **El iPhone es personal, no de QA.** Los dumps de lockdown traen **UDID, ECID,
  número de serie, IMEI, ICCID y número de teléfono** — PII bastante más sensible que
  la de Android.
- El checklist manual de Android (`fixtures/sm-a155m-api36/README.md`: serial,
  subscriberId, SSID, `ro.boot.em.did`, `ro.boot.kg.ap`) **ya falló una vez**: por eso
  existe la rama `pre-publish-history`, que conserva el serial real del Galaxy A15 sin
  redactar y no se puede pushear a ningún remoto nunca.

## Ya entregado (2026-08-10) — la mitad que no necesitaba el device

El gate está construido y verde; falta la captura, que sí necesita el juego instalado.

- `src/core/fixtures/scrub.ts` — lógica pura, **21 tests**. Dos familias de reglas:
  **por clave** (redacta el valor de una propiedad conocida en las cuatro serializaciones
  que aparecen en las capturas: getprop `[k]: [v]`, `k=v`, JSON y plist XML) y **por
  forma** (sólo alta especificidad: MAC, UDID moderno y legacy, teléfono internacional).
- **Decisión de diseño que importa**: NO hay regla "15 dígitos = IMEI". Los campos de
  sysmontap en nanosegundos (`cpuTotalUser`, `procAge`) tienen 15–19 dígitos y una regla
  así destruiría datos reales. El IMEI se ataca por clave. Hay tests explícitos de
  falsos positivos.
- Placeholders **estables** dentro de una corrida (`<REDACTED:UDID#1>`) para que una
  captura repartida en 30 ticks siga cruzando entre archivos. No se usa hash: para
  valores de baja entropía (teléfono, IMEI) un sha256 se rompe por fuerza bruta.
- Idempotente: correrlo dos veces no re-envuelve lo ya redactado (era un bug, lo cazó un test).
- `scripts/scrub-fixtures.ts` — CLI con `--check` (no escribe, sale 1) y `--staged`.
- `.githooks/pre-commit` + `bun run hooks:install` — el gate corre sobre lo staged.
- **Probado contra PII real**: sobre la captura del spike 033 detectó UDID, SERIAL y
  DEVICENAME, redactó, y la re-verificación quedó limpia.

## Decisión ya tomada en el grilling

El scrub es un **script de redacción que corre como gate antes del commit**, no una
lista en un README. Un checklist que se ejecuta con la mano falla la vez que estás
apurado. El gate falla el commit si detecta cualquiera de los patrones de PII conocidos
(Android e iOS) en `fixtures/`.

## A capturar

- Oneshot: ficha del device por lockdown, un `sysmontap` completo, un `graphics.opengl`
  completo, `diagnostics ioregistry` de `AppleSmartBattery`.
- Sesión de ~30 ticks con el juego corriendo (mismo formato que el fixture del A15).
- Un tramo de `syslog` de la app y, si se puede provocar, un crash report — insumo del 039.
- Estado final.

Anotar la versión de iOS del device y la de `pymobiledevice3` con la que se capturó: los
formatos cambian entre versiones (**R4**) y los fixtures sin esa marca envejecen mal.
