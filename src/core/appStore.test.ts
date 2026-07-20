import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AppStore,
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
    const store = new AppStore(path)
    expect(store.data.last).toBeNull()

    store.select('com.evermore.oda.qa')
    store.select('com.evermore.oda.qa')

    const reloaded = new AppStore(path)
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
})
