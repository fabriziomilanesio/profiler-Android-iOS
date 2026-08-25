---
id: 6
title: Conseguir logos de sample y Generic
label: wayfinder:task
status: closed
assignee: agent-brand
blocked-by: []
---

## Question

Obtener los assets de branding: logo de **sample** (protagonista, grande) y logo de
**Generic** (secundario), en formato apto para UI web y reporte HTML (SVG ideal; PNG @2x
aceptable). Buscar primero en el workspace (`samplearcade/`, `sample-cms/`, `vault/`,
Drive si hace falta); si no están, pedírselos al humano.

Dejarlos en `sample/profiler/assets/brand/` y anotar en el ticket la procedencia y
cualquier regla de uso (colores de marca, fondo claro/oscuro).

## Resolution (2026-07-16)

**Ambos logos conseguidos** — quedaron en `profiler/assets/brand/` (detalle completo con
tabla de procedencia y paleta en su `README.md`):

- `sample-logo.png` (939×473, transparente, full-color "Sample App") — protagonista.
  Origen: `samplearcade/Assets/_SampleApp/Sprites/Splash/logo.png`. Ese archivo en el
  working tree es un **puntero Git LFS** (el repo local no tiene los blobs); el binario se
  bajó vía la LFS batch API de `gitlab.com:sample1/samplearcade` con las credenciales SSH
  existentes, sin modificar `samplearcade/`.
- `sample-logo-white.png` (2148×888, wordmark "Sample App" blanco) — variante para
  fondo oscuro. Origen: `…/Sprites/Icon/SampleGsames-logoWhite.png` (LFS ídem).
- `sample-appicon.png` (1024×1024, app icon) — para favicon. Origen:
  `…/Sprites/Icon/Sample app icon_01.png` (LFS ídem).
- `generic-logo.png` (800×520, mascota + wordmark blanco, para fondo oscuro) — secundario.
  Origen: `sample/.agents/skills/branded-doc-builder/assets/generic-logo.png` (mismo asset
  que usan `generic-cronograma` y `mermaid-branded`).

**Colores de marca Generic** (de `~/.claude/skills/mermaid-branded/brands.json`): primary
`#EB008B`, secondary `#00E6DA`, bg `#0B0B10`, text `#F2F2F6`; fuentes Baloo 2 + Inter.
Copiados al README de brand.

**Descartados:** `sample-cms` solo tiene los logos default de React/CRA; `vault/` no tiene
imágenes; `_MainGame/Sprites/logo.png` y `_Skills/Sprites/Logo/logo.png` resultaron ser logos
de otros juegos ("Game Zone", "Trick Shot Pool").

**Falta / nice-to-have (no bloquea):** no existe **SVG vectorial** de ninguna de las dos
marcas en el workspace — si se quiere nitidez perfecta a cualquier escala, pedir al humano
los vectores originales (AI/SVG) de Sample App y Generic a diseño. Los PNG elegidos
son grandes y alcanzan para UI web y reporte HTML (el criterio del ticket: "PNG @2x
aceptable").
