import { describe, expect, test } from 'bun:test'
import {
  installPlatformTools,
  platformToolsUrl,
  type Downloader,
  type Unzipper,
} from './installPlatformTools'

describe('platformToolsUrl', () => {
  test('arma la URL oficial de Google por OS', () => {
    expect(platformToolsUrl('darwin')).toBe(
      'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
    )
    expect(platformToolsUrl('win32')).toBe(
      'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
    )
    expect(platformToolsUrl('linux')).toBe(
      'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
    )
  })

  test('OS desconocido tira error claro', () => {
    expect(() => platformToolsUrl('sunos')).toThrow(/sunos/)
  })
})

describe('installPlatformTools', () => {
  function makeDeps() {
    const calls: {
      downloaded: Array<{ url: string; dest: string }>
      extracted: Array<{ zip: string; dest: string }>
      mkdirs: string[]
      removed: string[]
    } = { downloaded: [], extracted: [], mkdirs: [], removed: [] }
    const downloader: Downloader = {
      download: async (url, dest) => {
        calls.downloaded.push({ url, dest })
      },
    }
    const unzipper: Unzipper = {
      extract: async (zip, dest) => {
        calls.extracted.push({ zip, dest })
      },
    }
    return {
      calls,
      deps: {
        downloader,
        unzipper,
        mkdir: async (dir: string) => {
          calls.mkdirs.push(dir)
        },
        rm: async (file: string) => {
          calls.removed.push(file)
        },
      },
    }
  }

  test('macOS: descarga a ~/.sample-profiler, descomprime ahí y devuelve la ruta del adb', async () => {
    const { calls, deps } = makeDeps()
    const adbPath = await installPlatformTools({ platform: 'darwin', homeDir: '/Users/dev' }, deps)

    expect(adbPath).toBe('/Users/dev/.sample-profiler/platform-tools/adb')
    expect(calls.mkdirs).toEqual(['/Users/dev/.sample-profiler'])
    expect(calls.downloaded).toEqual([
      {
        url: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
        dest: '/Users/dev/.sample-profiler/platform-tools.zip',
      },
    ])
    expect(calls.extracted).toEqual([
      {
        zip: '/Users/dev/.sample-profiler/platform-tools.zip',
        dest: '/Users/dev/.sample-profiler',
      },
    ])
    // limpia el zip después de extraer
    expect(calls.removed).toEqual(['/Users/dev/.sample-profiler/platform-tools.zip'])
  })

  test('Windows: separador \\ y adb.exe', async () => {
    const { calls, deps } = makeDeps()
    const adbPath = await installPlatformTools(
      { platform: 'win32', homeDir: 'C:\\Users\\dev' },
      deps,
    )
    expect(adbPath).toBe('C:\\Users\\dev\\.sample-profiler\\platform-tools\\adb.exe')
    expect(calls.downloaded[0]?.url).toContain('platform-tools-latest-windows.zip')
    expect(calls.downloaded[0]?.dest).toBe('C:\\Users\\dev\\.sample-profiler\\platform-tools.zip')
  })

  test('si la descarga falla, no intenta descomprimir', async () => {
    const { calls, deps } = makeDeps()
    deps.downloader = {
      download: async () => {
        throw new Error('network down')
      },
    }
    await expect(
      installPlatformTools({ platform: 'linux', homeDir: '/home/dev' }, deps),
    ).rejects.toThrow('network down')
    expect(calls.extracted).toEqual([])
  })
})
