// Captura de fixtures crudos desde un device real (ticket 001).
//
// Uso:  bun scripts/capture-fixtures.ts [--package com.evermore.oda.qa] [--serial X]
//                                       [--session-seconds 30] [--adb /ruta/adb]
//
// Flujo: preflight (adb → device → app instalada) → esperar la app corriendo →
// captura ONE-SHOT → sesión 1 Hz de --session-seconds con timestats habilitado
// (el humano juega la app) → dump final de timestats + latency del layer →
// README.md con la ficha del device y los comandos que fallaron.
//
// Todo output se guarda CRUDO (sin procesar): son fixtures de los parsers.
// Los comandos que fallan quedan como .err.txt — el fallo también es dato (N/A).
//
// Exit codes: 0 = captura completa · 1 = preflight falló (sin adb / sin device /
// app no instalada) · 2 = la app no se abrió a tiempo (timeout esperando el pid).

import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RealAdbTransport } from '../src/core/adb/RealAdbTransport'
import type { AdbTransport } from '../src/core/adb/AdbTransport'
import { discoverAdb } from '../src/core/preflight/discoverAdb'
import { Preflight, type PreflightReport } from '../src/core/preflight/preflight'
import {
  GPU_PROBES,
  buildReadme,
  deviceInfoFromProps,
  findSurfaceViewLayer,
  fixtureDirName,
  oneshotPlan,
  parseGetprop,
  pickGpuPath,
  tickPlan,
  type CaptureStep,
} from './capture-plan'

const DEFAULT_PACKAGE = 'com.evermore.oda.qa'
const DEFAULT_SESSION_SECONDS = 30
const APP_WAIT_TIMEOUT_S = 60

interface CliArgs {
  packageName: string
  serial?: string
  sessionSeconds: number
  adbPath?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { packageName: DEFAULT_PACKAGE, sessionSeconds: DEFAULT_SESSION_SECONDS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package' && argv[i + 1]) args.packageName = argv[++i]!
    else if (arg === '--serial' && argv[i + 1]) args.serial = argv[++i]!
    else if (arg === '--adb' && argv[i + 1]) args.adbPath = argv[++i]!
    else if (arg === '--session-seconds' && argv[i + 1]) {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 1) {
        console.error(`--session-seconds inválido: '${argv[i]}' (esperaba un entero ≥ 1)`)
        process.exit(1)
      }
      args.sessionSeconds = Math.floor(n)
    }
  }
  return args
}

function isExecutable(path: string): boolean {
  try {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface StepResult {
  file: string
  ok: boolean
  /** resumen del fallo para el README, solo si !ok */
  failure?: string
}

/**
 * Corre un paso del plan y guarda el output crudo. exit != 0 ⇒ `<name>.err.txt`
 * con exit code + stderr + stdout (el fallo es dato). Devuelve el resultado.
 */
async function runStep(
  transport: AdbTransport,
  serial: string,
  dir: string,
  step: CaptureStep,
  label: string,
): Promise<StepResult> {
  let result
  try {
    result = await transport.shell(serial, step.cmd)
  } catch (err) {
    result = { stdout: '', stderr: String(err), exitCode: -1 }
  }
  if (result.exitCode === 0) {
    writeFileSync(join(dir, step.file), result.stdout)
    return { file: `${label}/${step.file}`, ok: true }
  }
  const errFile = step.file.replace(/\.txt$/, '') + '.err.txt'
  writeFileSync(
    join(dir, errFile),
    `# comando: ${step.cmd}\n# exit code: ${result.exitCode}\n${result.stderr}${result.stdout}`,
  )
  const firstErrLine = result.stderr.split('\n').find((l) => l.trim()) ?? '(sin stderr)'
  return {
    file: `${label}/${step.file}`,
    ok: false,
    failure: `\`${label}/${errFile}\` — \`${step.cmd}\` → exit ${result.exitCode}: ${firstErrLine.trim()}`,
  }
}

/** Espera a que la app esté corriendo (pidof), pidiéndole al humano que la abra. */
async function waitForAppPid(
  transport: AdbTransport,
  serial: string,
  pkg: string,
): Promise<string | null> {
  for (let elapsed = 0; elapsed <= APP_WAIT_TIMEOUT_S; elapsed += 2) {
    const result = await transport.shell(serial, `pidof ${pkg}`)
    const pid = result.stdout.trim().split(/\s+/)[0]
    if (result.exitCode === 0 && pid) return pid
    if (elapsed === 0) {
      console.log(
        `\nLa app ${pkg} no está corriendo. ABRILA EN EL DEVICE ahora ` +
          `(espero hasta ${APP_WAIT_TIMEOUT_S} s)…`,
      )
    }
    await sleep(2000)
  }
  return null
}

async function main(): Promise<void> {
  console.log('Evermore Android Profiler — captura de fixtures (ticket 001)')
  const args = parseArgs(process.argv.slice(2))

  // ── 1. Preflight (misma cadena que el CLI: adb → device → app instalada) ──
  const discovery = discoverAdb({
    platform: process.platform,
    env: process.env,
    isExecutable,
    configPath: args.adbPath ?? process.env['EVERMORE_PROFILER_ADB'],
  })
  if (!discovery) {
    console.error(
      '\n✗ No se encontró adb (busqué --adb/EVERMORE_PROFILER_ADB, PATH, SDK típico y managed).' +
        '\n  → Instalá platform-tools: `bun run dev -- --install-platform-tools`, o pasá la ruta con --adb.',
    )
    process.exit(1)
  }
  console.log(`adb: ${discovery.path} (via ${discovery.source})`)

  const transport = new RealAdbTransport(discovery.path)
  const report = await new Preflight(transport, args.packageName).check()
  renderReport(report)
  if (!report.ready) {
    console.error(
      `\n✗ Preflight incompleto (estado: ${report.state}). ` +
        'Resolvé lo de arriba y volvé a correr el script.',
    )
    process.exit(1)
  }

  // ── 2. Device objetivo (--serial pisa al elegido por preflight) ──
  let serial = report.device!.serial
  if (args.serial && args.serial !== serial) {
    const devices = await transport.devices()
    const target = devices.find((d) => d.serial === args.serial)
    if (!target || target.state !== 'device') {
      console.error(
        `\n✗ El device --serial ${args.serial} no está conectado/autorizado ` +
          `(vi: ${devices.map((d) => `${d.serial} [${d.state}]`).join(', ') || 'ninguno'}).`,
      )
      process.exit(1)
    }
    const pm = await transport.shell(args.serial, `pm list packages ${args.packageName}`)
    const installed = pm.stdout
      .split('\n')
      .some((line) => line.trim() === `package:${args.packageName}`)
    if (!installed) {
      console.error(`\n✗ La app ${args.packageName} no está instalada en ${args.serial}.`)
      process.exit(1)
    }
    serial = args.serial
  }
  console.log(`\nDevice: ${serial} · package: ${args.packageName}`)

  // ── 3. La app tiene que estar corriendo (meminfo/pid/FPS lo requieren) ──
  const pid = await waitForAppPid(transport, serial, args.packageName)
  if (!pid) {
    console.error(
      `\n✗ Timeout: la app ${args.packageName} no apareció corriendo en ${APP_WAIT_TIMEOUT_S} s.` +
        '\n  → Abrila en el device y volvé a correr el script.',
    )
    process.exit(2)
  }
  console.log(`App corriendo con pid ${pid}.`)

  // ── 4. Ficha del device → nombre del dir de fixtures ──
  const getprop = await transport.shell(serial, 'getprop')
  const props = parseGetprop(getprop.stdout)
  const model = props['ro.product.model'] ?? 'unknown-device'
  const api = props['ro.build.version.sdk'] ?? ''
  const fixtureDir = join(import.meta.dir, '..', 'fixtures', fixtureDirName(model, api))
  const oneshotDir = join(fixtureDir, 'oneshot')
  mkdirSync(oneshotDir, { recursive: true })
  console.log(`\nFixtures → ${fixtureDir}`)

  // ── 5. Captura ONE-SHOT ──
  console.log('\nCaptura one-shot:')
  const failures: string[] = []
  const oneshotResults = new Map<string, boolean>()
  for (const step of oneshotPlan(args.packageName, pid)) {
    const result = await runStep(transport, serial, oneshotDir, step, 'oneshot')
    oneshotResults.set(step.file, result.ok)
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.file}`)
    if (result.failure) failures.push(result.failure)
  }

  // Fuente GPU%: primera ruta del probing que respondió (puede ser ninguna — N/A)
  const gpuPath = pickGpuPath(
    GPU_PROBES.map((p) => ({ path: p.path, ok: oneshotResults.get(`${p.file}.txt`) ?? false })),
  )
  console.log(`\nGPU%: ${gpuPath ?? 'ninguna ruta sysfs legible — N/A en este device'}`)

  // ── 6. Sesión 1 Hz — el humano juega la app ──
  const enable = await transport.shell(serial, 'dumpsys SurfaceFlinger --timestats -clear -enable')
  if (enable.exitCode !== 0) {
    failures.push(
      `\`SurfaceFlinger --timestats -clear -enable\` → exit ${enable.exitCode}: ` +
        `${enable.stderr.trim() || '(sin stderr)'} (¿API < 29? usar --latency como primaria)`,
    )
    console.log(
      '⚠ --timestats no respondió (queda anotado en el README; --latency igual se captura al final).',
    )
  }

  // Ctrl-C a mitad de sesión no debe dejar timestats del device encendido.
  process.once('SIGINT', () => {
    void transport
      .shell(serial, 'dumpsys SurfaceFlinger --timestats -disable')
      .catch(() => {})
      .finally(() => process.exit(130))
  })

  console.log(`\n📱 JUGÁ LA APP AHORA — sesión de ${args.sessionSeconds} s a 1 Hz arrancando en:`)
  for (let s = 5; s > 0; s--) {
    console.log(`  ${s}…`)
    await sleep(1000)
  }

  const tickFailures = new Map<string, number>()
  let ticksDone = 0
  for (let i = 0; i < args.sessionSeconds; i++) {
    const tickStart = Date.now()
    const tickDir = join(fixtureDir, 'session', `tick-${String(i).padStart(3, '0')}`)
    mkdirSync(tickDir, { recursive: true })
    for (const step of tickPlan(args.packageName, pid, gpuPath)) {
      const result = await runStep(transport, serial, tickDir, step, `session/tick-*`)
      if (!result.ok) tickFailures.set(step.file, (tickFailures.get(step.file) ?? 0) + 1)
    }
    ticksDone++
    console.log(
      `  tick ${String(i + 1).padStart(3, '0')}/${args.sessionSeconds} (quedan ${args.sessionSeconds - i - 1} s — seguí jugando)`,
    )
    const elapsed = Date.now() - tickStart
    if (elapsed < 1000) await sleep(1000 - elapsed)
  }
  for (const [file, count] of tickFailures) {
    failures.push(
      `\`session/tick-*/${file}\` — falló en ${count}/${ticksDone} ticks (ver los .err.txt)`,
    )
  }

  // ── 7. Cierre de sesión: timestats -dump + latency del layer del SurfaceView ──
  console.log('\nCierre de sesión:')
  const finalDir = join(fixtureDir, 'session', 'final')
  mkdirSync(finalDir, { recursive: true })

  const finalSteps: CaptureStep[] = [
    { file: 'timestats-dump.txt', cmd: 'dumpsys SurfaceFlinger --timestats -dump' },
    { file: 'surfaceflinger-list.txt', cmd: 'dumpsys SurfaceFlinger --list' },
  ]
  let listOutput = ''
  for (const step of finalSteps) {
    const result = await runStep(transport, serial, finalDir, step, 'session/final')
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.file}`)
    if (result.failure) failures.push(result.failure)
    if (step.file === 'surfaceflinger-list.txt' && result.ok) {
      listOutput = readFileSync(join(finalDir, step.file), 'utf-8')
    }
  }
  await transport.shell(serial, 'dumpsys SurfaceFlinger --timestats -disable')

  const layer = findSurfaceViewLayer(listOutput, args.packageName)
  if (layer) {
    writeFileSync(join(finalDir, 'layer-name.txt'), layer + '\n')
    const latency = await runStep(
      transport,
      serial,
      finalDir,
      { file: 'latency.txt', cmd: `dumpsys SurfaceFlinger --latency '${layer}'` },
      'session/final',
    )
    console.log(`  ${latency.ok ? '✓' : '✗'} ${latency.file} (layer: ${layer})`)
    if (latency.failure) failures.push(latency.failure)
  } else {
    failures.push(
      `layer del SurfaceView de ${args.packageName} no encontrado en \`SurfaceFlinger --list\` ` +
        '(¿la app quedó en background al cerrar la sesión?) — sin fixture de --latency',
    )
    console.log('  ✗ layer del SurfaceView no encontrado — sin --latency')
  }

  // ── 8. README con ficha del device + N/A ──
  const glesRaw = oneshotResults.get('surfaceflinger-gles.txt')
    ? readFileSync(join(oneshotDir, 'surfaceflinger-gles.txt'), 'utf-8')
    : ''
  const info = deviceInfoFromProps(props, serial, glesRaw)
  const readme = buildReadme(info, {
    pkg: args.packageName,
    date: new Date().toISOString(),
    sessionSeconds: args.sessionSeconds,
    ticks: ticksDone,
    gpuPath,
    layer,
    failures,
  })
  writeFileSync(join(fixtureDir, 'README.md'), readme)

  console.log(`\n✓ Captura completa: ${fixtureDir}`)
  console.log(
    `  ${failures.length === 0 ? 'Sin fallos.' : `${failures.length} comando(s) fallaron — quedaron como .err.txt y anotados en el README (son los N/A del device).`}`,
  )
  console.log('  Revisá el README.md y commiteá el dir de fixtures.')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
