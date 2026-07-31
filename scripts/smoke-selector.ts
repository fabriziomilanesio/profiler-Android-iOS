// smoke-selector.ts — smoke visual del dashboard SIN device: levanta el LiveServer
// con un AdbTransport fake (apps, pids, logs y MÉTRICAS sintéticas en memoria) y
// deja el dashboard servido en localhost para inspeccionarlo a mano o con Playwright.
// Correr con: bun scripts/smoke-selector.ts [puerto]
//
// Métricas guionadas (ticket 032, mismo espíritu que el sim del prototipo 031):
// ciclo de 150 s con FPS ~32 sobre target 30 (verde/amarillo), caída a ~11 FPS en
// t≈40–58 (semáforo rojo + bandas rojas + PERF POOR) y GPU/CPU/temp acompañando.
// El crash sintético de logcat (FATAL + am_anr a los ~8 s y cada 45 s) pone la
// marca CRASH en la timeline y el chip rojo del veredicto.
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AdbTransport, ShellResult } from '../src/core/adb/AdbTransport'
import type { AppStoreData } from '../src/core/appStore'
import { defaultAppStoreData } from '../src/core/appStore'
import { LiveServer } from '../src/server/liveServer'

const ok = (stdout: string): ShellResult => ({ stdout, stderr: '', exitCode: 0 })

// ---- logs sintéticos (ticket 028): el fake emite logcat threadtime+year real ----
const pad = (n: number, w: number) => String(n).padStart(w, '0')
function logLine(pid: number, tid: number, level: string, tag: string, msg: string): string {
  const d = new Date()
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`
  const time = `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`
  return `${date} ${time} ${pid} ${tid} ${level} ${tag}    : ${msg}`
}

const APP_LOG_SCRIPT: Array<[string, string, string]> = [
  ['I', 'Unity', 'Loading scene "MainMenu"…'],
  ['D', 'Unity', 'AudioManager: pool warm (32 voices)'],
  ['V', 'chatty', 'uid=10241 com.evermore.oda.qa identical 3 lines'],
  ['I', 'Unity', 'PlayerProfile loaded in 42 ms'],
  ['W', 'Unity', 'Texture atlas "ui_hd" not preloaded, loading on demand'],
  ['I', 'ActivityTaskManager', 'Displayed com.evermore.oda.qa/.MainActivity: +1s240ms'],
  ['E', 'Unity', 'NullReferenceException: Object reference not set to an instance of an object'],
  ['E', 'Unity', '  at Evermore.UI.HudController.Update () [0x0001a] in <9f3b>:0'],
  ['I', 'Unity', 'Level 2 start (arena=neon_park)'],
  ['D', 'OpenGLRenderer', 'endAllActiveAnimators on 0x7b3c'],
  ['W', 'AudioTrack', 'releaseBuffer() track 0x71 disabled due to previous underrun'],
  ['I', 'Unity', 'FPS avg last 60 frames: 29.4'],
  // línea de GC del ART: el dashboard la marca como punto ámbar sobre el trend de PSS
  [
    'I',
    'evermore.oda.qa',
    'Background concurrent copying GC freed 104329(4013KB) AllocSpace objects',
  ],
]

const CRASH_SCRIPT: Array<[string, string, string]> = [
  ['E', 'AndroidRuntime', 'FATAL EXCEPTION: main'],
  ['E', 'AndroidRuntime', 'Process: com.evermore.oda.qa, PID: 111'],
  ['E', 'AndroidRuntime', 'java.lang.IllegalStateException: simulated crash for smoke'],
  ['E', 'AndroidRuntime', '\tat com.evermore.oda.GameLoop.tick(GameLoop.java:87)'],
  ['E', 'AndroidRuntime', '\tat android.os.Handler.handleCallback(Handler.java:942)'],
  ['I', 'am_anr', '0,111,com.evermore.oda.qa,952680005,Input dispatching timed out'],
]

// ---- métricas sintéticas (contadores acumulados que los parsers deltan) ----
const SIM_CYCLE_S = 150
const simStart = Date.now()
let cpuLast = simStart
let cpuTotalTicks = 0
let cpuIdleTicks = 0
const appTicks = new Map<number, number>()
let rxBytes = 5_000_000
let txBytes = 2_000_000
let netLast = simStart

const elapsedS = () => (Date.now() - simStart) / 1000
const phaseS = () => elapsedS() % SIM_CYCLE_S
const inDrop = () => phaseS() >= 40 && phaseS() < 58

function fpsNow(): number {
  const e = elapsedS()
  return inDrop() ? 11 + 2 * Math.sin(e / 2) : 31.5 + 2.5 * Math.sin(e / 9)
}

function combinedCat(pids: number[]): string {
  const now = Date.now()
  const dt = Math.min(5, Math.max(0.05, (now - cpuLast) / 1000))
  cpuLast = now
  const e = elapsedS()
  const appShare = inDrop() ? 0.3 : 0.12 + 0.05 * Math.sin(e / 9)
  const deviceBusy = Math.min(0.95, appShare + 0.18 + 0.04 * Math.sin(e / 13))
  const dTotal = dt * 800 // 8 cores × USER_HZ 100
  cpuTotalTicks += dTotal
  cpuIdleTicks += dTotal * (1 - deviceBusy)
  const idle = Math.round(cpuIdleTicks)
  const busy = Math.round(cpuTotalTicks - cpuIdleTicks)
  const usedMb = 4600 + 350 * Math.sin(e / 40)
  const availKb = Math.round((8192 - usedMb) * 1024)
  const parts = [
    `cpu  ${busy} 0 0 ${idle} 0 0 0 0`,
    `MemTotal:        8388608 kB`,
    `MemAvailable:    ${availKb} kB`,
  ]
  for (const pid of pids) {
    const prev = appTicks.get(pid) ?? 0
    const next = prev + dTotal * appShare
    appTicks.set(pid, next)
    const u = Math.round(next / 2)
    const s = Math.round(next) - u
    parts.push(`${pid} (evermore.oda.qa) S 0 0 0 0 0 0 0 0 0 0 ${u} ${s} 0 0`)
    const rssKb = Math.round((320 + 30 * Math.sin(e / 30)) * 1024)
    parts.push(`VmRSS:\t   ${rssKb} kB`)
  }
  return parts.join('\n')
}

function timestatsDump(pkg: string): string {
  const fps = fpsNow()
  const frameMs = Math.max(1, Math.round(1000 / fps))
  const total = Math.round(fps)
  const jank = Math.max(1, Math.round(total * (inDrop() ? 0.28 : 0.05)))
  const buckets = `${frameMs}ms=${total - jank} ${frameMs * 2}ms=${jank}`
  return [
    `layerName = SurfaceView[${pkg}/com.unity3d.player.UnityPlayerActivity](BLAST)#0`,
    `totalFrames = ${total}`,
    `averageFPS = ${fps.toFixed(2)}`,
    `present2present histogram is as below:`,
    `${buckets}`,
  ].join('\n')
}

function meminfoDump(): string {
  const e = elapsedS()
  const javaKb = Math.round((92 + 14 * Math.sin(e / 35)) * 1024)
  const nativeKb = Math.round((74 + 8 * Math.sin(e / 28)) * 1024)
  const graphicsKb = Math.round((58 + 6 * Math.sin(e / 22)) * 1024)
  const codeKb = Math.round(48 * 1024)
  const stackKb = Math.round(3 * 1024)
  const otherKb = Math.round(24 * 1024)
  const totalKb = javaKb + nativeKb + graphicsKb + codeKb + stackKb + otherKb
  return [
    'App Summary',
    '                       Pss(KB)                        Rss(KB)',
    `           Java Heap:    ${javaKb}                          ${javaKb + 9000}`,
    `         Native Heap:    ${nativeKb}                        ${nativeKb + 4000}`,
    `                Code:    ${codeKb}                          ${codeKb + 20000}`,
    `               Stack:    ${stackKb}                           ${stackKb + 100}`,
    `            Graphics:    ${graphicsKb}                       ${graphicsKb}`,
    `       Private Other:    ${Math.round(otherKb * 0.7)}`,
    `              System:    ${Math.round(otherKb * 0.3)}`,
    '',
    `           TOTAL PSS:    ${totalKb}`,
  ].join('\n')
}

function netDevDump(): string {
  const now = Date.now()
  const dt = Math.min(5, Math.max(0.05, (now - netLast) / 1000))
  netLast = now
  const e = elapsedS()
  rxBytes += dt * 1024 * Math.max(2, 34 + 28 * Math.sin(e / 7))
  txBytes += dt * 1024 * Math.max(1, 9 + 7 * Math.sin(e / 5))
  return [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    `wlan0: ${Math.round(rxBytes)} 9000 0 0 0 0 0 0 ${Math.round(txBytes)} 5000 0 0 0 0 0 0`,
  ].join('\n')
}

const GETPROP = [
  '[ro.product.model]: [SM-FAKE]',
  '[ro.product.manufacturer]: [smoke]',
  '[ro.build.version.release]: [15]',
  '[ro.build.version.sdk]: [36]',
  '[ro.board.platform]: [mt6789]',
].join('\n')

const INSTALLED = [
  'com.evermore.oda.qa',
  'com.evermore.arcade',
  'com.evermore.oda.dev',
  'com.android.chrome',
  'com.whatsapp',
  'org.fdroid.fdroid',
  'com.discord',
  'com.spotify.music',
]
const running = new Map<string, number>([['com.evermore.oda.qa', 111]])

const transport: AdbTransport = {
  isAvailable: async () => true,
  version: async () => '1.0.41',
  devices: async () => [
    { serial: 'FAKE-SERIAL', state: 'device', description: 'model:SM_FAKE product:smoke' },
    { serial: 'FAKE-PIXEL', state: 'device', description: 'model:Pixel_7 product:panther' },
    { serial: 'FAKE-LOCKED', state: 'unauthorized', description: '' },
  ],
  trackDevices: () => () => {},
  // logcat fake: el app stream tira una línea cada 400 ms (con errores y stack
  // multi-línea en la rotación); el crash stream emite un FATAL + am_anr a los
  // ~8 s y cada 45 s (pid 111 = pid conocido de la app ⇒ se adjudica).
  streamShell: (_serial, command, onLine) => {
    if (command.startsWith('logcat -b main,system')) {
      const pid = Number(/--pid=(\d+)/.exec(command)?.[1] ?? 111)
      let i = 0
      const timer = setInterval(() => {
        const [level, tag, msg] = APP_LOG_SCRIPT[i % APP_LOG_SCRIPT.length]!
        onLine(logLine(pid, pid + (i % 3), level, tag, msg))
        i++
      }, 400)
      return () => clearInterval(timer)
    }
    if (command.startsWith('logcat -b crash,events')) {
      const emitCrash = () => {
        for (const [level, tag, msg] of CRASH_SCRIPT) onLine(logLine(111, 111, level, tag, msg))
      }
      const first = setTimeout(emitCrash, 8000)
      const repeat = setInterval(emitCrash, 45000)
      return () => {
        clearTimeout(first)
        clearInterval(repeat)
      }
    }
    return () => {}
  },
  shell: async (_serial, command) => {
    if (command.startsWith('pidof ')) {
      const pid = running.get(command.slice('pidof '.length).trim())
      return pid ? ok(String(pid)) : { stdout: '', stderr: '', exitCode: 1 }
    }
    if (command.startsWith('pm list packages')) {
      return ok(INSTALLED.map((p) => `package:${p}`).join('\n'))
    }
    if (command.startsWith('monkey -p ')) {
      running.set(command.split(' ')[2]!, 4242)
      return ok('Events injected: 1')
    }
    if (command.startsWith('getprop')) {
      return ok(GETPROP)
    }
    // ---- métricas sintéticas (los parsers reales las consumen tal cual) ----
    if (command.startsWith('cat /proc/stat /proc/meminfo')) {
      const pids = [...command.matchAll(/\/proc\/(\d+)\/stat\b/g)].map((m) => Number(m[1]))
      return ok(combinedCat(pids))
    }
    if (command.startsWith('ps -A')) {
      return ok(
        ['PID NAME', ...[...running.entries()].map(([pkg, pid]) => `${pid} ${pkg}`)].join('\n'),
      )
    }
    if (command === 'cat /sys/kernel/gpu/gpu_busy') {
      const e = elapsedS()
      const gpu = inDrop() ? 88 + 6 * Math.sin(e / 3) : 55 + 15 * Math.sin(e / 11)
      return ok(`${Math.round(Math.max(0, Math.min(100, gpu)))} %`)
    }
    if (command.includes('SurfaceFlinger --timestats')) {
      const pkg = [...running.keys()][0] ?? 'com.evermore.oda.qa'
      return command.includes('-dump') ? ok(timestatsDump(pkg)) : ok('')
    }
    if (command.includes('SurfaceFlinger --latency')) {
      return ok('11111111') // 90 Hz
    }
    if (command.includes('SurfaceFlinger') && command.includes('GLES')) {
      return ok('GLES: ARM, Mali-G57 MC2, OpenGL ES 3.2 v1.r44p1')
    }
    if (command === 'nproc') {
      return ok('8')
    }
    if (command === 'cat /proc/meminfo') {
      return ok('MemTotal:        8388608 kB\nMemAvailable:    3600000 kB')
    }
    if (command.startsWith('dumpsys meminfo')) {
      return ok(meminfoDump())
    }
    if (command === 'dumpsys thermalservice') {
      const t = inDrop() ? 41.4 : 36.2 + 2.4 * Math.sin(elapsedS() / 60)
      return ok(
        `Current temperatures from HAL:\n\tTemperature{mValue=${t.toFixed(1)}, mType=0, mName=AP, mStatus=0}\nCurrent cooling devices from HAL:`,
      )
    }
    if (command === 'dumpsys battery') {
      const level = Math.max(5, Math.round(84 - elapsedS() / 90))
      return ok(
        [
          'Current Battery Service state:',
          '  AC powered: false',
          '  USB powered: false',
          '  Wireless powered: false',
          `  level: ${level}`,
          '  temperature: 312',
          '  current now: -412',
        ].join('\n'),
      )
    }
    if (command === 'cat /proc/net/dev') {
      return ok(netDevDump())
    }
    return ok('')
  },
}

const smokeDir = join(tmpdir(), 'evermore-smoke')
const store = {
  data: {
    ...defaultAppStoreData(),
    usage: { 'com.evermore.oda.qa': 12, 'com.evermore.arcade': 5, 'com.android.chrome': 2 },
    reportsDir: join(smokeDir, 'reports'),
  } satisfies AppStoreData,
  select(pkg: string) {
    console.log(`[store] select ${pkg}`)
  },
  set(patch: Partial<AppStoreData>) {
    Object.assign(store.data, patch)
    console.log(`[store] set ${JSON.stringify(patch)}`)
  },
}

const server = new LiveServer({
  transport,
  serial: 'FAKE-SERIAL',
  packageName: 'com.evermore.oda.qa',
  uiRoot: join(import.meta.dir, '../src/ui'),
  port: Number(process.argv[2] ?? 4599),
  appStore: store,
  intervalMs: 1000,
  sessionsDir: join(smokeDir, 'sessions'),
})

const { url } = await server.start()
console.log(`smoke selector: dashboard fake en ${url} (Ctrl-C para cortar)`)
