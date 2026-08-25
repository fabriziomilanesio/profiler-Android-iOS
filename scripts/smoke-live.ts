// Smoke en vivo (ticket 021): corre el Sampler contra el device REAL (no fixtures)
// unos ticks e imprime los Samples. Uso: bun run scripts/smoke-live.ts [ticks]
import { RealAdbTransport } from '../src/core/adb/RealAdbTransport'
import { captureDeviceInfo } from '../src/server/liveServer'
import { Sampler, resolvePid } from '../src/core/sampler/sampler'

const PKG = process.env['PKG'] ?? 'com.sample.oda.qa'
const TICKS = Number(process.argv[2] ?? 5)

async function main(): Promise<void> {
  const t = new RealAdbTransport('adb')
  const devices = await t.devices()
  const dev = devices.find((d) => d.state === 'device')
  if (!dev) throw new Error('no hay device usable')

  const info = await captureDeviceInfo(t, dev.serial)
  console.log('DeviceInfo:', JSON.stringify(info))

  const pid = (await resolvePid(t, dev.serial, PKG)) ?? 0
  console.log(`pid(${PKG}) = ${pid}`)
  const sampler = new Sampler(t, dev.serial, PKG, pid)
  await sampler.init() // habilita timestats de SurfaceFlinger (FPS)
  await new Promise((r) => setTimeout(r, 1500)) // dejar acumular un poco de frames

  try {
    for (let i = 0; i < TICKS; i++) {
      const s = await sampler.sampleOnce()
      console.log(`tick ${s.t}:`, JSON.stringify(s))
      await new Promise((r) => setTimeout(r, 1000))
    }
  } finally {
    await sampler.dispose() // no dejar timestats del device encendido
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
