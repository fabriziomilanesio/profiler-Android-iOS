import { describe, expect, test } from 'bun:test'
import {
  GPU_PROBES,
  buildReadme,
  deviceInfoFromProps,
  findSurfaceViewLayer,
  fixtureDirName,
  oneshotPlan,
  parseGetprop,
  pickGpuPath,
  sanitizeDirName,
  tickPlan,
} from './capture-plan'

describe('sanitizeDirName', () => {
  test('slugifica modelo con espacios y mayúsculas', () => {
    expect(sanitizeDirName('Pixel 7 Pro')).toBe('pixel-7-pro')
  })

  test('colapsa caracteres raros y bordes', () => {
    expect(sanitizeDirName('  SM-A525F/DS (QA) ')).toBe('sm-a525f-ds-qa')
  })

  test('vacío o no sanitizable → unknown-device', () => {
    expect(sanitizeDirName('')).toBe('unknown-device')
    expect(sanitizeDirName('™®')).toBe('unknown-device')
  })
})

describe('fixtureDirName', () => {
  test('modelo-sanitizado + api', () => {
    expect(fixtureDirName('Pixel 7 Pro', '34')).toBe('pixel-7-pro-api34')
  })

  test('api vacío → unknown', () => {
    expect(fixtureDirName('Pixel 7', '')).toBe('pixel-7-apiunknown')
  })
})

describe('parseGetprop', () => {
  test('parsea líneas [key]: [value]', () => {
    const raw = [
      '[ro.product.model]: [Pixel 7]',
      '[ro.build.version.sdk]: [33]',
      '[ro.boot.empty]: []',
      'línea basura sin formato',
    ].join('\n')
    const props = parseGetprop(raw)
    expect(props['ro.product.model']).toBe('Pixel 7')
    expect(props['ro.build.version.sdk']).toBe('33')
    expect(props['ro.boot.empty']).toBe('')
    expect(Object.keys(props)).toHaveLength(3)
  })
})

describe('pickGpuPath', () => {
  test('gana la primera ruta del orden de probing que respondió', () => {
    const results = GPU_PROBES.map((p) => ({ path: p.path, ok: true }))
    expect(pickGpuPath(results)).toBe('/sys/class/kgsl/kgsl-3d0/gpubusy')
  })

  test('respeta el orden aunque los resultados vengan desordenados', () => {
    const results = [
      { path: '/sys/kernel/gpu/gpu_busy', ok: true },
      { path: '/sys/class/kgsl/kgsl-3d0/gpubusy', ok: false },
    ]
    expect(pickGpuPath(results)).toBe('/sys/kernel/gpu/gpu_busy')
  })

  test('ninguna legible → null (GPU% N/A)', () => {
    expect(pickGpuPath(GPU_PROBES.map((p) => ({ path: p.path, ok: false })))).toBeNull()
    expect(pickGpuPath([])).toBeNull()
  })
})

describe('oneshotPlan', () => {
  const plan = oneshotPlan('com.evermore.oda.qa', '12345')

  test('interpola pkg y pid en los comandos', () => {
    expect(plan.find((s) => s.file === 'dumpsys-meminfo.txt')?.cmd).toBe(
      'dumpsys meminfo com.evermore.oda.qa',
    )
    expect(plan.find((s) => s.file === 'proc-pid-stat.txt')?.cmd).toBe('cat /proc/12345/stat')
    expect(plan.find((s) => s.file === 'gfxinfo-framestats.txt')?.cmd).toBe(
      'dumpsys gfxinfo com.evermore.oda.qa framestats',
    )
  })

  test('cubre todas las fuentes del ticket', () => {
    const files = plan.map((s) => s.file)
    for (const expected of [
      'getprop.txt',
      'proc-meminfo.txt',
      'dumpsys-meminfo.txt',
      'dumpsys-cpuinfo.txt',
      'top.txt',
      'proc-pid-stat.txt',
      'proc-stat.txt',
      'dumpsys-thermalservice.txt',
      'thermal-zone-types.txt',
      'thermal-zone-temps.txt',
      'gpu-kgsl-ls.txt',
      'gpu-kgsl-gpubusy.txt',
      'gpu-samsung-gpu-busy.txt',
      'gpu-mali-utilization.txt',
      'dumpsys-netstats.txt',
      'surfaceflinger-list.txt',
      'gfxinfo-framestats.txt',
      'surfaceflinger-gles.txt',
    ]) {
      expect(files).toContain(expected)
    }
  })

  test('nombres de archivo únicos (nada se pisa)', () => {
    const files = plan.map((s) => s.file)
    expect(new Set(files).size).toBe(files.length)
  })
})

describe('tickPlan', () => {
  test('proc/stat y proc/<pid>/stat van juntos en una sola llamada', () => {
    const plan = tickPlan('com.evermore.oda.qa', '999', null)
    expect(plan.find((s) => s.file === 'proc-stat.txt')?.cmd).toBe('cat /proc/stat /proc/999/stat')
  })

  test('incluye gpubusy solo si hay ruta GPU elegida', () => {
    const conGpu = tickPlan('pkg', '1', '/sys/class/kgsl/kgsl-3d0/gpubusy')
    expect(conGpu.find((s) => s.file === 'gpubusy.txt')?.cmd).toBe(
      'cat /sys/class/kgsl/kgsl-3d0/gpubusy',
    )
    const sinGpu = tickPlan('pkg', '1', null)
    expect(sinGpu.some((s) => s.file === 'gpubusy.txt')).toBe(false)
  })

  test('cada tick guarda meminfo, thermal y netstats', () => {
    const files = tickPlan('pkg', '1', null).map((s) => s.file)
    expect(files).toContain('meminfo.txt')
    expect(files).toContain('thermalservice.txt')
    expect(files).toContain('netstats.txt')
  })
})

describe('findSurfaceViewLayer', () => {
  const pkg = 'com.evermore.oda.qa'

  test('encuentra el layer BLAST (API 31+)', () => {
    const list = [
      'com.android.systemui.ImageWallpaper#0',
      `SurfaceView[${pkg}/com.unity3d.player.UnityPlayerActivity]@0(BLAST)#132833`,
      `${pkg}/com.unity3d.player.UnityPlayerActivity#0`,
    ].join('\n')
    expect(findSurfaceViewLayer(list, pkg)).toBe(
      `SurfaceView[${pkg}/com.unity3d.player.UnityPlayerActivity]@0(BLAST)#132833`,
    )
  })

  test('encuentra el layer legacy (API 26–30)', () => {
    const list = `StatusBar#0\nSurfaceView - ${pkg}/com.unity3d.player.UnityPlayerActivity#0`
    expect(findSurfaceViewLayer(list, pkg)).toBe(
      `SurfaceView - ${pkg}/com.unity3d.player.UnityPlayerActivity#0`,
    )
  })

  test('fallback: cualquier línea que mencione el pkg si no hay SurfaceView', () => {
    const list = `StatusBar#0\n${pkg}/com.unity3d.player.UnityPlayerActivity#0`
    expect(findSurfaceViewLayer(list, pkg)).toBe(`${pkg}/com.unity3d.player.UnityPlayerActivity#0`)
  })

  test('no está el pkg → null', () => {
    expect(findSurfaceViewLayer('StatusBar#0\ncom.otra.app#0', pkg)).toBeNull()
    expect(findSurfaceViewLayer('', pkg)).toBeNull()
  })
})

describe('deviceInfoFromProps', () => {
  test('extrae ficha completa con ro.soc.*', () => {
    const info = deviceInfoFromProps(
      {
        'ro.product.model': 'Pixel 7',
        'ro.product.brand': 'google',
        'ro.product.manufacturer': 'Google',
        'ro.build.version.release': '13',
        'ro.build.version.sdk': '33',
        'ro.soc.manufacturer': 'Google',
        'ro.soc.model': 'GS201',
      },
      'ABC123',
      'GLES: ARM, Mali-G710, OpenGL ES 3.2',
    )
    expect(info.model).toBe('Pixel 7')
    expect(info.soc).toBe('Google GS201')
    expect(info.gpu).toBe('ARM, Mali-G710, OpenGL ES 3.2')
    expect(info.apiLevel).toBe('33')
    expect(info.serial).toBe('ABC123')
  })

  test('sin ro.soc.* cae a ro.board.platform; sin GLES lo marca desconocido', () => {
    const info = deviceInfoFromProps({ 'ro.board.platform': 'kona' }, 'X', '')
    expect(info.soc).toBe('kona')
    expect(info.gpu).toContain('desconocida')
    expect(info.model).toBe('desconocido')
  })

  test('ignora el header decorativo de RenderEngine y toma la línea GLES: real', () => {
    const info = deviceInfoFromProps(
      {},
      'X',
      ' ------------RE GLES (Ganesh)------------\nGLES: ARM, Mali-G57 MC2, OpenGL ES 3.2',
    )
    expect(info.gpu).toBe('ARM, Mali-G57 MC2, OpenGL ES 3.2')
  })
})

describe('buildReadme', () => {
  const info = deviceInfoFromProps(
    {
      'ro.product.model': 'Pixel 7',
      'ro.product.brand': 'google',
      'ro.product.manufacturer': 'Google',
      'ro.build.version.release': '13',
      'ro.build.version.sdk': '33',
      'ro.soc.model': 'GS201',
    },
    'ABC123',
    'GLES: ARM, Mali-G710',
  )

  test('incluye ficha del device y sección de fallos', () => {
    const md = buildReadme(info, {
      pkg: 'com.evermore.oda.qa',
      date: '2026-07-16T12:00:00Z',
      sessionSeconds: 30,
      ticks: 30,
      gpuPath: null,
      layer: 'SurfaceView[com.evermore.oda.qa/...]@0(BLAST)#1',
      failures: ['`oneshot/gpu-kgsl-gpubusy.err.txt` — exit 1: No such file or directory'],
    })
    expect(md).toContain('# Fixtures: Pixel 7 (API 33)')
    expect(md).toContain('| Modelo | Pixel 7 |')
    expect(md).toContain('| Android | 13 (API 33) |')
    expect(md).toContain('| SoC | GS201 |')
    expect(md).toContain('| GPU | ARM, Mali-G710 |')
    expect(md).toContain('2026-07-16T12:00:00Z')
    expect(md).toContain('ninguna legible — GPU% es N/A en este device')
    expect(md).toContain('- `oneshot/gpu-kgsl-gpubusy.err.txt` — exit 1: No such file or directory')
  })

  test('sin fallos lo dice explícito', () => {
    const md = buildReadme(info, {
      pkg: 'pkg',
      date: 'd',
      sessionSeconds: 30,
      ticks: 30,
      gpuPath: '/sys/class/kgsl/kgsl-3d0/gpubusy',
      layer: null,
      failures: [],
    })
    expect(md).toContain('Ninguno — todo capturado.')
    expect(md).toContain('/sys/class/kgsl/kgsl-3d0/gpubusy')
    expect(md).toContain('no encontrado en --list')
  })
})
