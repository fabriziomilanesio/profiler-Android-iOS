/**
 * smoke.js — validación sin browser del prototipo del rediseño (ticket 031).
 * Uso: bun prototypes/redesign/smoke.js
 * Chequea: sintaxis de los JS, invariantes del simulador en 600 ticks (rangos,
 * percentiles ordenados, crash + logs guionados, muerte/renacimiento) y que los
 * assets referenciados por index.html existan.
 */
const { readFileSync, existsSync } = require('fs')
const { join } = require('path')

const DIR = __dirname
let checks = 0
let failed = 0
function ok(cond, label) {
  checks++
  if (!cond) {
    failed++
    console.error('  ✗ ' + label)
  }
}

// ---- 1. sintaxis ----
for (const f of ['sim.js', 'app.js']) {
  try {
    new Function(readFileSync(join(DIR, f), 'utf8'))
    ok(true, f + ' parses')
  } catch (e) {
    ok(false, f + ' parses: ' + e.message)
  }
}

// ---- 2. sim invariants (600 ticks = 4 ciclos de historia) ----
const sim = require(join(DIR, 'sim.js'))
const s = sim.createSession()
let crashBlocks = 0
let deadTicks = 0
let reborn = 0
let redSeen = false
let logsSeen = 0
let lastAlive = true
const t0 = Date.now() - 600000
for (let i = 0; i < 600; i++) {
  const x = s.tick(t0 + i * 1000)
  logsSeen += (x.logs || []).length
  if (x.logs && x.logs.some((l) => l.isCrash)) crashBlocks++
  if (x.cpu === null) {
    // tick con la app muerta (o el tick de renacimiento): métricas en null
    if (x.appAlive === false) deadTicks++
    ok(x.fps === null && x.mem === null, 'dead tick has null metrics (t=' + x.t + ')')
    if (x.relaunched && !lastAlive) reborn++
    if (failed) break
  } else {
    ok(x.cpu >= 0 && x.cpu <= 100, 'cpu in range')
    ok(x.gpu >= 0 && x.gpu <= 100, 'gpu in range')
    ok(x.fps >= 10 && x.fps <= 61, 'fps in range')
    ok(x.tempC >= 25 && x.tempC <= 50, 'temp in range')
    const fr = x.frame
    ok(fr.p50Ms <= fr.p90Ms && fr.p90Ms <= fr.p99Ms, 'frame percentiles ordered')
    ok(fr.jankPct >= 0 && fr.jankPct <= 100, 'jank in range')
    ok(x.mem.pss > 0 && x.mem.rss > x.mem.pss, 'pss/rss sane')
    if (x.fps < 60 * 0.8) redSeen = true
  }
  lastAlive = x.appAlive !== false
  if (failed > 5) break
}
ok(crashBlocks >= 3, 'scripted crash block emitted per cycle (' + crashBlocks + ')')
ok(deadTicks >= 12, 'app dies after each crash (' + deadTicks + ' dead ticks)')
ok(reborn >= 3, 'app relaunches after death (' + reborn + ')')
ok(redSeen, 'scripted FPS drop reaches red semaphore territory')
ok(logsSeen > 400, 'log stream flows (' + logsSeen + ' entries)')

// ---- 3. assets referenciados ----
const html = readFileSync(join(DIR, 'index.html'), 'utf8')
for (const m of html.matchAll(/(?:src|href)="((?:assets|vendor)\/[^"]+)"/g)) {
  ok(existsSync(join(DIR, m[1])), 'asset exists: ' + m[1])
}
for (const m of html.matchAll(/url\('(vendor\/[^']+)'\)/g)) {
  ok(existsSync(join(DIR, m[1])), 'font exists: ' + m[1])
}
ok(html.includes('data-theme="dark"'), 'dark theme is the default')
ok(/lang="en"/.test(html), 'UI is english (lang=en)')

if (failed) {
  console.error('SMOKE FAIL — ' + failed + '/' + checks + ' checks failed')
  process.exit(1)
}
console.log('SMOKE PASS (' + checks + ' checks)')
