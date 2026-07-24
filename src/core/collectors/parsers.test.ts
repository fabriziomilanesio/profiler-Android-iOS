// Tests de los parsers puros contra los fixtures REALES del Galaxy A15 (SM-A155M / API 36).
// Cada parser: string crudo del device → tipo del schema. Formato desconocido ⇒ N/A tipado
// (null), nunca throw.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMeminfo, mergeMemSamples } from './meminfo'
import { parseCpu, parseDeviceCpu } from './cpu'
import { parseDeviceMemUsedMb } from './deviceMem'
import { parsePids } from '../sampler/sampler'
import { parseFps } from './fps'
import { parseTemp } from './temp'
import { parseGpu } from './gpu'
import { parseBattery } from './battery'
import { parseDeviceInfo } from './deviceInfo'
import { parseNetDev, netThroughputKb } from './netdev'

const FIX = join(import.meta.dir, '../../../fixtures/sm-a155m-api36')
const read = (p: string): string => readFileSync(join(FIX, p), 'utf8')

describe('parseMeminfo (App Summary)', () => {
  const raw = read('oneshot/dumpsys-meminfo.txt')

  test('extrae PSS total y breakdown en MB desde el fixture real', () => {
    const m = parseMeminfo(raw)
    // TOTAL PSS: 926735 KB ≈ 905.02 MB
    expect(m.pss).toBeCloseTo(905.01, 1)
    // Java Heap: 12940 KB ≈ 12.64 MB
    expect(m.java).toBeCloseTo(12.64, 1)
    // Native Heap: 61984 KB
    expect(m.native).toBeCloseTo(60.53, 1)
    // Graphics: 421468 KB (memtrack HAL presente en este device)
    expect(m.graphics).toBeCloseTo(411.59, 1)
    // Code: 124092 KB
    expect(m.code).toBeCloseTo(121.18, 1)
    // Stack: 4168 KB
    expect(m.stack).toBeCloseTo(4.07, 1)
    // Private Other (165944) + System (136139) = 302083 KB → other
    expect(m.other).toBeCloseTo(295.0, 0)
  })

  test('Graphics=0 ⇒ null (memtrack HAL ausente, no "0 MB")', () => {
    const zeroGfx = raw.replace(/Graphics:\s+\d+/, 'Graphics:        0')
    expect(parseMeminfo(zeroGfx).graphics).toBeNull()
  })

  test('formato desconocido ⇒ todo null, sin throw', () => {
    const m = parseMeminfo('garbage output\nno app summary here')
    expect(m.pss).toBeNull()
    expect(m.java).toBeNull()
  })
})

describe('parseCpu (deltas /proc/<pid>/stat vs /proc/stat)', () => {
  test('share-of-device 0–100 desde dos snapshots reales de sesión', () => {
    // tick-000 proc-stat (device) + oneshot proc-pid-stat como prev; tick-001 como next.
    const prevPidStat = read('oneshot/proc-pid-stat.txt')
    const prevCpuStat = read('oneshot/proc-stat.txt')
    const nextPidStat = read('oneshot/proc-pid-stat.txt') // mismo ⇒ delta 0 proc
    const nextCpuStat = read('session/tick-000/proc-stat.txt')
    const cpu = parseCpu(
      { pidStats: [prevPidStat], cpuStat: prevCpuStat },
      { pidStats: [nextPidStat], cpuStat: nextCpuStat },
    )
    // delta proc = 0 (mismo stat) ⇒ 0% pero válido (número, no null)
    expect(cpu).not.toBeNull()
    expect(cpu).toBe(0)
  })

  test('proc que sumó ticks contra device que sumó más ⇒ 0–100', () => {
    // pid usó 100 ticks (utime+stime) mientras el device total usó 1000 ⇒ 10%
    const prevPid = '1 (x) S 0 0 0 0 0 0 0 0 0 0 100 100 0 0'
    const nextPid = '1 (x) S 0 0 0 0 0 0 0 0 0 0 150 150 0 0' // +100
    const prevCpu = 'cpu  0 0 0 0 0 0 0 0 0 0'
    const nextCpu = 'cpu  500 0 500 0 0 0 0 0 0 0' // +1000 total
    const cpu = parseCpu(
      { pidStats: [prevPid], cpuStat: prevCpu },
      { pidStats: [nextPid], cpuStat: nextCpu },
    )
    expect(cpu).toBeCloseTo(10, 5)
  })

  test('multi-proceso: suma los deltas de main + hijos (matcheados por pid)', () => {
    const prevMain = '1 (app) S 0 0 0 0 0 0 0 0 0 0 100 0 0 0'
    const nextMain = '1 (app) S 0 0 0 0 0 0 0 0 0 0 150 0 0 0' // +50
    const prevChild = '2 (app:svc) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
    const nextChild = '2 (app:svc) S 0 0 0 0 0 0 0 0 0 0 50 0 0 0' // +50
    const prevCpu = 'cpu  0 0 0 0 0 0 0 0 0 0'
    const nextCpu = 'cpu  500 0 500 0 0 0 0 0 0 0' // +1000 ⇒ (50+50)/1000 = 10%
    const cpu = parseCpu(
      { pidStats: [prevMain, prevChild], cpuStat: prevCpu },
      { pidStats: [nextMain, nextChild], cpuStat: nextCpu },
    )
    expect(cpu).toBeCloseTo(10, 5)
  })

  test('hijo que nace entre snapshots no aporta delta (no infla el %)', () => {
    const prevMain = '1 (app) S 0 0 0 0 0 0 0 0 0 0 100 0 0 0'
    const nextMain = '1 (app) S 0 0 0 0 0 0 0 0 0 0 200 0 0 0' // +100
    const newChild = '9 (app:new) S 0 0 0 0 0 0 0 0 0 0 99999 0 0 0' // sin prev
    const prevCpu = 'cpu  0 0 0 0 0 0 0 0 0 0'
    const nextCpu = 'cpu  500 0 500 0 0 0 0 0 0 0'
    const cpu = parseCpu(
      { pidStats: [prevMain], cpuStat: prevCpu },
      { pidStats: [nextMain, newChild], cpuStat: nextCpu },
    )
    expect(cpu).toBeCloseTo(10, 5)
  })

  test('comm con espacios/paréntesis se parsea desde el último )', () => {
    const prevPid = '1 (weird (name) here) S 0 0 0 0 0 0 0 0 0 0 0 0'
    const nextPid = '1 (weird (name) here) S 0 0 0 0 0 0 0 0 0 0 50 50'
    const prevCpu = 'cpu  0 0 0 0 0 0 0'
    const nextCpu = 'cpu  0 0 1000 0 0 0 0'
    expect(
      parseCpu(
        { pidStats: [prevPid], cpuStat: prevCpu },
        { pidStats: [nextPid], cpuStat: nextCpu },
      ),
    ).toBeCloseTo(10, 5)
  })

  test('formato desconocido ⇒ null', () => {
    expect(
      parseCpu({ pidStats: ['x'], cpuStat: 'y' }, { pidStats: ['x'], cpuStat: 'y' }),
    ).toBeNull()
  })
})

describe('parseDeviceCpu (CPU total del device desde /proc/stat)', () => {
  test('busy = total − idle − iowait sobre el delta', () => {
    // Δtotal = 1000, Δidle(3º) = 600, Δiowait(4º) = 100 ⇒ busy 300/1000 = 30%
    const prev = 'cpu  0 0 0 0 0 0 0 0 0 0'
    const next = 'cpu  200 0 100 600 100 0 0 0 0 0'
    expect(
      parseDeviceCpu({ pidStats: [], cpuStat: prev }, { pidStats: [], cpuStat: next }),
    ).toBeCloseTo(30, 5)
  })

  test('snapshots reales del device ⇒ 0–100', () => {
    const prev = read('oneshot/proc-stat.txt')
    const next = read('session/tick-000/proc-stat.txt')
    const v = parseDeviceCpu({ pidStats: [], cpuStat: prev }, { pidStats: [], cpuStat: next })
    expect(v).not.toBeNull()
    expect(v!).toBeGreaterThanOrEqual(0)
    expect(v!).toBeLessThanOrEqual(100)
  })

  test('formato desconocido ⇒ null', () => {
    expect(
      parseDeviceCpu({ pidStats: [], cpuStat: 'x' }, { pidStats: [], cpuStat: 'y' }),
    ).toBeNull()
  })
})

describe('parseDeviceMemUsedMb (/proc/meminfo → RAM usada del device)', () => {
  test('MemTotal − MemAvailable en MB desde el fixture real', () => {
    const raw = read('oneshot/proc-meminfo.txt')
    const used = parseDeviceMemUsedMb(raw)
    expect(used).not.toBeNull()
    expect(used!).toBeGreaterThan(0)
    // nunca más que el total del fixture (3754184 kB ≈ 3666 MB)
    expect(used!).toBeLessThan(3667)
  })

  test('sintético: 4 GB total, 1 GB available ⇒ 3072 MB usados', () => {
    const raw = 'MemTotal:  4194304 kB\nMemFree:  100000 kB\nMemAvailable:  1048576 kB\n'
    expect(parseDeviceMemUsedMb(raw)).toBeCloseTo(3072, 5)
  })

  test('sin MemAvailable ⇒ null', () => {
    expect(parseDeviceMemUsedMb('MemTotal: 1000 kB\n')).toBeNull()
    expect(parseDeviceMemUsedMb('')).toBeNull()
  })
})

describe('mergeMemSamples (agregación multi-proceso)', () => {
  const base = {
    pss: null,
    rss: null,
    java: null,
    native: null,
    graphics: null,
    code: null,
    stack: null,
    other: null,
  }

  test('suma por categoría los no-null', () => {
    const merged = mergeMemSamples([
      { ...base, pss: 100, java: 10, graphics: 50 },
      { ...base, pss: 40, java: 5, native: 8 },
    ])
    expect(merged.pss).toBe(140)
    expect(merged.java).toBe(15)
    expect(merged.native).toBe(8)
    expect(merged.graphics).toBe(50)
    expect(merged.code).toBeNull() // todos null ⇒ null, no 0
  })

  test('lista vacía ⇒ todo null', () => {
    expect(mergeMemSamples([]).pss).toBeNull()
  })
})

describe('parsePids (ps -A → main + hijos del package)', () => {
  const ps = [
    'PID NAME',
    '1 init',
    '17276 com.android.chrome',
    '23490 com.android.chrome:privileged_process0',
    '23583 com.android.chrome:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:1',
    '17833 com.evermore.oda.qa',
    '999 com.android.chromecustom', // prefijo parecido SIN ":" ⇒ no es hijo
  ].join('\n')

  test('main exacto + hijos pkg:*', () => {
    const r = parsePids(ps, 'com.android.chrome')
    expect(r.main).toBe(17276)
    expect(r.children).toEqual([23490, 23583])
  })

  test('app single-process: main y cero hijos (caso Evermore)', () => {
    const r = parsePids(ps, 'com.evermore.oda.qa')
    expect(r.main).toBe(17833)
    expect(r.children).toEqual([])
  })

  test('app no corriendo ⇒ main null', () => {
    expect(parsePids(ps, 'com.no.esta').main).toBeNull()
  })
})

describe('parseFps (SurfaceFlinger --timestats averageFPS)', () => {
  test('extrae averageFPS del dump real (un solo layer)', () => {
    const fps = parseFps(read('session/final/timestats-dump.txt'))
    expect(fps).toBeCloseTo(33.94, 2)
  })

  test('con varios layers, filtra el averageFPS del SurfaceView de la app', () => {
    // Reproduce el bug real del device: NotificationShade primero, app después.
    const multi = [
      'layerName = NotificationShade$_2162#1789',
      'totalFrames = 590',
      'averageFPS = 54.828',
      'layerName = ca6669f SurfaceView[com.evermore.oda.qa/x]@0(BLAST)#1798',
      'totalFrames = 342',
      'averageFPS = 39.758',
      'layerName = StatusBar$_2162#95',
      'averageFPS = 32.961',
    ].join('\n')
    // sin filtro tomaría 54.828 (NotificationShade) — con package toma el de la app
    expect(parseFps(multi)).toBeCloseTo(54.828, 2)
    expect(parseFps(multi, 'com.evermore.oda.qa')).toBeCloseTo(39.758, 2)
  })

  test('package presente en el dump pero sin su layer (app idle) ⇒ null', () => {
    const multi = 'layerName = NotificationShade#1\naverageFPS = 60.0'
    expect(parseFps(multi, 'com.evermore.oda.qa')).toBeNull()
  })

  test('formato desconocido ⇒ null', () => {
    expect(parseFps('no timestats here')).toBeNull()
  })
})

describe('parseTemp (thermalservice HAL, mType 0=CPU/AP)', () => {
  test('reporta CPU(AP) desde "Current temperatures from HAL"', () => {
    const t = parseTemp(read('oneshot/dumpsys-thermalservice.txt'))
    // Current from HAL: mType=0 mName=AP mValue=30.9
    expect(t).toBeCloseTo(30.9, 1)
  })

  test('formato desconocido ⇒ null', () => {
    expect(parseTemp('no temperatures')).toBeNull()
  })
})

describe('parseGpu (/sys/kernel/gpu/gpu_busy "NN %")', () => {
  test('parsea el entero del fixed real', () => {
    expect(parseGpu(read('oneshot/gpu-samsung-gpu-busy.txt'))).toBe(99)
  })

  test('parsea variantes de session ticks', () => {
    expect(parseGpu('100 %\n')).toBe(100)
    expect(parseGpu('0 %')).toBe(0)
  })

  test('.err.txt / vacío / no numérico ⇒ null', () => {
    expect(parseGpu('cat: ...: No such file or directory')).toBeNull()
    expect(parseGpu('')).toBeNull()
  })
})

describe('parseBattery (dumpsys battery)', () => {
  const raw = read('oneshot/dumpsys-battery.txt')

  test('level / temp(÷10) / mA / charging desde el fixture real', () => {
    const b = parseBattery(raw)
    expect(b.levelPct).toBe(99)
    expect(b.tempC).toBeCloseTo(25.7, 1) // 257 / 10
    expect(b.mA).toBe(587)
    // AC powered: true ⇒ charging
    expect(b.charging).toBe(true)
  })

  test('sin AC/USB/wireless ⇒ charging false', () => {
    const discharging = raw.replace('AC powered: true', 'AC powered: false')
    expect(parseBattery(discharging).charging).toBe(false)
  })

  test('formato desconocido ⇒ todo null', () => {
    const b = parseBattery('no battery info')
    expect(b.levelPct).toBeNull()
    expect(b.mA).toBeNull()
  })
})

describe('parseNetDev (/proc/net/dev device-wide) + throughput', () => {
  const raw = read('oneshot/proc-net-dev.txt')

  test('suma rx/tx de interfaces de datos del fixture real (wlan0 + rmnet*)', () => {
    const snap = parseNetDev(raw, 1000)
    expect(snap).not.toBeNull()
    // wlan0 rx=6191217 + rmnet0 rx=4168047 + rmnet1 rx=467211 → incluye ≥ wlan0
    expect(snap!.rxBytes).toBeGreaterThanOrEqual(6191217)
    expect(snap!.txBytes).toBeGreaterThan(0)
  })

  test('ignora lo/dummy/túneles/p2p', () => {
    const snap = parseNetDev('lo: 10600 212 0 0 0 0 0 0 10600 212 0 0 0 0 0 0', 0)
    expect(snap).toBeNull()
  })

  test('matchea las variantes rmnet de Qualcomm (rmnet_data0 / rmnet_ipa0)', () => {
    const qcom = [
      'rmnet_data0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0',
      'rmnet_ipa0: 500 5 0 0 0 0 0 0 700 7 0 0 0 0 0 0',
    ].join('\n')
    const snap = parseNetDev(qcom, 0)!
    expect(snap.rxBytes).toBe(1500)
    expect(snap.txBytes).toBe(2700)
  })

  test('throughput = delta bytes / delta segundos / 1024 (KB/s)', () => {
    const prev = { rxBytes: 6191217, txBytes: 2312916, ts: 0 }
    const next = { rxBytes: 6193240, txBytes: 2312916, ts: 2000 } // +2023B rx en 2s
    const tp = netThroughputKb(prev, next)!
    expect(tp.rxKb).toBeCloseTo(2023 / 1024 / 2, 3) // ~0.988 KB/s
    expect(tp.txKb).toBe(0)
  })

  test('contador que baja (reset de interfaz) ⇒ 0, no negativo', () => {
    const tp = netThroughputKb(
      { rxBytes: 5000, txBytes: 5000, ts: 0 },
      { rxBytes: 10, txBytes: 10, ts: 1000 },
    )!
    expect(tp.rxKb).toBe(0)
    expect(tp.txKb).toBe(0)
  })

  test('dt<=0 ⇒ null', () => {
    expect(
      netThroughputKb({ rxBytes: 0, txBytes: 0, ts: 100 }, { rxBytes: 100, txBytes: 100, ts: 100 }),
    ).toBeNull()
  })

  test('vacío ⇒ null', () => {
    expect(parseNetDev('', 0)).toBeNull()
  })
})

describe('parseDeviceInfo (getprop + /proc/meminfo)', () => {
  test('extrae ficha limpia del device real (incl. GPU sin "GLES (Ganesh)")', () => {
    const info = parseDeviceInfo({
      getprop: read('oneshot/getprop.txt'),
      procMeminfo: read('oneshot/proc-meminfo.txt'),
      surfaceflingerGles: read('oneshot/surfaceflinger-gles.txt'),
      serial: 'REDACTED-SERIAL',
    })
    expect(info.serial).toBe('REDACTED-SERIAL')
    expect(info.model).toBe('SM-A155M')
    expect(info.manufacturer).toBe('samsung')
    expect(info.androidRelease).toBe('16')
    expect(info.apiLevel).toBe(36)
    expect(info.soc).toBe('mt6789')
    // GPU real limpio: "Mali-G57 MC2", NO "GLES (Ganesh)" ni "------RE GLES..."
    expect(info.gpu).toBe('Mali-G57 MC2')
    expect(info.gpu).not.toMatch(/Ganesh|GLES/i)
    // MemTotal 3754184 KB ≈ 3666 MB
    expect(info.ramTotalMb).toBeCloseTo(3666, 0)
  })

  test('nproc → cores; ausente/basura ⇒ null', () => {
    const inputs = {
      getprop: '[ro.product.model]: [X]\n',
      procMeminfo: '',
      surfaceflingerGles: '',
      serial: 'S',
    }
    expect(parseDeviceInfo({ ...inputs, nproc: '8\n' }).cores).toBe(8)
    expect(parseDeviceInfo({ ...inputs, nproc: 'garbage' }).cores).toBeNull()
    expect(parseDeviceInfo(inputs).cores).toBeNull()
  })

  test('sin SurfaceFlinger GLES cae a ro.hardware.vulkan / N/A limpio', () => {
    const info = parseDeviceInfo({
      getprop: '[ro.product.model]: [X]\n',
      procMeminfo: '',
      surfaceflingerGles: '',
      serial: 'S',
    })
    expect(info.model).toBe('X')
    expect(info.gpu).toBeNull()
    expect(info.ramTotalMb).toBeNull()
  })
})
