// Sunucu ajanı: yük kurucular (sahte /proc ve sahte komut), log konumu ve
// dönme, allow_paths, sahte API ile hello/metrics/logs/signal ve §9 kuralları.
// Testler gerçek makinede komut çalıştırmaz (io enjekte edilir).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';

import { makeAgentClient } from '../src/agent/client.mjs';
import {
  buildMetrics,
  collectDatabase,
  collectSystem,
  cpuPercent,
  helloPayload,
  parseDisks,
  parseMeminfo,
  parsePorts,
  parseProcStat,
  parsePs,
  socketUrlAllowed,
} from '../src/agent/collect.mjs';
import { loadConf, parseConf, writeConf } from '../src/agent/conf.mjs';
import { AGENT_VERSION, EXIT_AUTH, LIMITS } from '../src/agent/constants.mjs';
import { ALLOWED_COMMANDS, makeExec } from '../src/agent/exec.mjs';
import { collectLogs, commitPending, offsetDecision, pathAllowed, StateStore, stateKey } from '../src/agent/logs.mjs';
import { AgentRunner, AuthError, intervals } from '../src/agent/runner.mjs';
import { ephemeralBin, unitText } from '../src/agent/service.mjs';
import { fileSignals, signalBody } from '../src/agent/signals.mjs';

const BIN = fileURLToPath(new URL('../bin/signalbird.mjs', import.meta.url));
const TOKEN = 'sba_live_TESTTOKEN1234567890';

// ── sahte sistem ────────────────────────────────────────────────────

const PROC = {
  '/proc/uptime': '183600.52 700000.10\n',
  '/proc/loadavg': '0.42 0.51 0.48 1/123 4567\n',
  '/proc/meminfo': 'MemTotal:        8151040 kB\nMemFree:          100000 kB\nMemAvailable:    4956160 kB\nSwapTotal:       2097152 kB\nSwapFree:        2097152 kB\n',
  '/etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
};
// iki /proc/stat örneği: toplam fark 1000, idle+iowait farkı 876 → %12.4
const STAT_A = 'cpu  1000 0 1000 7000 1000 0 0 0 0 0\ncpu0 1 1 1 1\n';
const STAT_B = 'cpu  1062 0 1062 7800 1076 0 0 0 0 0\ncpu0 1 1 1 1\n';

const DF = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         81998848 43934208  38064640      54% /
/dev/sdb1         10485760  1048576   9437184      10% /srv/my data
`;
const DFI = `Filesystem      Inodes  IUsed   IFree IUse% Mounted on
/dev/sda1      5242880 576716 4666164   11% /
/dev/sdb1       655360   6553  648807    1% /srv/my data
`;
const SS = `LISTEN 0      511          0.0.0.0:443        0.0.0.0:*    users:(("nginx",pid=812,fd=6),("nginx",pid=811,fd=6))
LISTEN 0      511             [::]:443           [::]:*    users:(("nginx",pid=812,fd=7))
LISTEN 0      151        127.0.0.1:3306       0.0.0.0:*    users:(("mysqld",pid=900,fd=21))
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*
`;
const PS = `php-fpm8.3        8.1 245760
tmux: server      2.0  4096
nginx             0.5  10240
`;

function fakeIO({ platform = 'linux', files = PROC, exec, stats = [STAT_A, STAT_B], fetch } = {}) {
  const calls = [];
  let statIdx = 0;
  return {
    calls,
    platform,
    readFile(p) {
      if (p === '/proc/stat') return stats[Math.min(statIdx++, stats.length - 1)];
      return files[p] ?? null;
    },
    async exec(cmd, args, opts = {}) {
      if (!ALLOWED_COMMANDS.includes(cmd)) throw new Error(`izinsiz komut: ${cmd}`);
      calls.push({ cmd, args, env: opts.env });
      const r = exec ? exec(cmd, args, opts) : null;
      return { ok: true, stderr: '', missing: false, stdout: '', ...(r || {}) };
    },
    fetch: fetch || (async () => ({ ok: false, text: async () => '' })),
    sleep: async () => {},
    now: () => new Date('2026-10-14T09:00:00Z'),
    hrtimeMs: (() => {
      let t = 0;
      return () => (t += 3);
    })(),
    os: {
      loadavg: () => [9, 9, 9],
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 4 * 1024 ** 3,
      uptime: () => 1000,
      cpus: () => [],
      hostname: () => 'web-01',
      release: () => '6.8.0',
      type: () => 'Linux',
      machine: () => 'x86_64',
    },
  };
}

const linuxExec = (cmd, args) => {
  if (cmd === 'df') return { stdout: args[0] === '-Pi' ? DFI : DF };
  if (cmd === 'ss') return { stdout: SS };
  if (cmd === 'ps') return { stdout: PS };
  if (cmd === 'systemctl') return { stdout: { nginx: 'active\n', redis: 'inactive\n', mysql: 'failed\n' }[args[1]] ?? '', ok: args[1] === 'nginx' };
  return { stdout: '' };
};

// ── yük kurucular ───────────────────────────────────────────────────

describe('yük kurucular (§3.1, §3.3)', () => {
  test('hello gövdesi: şemadaki alanlar ve biçimler', () => {
    const io = fakeIO();
    const body = helloPayload(io, { version: AGENT_VERSION, protocol: 1, startedAt: new Date('2026-10-14T08:59:00Z') });
    assert.deepEqual(Object.keys(body).sort(), ['arch', 'boot_time', 'hostname', 'os', 'os_version', 'protocol', 'started_at', 'version']);
    assert.equal(body.os, 'linux');
    assert.equal(body.os_version, 'Ubuntu 24.04.1 LTS');
    assert.equal(body.arch, 'x86_64');
    assert.equal(body.hostname, 'web-01');
    assert.equal(body.protocol, 1);
    assert.equal(body.boot_time, '2026-10-12T06:00:00Z'); // 09:00 - 183600 sn
    assert.equal(body.started_at, '2026-10-14T08:59:00Z');
    assert.ok(body.version.length <= 20);
  });

  test('/proc/stat iki örnek → CPU yüzdesi; meminfo → bellek ve takas', async () => {
    assert.equal(cpuPercent(parseProcStat(STAT_A), parseProcStat(STAT_B)), 12.4);
    assert.equal(parseProcStat('yok'), null);
    assert.deepEqual(parseMeminfo(PROC['/proc/meminfo']), {
      memory: { total_mb: 7960, used_mb: 3120, percent: 39.2 },
      swap: { total_mb: 2048, used_mb: 0, percent: 0 },
    });
    const sys = await collectSystem(fakeIO(), { cpuSampleMs: 0 });
    assert.deepEqual(sys, {
      uptime_seconds: 183600,
      load: { '1m': 0.42, '5m': 0.51, '15m': 0.48 },
      cpu_percent: 12.4,
      memory: { total_mb: 7960, used_mb: 3120, percent: 39.2 },
      swap: { total_mb: 2048, used_mb: 0, percent: 0 },
    });
  });

  test('df -P / df -Pi → disks (boşluklu bağlama noktası dahil)', () => {
    assert.deepEqual(parseDisks(DF, DFI), [
      { device: '/dev/sda1', mount: '/', total_gb: 78.2, used_gb: 41.9, percent: 53.6, inode_percent: 11 },
      { device: '/dev/sdb1', mount: '/srv/my data', total_gb: 10, used_gb: 1, percent: 10, inode_percent: 1 },
    ]);
    assert.deepEqual(parseDisks('', ''), []);
  });

  test('ss -ltnpH → tekil portlar ve süreç adı', () => {
    assert.deepEqual(parsePorts(SS), [{ port: 53 }, { port: 443, process: 'nginx' }, { port: 3306, process: 'mysqld' }]);
  });

  test('ps → süreçler; boşluklu ad sağdan ayrıştırılır, sınır uygulanır', () => {
    assert.deepEqual(parsePs(PS, 2), [
      { name: 'php-fpm8.3', cpu: 8.1, memory_mb: 240 },
      { name: 'tmux: server', cpu: 2, memory_mb: 4 },
    ]);
  });

  test('socket adresi yalnız localhost (kullanıcı bilgili / dış adres reddedilir)', () => {
    assert.ok(socketUrlAllowed('http://127.0.0.1:3000/metrics'));
    assert.ok(socketUrlAllowed('http://localhost:3000/metrics'));
    assert.ok(socketUrlAllowed('http://[::1]:3000/'));
    assert.ok(!socketUrlAllowed('http://localhost:80@evil.com/'));
    assert.ok(!socketUrlAllowed('http://user:pw@127.0.0.1:3000/'));
    assert.ok(!socketUrlAllowed('https://evil.com/metrics'));
    assert.ok(!socketUrlAllowed('http://10.0.0.5:3000/'));
    assert.ok(!socketUrlAllowed('file:///etc/passwd'));
    assert.ok(!socketUrlAllowed(null));
  });

  test('buildMetrics: kapalı toplayıcının anahtarı hiç yok; yalnız izinli komutlar', async () => {
    const io = fakeIO({ exec: linuxExec });
    const body = await buildMetrics(io, { collectors: { system: true, disks: false, services: [], ports: false, processes: 0, socket: { enabled: false, url: null }, database: { enabled: false } } }, { db: {} }, { cpuSampleMs: 0 });
    assert.equal(body.collected_at, '2026-10-14T09:00:00Z');
    assert.deepEqual(Object.keys(body.metrics).sort(), ['cpu_percent', 'load', 'memory', 'swap', 'uptime_seconds']);
    assert.equal(io.calls.length, 0);
  });

  test('buildMetrics: hepsi açık → şemadaki anahtarlar', async () => {
    const fetchCalls = [];
    const io = fakeIO({
      exec: (cmd, args, opts) => {
        if (cmd === 'mysql') {
          return /SHOW GLOBAL STATUS/.test(args.at(-1))
            ? { stdout: 'Threads_connected\t24\nSlow_queries\t0\nUptime\t900000\nmax_connections\t151\n' }
            : { stdout: '2410.0\n' };
        }
        return linuxExec(cmd, args, opts);
      },
      fetch: async (url, opts) => {
        fetchCalls.push({ url, opts });
        return { ok: true, text: async () => JSON.stringify({ clients: 184, rooms: 22, events_per_second: 41.5 }) };
      },
    });
    const config = {
      collectors: {
        disks: true,
        services: ['nginx', 'redis', 'mysql', '--help'],
        ports: true,
        processes: 99,
        socket: { enabled: true, url: 'http://127.0.0.1:3000/metrics' },
        database: { enabled: true },
      },
    };
    const conf = { db: { driver: 'mysql', host: '127.0.0.1', port: '3306', user: 'ro', pass: 'S3CRET pass', name: 'penyu' } };
    const { metrics } = await buildMetrics(io, config, conf, { cpuSampleMs: 0 });

    assert.deepEqual(Object.keys(metrics).sort(), ['cpu_percent', 'database', 'disks', 'load', 'memory', 'ports', 'processes', 'services', 'socket', 'swap', 'uptime_seconds']);
    assert.deepEqual(metrics.services, [
      { name: 'nginx', state: 'running' },
      { name: 'redis', state: 'stopped' },
      { name: 'mysql', state: 'failed' },
      { name: '--help', state: 'unknown' },
    ]);
    assert.deepEqual(metrics.socket, { ok: true, clients: 184, rooms: 22, events_per_second: 41.5 });
    assert.equal(fetchCalls[0].opts.redirect, 'error');
    assert.deepEqual(metrics.database, { ok: true, driver: 'mysql', response_ms: 3, connections: 24, max_connections: 151, slow_queries: 0, uptime_seconds: 900000, size_mb: 2410 });
    assert.equal(metrics.processes.length, 3);

    // Komut listesi docs/AGENT-COMMANDS.md ile aynı; parola hiçbir argümanda yok.
    for (const c of io.calls) {
      assert.ok(ALLOWED_COMMANDS.includes(c.cmd));
      assert.ok(!c.args.join(' ').includes('S3CRET'), `${c.cmd} argümanında parola`);
    }
    const mysqlCall = io.calls.find((c) => c.cmd === 'mysql');
    assert.equal(mysqlCall.env.MYSQL_PWD, 'S3CRET pass');
    assert.deepEqual(io.calls.find((c) => c.cmd === 'ps').args, ['-eo', 'comm=,pcpu=,rss=', '--sort=-pcpu']);
    assert.deepEqual(io.calls.find((c) => c.cmd === 'ss').args, ['-ltnpH']);
    assert.deepEqual(io.calls.filter((c) => c.cmd === 'systemctl').map((c) => c.args), [['is-active', 'nginx'], ['is-active', 'redis'], ['is-active', 'mysql']]);
  });

  test('veritabanı: istemci yok, bağlantı yok, sürücü yok, zararlı db_name', async () => {
    const missing = fakeIO({ exec: () => ({ ok: false, missing: true }) });
    assert.deepEqual(await collectDatabase(missing, { driver: 'mysql' }), { ok: false, error: 'mysql istemcisi yok' });
    assert.deepEqual(await collectDatabase(missing, { driver: 'pgsql' }), { ok: false, error: 'psql istemcisi yok' });
    const down = fakeIO({ exec: () => ({ ok: false, stdout: '' }) });
    assert.deepEqual(await collectDatabase(down, { driver: 'mysql' }), { ok: false, driver: 'mysql', error: 'baglanti kurulamadi' });
    assert.deepEqual(await collectDatabase(down, {}), { ok: false, error: 'yerel ayarda db_driver yok' });

    const io = fakeIO({ exec: () => ({ stdout: 'Threads_connected\t1\n' }) });
    await collectDatabase(io, { driver: 'mysql', name: "x'; DROP TABLE t; --" });
    assert.equal(io.calls.length, 1, 'geçersiz db_name ile boyut sorgusu çalışmaz');

    const pg = fakeIO({ exec: (cmd, args) => ({ stdout: { 'SHOW max_connections;': '100\n' }[args.at(-1)] ?? (args.at(-1).includes('pg_stat_activity') ? '7\n' : '12.5\n') }) });
    const r = await collectDatabase(pg, { driver: 'postgres', user: 'ro', pass: 'pw', name: 'app' });
    assert.deepEqual(r, { ok: true, driver: 'pgsql', response_ms: 3, connections: 7, max_connections: 100, size_mb: 12.5 });
    assert.equal(pg.calls[0].env.PGPASSWORD, 'pw');
    assert.equal(pg.calls[0].env.PGCONNECT_TIMEOUT, '5');
  });

  test('exec beyaz listesi: listede olmayan komut çalışmaz', async () => {
    const exec = makeExec();
    await assert.rejects(exec('curl', ['http://evil']), /izinsiz komut/);
    await assert.rejects(exec('sh', ['-c', 'id']), /izinsiz komut/);
    assert.deepEqual([...ALLOWED_COMMANDS].sort(), ['df', 'mysql', 'ps', 'psql', 'ss', 'systemctl']);
  });

  test('sinyal gövdesi ve dosya sinyalleri', () => {
    assert.deepEqual(signalBody('db-backup', 'ok', 'tamam'), { key: 'db-backup', status: 'ok', message: 'tamam' });
    assert.deepEqual(signalBody('k', 'fail'), { key: 'k', status: 'fail' });
    assert.throws(() => signalBody('k', 'failed'), /ok" ya da "fail/);
    assert.throws(() => signalBody('', 'ok'), /anahtarı gerekli/);
    assert.equal(signalBody('k', 'ok', 'x'.repeat(900)).message.length, LIMITS.signalMessage);

    const dir = tmp('sbagent-sig-');
    const fresh = join(dir, 'fresh.gz');
    const stale = join(dir, 'stale.gz');
    writeFileSync(fresh, 'x'.repeat(2048));
    writeFileSync(stale, 'x');
    const now = Date.now();
    utimesSync(stale, new Date(now - 3 * 3600e3), new Date(now - 3 * 3600e3));
    const out = fileSignals(
      [
        { key: 'a', mode: 'file', path: fresh, max_age_minutes: 70 },
        { key: 'b', mode: 'file', path: stale, max_age_minutes: 70 },
        { key: 'c', mode: 'file', path: join(dir, 'yok') },
        { key: 'd', mode: 'manual' },
      ],
      { now },
    );
    assert.deepEqual(out.map((s) => [s.key, s.status]), [['a', 'ok'], ['c', 'fail']]);
    assert.match(out[0].message, /0 dakika önce güncellendi \(2\.0K\)/);
  });

  test('aralıklar §4 sınırlarına kırpılır', () => {
    assert.deepEqual(intervals(null), { interval: 60, refresh: 300 });
    assert.deepEqual(intervals({ interval_seconds: 5, config_refresh_seconds: 10 }), { interval: 30, refresh: 60 });
    assert.deepEqual(intervals({ interval_seconds: 99999, config_refresh_seconds: 'x' }), { interval: 3600, refresh: 300 });
  });
});

// ── yerel ayar ──────────────────────────────────────────────────────

describe('yerel ayar (§5)', () => {
  test('ayrıştırma, anahtar türü, signalbird.app uyarısı, kurulumda korunma', () => {
    const dir = tmp('sbagent-conf-');
    const p = join(dir, 'agent.conf');
    assert.deepEqual(parseConf('# yorum\n token = sba_live_x \ndb_pass= a b=c \nbilinmeyen=1\n'), { token: 'sba_live_x', db_pass: 'a b=c' });

    writeFileSync(p, 'token=sbf_live_abcdefghijkl\n');
    assert.throws(() => loadConf(p), /yalnız sba_live_/);
    writeFileSync(p, 'token=sb_secret_live_abc\n');
    assert.throws(() => loadConf(p), /yalnız sba_live_/);

    const warnings = [];
    writeFileSync(p, `token=${TOKEN}\napi_base=https://api.signalbird.app/api\nallow_paths=/var/log/, /srv/app/logs\ndb_driver=mysql\ndb_pass=gizli\n`);
    const c = loadConf(p, (lvl, m) => warnings.push(m));
    assert.equal(c.api, 'https://live.signalbird.io/api');
    assert.deepEqual(c.allowPaths, ['/var/log', '/srv/app/logs']);
    assert.equal(c.db.pass, 'gizli');
    assert.match(warnings[0], /api_base geçersiz/);

    writeConf(p, { token: 'sba_live_NEW', api: 'http://localhost:8000/api' });
    const text = readFileSync(p, 'utf8');
    assert.match(text, /^token=sba_live_NEW$/m);
    assert.match(text, /^db_pass=gizli$/m, 'veritabanı satırı korunur');
    assert.match(text, /^allow_paths=\/var\/log\/, \/srv\/app\/logs$/m, '--allow verilmezse izinli yollar korunur');
    assert.equal(text.match(/^token=/gm).length, 1);
    if (process.platform !== 'win32') assert.equal((spawnSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', p] : ['-c', '%a', p]).stdout + '').trim(), '600');
  });

  test('CLI: agent rolü sba_live_ dışı anahtarı reddeder; fix rolü etkilenmez', () => {
    const dir = tmp('sbagent-cli-');
    const conf = join(dir, 'agent.conf');
    writeFileSync(conf, 'token=sbf_live_abcdefghijklmnop\n');
    const env = { ...process.env, SIGNALBIRD_AGENT_CONF: conf, SIGNALBIRD_AGENT_STATE_DIR: join(dir, 'state'), SIGNALBIRD_AGENT_LOG: join(dir, 'agent.log') };
    const r = spawnSync(process.execPath, [BIN, 'agent', 'signal', 'db-backup', 'ok'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /yalnız sba_live_/);

    const v = spawnSync(process.execPath, [BIN, 'agent', 'version'], { env, encoding: 'utf8' });
    assert.equal(v.stdout.trim(), AGENT_VERSION);

    const h = spawnSync(process.execPath, [BIN, 'fix'], { env, encoding: 'utf8' });
    assert.match(h.stdout, /signalbird fix login/);
  });

  test('systemd birimi: agent run, 401 çıkış kodunda yeniden başlamaz, sertleştirme', () => {
    const u = unitText({ execPath: '/usr/bin/node', bin: '/usr/lib/node_modules/signalbird-cli/bin/signalbird.mjs' });
    assert.match(u, /^ExecStart="\/usr\/bin\/node" "\/usr\/lib\/node_modules\/signalbird-cli\/bin\/signalbird\.mjs" agent run$/m);
    assert.match(u, new RegExp(`^RestartPreventExitStatus=${EXIT_AUTH}$`, 'm'));
    assert.match(u, /^ProtectSystem=strict$/m);
    assert.match(u, /^ReadWritePaths=\/var\/lib\/signalbird \/var\/log$/m);
    assert.ok(ephemeralBin('/root/.npm/_npx/abc/node_modules/signalbird-cli/bin/signalbird.mjs'));
    assert.ok(!ephemeralBin('/usr/lib/node_modules/signalbird-cli/bin/signalbird.mjs'));
  });
});

// ── log takibi ──────────────────────────────────────────────────────

describe('log takibi (§3.4, §6)', () => {
  test('allow_paths: kök altı kabul, dışı / .. / sembolik bağ kaçışı red', () => {
    const dir = tmp('sbagent-allow-');
    mkdirSync(join(dir, 'logs'));
    mkdirSync(join(dir, 'secret'));
    writeFileSync(join(dir, 'logs', 'app.log'), 'x\n');
    writeFileSync(join(dir, 'secret', 'shadow'), 'x\n');
    symlinkSync(join(dir, 'secret', 'shadow'), join(dir, 'logs', 'kacis.log'));
    const allow = [join(dir, 'logs') + '/'];

    assert.ok(pathAllowed(join(dir, 'logs', 'app.log'), allow));
    assert.ok(pathAllowed(join(dir, 'logs', 'henuz-yok.log'), allow));
    assert.ok(!pathAllowed(join(dir, 'secret', 'shadow'), allow));
    assert.ok(!pathAllowed(join(dir, 'logs', '..', 'secret', 'shadow'), allow));
    assert.ok(!pathAllowed(join(dir, 'logs', 'kacis.log'), allow), 'sembolik bağ dışarı çıkamaz');
    assert.ok(!pathAllowed(join(dir, 'logs-baska', 'x.log'), allow), 'önek benzerliği yetmez');
    assert.ok(!pathAllowed('relative/app.log', allow));
    assert.ok(!pathAllowed('/etc/shadow', ['/var/log']));
  });

  function setup() {
    const dir = tmp('sbagent-logs-');
    const file = join(dir, 'error.log');
    const state = new StateStore(join(dir, 'state'));
    const logs = [];
    const run = (spec = {}, opts = {}) =>
      collectLogs({ specs: [{ channel: 'sunucu', path: file, level: 'error', ...spec }], allowPaths: [dir], state, hostname: 'web-01', log: (l, m) => logs.push(m), ...opts });
    return { dir, file, state, run, logs };
  }

  test('ilk görülme geçmişi göndermez; yeni satırlar gider; yarım satır bekletilir', () => {
    const { file, state, run } = setup();
    writeFileSync(file, 'eski 1\neski 2\n');
    let r = run();
    assert.equal(r.events.length, 0);
    assert.equal(state.get(stateKey(file)), String(14));

    appendFileSync(file, '[error] bir\n[error] iki\nyarı');
    r = run();
    assert.deepEqual(r.events.map((e) => e.message), ['[error] bir', '[error] iki']);
    assert.deepEqual(r.events[0], { channel: 'sunucu', level: 'error', message: '[error] bir', source: `web-01:${file}`.slice(-110), context: { path: file.slice(-200) } });
    commitPending(state, r.pending);
    assert.equal(Number(state.get(stateKey(file))), 14 + 24, 'konum yarım satırın başında');

    appendFileSync(file, 'm satır\n');
    r = run();
    assert.deepEqual(r.events.map((e) => e.message), ['yarım satır']);
  });

  test('dönme: yeni dosya (inode) ve kesilen dosya BAŞTAN okunur', () => {
    const { file, state, run } = setup();
    writeFileSync(file, 'x'.repeat(100) + '\n');
    run();
    // logrotate: eski dosya taşınır, yeni dosya açılır
    renameSync(file, file + '.1');
    writeFileSync(file, 'yeni 1\nyeni 2\n');
    let r = run();
    assert.deepEqual(r.events.map((e) => e.message), ['yeni 1', 'yeni 2']);
    commitPending(state, r.pending);

    // copytruncate: aynı inode, boyut küçülür
    truncateSync(file, 0);
    appendFileSync(file, 'kesildi\n');
    r = run();
    assert.deepEqual(r.events.map((e) => e.message), ['kesildi']);
  });

  test('bash durum biçimi (inode yok) okunur ve devam eder', () => {
    const { dir, file } = setup();
    writeFileSync(file, 'a\nb\n');
    writeFileSync(join(dir, 'state2'), `${stateKey(file)}=2\nbaska=1\n`);
    const state = new StateStore(join(dir, 'state2'));
    const r = collectLogs({ specs: [{ path: file }], allowPaths: [dir], state, hostname: 'h' });
    assert.deepEqual(r.events.map((e) => e.message), ['b']);
    commitPending(state, r.pending);
    state.save();
    const text = readFileSync(join(dir, 'state2'), 'utf8');
    assert.match(text, /^baska=1$/m);
    assert.match(text, new RegExp(`^${stateKey(file)}=4$`, 'm'));
    assert.match(text, /^ino:.*=\d+$/m);
  });

  test('max_lines ve 100 kayıt sınırı: kalan satırlar KAYBOLMAZ, sonraki turda gelir', () => {
    const { file, state, run } = setup();
    writeFileSync(file, '');
    run();
    appendFileSync(file, Array.from({ length: 250 }, (_, i) => `satır ${i}`).join('\n') + '\n');

    let r = run({ max_lines: 30 });
    assert.equal(r.events.length, 30);
    commitPending(state, r.pending);

    r = run({ max_lines: 500 });
    assert.equal(r.events.length, LIMITS.eventsPerRequest);
    assert.equal(r.events[0].message, 'satır 30');
    commitPending(state, r.pending);

    r = run({ max_lines: 500 });
    assert.equal(r.events.length, 100);
    commitPending(state, r.pending);
    r = run({ max_lines: 500 });
    assert.equal(r.events.length, 20);
    assert.equal(r.events.at(-1).message, 'satır 249');
  });

  test('match süzgeci, boş satır, kırpma; süzgeçte elenenler konumu ilerletir', () => {
    const { file, state, run } = setup();
    writeFileSync(file, '');
    run();
    const long = '[crit] ' + 'ç'.repeat(5000);
    appendFileSync(file, `info x\n\n[error] y\n${long}\n`);
    const r = run({ match: '\\[error\\]|\\[crit\\]', channel: 'k'.repeat(60) });
    assert.deepEqual(r.events.map((e) => e.message.slice(0, 7)), ['[error]', '[crit] ']);
    assert.equal(Array.from(r.events[1].message).length, LIMITS.message);
    assert.equal(r.events[0].channel.length, LIMITS.channel);
    commitPending(state, r.pending);
    assert.equal(run({ match: 'x' }).events.length, 0);
  });

  test('izinsiz yol okunmaz ve bir kez uyarılır', () => {
    const { state, logs } = setup();
    const warned = new Set();
    for (let i = 0; i < 3; i++) {
      const r = collectLogs({ specs: [{ path: '/etc/passwd' }], allowPaths: ['/var/log'], state, hostname: 'h', log: (l, m) => logs.push(m), warnedPaths: warned });
      assert.deepEqual(r.rejected, ['/etc/passwd']);
      assert.equal(r.events.length, 0);
    }
    assert.equal(logs.filter((m) => /izinli değil/.test(m)).length, 1);
    assert.ok(!state.has(stateKey('/etc/passwd')));
  });

  test('klasör ya da dosya olmayan yol turu durdurmaz', () => {
    const { dir, file, state, run } = setup();
    mkdirSync(join(dir, 'klasor'));
    writeFileSync(file, '');
    run();
    appendFileSync(file, 'sonra\n');
    const logs = [];
    const r = collectLogs({ specs: [{ path: join(dir, 'klasor') }, { path: file }], allowPaths: [dir], state, hostname: 'h', log: (l, m) => logs.push(m) });
    assert.deepEqual(r.events.map((e) => e.message), ['sonra']);
    assert.match(logs.join('\n'), /dosya değil/);
  });

  test('konum kararı (§9)', () => {
    assert.equal(offsetDecision(200), 'advance');
    assert.equal(offsetDecision(202), 'advance');
    assert.equal(offsetDecision(422), 'advance');
    assert.equal(offsetDecision(403), 'advance');
    assert.equal(offsetDecision(404), 'advance');
    assert.equal(offsetDecision(429), 'hold');
    assert.equal(offsetDecision(500), 'hold');
    assert.equal(offsetDecision(503), 'hold');
    assert.equal(offsetDecision(0), 'hold');
    assert.equal(offsetDecision(302), 'hold');
    assert.equal(offsetDecision(401), 'fatal');
  });
});

// ── sahte API ───────────────────────────────────────────────────────

describe('sahte API ile uçtan uca', () => {
  const calls = [];
  const replies = {}; // yol → { status, body } (bir kez) ya da varsayılan
  let server;
  let apiUrl;
  const base = tmp('sbagent-e2e-');
  const logDir = join(base, 'logs');
  const logFile = join(logDir, 'app.log');
  const stateDir = join(base, 'state');
  const paths = { stateDir, state: join(stateDir, 'state'), configCache: join(stateDir, 'config.json') };

  const CONFIG = {
    config_version: 7,
    interval_seconds: 60,
    config_refresh_seconds: 300,
    collectors: { system: true, disks: true, services: ['nginx'], ports: false, processes: 2, socket: { enabled: false, url: null }, database: { enabled: false } },
    logs: [{ channel: 'sunucu', path: logFile, level: 'error', match: 'ERR', max_lines: 200 }],
    signals: [{ key: 'db-backup', mode: 'manual' }],
  };

  before(async () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logFile, 'geçmiş ERR satırı\n');
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        const path = req.url.replace(/^\/api/, '');
        calls.push({ method: req.method, path, headers: req.headers, body });
        const send = (status, json) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        const once = replies[path]?.shift?.();
        if (once) return send(once.status, once.body);
        if (path === '/v1/agent/hello') return send(200, { ok: true, agent: { id: 1, name: 'web-01' }, config: CONFIG, release: { version: '9.9.9', is_outdated: true, notes_url: 'https://signalbird.io/agent/changelog' } });
        if (path === '/v1/agent/config') return send(200, { ok: true, config: CONFIG });
        if (path === '/v1/agent/metrics') return send(202, { ok: true });
        if (path === '/v1/agent/logs') return send(202, { accepted: body.events.length, total: body.events.length, results: {} });
        if (path === '/v1/agent/signal') return body.key === 'db-backup' ? send(200, { ok: true }) : send(404, { ok: false, code: 'UNKNOWN_SIGNAL_KEY' });
        send(404, {});
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(() => server?.close());

  const logs = [];
  const mk = (token = TOKEN) =>
    new AgentRunner({
      conf: { api: apiUrl, token, allowPaths: [logDir], db: {} },
      paths,
      io: fakeIO({ exec: linuxExec }),
      client: makeAgentClient({ api: apiUrl, token }),
      log: (l, m) => logs.push(`[${l}] ${m}`),
      cpuSampleMs: 0,
    });
  const offset = () => Number(new StateStore(paths.state).get(stateKey(logFile)));
  const reply = (path, status, body = {}) => (replies[path] ||= []).push({ status, body });
  const of = (path) => calls.filter((c) => c.path === path);

  test('hello: başlıklar, gövde, ayar önbelleği, sürüm uyarısı (kendini güncellemez)', async () => {
    const r = mk();
    assert.equal(await r.hello(), true);
    const c = of('/v1/agent/hello')[0];
    assert.equal(c.method, 'POST');
    assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers.accept, 'application/json');
    assert.equal(c.headers['content-type'], 'application/json');
    assert.match(c.headers['user-agent'], new RegExp(`^signalbird-agent/${AGENT_VERSION.replace(/\./g, '\\.')} \\(`));
    assert.equal(c.body.version, AGENT_VERSION);
    assert.equal(c.body.protocol, 1);
    assert.deepEqual(JSON.parse(readFileSync(paths.configCache, 'utf8')), CONFIG);
    assert.equal(logs.filter((l) => /Yeni ajan sürümü var: 9\.9\.9/.test(l)).length, 1);
    await r.hello();
    assert.equal(logs.filter((l) => /Yeni ajan sürümü var/.test(l)).length, 1, 'uyarı sürüm başına bir kez');
  });

  test('tur: ilk görülen log gönderilmez, ölçüm gider; sonra yeni satır gider ve konum ilerler', async () => {
    const r = mk();
    await r.hello();
    calls.length = 0;
    await r.cycle();
    assert.equal(of('/v1/agent/logs').length, 0, 'geçmiş gönderilmez');
    const m = of('/v1/agent/metrics')[0];
    assert.ok(m, 'ölçüm gönderildi');
    assert.deepEqual(Object.keys(m.body), ['collected_at', 'metrics']);
    assert.deepEqual(m.body.metrics.services, [{ name: 'nginx', state: 'running' }]);
    assert.ok(Array.isArray(m.body.metrics.disks));
    assert.ok(!('ports' in m.body.metrics) && !('socket' in m.body.metrics) && !('database' in m.body.metrics));
    const start = offset();

    appendFileSync(logFile, 'ERR bir\nbilgi\nERR iki\n');
    calls.length = 0;
    await r.cycle();
    const l = of('/v1/agent/logs')[0];
    assert.deepEqual(l.body.events.map((e) => e.message), ['ERR bir', 'ERR iki']);
    assert.equal(l.body.events[0].source, `web-01:${logFile}`.slice(-110));
    assert.equal(offset(), start + 'ERR bir\nbilgi\nERR iki\n'.length);
  });

  for (const [status, advance] of [[500, false], [503, false], [429, false], [422, true], [413, true], [403, true]]) {
    test(`logs ${status} → konum ${advance ? 'ilerler' : 'durur'}`, async () => {
      const r = mk();
      await r.hello();
      const before = offset();
      const line = `ERR durum ${status}\n`;
      appendFileSync(logFile, line);
      reply('/v1/agent/logs', status, { ok: false, code: 'X' });
      await r.cycle();
      assert.equal(offset(), advance ? before + Buffer.byteLength(line) : before);
      if (!advance) {
        // aynı satır sonraki turda yeniden denenir ve bu kez kabul edilir
        calls.length = 0;
        await r.cycle();
        assert.deepEqual(of('/v1/agent/logs')[0].body.events.map((e) => e.message), [line.trim()]);
        assert.equal(offset(), before + Buffer.byteLength(line));
      }
    });
  }

  test('logs ağ hatası → konum durur', async () => {
    const r = new AgentRunner({ conf: { api: 'http://127.0.0.1:1/api', token: TOKEN, allowPaths: [logDir], db: {} }, paths, io: fakeIO({ exec: linuxExec }), client: makeAgentClient({ api: 'http://127.0.0.1:1/api', token: TOKEN }), log: () => {}, cpuSampleMs: 0 });
    r.setConfig(CONFIG, false);
    const before = offset();
    appendFileSync(logFile, 'ERR ağ\n');
    await r.cycle();
    assert.equal(offset(), before);
    // temizlik: gerçek sunucuyla gönder
    const ok = mk();
    await ok.hello();
    await ok.cycle();
    assert.equal(offset(), before + Buffer.byteLength('ERR ağ\n'));
  });

  test('logs 401 → AuthError, konum ilerlemez; hello 401 → AuthError', async () => {
    const r = mk();
    await r.hello();
    const before = offset();
    appendFileSync(logFile, 'ERR yetki\n');
    reply('/v1/agent/logs', 401, { ok: false, code: 'INVALID_AGENT_KEY' });
    await assert.rejects(r.cycle(), AuthError);
    assert.equal(offset(), before);
    reply('/v1/agent/hello', 401, { ok: false, code: 'INVALID_AGENT_KEY' });
    await assert.rejects(mk().hello(), AuthError);
    // kalan satırı boşalt
    await r.cycle();
  });

  test('hello 403 MODULE_DISABLED → tur atlanır, açılınca devam', async () => {
    const r = mk();
    reply('/v1/agent/hello', 403, { ok: false, code: 'MODULE_DISABLED', module: 'servers' });
    assert.equal(await r.hello(), false);
    assert.equal(r.blocked, 'MODULE_DISABLED');
    calls.length = 0;
    assert.equal(await r.cycle(), false);
    assert.equal(calls.length, 0);
    assert.equal(await r.hello(), true);
    assert.equal(r.blocked, null);
  });

  test('hello 5xx → GET /config ile ayar; o da olmazsa önbellek', async () => {
    const r = mk();
    reply('/v1/agent/hello', 500, {});
    assert.equal(await r.hello(), true);
    assert.equal(of('/v1/agent/config').at(-1).method, 'GET');
    assert.equal(of('/v1/agent/config').at(-1).headers.accept, 'application/json');

    const r2 = mk();
    reply('/v1/agent/hello', 500, {});
    reply('/v1/agent/config', 502, {});
    assert.equal(await r2.hello(), false);
    assert.equal(r2.config.config_version, 7, 'önbellekten');
  });

  test('ilk açılışta ayar yoksa yalnız hello (§9)', async () => {
    const empty = { ...paths, configCache: join(base, 'yok', 'config.json') };
    const r = new AgentRunner({ conf: { api: apiUrl, token: TOKEN, allowPaths: [logDir], db: {} }, paths: empty, io: fakeIO(), client: makeAgentClient({ api: apiUrl, token: TOKEN }), log: () => {}, cpuSampleMs: 0 });
    reply('/v1/agent/hello', 503, {});
    reply('/v1/agent/config', 503, {});
    assert.equal(await r.hello(), false);
    calls.length = 0;
    assert.equal(await r.cycle(), false);
    assert.equal(calls.length, 0);
  });

  test('signal: ok, fail, tanımsız anahtar (404 UNKNOWN_SIGNAL_KEY)', async () => {
    const r = mk();
    calls.length = 0;
    assert.equal((await r.sendSignal('db-backup', 'ok', '42 tablo')).ok, true);
    assert.deepEqual(of('/v1/agent/signal')[0].body, { key: 'db-backup', status: 'ok', message: '42 tablo' });
    assert.equal((await r.sendSignal('db-backup', 'fail')).ok, true);
    assert.deepEqual(of('/v1/agent/signal')[1].body, { key: 'db-backup', status: 'fail' });
    const res = await r.sendSignal('yok', 'ok');
    assert.deepEqual(res, { ok: false, status: 404, code: 'UNKNOWN_SIGNAL_KEY' });
  });

  test('dosya sinyali turda gönderilir', async () => {
    const r = mk();
    await r.hello();
    const backup = join(base, 'db.sql.gz');
    writeFileSync(backup, 'x');
    r.setConfig({ ...CONFIG, logs: [], signals: [{ key: 'db-backup', mode: 'file', path: backup, max_age_minutes: 70 }] }, false);
    r.io.now = () => new Date();
    calls.length = 0;
    await r.cycle();
    assert.equal(of('/v1/agent/signal')[0].body.status, 'ok');
  });

  test('CLI agent signal: sahte API ile uçtan uca ve sba_live_ dışı anahtar', () => {
    const conf = join(base, 'agent.conf');
    writeFileSync(conf, `token=${TOKEN}\napi_base=${apiUrl}\nallow_paths=${logDir}\n`);
    const env = { ...process.env, SIGNALBIRD_AGENT_CONF: conf, SIGNALBIRD_AGENT_STATE_DIR: stateDir, SIGNALBIRD_AGENT_LOG: join(base, 'agent.log') };
    return new Promise((resolve, reject) => {
      // spawnSync sunucuyu (aynı süreç) bloklardı; async spawn kullanılır.
      import('node:child_process').then(({ execFile }) => {
        execFile(process.execPath, [BIN, 'agent', 'signal', 'db-backup', 'ok', 'yedek', 'bitti'], { env }, (err, stdout) => {
          try {
            assert.equal(err, null);
            assert.match(stdout, /sinyal iletildi/);
            assert.deepEqual(of('/v1/agent/signal').at(-1).body, { key: 'db-backup', status: 'ok', message: 'yedek bitti' });
            assert.ok(existsSync(join(base, 'agent.log')));
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  });
});
