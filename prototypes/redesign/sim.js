/**
 * sim.js — simulador de sesión para el prototipo del REDISEÑO (ticket 031).
 * DESCARTABLE. Evolución del sim del 007: además de las métricas clásicas emite
 * frame-time p50/p90/p99 + jank% (024), battery/deviceCpu/deviceRamUsedMb, un
 * stream de logs estilo logcat (027/028) y una historia guionada:
 *
 *   - t≈40–58 s  caída de FPS a ~26 (target 60 ⇒ semáforo ROJO en acción)
 *   - t≈80 s     CRASH sintético: bloque FATAL EXCEPTION en logs, la app muere
 *                ~6 s (samples null, badge "esperando proceso…") y renace
 *   - la historia se repite cada ~150 s para sesiones largas de demo
 *
 * Corre en browser (global `RedesignSim`) y en Bun/Node (module.exports) para smoke.
 */
;(function (global) {
  'use strict'

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v))
  }
  function rand(lo, hi) {
    return lo + Math.random() * (hi - lo)
  }
  function irand(lo, hi) {
    return Math.round(rand(lo, hi))
  }
  function drift(cur, target, rate, noise) {
    return cur + (target - cur) * rate + rand(-noise, noise)
  }

  // Juego que apunta a 60 FPS (el target default del prototipo es 60 para que el
  // semáforo muestre los 3 estados; en la app real el default sigue siendo 30).
  var PHASES = [
    { name: 'menu', dur: [8, 14], cpu: 24, gpu: 30, fps: 60, load: 0.25 },
    { name: 'loading', dur: [4, 7], cpu: 58, gpu: 36, fps: 52, load: 0.7, netHeavy: true },
    { name: 'gameplay', dur: [22, 40], cpu: 42, gpu: 56, fps: 58, load: 0.55 },
    { name: 'combat', dur: [10, 20], cpu: 60, gpu: 72, fps: 50, load: 0.95 },
  ]

  // Guion (relativo al inicio de cada ciclo de STORY_PERIOD segundos)
  var STORY_PERIOD = 150
  var DROP_AT = 40
  var DROP_DUR = 18
  var CRASH_AT = 80
  var DEAD_TICKS = 6

  var PID_BASE = 12000

  // ---- generador de logs estilo logcat de una app Unity ----
  var INFO_MSGS = [
    ['Unity', 'Loading scene "Arcade_Main" (additive)'],
    ['Unity', 'SpawnManager: wave 3 spawned (12 enemies)'],
    ['Unity', 'SaveSystem: profile synced ok (142 ms)'],
    ['ActivityManager', 'Displayed com.sample.oda.qa/.MainActivity'],
    ['Unity', 'AudioBank "combat_a" loaded'],
    ['NetworkManager', 'Heartbeat ok rtt=84ms'],
    ['Unity', 'ObjectPool: recycled 48 projectiles'],
  ]
  var DEBUG_MSGS = [
    ['Unity', 'FSM: enemy#31 Idle -> Chase'],
    ['Unity', 'Anim: blend combat_idle -> attack_02 (0.12s)'],
    ['libEGL', 'eglSwapBuffers ok'],
    ['Unity', 'GC.Collect scheduled (heap pressure)'],
  ]
  var WARN_MSGS = [
    ['Unity', 'Audio: voice limit reached, stealing oldest voice'],
    ['Adreno-GSL', 'gsl_ldd_control: cache hint ignored'],
    ['Unity', 'Texture "boss_atlas" not in memory budget, streaming mips'],
    ['Choreographer', 'Skipped 4 frames! The application may be doing too much work.'],
  ]
  var ERROR_MSGS = [
    ['Unity', 'NullReferenceException (caught): EnemyController.OnHit — enemy already pooled'],
    ['Unity', 'Shader "Sample/Water" not supported on this GPU, using fallback'],
  ]
  var CRASH_BLOCK = [
    'FATAL EXCEPTION: main',
    'Process: com.sample.oda.qa, PID: {pid}',
    'java.lang.Error: FATAL EXCEPTION [UnityMain]',
    'Caused by: java.lang.NullPointerException: combat queue drained while resolving hit',
    '  at com.sample.oda.combat.EngageQueue.resolve(EngageQueue.java:211)',
    '  at com.unity3d.player.UnityPlayer.nativeRender(Native Method)',
    '  at com.unity3d.player.UnityPlayer$e$1.handleMessage(UnityPlayer.java:118)',
    '  at android.os.Handler.dispatchMessage(Handler.java:103)',
  ]

  function createSession() {
    var t = 0
    var phase = PHASES[0]
    var phaseLeft = irand(phase.dur[0], phase.dur[1])
    var pid = PID_BASE + irand(1, 900)
    var deadLeft = 0 // ticks restantes con la app muerta
    var relaunchAnnounced = true

    var cpu = 22,
      gpu = 30,
      fps = 60,
      temp = 32.0
    var deviceCpu = 34
    var deviceRam = 3900
    var battery = 86
    var charging = false
    var chargeFlip = irand(60, 100)
    var mem = { java: 420, native: 610, graphics: 360, code: 210, stack: 24, other: 130 }
    var gcCooldown = irand(18, 35)
    var jankLeft = 0,
      jankDepth = 0
    var burstLeft = 0,
      burstRx = 0,
      burstTx = 0
    var rxTotal = 0,
      txTotal = 0

    function pss() {
      return mem.java + mem.native + mem.graphics + mem.code + mem.stack + mem.other
    }
    function nextPhase() {
      var candidates = PHASES.filter(function (p) {
        return p.name !== phase.name
      })
      phase = candidates[irand(0, candidates.length - 1)]
      phaseLeft = irand(phase.dur[0], phase.dur[1])
    }

    function pick(pool) {
      return pool[irand(0, pool.length - 1)]
    }
    function entry(now, level, tag, message, isCrash) {
      return {
        ts: now,
        level: level,
        tag: tag,
        message: message,
        pid: pid,
        isCrash: isCrash === true,
      }
    }

    function makeLogs(now, storyT, load) {
      var logs = []
      if (deadLeft > 0) return logs // app muerta: silencio (como la captura real)
      if (storyT === CRASH_AT) {
        // bloque de crash completo, mismo ts (bloque = gap ≤ 2 s, ticket 030)
        CRASH_BLOCK.forEach(function (line) {
          logs.push(entry(now, 'F', 'AndroidRuntime', line.replace('{pid}', String(pid)), true))
        })
        return logs
      }
      // ritmo base: 1–3 líneas por segundo, más denso con load alto
      var n = irand(1, load > 0.6 ? 3 : 2)
      for (var i = 0; i < n; i++) {
        var r = Math.random()
        var m
        if (r < 0.06) {
          m = pick(ERROR_MSGS)
          logs.push(entry(now + i * 90, 'E', m[0], m[1]))
        } else if (r < 0.2 + load * 0.1) {
          m = pick(WARN_MSGS)
          logs.push(entry(now + i * 90, 'W', m[0], m[1]))
        } else if (r < 0.55) {
          m = pick(DEBUG_MSGS)
          logs.push(entry(now + i * 90, 'D', m[0], m[1]))
        } else {
          m = pick(INFO_MSGS)
          logs.push(entry(now + i * 90, 'I', m[0], m[1]))
        }
      }
      return logs
    }

    function tick(nowOverride) {
      t += 1
      var now = typeof nowOverride === 'number' ? nowOverride : Date.now()
      var storyT = t % STORY_PERIOD

      // ---- muerte / renacimiento (crash guionado) ----
      // los logs se generan ANTES de marcar la muerte: el bloque FATAL del
      // crash stream llega junto con el último tick vivo (como en el 027)
      var logs = makeLogs(now, storyT, phase.load)
      if (storyT === CRASH_AT) {
        deadLeft = DEAD_TICKS
        relaunchAnnounced = false
      }

      if (deadLeft > 0) {
        deadLeft -= 1
        var reborn = deadLeft === 0
        if (reborn) {
          pid = PID_BASE + irand(1, 900)
          // el proceso nuevo arranca "frío"
          cpu = 30
          gpu = 20
          fps = 48
          mem.java = 380
          mem.native = 560
          mem.graphics = 300
          logs.push(entry(now, 'I', 'ActivityManager', 'Start proc ' + pid + ':com.sample.oda.qa'))
          logs.push(entry(now, 'I', 'Unity', 'UnityMain restarted, loading last checkpoint'))
        }
        return {
          ts: now,
          t: t,
          phase: phase.name,
          appAlive: reborn,
          relaunched: reborn,
          cpu: null,
          gpu: null,
          fps: null,
          frame: { p50Ms: null, p90Ms: null, p99Ms: null, jankPct: null },
          tempC: temp,
          mem: null,
          battery: { levelPct: battery, charging: charging },
          netRxKb: null,
          netTxKb: null,
          rxTotalKb: rxTotal,
          txTotalKb: txTotal,
          deviceCpu: clamp(drift(deviceCpu, 26, 0.3, 2), 8, 95),
          deviceRamUsedMb: deviceRam,
          gc: false,
          logs: logs,
          pid: null,
        }
      }

      if (--phaseLeft <= 0) nextPhase()
      var load = phase.load

      // ---- caída de FPS guionada (semáforo rojo) ----
      var scripted = storyT >= DROP_AT && storyT < DROP_AT + DROP_DUR
      var fpsGoal = phase.fps
      if (scripted) {
        // bajón térmico/combate: fps se hunde bien abajo del 80% del target
        fpsGoal = 26
        load = 1.0
      }

      cpu = clamp(drift(cpu, scripted ? 72 : phase.cpu, 0.25, 3.5), 15, 88)
      gpu = clamp(drift(gpu, scripted ? 88 : phase.gpu, 0.3, 4.0), 18, 97)
      deviceCpu = clamp(drift(deviceCpu, cpu + rand(8, 18), 0.3, 2.5), 10, 98)
      deviceRam = clamp(drift(deviceRam, 3800 + load * 500, 0.1, 30), 3400, 5200)

      var jankNow = false
      if (jankLeft > 0) {
        jankLeft -= 1
        jankNow = true
      } else if (Math.random() < 0.05 * load) {
        jankLeft = irand(1, 3)
        jankDepth = rand(8, 16)
        jankNow = true
      }
      var fpsTarget = jankNow ? fpsGoal - jankDepth : fpsGoal
      fps = clamp(drift(fps, fpsTarget, 0.55, 1.2), 18, 61)

      // ---- frame-time derivado del FPS (histograma present2present simulado) ----
      var p50 = 1000 / fps
      var stress = scripted ? rand(1.9, 2.6) : jankNow ? rand(1.5, 1.9) : rand(1.05, 1.25)
      var p90 = p50 * stress
      var p99 = p90 * rand(1.25, 1.8)
      var jankPct = scripted
        ? rand(18, 34)
        : jankNow
          ? rand(6, 14)
          : clamp(rand(-0.5, 2.2), 0, 2.2)

      // ---- memoria ----
      var gcNow = false
      mem.java += rand(0.5, 3.0) * load
      mem.native += rand(0.1, 0.9) * load
      mem.graphics = clamp(drift(mem.graphics, 300 + gpu * 2.2, 0.15, 6), 260, 640)
      mem.other = clamp(drift(mem.other, 130 + load * 40, 0.1, 3), 100, 220)
      mem.code = clamp(mem.code + rand(-0.3, 0.35), 200, 240)
      mem.stack = clamp(mem.stack + rand(-0.15, 0.15), 20, 30)
      gcCooldown -= 1
      if (gcCooldown <= 0 || mem.java > 980) {
        mem.java -= mem.java * rand(0.12, 0.28)
        mem.native -= mem.native * rand(0.01, 0.04)
        gcCooldown = irand(18, 40)
        gcNow = true
      }
      mem.java = clamp(mem.java, 320, 1000)
      mem.native = clamp(mem.native, 500, 1400)

      // ---- temperatura ----
      var tempCeil = 33 + 11 * load
      var heatRate = load > 0.4 ? 0.012 : 0.03
      temp = clamp(drift(temp, Math.max(tempCeil, temp - 0.5), heatRate, 0.06), 32, 44.5)
      temp = Math.max(temp, 32 + Math.min(t * 0.011, 10.5))

      // ---- batería ----
      chargeFlip -= 1
      if (chargeFlip <= 0) {
        charging = !charging
        chargeFlip = charging ? irand(18, 30) : irand(70, 110)
      }
      battery = clamp(battery + (charging ? rand(0.15, 0.4) : -rand(0.02, 0.09)), 5, 100)

      // ---- red ----
      var rx, tx
      if (burstLeft > 0) {
        burstLeft -= 1
        rx = burstRx * rand(0.7, 1.15)
        tx = burstTx * rand(0.6, 1.2)
      } else {
        if (phase.netHeavy || Math.random() < 0.035) {
          burstLeft = irand(2, 4)
          burstRx = rand(250, 900)
          burstTx = rand(20, 90)
        }
        rx = rand(4, 38)
        tx = rand(1, 12)
      }
      rxTotal += rx
      txTotal += tx

      var m = pss()
      return {
        ts: now,
        t: t,
        phase: phase.name,
        appAlive: true,
        relaunched: false,
        cpu: cpu,
        gpu: gpu,
        fps: fps,
        frame: { p50Ms: p50, p90Ms: p90, p99Ms: p99, jankPct: jankPct },
        tempC: temp,
        mem: {
          java: mem.java,
          native: mem.native,
          graphics: mem.graphics,
          code: mem.code,
          stack: mem.stack,
          other: mem.other,
          pss: m,
          rss: m * rand(1.12, 1.18),
        },
        battery: { levelPct: battery, charging: charging },
        netRxKb: rx,
        netTxKb: tx,
        rxTotalKb: rxTotal,
        txTotalKb: txTotal,
        deviceCpu: deviceCpu,
        deviceRamUsedMb: deviceRam + m,
        gc: gcNow,
        logs: logs,
        pid: pid,
      }
    }

    return { tick: tick }
  }

  // Flows fake para el Network Inspector (cuando se prende el toggle)
  var FLOW_HOSTS = [
    ['GET', 'https', 'api.sample.games', '/v2/session/heartbeat', 200, 1200],
    ['POST', 'https', 'analytics.generic.com', '/collect', 204, 860],
    ['GET', 'https', 'cdn.sample.games', '/banks/combat_a.bank', 200, 412000],
    ['GET', 'http', 'config.sample.games', 'http://config.sample.games/remote/flags.json', 200, 2300],
    ['POST', 'https', 'api.sample.games', '/v2/score', 200, 640],
    ['GET', 'https', 'firebase.googleapis.com', '/v1/projects/sample-qa', 200, 5100],
  ]
  function fakeFlow() {
    var f = FLOW_HOSTS[irand(0, FLOW_HOSTS.length - 1)]
    var fail = Math.random() < 0.07
    return {
      ts: Date.now(),
      method: f[0],
      kind: f[1],
      host: f[2],
      url: f[3],
      status: fail ? 0 : f[4],
      bytes: Math.round(f[5] * rand(0.7, 1.3)),
    }
  }

  var api = { createSession: createSession, fakeFlow: fakeFlow, STORY_PERIOD: STORY_PERIOD }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  global.RedesignSim = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
