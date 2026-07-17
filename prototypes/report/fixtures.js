/**
 * fixtures.js — generador de "sesiones" fake COMPLETAS para el prototipo del reporte
 * HTML (wayfinder ticket 020). DESCARTABLE.
 *
 * Produce 2-3 sesiones de la MISMA app con distintos bundle id (qa vs prod), cada una
 * con metadata + una serie temporal 1 Hz + un `SessionSummary` precalculado por métrica.
 * Las sesiones difieren de forma creíble (qa consume más batería/temp/RAM que prod) para
 * que la comparación tenga señal.
 *
 * NUEVA métrica respecto del dashboard: BATERÍA (nivel %, temp de batería, mA promedio) y
 * su derivada de sesión `drainPct` = nivelInicial − nivelFinal.
 *
 * ---- Forma del SessionSummary (contrato propuesto para tickets 3 y 12) ----
 * Cada métrica escalar (cpu, gpu, fps, tempC, ramMb) → { avg, peak, min, p90 }.
 * Batería → { levelStart, levelEnd, drainPct, avgMa, tempPeak, tempAvg }.
 * memAvg → breakdown promedio de PSS por categoría (suma == ramMb.avg).
 *
 * Determinístico: usa un PRNG con seed por sesión para que el reporte y el smoke test
 * vean SIEMPRE los mismos números (comparación reproducible). Corre en browser
 * (global `ReportFixtures`) y en Bun/Node (`module.exports`).
 */
(function (global) {
  'use strict';

  // ---- PRNG determinístico (mulberry32) — sin esto la comparación cambiaría cada load ----
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function drift(cur, target, rate, noise, rnd) {
    return cur + (target - cur) * rate + (rnd() * 2 - 1) * noise;
  }
  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 0;
    var idx = clamp(Math.round((p / 100) * (sortedAsc.length - 1)), 0, sortedAsc.length - 1);
    return sortedAsc[idx];
  }

  // Fases de una sesión típica. `load` ∈ [0,1] escala calor/GC/consumo.
  var PHASES = [
    { name: 'menu',     dur: [10, 16], cpu: 26, gpu: 34, fps: 60, load: 0.25 },
    { name: 'loading',  dur: [4, 7],   cpu: 62, gpu: 40, fps: 47, load: 0.70, netHeavy: true },
    { name: 'gameplay', dur: [26, 44], cpu: 44, gpu: 58, fps: 58, load: 0.55 },
    { name: 'combat',   dur: [12, 22], cpu: 63, gpu: 76, fps: 52, load: 0.95 },
  ];

  var DEVICE = {
    name: 'Samsung SM_G973F',
    model: 'SM_G973F',
    os: 'Android 12 (API 31)',
    ramGb: 8,
    ramMb: 8192,
    gpu: 'Adreno 640',
    soc: 'Snapdragon 855',
    screen: '1440×3040',
    batteryCapacityMah: 3400,
  };

  /**
   * Genera una sesión completa.
   * @param cfg { bundleId, label, seed, durationS, intensity } intensity>1 = más caliente/hambriento.
   */
  function makeSession(cfg) {
    var rnd = mulberry32(cfg.seed);
    var durationS = cfg.durationS || 300; // ~5 min
    var intensity = cfg.intensity == null ? 1 : cfg.intensity;

    // fase inicial + estado
    var phaseIdx = 0, phase = PHASES[0];
    var phaseLeft = Math.round(phase.dur[0] + rnd() * (phase.dur[1] - phase.dur[0]));

    var cpu = 24, gpu = 32, fps = 60, temp = 30 + rnd() * 2;
    var mem = { java: 420, native: 610, graphics: 360, code: 210, stack: 24, other: 130 };
    var gcCooldown = 20 + Math.floor(rnd() * 18);
    var jankLeft = 0, jankDepth = 0;

    // batería: arranca alta, drena durante la sesión (más rápido con más load/intensity)
    var battLevel = 82 - rnd() * 6;      // 76–82 %
    var battTemp = 28 + rnd() * 2;
    var rxTotal = 0, txTotal = 0;

    function pss() {
      return mem.java + mem.native + mem.graphics + mem.code + mem.stack + mem.other;
    }
    function nextPhase() {
      var candidates = [];
      for (var i = 0; i < PHASES.length; i++) if (i !== phaseIdx) candidates.push(i);
      phaseIdx = candidates[Math.floor(rnd() * candidates.length)];
      phase = PHASES[phaseIdx];
      phaseLeft = Math.round(phase.dur[0] + rnd() * (phase.dur[1] - phase.dur[0]));
    }

    var series = [];
    var t0 = cfg.startEpochMs || Date.UTC(2026, 6, 16, 20, 12, 0); // fecha fija de la sesión

    for (var t = 0; t < durationS; t++) {
      if (--phaseLeft <= 0) nextPhase();
      var load = phase.load;

      cpu = clamp(drift(cpu, phase.cpu * (1 + (intensity - 1) * 0.5), 0.25, 3.5, rnd), 20, 78);
      gpu = clamp(drift(gpu, phase.gpu * (1 + (intensity - 1) * 0.4), 0.25, 4.0, rnd), 30, 92);

      // FPS con jank (peor cuanto mayor la intensity: más dips)
      var jankNow = false;
      if (jankLeft > 0) { jankLeft -= 1; jankNow = true; }
      else if (rnd() < 0.05 * load * intensity) {
        jankLeft = 1 + Math.floor(rnd() * 3);
        jankDepth = 8 + rnd() * 16;
        jankNow = true;
      }
      var fpsTarget = jankNow ? phase.fps - jankDepth : phase.fps;
      fps = clamp(drift(fps, fpsTarget, 0.55, 1.2, rnd), 34, 60);

      // RAM: crece con load*intensity; GC drop periódico
      var gcNow = false;
      mem.java += (0.5 + rnd() * 2.5) * load * intensity;
      mem.native += (0.1 + rnd() * 0.8) * load * intensity;
      mem.graphics = clamp(drift(mem.graphics, 300 + gpu * 2.2, 0.15, 6, rnd), 260, 660);
      mem.other = clamp(drift(mem.other, 130 + load * 40, 0.1, 3, rnd), 100, 230);
      mem.code = clamp(mem.code + (rnd() - 0.5) * 0.6, 200, 240);
      mem.stack = clamp(mem.stack + (rnd() - 0.5) * 0.3, 20, 30);
      gcCooldown -= 1;
      if (gcCooldown <= 0 || mem.java > 980 * intensity) {
        mem.java -= mem.java * (0.12 + rnd() * 0.16);
        mem.native -= mem.native * (0.01 + rnd() * 0.03);
        gcCooldown = 18 + Math.floor(rnd() * 22);
        gcNow = true;
      }
      mem.java = clamp(mem.java, 320, 1100 * intensity);
      mem.native = clamp(mem.native, 500, 1500);

      // Temperatura del SoC: techo depende de load*intensity; sesgo de sesión que no baja
      var tempCeil = 33 + 11 * load * intensity;
      var heatRate = load > 0.4 ? 0.012 : 0.03;
      temp = clamp(drift(temp, Math.max(tempCeil, temp - 0.5), heatRate, 0.06, rnd), 30, 47);
      temp = Math.max(temp, 30 + Math.min(t * 0.012 * intensity, 12));
      temp = clamp(temp, 30, 47);

      // Batería: mA de descarga escala con load*intensity; drena el nivel; temp de batería
      // sigue a la del SoC pero más suave y más baja.
      var mA = (280 + load * 620) * intensity + (rnd() - 0.5) * 40; // 280–900+ mA
      mA = clamp(mA, 180, 1400);
      // 1 seg de mA sobre capacidad → % drenado. cap 3400 mAh → 1 mAh = 1/3400*100 %.
      var drainThisSec = (mA / 3600) / DEVICE.batteryCapacityMah * 100;
      battLevel = clamp(battLevel - drainThisSec, 0, 100);
      battTemp = clamp(drift(battTemp, 26 + (temp - 30) * 0.7 + intensity * 1.5, 0.03, 0.05, rnd), 26, 43);

      // Red: baseline + bursts en loading
      var rx, tx;
      if (phase.netHeavy) { rx = 250 + rnd() * 650; tx = 20 + rnd() * 70; }
      else { rx = 4 + rnd() * 34; tx = 1 + rnd() * 11; }
      rxTotal += rx; txTotal += tx;

      series.push({
        t: t,
        ts: t0 + t * 1000,
        phase: phase.name,
        cpu: cpu,
        gpu: gpu,
        fps: fps,
        tempC: temp,
        ramMb: pss(),
        mem: { java: mem.java, native: mem.native, graphics: mem.graphics, code: mem.code, stack: mem.stack, other: mem.other },
        battery: { level: battLevel, tempC: battTemp, mA: mA },
        netRxKb: rx, netTxKb: tx, rxTotalKb: rxTotal, txTotalKb: txTotal,
        gc: gcNow, jank: jankNow,
      });
    }

    var summary = summarize(series);
    return {
      id: cfg.id,
      app: 'Evermore Arcade',
      bundleId: cfg.bundleId,
      label: cfg.label,
      device: DEVICE,
      startedAt: new Date(t0).toISOString(),
      durationS: durationS,
      samplingHz: 1,
      sampleCount: series.length,
      series: series,
      summary: summary,
    };
  }

  // ---- SessionSummary: precálculo por métrica (el CONTRATO que fija este ticket) ----
  function scalarStats(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < values.length; i++) sum += values[i];
    return {
      avg: sum / values.length,
      peak: sorted[sorted.length - 1],
      min: sorted[0],
      p90: percentile(sorted, 90),
    };
  }

  function summarize(series) {
    var cpu = [], gpu = [], fps = [], tempC = [], ramMb = [], battMa = [], battTemp = [];
    var memSum = { java: 0, native: 0, graphics: 0, code: 0, stack: 0, other: 0 };
    for (var i = 0; i < series.length; i++) {
      var s = series[i];
      cpu.push(s.cpu); gpu.push(s.gpu); fps.push(s.fps);
      tempC.push(s.tempC); ramMb.push(s.ramMb);
      battMa.push(s.battery.mA); battTemp.push(s.battery.tempC);
      memSum.java += s.mem.java; memSum.native += s.mem.native; memSum.graphics += s.mem.graphics;
      memSum.code += s.mem.code; memSum.stack += s.mem.stack; memSum.other += s.mem.other;
    }
    var n = series.length;
    var memAvg = {
      java: memSum.java / n, native: memSum.native / n, graphics: memSum.graphics / n,
      code: memSum.code / n, stack: memSum.stack / n, other: memSum.other / n,
    };
    var battTempSorted = battTemp.slice().sort(function (a, b) { return a - b; });
    var battMaSum = 0;
    for (var j = 0; j < battMa.length; j++) battMaSum += battMa[j];
    var levelStart = series[0].battery.level;
    var levelEnd = series[n - 1].battery.level;

    return {
      cpu: scalarStats(cpu),
      gpu: scalarStats(gpu),
      fps: scalarStats(fps),
      tempC: scalarStats(tempC),
      ramMb: scalarStats(ramMb),
      battery: {
        levelStart: levelStart,
        levelEnd: levelEnd,
        drainPct: levelStart - levelEnd,             // > 0 siempre en una sesión activa
        avgMa: battMaSum / battMa.length,
        tempPeak: battTempSorted[battTempSorted.length - 1],
        tempAvg: battTempSorted.reduce(function (a, b) { return a + b; }, 0) / battTempSorted.length,
      },
      memAvg: memAvg, // suma ≈ ramMb.avg (invariante chequeada en smoke)
    };
  }

  // ---- Las 3 sesiones del prototipo: misma app, distinto bundle id, señal creíble ----
  function makeSessions() {
    return [
      makeSession({
        id: 'sess-qa',
        bundleId: 'com.evermore.oda.qa',
        label: 'QA build',
        seed: 1337,
        durationS: 300,
        intensity: 1.18,             // QA: debug symbols → más caliente/hambrienta/más RAM
        startEpochMs: Date.UTC(2026, 6, 16, 20, 12, 0),
      }),
      makeSession({
        id: 'sess-prod',
        bundleId: 'com.evermore.oda',
        label: 'Prod build',
        seed: 4242,
        durationS: 300,
        intensity: 0.92,             // Prod: optimizada → menos consumo
        startEpochMs: Date.UTC(2026, 6, 16, 20, 34, 0),
      }),
      makeSession({
        id: 'sess-prod-rc',
        bundleId: 'com.evermore.oda',
        label: 'Prod RC2',
        seed: 909,
        durationS: 300,
        intensity: 1.02,             // release candidate: entre las dos
        startEpochMs: Date.UTC(2026, 6, 16, 21, 3, 0),
      }),
    ];
  }

  var api = { makeSession: makeSession, makeSessions: makeSessions, summarize: summarize, DEVICE: DEVICE, PHASES: PHASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ReportFixtures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
