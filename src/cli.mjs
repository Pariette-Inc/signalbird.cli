import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ApiError } from './api.mjs';
import { expandHome, loadConfig, parseTarget, saveConfig, sameTarget, targetLabel } from './config.mjs';
import { claudeVersion } from './fix/agent.mjs';
import { describeLink } from './fix/discover.mjs';
import { tryRun } from './fix/git.mjs';
import { assertFixAllowed, fixClient, FixRunner } from './fix/runner.mjs';
import { install, logFile, restart, serviceStatus, uninstall } from './fix/service.mjs';
import { listJobs, removeJob } from './fix/workspace.mjs';
import { send } from './send.mjs';
import { VERSION } from './version.mjs';

const HELP = `signalbird ${VERSION}

Düzeltici (geliştirici bilgisayarı) — telsiz alarmını yerel Claude'a düzelttirip PR açar
  signalbird fix login --key sbf_live_…   [--api URL]   Panelden alınan makine anahtarını kaydeder
  signalbird fix link <domain|#kanal> <klasör> [--base dal] [--repos a,b]
                                         Domain'i proje klasörüne bağlar (alt repolar otomatik bulunur)
  signalbird fix unlink <domain|#kanal>
  signalbird fix links                   Bağlar ve keşfedilen repolar / hedef dallar
  signalbird fix install                 Açılışta başlayan servis olarak kurar (launchd / systemd)
  signalbird fix uninstall
  signalbird fix start                   Ön planda çalıştırır
  signalbird fix status                  Servis, bağlantı, açık iş klasörleri
  signalbird fix doctor                  git / gh / claude / API kontrolü
  signalbird fix cleanup [--dry-run] [--force]
                                         Sunucuda kapanmış işlerin yerel klonlarını siler
  signalbird fix logs [-n 100]           Servis logunun sonu

Gönderici (her yer)
  signalbird send <seviye> <mesaj> --channel <kanal> [--key sb_secret_live_…] [--source x] [--context '{"a":1}']
  signalbird send login --key sb_secret_live_…
      seviye: debug | info | warn | error | critical

Sunucu ajanı
  signalbird agent …                     Yakında (agent.signalbird'ün yerini alacak)

Ayar: ~/.signalbird/config.json   ·   Sözleşme: PROTOCOL.md
`;

function out(...a) {
  console.log(...a);
}

function die(msg, code = 1) {
  console.error(`hata: ${msg}`);
  process.exit(code);
}

function args(argv, options) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

// ── fix ─────────────────────────────────────────────────────────────

async function fixLogin(argv) {
  const { values } = args(argv, { key: { type: 'string' }, api: { type: 'string' } });
  const cfg = loadConfig();
  if (values.api) cfg.api = values.api.replace(/\/+$/, '');
  if (!values.key) die('--key sbf_live_… gerekli (Panel → Telsiz → Düzeltici makineler → Makine ekle).');
  cfg.fix.key = values.key.trim();
  assertFixAllowed(cfg);

  // Kaydetmeden önce dene: yanlış anahtar ayar dosyasına girmesin.
  try {
    const res = await fixClient(cfg, { retry: false })('POST', '/v1/fix/hello', { version: VERSION, protocol: 1, links: [], agents: {} });
    saveConfig(cfg);
    out(`✓ Bağlandı: makine "${res.machine?.name}" (takım ${res.machine?.team_id}).`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) die('Anahtar reddedildi (401). Panelden doğru anahtarı kopyalayın.');
    die(err.message);
  }
  if (restart()) out('✓ Servis yeni anahtarla yeniden başlatıldı.');
  else out('Sıradaki: signalbird fix link <domain> <klasör>');
}

function printRepos(link) {
  const repos = describeLink(link);
  if (!repos.length) {
    out(`  (git deposu bulunamadı: ${link.root})`);
    return repos;
  }
  for (const r of repos) {
    if (r.problem) out(`  ✗ ${r.name.padEnd(24)} ${r.problem}`);
    else out(`  ✓ ${r.name.padEnd(24)} ${r.slug.padEnd(36)} → ${r.base}`);
  }
  return repos;
}

function fixLink(argv) {
  const { values, positionals } = args(argv, {
    base: { type: 'string' },
    repos: { type: 'string' },
    channel: { type: 'boolean' },
  });
  if (positionals.length !== 2) die('Kullanım: signalbird fix link <domain|#kanal> <klasör>');

  const target = parseTarget(positionals[0], { channel: values.channel });
  const root = expandHome(positionals[1]);
  if (!existsSync(root) || !statSync(root).isDirectory()) die(`Klasör yok: ${root}`);

  const cfg = loadConfig();
  const link = { ...target, root, base: values.base || null, repos: values.repos ? values.repos.split(',').map((s) => s.trim()).filter(Boolean) : null };
  cfg.fix.links = [...cfg.fix.links.filter((l) => !sameTarget(l, target)), link];

  out(`${targetLabel(target)} → ${root}`);
  const repos = printRepos(link);
  if (!repos.some((r) => !r.problem)) die('Bu klasörde PR açılabilecek repo yok; bağ kaydedilmedi.');

  saveConfig(cfg);
  out('✓ Kaydedildi. Hedef dalı değiştirmek için: --base <dal> (repo başına ayar: config.json → links[].base = {"repo":"dal"})');
  if (!serviceStatus().installed) out('Sıradaki: signalbird fix install');
}

function fixUnlink(argv) {
  const { values, positionals } = args(argv, { channel: { type: 'boolean' } });
  if (positionals.length !== 1) die('Kullanım: signalbird fix unlink <domain|#kanal>');
  const target = parseTarget(positionals[0], { channel: values.channel });
  const cfg = loadConfig();
  const before = cfg.fix.links.length;
  cfg.fix.links = cfg.fix.links.filter((l) => !sameTarget(l, target));
  if (cfg.fix.links.length === before) die(`${targetLabel(target)} için bağ yok.`);
  saveConfig(cfg);
  out(`✓ ${targetLabel(target)} bağı kaldırıldı.`);
}

function fixLinks() {
  const cfg = loadConfig();
  if (!cfg.fix.links.length) {
    out('Bağ yok. Örnek: signalbird fix link adall.io ~/git/adall');
    return;
  }
  for (const link of cfg.fix.links) {
    out(`\n${targetLabel(link)} → ${link.root}${link.base ? `  (base: ${JSON.stringify(link.base)})` : ''}`);
    printRepos(link);
  }
}

async function fixStatus() {
  const cfg = loadConfig();
  const svc = serviceStatus();
  out(`signalbird ${VERSION} · API ${cfg.api}`);
  out(`Anahtar: ${cfg.fix.key ? cfg.fix.key.slice(0, 16) + '…' : 'yok'}`);
  out(`Servis: ${svc.installed ? (svc.running ? `çalışıyor (pid ${svc.pid ?? '?'})` : 'kurulu, çalışmıyor') : 'kurulu değil'}`);
  out(`Bağlar: ${cfg.fix.links.map(targetLabel).join(', ') || 'yok'}`);

  if (cfg.fix.key) {
    try {
      const res = await fixClient(cfg, { retry: false })('POST', '/v1/fix/hello', {
        version: VERSION,
        protocol: 1,
        links: cfg.fix.links.map((l) => (l.domain ? { domain: l.domain } : { channel: l.channel })),
        agents: { claude: { version: claudeVersion(cfg), status: 'ready' } },
      });
      out(`Sunucu: makine "${res.machine?.name}", kuyrukta ${res.pending ?? 0} iş, temizlik bekleyen ${res.cleanup?.length ?? 0}`);
    } catch (err) {
      out(`Sunucu: ${err.message}`);
    }
  }

  const jobs = listJobs(cfg.fix.workdir);
  out(`\nYerel iş klasörleri (${jobs.length}) · ${cfg.fix.workdir}/jobs`);
  for (const j of jobs) {
    const days = Math.floor((Date.now() - j.touchedAt) / 86400000);
    out(`  ${j.code.padEnd(22)} ${String(j.marker?.status || '?').padEnd(9)} ${(j.marker?.touched || j.marker?.repos?.map((r) => r.name) || []).join(',')}  ${days} gün`);
  }
}

function check(label, ok, detail) {
  out(`${ok ? '✓' : '✗'} ${label.padEnd(16)} ${detail || ''}`);
  return ok;
}

async function fixDoctor() {
  const cfg = loadConfig();
  let ok = true;
  ok &= check('node', Number(process.versions.node.split('.')[0]) >= 20, process.version);
  const gitV = tryRun('git', ['--version']);
  ok &= check('git', Boolean(gitV), gitV || 'yok');
  const ghV = tryRun('gh', ['--version'])?.split('\n')[0];
  ok &= check('gh', Boolean(ghV), ghV || 'yok → brew install gh');
  if (ghV) {
    const auth = tryRun('gh', ['auth', 'status']);
    ok &= check('gh oturumu', auth !== null, auth !== null ? 'açık' : 'kapalı → gh auth login');
  }
  const cv = claudeVersion(cfg);
  ok &= check('claude', Boolean(cv), cv || 'yok → npm i -g @anthropic-ai/claude-code');
  ok &= check('root değil', !(process.getuid && process.getuid() === 0), '');

  try {
    assertFixAllowed(cfg);
    const res = await fixClient(cfg, { retry: false })('POST', '/v1/fix/hello', { version: VERSION, protocol: 1, links: [], agents: { claude: { version: cv, status: 'ready' } } });
    check('API', true, `makine "${res.machine?.name}"`);
  } catch (err) {
    ok = check('API', false, err.message) && ok;
  }

  // auth_required / rate_limited bayrağını sıfırla: kullanıcı sorunu giderdiğini söylüyor.
  try {
    const statePath = `${cfg.fix.workdir}/state.json`;
    if (existsSync(statePath)) {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      if (st.agent?.status && st.agent.status !== 'ready') {
        st.agent = { status: 'ready', until: null };
        const { writeFileSync } = await import('node:fs');
        writeFileSync(statePath, JSON.stringify(st, null, 2));
        out(`• Claude durumu "ready" olarak sıfırlandı.`);
      }
    }
  } catch {}

  for (const link of cfg.fix.links) {
    out(`\n${targetLabel(link)} → ${link.root}`);
    const repos = printRepos(link);
    if (!repos.some((r) => !r.problem)) ok = false;
  }
  if (!cfg.fix.links.length) ok = check('bağ', false, 'yok → signalbird fix link <domain> <klasör>') && ok;

  process.exitCode = ok ? 0 : 1;
}

async function fixCleanup(argv) {
  const { values } = args(argv, { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' } });
  const cfg = loadConfig();
  const api = cfg.fix.key ? fixClient(cfg, { retry: false }) : null;
  const jobs = listJobs(cfg.fix.workdir);
  if (!jobs.length) return out('Temizlenecek iş klasörü yok.');

  for (const j of jobs) {
    let status = null;
    if (api && j.marker?.job_id) {
      try {
        status = (await api('GET', `/v1/fix/jobs/${j.marker.job_id}`)).status;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) status = 'gone';
      }
    }
    const closed = ['resolved', 'rejected', 'canceled', 'no_change', 'gone'].includes(status);
    if (!closed && !values.force) {
      out(`  ${j.code}: ${status || 'durum bilinmiyor'} → bırakıldı`);
      continue;
    }
    const res = removeJob(cfg.fix.workdir, j.code, { force: values.force, dryRun: values['dry-run'] });
    const verb = values['dry-run'] ? 'silinecek' : 'silindi';
    out(`  ${j.code}: ${status || 'zorla'} → ${verb}: ${res.removed.join(', ') || '-'}${res.kept.length ? ` · korunan: ${res.kept.map((k) => `${k.name} (${k.reasons.join(', ')})`).join('; ')}` : ''}`);
    if (!values['dry-run'] && !res.kept.length && api && j.marker?.job_id && status !== 'gone') {
      await api('POST', `/v1/fix/jobs/${j.marker.job_id}/cleaned`, { removed: res.removed }).catch(() => {});
    }
  }
}

function fixLogs(argv) {
  const { values } = args(argv, { n: { type: 'string', short: 'n' } });
  const file = logFile();
  if (!existsSync(file)) return out(`Log yok: ${file}`);
  const n = Number(values.n || 100);
  out(readFileSync(file, 'utf8').split('\n').slice(-n - 1).join('\n'));
}

async function fix(argv) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'login':
      return fixLogin(rest);
    case 'link':
      return fixLink(rest);
    case 'unlink':
      return fixUnlink(rest);
    case 'links':
      return fixLinks();
    case 'start':
      return new FixRunner({ cfg: loadConfig() }).start();
    case 'install': {
      const cfg = loadConfig();
      assertFixAllowed(cfg);
      const r = install();
      out(`✓ ${r.kind} servisi kuruldu: ${r.path}\n  Log: ${r.log}  (signalbird fix logs)`);
      return;
    }
    case 'uninstall':
      uninstall();
      return out('✓ Servis kaldırıldı. Ayar ve iş klasörleri duruyor.');
    case 'status':
      return fixStatus();
    case 'doctor':
      return fixDoctor();
    case 'cleanup':
      return fixCleanup(rest);
    case 'logs':
      return fixLogs(rest);
    default:
      out(HELP);
      if (sub) process.exitCode = 1;
  }
}

// ── send ────────────────────────────────────────────────────────────

async function sendCmd(argv) {
  if (argv[0] === 'login') {
    const { values } = args(argv.slice(1), { key: { type: 'string' }, api: { type: 'string' } });
    if (!values.key?.startsWith('sb_secret_live_')) die('--key sb_secret_live_… gerekli.');
    const cfg = loadConfig();
    cfg.send.key = values.key;
    if (values.api) cfg.api = values.api.replace(/\/+$/, '');
    saveConfig(cfg);
    return out('✓ Gönderici anahtarı kaydedildi.');
  }

  const { values, positionals } = args(argv, {
    channel: { type: 'string', short: 'c' },
    key: { type: 'string' },
    source: { type: 'string' },
    context: { type: 'string' },
  });
  const [level, ...msg] = positionals;
  let context;
  if (values.context) {
    try {
      context = JSON.parse(values.context);
    } catch {
      die('--context geçerli JSON olmalı.');
    }
  }
  const res = await send({ cfg: loadConfig(), key: values.key, channel: values.channel, level, message: msg.join(' '), source: values.source, context });
  out(`✓ gönderildi (${res.event_id || 'ok'})`);
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'fix':
        return await fix(rest);
      case 'send':
        return await sendCmd(rest);
      case 'agent':
        return die('Sunucu ajanı henüz bu pakette değil; yakında `signalbird agent install` olarak gelecek.');
      case 'version':
      case '--version':
      case '-v':
        return out(VERSION);
      default:
        out(HELP);
        if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
    }
  } catch (err) {
    die(err.message);
  }
}
