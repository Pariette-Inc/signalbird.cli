import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { agentMain, AGENT_HELP } from './agent/index.mjs';
import { ApiError } from './api.mjs';
import { expandHome, loadConfig, parseTarget, saveConfig, sameTarget, targetLabel } from './config.mjs';
import { AGENT_NAMES, AGENTS, agentName, agentVersion, probeAgent } from './fix/agent.mjs';
import { describeLink, discoverProjects, suggestRoots } from './fix/discover.mjs';
import { deviceLogin } from './fix/login.mjs';
import { tryRun } from './fix/git.mjs';
import { assertFixAllowed, fixClient, FixRunner } from './fix/runner.mjs';
import { install, logFile, restart, serviceStatus, uninstall } from './fix/service.mjs';
import { listJobs, removeJob } from './fix/workspace.mjs';
import { send } from './send.mjs';
import { ask, askSecret, c, ui } from './ui.mjs';
import { FIX_PROTOCOL, VERSION } from './version.mjs';

const HELP = `signalbird ${VERSION}

Janet (geliştirici bilgisayarı): Signalbird alarmını kendi ajanınıza (Claude Code, Codex, Gemini CLI) düzelttirip PR açar
  signalbird login [--root ~/git] [--agent claude|codex|gemini] [--no-service] [--api URL]
                                         Hesabınızla bağlanır (tarayıcı onayı), proje kökünü bulur,
                                         servisi kurar. Bir kez çalıştırmanız yeter.
  signalbird logout                      Bu bilgisayarın oturumunu ve servisini kaldırır
  signalbird fix login --key sbf_live_…   [--api URL]   (gelişmiş) Anahtarla bağlanır
  signalbird fix link <domain|#kanal> <klasör> [--base dal] [--repos a,b]
                                         Domain'i proje klasörüne bağlar (alt repolar otomatik bulunur)
  signalbird fix unlink <domain|#kanal>
  signalbird fix links                   Yerel bağlar ve projeler (eşleme panelde de yapılır)
  signalbird fix install                 Açılışta başlayan servis olarak kurar (launchd / systemd)
  signalbird fix uninstall
  signalbird fix start                   Ön planda çalıştırır
  signalbird fix status                  Servis, bağlantı, açık iş klasörleri
  signalbird fix doctor                  git / gh / ajan (oturum dahil) / API kontrolü
  signalbird fix agent [claude|codex|gemini] [--key …] [--env AD=değer]
                                         Janet'ın kullandığı ajanı gösterir ya da değiştirir
  signalbird fix claude-token [anahtar]  Claude'a uzun ömürlü anahtarla bağlanır (claude setup-token)
  signalbird fix cleanup [--dry-run] [--force]
                                         Sunucuda kapanmış işlerin yerel klonlarını siler
  signalbird fix logs [-n 100]           Servis logunun sonu

Gönderici (her yer)
  signalbird send <seviye> <mesaj> --channel <kanal> [--key sb_secret_live_…] [--source x] [--context '{"a":1}']
  signalbird send login --key sb_secret_live_…
      seviye: debug | info | warn | error | critical

${AGENT_HELP}

Ayar: ~/.signalbird/config.json (fix, send) · /etc/signalbird/agent.conf (agent)
Sözleşme: PROTOCOL.md · docs/AGENT-PROTOCOL.md · docs/AGENT-COMMANDS.md
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


// ── login (protokol 2, PROTOCOL.md §12.2) ───────────────────────────

async function login(argv) {
  const { values } = args(argv, {
    api: { type: 'string' },
    root: { type: 'string', multiple: true },
    'no-service': { type: 'boolean' },
    key: { type: 'string' },
    agent: { type: 'string' },
  });
  if (values.key) return fixLogin(['--key', values.key, ...(values.api ? ['--api', values.api] : [])]);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    die('signalbird login root olarak çalışmaz. Janet geliştirici bilgisayarı içindir; sunucular için: sudo signalbird agent install --token=…');
  }

  const cfg = loadConfig();
  if (values.api) cfg.api = values.api.replace(/\/+$/, '');
  const total = values['no-service'] ? 3 : 4;
  ui.title('Signalbird · Janet kurulumu');

  // 1) Proje klasörü: tarayıcı onayından ÖNCE sorulur: soru yarıda
  // kesilirse bilgisayar bağlanmış ama projesiz kalıyordu (14 Eki).
  ui.step(1, total, 'Proje klasörü');
  let roots = (values.root || []).map(expandHome);
  if (!roots.length && cfg.fix.roots.length) roots = cfg.fix.roots;
  if (!roots.length) {
    const s = suggestRoots();
    const def = s[0]?.root || expandHome('~/git');
    roots = [expandHome(await ask('Projeleriniz hangi klasörde? (Enter = önerileni kabul et)', def))];
  }
  for (const r of roots) if (!existsSync(r)) die(`Klasör yok: ${r}`);
  cfg.fix.roots = roots;
  const projects = discoverProjects(roots);
  if (projects.length) {
    const names = projects.slice(0, 6).map((p) => p.name).join(', ') + (projects.length > 6 ? ` +${projects.length - 6}` : '');
    ui.ok(`${c.bold(String(projects.length))} proje · ${c.dim(roots.join(', '))}`);
    ui.line(c.dim(names));
  } else {
    ui.warn(`Bu klasörde git deposu olan proje yok: ${roots.join(', ')}`);
    ui.line(c.dim('Değiştirmek için: signalbird login --root <klasör>'));
  }
  ui.gap();

  // 2) Hesapla bağlan
  ui.step(2, total, 'Hesabınızla bağlanın');
  let spin;
  const { token, machine } = await deviceLogin({
    api: cfg.api,
    onCode: ({ verify_url, user_code, opened }) => {
      ui.line(opened ? 'Tarayıcı açıldı. Signalbird\'de "Bu bilgisayarı bağla" deyin.' : 'Bu adresi tarayıcıda açıp "Bu bilgisayarı bağla" deyin:');
      ui.code('Kod', user_code);
      ui.code('Adres', verify_url);
      spin = ui.spinner('Onay bekleniyor…');
    },
  }).finally(() => spin?.stop());
  cfg.fix.key = token;
  saveConfig(cfg);
  ui.ok(`Bağlandı: ${c.bold(machine.name || 'bu bilgisayar')}`);

  // Panel projeleri hemen görsün (servisin ilk turunu beklemeden).
  try {
    await fixClient(cfg, { retry: false })('POST', '/v1/fix/hello', {
      version: VERSION,
      protocol: FIX_PROTOCOL,
      links: cfg.fix.links.map((l) => (l.domain ? { domain: l.domain } : { channel: l.channel })),
      projects: projects.map((p) => ({ name: p.name, repos: p.repos.slice(0, 50) })),
      agents: { [agentName(cfg)]: { version: agentVersion(cfg), status: 'ready' } },
    });
  } catch {}
  ui.gap();

  // 3) Gerekenler
  ui.step(3, total, 'Kontroller');
  checkAgent(cfg, values.agent);
  if (tryRun('gh', ['auth', 'status']) !== null) ui.ok('GitHub CLI oturumu açık');
  else ui.fail('GitHub CLI oturumu yok (PR açmak için gerekli)', 'brew install gh && gh auth login');
  ui.gap();

  // 4) Servis
  if (!values['no-service']) {
    ui.step(4, total, 'Arka plan servisi');
    try {
      if (serviceStatus().installed) {
        restart();
        ui.ok('Yeniden başlatıldı');
      } else {
        const r = install();
        ui.ok(`Kuruldu ${c.dim(`(${r.kind})`)} · bilgisayar açılınca kendiliğinden başlar`);
      }
    } catch (err) {
      ui.fail(`Kurulamadı: ${err.message}`, 'signalbird fix start   (ön planda çalıştırır)');
    }
  }

  const panel = cfg.api.replace(/\/api\/?$/, '').replace('://live.', '://') + '/tr/janet';
  ui.done('Hazır. Gerisi panelden', [
    `${c.violet('→')} Janet › Projeler: domain'leri onaylayın`,
    `${c.violet('→')} Kanal ayarı: "Janet otomatik düzeltsin"`,
    `${c.violet('→')} ya da bir alarmda "Janet'a aktar"`,
    c.dim(panel),
  ]);
}

/** Ajan hatasında ne yapılacağı. */
function agentFix(name, failure) {
  const a = AGENTS[name];
  if (failure === 'auth_required') return a.login;
  if (failure === 'not_installed') return a.install;
  if (failure === 'rate_limited') return `${a.label} kullanım limiti dolmuş; sıfırlanınca tekrar: signalbird fix doctor`;
  return null;
}

/**
 * `login`in 3. adımı: ajanı seçer ve dener. `--agent` verilmediyse ayardaki
 * ajan kuruluysa o kalır; değilse kurulu ilk ajan (claude, codex, gemini
 * sırasıyla) seçilir ve kaydedilir.
 */
function checkAgent(cfg, wanted) {
  if (wanted && !AGENTS[wanted]) die(`Bilinmeyen ajan: ${wanted}. Seçenekler: ${AGENT_NAMES.join(', ')}`);
  let name = wanted || agentName(cfg);
  if (!wanted && !agentVersion(cfg, name)) {
    const found = AGENT_NAMES.find((n) => agentVersion(cfg, n));
    if (found) name = found;
  }
  if (cfg.fix.agent !== name) {
    cfg.fix.agent = name;
    saveConfig(cfg);
  }
  const a = AGENTS[name];
  const v = agentVersion(cfg, name);
  if (!v) {
    ui.fail(`${a.label} bulunamadı`, `${a.install}   (ya da: signalbird login --agent codex | gemini)`);
    return;
  }
  const sp = ui.spinner(`${a.label} deneniyor…`);
  const probe = probeAgent(cfg, name);
  sp.stop();
  const ver = c.dim(v.replace(/\s*\(Claude Code\)/, ''));
  if (probe.ok) ui.ok(`${a.label} ${ver} · oturum açık`);
  else ui.fail(`${a.label} ${ver} · ${probe.failure === 'auth_required' ? 'oturum yok' : 'çalışmadı'}`, agentFix(name, probe.failure) || probe.detail);
  const others = AGENT_NAMES.filter((n) => n !== name && agentVersion(cfg, n));
  if (others.length) ui.line(c.dim(`Başka ajan da kurulu (${others.map((n) => AGENTS[n].label).join(', ')}). Değiştirmek için: signalbird fix agent <ad>`));
}

/**
 * `signalbird fix agent [ad] [--key …]`: Janet'ın hangi ajanla çalışacağı.
 * Ajan kullanıcının kendi bilgisayarında, kendi hesabıyla çalışır.
 */
async function fixAgent(argv) {
  const { values, positionals } = args(argv, { key: { type: 'string' }, env: { type: 'string', multiple: true } });
  const cfg = loadConfig();
  const current = agentName(cfg);
  const wanted = positionals[0];

  if (!wanted) {
    out(`Janet şu an ${c.bold(AGENTS[current].label)} ile çalışıyor.\n`);
    for (const n of AGENT_NAMES) {
      const v = agentVersion(cfg, n);
      out(`  ${n === current ? c.green('●') : ' '} ${n.padEnd(7)} ${AGENTS[n].label.padEnd(16)} ${v ? c.dim(v) : c.dim(`kurulu değil → ${AGENTS[n].install}`)}`);
    }
    return out(`\nDeğiştirmek için: signalbird fix agent codex   (ya da claude, gemini)`);
  }

  if (!AGENTS[wanted]) die(`Bilinmeyen ajan: ${wanted}. Seçenekler: ${AGENT_NAMES.join(', ')}`);
  const a = AGENTS[wanted];
  if (!agentVersion(cfg, wanted)) die(`${a.label} bu bilgisayarda yok. Kurmak için: ${a.install}`);

  if (values.key) {
    const envKey = { claude: 'CLAUDE_CODE_OAUTH_TOKEN', codex: 'CODEX_API_KEY', gemini: 'GEMINI_API_KEY' }[wanted];
    cfg.fix[wanted] = { ...(cfg.fix[wanted] || {}), env: { ...(cfg.fix[wanted]?.env || {}), [envKey]: values.key.trim() } };
  }

  // Ör. Workspace hesabıyla Gemini: --env GOOGLE_CLOUD_PROJECT=proje-id
  for (const kv of values.env || []) {
    const i = kv.indexOf('=');
    if (i < 1) die(`--env AD=değer biçiminde olmalı: ${kv}`);
    cfg.fix[wanted] = { ...(cfg.fix[wanted] || {}), env: { ...(cfg.fix[wanted]?.env || {}), [kv.slice(0, i)]: kv.slice(i + 1) } };
  }

  cfg.fix.agent = wanted;
  const sp = ui.spinner(`${a.label} deneniyor…`);
  const probe = probeAgent(cfg, wanted);
  sp.stop();
  if (!probe.ok) die(`${a.label} çalışmadı (${probe.failure === 'auth_required' ? 'oturum yok' : probe.detail || probe.failure}). ${agentFix(wanted, probe.failure) || ''}`);
  saveConfig(cfg);
  resetAgentState(cfg);
  ui.ok(`Janet artık ${a.label} ile çalışıyor.`);
  if (restart()) ui.ok('Servis yeniden başlatıldı.');
}

/**
 * Janet'ın Claude'a uzun ömürlü anahtarla bağlanması. Terminal oturumu
 * (claude /login) zamanla düşer ve arka plan servisi işleri "oturum yok"
 * diye düşürür; `claude setup-token` ile alınan anahtar düşmez.
 */
async function fixClaudeToken(argv) {
  const { positionals, values } = args(argv, { clear: { type: 'boolean' } });
  const cfg = loadConfig();
  cfg.fix.claude.env = { ...(cfg.fix.claude.env || {}) };
  if (values.clear) {
    delete cfg.fix.claude.env.CLAUDE_CODE_OAUTH_TOKEN;
    saveConfig(cfg);
    return out('✓ Anahtar kaldırıldı; Janet terminaldeki claude oturumunu kullanacak.');
  }
  let token = positionals[0];
  if (!token) {
    ui.line(c.dim('Anahtarı almak için başka bir terminalde: claude setup-token'));
    token = await askSecret('Claude anahtarını yapıştırın (sk-ant-oat…; iki satıra bölünmüşse de olduğu gibi yapıştırın)');
  }
  token = String(token || '').replace(/\s+/g, '');
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(token)) die('Bu bir Claude anahtarına benzemiyor (sk-ant-… bekleniyor). Almak için: claude setup-token');
  cfg.fix.claude.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  const sp = ui.spinner('Claude deneniyor…');
  const probe = probeAgent(cfg, 'claude');
  sp.stop();
  if (!probe.ok) die(`Anahtarla da çalışmadı: ${probe.detail}`);
  saveConfig(cfg);
  resetAgentState(cfg);
  ui.ok('Claude anahtarı kaydedildi ve çalışıyor (~/.signalbird/config.json, yalnız sizin okuyabileceğiniz dosya).');
  if (restart()) ui.ok('Servis yeniden başlatıldı; Janet görev almaya hazır.');
}

function resetAgentState(cfg) {
  try {
    const statePath = `${cfg.fix.workdir}/state.json`;
    if (!existsSync(statePath)) return;
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    st.agent = { status: 'ready', until: null };
    writeFileSync(statePath, JSON.stringify(st, null, 2));
  } catch {}
}

async function logout() {
  const cfg = loadConfig();
  uninstall();
  cfg.fix.key = null;
  saveConfig(cfg);
  out('✓ Oturum ve servis kaldırıldı. Bilgisayarı panelden de silmek için: Janet → Bilgisayarlar.');
}

// ── fix ─────────────────────────────────────────────────────────────

async function fixLogin(argv) {
  const { values } = args(argv, { key: { type: 'string' }, api: { type: 'string' } });
  const cfg = loadConfig();
  if (values.api) cfg.api = values.api.replace(/\/+$/, '');
  if (!values.key) die('--key sbf_live_… gerekli. Anahtarsız bağlanmak için: signalbird login');
  cfg.fix.key = values.key.trim();
  assertFixAllowed(cfg);

  // Kaydetmeden önce dene: yanlış anahtar ayar dosyasına girmesin.
  try {
    const res = await fixClient(cfg, { retry: false })('POST', '/v1/fix/hello', {
      version: VERSION,
      protocol: FIX_PROTOCOL,
      links: cfg.fix.links.map((l) => (l.domain ? { domain: l.domain } : { channel: l.channel })),
      projects: cfg.fix.roots.length ? discoverProjects(cfg.fix.roots).map((p) => ({ name: p.name, repos: p.repos.slice(0, 50) })) : undefined,
      agents: {},
    });
    saveConfig(cfg);
    out(`✓ Bağlandı: makine "${res.machine?.name}".`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) die('Anahtar reddedildi (401). Panelden doğru anahtarı kopyalayın.');
    die(err.message);
  }
  if (restart()) out('✓ Servis yeni anahtarla yeniden başlatıldı.');
  else out('Sıradaki: signalbird login --root <proje kökü> (anahtar korunur) ya da signalbird fix install');
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
  out(`Ajan: ${AGENTS[agentName(cfg)].label} ${agentVersion(cfg) || '(kurulu değil)'}  · değiştirmek için: signalbird fix agent`);
  out(`Servis: ${svc.installed ? (svc.running ? `çalışıyor (pid ${svc.pid ?? '?'})` : 'kurulu, çalışmıyor') : 'kurulu değil → Janet görev almaz. Kurmak için: signalbird fix install'}`);
  const projects = discoverProjects(cfg.fix.roots);
  out(`Proje kökü: ${cfg.fix.roots.join(', ') || 'yok (signalbird login --root …)'} · ${projects.length} proje`);
  out(`Yerel bağlar: ${cfg.fix.links.map(targetLabel).join(', ') || 'yok'}`);

  if (cfg.fix.key) {
    try {
      const res = await fixClient(cfg, { retry: false })('POST', '/v1/fix/hello', {
        version: VERSION,
        protocol: FIX_PROTOCOL,
        links: cfg.fix.links.map((l) => (l.domain ? { domain: l.domain } : { channel: l.channel })),
        projects: cfg.fix.roots.length ? projects.map((p) => ({ name: p.name, repos: p.repos.slice(0, 50) })) : undefined,
        agents: { [agentName(cfg)]: { version: agentVersion(cfg), status: 'ready' } },
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
  out(`  ${ok ? c.green('✓') : c.red('✗')} ${c.bold(label.padEnd(14))} ${ok ? c.dim(detail || '') : c.cyan(detail || '')}`);
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
  const an = agentName(cfg);
  const cv = agentVersion(cfg, an);
  ok &= check(an, Boolean(cv), cv || `yok → ${AGENTS[an].install}`);
  const probe = cv ? probeAgent(cfg, an) : { ok: false, failure: 'not_installed' };
  if (cv) ok &= check(`${an} oturumu`, probe.ok, probe.ok ? 'çalışıyor' : agentFix(an, probe.failure) || probe.detail);
  ok &= check('root değil', !(process.getuid && process.getuid() === 0), '');

  try {
    assertFixAllowed(cfg);
    // Servisin bildirdiği bağları/projeleri ezmemek için aynısını gönder.
    const res = await fixClient(cfg, { retry: false })('POST', '/v1/fix/hello', {
      version: VERSION,
      protocol: FIX_PROTOCOL,
      links: cfg.fix.links.map((l) => (l.domain ? { domain: l.domain } : { channel: l.channel })),
      projects: cfg.fix.roots.length ? discoverProjects(cfg.fix.roots).map((p) => ({ name: p.name, repos: p.repos.slice(0, 50) })) : undefined,
      agents: { [agentName(cfg)]: { version: cv, status: 'ready' } },
    });
    check('API', true, `makine "${res.machine?.name}"`);
  } catch (err) {
    ok = check('API', false, err.message) && ok;
  }

  // auth_required / rate_limited bayrağını sıfırla: yalnız ajan gerçekten çalışıyorsa.
  if (probe.ok) try {
    const statePath = `${cfg.fix.workdir}/state.json`;
    if (existsSync(statePath)) {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      if (st.agent?.status && st.agent.status !== 'ready') {
        st.agent = { status: 'ready', until: null };
        const { writeFileSync } = await import('node:fs');
        writeFileSync(statePath, JSON.stringify(st, null, 2));
        out(`• ${AGENTS[an].label} durumu "ready" olarak sıfırlandı.`);
      }
    }
  } catch {}

  for (const link of cfg.fix.links) {
    out(`\n${targetLabel(link)} → ${link.root}`);
    const repos = printRepos(link);
    if (!repos.some((r) => !r.problem)) ok = false;
  }
  const projCount = discoverProjects(cfg.fix.roots).length;
  check('projeler', projCount > 0 || cfg.fix.links.length > 0, `${projCount} proje (${cfg.fix.roots.join(', ') || 'kök yok'}) · ${cfg.fix.links.length} yerel bağ`);
  if (!projCount && !cfg.fix.links.length) ok = false;

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
    case 'claude-token':
      return fixClaudeToken(rest);
    case 'agent':
      return fixAgent(rest);
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
      case 'login':
        return await login(rest);
      case 'logout':
        return await logout();
      case 'fix':
        return await fix(rest);
      case 'send':
        return await sendCmd(rest);
      case 'agent':
        return await agentMain(rest);
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
