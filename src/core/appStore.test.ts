import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AppStore,
  autoIntervalMs,
  defaultAppStoreData,
  parseAppStore,
  rankPackages,
  recordSelection,
} from './appStore'

describe('parseAppStore', () => {
  test('JSON corrupto ⇒ defaults', () => {
    const d = parseAppStore('{not json')
    expect(d).toEqual(defaultAppStoreData())
    expect(d.filterTerm).toBe('evermore')
  })

  test('campos faltantes ⇒ se completan con defaults', () => {
    const d = parseAppStore('{"last":"com.foo.bar"}')
    expect(d.last).toBe('com.foo.bar')
    expect(d.usage).toEqual({})
    expect(d.filterTerm).toBe('evermore')
  })

  test('descarta basura: last inválido y usage con counts no numéricos', () => {
    const d = parseAppStore(
      JSON.stringify({
        last: 'rm -rf /',
        usage: { 'com.ok.app': 3, 'inyección; reboot': 9, 'com.otra.app': 'nan' },
        filterTerm: 42,
      }),
    )
    expect(d.last).toBeNull()
    expect(d.usage).toEqual({ 'com.ok.app': 3 })
    expect(d.filterTerm).toBe('evermore')
  })
})

describe('recordSelection', () => {
  test('incrementa el contador y actualiza last', () => {
    let d = defaultAppStoreData()
    d = recordSelection(d, 'com.evermore.oda.qa')
    d = recordSelection(d, 'com.evermore.oda.qa')
    d = recordSelection(d, 'com.android.chrome')
    expect(d.usage['com.evermore.oda.qa']).toBe(2)
    expect(d.usage['com.android.chrome']).toBe(1)
    expect(d.last).toBe('com.android.chrome')
  })
})

describe('rankPackages', () => {
  test('ordena por uso descendente y desempata alfabético', () => {
    const installed = ['com.zzz.app', 'com.aaa.app', 'com.evermore.oda.qa', 'com.mid.app']
    const usage = { 'com.evermore.oda.qa': 5, 'com.mid.app': 2, 'com.desinstalada.app': 9 }
    expect(rankPackages(installed, usage)).toEqual([
      'com.evermore.oda.qa',
      'com.mid.app',
      'com.aaa.app',
      'com.zzz.app',
    ])
  })
})

describe('AppStore (persistencia)', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  test('archivo inexistente ⇒ defaults; select persiste y recarga', () => {
    dir = mkdtempSync(join(tmpdir(), 'appstore-'))
    const path = join(dir, 'sub', 'apps.json') // el subdir no existe: save debe crearlo
    const legacy = join(dir, 'no-legacy.json') // aislar del apps.json real de la máquina
    const store = new AppStore(path, legacy)
    expect(store.data.last).toBeNull()

    store.select('com.evermore.oda.qa')
    store.select('com.evermore.oda.qa')

    const reloaded = new AppStore(path, legacy)
    expect(reloaded.data.last).toBe('com.evermore.oda.qa')
    expect(reloaded.data.usage['com.evermore.oda.qa']).toBe(2)
    // el JSON en disco es legible/editable a mano (filterTerm configurable)
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.filterTerm).toBe('evermore')
  })

  test('archivo corrupto ⇒ arranca con defaults sin tirar', () => {
    dir = mkdtempSync(join(tmpdir(), 'appstore-'))
    const path = join(dir, 'apps.json')
    writeFileSync(path, '{basura')
    const store = new AppStore(path)
    expect(store.data).toEqual(defaultAppStoreData())
  })

  test('migra silenciosamente del apps.json viejo a config.json', () => {
    dir = mkdtempSync(join(tmpdir(), 'appstore-'))
    const legacy = join(dir, 'apps.json')
    const cfg = join(dir, 'config.json')
    writeFileSync(
      legacy,
      JSON.stringify({ last: 'com.evermore.oda.qa', usage: { 'com.evermore.oda.qa': 4 } }),
    )
    const store = new AppStore(cfg, legacy)
    expect(store.data.last).toBe('com.evermore.oda.qa')
    expect(store.data.theme).toBe('dark') // defaults nuevos completados (dark desde el 032)
    store.select('com.evermore.oda.qa')
    // tras el primer save, config.json existe y manda sobre el legacy
    const reloaded = new AppStore(cfg, legacy)
    expect(reloaded.data.usage['com.evermore.oda.qa']).toBe(5)
  })

  test('set() aplica config validada y rechaza basura', () => {
    dir = mkdtempSync(join(tmpdir(), 'appstore-'))
    const store = new AppStore(join(dir, 'config.json'), join(dir, 'apps.json'))
    store.select('com.evermore.oda.qa')
    store.set({ theme: 'dark', intervalMs: 2000, filterTerm: 'oda' })
    expect(store.data.theme).toBe('dark')
    expect(store.data.intervalMs).toBe(2000)
    expect(store.data.filterTerm).toBe('oda')
    expect(store.data.last).toBe('com.evermore.oda.qa') // select previo se preserva

    store.set({ intervalMs: 50 } as never) // fuera de rango ⇒ se ignora
    expect(store.data.intervalMs).toBe(2000)
  })

  test('intervalo auto (ticket 023): default true, set(intervalMs) lo apaga, set(intervalAuto) lo vuelve a prender', () => {
    dir = mkdtempSync(join(tmpdir(), 'appstore-'))
    const store = new AppStore(join(dir, 'config.json'), join(dir, 'apps.json'))
    expect(store.data.intervalAuto).toBe(true)

    store.set({ intervalMs: 2000 }) // elegir un intervalo concreto = manual
    expect(store.data.intervalAuto).toBe(false)
    expect(store.data.intervalMs).toBe(2000)

    store.set({ intervalAuto: true })
    expect(store.data.intervalAuto).toBe(true)
    expect(store.data.intervalMs).toBe(2000) // el valor manual queda guardado igual
  })

  test('migración pre-023: config sin intervalAuto ⇒ auto solo si intervalMs es el default 1000', () => {
    expect(parseAppStore(JSON.stringify({ intervalMs: 1000 })).intervalAuto).toBe(true)
    expect(parseAppStore(JSON.stringify({ intervalMs: 2000 })).intervalAuto).toBe(false)
    expect(parseAppStore('{}').intervalAuto).toBe(true)
    // el flag explícito manda sobre la heurística
    expect(
      parseAppStore(JSON.stringify({ intervalMs: 2000, intervalAuto: true })).intervalAuto,
    ).toBe(true)
  })

  test('fpsTarget (ticket 025): default 30 y migración de configs viejas sin el campo', () => {
    expect(defaultAppStoreData().fpsTarget).toBe(30)
    // config pre-025 (sin fpsTarget) ⇒ migra al default sin romper el resto
    const old = parseAppStore(JSON.stringify({ last: 'com.evermore.oda.qa', intervalMs: 2000 }))
    expect(old.fpsTarget).toBe(30)
    expect(old.last).toBe('com.evermore.oda.qa')
    // valores válidos se toman (redondeados); basura ⇒ default
    expect(parseAppStore(JSON.stringify({ fpsTarget: 60 })).fpsTarget).toBe(60)
    expect(parseAppStore(JSON.stringify({ fpsTarget: 59.6 })).fpsTarget).toBe(60)
    expect(parseAppStore(JSON.stringify({ fpsTarget: 0 })).fpsTarget).toBe(30)
    expect(parseAppStore(JSON.stringify({ fpsTarget: 999 })).fpsTarget).toBe(30)
    expect(parseAppStore(JSON.stringify({ fpsTarget: '60' })).fpsTarget).toBe(30)
  })

  test('set() aplica fpsTarget validado, persiste y recarga', () => {
    dir = mkdtempSync(join(tmpdir(), 'appstore-'))
    const path = join(dir, 'config.json')
    const legacy = join(dir, 'apps.json')
    const store = new AppStore(path, legacy)
    expect(store.data.fpsTarget).toBe(30)

    store.set({ fpsTarget: 60 })
    expect(store.data.fpsTarget).toBe(60)
    store.set({ fpsTarget: -5 } as never) // fuera de rango ⇒ se ignora
    expect(store.data.fpsTarget).toBe(60)

    const reloaded = new AppStore(path, legacy)
    expect(reloaded.data.fpsTarget).toBe(60)
  })

  test('autoIntervalMs: gama baja (<4 GB) ⇒ 2 s; resto (o sin device) ⇒ 1 s', () => {
    expect(autoIntervalMs(3667)).toBe(2000) // SM-A155M
    expect(autoIntervalMs(4095)).toBe(2000)
    expect(autoIntervalMs(4096)).toBe(1000)
    expect(autoIntervalMs(7972)).toBe(1000)
    expect(autoIntervalMs(null)).toBe(1000) // modo espera: sin ficha todavía
  })
})
