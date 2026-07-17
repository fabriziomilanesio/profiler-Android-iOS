/**
 * report.js — ECharts wiring for the EXPORTED HTML REPORT prototype (ticket 020). DISPOSABLE.
 *
 * Two modes:
 *   Single  — consumption cards per metric, memory pie, full-session timelines.
 *   Compare — delta table (better/worse colored), grouped bars, overlaid timelines.
 * New metric vs the dashboard: BATTERY (drain %, temp, avg mA) — the star card in single mode.
 *
 * All data comes from ReportFixtures (deterministic). Charts rebuild on theme toggle so
 * every axis/tooltip/text recolors.
 */
(function () {
  'use strict';

  var PALETTES = {
    light: {
      bg:'#F4F4F9', card:'#FFFFFF', card2:'#FBFBFE',
      primary:'#EB008B', secondary:'#009E96',
      text:'#1C1C28', muted:'#66667A', line:'#E2E2EC',
      ok:'#0FA968', warn:'#E08A00', bad:'#E11D48',
      violet:'#7C5CE0', amber:'#D98A00', blue:'#1E90D6', grey:'#8E8EA6',
      track:'#ECECF4', split:'rgba(28,28,40,.09)', legendOff:'#C4C4D2',
    },
    dark: {
      bg:'#0B0B10', card:'#15151D', card2:'#1B1B25',
      primary:'#EB008B', secondary:'#00E6DA',
      text:'#F2F2F6', muted:'#9B9BAB', line:'#2A2A38',
      ok:'#2EE59D', warn:'#FFC24B', bad:'#FF4D6D',
      violet:'#B18CFF', amber:'#FFB03A', blue:'#5AD1FF', grey:'#6E6E82',
      track:'#22222e', split:'rgba(42,42,56,.55)', legendOff:'#44444f',
    },
  };
  var theme = 'light';
  var C = PALETTES[theme];
  var FONT_TITLE = "'Baloo 2', ui-rounded, system-ui, sans-serif";
  var FONT_BODY = "'Inter', system-ui, sans-serif";

  var SESSIONS = ReportFixtures.makeSessions();
  var DEVICE = ReportFixtures.DEVICE;

  // Per-session accent colors for compare charts (stable order).
  function sessionColors() { return [C.primary, C.secondary, C.violet]; }

  // ---------- helpers ----------
  function fmtDuration(s) {
    var m = Math.floor(s / 60), ss = s % 60;
    return m + 'm ' + (ss < 10 ? '0' : '') + ss + 's';
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }
  function gb(mb) { return (mb / 1024).toFixed(2); }

  // ================= SINGLE MODE =================
  var memPie, timeline;

  function memMeta() {
    return [
      { key:'java',     name:'Java heap', color:C.primary },
      { key:'native',   name:'Native',    color:C.secondary },
      { key:'graphics', name:'Graphics',  color:C.violet },
      { key:'code',     name:'Code',      color:C.amber },
      { key:'stack',    name:'Stack',     color:C.blue },
      { key:'other',    name:'Other',     color:C.grey },
    ];
  }

  // Metric card definitions: value from the SessionSummary. Battery is the star.
  function metricCardDefs(sess) {
    var S = sess.summary;
    return [
      { title:'🔋 Battery', star:true,
        big: '−' + S.battery.drainPct.toFixed(1), unit:'%',
        sub: 'drained · ' + S.battery.levelStart.toFixed(0) + '% → ' + S.battery.levelEnd.toFixed(0) +
             '% · <span class="hi">' + S.battery.tempPeak.toFixed(1) + '°C</span> peak · ' +
             Math.round(S.battery.avgMa) + ' mA avg' },
      { title:'CPU', big: S.cpu.avg.toFixed(0), unit:'%',
        sub: '<span class="hi">peak ' + S.cpu.peak.toFixed(0) + '%</span> · min ' + S.cpu.min.toFixed(0) + '% · p90 ' + S.cpu.p90.toFixed(0) + '%' },
      { title:'GPU', big: S.gpu.avg.toFixed(0), unit:'%',
        sub: '<span class="hi">peak ' + S.gpu.peak.toFixed(0) + '%</span> · min ' + S.gpu.min.toFixed(0) + '% · p90 ' + S.gpu.p90.toFixed(0) + '%' },
      { title:'FPS', big: S.fps.avg.toFixed(0), unit:'fps',
        sub: '<span class="lo">min ' + S.fps.min.toFixed(0) + '</span> · peak ' + S.fps.peak.toFixed(0) + ' · p90 ' + S.fps.p90.toFixed(0) },
      { title:'Temp', big: S.tempC.avg.toFixed(1), unit:'°C',
        sub: '<span class="hi">peak ' + S.tempC.peak.toFixed(1) + '°C</span> · min ' + S.tempC.min.toFixed(1) + '°C' },
      { title:'RAM (PSS)', big: gb(S.ramMb.avg), unit:'GB',
        sub: '<span class="hi">peak ' + gb(S.ramMb.peak) + ' GB</span> · min ' + gb(S.ramMb.min) + ' GB' },
    ];
  }

  function renderMeta(sess) {
    document.getElementById('devName').textContent = DEVICE.name;
    var specs = [DEVICE.os, DEVICE.ramGb + ' GB RAM', DEVICE.gpu, DEVICE.soc, DEVICE.screen,
                 DEVICE.batteryCapacityMah + ' mAh'];
    document.getElementById('devSpecs').innerHTML = specs.map(function (s) {
      return '<span class="spec">' + s + '</span>';
    }).join('');

    document.getElementById('sesApp').textContent = sess.app + ' · ' + sess.label;
    document.getElementById('sesBundle').textContent = sess.bundleId;
    var facts = [
      ['Date', fmtDate(sess.startedAt)],
      ['Duration', fmtDuration(sess.durationS)],
      ['Sampling', sess.samplingHz + ' Hz'],
      ['Samples', String(sess.sampleCount)],
    ];
    document.getElementById('sesFacts').innerHTML = facts.map(function (f) {
      return '<span class="fact">' + f[0] + ' <b>' + f[1] + '</b></span>';
    }).join('');
  }

  function renderCards(sess) {
    var host = document.getElementById('metricCards');
    host.innerHTML = metricCardDefs(sess).map(function (d) {
      return '<div class="card metric-card' + (d.star ? ' star' : '') + '">' +
        '<div class="card-title">' + d.title + '</div>' +
        '<div class="metric-big">' + d.big + '<span class="unit">' + d.unit + '</span></div>' +
        '<div class="metric-sub">' + d.sub + '</div>' +
      '</div>';
    }).join('');
  }

  function makeMemPie() {
    var chart = echarts.init(document.getElementById('memPie'));
    chart.setOption({
      tooltip: { trigger:'item', backgroundColor:C.card2, borderColor:C.line,
        textStyle:{ color:C.text, fontFamily:FONT_BODY },
        formatter:function (p) { return p.name + ': <b>' + Math.round(p.value) + ' MB</b> (' + p.percent + '%)'; } },
      title: { text:'', left:'center', top:'40%',
        textStyle:{ color:C.text, fontFamily:FONT_TITLE, fontWeight:800, fontSize:22 },
        subtext:'avg PSS', subtextStyle:{ color:C.muted, fontFamily:FONT_BODY, fontSize:11 } },
      legend: { bottom:0, left:'center', type:'scroll', icon:'circle',
        itemWidth:9, itemHeight:9, itemGap:10,
        textStyle:{ color:C.muted, fontFamily:FONT_BODY, fontSize:11 },
        pageIconColor:C.muted, pageTextStyle:{ color:C.muted } },
      series: [{ type:'pie', radius:['48%','72%'], center:['50%','46%'],
        avoidLabelOverlap:true, minShowLabelAngle:18,
        itemStyle:{ borderColor:C.card, borderWidth:2, borderRadius:5 },
        label:{ show:true, position:'inside', formatter:'{d}%', color:'#fff',
          fontFamily:FONT_BODY, fontSize:10, fontWeight:600,
          textShadowColor:'rgba(0,0,0,0.45)', textShadowBlur:2 },
        labelLine:{ show:false },
        data: memMeta().map(function (m) { return { name:m.name, value:0, itemStyle:{ color:m.color } }; }) }],
    });
    return chart;
  }
  function updateMemPie(sess) {
    var mem = sess.summary.memAvg;
    memPie.setOption({
      title: { text: gb(sess.summary.ramMb.avg) + ' GB' },
      series: [{ data: memMeta().map(function (m) { return { name:m.name, value:mem[m.key], itemStyle:{ color:m.color } }; }) }],
    });
  }

  // full-session timeline: all series normalized 0–100 to share one axis; tooltip shows real value.
  function tlMeta() {
    return [
      { name:'CPU %',   color:C.primary,   norm:function (s){ return s.cpu; },                          real:function (s){ return s.cpu.toFixed(0)+' %'; } },
      { name:'RAM',     color:C.violet,    norm:function (s){ return s.ramMb / DEVICE.ramMb * 100; },   real:function (s){ return gb(s.ramMb)+' GB'; } },
      { name:'FPS',     color:C.secondary, norm:function (s){ return s.fps / 60 * 100; },               real:function (s){ return s.fps.toFixed(0)+' fps'; } },
      { name:'Temp',    color:C.amber,     norm:function (s){ return (s.tempC-25)/(50-25)*100; },       real:function (s){ return s.tempC.toFixed(1)+' °C'; } },
      { name:'Battery', color:C.ok,        norm:function (s){ return s.battery.level; },                real:function (s){ return s.battery.level.toFixed(1)+' %'; } },
    ];
  }

  function makeTimeline() {
    var chart = echarts.init(document.getElementById('timeline'));
    var M = tlMeta();
    chart.setOption({
      animation:false, backgroundColor:'transparent',
      grid:{ left:44, right:16, top:40, bottom:30 },
      legend:{ top:2, left:4, icon:'roundRect', itemWidth:14, itemHeight:5,
        textStyle:{ color:C.muted, fontFamily:FONT_BODY, fontSize:12 }, inactiveColor:C.legendOff,
        data:M.map(function (m){ return m.name; }) },
      tooltip:{ trigger:'axis', backgroundColor:C.card2, borderColor:C.line,
        textStyle:{ color:C.text, fontFamily:FONT_BODY, fontSize:12 },
        axisPointer:{ type:'line', lineStyle:{ color:C.line } },
        formatter:function (params){
          if (!params.length) return '';
          var lines = [echarts.time.format(params[0].value[0], '{mm}:{ss}', false)];
          params.forEach(function (p){ lines.push(p.marker+' '+p.seriesName+': <b>'+p.value[2]+'</b>'); });
          return lines.join('<br/>');
        } },
      xAxis:{ type:'time', axisLine:{ lineStyle:{ color:C.line } },
        axisLabel:{ color:C.muted, fontFamily:FONT_BODY, fontSize:10, formatter:'{mm}:{ss}' }, splitLine:{ show:false } },
      yAxis:{ type:'value', min:0, max:100,
        axisLabel:{ color:C.muted, fontFamily:FONT_BODY, fontSize:10 }, splitLine:{ lineStyle:{ color:C.split } } },
      series: M.map(function (m){ return { name:m.name, type:'line', showSymbol:false, smooth:0.2,
        lineStyle:{ width:2, color:m.color }, itemStyle:{ color:m.color }, emphasis:{ disabled:true }, data:[] }; }),
    });
    return chart;
  }
  function updateTimeline(sess) {
    var M = tlMeta();
    timeline.setOption({
      series: M.map(function (m){
        return { data: sess.series.map(function (s){ return { value:[s.ts, m.norm(s), m.real(s)] }; }) };
      }),
    });
  }

  function renderSingle(sess) {
    renderMeta(sess);
    renderCards(sess);
    updateMemPie(sess);
    updateTimeline(sess);
  }

  // ================= COMPARE MODE =================
  var cmpBars, cmpTimeline, cmpMetric = 'battery';

  // Metric rows for the delta table & bars. `betterWhen:'lower'|'higher'`.
  function cmpMetricDefs() {
    return [
      { key:'battDrain', name:'Battery drained', unit:'%', betterWhen:'lower',
        get:function (S){ return S.battery.drainPct; }, fmt:function (v){ return v.toFixed(1)+'%'; } },
      { key:'battTemp', name:'Battery temp peak', unit:'°C', betterWhen:'lower',
        get:function (S){ return S.battery.tempPeak; }, fmt:function (v){ return v.toFixed(1)+'°C'; } },
      { key:'cpu', name:'CPU', unit:'% avg / peak', betterWhen:'lower',
        get:function (S){ return S.cpu.avg; }, peak:function (S){ return S.cpu.peak; }, fmt:function (v){ return v.toFixed(0)+'%'; } },
      { key:'gpu', name:'GPU', unit:'% avg / peak', betterWhen:'lower',
        get:function (S){ return S.gpu.avg; }, peak:function (S){ return S.gpu.peak; }, fmt:function (v){ return v.toFixed(0)+'%'; } },
      { key:'ram', name:'RAM (PSS)', unit:'GB avg / peak', betterWhen:'lower',
        get:function (S){ return S.ramMb.avg/1024; }, peak:function (S){ return S.ramMb.peak/1024; }, fmt:function (v){ return v.toFixed(2)+' GB'; } },
      { key:'temp', name:'SoC temp', unit:'°C avg / peak', betterWhen:'lower',
        get:function (S){ return S.tempC.avg; }, peak:function (S){ return S.tempC.peak; }, fmt:function (v){ return v.toFixed(1)+'°C'; } },
      { key:'fps', name:'FPS', unit:'avg / min', betterWhen:'higher',
        get:function (S){ return S.fps.avg; }, peak:function (S){ return S.fps.min; }, fmt:function (v){ return v.toFixed(0); } },
    ];
  }

  // Decide better/worse for a delta given the metric's direction.
  function dir(deltaPct, betterWhen) {
    if (Math.abs(deltaPct) < 0.5) return 'flat';
    var improved = betterWhen === 'lower' ? deltaPct < 0 : deltaPct > 0;
    return improved ? 'better' : 'worse';
  }

  // Comparability check: same device + sampling → comparable. Prototype fixtures share
  // the device, so this returns comparable. The `else` branch (red banner) is live code
  // that would fire if a real export mixed devices/conditions.
  function checkComparable(sessions) {
    var base = sessions[0];
    var reasons = [];
    for (var i = 1; i < sessions.length; i++) {
      var s = sessions[i];
      if (s.device.model !== base.device.model) reasons.push('device differs (' + s.device.model + ' vs ' + base.device.model + ')');
      if (s.device.os !== base.device.os) reasons.push('OS differs');
      if (s.samplingHz !== base.samplingHz) reasons.push('sampling rate differs');
    }
    return { comparable: reasons.length === 0, reasons: reasons };
  }

  function renderBanner(sessions) {
    var res = checkComparable(sessions);
    var el = document.getElementById('cmpBanner');
    var txt = document.getElementById('cmpBannerText');
    var ico = el.querySelector('.ico');
    if (res.comparable) {
      el.classList.remove('warn');
      ico.textContent = '✓';
      txt.innerHTML = 'Comparable — same device (' + sessions[0].device.name +
        ') &amp; ' + sessions[0].samplingHz + ' Hz sampling across all ' + sessions.length + ' sessions.';
    } else {
      el.classList.add('warn');
      ico.textContent = '⚠';
      txt.innerHTML = 'Benchmark not directly comparable: ' + res.reasons.join('; ') + '.';
    }
  }

  function renderCmpTable(sessions) {
    var defs = cmpMetricDefs();
    var base = sessions[0];
    var head = '<thead><tr><th>Metric</th>';
    sessions.forEach(function (s, i) {
      head += '<th>' + s.label + (i === 0 ? ' <small style="font-weight:400">(baseline)</small>' : '') + '</th>';
    });
    head += '</tr></thead>';

    var body = '<tbody>';
    defs.forEach(function (d) {
      body += '<tr><td class="metric-name">' + d.name + '<small>' + d.unit + '</small></td>';
      var baseVal = d.get(base.summary);
      sessions.forEach(function (s, i) {
        var v = d.get(s.summary);
        var cell = d.fmt(v);
        if (d.peak) cell += ' <span style="color:var(--muted)">/ ' + d.fmt(d.peak(s.summary)) + '</span>';
        if (i === 0) {
          body += '<td class="base">' + cell + '</td>';
        } else {
          var deltaPct = baseVal === 0 ? 0 : (v - baseVal) / Math.abs(baseVal) * 100;
          var klass = dir(deltaPct, d.betterWhen);
          var sign = deltaPct > 0 ? '+' : '';
          var arrow = klass === 'better' ? '▲' : klass === 'worse' ? '▼' : '·';
          body += '<td>' + cell + ' <span class="delta ' + klass + '">' + arrow + ' ' + sign + deltaPct.toFixed(1) + '%</span></td>';
        }
      });
      body += '</tr>';
    });
    body += '</tbody>';
    document.getElementById('cmpTable').innerHTML = head + body;
  }

  // Grouped bars: normalize each metric to its own max so bars are comparable in one axis.
  function makeCmpBars() {
    var chart = echarts.init(document.getElementById('cmpBars'));
    var defs = cmpMetricDefs();
    var cols = sessionColors();
    var cats = defs.map(function (d){ return d.name; });
    // per-metric max across sessions for normalization
    var maxes = defs.map(function (d){
      return Math.max.apply(null, SESSIONS.map(function (s){ return d.get(s.summary); }));
    });
    var series = SESSIONS.map(function (s, si) {
      return {
        name: s.label, type:'bar',
        itemStyle:{ color:cols[si % cols.length], borderRadius:[4,4,0,0] },
        data: defs.map(function (d, di){
          var raw = d.get(s.summary);
          return { value: maxes[di] ? +(raw / maxes[di] * 100).toFixed(1) : 0, raw:raw, fmt:d.fmt(raw) };
        }),
      };
    });
    chart.setOption({
      backgroundColor:'transparent',
      grid:{ left:40, right:16, top:36, bottom:60 },
      legend:{ top:2, left:4, textStyle:{ color:C.muted, fontFamily:FONT_BODY, fontSize:12 },
        icon:'roundRect', itemWidth:12, itemHeight:8, inactiveColor:C.legendOff },
      tooltip:{ trigger:'axis', backgroundColor:C.card2, borderColor:C.line,
        textStyle:{ color:C.text, fontFamily:FONT_BODY, fontSize:12 },
        formatter:function (params){
          var lines = [params[0].axisValue];
          params.forEach(function (p){ lines.push(p.marker+' '+p.seriesName+': <b>'+p.data.fmt+'</b>'); });
          return lines.join('<br/>');
        } },
      xAxis:{ type:'category', data:cats,
        axisLine:{ lineStyle:{ color:C.line } },
        axisLabel:{ color:C.muted, fontFamily:FONT_BODY, fontSize:10, interval:0, rotate:22 } },
      yAxis:{ type:'value', min:0, max:100, name:'% of max', nameTextStyle:{ color:C.muted, fontSize:10 },
        axisLabel:{ color:C.muted, fontFamily:FONT_BODY, fontSize:10 }, splitLine:{ lineStyle:{ color:C.split } } },
      series: series,
    });
    return chart;
  }

  // Overlaid timelines: one series per session for the selected metric (real values).
  function cmpTimelineMetricDefs() {
    return {
      battery: { name:'Battery %', get:function (s){ return s.battery.level; }, fmt:function (v){ return v.toFixed(1)+' %'; } },
      cpu:     { name:'CPU %',     get:function (s){ return s.cpu; },           fmt:function (v){ return v.toFixed(0)+' %'; } },
      gpu:     { name:'GPU %',     get:function (s){ return s.gpu; },           fmt:function (v){ return v.toFixed(0)+' %'; } },
      ram:     { name:'RAM GB',    get:function (s){ return s.ramMb/1024; },    fmt:function (v){ return v.toFixed(2)+' GB'; } },
      temp:    { name:'SoC °C',    get:function (s){ return s.tempC; },         fmt:function (v){ return v.toFixed(1)+' °C'; } },
      fps:     { name:'FPS',       get:function (s){ return s.fps; },           fmt:function (v){ return v.toFixed(0)+' fps'; } },
    };
  }

  function makeCmpTimeline() {
    return echarts.init(document.getElementById('cmpTimeline'));
  }
  function updateCmpTimeline() {
    var def = cmpTimelineMetricDefs()[cmpMetric];
    var cols = sessionColors();
    // align all sessions to elapsed seconds (t) so overlay makes sense despite diff start times.
    cmpTimeline.setOption({
      animation:false, backgroundColor:'transparent',
      grid:{ left:48, right:16, top:36, bottom:30 },
      legend:{ top:2, left:4, textStyle:{ color:C.muted, fontFamily:FONT_BODY, fontSize:12 },
        icon:'roundRect', itemWidth:14, itemHeight:5, inactiveColor:C.legendOff },
      tooltip:{ trigger:'axis', backgroundColor:C.card2, borderColor:C.line,
        textStyle:{ color:C.text, fontFamily:FONT_BODY, fontSize:12 },
        formatter:function (params){
          if (!params.length) return '';
          var lines = ['t = ' + params[0].axisValue + 's'];
          params.forEach(function (p){ lines.push(p.marker+' '+p.seriesName+': <b>'+def.fmt(p.value[1])+'</b>'); });
          return lines.join('<br/>');
        } },
      xAxis:{ type:'value', name:'elapsed s', nameTextStyle:{ color:C.muted, fontSize:10 },
        axisLine:{ lineStyle:{ color:C.line } },
        axisLabel:{ color:C.muted, fontFamily:FONT_BODY, fontSize:10 }, splitLine:{ show:false } },
      yAxis:{ type:'value', name:def.name, nameTextStyle:{ color:C.muted, fontSize:10 }, scale:true,
        axisLabel:{ color:C.muted, fontFamily:FONT_BODY, fontSize:10 }, splitLine:{ lineStyle:{ color:C.split } } },
      series: SESSIONS.map(function (s, si){
        return { name:s.label, type:'line', showSymbol:false, smooth:0.2,
          lineStyle:{ width:2, color:cols[si % cols.length] }, itemStyle:{ color:cols[si % cols.length] },
          emphasis:{ disabled:true },
          data: s.series.map(function (x){ return [x.t, def.get(x)]; }) };
      }),
    });
  }

  function renderMetricSwitch() {
    var host = document.getElementById('cmpMetricSwitch');
    var defs = cmpTimelineMetricDefs();
    host.innerHTML = Object.keys(defs).map(function (k) {
      return '<button data-metric="' + k + '" class="' + (k === cmpMetric ? 'active' : '') + '" type="button">' + defs[k].name + '</button>';
    }).join('');
    host.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        cmpMetric = b.getAttribute('data-metric');
        host.querySelectorAll('button').forEach(function (x){ x.classList.toggle('active', x === b); });
        updateCmpTimeline();
      });
    });
  }

  function renderCompare() {
    renderBanner(SESSIONS);
    renderCmpTable(SESSIONS);
    renderMetricSwitch();
    updateCmpTimeline();
  }

  // ================= BUILD / REBUILD =================
  function allCharts() { return [memPie, timeline, cmpBars, cmpTimeline].filter(Boolean); }

  function buildCharts() {
    memPie = makeMemPie();
    timeline = makeTimeline();
    cmpBars = makeCmpBars();
    cmpTimeline = makeCmpTimeline();
  }
  function disposeCharts() {
    allCharts().forEach(function (c){ c.dispose(); });
    memPie = timeline = cmpBars = cmpTimeline = null;
  }

  // ---------- session picker ----------
  var currentSess = SESSIONS[0];
  var sessSel = document.getElementById('sessSel');
  SESSIONS.forEach(function (s, i) {
    var opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label + ' — ' + s.bundleId;
    if (i === 0) opt.selected = true;
    sessSel.appendChild(opt);
  });
  sessSel.addEventListener('change', function () {
    currentSess = SESSIONS.filter(function (s){ return s.id === sessSel.value; })[0] || SESSIONS[0];
    renderSingle(currentSess);
  });

  // ---------- mode toggle ----------
  var mode = 'single';
  document.getElementById('modeToggle').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.getAttribute('data-mode');
      document.getElementById('modeToggle').querySelectorAll('button').forEach(function (x){ x.classList.toggle('active', x === b); });
      document.getElementById('viewSingle').classList.toggle('hidden', mode !== 'single');
      document.getElementById('viewCompare').classList.toggle('hidden', mode !== 'compare');
      // charts sized while hidden render at 0px → resize on reveal
      setTimeout(function () { allCharts().forEach(function (c){ c.resize(); }); }, 0);
    });
  });

  // ---------- theme toggle ----------
  var themeToggle = document.getElementById('themeToggle');
  var themeIcon = document.getElementById('themeIcon');
  var themeLabel = document.getElementById('themeLabel');
  themeToggle.addEventListener('click', function () {
    theme = theme === 'light' ? 'dark' : 'light';
    C = PALETTES[theme];
    document.body.setAttribute('data-theme', theme);
    themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
    themeLabel.textContent = theme === 'light' ? 'Dark' : 'Light';
    disposeCharts();
    buildCharts();
    renderSingle(currentSess);
    renderCompare();
    setTimeout(function () { allCharts().forEach(function (c){ c.resize(); }); }, 0);
  });

  // ---------- first paint ----------
  buildCharts();
  renderSingle(currentSess);
  renderCompare();

  window.addEventListener('resize', function () {
    allCharts().forEach(function (c){ c.resize(); });
  });
})();
