// Track mode: route recording, trip stats, 0–100 / ¼ mile / 100–200 timers, history, GPX export.
// Listens to 'se:fix' events from the main app ({ t, lat, lon, alt, acc, kmh, heading }).
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SE = window.SE;
  const R_EARTH = 6371000, toR = Math.PI / 180;
  const dist = (a, b) => {
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(s));
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const fmtTime = s => {
    if (s == null || !isFinite(s)) return '—';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  };
  const fmtKm = m => m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} км`;
  const fmtSec = s => s == null ? '—' : s.toFixed(1) + ' с';

  // ---------- live trip ----------
  let trip = null;          // recording trip
  let viewTrip = null;      // trip shown on the map (live or from history)
  let last = null;          // last accepted fix
  const sensors = { fixes: 0, nativeSpeed: false, nativeHeading: false, alt: false, acc: null, motion: false, demo: false };

  function newTrip() {
    return { id: Date.now(), date: new Date().toISOString(), tesla: SE.tesla().name + ' ' + SE.tesla().trim.split(' · ')[0],
      pts: [], dist: 0, moving: 0, start: null, end: null, max: 0, gain: 0, altEma: null, altRef: null,
      maxLatG: 0, maxLongG: 0, maxBrakeG: 0 };
  }

  // ---------- timers: 0–100, ¼ mile (402.3 m), 100–200 ----------
  const timers = { armed: false, t0: null, d: 0, r0100: null, quarter: null, trap: null, t100: null, r100200: null, live: null };
  const best = () => store.get('best:' + SE.tesla().name + SE.tesla().trim, {});
  function saveBest(key, val) {
    const b = best();
    if (b[key] == null || val < b[key]) { b[key] = val; store.set('best:' + SE.tesla().name + SE.tesla().trim, b); flash(key); }
  }
  // linear interpolation of the moment speed crossed `target` between two fixes
  const cross = (a, b, target) => a.t + (target - a.kmh) / Math.max(1e-6, b.kmh - a.kmh) * (b.t - a.t);

  function updateTimers(prev, f, seg) {
    if (f.kmh < 1) { timers.armed = true; timers.t0 = null; timers.d = 0; timers.live = null; return; }
    if (timers.armed && timers.t0 == null && prev && prev.kmh < 1) {
      timers.t0 = cross(prev, f, 1); timers.d = 0; timers.vmax = 0; timers.r0100 = timers.quarter = timers.trap = null;
    }
    if (timers.t0 != null) {
      timers.d += seg;
      timers.vmax = Math.max(timers.vmax, f.kmh);
      // lifted off / braked during the run → it is not a full-throttle pull any more
      if (f.kmh < timers.vmax * 0.9 && timers.vmax > 15) { timers.armed = false; timers.t0 = null; timers.live = null; return; }
      timers.live = (f.t - timers.t0) / 1000;
      if (timers.r0100 == null && prev && prev.kmh < 100 && f.kmh >= 100) {
        timers.r0100 = (cross(prev, f, 100) - timers.t0) / 1000; saveBest('r0100', timers.r0100);
      }
      if (timers.quarter == null && timers.d >= 402.3) {
        timers.quarter = (f.t - timers.t0) / 1000; timers.trap = f.kmh; saveBest('quarter', timers.quarter);
      }
      if (timers.r0100 != null && timers.quarter != null) { timers.armed = false; timers.t0 = null; }
      if (timers.live > 60) { timers.armed = false; timers.t0 = null; }
    }
    // rolling 100–200
    if (prev && prev.kmh < 100 && f.kmh >= 100) timers.t100 = cross(prev, f, 100);
    if (timers.t100 != null && f.kmh < 95) timers.t100 = null;
    if (timers.t100 != null && prev && prev.kmh < 200 && f.kmh >= 200) {
      timers.r100200 = (cross(prev, f, 200) - timers.t100) / 1000; saveBest('r100200', timers.r100200); timers.t100 = null;
    }
  }

  window.addEventListener('se:fix', e => {
    const f = e.detail;
    sensors.fixes++; sensors.demo = !!f.demo;
    if (f.nativeSpeed) sensors.nativeSpeed = true;
    if (f.nativeHeading) sensors.nativeHeading = true;
    if (f.alt != null && !isNaN(f.alt)) sensors.alt = true;
    sensors.acc = f.acc;
    if (f.kmh == null || f.acc > 40) return;            // too inaccurate for distance/timers
    let seg = 0;
    if (last) {
      seg = dist(last, f);
      const dt = (f.t - last.t) / 1000;
      if (dt <= 0 || seg / Math.max(dt, 0.05) > 120) seg = 0;   // reject GPS jumps (>430 km/h)
    }
    updateTimers(last, f, seg);
    if (trip) {
      if (trip.start == null) trip.start = f.t;
      trip.end = f.t;
      trip.dist += seg;
      if (f.kmh > 3 && last) trip.moving += (f.t - last.t) / 1000;
      trip.max = Math.max(trip.max, f.kmh);
      if (f.alt != null && !isNaN(f.alt)) {
        trip.altEma = trip.altEma == null ? f.alt : trip.altEma + (f.alt - trip.altEma) * 0.2;
        if (trip.altRef == null) trip.altRef = trip.altEma;
        if (trip.altEma - trip.altRef > 2) { trip.gain += trip.altEma - trip.altRef; trip.altRef = trip.altEma; }
        else if (trip.altEma < trip.altRef - 2) trip.altRef = trip.altEma;
      }
      const st = SE.state, lg = st.accel / 3.6 / 9.81;
      trip.maxLatG = Math.max(trip.maxLatG, Math.abs(st.latG));
      trip.maxLongG = Math.max(trip.maxLongG, lg);
      trip.maxBrakeG = Math.max(trip.maxBrakeG, -lg);
      const p = trip.pts[trip.pts.length - 1];
      if (!p || seg > 3 || (f.t - p[3]) > 5000) trip.pts.push([+f.lat.toFixed(6), +f.lon.toFixed(6), Math.round(f.kmh), f.t, f.alt != null ? Math.round(f.alt) : null]);
    }
    last = { lat: f.lat, lon: f.lon, t: f.t, kmh: f.kmh };
  });

  // optional motion sensor (phones / tablets; the car screen usually has none)
  window.addEventListener('devicemotion', e => {
    const a = e.acceleration || e.accelerationIncludingGravity;
    if (a && (a.x != null || a.y != null)) sensors.motion = true;
  });

  // ---------- recording ----------
  function startRec() { trip = newTrip(); viewTrip = trip; render(); }
  function stopRec() {
    if (!trip) return;
    const t = trip; trip = null;
    if (t.pts.length > 1 && t.dist > 20) {
      if (t.pts.length > 1500) { const k = Math.ceil(t.pts.length / 1500); t.pts = t.pts.filter((_, i) => i % k === 0); }
      t.best0100 = timers.r0100; t.quarter = timers.quarter;
      const list = store.get('trips', []); list.unshift(slim(t)); store.set('trips', list.slice(0, 25));
    }
    viewTrip = t; render();
  }
  const slim = t => ({ id: t.id, date: t.date, tesla: t.tesla, pts: t.pts, dist: t.dist, moving: t.moving,
    start: t.start, end: t.end, max: t.max, gain: t.gain, maxLatG: t.maxLatG, maxLongG: t.maxLongG, maxBrakeG: t.maxBrakeG,
    best0100: t.best0100, quarter: t.quarter });

  // ---------- GPX ----------
  function gpx(t) {
    const pts = t.pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[4] != null ? `<ele>${p[4]}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time><extensions><speed>${(p[2] / 3.6).toFixed(2)}</speed></extensions></trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Sport Engine" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${t.tesla} ${t.date}</name><trkseg>\n${pts}\n</trkseg></trk></gpx>`;
  }
  function downloadGpx(t) {
    if (!t || t.pts.length < 2) { SE.setStatus('Нет точек маршрута для GPX', 'warn'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([gpx(t)], { type: 'application/gpx+xml' }));
    a.download = 'trip-' + t.date.slice(0, 16).replace(/[:T]/g, '-') + '.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- UI ----------
  const cv = $('routeCv'), g = cv.getContext('2d');
  let flashKey = null, flashUntil = 0;
  function flash(k) { flashKey = k; flashUntil = performance.now() + 2500; }

  function card(id, label, val, sub, hl) {
    return `<div class="tcard${hl ? ' hl' : ''}" id="${id}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  }
  function renderStats() {
    const t = viewTrip, b = best(), st = SE.state;
    const fl = k => flashKey === k && performance.now() < flashUntil;
    const avg = t && t.moving > 5 ? t.dist / t.moving * 3.6 : null;
    const dur = t && t.start ? (t.end - t.start) / 1000 : null;
    const liveRun = timers.t0 != null ? `идёт: ${timers.live.toFixed(1)} с` : (timers.armed ? 'готов — стартуйте с места' : 'остановитесь для старта');
    $('tStats').innerHTML = [
      card('cDist', 'Пробег', t ? fmtKm(t.dist) : '—', t && t.gain ? `набор высоты ${Math.round(t.gain)} м` : ''),
      card('cTime', 'Время', fmtTime(dur), t && t.moving ? `в движении ${fmtTime(t.moving)}` : ''),
      card('cAvg', 'Средняя / Макс', `${avg ? Math.round(avg) : '—'} / ${t ? Math.round(t.max) : '—'}`, 'км/ч'),
      card('c0100', '0–100 км/ч', fmtSec(timers.r0100), `лучшее ${fmtSec(b.r0100)} · ${liveRun}`, fl('r0100')),
      card('cQ', '¼ мили (402 м)', fmtSec(timers.quarter), timers.trap ? `на ${Math.round(timers.trap)} км/ч · лучшее ${fmtSec(b.quarter)}` : `лучшее ${fmtSec(b.quarter)}`, fl('quarter')),
      card('c100', '100–200 км/ч', fmtSec(timers.r100200), `лучшее ${fmtSec(b.r100200)}`, fl('r100200')),
      card('cG', 'Перегрузки', `${Math.abs(st.latG).toFixed(2)} g бок`, t ? `макс: разгон ${t.maxLongG.toFixed(2)} · торм. ${t.maxBrakeG.toFixed(2)} · бок ${t.maxLatG.toFixed(2)}` : ''),
    ].join('');
    const yes = '✓', no = '✗';
    $('tSensors').textContent = sensors.demo ? 'Демо: имитация GPS‑маршрута' :
      `Данные браузера: GPS ${sensors.fixes ? yes : no}${sensors.acc != null ? ' ±' + Math.round(sensors.acc) + ' м' : ''} · скорость от GPS ${sensors.nativeSpeed ? yes : 'вычисляется'} · курс ${sensors.nativeHeading ? yes : 'вычисляется'} · высота ${sensors.alt ? yes : no} · датчик движения ${sensors.motion ? yes : no}`;
    $('recBtn').textContent = trip ? '■ Стоп записи' : '● Записать поездку';
    $('recBtn').classList.toggle('on', !!trip);
  }

  function renderMap() {
    const dpr = Math.min(2, devicePixelRatio || 1), r = cv.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const pts = viewTrip ? viewTrip.pts : [];
    if (pts.length < 2) {
      g.fillStyle = '#7c8594'; g.font = `600 ${W < 420 ? 13 : 15}px -apple-system, Roboto, sans-serif`; g.textAlign = 'center';
      g.fillText(trip ? 'Запись идёт — начните движение' : 'Маршрут появится после «Записать поездку»', W / 2, H / 2);
      return;
    }
    const lat0 = pts[0][0], k = Math.cos(lat0 * toR);
    const xy = pts.map(p => [(p[1] - pts[0][1]) * k * 111320, -(p[0] - lat0) * 111320]);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    xy.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
    const pad = 24, sc = Math.min((W - pad * 2) / Math.max(30, maxX - minX), (H - pad * 2) / Math.max(30, maxY - minY));
    const ox = (W - (maxX - minX) * sc) / 2 - minX * sc, oy = (H - (maxY - minY) * sc) / 2 - minY * sc;
    const vmax = Math.max(60, ...pts.map(p => p[2]));
    g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 1; i < xy.length; i++) {
      const v = pts[i][2] / vmax;                                   // green → yellow → red by speed
      g.strokeStyle = `hsl(${120 - 120 * Math.min(1, v)}, 90%, 52%)`;
      g.beginPath(); g.moveTo(xy[i - 1][0] * sc + ox, xy[i - 1][1] * sc + oy); g.lineTo(xy[i][0] * sc + ox, xy[i][1] * sc + oy); g.stroke();
    }
    const s0 = xy[0], s1 = xy[xy.length - 1];
    g.fillStyle = '#fff'; g.beginPath(); g.arc(s0[0] * sc + ox, s0[1] * sc + oy, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff3b30'; g.shadowColor = '#ff3b30'; g.shadowBlur = 12;
    g.beginPath(); g.arc(s1[0] * sc + ox, s1[1] * sc + oy, 7, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
    // scale bar
    const meters = [50, 100, 200, 500, 1000, 2000, 5000, 10000].find(m => m * sc > 60) || 10000;
    g.strokeStyle = '#7c8594'; g.lineWidth = 2; g.beginPath(); g.moveTo(14, H - 14); g.lineTo(14 + meters * sc, H - 14); g.stroke();
    g.fillStyle = '#7c8594'; g.font = '600 12px -apple-system, Roboto, sans-serif'; g.textAlign = 'left';
    g.fillText(fmtKm(meters), 14, H - 20);
  }

  function render() { if (!$('trackView').hidden) { renderStats(); renderMap(); } }
  setInterval(render, 500);
  window.addEventListener('resize', render);

  function renderHistory() {
    const list = store.get('trips', []);
    $('histList').innerHTML = list.length ? list.map((t, i) => `
      <div class="hrow" data-i="${i}">
        <div><b>${new Date(t.date).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>
          <small>${t.tesla} · ${fmtKm(t.dist)} · макс ${Math.round(t.max)} км/ч${t.best0100 ? ' · 0–100 ' + t.best0100.toFixed(1) + ' с' : ''}</small></div>
        <div class="hact"><button data-a="show">Показать</button><button data-a="gpx">GPX</button><button data-a="del" aria-label="Удалить">✕</button></div>
      </div>`).join('') : '<p class="hempty">Пока нет сохранённых поездок</p>';
  }
  $('histList').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    const i = +btn.closest('.hrow').dataset.i, list = store.get('trips', []), t = list[i];
    if (btn.dataset.a === 'show') { viewTrip = t; $('history').hidden = true; render(); }
    else if (btn.dataset.a === 'gpx') downloadGpx(t);
    else if (btn.dataset.a === 'del') { list.splice(i, 1); store.set('trips', list); renderHistory(); }
  });

  $('recBtn').onclick = () => { trip ? stopRec() : startRec(); render(); };
  $('resetTimers').onclick = () => { Object.assign(timers, { r0100: null, quarter: null, trap: null, r100200: null }); render(); };
  $('histBtn').onclick = () => { renderHistory(); $('history').hidden = false; };
  $('histClose').onclick = () => { $('history').hidden = true; };
  $('history').addEventListener('click', e => { if (e.target === $('history')) $('history').hidden = true; });
  $('gpxBtn').onclick = () => downloadGpx(viewTrip || trip);
  $('liveBtn').onclick = () => { viewTrip = trip; render(); };

  window.SE_TRACK = { render, isRecording: () => !!trip };
})();
