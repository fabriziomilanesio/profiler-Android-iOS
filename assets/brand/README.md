# Brand assets — Mobile Profiler

Assets de branding para la UI del profiler y el reporte HTML (ticket wayfinder 006).
**No hay SVG de ninguna de las dos marcas en el workspace** — todo lo encontrado es PNG.
Los PNG elegidos son grandes y con fondo transparente, aptos para web/@2x.

## Archivos

| Archivo | Qué es | Dimensiones | Procedencia (path original) |
| --- | --- | --- | --- |
| `sample-logo.png` | Logo "Sample App" full-color (letras doradas con borde blanco, fondo transparente). **Protagonista** para UI y reporte. | 939×473 | `samplearcade/Assets/_SampleApp/Sprites/Splash/logo.png` (Git LFS, `oid 42b24a9a…`, bajado del LFS de `gitlab.com:sample1/samplearcade`) |
| `sample-logo-white.png` | Wordmark "Sample App" monocromo blanco (transparente). Variante para fondos oscuros / footers. | 2148×888 | `samplearcade/Assets/_SampleApp/Sprites/Icon/SampleGsames-logoWhite.png` (Git LFS, `oid e237c901…`) |
| `sample-appicon.png` | App icon cuadrado de Sample App (fondo violeta, estrellas). Útil como favicon/icono de la tool. | 1024×1024 | `samplearcade/Assets/_SampleApp/Sprites/Icon/Sample app icon_01.png` (Git LFS, `oid 613948c4…`) |
| `generic-logo.png` | Logo : mascota (dragón teal con lengua magenta) + wordmark **blanco** — pensado para fondo oscuro. **Secundario.** | 800×520 | `sample/.agents/skills/branded-doc-builder/assets/generic-logo.png` (mismo archivo que usa `~/.claude/skills/generic-cronograma/generic-logo.png` y `mermaid-branded`) |

Notas de uso:

- El logo de Sample App en el working tree de `samplearcade/` es un **puntero Git LFS**
  (el repo local no tiene los blobs); estos PNG se bajaron vía la LFS batch API de GitLab con
  las credenciales SSH del repo, sin tocar el working tree.
- `sample-logo-white.png` y `generic-logo.png` son blancos → **solo sobre fondo oscuro**
  (invisibles sobre blanco). `sample-logo.png` funciona sobre claro y oscuro.

## Colores de marca — Generic (de `~/.claude/skills/mermaid-branded/brands.json`)

Identidad "gaming-neon" que ya usan las skills brandeadas (`mermaid-branded`,
`generic-cronograma`, `branded-doc-builder`):

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

No hay paleta formal documentada para **Sample App**; del logo/app icon: dorado/naranja
(letras), violeta (fondo del icon), blanco (bordes).

## generic-dog.png

Mascota sola (sin wordmark), full-color, fondo transparente, 72×72 — es el ícono oficial
del sitio: https://www.generic.com/wp-content/uploads/2025/02/icono.png (favicon /
apple-touch-icon). Única resolución pública; para >80px de render pedir el vector a diseño.
Funciona sobre fondo claro y oscuro (no usar la variante del logo grande recortada: tiene
ojos/dientes blancos pensados para fondo oscuro).
