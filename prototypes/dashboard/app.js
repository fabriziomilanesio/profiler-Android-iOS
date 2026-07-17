/**
 * app.js — ECharts wiring + 1 Hz loop for the prototype (ticket 007). DISPOSABLE.
 * Color thresholds here are visual placeholders: the map says they get calibrated
 * with real evermore sessions, not a priori.
 *
 * Human feedback applied (2026-07-17):
 *  - All UI text in English.
 *  - GPU and FPS merged into ONE donut: the ring is GPU% (thresholded), FPS is a
 *    plain number under it — no thresholds/colors for FPS, it's data-only.
 *  - Light theme is the default; a header toggle switches to the dark brand theme.
 *    Charts are fully rebuilt on toggle so axes/tooltips/texts recolor.
 */
(function () {
  'use strict';

  // ---------- theme palettes (brand accents stay: #EB008B / #00E6DA) ----------
  var PALETTES = {
    light: {
      bg: '#F4F4F9', card: '#FFFFFF', card2: '#FBFBFE',
      primary: '#EB008B', secondary: '#009E96',
      text: '#1C1C28', muted: '#66667A', line: '#E2E2EC',
      ok: '#0FA968', warn: '#E08A00', bad: '#E11D48',
      violet: '#7C5CE0', amber: '#D98A00',
      track: '#ECECF4', split: 'rgba(28,28,40,.09)', legendOff: '#C4C4D2',
      rxArea: 'rgba(0,158,150,.12)', txArea: 'rgba(235,0,139,.10)',
    },
    dark: {
      bg: '#0B0B10', card: '#15151D', card2: '#1B1B25',
      primary: '#EB008B', secondary: '#00E6DA',
      text: '#F2F2F6', muted: '#9B9BAB', line: '#2A2A38',
      ok: '#2EE59D', warn: '#FFC24B', bad: '#FF4D6D',
      violet: '#B18CFF', amber: '#FFB03A',
      track: '#22222e', split: 'rgba(42,42,56,.55)', legendOff: '#44444f',
      rxArea: 'rgba(0,230,218,.12)', txArea: 'rgba(235,0,139,.12)',
    },
  };
  var theme = 'light'; // default per human feedback
  var C = PALETTES[theme];

  var FONT_TITLE = "'Baloo 2', ui-rounded, system-ui, sans-serif";
  var FONT_BODY = "'Inter', system-ui, sans-serif";

  var DEVICE_RAM_MB = 8192;
  var WINDOW_S = 120; // timeline sliding window

  // ---------- thresholds (green → yellow → red) ----------
  function bands(warn, bad) {
    return function (v) { return v < warn ? C.ok : v < bad ? C.warn : C.bad; };
  }

  // FPS has NO thresholds: it's shown as a plain number inside the GPU donut.
  var latestFps = null;

  function gaugeDefs() {
    return {
      cpu:  { el: 'gCpu',  min: 0,  max: 100, color: bands(55, 75),
              fmt: function (v) { return Math.round(v) + '{u|%}'; } },
      gpu:  { el: 'gGpu',  min: 0,  max: 100, color: bands(65, 85),
              fmt: function (v) {
                var fpsLine = latestFps === null ? '' : '\n{fps|' + Math.round(latestFps) + ' FPS}';
                return Math.round(v) + '{u|%}' + fpsLine;
              } },
      temp: { el: 'gTemp', min: 25, max: 50,  color: bands(38, 42),
              fmt: function (v) { return v.toFixed(1) + '{u|°C}'; } },
      ram:  { el: 'gRam',  min: 0,  max: DEVICE_RAM_MB,
              color: bands(DEVICE_RAM_MB * .45, DEVICE_RAM_MB * .7),
              fmt: function (v) { return (v / 1024).toFixed(2) + '{u|GB}'; } },
    };
  }

  function makeGauge(cfg) {
    var chart = echarts.init(document.getElementById(cfg.el), null, { renderer: 'canvas' });
    chart.setOption({
      series: [{
        type: 'gauge',
        startAngle: 90, endAngle: -270,        // closed donut
        min: cfg.min, max: cfg.max,
        pointer: { show: false },
        progress: {
          show: true, width: 13, roundCap: true,
          itemStyle: { color: C.ok, shadowColor: 'rgba(0,0,0,.25)', shadowBlur: 5 },
        },
        axisLine: { lineStyle: { width: 13, color: [[1, C.track]] } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        anchor: { show: false }, title: { show: false },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, 0],
          formatter: cfg.fmt,
          color: C.text,
          fontFamily: FONT_TITLE,
          fontWeight: 800,
          fontSize: 30,
          lineHeight: 34,
          rich: {
            u: { color: C.muted, fontSize: 13, fontFamily: FONT_BODY, fontWeight: 500, padding: [8, 0, 0, 2] },
            // FPS: plain data, neutral color, no thresholds
            fps: { color: C.muted, fontSize: 14, fontFamily: FONT_BODY, fontWeight: 600, padding: [4, 0, 0, 0] },
          },
        },
        data: [{ value: cfg.min }],
      }],
    });
    cfg.chart = chart;
    return cfg;
  }

  function updateGauge(cfg, value) {
    cfg.chart.setOption({
      series: [{ data: [{ value: value }], progress: { itemStyle: { color: cfg.color(value) } } }],
    });
  }

  // ---------- memory pie ----------
  function memMeta() {
    return [
      { key: 'java',     name: 'Java heap', color: C.primary },
      { key: 'native',   name: 'Native',    color: C.secondary },
      { key: 'graphics', name: 'Graphics',  color: C.violet },
      { key: 'code',     name: 'Code',      color: C.amber },
      { key: 'stack',    name: 'Stack',     color: theme === 'light' ? '#1E90D6' : '#5AD1FF' },
      { key: 'other',    name: 'Other',     color: theme === 'light' ? '#8E8EA6' : '#6E6E82' },
    ];
  }

  function makeMemPie() {
    var chart = echarts.init(document.getElementById('memPie'));
    chart.setOption({
      animationDurationUpdate: 800,
      animationEasingUpdate: 'cubicOut',
      tooltip: {
        trigger: 'item',
        backgroundColor: C.card2, borderColor: C.line, textStyle: { color: C.text, fontFamily: FONT_BODY },
        formatter: function (p) { return p.name + ': <b>' + Math.round(p.value) + ' MB</b> (' + p.percent + '%)'; },
      },
      title: {
        text: '', left: 'center', top: '40%',
        textStyle: { color: C.text, fontFamily: FONT_TITLE, fontWeight: 800, fontSize: 22 },
        subtext: 'PSS total',
        subtextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 11 },
      },
      // Category names live in the legend (not as outside labels): outside labels
      // get "..."-truncated at mid widths; the legend never does.
      legend: {
        bottom: 0, left: 'center', type: 'scroll', icon: 'circle',
        itemWidth: 9, itemHeight: 9, itemGap: 10,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 11 },
        pageIconColor: C.muted, pageTextStyle: { color: C.muted },
      },
      series: [{
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        minShowLabelAngle: 18,
        itemStyle: { borderColor: C.card, borderWidth: 2, borderRadius: 5 },
        label: {
          show: true, position: 'inside', formatter: '{d}%',
          color: '#fff', fontFamily: FONT_BODY, fontSize: 10, fontWeight: 600,
          textShadowColor: 'rgba(0,0,0,0.45)', textShadowBlur: 2,
        },
        labelLine: { show: false },
        data: memMeta().map(function (m) { return { name: m.name, value: 0, itemStyle: { color: m.color } }; }),
      }],
    });
    return chart;
  }

  function updateMemPie(mem, pssMb) {
    memPie.setOption({
      title: { text: (pssMb / 1024).toFixed(2) + ' GB' },
      series: [{ data: memMeta().map(function (m) { return { name: m.name, value: mem[m.key], itemStyle: { color: m.color } }; }) }],
    });
  }

  // ---------- multi-series timeline ----------
  // All series are plotted normalized to 0–100 to share one axis; the tooltip
  // shows the real value with its unit (open feedback question: separate axes?).
  function seriesMeta() {
    return [
      { name: 'CPU %', color: C.primary,   plot: function (s) { return s.cpu; },                          real: function (s) { return s.cpu.toFixed(0) + ' %'; } },
      { name: 'RAM',   color: C.violet,    plot: function (s) { return s.ramMb / DEVICE_RAM_MB * 100; },  real: function (s) { return (s.ramMb / 1024).toFixed(2) + ' GB'; } },
      { name: 'FPS',   color: C.secondary, plot: function (s) { return s.fps / 60 * 100; },               real: function (s) { return s.fps.toFixed(0) + ' fps'; } },
      { name: 'Temp',  color: C.amber,     plot: function (s) { return (s.tempC - 25) / (50 - 25) * 100; }, real: function (s) { return s.tempC.toFixed(1) + ' °C'; } },
    ];
  }
  var SERIES = seriesMeta();

  function makeTimeline() {
    var chart = echarts.init(document.getElementById('timeline'));
    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 42, right: 16, top: 38, bottom: 28 },
      legend: {
        top: 2, left: 4,
        icon: 'roundRect', itemWidth: 14, itemHeight: 5,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 12 },
        inactiveColor: C.legendOff,
        data: SERIES.map(function (s) { return s.name; }),
        selected: { 'CPU %': true, RAM: true, FPS: true, Temp: true },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: C.card2, borderColor: C.line, textStyle: { color: C.text, fontFamily: FONT_BODY, fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: C.line } },
        formatter: function (params) {
          if (!params.length) return '';
          var lines = [echarts.time.format(params[0].value[0], '{HH}:{mm}:{ss}', false)];
          params.forEach(function (p) {
            lines.push(p.marker + ' ' + p.seriesName + ': <b>' + p.value[2] + '</b>');
          });
          return lines.join('<br/>');
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: C.line } },
        axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10, formatter: '{mm}:{ss}' },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0, max: 100,
        axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10, formatter: '{value}' },
        splitLine: { lineStyle: { color: C.split } },
      },
      series: SERIES.map(function (s) {
        return {
          name: s.name, type: 'line',
          showSymbol: false, smooth: 0.25,
          lineStyle: { width: 2, color: s.color },
          itemStyle: { color: s.color },
          emphasis: { disabled: true },
          data: [],
        };
      }),
    });
    return chart;
  }

  // ---------- network sparkline ----------
  function makeNetSpark() {
    var chart = echarts.init(document.getElementById('netSpark'));
    chart.setOption({
      animation: false,
      grid: { left: 4, right: 4, top: 4, bottom: 4 },
      xAxis: { type: 'time', show: false },
      yAxis: { type: 'value', show: false },
      tooltip: {
        trigger: 'axis',
        backgroundColor: C.card2, borderColor: C.line, textStyle: { color: C.text, fontSize: 11, fontFamily: FONT_BODY },
        formatter: function (params) {
          return params.map(function (p) { return p.marker + ' ' + p.seriesName + ': <b>' + Math.round(p.value[1]) + ' KB/s</b>'; }).join('<br/>');
        },
      },
      series: [
        { name: '↓ rx', type: 'line', showSymbol: false, smooth: 0.3, data: [],
          lineStyle: { width: 1.5, color: C.secondary }, itemStyle: { color: C.secondary },
          areaStyle: { color: C.rxArea } },
        { name: '↑ tx', type: 'line', showSymbol: false, smooth: 0.3, data: [],
          lineStyle: { width: 1.5, color: C.primary }, itemStyle: { color: C.primary },
          areaStyle: { color: C.txArea } },
      ],
    });
    return chart;
  }

  // ---------- build / rebuild all charts (theme switch reinits everything) ----------
  var gauges, memPie, timeline, netSpark;

  function allCharts() {
    var list = [memPie, timeline, netSpark];
    Object.keys(gauges || {}).forEach(function (k) { list.push(gauges[k].chart); });
    return list.filter(Boolean);
  }

  function buildCharts() {
    gauges = {};
    var defs = gaugeDefs();
    Object.keys(defs).forEach(function (k) { gauges[k] = makeGauge(defs[k]); });
    memPie = makeMemPie();
    timeline = makeTimeline();
    netSpark = makeNetSpark();
  }

  function disposeCharts() {
    allCharts().forEach(function (c) { c.dispose(); });
    gauges = null; memPie = null; timeline = null; netSpark = null;
  }

  // ---------- state + 1 Hz loop ----------
  var session, elapsed, tlData, netData, lastSample;
  function resetSession() {
    session = ProfilerSim.createSession();
    elapsed = 0;
    lastSample = null;
    latestFps = null;
    tlData = SERIES.map(function () { return []; });
    netData = [[], []];
    timeline.setOption({ series: SERIES.map(function (_, i) { return { data: tlData[i] }; }) });
  }

  function render(s) {
    latestFps = s.fps;
    updateGauge(gauges.cpu, s.cpu);
    updateGauge(gauges.gpu, s.gpu);
    updateGauge(gauges.temp, s.tempC);
    updateGauge(gauges.ram, s.ramMb);
    updateMemPie(s.mem, s.ramMb);
    timeline.setOption({ series: SERIES.map(function (_, i) { return { data: tlData[i] }; }) });
    netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] });
    document.getElementById('rxNow').textContent = '↓ ' + fmtKb(s.netRxKb);
    document.getElementById('txNow').textContent = '↑ ' + fmtKb(s.netTxKb);
    document.getElementById('rxTot').textContent = 'total ' + fmtTotal(s.rxTotalKb);
    document.getElementById('txTot').textContent = 'total ' + fmtTotal(s.txTotalKb);
  }

  buildCharts();
  resetSession();

  var paused = false;
  var recBadge = document.getElementById('recBadge');
  var recTime = document.getElementById('recTime');
  var recLabel = recBadge.querySelector('.rec-label');
  recBadge.addEventListener('click', function () {
    paused = !paused;
    recBadge.classList.toggle('paused', paused);
    recLabel.textContent = paused ? 'PAUSED' : 'REC';
  });

  document.getElementById('appSel').addEventListener('change', resetSession);

  // ---------- theme toggle (light default, dark = brand palette) ----------
  var themeToggle = document.getElementById('themeToggle');
  var themeIcon = document.getElementById('themeIcon');
  var themeLabel = document.getElementById('themeLabel');
  themeToggle.addEventListener('click', function () {
    theme = theme === 'light' ? 'dark' : 'light';
    C = PALETTES[theme];
    document.body.setAttribute('data-theme', theme);
    themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
    themeLabel.textContent = theme === 'light' ? 'Dark' : 'Light';
    // Rebuild charts so every axis/tooltip/text picks up the new palette,
    // then re-feed the buffered data so nothing visually resets.
    disposeCharts();
    SERIES = seriesMeta();
    buildCharts();
    if (lastSample) render(lastSample);
  });

  function fmtClock(s) {
    var m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function fmtKb(kb) {
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : Math.round(kb) + ' KB/s';
  }
  function fmtTotal(kb) {
    return kb >= 1024 * 1024 ? (kb / 1024 / 1024).toFixed(2) + ' GB' : (kb / 1024).toFixed(1) + ' MB';
  }

  function flashChip(id) {
    var el = document.getElementById(id);
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 1600);
  }

  function tick() {
    if (paused) return;
    var s = session.tick();
    elapsed += 1;
    recTime.textContent = fmtClock(elapsed);

    if (s.gc) flashChip('chipGc');
    if (s.jank) flashChip('chipJank');

    // timeline sliding window
    var now = Date.now();
    SERIES.forEach(function (meta, i) {
      tlData[i].push({ value: [now, meta.plot(s), meta.real(s)] });
      while (tlData[i].length > WINDOW_S) tlData[i].shift();
    });

    // network
    netData[0].push([now, s.netRxKb]);
    netData[1].push([now, s.netTxKb]);
    netData.forEach(function (arr) { while (arr.length > WINDOW_S) arr.shift(); });

    lastSample = s;
    render(s);
  }

  tick(); // first sample right away so nothing starts empty
  setInterval(tick, 1000);

  window.addEventListener('resize', function () {
    allCharts().forEach(function (c) { c.resize(); });
  });
})();
