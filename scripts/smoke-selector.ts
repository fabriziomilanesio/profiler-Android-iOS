// smoke-selector.ts — smoke visual del selector de apps SIN device: levanta el
// LiveServer con un AdbTransport fake (apps y pids en memoria) y deja el dashboard
// servido en localhost para inspeccionarlo a mano o con Playwright.
// Correr con: bun scripts/smoke-selector.ts [puerto]
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
]

const CRASH_SCRIPT: Array<[string, string, string]> = [
  ['E', 'AndroidRuntime', 'FATAL EXCEPTION: main'],
  ['E', 'AndroidRuntime', 'Process: com.evermore.oda.qa, PID: 111'],
  ['E', 'AndroidRuntime', 'java.lang.IllegalStateException: simulated crash for smoke'],
  ['E', 'AndroidRuntime', '\tat com.evermore.oda.GameLoop.tick(GameLoop.java:87)'],
  ['E', 'AndroidRuntime', '\tat android.os.Handler.handleCallback(Handler.java:942)'],
  ['I', 'am_anr', '0,111,com.evermore.oda.qa,952680005,Input dispatching timed out'],
]

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
      return ok('[ro.product.model]: [SM-FAKE]\n[ro.product.manufacturer]: [smoke]\n')
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
