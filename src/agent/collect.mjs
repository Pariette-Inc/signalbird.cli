// Toplayıcılar (AGENT-PROTOCOL.md §3.3). Hepsi tek kural altında çalışır:
// yalnız okur, hata hâlinde o ölçümü atlar. Kapalı ya da ölçülemeyen
// toplayıcının anahtarı gövdede HİÇ bulunmaz: "ölçüm yok" ile "ölçüm sıfır"
// farklı şeylerdir.
//
// Dış dünya (dosya okuma, komut, fetch, saat) `io` ile verilir; testler sahte
// /proc ve sahte komut çıktısı geçirir. Linux birincil, macOS en iyi çaba.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import { basename } from 'node:path';
import { LIMITS } from './constants.mjs';
import { makeExec } from './exec.mjs';

export function defaultIO() {
  return {
    platform: process.platform,
    readFile(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    exec: makeExec(),
    fetch: (...a) => globalThis.fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    hrtimeMs: () => Number(process.hrtime.bigint() / 1000000n),
    os: {
      loadavg: () => os.loadavg(),
      totalmem: () => os.totalmem(),
      freemem: () => os.freemem(),
      uptime: () => os.uptime(),
      cpus: () => os.cpus(),
      hostname: () => os.hostname(),
      release: () => os.release(),
      type: () => os.type(),
      machine: () => (typeof os.machine === 'function' ? os.machine() : os.arch()),
    },
  };
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;
const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : 0);
const int = (v, d = 0) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d = 0) => {
  const n = Number.parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : d;
};

// ── kimlik (hello) ──────────────────────────────────────────────────

export function osName(platform) {
  return platform === 'darwin' ? 'macos' : platform;
}

export function osVersion(io) {
  const rel = io.readFile('/etc/os-release');
  if (rel) {
    const m = rel.match(/^PRETTY_NAME=(.*)$/m);
    if (m) return m[1].replace(/"/g, '').trim();
  }
  return `${io.os.type()} ${io.os.release()}`; // `uname -sr` karşılığı
}

export function uptimeSeconds(io) {
  if (io.platform === 'linux') {
    const t = io.readFile('/proc/uptime');
    if (t) return int(t.split(/\s+/)[0]);
  }
  return Math.floor(io.os.uptime());
}

export function isoSeconds(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function helloPayload(io, { version, protocol, startedAt }) {
  const now = io.now();
  return {
    version,
    protocol,
    hostname: String(io.os.hostname()).slice(0, 190),
    os: osName(io.platform),
    os_version: osVersion(io).slice(0, 190),
    arch: String(io.os.machine()).slice(0, 20),
    boot_time: isoSeconds(now.getTime() - uptimeSeconds(io) * 1000),
    started_at: isoSeconds(startedAt || now),
  };
}

// ── sistem ──────────────────────────────────────────────────────────

/** /proc/stat "cpu " satırı → { idle, total } (idle = idle + iowait). */
export function parseProcStat(text) {
  const line = String(text || '').split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 4 || f.some((x) => !Number.isFinite(x))) return null;
  return { idle: f[3] + (f[4] || 0), total: f.reduce((a, b) => a + b, 0) };
}

export function cpuPercent(a, b) {
  if (!a || !b) return 0;
  const d = b.total - a.total;
  if (d <= 0) return 0;
  return round1((1 - (b.idle - a.idle) / d) * 100);
}

function cpusSample(io) {
  let idle = 0;
  let total = 0;
  for (const c of io.os.cpus() || []) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return total ? { idle, total } : null;
}

/**
 * CPU yüzdesi iki örnek arasındaki farktan hesaplanır: tek okuma açılıştan
 * beri geçen ortalamayı verirdi.
 */
export async function sampleCpu(io, ms = 1000) {
  const read = io.platform === 'linux' ? () => parseProcStat(io.readFile('/proc/stat')) : () => cpusSample(io);
  const a = read();
  if (!a) return 0;
  await io.sleep(ms);
  return cpuPercent(a, read());
}

export function parseMeminfo(text) {
  const kb = (k) => {
    const m = String(text || '').match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? Math.floor(Number(m[1]) / 1024) : 0;
  };
  const total = kb('MemTotal');
  const used = total - kb('MemAvailable');
  const swapTotal = kb('SwapTotal');
  const swapUsed = swapTotal - kb('SwapFree');
  return {
    memory: { total_mb: total, used_mb: used, percent: total > 0 ? round1((used / total) * 100) : 0 },
    swap: { total_mb: swapTotal, used_mb: swapUsed, percent: swapTotal > 0 ? round1((swapUsed / swapTotal) * 100) : 0 },
  };
}

export async function collectSystem(io, { cpuSampleMs = 1000 } = {}) {
  let load = io.os.loadavg();
  if (io.platform === 'linux') {
    const t = io.readFile('/proc/loadavg');
    if (t) load = t.trim().split(/\s+/).slice(0, 3).map(Number);
  }
  const out = {
    uptime_seconds: uptimeSeconds(io),
    load: { '1m': round2(load[0]), '5m': round2(load[1]), '15m': round2(load[2]) },
    cpu_percent: await sampleCpu(io, cpuSampleMs),
  };

  if (io.platform === 'linux') {
    const mem = parseMeminfo(io.readFile('/proc/meminfo'));
    out.memory = mem.memory;
    out.swap = mem.swap;
  } else {
    // macOS: takas os modülünden okunamıyor; anahtar gönderilmez.
    const total = Math.floor(io.os.totalmem() / 1048576);
    const used = total - Math.floor(io.os.freemem() / 1048576);
    out.memory = { total_mb: total, used_mb: used, percent: total > 0 ? round1((used / total) * 100) : 0 };
  }
  return out;
}

// ── disk ────────────────────────────────────────────────────────────

// Yalnız gerçek yerel dosya sistemleri (bash ajanıyla aynı süzgeç).
export const DF_EXCLUDE = ['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'nfs', 'nfs4', 'cifs'];

/** `df -P` / `df -Pi` çıktısını başlığa bakarak ayrıştırır. */
export function parseDfTable(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { head: [], rows: [] };
  const head = lines[0].trim().split(/\s+/);
  const mountIdx = head.findIndex((h) => /^mounted$/i.test(h));
  const rows = [];
  for (const l of lines.slice(1)) {
    const f = l.trim().split(/\s+/);
    if (mountIdx < 0 || f.length < mountIdx + 1) continue;
    const row = { device: f[0], mount: f.slice(mountIdx).join(' ') };
    head.slice(0, mountIdx).forEach((h, i) => (row[h.toLowerCase()] = f[i]));
    rows.push(row);
  }
  return { head: head.map((h) => h.toLowerCase()), rows };
}

export function parseDisks(dfText, dfiText, { platform = 'linux' } = {}) {
  const df = parseDfTable(dfText);
  if (!df.rows.length) return [];
  const blockCol = df.head.find((h) => /^\d+-blocks$/.test(h));
  const blockSize = blockCol ? Number(blockCol.split('-')[0]) : 1024;
  const usedCol = df.head.includes('used') ? 'used' : df.head[2];

  const inodes = new Map();
  const dfi = parseDfTable(dfiText);
  for (const r of dfi.rows) {
    const key = Object.keys(r).find((k) => /^(iuse%|%iused)$/.test(k));
    if (key) inodes.set(r.mount, int(String(r[key]).replace('%', '')));
  }

  const disks = [];
  for (const r of df.rows) {
    if (platform === 'darwin') {
      if (!r.device.startsWith('/dev/')) continue;
      if (r.mount.startsWith('/System/Volumes/') && r.mount !== '/System/Volumes/Data') continue;
    }
    const totalKb = (num(r[blockCol]) * blockSize) / 1024;
    const usedKb = (num(r[usedCol]) * blockSize) / 1024;
    disks.push({
      device: r.device,
      mount: r.mount,
      total_gb: round1(totalKb / 1048576),
      used_gb: round1(usedKb / 1048576),
      percent: totalKb > 0 ? round1((usedKb / totalKb) * 100) : 0,
      inode_percent: inodes.get(r.mount) ?? 0,
    });
  }
  return disks;
}

export function dfArgs(platform, inodes) {
  if (platform === 'linux') return [inodes ? '-Pi' : '-P', ...DF_EXCLUDE.flatMap((t) => ['-x', t])];
  return [inodes ? '-Pi' : '-Pk'];
}

export async function collectDisks(io) {
  const a = await io.exec('df', dfArgs(io.platform, false));
  if (!a.stdout) return null;
  const b = await io.exec('df', dfArgs(io.platform, true));
  return parseDisks(a.stdout, b.stdout, { platform: io.platform });
}

// ── servis ──────────────────────────────────────────────────────────

const SERVICE_NAME_RE = /^[A-Za-z0-9@._:\\-]{1,128}$/;

export function mapServiceState(raw) {
  const s = String(raw || '').trim().split('\n')[0];
  if (s === 'active') return 'running';
  if (s === 'inactive') return 'stopped';
  if (s === 'failed') return 'failed';
  return s || 'unknown';
}

/** `systemctl is-active <ad>` yalnız OKUR, servise dokunmaz. */
export async function collectServices(io, names) {
  const out = [];
  for (const name of names) {
    const n = String(name ?? '').trim();
    if (!n) continue;
    let state = 'unknown';
    // "-" ile başlayan ad bir seçenek gibi yorumlanırdı; hiç çalıştırılmaz.
    if (io.platform === 'linux' && SERVICE_NAME_RE.test(n) && !n.startsWith('-')) {
      const r = await io.exec('systemctl', ['is-active', n]);
      state = r.missing ? 'unknown' : mapServiceState(r.stdout);
    }
    out.push({ name: n, state });
  }
  return out;
}

// ── port ────────────────────────────────────────────────────────────

/** `ss -ltnpH` çıktısı → [{ port, process? }] (tekil, sıralı, en çok 50). */
export function parsePorts(text) {
  const byPort = new Map();
  for (const l of String(text || '').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 4) continue;
    const local = f[3];
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const proc = l.match(/users:\(\("([^"]+)"/)?.[1];
    if (!byPort.has(port) || (!byPort.get(port).process && proc)) {
      byPort.set(port, proc ? { port, process: proc } : { port });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, LIMITS.portsCap);
}

export async function collectPorts(io) {
  if (io.platform !== 'linux') return null; // ss yok: ölçüm yok, sıfır değil
  const r = await io.exec('ss', ['-ltnpH']);
  if (r.missing) return null;
  return parsePorts(r.stdout);
}

// ── süreç ───────────────────────────────────────────────────────────

/** `ps … comm=,pcpu=,rss=` çıktısı. Ad boşluk içerebilir: sağdan ayrıştırılır. */
export function parsePs(text, limit, { platform = 'linux' } = {}) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 3) continue;
    const rss = int(f.pop());
    const cpu = num(f.pop());
    let name = f.join(' ');
    if (platform === 'darwin') name = basename(name);
    if (!name) continue;
    out.push({ name, cpu, memory_mb: Math.floor(rss / 1024) });
    if (out.length >= limit) break;
  }
  return out;
}

export async function collectProcesses(io, limit) {
  const args = io.platform === 'linux' ? ['-eo', 'comm=,pcpu=,rss=', '--sort=-pcpu'] : ['-Ao', 'comm=,pcpu=,rss=', '-r'];
  const r = await io.exec('ps', args);
  if (!r.stdout) return null;
  return parsePs(r.stdout, limit, { platform: io.platform });
}

// ── socket.io ───────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Socket adresi YALNIZ localhost olabilir (§4): ajan, panelden verilen
 * rastgele bir adrese istek atan bir tarayıcıya dönüşmemeli. URL ayrıştırılır;
 * `http://localhost:80@evil.com/` gibi kullanıcı-bilgili adresler reddedilir.
 */
export function socketUrlAllowed(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname) && !u.username && !u.password;
}

export async function collectSocket(io, url, log = () => {}) {
  if (!socketUrlAllowed(url)) {
    log('uyari', `socket adresi localhost değil, atlandı: ${url}`);
    return null;
  }
  let json;
  try {
    // Yönlendirme izlenmez: localhost bir dış adrese yönlendiremesin.
    const res = await io.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false };
    json = JSON.parse(await res.text());
  } catch {
    return { ok: false };
  }
  if (!json || typeof json !== 'object') return { ok: false };
  return {
    ok: true,
    clients: Math.max(0, int(json.clients ?? json.connections)),
    rooms: Math.max(0, int(json.rooms)),
    events_per_second: Math.max(0, num(json.events_per_second)),
  };
}

// ── veritabanı ──────────────────────────────────────────────────────

// db_name SQL içine girer (mysql boyut sorgusu); yalnız tanımlayıcı karakterleri.
const DB_NAME_RE = /^[A-Za-z0-9_$-]{1,64}$/;

/**
 * Bağlantı bilgisi YALNIZ yerel ayardan okunur (§1.4). Parola komut satırına
 * yazılmaz (`ps` çıktısında görünürdü): MYSQL_PWD / PGPASSWORD yalnız bu
 * çağrının ortamına verilir.
 */
export async function collectDatabase(io, db) {
  if (!db?.driver) return { ok: false, error: 'yerel ayarda db_driver yok' };
  const d = db.driver.toLowerCase();
  if (d === 'mysql' || d === 'mariadb') return dbMysql(io, db);
  if (d === 'pgsql' || d === 'postgres' || d === 'postgresql') return dbPgsql(io, db);
  return { ok: false, error: 'bilinmeyen sürücü' };
}

export const MYSQL_STATUS_SQL =
  "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Slow_queries','Uptime'); SHOW GLOBAL VARIABLES LIKE 'max_connections';";

async function dbMysql(io, db) {
  const base = ['-h', db.host || '127.0.0.1', '-P', String(db.port || '3306')];
  if (db.user) base.push('-u', db.user);
  base.push('--connect-timeout=5', '-N', '-B');
  const env = { MYSQL_PWD: db.pass || '' };

  const start = io.hrtimeMs();
  const r = await io.exec('mysql', [...base, '-e', MYSQL_STATUS_SQL], { env });
  const ms = Math.max(0, Math.round(io.hrtimeMs() - start));
  if (r.missing) return { ok: false, error: 'mysql istemcisi yok' };
  if (!r.stdout.trim()) return { ok: false, driver: 'mysql', error: 'baglanti kurulamadi' };

  const vars = {};
  for (const l of r.stdout.split('\n')) {
    const [k, v] = l.split('\t');
    if (k) vars[k.trim()] = v;
  }

  let size = 0;
  if (db.name && DB_NAME_RE.test(db.name)) {
    const s = await io.exec(
      'mysql',
      [...base, '-e', `SELECT ROUND(SUM(data_length+index_length)/1048576,1) FROM information_schema.tables WHERE table_schema='${db.name}';`],
      { env },
    );
    size = num(s.stdout.trim());
  }

  return {
    ok: true,
    driver: 'mysql',
    response_ms: ms,
    connections: int(vars.Threads_connected),
    max_connections: int(vars.max_connections),
    slow_queries: int(vars.Slow_queries),
    uptime_seconds: int(vars.Uptime),
    size_mb: size,
  };
}

export const PGSQL_QUERIES = [
  'SELECT count(*) FROM pg_stat_activity;',
  'SHOW max_connections;',
  'SELECT ROUND(pg_database_size(current_database())/1048576.0,1);',
];

async function dbPgsql(io, db) {
  const base = ['-h', db.host || '127.0.0.1', '-p', String(db.port || '5432')];
  if (db.user) base.push('-U', db.user);
  base.push('-d', db.name || 'postgres');
  // Bash ajanında zaman aşımı yoktu; kilitlenen bir veritabanı turu dondurmasın.
  const env = { PGPASSWORD: db.pass || '', PGCONNECT_TIMEOUT: '5' };

  const start = io.hrtimeMs();
  const results = [];
  for (const q of PGSQL_QUERIES) {
    const r = await io.exec('psql', [...base, '-tAc', q], { env });
    if (r.missing) return { ok: false, error: 'psql istemcisi yok' };
    results.push(r.stdout.trim());
  }
  const ms = Math.max(0, Math.round(io.hrtimeMs() - start));
  if (!results[0]) return { ok: false, driver: 'pgsql', error: 'baglanti kurulamadi' };

  return {
    ok: true,
    driver: 'pgsql',
    response_ms: ms,
    connections: int(results[0]),
    max_connections: int(results[1]),
    size_mb: num(results[2]),
  };
}

// ── ölçüm gövdesi ───────────────────────────────────────────────────

/**
 * Panel ayarına göre metrics gövdesini kurar (§3.3). Patlayan toplayıcı
 * yalnız kendi anahtarını kaybeder; tur devam eder.
 */
export async function buildMetrics(io, config, conf, { log = () => {}, cpuSampleMs = 1000 } = {}) {
  const c = config?.collectors || {};
  const metrics = {};

  const guard = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      log('uyari', `${name} ölçümü atlandı: ${err.message}`);
      return null;
    }
  };

  const sys = await guard('sistem', () => collectSystem(io, { cpuSampleMs }));
  if (sys) Object.assign(metrics, sys);

  if (c.disks !== false) {
    const disks = await guard('disk', () => collectDisks(io));
    if (disks) metrics.disks = disks;
  }

  if (Array.isArray(c.services) && c.services.length) {
    const svc = await guard('servis', () => collectServices(io, c.services));
    if (svc) metrics.services = svc;
  }

  if (c.ports === true) {
    const ports = await guard('port', () => collectPorts(io));
    if (ports) metrics.ports = ports;
  }

  const procLimit = Math.min(int(c.processes), LIMITS.processesCap);
  if (procLimit > 0) {
    const procs = await guard('süreç', () => collectProcesses(io, procLimit));
    if (procs) metrics.processes = procs;
  }

  if (c.socket?.enabled === true && c.socket.url) {
    const sock = await guard('socket', () => collectSocket(io, c.socket.url, log));
    if (sock) metrics.socket = sock;
  }

  if (c.database?.enabled === true) {
    const db = await guard('veritabanı', () => collectDatabase(io, conf?.db));
    if (db) metrics.database = db;
  }

  return { collected_at: isoSeconds(io.now()), metrics };
}
