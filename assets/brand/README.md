# Brand assets — Evermore Android Profiler

Assets de branding para la UI del profiler y el reporte HTML (ticket wayfinder 006).
**No hay SVG de ninguna de las dos marcas en el workspace** — todo lo encontrado es PNG.
Los PNG elegidos son grandes y con fondo transparente, aptos para web/@2x.

## Archivos

| Archivo | Qué es | Dimensiones | Procedencia (path original) |
| --- | --- | --- | --- |
| `evermore-logo.png` | Logo "Evermore Arcade" full-color (letras doradas con borde blanco, fondo transparente). **Protagonista** para UI y reporte. | 939×473 | `evermorearcade/Assets/_EvermoreArcade/Sprites/Splash/logo.png` (Git LFS, `oid 42b24a9a…`, bajado del LFS de `gitlab.com:evermore1/evermorearcade`) |
| `evermore-logo-white.png` | Wordmark "Evermore Games" monocromo blanco (transparente). Variante para fondos oscuros / footers. | 2148×888 | `evermorearcade/Assets/_EvermoreArcade/Sprites/Icon/EvermoreGsames-logoWhite.png` (Git LFS, `oid e237c901…`) |
| `evermore-appicon.png` | App icon cuadrado de Evermore Arcade (fondo violeta, estrellas). Útil como favicon/icono de la tool. | 1024×1024 | `evermorearcade/Assets/_EvermoreArcade/Sprites/Icon/Evermore app icon_01.png` (Git LFS, `oid 613948c4…`) |
| `odaclick-logo.png` | Logo Odaclick Game Studio: mascota (dragón teal con lengua magenta) + wordmark **blanco** — pensado para fondo oscuro. **Secundario.** | 800×520 | `evermore/.agents/skills/branded-doc-builder/assets/odaclick-logo.png` (mismo archivo que usa `~/.claude/skills/odaclick-cronograma/odaclick-logo.png` y `mermaid-branded`) |

Notas de uso:

- El logo de Evermore Arcade en el working tree de `evermorearcade/` es un **puntero Git LFS**
  (el repo local no tiene los blobs); estos PNG se bajaron vía la LFS batch API de GitLab con
  las credenciales SSH del repo, sin tocar el working tree.
- `evermore-logo-white.png` y `odaclick-logo.png` son blancos → **solo sobre fondo oscuro**
  (invisibles sobre blanco). `evermore-logo.png` funciona sobre claro y oscuro.

## Colores de marca — Odaclick (de `~/.claude/skills/mermaid-branded/brands.json`)

Identidad "gaming-neon" que ya usan las skills brandeadas (`mermaid-branded`,
`odaclick-cronograma`, `branded-doc-builder`):

| Token | Hex |
| --- | --- |
| primary (magenta) | `#EB008B` |
| secondary (teal) | `#00E6DA` |
| bg | `#0B0B10` |
| bgCard | `#15151D` |
| bgCard2 | `#1B1B25` |
| text | `#F2F2F6` |
| muted | `#9B9BAB` |
| line | `#2A2A38` |

Fuentes: **Baloo 2** (títulos) + **Inter** (cuerpo) —
`https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap`

No hay paleta formal documentada para **Evermore Arcade**; del logo/app icon: dorado/naranja
(letras), violeta (fondo del icon), blanco (bordes).

## odaclick-dog.png

Mascota sola (sin wordmark), full-color, fondo transparente, 72×72 — es el ícono oficial
del sitio: https://www.odaclick.com/wp-content/uploads/2025/02/icono.png (favicon /
apple-touch-icon). Única resolución pública; para >80px de render pedir el vector a diseño.
Funciona sobre fondo claro y oscuro (no usar la variante del logo grande recortada: tiene
ojos/dientes blancos pensados para fondo oscuro).
