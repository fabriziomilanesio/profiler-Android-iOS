import { describe, expect, test } from 'bun:test'
import type { Sample } from '../core/schema'
import type { LogEntry, LogLevel } from '../core/logs/logEntry'
import { buildReportSession } from '../core/session/stats'
import { generateReportHtml, reportFilename } from './generateReport'

function sample(t: number): Sample {
  return {
    t,
    ts: 1_750_000_000_000 + t * 1000,
    cpu: 40,
    deviceCpu: 55,
    deviceRamUsedMb: 2800,
    gpu: 60,
    fps: 58,
    frame: {
      p50Ms: 16,
      p90Ms: 17,
      p99Ms: 33,
      jankPct: 2,
      jankFrames: 2,
      totalFrames: 100,
    },
    tempC: 33,
    mem: {
      pss: 900,
      footprint: null,
      compressed: null,
      rss: null,
      java: 300,
      native: 400,
      graphics: 150,
      code: 40,
      stack: 5,
      other: 5,
    },
    battery: { levelPct: 80, tempC: 30, mA: -500, charging: false },
    netRxKb: 10,
    netTxKb: 2,
  }
}

const SESSION = buildReportSession({
  samples: [sample(0), sample(1), sample(2)],
  packageName: 'com.sample.oda.qa',
  device: {
    serial: 'X1',
    model: 'SM-A155M',
    manufacturer: 'samsung',
    androidRelease: '16',
    apiLevel: 36,
    soc: 'mt6789',
    gpu: 'Mali-G57',
    ramTotalMb: 3666,
    cores: 8,
    refreshHz: 90,
  },
  intervalMs: 1000,
  trimmed: false,
})

describe('generateReportHtml', () => {
  test('produce un HTML auto-contenido con los datos embebidos', () => {
    const html = generateReportHtml(SESSION, 'dark', new Date('2026-07-20T18:00:00Z'))
    expect(html).toContain('com.sample.oda.qa')
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('window.ReportData')
    expect(html).toContain('data:font/woff2;base64,') // fuentes inline
    expect(html).toContain('echarts') // lib inline
    // ningún placeholder del template sin resolver (echarts minificado usa __X__ propios)
    for (const token of [
      '__TITLE__',
      '__THEME__',
      '__FONTS_CSS__',
      '__GENERATED__',
      '__ECHARTS__',
      '__REPORT_DATA__',
      '__TEMPLATE_JS__',
    ]) {
      expect(html).not.toContain(token)
    }
    // standalone: sin referencias relativas a assets del server
    expect(html).not.toContain('src="assets/')
    expect(html).not.toContain('vendor/echarts.min.js"')
  })

  test('veredicto de perf embebido: target declarado, semáforo y secciones (026)', () => {
    const html = generateReportHtml(SESSION, 'light', new Date('2026-07-31T18:00:00Z'))
    // secciones nuevas del template
    expect(html).toContain('id="verdictCard"')
    expect(html).toContain('id="corrChart"')
    expect(html).toContain('Worst stretches')
    expect(html).toContain('Thermal throttling')
    // datos del veredicto embebidos (fps 58 vs target default 30 ⇒ verde, 100% en target)
    expect(html).toContain('"fpsTarget":30')
    expect(html).toContain('"overall":"green"')
    expect(html).toContain('"timeInTarget":{"greenPct":100')
    expect(html).toContain('"throttling":{"detected":false')
  })

  test('el target configurado viaja hasta el reporte (no siempre 30)', () => {
    const s60 = buildReportSession({
      samples: [sample(0), sample(1), sample(2)],
      packageName: 'com.sample.oda.qa',
      device: null,
      intervalMs: 1000,
      trimmed: false,
      fpsTarget: 60,
    })
    expect(s60.fpsTarget).toBe(60)
    expect(s60.verdict.overall).toBe('yellow') // 58 fps ≥ 80% de 60
    const html = generateReportHtml(s60, 'light', new Date('2026-07-31T18:00:00Z'))
    expect(html).toContain('"fpsTarget":60')
  })

  test('sesión vieja sin frame ni FPS: veredicto degrada sin romper el reporte', () => {
    const legacy = buildReportSession({
      samples: [sample(0), sample(1), sample(2)].map((s) => {
        const clone = { ...s, fps: null } as Partial<Sample>
        delete clone.frame
        return clone as Sample
      }),
      packageName: 'com.sample.oda.qa',
      device: null,
      intervalMs: 1000,
      trimmed: false,
    })
    expect(legacy.verdict.overall).toBeNull()
    expect(legacy.verdict.timeInTarget).toBeNull()
    expect(legacy.verdict.worstWindows).toEqual([])
    const html = generateReportHtml(legacy, 'dark', new Date('2026-07-31T18:00:00Z'))
    expect(html).toContain('"overall":null')
  })

  test('escapa </script> dentro de los datos (no corta el script del template)', () => {
    const evil = buildReportSession({
      samples: [sample(0)],
      packageName: 'com.sample.oda.qa',
      device: null,
      intervalMs: 1000,
      trimmed: false,
    })
    // un campo string con </script> — simulando data hostil del device
    ;(evil as { app: string }).app = '</script><script>alert(1)</script>'
    const html = generateReportHtml(evil, 'light', new Date('2026-07-20T18:00:00Z'))
    expect(html).not.toContain('</script><script>alert(1)')
  })

  test('reportFilename: app + timestamp', () => {
    expect(reportFilename(SESSION, new Date('2026-07-20T18:05:30Z'))).toBe(
      'sample-report-com.sample.oda.qa-2026-07-20T18-05-30.html',
    )
  })
})

// ---------- logs en el reporte (ticket 030) ----------
const BASE_TS = 1_750_000_000_000

function logAt(offsetMs: number, level: LogLevel, message: string, crash = false): LogEntry {
  const e: LogEntry = {
    ts: BASE_TS + offsetMs,
    level,
    tag: crash ? 'AndroidRuntime' : 'Unity',
    message,
    pid: 111,
    source: 'logcat',
  }
  if (crash) e.isCrash = true
  return e
}

describe('logs embebidos en el reporte (030)', () => {
  const CRASH_LOGS = [
    logAt(500, 'I', 'Loading scene'),
    logAt(800, 'W', 'Texture atlas not preloaded'),
    logAt(1200, 'E', 'FATAL EXCEPTION: main', true),
    logAt(1210, 'E', 'java.lang.IllegalStateException: boom', true),
    logAt(1220, 'E', '\tat com.sample.oda.GameLoop.tick(GameLoop.java:87)', true),
  ]

  test('reporte con crashes: marks presentes y sección de logs embebida', () => {
    const s = buildReportSession({
      samples: [sample(0), sample(1), sample(2)],
      packageName: 'com.sample.oda.qa',
      device: null,
      intervalMs: 1000,
      trimmed: false,
      logEntries: CRASH_LOGS,
    })
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.label).toBe('CRASH: FATAL EXCEPTION: main')
    expect(s.logs).not.toBeNull()
    // W + 3 líneas del crash embebidas; la I queda solo como conteo
    expect(s.logs!.entries).toHaveLength(4)
    expect(s.logs!.totalByLevel.I).toBe(1)
    const html = generateReportHtml(s, 'dark', new Date('2026-07-31T18:00:00Z'))
    expect(html).toContain('id="logsSection"')
    expect(html).toContain('"marks":[{')
    expect(html).toContain('CRASH: FATAL EXCEPTION: main')
    expect(html).toContain('"logs":{')
  })

  test('sesión sin logs: marks vacías, logs null, el HTML degrada sin sección con datos', () => {
    const s = buildReportSession({
      samples: [sample(0), sample(1)],
      packageName: 'com.sample.oda.qa',
      device: null,
      intervalMs: 1000,
      trimmed: false,
    })
    expect(s.marks).toEqual([])
    expect(s.logs).toBeNull()
    const html = generateReportHtml(s, 'light', new Date('2026-07-31T18:00:00Z'))
    expect(html).toContain('"logs":null')
    expect(html).toContain('"marks":[]')
  })

  test('cap respetado: crashes completos + no-crash truncadas con conteo', () => {
    const many: LogEntry[] = []
    for (let i = 0; i < 700; i++) many.push(logAt(i, 'W', `warn ${i}`))
    many.push(...CRASH_LOGS.filter((e) => e.isCrash))
    many.sort((a, b) => a.ts - b.ts)
    const s = buildReportSession({
      samples: [sample(0), sample(1), sample(2)],
      packageName: 'com.sample.oda.qa',
      device: null,
      intervalMs: 1000,
      trimmed: false,
      logEntries: many,
    })
    expect(s.logs!.entries.filter((e) => !e.isCrash)).toHaveLength(500)
    expect(s.logs!.entries.filter((e) => e.isCrash)).toHaveLength(3)
    expect(s.logs!.truncated).toBe(200)
  })

  test('rango respetado: solo los logs de la ventana de los samples entran', () => {
    // samples en t=0..2 ⇒ ventana [BASE_TS, BASE_TS+2000]
    const s = buildReportSession({
      samples: [sample(0), sample(1), sample(2)],
      packageName: 'com.sample.oda.qa',
      device: null,
      intervalMs: 1000,
      trimmed: false,
      logEntries: [
        logAt(-5000, 'E', 'de la app anterior'),
        logAt(1000, 'E', 'dentro'),
        logAt(60_000, 'E', 'de después'),
        logAt(4000, 'E', 'FATAL EXCEPTION: main', true), // gracia solo-crash
      ],
    })
    expect(s.logs!.entries.map((e) => e.message)).toEqual(['dentro', 'FATAL EXCEPTION: main'])
    expect(s.logs!.totalByLevel.E).toBe(2)
    // la marca del crash post-ventana queda clampeada al borde del chart
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.ts).toBe(BASE_TS + 2000)
  })
})
