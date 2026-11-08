// Turns one measurement into the sentence on screen: why is it slow, who did it.
// Pure on purpose: no DOM, so it runs under `node --test`.
export const GROUP_NAMES = {
  'Claude oturumları': 'Claude oturumları',
  'Dev sunucular ve testler': 'Dev işleri',
  Uygulama: 'dreamcontext uygulaması',
  Diğerleri: 'Diğer uygulamalar',
};
export const GROUP_ORDER = ['Diğerleri', 'Uygulama', 'Dev sunucular ve testler', 'Claude oturumları'];

const GB = 1073741824;
/** Sıcaklık eşikleri (°C): altı normal, arası sıcak, üstü kritik. */
export const TEMP_HOT = 70;
export const TEMP_CRIT = 90;
export const tempLevel = (c) => (c > TEMP_CRIT ? 'crit' : c >= TEMP_HOT ? 'hot' : 'ok');
const num = (x, d = 1) => x.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const gb = (b, d = 1) => num(b / GB, d);
export const human = (b) => (b >= GB ? `${gb(b)} GB` : `${Math.round(b / 1048576)} MB`);

/** Who to name: a real group, or a program from the catch-all. "Diğer" alone names nobody. */
function culprit(r, key) {
  const groups = r.dc.groups;
  // CPU shares are of what `ps` adds up to; memory shares are of the memory actually in use.
  const base = key === 'mem' ? r.machine.memUsed : Object.values(groups).reduce((t, x) => t + x.cpu, 0);
  const seen = {};
  for (const [name, g] of Object.entries(groups)) if (name !== 'Diğerleri') seen[GROUP_NAMES[name] ?? name] = g[key];
  const list = key === 'mem' ? (r.topMem ?? r.top) : r.top;
  for (const p of list) if (p.group === 'Diğerleri') seen[p.name] = (seen[p.name] ?? 0) + p[key];
  const [name, value] = Object.entries(seen).sort((a, b) => b[1] - a[1])[0] ?? [];
  return name && value > 0 ? { name, share: base ? Math.min(1, value / base) : 0 } : null;
}

/** How long the machine has been above `limit` %, walking back through the history. */
function since(history, limit) {
  let start = null;
  let prev = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.m < limit || (prev !== null && prev - h.t > 30000)) break;
    start = h.t; prev = h.t;
  }
  if (start === null) return '';
  const min = Math.round((history[history.length - 1].t - start) / 60000);
  return min >= 1 ? ` ${min} dakikadır böyle.` : '';
}

/** load1 is a one-minute average: only a run of readings says it is more than a tail. */
function loadHeld(r) {
  const recent = (r.history ?? []).slice(-6);
  return recent.length === 6 && recent.every((h) => h.l > r.cores);
}

function read(r) {
  const m = r.machine;
  const memR = m.memUsed / m.memTotal;
  const swapR = m.swapUsed / m.memTotal;
  const diskKnown = m.diskTotal > 0;
  const freeR = diskKnown ? m.diskFree / m.diskTotal : 1;
  const busyCores = (m.cpu / 100) * r.cores;
  const over = m.load1 > r.cores;
  const spilling = swapR >= 0.4 && memR >= 0.7;
  const memFull = memR >= 0.9;
  const memTight = memR >= 0.8 || swapR >= 0.2;
  const diskJam = diskKnown && (freeR < 0.05 || m.diskFree < 10 * GB);
  const diskTight = diskKnown && (freeR < 0.1 || m.diskFree < 25 * GB);
  const c = culprit(r, 'cpu');
  const k = culprit(r, 'mem');
  const cCores = c ? num(busyCores * c.share) : '';
  const cpuWho = c ? `${c.name} ${cCores} çekirdek tutuyor.` : 'Süreç listesi alınamadı.';
  const memWho = k ? ` En büyüğü ${k.name}, belleğin %${Math.round(k.share * 100)} kadarı.` : '';
  const diskNote = diskTight ? ` Disk de azaldı, ${gb(m.diskFree, 0)} GB boş.` : '';
  const loadNote = loadHeld(r) ? ` Load ${num(m.load1)}, ${r.cores} çekirdeğin üstünde.` : '';
  const working = `${r.cores} çekirdeğin ${num(busyCores)} tanesi çalışıyor.`;
  const tMax = m.temp?.cpuMax;
  const throttle = tMax != null && tMax > TEMP_CRIT;
  const heatNote = throttle ? ` İşlemci ${Math.round(tMax)} °C: ısınma, işlemci yavaşlatılıyor olabilir.` : '';

  if (m.cpu >= 85) {
    return { level: 'jam', res: 'cpu', title: c ? `İşlemci dolu: ${cpuWho}` : 'İşlemci dolu.',
      detail: `${working}${since(r.history ?? [], 85)}${heatNote}${diskNote}` };
  }
  if (throttle) {
    return { level: 'jam', res: 'cpu', title: `İşlemci ${Math.round(tMax)} °C: ısınma, işlemci yavaşlatılıyor olabilir.`,
      detail: `${working}${diskNote}` };
  }
  if (spilling) {
    return { level: 'jam', res: 'mem', title: 'Bellek dolu, makine diske taşıyor.',
      detail: `Swap ${gb(m.swapUsed)} GB.${memWho}${diskNote}` };
  }
  if (memFull) {
    return { level: 'jam', res: 'mem', title: 'Bellek neredeyse dolu.',
      detail: `${gb(m.memTotal, 0)} GB belleğin ${gb(m.memUsed)} GB kadarı kullanımda.${memWho}${diskNote}` };
  }
  if (diskJam) {
    return { level: 'jam', res: 'disk', title: `Disk dolmak üzere: ${gb(m.diskFree, 0)} GB kaldı.`,
      detail: 'Disk dolunca swap da yazamaz, makine birden tıkanır.' };
  }
  if (m.cpu >= 60) {
    const who = c ? `en çok ${c.name}` : 'süreç listesi alınamadı';
    return { level: 'busy', res: 'cpu', title: `Makine yoğun: ${who}.`,
      detail: `${working} ${cpuWho}${loadNote}${diskNote}` };
  }
  if (memTight || diskTight) {
    const res = memTight ? 'mem' : 'disk';
    return { level: 'busy', res, title: memTight ? 'Bellek sıkışıyor.' : 'Disk azalıyor.',
      detail: memTight ? `Swap ${gb(m.swapUsed)} GB.${memWho}${loadNote}${diskNote}` : `${gb(m.diskFree, 0)} GB boş.${loadNote}` };
  }
  if (loadHeld(r)) {
    return { level: 'busy', res: 'cpu', title: `Load ${num(m.load1)}, ${r.cores} çekirdeğin üstünde.`,
      detail: `İşlemci %${Math.round(m.cpu)} dolu. Bu ölçüm sebebini göstermiyor.` };
  }
  return { level: 'calm', res: 'cpu', title: 'Makine sakin, yavaşlatan bir şey yok.',
    detail: over ? `${working} Load ${num(m.load1)}, bir dakikalık ortalama.` : working };
}

/** `key` is what must hold to change the screen: resource and level, never the name in the sentence. */
export function verdict(r) {
  const v = read(r);
  return { ...v, key: `${v.res}:${v.level}` };
}

/** dreamcontext and dev work, on the same busy-core basis as the rows above it. */
export function dcShare(r) {
  const g = r.dc.groups;
  const sum = (keys) => keys.reduce((t, k) => t + (g[k]?.cpu ?? 0), 0);
  const all = sum(Object.keys(g));
  const share = all ? sum(['Uygulama', 'Claude oturumları', 'Dev sunucular ve testler']) / all : 0;
  if (!all) return null;
  return { percent: share * 100, cores: share * (r.machine.cpu / 100) * r.cores };
}

/** Evenly spaced round marks, at most eight, like the numerals painted on a hull. */
export function marks(max) {
  const step = [1, 2, 4, 8, 16, 32, 64, 128, 256].find((s) => max / s <= 8) ?? 512;
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

/** What the hold carries for one resource: cargo by group, the limit, what spills over it. */
export function holdFor(r, res) {
  const m = r.machine;
  const groups = r.dc.groups;
  const key = res === 'cpu' ? 'cpu' : 'mem';
  const sum = Object.values(groups).reduce((t, x) => t + x[key], 0);
  if (res === 'disk' && !m.diskTotal) {
    return { unit: 'GB', cap: 1, top: 1, over: 0, overText: '', cargo: [], lineText: 'Disk ölçülemedi', note: '' };
  }
  if (res === 'disk') {
    const t = m.diskTotal / GB;
    return { unit: 'GB', cap: t, top: t * 1.08, over: 0, overText: '',
      cargo: [{ id: 'Dolu', name: 'Dolu alan', value: t - m.diskFree / GB }],
      lineText: `${gb(m.diskTotal, 0)} GB`, note: 'Disk grup grup ölçülmüyor.' };
  }
  if (res === 'mem') {
    const t = m.memTotal / GB; const used = m.memUsed / GB; const swap = m.swapUsed / GB;
    // Group sizes stay the real ones the list shows; what they leave of `used` is the system.
    if (!sum) {
      return { unit: 'GB', cap: t, top: Math.max(t * 1.2, (t + swap) * 1.04), over: swap, overText: `Swap ${gb(m.swapUsed)} GB`,
        cargo: [{ id: 'Dolu', name: 'Kullanılan', value: used }], lineText: `${gb(m.memTotal, 0)} GB bellek`, note: 'Süreç listesi alınamadı.' };
    }
    const scale = Math.min(1, (used * GB) / sum);
    const cargo = GROUP_ORDER.filter((g) => groups[g]).map((g) => ({ id: g, name: GROUP_NAMES[g], value: (groups[g].mem * scale) / GB }));
    const rest = used - cargo.reduce((a, c) => a + c.value, 0);
    if (rest > 0.05) cargo.unshift({ id: 'Sistem', name: 'macOS ve önbellek', value: rest });
    return { unit: 'GB', cap: t, top: Math.max(t * 1.2, (t + swap) * 1.04), over: swap, overText: `Swap ${gb(m.swapUsed)} GB`,
      cargo,
      lineText: `${gb(m.memTotal, 0)} GB bellek`, note: 'Çizginin üstü diske taşan bellek.' };
  }
  const busy = (m.cpu / 100) * r.cores; const queue = Math.max(0, m.load1 - r.cores);
  return { unit: 'çekirdek', cap: r.cores, top: Math.max(r.cores * 1.25, (r.cores + queue) * 1.04), over: queue,
    overText: queue ? `Load ${num(m.load1)}` : '',
    cargo: sum ? GROUP_ORDER.filter((g) => groups[g]).map((g) => ({ id: g, name: GROUP_NAMES[g], value: (busy * groups[g].cpu) / sum }))
      : [{ id: 'Dolu', name: 'Çalışan', value: busy }],
    lineText: `${r.cores} çekirdek`, note: 'Çizginin üstü son bir dakikanın load fazlası.' };
}
