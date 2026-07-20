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
