import { describe, expect, test } from 'bun:test'
import type { Sample } from '../core/schema'
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
  packageName: 'com.evermore.oda.qa',
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
    expect(html).toContain('com.evermore.oda.qa')
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('window.ReportData')
    expect(html).toContain('data:image/png;base64,') // logos inline
    expect(html).toContain('data:font/woff2;base64,') // fuentes inline
    expect(html).toContain('echarts') // lib inline
    // ningún placeholder del template sin resolver (echarts minificado usa __X__ propios)
    for (const token of [
      '__TITLE__',
      '__THEME__',
      '__FONTS_CSS__',
      '__LOGO_EVERMORE__',
      '__LOGO_ODACLICK__',
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
      packageName: 'com.evermore.oda.qa',
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
      packageName: 'com.evermore.oda.qa',
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
      packageName: 'com.evermore.oda.qa',
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
      'evermore-report-com.evermore.oda.qa-2026-07-20T18-05-30.html',
    )
  })
})
