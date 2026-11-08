// Page code (CSP forbids inline script). All text goes in via textContent.
import { verdict, dcShare, holdFor, marks, gb, human, tempLevel, GROUP_NAMES } from './verdict.js';

const POLL_MS = 5000;
const FIVE_MIN = 300000;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const num = (x, d = 1) => x.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const clock = (t) => new Date(t).toLocaleTimeString('tr-TR');
const CLASS = { 'Claude oturumları': 'g-claude', 'Dev sunucular ve testler': 'g-dev', Uygulama: 'g-app', Diğerleri: 'g-other', Dolu: 'g-disk', Sistem: 'g-sys' };

let last = null;        // the newest measurement
let shownKey = null;    // the verdict kind on screen
let waited = false;     // a different kind was seen once: a second differing reading shows it
let shownRes = 'cpu';   // the resource the verdict points at
let picked = null;      // the resource the owner chose, held for a minute; null = follow the verdict
let pickedAt = 0;
let order = [];         // group order, re-ranked slowly so rows do not jump
let orderRes = null;
let ticks = 0;
let lastTitle = null;

function paintVerdict(v) {
  if (shownKey !== null && v.key !== shownKey && !waited) { waited = true; return; }
  waited = false; shownKey = v.key; shownRes = v.res;
  document.querySelector('.verdict').dataset.level = v.level;
  if (v.title !== lastTitle) { $('title').textContent = v.title; lastTitle = v.title; }
  $('detail').textContent = v.detail;
}

function paintHold(r, res) {
  const h = holdFor(r, res);
  $('hull').classList.add('ready');
  const pct = (x) => (100 * x) / h.top;
  const sig = `${res}:${Math.round(h.top)}`;
  const box = $('marks');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.replaceChildren(...marks(h.cap).filter((v) => v > 0 && v < h.cap).map((v) => { const s = el('span', null, String(v)); s.style.bottom = pct(v) + '%'; return s; }));
  }
  $('line').style.bottom = pct(h.cap) + '%';
  $('line-text').textContent = h.lineText;
  const over = $('over');
  over.style.bottom = pct(h.cap) + '%';
  over.style.height = pct(h.over) + '%';
  over.classList.toggle('tiny', pct(h.over) < 4);
  over.hidden = h.over <= 0;
  $('over-text').textContent = h.overText;

  const carried = h.cargo.reduce((t, c) => t + c.value, 0);
  const stack = $('stack');
  stack.style.height = pct(carried) + '%';
  const seen = new Set();
  for (const c of h.cargo) {
    seen.add(c.id);
    let b = stack.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
    if (!b) { b = el('div', `box ${CLASS[c.id] ?? ''}`); b.dataset.id = c.id; b.append(el('span'), el('b')); stack.append(b); }
    const share = carried ? (100 * c.value) / carried : 0;
    b.style.height = share + '%';
    b.children[0].textContent = c.name;
    b.children[1].textContent = num(c.value, c.id === 'Dolu' ? 0 : 1);
    b.classList.toggle('short', pct(c.value) < 5);
  }
  for (const b of [...stack.children]) if (!seen.has(b.dataset.id)) b.remove();
  $('hull-note').textContent = h.over > 0 ? h.note : '';
}

function paintRes(r, res) {
  const m = r.machine;
  $('res-cpu').textContent = `%${Math.round(m.cpu)}`;
  $('res-cpu-note').textContent = `load ${num(m.load1)}, ${r.cores} çekirdek`;
  $('res-mem').textContent = `${gb(m.memUsed)} GB`;
  $('res-mem-note').textContent = `${gb(m.memTotal, 0)} GB içinde, swap ${gb(m.swapUsed)}`;
  $('res-disk').textContent = m.diskTotal ? `${gb(m.diskFree, 0)} GB` : '–';
  $('res-disk-note').textContent = m.diskTotal ? `boş, ${gb(m.diskTotal, 0)} GB içinde` : 'ölçülemedi';
  const t = m.temp;
  $('res-temp').textContent = t ? `${Math.round(t.cpuAvg)} °C` : '–';
  $('res-temp-note').textContent = t ? `en yüksek ${Math.round(t.cpuMax)}, ${t.n} sensör` : 'ölçülemedi';
  const tl = t ? tempLevel(t.cpuMax) : 'none';
  $('res-temp-box').dataset.temp = tl;
  const v = verdict(r);
  for (const b of document.querySelectorAll('.res-btn')) {
    b.setAttribute('aria-pressed', String(b.dataset.res === res));
    if (b.dataset.res === v.res && v.level !== 'calm') b.dataset.state = v.level; else delete b.dataset.state;
  }
}

function paintGroups(r, res) {
  const useMem = res !== 'cpu';
  const key = useMem ? 'mem' : 'cpu';
  const g = r.dc.groups;
  const sum = Object.values(g).reduce((t, x) => t + x[key], 0) || 1;
  const fresh = Object.keys(g).sort((a, b) => g[b][key] - g[a][key]);
  if (orderRes !== key || ticks % 6 === 0 || order.length !== fresh.length || order.some((k) => !g[k])) { order = fresh; orderRes = key; }
  $('who-title').textContent = useMem ? 'Belleği tutanlar' : 'İşlemciyi tutanlar';
  const busy = (r.machine.cpu / 100) * r.cores;
  $('groups').replaceChildren(...order.map((k) => {
    const x = g[k];
    const li = el('li');
    const names = (useMem ? r.topMem ?? r.top : r.top).filter((p) => p.group === k).sort((a, b) => b[key] - a[key]).map((p) => p.name).filter((n, i, all) => all.indexOf(n) === i).slice(0, 2);
    const sub = `${x.n} süreç, ${human(x.mem)} bellek` + (names.length ? `. En ağırı ${names.join(' ve ')}` : '');
    li.append(el('span', `chip ${CLASS[k] ?? ''}`), el('span', 'g-name', GROUP_NAMES[k] ?? k),
      el('span', 'g-val', useMem ? human(x.mem) : `${num((busy * x.cpu) / sum)} çekirdek`), el('span', 'g-sub', sub));
    return li;
  }));
  const d = dcShare(r);
  if (d) $('share').replaceChildren('dreamcontext ve dev işleri, çalışan işlemcinin ', el('b', null, `%${Math.round(d.percent)}`), ` kadarını kullanıyor: ${num(d.cores)} çekirdek.`);
  else $('share').textContent = 'Süreç listesi alınamadı, paylar bu ölçümde yok.';
}

function paintTide(r) {
  const NS = 'http://www.w3.org/2000/svg';
  const now = r.t;
  const pts = (r.history ?? []).filter((h) => now - h.t <= FIVE_MIN);
  const x = (t) => 600 - (600 * (now - t)) / FIVE_MIN;
  const area = (k, cls) => {
    const p = document.createElementNS(NS, 'polygon');
    p.setAttribute('class', cls);
    if (pts.length) p.setAttribute('points', [`${x(pts[0].t)},100`, ...pts.map((h) => `${x(h.t).toFixed(1)},${(100 - h[k]).toFixed(1)}`), `${x(pts.at(-1).t)},100`].join(' '));
    return p;
  };
  const limit = document.createElementNS(NS, 'line');
  limit.setAttribute('class', 'limit');
  for (const [a, v] of [['x1', 0], ['x2', 600], ['y1', 15], ['y2', 15]]) limit.setAttribute(a, v);
  const line = document.createElementNS(NS, 'path');
  line.setAttribute('class', 'temp');
  let started = false; let d = '';
  for (const h of pts) {
    if (h.c == null) { started = false; continue; }
    d += `${started ? 'L' : 'M'}${x(h.t).toFixed(1)},${(100 - Math.min(100, h.c)).toFixed(1)}`; started = true;
  }
  if (d) line.setAttribute('d', d);
  $('tide').replaceChildren(area('m', 'm'), area('d', 'd'), limit, line);
}

function paintTop(r) {
  $('top').replaceChildren(...r.top.map((p) => {
    const tr = el('tr');
    tr.append(el('td', null, p.name), el('td', 'grp', GROUP_NAMES[p.group] ?? p.group), el('td', 'n', `%${num(p.cpu)}`), el('td', 'n', human(p.mem)));
    return tr;
  }));
}

function paint(r) {
  if (picked && Date.now() - pickedAt > 60000) picked = null;
  const res = picked ?? shownRes;
  paintHold(r, res); paintRes(r, res); paintGroups(r, res); paintTide(r); paintTop(r);
  $('stamp').textContent = `${clock(r.t)} ölçümü, 5 saniyede bir yenilenir`;
}

async function tick() {
  let r = null;
  try {
    if (!document.hidden) {
      const res = await fetch('/api/yuk', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(String(res.status));
      r = await res.json();
    }
  } catch {
    document.querySelector('.verdict').dataset.stale = 'true';
    $('stamp').textContent = last ? `Ölçüm alınamadı, ekrandaki veri ${clock(last.t)} ölçümü` : 'Ölçüm alınamadı, yeniden deneniyor';
  }
  if (r) {
    try {
      last = r;
      paintVerdict(verdict(r));
      paint(r);
      ticks++;
      delete document.querySelector('.verdict').dataset.stale;
    } catch (e) {
      console.error('paint', e);
      document.querySelector('.verdict').dataset.stale = 'true';
      $('stamp').textContent = `Ölçüm ekrana basılamadı: ${e.message}`;
    }
  }
  setTimeout(tick, POLL_MS);
}
tick();

for (const b of document.querySelectorAll('.res-btn')) {
  b.addEventListener('click', () => { picked = b.dataset.res; pickedAt = Date.now(); if (last) paint(last); });
}

