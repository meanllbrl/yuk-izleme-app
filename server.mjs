// A dreamcontext App backend, zero dependencies. Keep the three rules:
//   1. listen on process.env.PORT at process.env.HOST (127.0.0.1);
//   2. refuse anything without the gateway secret (dcGuard);
//   3. keep data in process.env.DC_DATA_DIR, secrets in .env (never committed).
import http from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
const sh = promisify(execFile);
const run = async (c, a) => { try { return (await sh(c, a, { maxBuffer: 16e6 })).stdout; } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WT = os.homedir() + '/.claude-worktrees';
const HIST = [];

// Sıcaklık okuyucusu: lib/sicaklik.m -> bin/sicaklik. Açılışta bir kez derlenir; olmazsa sıcaklık "ölçülemedi" kalır.
const SENSOR_SRC = join(fileURLToPath(new URL('.', import.meta.url)), 'lib', 'sicaklik.m');
const SENSOR_BIN = join(fileURLToPath(new URL('.', import.meta.url)), 'bin', 'sicaklik');
let sensorReady = false;
async function ensureSensor() {
  try {
    const src = await stat(SENSOR_SRC);
    let fresh = false;
    try { fresh = (await stat(SENSOR_BIN)).mtimeMs >= src.mtimeMs; } catch { /* henüz yok */ }
    if (!fresh) {
      await mkdir(dirname(SENSOR_BIN), { recursive: true });
      await sh('clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'IOKit', SENSOR_SRC, '-o', SENSOR_BIN], { timeout: 60000 });
    }
    sensorReady = true;
  } catch (e) { sensorReady = false; console.error('sıcaklık okuyucusu derlenemedi:', String(e.message || e).slice(0, 300)); }
}
const sensorDone = ensureSensor();

/** "ad<TAB>derece" satırlarından işlemci sıcaklığı: YALNIZ "PMU tdie*" satırları. Sensör yoksa null (0 yazılmaz). */
export function parseTemp(out) {
  const die = []; const bat = [];
  for (const line of String(out).split('\n')) {
    const [name, val] = line.split('\t'); const v = Number(val);
    if (!name || !Number.isFinite(v) || v <= 0) continue;
    if (/^PMU tdie/.test(name)) die.push(v); else if (/gas gauge battery/.test(name)) bat.push(v);
  }
  if (!die.length) return null;
  const avg = (a) => a.reduce((t, x) => t + x, 0) / a.length;
  return { cpuAvg: avg(die), cpuMax: Math.max(...die), battery: bat.length ? avg(bat) : null, n: die.length };
}

const cpuTimes = () => os.cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); a.t += t; a.i += c.times.idle; return a; }, { t: 0, i: 0 });

/** Short name only: never the full command line (it may hold keys). */
function shortName(cmd) {
  const app = /\/([^/]+)\.app\//.exec(cmd);
  if (app) return app[1].slice(0, 28);
  const tok = cmd.split(' ').filter(Boolean);
  let n = basename(tok[0] || '?');
  if (/^(node|npm|npx|tsx|python3?|bash|sh)$/.test(n)) { const t = tok.slice(1).find((x) => !x.startsWith('-') && x.includes('/')); if (t) n = n + ':' + basename(t); }
  return n.slice(0, 28);
}
function group(cmd) {
  if (cmd.includes(WT) && !/dreamcontext-desktop/.test(cmd)) return /(^|\/)(claude|codex)( |$)/.test(cmd) ? 'Claude oturumları' : 'Dev sunucular ve testler';
  if (/dreamcontext-desktop|dreamcontext.*dashboard|dashboard.*--no-open|dreamcontext\/(dist|src)\/cli|bin\/dreamcontext/i.test(cmd) || /Dreamcontext Apps\/|\/Dreamcontext( |$)/.test(cmd)) return 'Uygulama';
  if (/(^|\/)(claude|codex)( |$)/.test(cmd)) return 'Claude oturumları';
  // Headless Chromium is what the verify runs of agents drive.
  if (cmd.includes(WT) || /chrome-headless-shell|firebase|functionsEmulator|vitest|jest|rustc|cargo|\btsc\b/.test(cmd)) return 'Dev sunucular ve testler';
  return 'Diğerleri';
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const SECRET = process.env.DC_GATEWAY_SECRET || '';

/** Only the dreamcontext gateway knows the secret: nothing else on this Mac reaches the app. */
function dcGuard(req) {
  return SECRET !== '' && req.headers['x-dc-gateway-secret'] === SECRET;
}

/** Escape text before it goes into HTML. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'";

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function measure() {
  const a = cpuTimes(); const psP = run('ps', ['-axo', 'pid,ppid,pcpu,rss,command']); await sleep(400); const b = cpuTimes();
  const cores = os.cpus().length;
  const cpu = Math.max(0, Math.min(100, 100 * (1 - (b.i - a.i) / Math.max(1, b.t - a.t))));
  await sensorDone;
  const [ps, vm, swap, df, tempOut] = await Promise.all([psP, run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage']), run('df', ['-k', '/System/Volumes/Data']), sensorReady ? run(SENSOR_BIN, []) : '']);
  const temp = parseTemp(tempOut);
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] || 16384);
  const pg = (k) => Number(new RegExp(k + ':\\s+(\\d+)').exec(vm)?.[1] || 0) * page;
  const total = os.totalmem();
  const used = Math.min(total, pg('Pages active') + pg('Pages wired down') + pg('Pages occupied by compressor'));
  const sw = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(swap);
  const d = df.trim().split('\n')[1]?.split(/\s+/) || [];
  const groups = {}; const procs = [];
  for (const line of ps.split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line); if (!m) continue;
    const g = group(m[5]); const cpuP = Number(m[3]); const mem = Number(m[4]) * 1024;
    const x = (groups[g] ||= { cpu: 0, mem: 0, n: 0 }); x.cpu += cpuP; x.mem += mem; x.n++;
    procs.push({ name: shortName(m[5]), group: g, cpu: cpuP, mem });
  }
  const sum = Object.values(groups).reduce((t, x) => t + x.cpu, 0);
  const dcCpu = ['Uygulama', 'Claude oturumları', 'Dev sunucular ve testler'].reduce((t, k) => t + (groups[k]?.cpu || 0), 0);
  const snap = {
    t: Date.now(), cores,
    machine: { cpu, load1: os.loadavg()[0], memUsed: used, memTotal: total, swapUsed: sw ? Number(sw[2]) * 1048576 : 0, swapTotal: sw ? Number(sw[1]) * 1048576 : 0, diskFree: Number(d[3] || 0) * 1024, diskTotal: Number(d[1] || 0) * 1024, temp },
    dc: { cpuCores: dcCpu / 100, share: sum ? (100 * dcCpu) / sum : 0, groups },
    topMem: [...procs].sort((x, y) => y.mem - x.mem).slice(0, 8),
    top: procs.sort((x, y) => y.cpu - x.cpu).slice(0, 8),
  };
  HIST.push({ t: snap.t, m: cpu, d: Math.min(100, dcCpu / cores), l: snap.machine.load1, c: temp ? temp.cpuAvg : null });
  if (HIST.length > 60) HIST.shift();
  return { ...snap, history: HIST };
}

const routes = {
  'GET /api/yuk': async (_req, res) => json(res, 200, await measure()),
  'GET /health': async (_req, res) => { res.writeHead(200); res.end('ok'); },
};

const server = http.createServer(async (req, res) => {
  if (!dcGuard(req)) { res.writeHead(401); res.end('unauthorized'); return; }
  const url = new URL(req.url, 'http://app');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) { await route(req, res); return; }
    // Static files from public/ (no directory escape).
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(404); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') { res.writeHead(404); res.end('not found'); return; }
    console.error(err);
    json(res, 500, { error: 'internal' });
  }
});

server.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
