# AGENTS.md — profiler-Android-iOS

## Propósito y uso de esta guía

Contexto operativo para trabajar en el repositorio sin explorarlo completo en cada tarea.
Base verificada: `main`, commit `4499ff267af38c7454ee7ae6f02cfdf7c8170ee2`
(`Merge feat/DualmodeUnifiedSettings into main`), el 2026-09-04.
Este hash identifica la revisión inicial; no es una instrucción para volver a ese commit.

Repositorio canónico: https://github.com/fabriziomilanesio/profiler-Android-iOS.
Usar `profiler-Android-iOS` para identificar el repositorio y `Mobile Profiler` para la
aplicación. No reintroducir marcas anteriores en código, documentación, interfaz ni assets.
El nombre de una carpeta local no define la identidad del proyecto; verificar el remoto.

- Al iniciar, leer esta guía y consultar `git status --short --branch`. Revisar solamente los
  módulos y tests relacionados con el pedido usando el mapa de archivos de abajo.
- El código de la rama de trabajo y sus tests prevalecen sobre descripciones desactualizadas.
  Consultar el diff relevante contra `main` cuando haya cambios posteriores a esta guía.
- `README.md` explica instalación y uso. `docs/wayfinder/map.md` y sus tickets contienen
  historia y planes: no asumir que un objetivo del mapa ya está implementado.
- Conservar cambios locales ajenos a la tarea. No cambiar de rama ni restaurar archivos para
  hacer coincidir el árbol de trabajo con esta revisión.

## Qué hace la aplicación

Profiler local para aplicaciones Android e iOS, con dashboard web en vivo, selección de
teléfono y aplicación, logs/crashes, historial de sesiones y reportes HTML autocontenidos.
Android se comunica por ADB; iOS, por Python + `pymobiledevice3`. No requiere un SDK dentro
de la aplicación. Los nombres internos actuales usan `sample`/`generic`: el paquete es
`@generic/sample-mobile-profiler`, aunque el repositorio se llama `profiler-Android-iOS`.

Stack: Bun >= 1.3, TypeScript estricto con módulos ESM, servidor HTTP/WebSocket local y UI
HTML/JavaScript plano. ECharts, Motion y fuentes están vendorizados. La UI no tiene un
framework ni una compilación separada. Bun genera ejecutables con los assets incluidos.

### Flujo principal

1. `src/cli.ts` interpreta `live` (predeterminado) o `preflight`, descubre ADB, carga `AppStore`
   y construye `LiveServer`. El dashboard usa `http://localhost:4517`, con escucha en loopback.
   Se abre el navegador salvo `--no-open`. Puede iniciar sin teléfono; ADB ausente sí bloquea
   el arranque actual del CLI. iOS es opcional y no debe impedir usar Android.
2. `LiveServer` lista dispositivos Android/iOS, gestiona selección y conexión, y elige
   `Sampler` para Android o `IosMetricSource` para iOS. Los transportes admiten sustitutos
   para tests sin hardware.
3. Se puede cambiar de app en caliente. Android intenta lanzarla si está cerrada; en iOS el
   usuario la abre y el profiler detecta su proceso. Sin `--package`, se retoma la última
   selección; el primer valor es `com.sample.oda.qa`. El filtro inicial es `sample`.
4. Ambas fuentes producen `Sample`; el servidor envía mensajes por `/ws` y mantiene buffers
   y registros JSONL. En el carril primario, si la app muere continúa el dashboard, se pausa
   la persistencia de muestras y se registran eventos `app-died`/`app-restarted`.
5. La UI muestra performance, memoria/sistema, red y logs, con paneles plegables, tema oscuro
   inicial, tema claro y un veredicto de performance. Configuración y exportación están en
   el menú del dashboard; los reportes se descargan y se copian a la carpeta configurada.

### Comparación dual y espejo

- `src/ui/live.js` construye dos iframes reutilizando el dashboard: `/?pane=primary` y
  `/?pane=secondary`. Cada carril tiene su dispositivo/app, muestras y captura de logs.
  `messages.ts` identifica el carril con `pane`; omitido equivale a `primary` por compatibilidad.
- `LiveServer` mantiene el estado secundario, timers y streams separados. Un tick lento de B
  no bloquea A. Salir del modo dual libera los recursos de B y conserva A.
- `Dual Settings` reúne filtro de apps, intervalo, target FPS, carpeta de reportes, historial
  dual y exportación por ventana. El intervalo Auto compartido toma el mayor intervalo
  requerido por los dos dispositivos. Tema y disposición tienen controles por panel.
- Se permiten Android/Android, iOS/iOS y combinaciones. `dualComparison.js` y `capabilities.js`
  adaptan los paneles y avisos cuando participa iOS; no prometer paridad de métricas.
- Si B elige el mismo teléfono que A, actúa como espejo y reutiliza el flujo primario: no
  abrir otro sampler sobre ese teléfono. El espejo está vinculado al serial original; al
  cambiar A, B puede pasar a ser independiente sobre el dispositivo anterior.
- El espejo bloquea el reporte dual y la consulta de registros duales. No describirlo como
  dos mediciones independientes ni asumir que eso desactiva toda escritura interna.
- `DualSessionLog` agrupa ambos carriles bajo un ID. El reporte dual disponible contiene dos
  reportes individuales completos A/B dentro de un HTML. El botón adicional
  `Export Comparison Report` todavía es un placeholder: no genera una comparación nueva.

## Mapa de archivos: dónde intervenir

| Área                         | Entradas principales                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Arranque y requisitos        | `src/cli.ts`, `src/core/preflight/`, `INSTALAR.bat`, `INICIAR.bat`, `scripts/install-windows.ps1`                 |
| Transportes Android          | `src/core/adb/AdbTransport.ts`, `RealAdbTransport.ts`, `parseDevices.ts`, `listPackages.ts` dentro de esa carpeta |
| Métricas Android             | `src/core/sampler/sampler.ts`, `src/core/collectors/` (parsers por métrica)                                       |
| Transporte y métricas iOS    | `src/core/ios/IosTransport.ts`, `IosMetricSource.ts`, `resilientStream.ts` y parsers dentro de esa carpeta        |
| Contratos y capacidades      | `src/core/schema.ts`, `src/core/platform.ts`, `src/server/messages.ts`                                            |
| Orquestación y API           | `src/server/liveServer.ts`; buscar el handler del endpoint antes de leer el archivo entero                        |
| Runtime, estáticos y binario | `src/runtime/spawn.ts`, `src/runtime/httpServer.ts`, `src/server/staticFiles.ts`, `src/server/embeddedUi.ts`      |
| Dashboard y modo dual        | `src/ui/index.html`, `live.js`, `render.js`, `dualComparison.js`, `capabilities.js`                               |
| Logs/crashes                 | `src/core/logs/`, `src/core/ios/IosLogCapture.ts`, `src/ui/logsCore.js`, `logsPanel.js`                           |
| Inspector de red activo      | `src/server/inspectorProxy.ts` y handlers del inspector en `liveServer.ts`                                        |
| Configuración                | `src/core/appStore.ts` y `handlePutConfig` en `liveServer.ts`                                                     |
| Sesiones y reportes          | `src/core/session/`, `src/core/perf/`, `src/report/generateReport.ts`, `template.html`, `template.js`             |
| Pruebas del navegador        | `e2e/`, `scripts/e2e-harness.ts`, `playwright.config.ts`                                                          |
| Capturas y referencias       | `fixtures/`, `scripts/capture-fixtures.ts`, `scripts/scrub-fixtures.ts`, `docs/research/`                         |

`prototypes/` contiene prototipos; no es la UI servida en producción. Evitar buscar dentro
de `node_modules/`, librerías vendorizadas y capturas completas si la tarea no lo requiere.

## Contratos y convenciones que deben conservarse

### Métricas

- `Sample` es el contrato compartido entre fuentes, servidor, sesiones y UI. Un dato no
  disponible se representa con `null`, nunca con cero. Cero es una medición válida.
- Capacidad inexistente en la plataforma: ocultar su UI. Fallo temporal de una capacidad
  existente: mostrar N/A. La fuente de capacidades es `src/core/platform.ts`.
- CPU de la app se expresa como porcentaje del dispositivo completo (share-of-device,
  0–100); el texto equivalente a un core es otra representación. Android agrega procesos
  principal e hijos `pkg:*`.
- Android guarda memoria PSS y composición; iOS guarda `footprint`, `compressed` y RSS.
  No colocar footprint dentro de `mem.pss`. Memoria se expresa en MB.
- Android calcula FPS/frame-times con SurfaceFlinger sobre la capa elegida de la app;
  `gfxinfo` no sirve como sustituto para los frames de Unity. iOS obtiene FPS del compositor
  CoreAnimation; no hay histograma de frame-times ni jank/p90/p99 implementados.
- Android ofrece CPU/RAM usada del dispositivo, temperatura SoC y red device-wide. iOS no
  ofrece esas mediciones en el flujo actual: sí GPU con desglose renderer/tiler, temperatura
  de batería, carga y logs. La RAM total del teléfono iOS se consulta como metadato.
- Usar `comparabilityKey()` al razonar sobre series comparables: PSS/footprint y GPU Android/
  iOS tienen claves diferentes. FPS comparte clave, pero debe conservarse la explicación de
  su origen. No equiparar automáticamente métricas sólo porque tengan la misma unidad.
- Preservar lectura de sesiones antiguas: `DeviceInfo.platform` ausente significa Android y
  `Sample.frame` puede faltar. Toda ampliación de schema debe mantener compatibilidad.

### Muestreo y ciclo de vida

- Android tiene dos ritmos: `/proc`, `/sys`, RSS y FPS por tick; meminfo/PSS cada 15 s;
  térmica, batería y refresco periódico de procesos cada 10 s. Reutiliza los últimos datos
  lentos entre lecturas. No llevar `dumpsys meminfo` al ritmo rápido: altera la app medida.
- Auto usa 2 s con RAM menor a 4096 MB y 1 s en el resto. Los fallos de collectors son
  parciales; no deben interrumpir la sesión ni crear bucles de reintentos dentro del tick.
- GPU Android descubre una fuente sysfs compatible y dispone de fallback con `dumpsys gpu`.
- iOS mantiene suscripciones y lee el último valor recibido; `ResilientStream` recupera
  procesos de streaming. No abrir túnel o lanzar un comando de desarrollo nuevo por tick.
- Mantener separación entre desconexión del WebSocket, pérdida del teléfono y muerte de la
  app. El protocolo de conexión usa `connected`, `reconnecting`, `lost`.
- Al cambiar app/dispositivo o cerrar, liberar timers, streams, log captures, proxy y reverse
  correspondientes. No generalizar al carril B todos los detalles del ciclo de vida de A:
  sus implementaciones actuales no son idénticas.

### UI, reportes e inspector

- Si se agrega un asset servido por la UI, incluirlo en `src/server/embeddedUi.ts`: de otro
  modo puede funcionar desde fuentes y faltar en el ejecutable compilado.
- Los reportes incluyen datos, scripts, gráficos y fuentes; deben abrir sin servidor ni red.
  Mantener el escape de datos insertados en HTML/JavaScript.
- El semáforo FPS es verde >= target, amarillo >= 80% del target y rojo por debajo. Sin dato
  no es rojo. Default: 30 FPS. Los espejos de lógica entre core y JS tienen guardias en
  `src/ui/mirrors.test.ts`; actualizar ambos lados si cambia la regla.
- Los logs se envían en lotes, con ring buffer y exportación; evitar un mensaje WS por línea.
- El inspector integrado es pass-through: HTTP visible y túnel CONNECT para HTTPS sin
  descifrar payloads. Usa `adb reverse` y proxy global Android; debe restaurar el estado
  anterior y limpiar el reverse al detenerse. No está disponible en iOS.
- `src/core/http-inspector/` contiene CA, almacenamiento de flows y controlador de proxy,
  pero su existencia no significa que MITM esté integrado en `InspectorProxy`/`LiveServer`.

## API y almacenamiento local

La implementación de endpoints está en `src/server/liveServer.ts`:

| Función           | Endpoints                                                                    |
| ----------------- | ---------------------------------------------------------------------------- |
| Selección         | `GET /api/devices`, `POST /api/device`, `GET /api/packages`, `POST /api/app` |
| Preferencias      | `GET /api/config`, `PUT /api/config`                                         |
| Sesiones y export | `GET /api/sessions`, `GET /api/report`                                       |
| Dual              | `POST /api/dual`, `GET /api/dual/sessions`, `GET /api/dual/report`           |
| Logs              | `GET /api/logs`, `POST /api/logs/export`                                     |
| Inspector         | `POST /api/inspector`                                                        |

Los handlers que distinguen carril usan `pane=secondary` según su contrato. Revisar handler,
mensaje WS y consumidor JS juntos al modificar comunicación. Mantener validación de origen
local, identificadores de apps/sesiones y rutas de estáticos.

Datos de usuario fuera del repositorio:

- `~/.config/sample-profiler/config.json`: selección/ranking, filtro, tema, intervalo,
  target FPS y carpeta de reportes; migra el antiguo `apps.json`.
- `~/.config/sample-profiler/sessions/`: sesiones JSONL; subcarpeta `dual/` para pares.
- `~/.config/sample-profiler/reports/`: destino inicial de reportes; configurable.
- `~/.sample-profiler/pmd3-venv/`: entorno Python gestionado. No confundirlo con `.config`.

La persistencia de métricas es best-effort: un fallo de disco no debe detener el muestreo.
El buffer de muestras tiene capacidad de 28800 entradas (unas 8 h a 1 Hz, no 8 h a todo ritmo).
Para Python consultar `pythonCandidates()` y el constructor de `IosTransport`; la mención
de `MOBILE_PROFILER_PYTHON` en README no está conectada al arranque actual de `src/cli.ts`.

## Comandos y validación

Ejecutar desde la raíz del checkout con Bun en PATH:

```sh
bun install
bun start                              # dashboard real; requiere ADB disponible
bun start --no-open                    # evita abrir navegador
bun run src/cli.ts preflight
bun test src scripts                   # suite unitaria/integración; igual a bun run test
bun run typecheck
bun run fmt:check
bun run test:e2e                       # Playwright y harness; no requiere teléfono
bun run build
bun run build:win
```

- Elegir los tests relacionados con el cambio. Collectors: `parsers.test.ts` y sampler;
  iOS: tests de transporte/fuente/parsers y `iosConnection.test.ts`; dual: tests de servidor,
  `dualComparison.test.js`, `dualSessionLog.test.ts` y `e2e/dual-comparison.spec.ts`.
- Para cambios de UI, verificar también la interacción con navegador. Playwright usa el
  dashboard real y dispositivos falsos, puerto 8788; el control del harness usa 8789.
  Requiere navegador Playwright instalado. Eso no sustituye una medición en hardware real.
- Para un cambio sólo documental, verificar rutas, comandos y formato; no hace falta correr
  pruebas de dispositivos. `fmt:check` no incluye `AGENTS.md`: usar
  `bun x prettier --check AGENTS.md` explícitamente.
- Estilo del proyecto: sin punto y coma, comillas simples y ancho 100 según `.prettierrc`;
  TS tiene `strict` y `noUncheckedIndexedAccess`. Evitar reformatear archivos ajenos.
- Antes de commitear capturas: `bun run hooks:install`, redactar con
  `bun run scrub <ruta>` y comprobar con `bun run scripts/scrub-fixtures.ts --check <ruta>`.
  `bun run scrub:check` valida lo staged. No versionar seriales, UDID, IMEI, cuentas ni otros
  datos personales de dispositivos; los scripts de captura cruda usan `.tmp/`.

## Mantener AGENTS.md actualizado

Actualizar esta guía en el mismo cambio que introduce, elimina o modifica una funcionalidad
cuando afecte arquitectura, rutas de código, API, contratos de métricas, persistencia,
instalación, comandos o limitaciones. Esto es una regla de mantenimiento para futuras tareas;
no hay un proceso automático que regenere el archivo.

- Describir comportamiento ya implementado y comprobado. Separar placeholders e ideas.
- Sustituir información obsoleta; no añadir una crónica de cada tarea ni copiar tickets.
- Mantener el mapa breve y útil para ir directamente al módulo pertinente. Los detalles
  extensos de instalación/research deben seguir en README o `docs/`.
- Actualizar la referencia de revisión cuando se vuelva a verificar el conjunto contra
  `main`; si la función está aún en una rama, dejarlo claro sin presentarla como integrada.
- En la entrega de un cambio relevante, indicar si esta guía necesitó actualización y qué
  comprobaciones se realizaron. Si aparece una contradicción, corregirla con evidencia del
  código, sin alterar funcionalidades como parte de una tarea puramente documental.
