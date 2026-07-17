/**
 * smoke.js — validación sin browser del prototipo (ticket 007).
 * Correr con: bun prototypes/dashboard/smoke.js
 *
 * 1. sim.js: corre 600 ticks (10 min de sesión fake) y verifica rangos/invariantes.
 * 2. app.js / sim.js: chequeo sintáctico (new Function).
 * 3. index.html + vendor: existencia de echarts, fuentes y logos referenciados.
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  ok  ' + name);
  else { failures++; console.error('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

// ---- 1. simulador: rangos e invariantes en 600 ticks ----
const { createSession } = require('./sim.js');
const s = createSession();
let gcSeen = 0, jankSeen = 0, burstSeen = 0;
let minCpu = 1e9, maxCpu = -1e9, minFps = 1e9, maxFps = -1e9;
let minTemp = 1e9, maxTemp = -1e9, minGpu = 1e9, maxGpu = -1e9;
let lastRxTotal = 0, lastTxTotal = 0, ramStart = 0, ramPeak = 0;
let memSumOk = true, netMonotonic = true;
let prevRam = 0, growRun = 0, maxGrowRun = 0; // serrucho: crece sostenido entre GCs

for (let i = 0; i < 600; i++) {
  const x = s.tick();
  minCpu = Math.min(minCpu, x.cpu); maxCpu = Math.max(maxCpu, x.cpu);
  minGpu = Math.min(minGpu, x.gpu); maxGpu = Math.max(maxGpu, x.gpu);
  minFps = Math.min(minFps, x.fps); maxFps = Math.max(maxFps, x.fps);
  minTemp = Math.min(minTemp, x.tempC); maxTemp = Math.max(maxTemp, x.tempC);
  if (x.gc) gcSeen++;
  if (x.jank) jankSeen++;
  if (x.netRxKb > 200) burstSeen++;
  if (x.rxTotalKb < lastRxTotal || x.txTotalKb < lastTxTotal) netMonotonic = false;
  lastRxTotal = x.rxTotalKb; lastTxTotal = x.txTotalKb;
  const sum = x.mem.java + x.mem.native + x.mem.graphics + x.mem.code + x.mem.stack + x.mem.other;
  if (Math.abs(sum - x.ramMb) > 0.01) memSumOk = false;
  if (i === 0) ramStart = x.ramMb;
  ramPeak = Math.max(ramPeak, x.ramMb);
  if (x.ramMb > prevRam) { growRun++; maxGrowRun = Math.max(maxGrowRun, growRun); }
  else growRun = 0;
  prevRam = x.ramMb;
}

check('CPU en [20,70]', minCpu >= 20 && maxCpu <= 70, `[${minCpu.toFixed(1)}, ${maxCpu.toFixed(1)}]`);
check('CPU varía (rango > 15pts)', maxCpu - minCpu > 15, `${(maxCpu - minCpu).toFixed(1)}`);
check('GPU en [30,80]', minGpu >= 30 && maxGpu <= 80, `[${minGpu.toFixed(1)}, ${maxGpu.toFixed(1)}]`);
check('FPS en [40,60]', minFps >= 40 && maxFps <= 60, `[${minFps.toFixed(1)}, ${maxFps.toFixed(1)}]`);
check('hubo dips de jank', jankSeen > 3, `${jankSeen} ticks con jank`);
check('temp en [32,44] y sube', minTemp >= 32 && maxTemp <= 44 && maxTemp > 36,
      `[${minTemp.toFixed(1)}, ${maxTemp.toFixed(1)}]`);
check('RAM en serrucho: crece sostenido entre GCs', maxGrowRun >= 8, `run máximo ${maxGrowRun} ticks`);
check('RAM tiene pico visible sobre el inicio', ramPeak > ramStart + 80, `${ramStart.toFixed(0)} → pico ${ramPeak.toFixed(0)} MB`);
check('hubo GC drops', gcSeen > 5, `${gcSeen} GCs`);
check('composición de memoria suma el PSS', memSumOk);
check('hubo bursts de red (>200 KB/s)', burstSeen > 3, `${burstSeen} ticks`);
check('acumulados de red monótonos', netMonotonic);

// ---- 2. sintaxis de app.js (no se puede ejecutar sin DOM, solo parsear) ----
for (const f of ['app.js', 'sim.js']) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  let ok = true, err = '';
  try { new Function(src); } catch (e) { ok = false; err = String(e); }
  check(`${f} parsea sin errores de sintaxis`, ok, err);
}

// ---- 3. artefactos referenciados por index.html ----
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const refs = [
  'vendor/echarts.min.js', 'sim.js', 'app.js',
  'assets/evermore-logo.png', 'assets/odaclick-dog.png', 'assets/evermore-appicon.png',
  'vendor/fonts/baloo-2-latin-800-normal.woff2', 'vendor/fonts/inter-latin-400-normal.woff2',
];
for (const r of refs) {
  check(`index.html referencia ${r}`, html.includes(r));
  check(`existe ${r}`, fs.existsSync(path.join(DIR, r)));
}
const echartsSrc = fs.readFileSync(path.join(DIR, 'vendor/echarts.min.js'), 'utf8');
check('vendor/echarts.min.js es ECharts real (>500 KB)', echartsSrc.length > 500_000 && echartsSrc.includes('echarts'));
// ids de contenedores que app.js espera (gFps ya no existe: FPS vive dentro del donut de GPU)
for (const id of ['gCpu', 'gGpu', 'gTemp', 'gRam', 'memPie', 'timeline', 'netSpark', 'recBadge', 'recTime', 'appSel', 'themeToggle']) {
  check(`index.html tiene #${id}`, html.includes(`id="${id}"`));
}
check('index.html NO tiene #gFps (FPS unificado en el donut de GPU)', !html.includes('id="gFps"'));

// ---- 4. feedback humano 2026-07-17: UI en inglés, light default, GPU·FPS unificado ----
check('light theme es default', html.includes('data-theme="light"'));
check('UI en inglés: label "Profiled app"', html.includes('Profiled app'));
check('UI en inglés: card "GPU · FPS"', html.includes('GPU · FPS'));
check('UI en inglés: "Memory composition"', html.includes('Memory composition'));
check('UI en inglés: "Live timeline"', html.includes('Live timeline'));
check('UI en inglés: footer "Disposable prototype"', html.includes('Disposable prototype'));
check('UI en inglés: no queda texto es de UI', !/App perfilada|acumulado|Composición|ventana deslizante/.test(html));
const appSrc = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
check('app.js: PAUSED (no PAUSA)', appSrc.includes("'PAUSED'") && !appSrc.includes("'PAUSA'"));
check('app.js: totales en inglés ("total ")', appSrc.includes("'total '") && !appSrc.includes("'acumulado '"));
check('app.js: light default', appSrc.includes("var theme = 'light'"));
check('app.js: FPS sin umbrales (no bandsInv)', !appSrc.includes('bandsInv'));

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
