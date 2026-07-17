import { describe, expect, test } from 'bun:test'
import { discoverAdb, type DiscoverAdbOptions } from './discoverAdb'

/** fs-checker fake: "existe y es ejecutable" ⇔ está en el set. */
function checkerOf(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return (p) => set.has(p)
}

function darwinOpts(overrides: Partial<DiscoverAdbOptions> = {}): DiscoverAdbOptions {
  return {
    platform: 'darwin',
    env: { HOME: '/Users/dev', PATH: '/usr/local/bin:/usr/bin' },
    isExecutable: checkerOf(),
    ...overrides,
  }
}

describe('discoverAdb', () => {
  test('devuelve null si no hay adb en ningún lado', () => {
    expect(discoverAdb(darwinOpts())).toBeNull()
  })

  test('(a) el path explícito de config gana sobre todo', () => {
    const result = discoverAdb(
      darwinOpts({
        configPath: '/custom/adb',
        isExecutable: checkerOf('/custom/adb', '/usr/local/bin/adb'),
      }),
    )
    expect(result).toEqual({ path: '/custom/adb', source: 'config' })
  })

  test('config path que no existe se ignora y sigue la cadena', () => {
    const result = discoverAdb(
      darwinOpts({ configPath: '/nope/adb', isExecutable: checkerOf('/usr/local/bin/adb') }),
    )
    expect(result).toEqual({ path: '/usr/local/bin/adb', source: 'path' })
  })

  test('(b) encuentra adb en PATH respetando el orden de los dirs', () => {
    const result = discoverAdb(
      darwinOpts({
        env: { HOME: '/Users/dev', PATH: '/first:/second' },
        isExecutable: checkerOf('/first/adb', '/second/adb'),
      }),
    )
    expect(result).toEqual({ path: '/first/adb', source: 'path' })
  })

  test('(c) macOS: ruta típica del SDK', () => {
    const result = discoverAdb(
      darwinOpts({
        isExecutable: checkerOf('/Users/dev/Library/Android/sdk/platform-tools/adb'),
      }),
    )
    expect(result).toEqual({
      path: '/Users/dev/Library/Android/sdk/platform-tools/adb',
      source: 'sdk',
    })
  })

  test('(c) Windows: PATH con ";", adb.exe y %LOCALAPPDATA%', () => {
    const opts: DiscoverAdbOptions = {
      platform: 'win32',
      env: {
        Path: 'C:\\tools;C:\\bin',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\dev',
      },
      isExecutable: checkerOf(
        'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
      ),
    }
    expect(discoverAdb(opts)).toEqual({
      path: 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
      source: 'sdk',
    })

    const viaPath = discoverAdb({ ...opts, isExecutable: checkerOf('C:\\bin\\adb.exe') })
    expect(viaPath).toEqual({ path: 'C:\\bin\\adb.exe', source: 'path' })
  })

  test('(c) Linux: ruta típica del SDK', () => {
    const result = discoverAdb({
      platform: 'linux',
      env: { HOME: '/home/dev', PATH: '/usr/bin' },
      isExecutable: checkerOf('/home/dev/Android/Sdk/platform-tools/adb'),
    })
    expect(result).toEqual({ path: '/home/dev/Android/Sdk/platform-tools/adb', source: 'sdk' })
  })

  test('(d) fallback: platform-tools instalados por la tool en ~/.evermore-profiler', () => {
    const result = discoverAdb(
      darwinOpts({
        isExecutable: checkerOf('/Users/dev/.evermore-profiler/platform-tools/adb'),
      }),
    )
    expect(result).toEqual({
      path: '/Users/dev/.evermore-profiler/platform-tools/adb',
      source: 'managed',
    })
  })

  test('(d) en Windows el managed usa USERPROFILE y adb.exe', () => {
    const result = discoverAdb({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\dev' },
      isExecutable: checkerOf('C:\\Users\\dev\\.evermore-profiler\\platform-tools\\adb.exe'),
    })
    expect(result).toEqual({
      path: 'C:\\Users\\dev\\.evermore-profiler\\platform-tools\\adb.exe',
      source: 'managed',
    })
  })

  test('precedencia: PATH gana sobre SDK y SDK gana sobre managed', () => {
    const sdk = '/Users/dev/Library/Android/sdk/platform-tools/adb'
    const managed = '/Users/dev/.evermore-profiler/platform-tools/adb'
    expect(
      discoverAdb(darwinOpts({ isExecutable: checkerOf('/usr/bin/adb', sdk, managed) })),
    ).toEqual({ path: '/usr/bin/adb', source: 'path' })
    expect(discoverAdb(darwinOpts({ isExecutable: checkerOf(sdk, managed) }))).toEqual({
      path: sdk,
      source: 'sdk',
    })
  })

  test('PATH vacío o ausente no explota', () => {
    expect(discoverAdb(darwinOpts({ env: { HOME: '/Users/dev' } }))).toBeNull()
  })
})
