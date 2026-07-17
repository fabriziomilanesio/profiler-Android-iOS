/**
 * smoke.js — validación sin browser del prototipo del reporte (ticket 020).
 * Correr con: bun prototypes/report/smoke.js
 *
 * 1. fixtures.js: genera las sesiones y verifica rangos e invariantes
 *    (drainPct>0, summaries consistentes con la serie, memAvg suma el PSS avg).
 * 2. report.js / fixtures.js: chequeo sintáctico (new Function).
 * 3. report.html + vendor + assets: existencia de todo lo referenciado.
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  ok  ' + name);
  else { failures++; console.error('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

// ---- 1. fixtures: sesiones, rangos e invariantes ----
const F = require('./fixtures.js');
const sessions = F.makeSessions();

check('genera 2-3 sesiones', sessions.length >= 2 && sessions.length <= 3, `${sessions.length}`);
check('mismo device en todas (comparable)', sessions.every(s => s.device.model === sessions[0].device.model));
check('mismo sampling 1 Hz', sessions.every(s => s.samplingHz === 1));
check('hay ≥2 bundle ids distintos', new Set(sessions.map(s => s.bundleId)).size >= 2);

sessions.forEach((sess) => {
  const tag = sess.label;
  const ser = sess.series;
  const S = sess.summary;

  check(`[${tag}] serie ~5 min (270-330 samples)`, ser.length >= 270 && ser.length <= 330, `${ser.length}`);
  check(`[${tag}] sampleCount == serie.length`, sess.sampleCount === ser.length);

  // recompute stats from the series and compare with the precomputed summary
  const cpu = ser.map(x => x.cpu);
  const avgCpu = cpu.reduce((a, b) => a + b, 0) / cpu.length;
  const peakCpu = Math.max(...cpu);
  check(`[${tag}] summary.cpu.avg consistente con la serie`, approx(S.cpu.avg, avgCpu, 0.01), `${S.cpu.avg.toFixed(2)} vs ${avgCpu.toFixed(2)}`);
  check(`[${tag}] summary.cpu.peak consistente`, approx(S.cpu.peak, peakCpu, 0.01));
  check(`[${tag}] p90 ∈ [min,peak]`, S.cpu.p90 >= S.cpu.min && S.cpu.p90 <= S.cpu.peak);

  // ranges
  const rng = (arr) => [Math.min(...arr), Math.max(...arr)];
  const [tlo, thi] = rng(ser.map(x => x.tempC));
  check(`[${tag}] temp SoC ∈ [30,47] y sube`, tlo >= 30 && thi <= 47 && thi > 36, `[${tlo.toFixed(1)}, ${thi.toFixed(1)}]`);
  const [flo, fhi] = rng(ser.map(x => x.fps));
  check(`[${tag}] fps ∈ [34,60]`, flo >= 34 && fhi <= 60, `[${flo.toFixed(1)}, ${fhi.toFixed(1)}]`);
  const [glo, ghi] = rng(ser.map(x => x.gpu));
  check(`[${tag}] gpu ∈ [30,92]`, glo >= 30 && ghi <= 92, `[${glo.toFixed(1)}, ${ghi.toFixed(1)}]`);

  // battery invariants
  check(`[${tag}] batería drena (drainPct>0)`, S.battery.drainPct > 0, `${S.battery.drainPct.toFixed(2)}%`);
  check(`[${tag}] drainPct == levelStart-levelEnd`, approx(S.battery.drainPct, S.battery.levelStart - S.battery.levelEnd, 1e-6));
  check(`[${tag}] nivel batería monótono decreciente`, ser.every((x, i) => i === 0 || x.battery.level <= ser[i - 1].battery.level + 1e-6));
  check(`[${tag}] avgMa > 0 y en rango [180,1400]`, S.battery.avgMa > 0 && S.battery.avgMa <= 1400, `${S.battery.avgMa.toFixed(0)} mA`);
  check(`[${tag}] battery.tempPeak consistente con la serie`, approx(S.battery.tempPeak, Math.max(...ser.map(x => x.battery.tempC)), 0.01));

  // memory: cada sample suma el PSS, y el memAvg suma el ramMb.avg
  const perSampleOk = ser.every(x => approx(x.mem.java + x.mem.native + x.mem.graphics + x.mem.code + x.mem.stack + x.mem.other, x.ramMb, 0.01));
  check(`[${tag}] cada sample: mem suma el PSS`, perSampleOk);
  const memAvgSum = S.memAvg.java + S.memAvg.native + S.memAvg.graphics + S.memAvg.code + S.memAvg.stack + S.memAvg.other;
  check(`[${tag}] memAvg suma el ramMb.avg`, approx(memAvgSum, S.ramMb.avg, 0.05), `${memAvgSum.toFixed(1)} vs ${S.ramMb.avg.toFixed(1)}`);
});

// ---- señal de comparación: qa consume más que prod ----
const qa = sessions.find(s => s.bundleId.endsWith('.qa'));
const prod = sessions.find(s => s.bundleId === 'com.evermore.oda');
check('qa drena más batería que prod', qa.summary.battery.drainPct > prod.summary.battery.drainPct,
  `qa ${qa.summary.battery.drainPct.toFixed(2)}% vs prod ${prod.summary.battery.drainPct.toFixed(2)}%`);
check('qa más caliente (temp peak) que prod', qa.summary.tempC.peak > prod.summary.tempC.peak,
  `qa ${qa.summary.tempC.peak.toFixed(1)} vs prod ${prod.summary.tempC.peak.toFixed(1)}`);
check('qa usa más RAM avg que prod', qa.summary.ramMb.avg > prod.summary.ramMb.avg,
  `qa ${qa.summary.ramMb.avg.toFixed(0)} vs prod ${prod.summary.ramMb.avg.toFixed(0)} MB`);

// ---- determinismo: dos generaciones dan lo mismo ----
const again = F.makeSessions();
check('generación determinística (drainPct estable)',
  approx(again[0].summary.battery.drainPct, sessions[0].summary.battery.drainPct, 1e-9));

// ---- 2. sintaxis de report.js / fixtures.js (parse, no ejecutar sin DOM) ----
for (const f of ['report.js', 'fixtures.js']) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  let ok = true, err = '';
  try { new Function(src); } catch (e) { ok = false; err = String(e); }
  check(`${f} parsea sin errores de sintaxis`, ok, err);
}

// ---- 3. artefactos referenciados por report.html ----
const html = fs.readFileSync(path.join(DIR, 'report.html'), 'utf8');
const refs = [
  'vendor/echarts.min.js', 'fixtures.js', 'report.js',
  'assets/evermore-logo.png', 'assets/odaclick-dog.png', 'assets/evermore-appicon.png',
  'vendor/fonts/baloo-2-latin-800-normal.woff2', 'vendor/fonts/inter-latin-400-normal.woff2',
];
for (const r of refs) {
  check(`report.html referencia ${r}`, html.includes(r));
  check(`existe ${r}`, fs.existsSync(path.join(DIR, r)));
}
const echartsSrc = fs.readFileSync(path.join(DIR, 'vendor/echarts.min.js'), 'utf8');
check('vendor/echarts.min.js es ECharts real (>500 KB)', echartsSrc.length > 500_000 && echartsSrc.includes('echarts'));

// container ids report.js espera
for (const id of ['sessSel', 'devSpecs', 'sesFacts', 'metricCards', 'memPie', 'timeline',
  'modeToggle', 'themeToggle', 'viewSingle', 'viewCompare', 'cmpBanner', 'cmpTable', 'cmpBars',
  'cmpTimeline', 'cmpMetricSwitch']) {
  check(`report.html tiene #${id}`, html.includes(`id="${id}"`));
}

// ---- 4. contrato del reporte: modos, batería, comparabilidad ----
check('light theme es default', html.includes('data-theme="light"'));
check('tiene toggle de modo 1 sesión / comparar', html.includes('data-mode="single"') && html.includes('data-mode="compare"'));
check('branding evermore grande', html.includes('assets/evermore-logo.png'));
check('perro Odaclick chico', html.includes('assets/odaclick-dog.png'));
const js = fs.readFileSync(path.join(DIR, 'report.js'), 'utf8');
check('report.js: tarjeta de batería (drainPct)', js.includes('drainPct'));
check('report.js: mA promedio en la ficha', js.includes('avgMa'));
check('report.js: banner comparable ✓ + rama roja para device distinto', js.includes('checkComparable') && js.includes("classList.add('warn')"));
check('report.js: dirección better/worse coloreada', js.includes("'better'") && js.includes("'worse'") && js.includes('betterWhen'));
check('report.html: banner "comparable"', html.includes('Comparable'));

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
