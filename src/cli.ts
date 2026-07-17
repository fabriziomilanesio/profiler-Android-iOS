// Entry point del CLI. Corre el preflight gate completo (ticket 013): descubre
// adb (config → PATH → SDK → managed), opcionalmente instala platform-tools, y
// muestra la cadena de checks con ✓/✗/– y remedios. La UI web (panel visual +
// re-check por track-devices) llega con los tickets 007/010.
//
// Flags: --package <pkg> · --adb <ruta> · --install-platform-tools
// Env:   EVERMORE_PROFILER_ADB (ruta explícita de adb)
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RealAdbTransport } from './core/adb/RealAdbTransport'
import { discoverAdb } from './core/preflight/discoverAdb'
import { installPlatformTools, realInstallDeps } from './core/preflight/installPlatformTools'
import { Preflight, type PreflightReport } from './core/preflight/preflight'
import { LiveServer } from './server/liveServer'
import type { AdbTransport } from './core/adb/AdbTransport'

const DEFAULT_PACKAGE = 'com.evermore.oda.qa'

// El package viaja interpolado a `adb shell` (que pasa por el sh del device):
// validar acá corta cualquier inyección de comandos vía --package.
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

interface CliArgs {
  command: 'preflight' | 'live'
  packageName: string
  adbPath?: string
  installPlatformTools: boolean
  port?: number
  inspectHttp: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'preflight',
    packageName: DEFAULT_PACKAGE,
    installPlatformTools: false,
    inspectHttp: false,
  }
  let i = 0
  if (argv[0] === 'live') {
    args.command = 'live'
    i = 1
  } else if (argv[0] === 'preflight') {
    i = 1
  }
  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package' && argv[i + 1]) args.packageName = argv[++i]!
    else if (arg === '--adb' && argv[i + 1]) args.adbPath = argv[++i]!
    else if (arg === '--port' && argv[i + 1]) args.port = Number(argv[++i])
    else if (arg === '--install-platform-tools') args.installPlatformTools = true
    else if (arg === '--inspect' || arg === '--inspect-http') args.inspectHttp = true
    else {
      console.error(`Flag desconocido: ${arg}`)
      process.exit(2)
    }
  }
  if (!PACKAGE_RE.test(args.packageName)) {
    console.error(`--package inválido: "${args.packageName}" (se espera ej. com.empresa.app)`)
    process.exit(2)
  }
  if (
    args.port !== undefined &&
    (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)
  ) {
    console.error(`--port inválido: se espera un entero 1–65535`)
    process.exit(2)
  }
  return args
}

/** fs-checker real para discoverAdb. */
function isExecutable(path: string): boolean {
  try {
    // en Windows el bit X no aplica: alcanza con que exista
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const ICONS = { ok: '✓', fail: '✗', skipped: '–' } as const

function renderReport(report: PreflightReport): void {
  console.log('\nPreflight:')
  for (const link of report.links) {
    console.log(`  ${ICONS[link.result]} ${link.label} — ${link.detail}`)
    if (link.remedy) console.log(`      → ${link.remedy}`)
  }
  console.log(
    report.ready
      ? `\nReady: todo listo para profilear ${report.device?.serial ?? ''}`.trimEnd()
      : `\nPreflight incompleto (estado: ${report.state}).`,
  )
}

/** Descubre (o instala) adb y devuelve la ruta usable. */
async function resolveAdbPath(args: CliArgs): Promise<string> {
  const discovery = discoverAdb({
    platform: process.platform,
    env: process.env,
    isExecutable,
    configPath: args.adbPath ?? process.env['EVERMORE_PROFILER_ADB'],
  })

  if (discovery) {
    console.log(`adb: ${discovery.path} (via ${discovery.source})`)
    return discovery.path
  }
  if (args.installPlatformTools) {
    console.log('adb no encontrado — descargando platform-tools oficiales de Google…')
    let lastPct = -1
    const adbPath = await installPlatformTools(
      {
        platform: process.platform,
        homeDir: homedir(),
        onProgress: (received, total) => {
          if (total === null) return
          const pct = Math.floor((received / total) * 10) * 10
          if (pct > lastPct) {
            lastPct = pct
            process.stdout.write(`\r  descargando… ${pct}%`)
          }
        },
      },
      await realInstallDeps(),
    )
    console.log(`\n  instalado: ${adbPath}`)
    return adbPath
  }
  return 'adb'
}

/** Ruta al UI servido en vivo (src/ui). */
function uiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, 'ui')
}

/** Subcomando `profiler live`: preflight → primer device → server WS + dashboard. */
async function runLive(transport: AdbTransport, adbPath: string, args: CliArgs): Promise<void> {
  const report = await new Preflight(transport, args.packageName).check()
  renderReport(report)
  if (!report.ready || !report.device) {
    process.exitCode = 1
    return
  }
  const serial = report.device.serial

  const server = new LiveServer({
    transport,
    serial,
    packageName: args.packageName,
    uiRoot: uiRoot(),
    port: args.port,
    inspectHttp: args.inspectHttp,
    adbPath,
  })

  // Cleanup idempotente registrado ANTES de start(): start() setea el proxy del
  // device (--inspect) y habilita timestats; cualquier salida — Ctrl-C, kill,
  // crash — debe restaurar el device, no solo el happy path de SIGINT.
  let cleaningUp = false
  const cleanup = (code: number): void => {
    if (cleaningUp) return
    cleaningUp = true
    // escape: si stop() se cuelga (device desenchufado), salir igual
    setTimeout(() => process.exit(code), 5000).unref()
    server
      .stop()
      .catch(() => {})
      .finally(() => process.exit(code))
  }
  process.on('SIGINT', () => cleanup(0))
  process.on('SIGTERM', () => cleanup(0))
  process.on('uncaughtException', (err) => {
    console.error(err)
    cleanup(1)
  })
  process.on('unhandledRejection', (err) => {
    console.error(err)
    cleanup(1)
  })

  let started: { url: string; device: import('./core/schema').DeviceInfo }
  try {
    started = await server.start()
  } catch (err) {
    // start() pudo quedar a mitad de camino (server arriba, proxy a medio setear)
    await server.stop().catch(() => {})
    throw err
  }
  const { url, device } = started

  console.log(
    `\nDevice: ${[device.manufacturer, device.model].filter(Boolean).join(' ')} ` +
      `· Android ${device.androidRelease ?? '?'} (API ${device.apiLevel ?? '?'}) ` +
      `· ${device.gpu ?? 'GPU ?'} · ${device.soc ?? 'SoC ?'}`,
  )
  console.log(`Streaming ${args.packageName} @ 1 Hz por WebSocket.`)
  if (args.inspectHttp) {
    console.log(`  🔎 Network inspector ON — proxy del device seteado (se limpia al cortar).`)
  }
  console.log(`\n  ▶  Dashboard en vivo:  ${url}\n`)
  console.log('  (Ctrl-C para cortar.)')
}

async function main(): Promise<void> {
  console.log('Evermore Android Profiler v0.1.0')
  const args = parseArgs(process.argv.slice(2))

  const adbPath = await resolveAdbPath(args)
  const transport = new RealAdbTransport(adbPath)

  if (args.command === 'live') {
    await runLive(transport, adbPath, args)
    return
  }

  // preflight (default): cadena de checks contra el transport real
  const report = await new Preflight(transport, args.packageName).check()
  renderReport(report)
  process.exitCode = report.ready ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
