/**
 * sim.js — generador de datos fake para el prototipo del dashboard (ticket 007).
 * DESCARTABLE. Simula una sesión de juego a 1 Hz con fases (menu/loading/gameplay/combat),
 * jank de FPS, GC drops de RAM, temperatura subiendo lento y bursts de red.
 *
 * Funciona en browser (global `ProfilerSim`) y en Bun/Node (`module.exports`) para el smoke test.
 */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function irand(lo, hi) { return Math.round(rand(lo, hi)); }
  // lerp con ruido: se acerca al target y tiembla un poco (variación creíble, no random puro)
  function drift(cur, target, rate, noise) {
    return cur + (target - cur) * rate + rand(-noise, noise);
  }

  // Fases de una sesión de juego típica. load ∈ [0,1] escala calor/GC/jank.
  var PHASES = [
    { name: 'menu',     dur: [8, 14],  cpu: 26, gpu: 34, fps: 60, load: 0.25 },
    { name: 'loading',  dur: [4, 7],   cpu: 62, gpu: 38, fps: 47, load: 0.70, netHeavy: true },
    { name: 'gameplay', dur: [22, 40], cpu: 44, gpu: 58, fps: 58, load: 0.55 },
    { name: 'combat',   dur: [10, 20], cpu: 63, gpu: 74, fps: 52, load: 0.95 },
  ];

  function createSession() {
    var t = 0;
    var phase = PHASES[0];
    var phaseLeft = irand(phase.dur[0], phase.dur[1]);

    // métricas
    var cpu = 24, gpu = 32, fps = 60, temp = 32.0;
    // memoria (MB) por componente — suman el PSS
    var mem = { java: 420, native: 610, graphics: 360, code: 210, stack: 24, other: 130 };
    var gcCooldown = irand(18, 35);
    var jankLeft = 0, jankDepth = 0;
    // red
    var burstLeft = 0, burstRx = 0, burstTx = 0;
    var rxTotal = 0, txTotal = 0;

    function pss() {
      return mem.java + mem.native + mem.graphics + mem.code + mem.stack + mem.other;
    }

    function nextPhase() {
      var candidates = PHASES.filter(function (p) { return p.name !== phase.name; });
      phase = candidates[irand(0, candidates.length - 1)];
      phaseLeft = irand(phase.dur[0], phase.dur[1]);
    }

    function tick() {
      t += 1;
      if (--phaseLeft <= 0) nextPhase();
      var load = phase.load;

      // --- CPU / GPU: drift hacia el target de la fase, acotado 20–70 / 30–80
      cpu = clamp(drift(cpu, phase.cpu, 0.25, 3.5), 20, 70);
      gpu = clamp(drift(gpu, phase.gpu, 0.25, 4.0), 30, 80);

      // --- FPS: cerca del target, con episodios de jank (dips de 1–3 s)
      var gcNow = false;
      var jankNow = false;
      if (jankLeft > 0) {
        jankLeft -= 1;
        jankNow = true;
      } else if (Math.random() < 0.05 * load) {
        jankLeft = irand(1, 3);
        jankDepth = rand(8, 16);
        jankNow = true;
      }
      var fpsTarget = jankNow ? phase.fps - jankDepth : phase.fps;
      fps = clamp(drift(fps, fpsTarget, 0.55, 1.2), 40, 60);

      // --- RAM: crece con el load; GC drop periódico sobre el java heap
      mem.java += rand(0.5, 3.0) * load;
      mem.native += rand(0.1, 0.9) * load;
      mem.graphics = clamp(drift(mem.graphics, 300 + gpu * 2.2, 0.15, 6), 260, 620);
      mem.other = clamp(drift(mem.other, 130 + load * 40, 0.1, 3), 100, 220);
      // code/stack casi constantes
      mem.code = clamp(mem.code + rand(-0.3, 0.35), 200, 240);
      mem.stack = clamp(mem.stack + rand(-0.15, 0.15), 20, 30);
      gcCooldown -= 1;
      if (gcCooldown <= 0 || mem.java > 980) {
        var freed = mem.java * rand(0.12, 0.28);
        mem.java -= freed;
        mem.native -= mem.native * rand(0.01, 0.04);
        gcCooldown = irand(18, 40);
        gcNow = true;
      }
      mem.java = clamp(mem.java, 320, 1000);
      mem.native = clamp(mem.native, 500, 1400);

      // --- Temperatura: sube lento hacia un techo que depende del load; enfría en menú
      var tempCeil = 33 + 11 * load; // combat empuja hacia ~43.5
      var heatRate = load > 0.4 ? 0.012 : 0.03; // calienta lento, enfría un toque más rápido
      temp = clamp(drift(temp, Math.max(tempCeil, temp - 0.5), heatRate, 0.06), 32, 44);
      // sesgo de sesión: nunca baja de lo que ya calentó menos ~1.5°
      temp = Math.max(temp, 32 + Math.min(t * 0.011, 10.5));
      temp = clamp(temp, 32, 44);

      // --- Red: baseline bajo + bursts (loading siempre; aleatorio si no)
      var rx, tx;
      if (burstLeft > 0) {
        burstLeft -= 1;
        rx = burstRx * rand(0.7, 1.15);
        tx = burstTx * rand(0.6, 1.2);
      } else {
        if (phase.netHeavy || Math.random() < 0.035) {
          burstLeft = irand(2, 4);
          burstRx = rand(250, 900);
          burstTx = rand(20, 90);
        }
        rx = rand(4, 38);
        tx = rand(1, 12);
      }
      rxTotal += rx;
      txTotal += tx;

      return {
        t: t,
        phase: phase.name,
        cpu: cpu,
        gpu: gpu,
        fps: fps,
        tempC: temp,
        ramMb: pss(),
        mem: {
          java: mem.java, native: mem.native, graphics: mem.graphics,
          code: mem.code, stack: mem.stack, other: mem.other,
        },
        netRxKb: rx,       // KB/s este segundo
        netTxKb: tx,
        rxTotalKb: rxTotal,
        txTotalKb: txTotal,
        gc: gcNow,
        jank: jankNow,
      };
    }

    return { tick: tick };
  }

  var api = { createSession: createSession };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ProfilerSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
