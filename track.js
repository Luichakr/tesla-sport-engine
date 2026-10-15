// Drag + Track (laps) modes, route recording, history, GPX.
// Listens to 'se:fix' events from the main app ({ t, lat, lon, alt, acc, kmh, heading }).
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SE = window.SE;
  const toR = Math.PI / 180;
  const dist = (a, b) => {
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
  };
  // local metric offset of b relative to a (east, north)
  const enu = (a, b) => [(b.lon - a.lon) * toR * 6371000 * Math.cos(a.lat * toR), (b.lat - a.lat) * toR * 6371000];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const fmtTime = s => {
    if (s == null || !isFinite(s)) return '—';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  };
  const fmtLap = s => s == null ? '—' : `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
  const fmtKm = m => m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} км`;
  const fmtSec = s => s == null ? '—' : s.toFixed(2) + ' с';
  const teslaKey = () => SE.tesla().name + ' ' + SE.tesla().trim;
  const teslaShort = () => SE.tesla().name + ' ' + SE.tesla().trim.split(' · ')[0];
  const gNow = () => ({ lat: Math.abs(SE.state.latG), lon: SE.state.accel / 3.6 / 9.81 });

  let last = null;          // last accepted fix
  const sensors = { fixes: 0, nativeSpeed: false, nativeHeading: false, alt: false, acc: null, motion: false, demo: false };

  // =====================================================================
  // DRAG: standing-start run with speed and distance splits
  // =====================================================================
  const SPEEDS = [60, 100, 150, 200];
  const DISTS = [{ k: 'd201', m: 201.2, name: '1/8 мили · 201 м' }, { k: 'd402', m: 402.3, name: '1/4 мили · 402 м' },
                 { k: 'd805', m: 804.7, name: '1/2 мили · 805 м' }, { k: 'd1609', m: 1609.3, name: '1 миля · 1609 м' }];
  const drag = { state: 'idle', t0: null, d: 0, vmax: 0, live: 0, run: null, last: null, roll: { t100: null, r100200: null } };
  // linear interpolation of the moment speed crossed `target` between two fixes
  const cross = (a, b, target) => a.t + (target - a.kmh) / Math.max(1e-6, b.kmh - a.kmh) * (b.t - a.t);
  const bestDrag = () => store.get('dragbest:' + teslaKey(), {});
  let flashKey = null, flashUntil = 0;
  function saveBest(k, v) {
    const b = bestDrag();
    if (b[k] == null || v < b[k]) { b[k] = v; store.set('dragbest:' + teslaKey(), b); flashKey = k; flashUntil = performance.now() + 3000; }
  }
  function finishRun() {
    const r = drag.run;
    if (r && Object.keys(r.res).length) {
      drag.last = r;
      const runs = store.get('dragruns', []); runs.unshift({ date: new Date().toISOString(), tesla: teslaShort(), res: r.res, vmax: drag.vmax });
      store.set('dragruns', runs.slice(0, 30));
    }
    drag.run = null; drag.t0 = null;
  }
  function dragFix(prev, f, seg) {
    if (f.kmh < 1) {
      if (drag.state === 'run') finishRun();
      drag.state = 'ready'; drag.t0 = null; drag.d = 0; drag.vmax = 0; drag.live = 0;
    } else if (drag.state === 'ready' && prev && prev.kmh < 1) {
      drag.state = 'run'; drag.t0 = cross(prev, f, 1); drag.d = 0; drag.vmax = 0; drag.run = { res: {} };
    }
    if (drag.state === 'run') {
      const r = drag.run.res;
      drag.d += seg; drag.vmax = Math.max(drag.vmax, f.kmh); drag.live = (f.t - drag.t0) / 1000;
      for (const v of SPEEDS) {
        if (r['v' + v] == null && prev && prev.kmh < v && f.kmh >= v) { r['v' + v] = (cross(prev, f, v) - drag.t0) / 1000; saveBest('v' + v, r['v' + v]); }
      }
      for (const D of DISTS) {
        if (r[D.k] == null && drag.d >= D.m) {
          const over = drag.d - D.m, back = seg > 0 ? over / seg : 0;           // interpolate inside the last segment
          r[D.k] = (f.t - back * (f.t - prev.t) - drag.t0) / 1000; r[D.k + 'v'] = f.kmh; saveBest(D.k, r[D.k]);
        }
      }
      // lifted off / braked → the pull is over
      if ((f.kmh < drag.vmax * 0.88 && drag.vmax > 20) || drag.live > 120) { finishRun(); drag.state = 'done'; }
    }
    // rolling 100–200 (any time)
    if (prev && prev.kmh < 100 && f.kmh >= 100) drag.roll.t100 = cross(prev, f, 100);
    if (drag.roll.t100 != null && f.kmh < 95) drag.roll.t100 = null;
    if (drag.roll.t100 != null && prev && prev.kmh < 200 && f.kmh >= 200) {
      drag.roll.r100200 = (cross(prev, f, 200) - drag.roll.t100) / 1000; saveBest('r100200', drag.roll.r100200); drag.roll.t100 = null;
    }
  }

  // =====================================================================
  // TRACK: start/finish line + laps
  // =====================================================================
  const tr = { line: store.get('trackline', null), laps: [], cur: null, lastSide: null, auto: true };
  function newLap(t) { return { t0: t, dist: 0, vmax: 0, vmin: Infinity, latG: 0, accG: 0, brkG: 0, pts: [] }; }
  function setLine(f) {
    if (!f || f.heading == null) { SE.setStatus('Нужен курс: начните движение, затем поставьте линию', 'warn'); return false; }
    tr.line = { lat: f.lat, lon: f.lon, hd: f.heading }; store.set('trackline', tr.line);
    tr.laps = []; tr.cur = null; tr.lastSide = null;
    SE.setStatus('Линия старт/финиш установлена — круги считаются при её пересечении', 'ok');
    return true;
  }
  function lapFix(prev, f, seg) {
    const L = tr.line;
    if (tr.cur) {
      const c = tr.cur, g = gNow();
      c.dist += seg; c.vmax = Math.max(c.vmax, f.kmh);
      if ((f.t - c.t0) > 3000) c.vmin = Math.min(c.vmin, f.kmh);       // skip the launch moment
      c.latG = Math.max(c.latG, g.lat); c.accG = Math.max(c.accG, g.lon); c.brkG = Math.max(c.brkG, -g.lon);
      const p = c.pts[c.pts.length - 1];
      if (!p || seg > 2) c.pts.push([f.lat, f.lon, Math.round(f.kmh)]);
    }
    if (!L || !prev) return;
    // signed distance along the line's heading: crossing = sign change near the line point
    const h = L.hd * toR, dir = [Math.sin(h), Math.cos(h)];
    const a = enu(L, prev), b = enu(L, f);
    const sa = a[0] * dir[0] + a[1] * dir[1], sb = b[0] * dir[0] + b[1] * dir[1];
    const lateral = Math.abs(b[0] * dir[1] - b[1] * dir[0]);
    const hdOk = f.heading == null || Math.abs(((f.heading - L.hd + 540) % 360) - 180) < 70;
    if (sa < 0 && sb >= 0 && lateral < 35 && hdOk) {
      const tc = prev.t + (-sa) / Math.max(1e-6, sb - sa) * (f.t - prev.t);
      if (tr.cur) {
        const c = tr.cur, time = (tc - c.t0) / 1000;
        if (time > 12 && c.dist > 150) {
          tr.laps.push({ n: tr.laps.length + 1, time, dist: c.dist, vmax: c.vmax, vmin: isFinite(c.vmin) ? c.vmin : 0,
            latG: c.latG, accG: c.accG, brkG: c.brkG, pts: c.pts });
          const best = store.get('lapbest', {}), key = L.lat.toFixed(4) + ',' + L.lon.toFixed(4);
          if (best[key] == null || time < best[key]) { best[key] = time; store.set('lapbest', best); }
        }
      }
      tr.cur = newLap(tc);
    }
  }
  const bestLapSession = () => tr.laps.length ? tr.laps.reduce((m, l) => l.time < m.time ? l : m) : null;
  const bestLapEver = () => tr.line ? store.get('lapbest', {})[tr.line.lat.toFixed(4) + ',' + tr.line.lon.toFixed(4)] : null;

  // =====================================================================
  // route recording (trip) — shown on the track map, saved to history / GPX
  // =====================================================================
  let trip = null, viewTrip = null;
  function newTrip() {
    return { id: Date.now(), date: new Date().toISOString(), tesla: teslaShort(), pts: [], dist: 0, moving: 0,
      start: null, end: null, max: 0, gain: 0, altEma: null, altRef: null };
  }
  function tripFix(prev, f, seg) {
    if (!trip) return;
    if (trip.start == null) trip.start = f.t;
    trip.end = f.t; trip.dist += seg;
    if (f.kmh > 3 && prev) trip.moving += (f.t - prev.t) / 1000;
    trip.max = Math.max(trip.max, f.kmh);
    if (f.alt != null && !isNaN(f.alt)) {
      trip.altEma = trip.altEma == null ? f.alt : trip.altEma + (f.alt - trip.altEma) * 0.2;
      if (trip.altRef == null) trip.altRef = trip.altEma;
      if (trip.altEma - trip.altRef > 2) { trip.gain += trip.altEma - trip.altRef; trip.altRef = trip.altEma; }
      else if (trip.altEma < trip.altRef - 2) trip.altRef = trip.altEma;
    }
    const p = trip.pts[trip.pts.length - 1];
    if (!p || seg > 3 || (f.t - p[3]) > 5000) trip.pts.push([+f.lat.toFixed(6), +f.lon.toFixed(6), Math.round(f.kmh), f.t, f.alt != null ? Math.round(f.alt) : null]);
  }
  function startRec() { trip = newTrip(); viewTrip = trip; if (!tr.line && last && last.heading != null) setLine(last); }
  function stopRec() {
    if (!trip) return;
    const t = trip; trip = null;
    if (t.pts.length > 1 && t.dist > 20) {
      if (t.pts.length > 1500) { const k = Math.ceil(t.pts.length / 1500); t.pts = t.pts.filter((_, i) => i % k === 0); }
      const bl = bestLapSession();
      const list = store.get('trips', []);
      list.unshift({ id: t.id, date: t.date, tesla: t.tesla, pts: t.pts, dist: t.dist, moving: t.moving, start: t.start, end: t.end,
        max: t.max, gain: t.gain, laps: tr.laps.length, bestLap: bl ? bl.time : null });
      store.set('trips', list.slice(0, 25));
    }
    viewTrip = t;
  }

  window.addEventListener('se:fix', e => {
    const f = e.detail;
    sensors.fixes++; sensors.demo = !!f.demo;
    if (f.nativeSpeed) sensors.nativeSpeed = true;
    if (f.nativeHeading) sensors.nativeHeading = true;
    if (f.alt != null && !isNaN(f.alt)) sensors.alt = true;
    sensors.acc = f.acc;
    if (f.kmh == null || f.acc > 40) return;                 // too inaccurate for distance/timers
    let seg = 0;
    if (last) {
      seg = dist(last, f);
      const dt = (f.t - last.t) / 1000;
      if (dt <= 0 || seg / Math.max(dt, 0.05) > 120) seg = 0; // reject GPS jumps (>430 km/h)
    }
    dragFix(last, f, seg);
    lapFix(last, f, seg);
    tripFix(last, f, seg);
    last = { lat: f.lat, lon: f.lon, t: f.t, kmh: f.kmh, heading: f.heading };
  });
  window.addEventListener('devicemotion', e => {
    const a = e.acceleration || e.accelerationIncludingGravity;
    if (a && (a.x != null || a.y != null)) sensors.motion = true;
  });

  // =====================================================================
  // GPX
  // =====================================================================
  function gpx(t) {
    const pts = t.pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[4] != null ? `<ele>${p[4]}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time><extensions><speed>${(p[2] / 3.6).toFixed(2)}</speed></extensions></trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Sport Engine" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${t.tesla} ${t.date}</name><trkseg>\n${pts}\n</trkseg></trk></gpx>`;
  }
  function downloadGpx(t) {
    if (!t || !t.pts || t.pts.length < 2) { SE.setStatus('Нет точек маршрута для GPX', 'warn'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([gpx(t)], { type: 'application/gpx+xml' }));
    a.download = 'trip-' + t.date.slice(0, 16).replace(/[:T]/g, '-') + '.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // =====================================================================
  // UI
  // =====================================================================
  const card = (label, val, sub, cls) =>
    `<div class="tcard${cls ? ' ' + cls : ''}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const fl = k => flashKey === k && performance.now() < flashUntil ? 'hl' : '';

  function renderDrag() {
    const r = (drag.run || drag.last || { res: {} }).res, b = bestDrag();
    const msg = { idle: 'Остановитесь полностью — таймер встанет на старт',
                  ready: 'Готов! Старт с места — замер начнётся с движением',
                  run: 'Заезд идёт… не отпускайте газ', done: 'Заезд завершён — остановитесь для нового' }[drag.state];
    $('dLive').innerHTML = `<div class="dbig">${drag.state === 'run' ? drag.live.toFixed(1) : (drag.state === 'ready' ? '0.0' : '—')}<small> с</small></div>
      <div class="dmeta"><b>${Math.round(SE.state.speed)}</b> км/ч · ${fmtKm(drag.d)} · макс ${Math.round(drag.vmax)} км/ч</div>
      <div class="dstate ${drag.state}">${msg}</div>`;
    const cells = [];
    for (const v of SPEEDS) cells.push(card(`0–${v} км/ч`, fmtSec(r['v' + v]), `лучшее ${fmtSec(b['v' + v])}`, fl('v' + v)));
    cells.push(card('100–200 км/ч', fmtSec(drag.roll.r100200), `лучшее ${fmtSec(b.r100200)} · с ходу`, fl('r100200')));
    for (const D of DISTS) cells.push(card(D.name, fmtSec(r[D.k]), `${r[D.k + 'v'] ? 'на ' + Math.round(r[D.k + 'v']) + ' км/ч · ' : ''}лучшее ${fmtSec(b[D.k])}`, fl(D.k)));
    $('dStats').innerHTML = cells.join('');
    $('dTesla').textContent = 'Лучшие результаты для: ' + teslaShort();
  }

  function renderTrack() {
    const c = tr.cur, bl = bestLapSession(), be = bestLapEver();
    const curT = c && last ? (last.t - c.t0) / 1000 : null;
    const g = gNow();
    let delta = '';
    if (curT != null && bl) { const d = curT - bl.time; delta = (d > 0 ? '+' : '') + d.toFixed(1) + ' с к лучшему'; }
    $('tStats').innerHTML = [
      card('Текущий круг', c ? fmtLap(curT) : '—', tr.line ? (c ? `${fmtKm(c.dist)} · ${delta || 'первый круг'}` : 'ждём пересечения линии') : 'поставьте линию старт/финиш'),
      card('Лучший круг', bl ? fmtLap(bl.time) : '—', be ? `рекорд трассы ${fmtLap(be)}` : 'сессия', bl ? 'hl' : ''),
      card('Скорость на круге', c ? `${Math.round(c.vmax)} / ${isFinite(c.vmin) ? Math.round(c.vmin) : '—'}` : '—', 'макс / мин, км/ч'),
      card('Перегрузки', `${g.lat.toFixed(2)} g`, c ? `круг: бок ${c.latG.toFixed(2)} · разгон ${c.accG.toFixed(2)} · торм ${c.brkG.toFixed(2)}` : 'боковая сейчас'),
    ].join('');
    const rows = tr.laps.slice().reverse().map(l => `<tr class="${bl && l === bl ? 'best' : ''}"><td>${l.n}</td><td>${fmtLap(l.time)}</td><td>${fmtKm(l.dist)}</td>
      <td>${Math.round(l.vmax)}</td><td>${Math.round(l.vmin)}</td><td>${l.latG.toFixed(2)}</td><td>${l.accG.toFixed(2)}</td><td>${l.brkG.toFixed(2)}</td></tr>`).join('');
    $('lapTable').innerHTML = `<thead><tr><th>#</th><th>Время</th><th>Длина</th><th>Макс</th><th>Мин</th><th>Бок g</th><th>Разг g</th><th>Торм g</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="empty">Круги появятся после пересечения линии старт/финиш</td></tr>'}</tbody>`;
    const yes = '✓', no = '✗';
    $('tSensors').textContent = sensors.demo ? 'Демо: имитация GPS (кольцевая трасса)' :
      `Данные браузера: GPS ${sensors.fixes ? yes : no}${sensors.acc != null ? ' ±' + Math.round(sensors.acc) + ' м' : ''} · скорость от GPS ${sensors.nativeSpeed ? yes : 'вычисляется'} · курс ${sensors.nativeHeading ? yes : 'вычисляется'} · высота ${sensors.alt ? yes : no} · датчик движения ${sensors.motion ? yes : no}`;
    $('recBtn').textContent = trip ? '■ Стоп записи' : '● Запись маршрута';
    $('recBtn').classList.toggle('on', !!trip);
    renderMap();
  }

  const cv = $('routeCv'), g = cv.getContext('2d');
  function renderMap() {
    const dpr = Math.min(2, devicePixelRatio || 1), r = cv.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const pts = (viewTrip && viewTrip.pts.length > 1) ? viewTrip.pts : (tr.cur && tr.cur.pts.length > 1 ? tr.cur.pts : (bestLapSession() || {}).pts || []);
    if (pts.length < 2) {
      g.fillStyle = '#7c8594'; g.font = `600 ${W < 420 ? 13 : 15}px -apple-system, Roboto, sans-serif`; g.textAlign = 'center';
      g.fillText('Здесь появится трасса', W / 2, H / 2);
      return;
    }
    const o = { lat: pts[0][0], lon: pts[0][1] };
    const xy = pts.map(p => { const e = enu(o, { lat: p[0], lon: p[1] }); return [e[0], -e[1]]; });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    xy.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
    const pad = 22, sc = Math.min((W - pad * 2) / Math.max(30, maxX - minX), (H - pad * 2) / Math.max(30, maxY - minY));
    const ox = (W - (maxX - minX) * sc) / 2 - minX * sc, oy = (H - (maxY - minY) * sc) / 2 - minY * sc;
    const P = ([x, y]) => [x * sc + ox, y * sc + oy];
    const vmax = Math.max(60, ...pts.map(p => p[2]));
    g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 1; i < xy.length; i++) {
      g.strokeStyle = `hsl(${120 - 120 * Math.min(1, pts[i][2] / vmax)}, 90%, 52%)`;   // green → red by speed
      const a = P(xy[i - 1]), b = P(xy[i]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    if (tr.line) {                                             // start/finish line, drawn across the heading
      const c = enu(o, tr.line), h = tr.line.hd * toR, n = [Math.cos(h) * 18, -Math.sin(h) * 18];
      const a = P([c[0] - n[0], -c[1] + n[1]]), b = P([c[0] + n[0], -c[1] - n[1]]);
      g.strokeStyle = '#fff'; g.lineWidth = 3; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
    }
    const e = P(xy[xy.length - 1]);
    g.fillStyle = '#ff3b30'; g.shadowColor = '#ff3b30'; g.shadowBlur = 12;
    g.beginPath(); g.arc(e[0], e[1], 7, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
    const meters = [50, 100, 200, 500, 1000, 2000, 5000, 10000].find(m => m * sc > 60) || 10000;
    g.strokeStyle = '#7c8594'; g.lineWidth = 2; g.beginPath(); g.moveTo(14, H - 14); g.lineTo(14 + meters * sc, H - 14); g.stroke();
    g.fillStyle = '#7c8594'; g.font = '600 12px -apple-system, Roboto, sans-serif'; g.textAlign = 'left';
    g.fillText(fmtKm(meters), 14, H - 20);
  }

  function render() {
    if (!$('dragView').hidden) renderDrag();
    if (!$('trackView').hidden) renderTrack();
  }
  setInterval(render, 250);
  window.addEventListener('resize', render);

  function renderHistory() {
    const list = store.get('trips', []), runs = store.get('dragruns', []);
    const tripsHtml = list.map((t, i) => `
      <div class="hrow" data-i="${i}">
        <div><b>${new Date(t.date).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>
          <small>${t.tesla} · ${fmtKm(t.dist)} · макс ${Math.round(t.max)} км/ч${t.laps ? ' · кругов ' + t.laps + ', лучший ' + fmtLap(t.bestLap) : ''}</small></div>
        <div class="hact"><button data-a="show">Показать</button><button data-a="gpx">GPX</button><button data-a="del" aria-label="Удалить">✕</button></div>
      </div>`).join('');
    const runsHtml = runs.slice(0, 15).map(r => `<div class="hrow"><div><b>${new Date(r.date).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · драг</b>
      <small>${r.tesla} · 0–100 ${fmtSec(r.res.v100)} · 1/4 ${fmtSec(r.res.d402)} · макс ${Math.round(r.vmax)} км/ч</small></div></div>`).join('');
    $('histList').innerHTML = (tripsHtml || runsHtml) ? tripsHtml + runsHtml : '<p class="hempty">Пока нет сохранённых поездок и заездов</p>';
  }
  $('histList').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    const row = btn.closest('.hrow'); if (row.dataset.i == null) return;
    const i = +row.dataset.i, list = store.get('trips', []), t = list[i];
    if (btn.dataset.a === 'show') { viewTrip = t; $('history').hidden = true; render(); }
    else if (btn.dataset.a === 'gpx') downloadGpx(t);
    else if (btn.dataset.a === 'del') { list.splice(i, 1); store.set('trips', list); renderHistory(); }
  });

  $('recBtn').onclick = () => { trip ? stopRec() : startRec(); render(); };
  $('lineBtn').onclick = () => { setLine(last); render(); };
  $('lapReset').onclick = () => { tr.laps = []; tr.cur = null; viewTrip = trip; render(); };
  $('dragReset').onclick = () => { drag.last = null; drag.run = null; drag.roll.r100200 = null; if (drag.state !== 'ready') drag.state = 'idle'; render(); };
  $('dragBestReset').onclick = () => { store.set('dragbest:' + teslaKey(), {}); render(); };
  $('histBtn').onclick = () => { renderHistory(); $('history').hidden = false; };
  $('dragHist').onclick = () => { renderHistory(); $('history').hidden = false; };
  $('histClose').onclick = () => { $('history').hidden = true; };
  $('history').addEventListener('click', e => { if (e.target === $('history')) $('history').hidden = true; });
  $('gpxBtn').onclick = () => downloadGpx(viewTrip || trip);

  window.SE_TRACK = { render };
})();
