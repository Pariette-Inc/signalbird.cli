// `signalbird fix start`: sürekli çalışan düzeltici.
//
// Uyanma sebepleri: socket bildirimi (fix.job / fix.cleanup / fix.cancel)
// ya da 60 sn'lik yedek tur. Socket düşerse yoklama tek başına yeter.
// Makine aynı anda tek iş yapar (PROTOCOL.md §5.2).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { ApiError, createClient } from '../api.mjs';
import { findLink, loadConfig, saveConfig, targetLabel } from '../config.mjs';
import { log, redact, warn } from '../log.mjs';
import { FIX_PROTOCOL, VERSION } from '../version.mjs';
import { claudeVersion, runClaude } from './agent.mjs';
import { errText } from './git.mjs';
import { discoverProjects, suggestRoots } from './discover.mjs';
import { buildPrompt, extractSummary, prBody, prTitle } from './prompt.mjs';
import { finalize, ghOpenPr, jobDir, listJobs, prepare, removeJob, writeMarker } from './workspace.mjs';

const TICK_MS = 60000;
const CANCEL_POLL_MS = 45000;
const LOG_FLUSH_MS = 3000;
const LOG_CHUNK_MAX = 15000;
const LIMIT_COOLDOWN_MS = 30 * 60000;
const LOCAL_SWEEP_DAYS = 30;

export function assertFixAllowed(cfg) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('signalbird fix root olarak çalışmaz. Düzeltici geliştirici bilgisayarı içindir, sunucu için değil.');
  }
  if (!cfg.fix.key) throw new Error('Anahtar yok. Önce: signalbird fix login --key sbf_live_…');
  if (!/^sbf_live_[A-Za-z0-9]{16,}$/.test(cfg.fix.key)) {
    throw new Error('Bu bir düzeltici anahtarı değil (sbf_live_… bekleniyor). Sunucu/domain anahtarıyla fix çalışmaz.');
  }
}

export function fixClient(cfg, opts = {}) {
  return createClient({
    api: cfg.api,
    role: 'fix',
    headers: { Authorization: `Bearer ${cfg.fix.key}` },
    log: (m) => warn(m),
    ...opts,
  });
}

// ── yerel durum ─────────────────────────────────────────────────────

function statePath(cfg) {
  return join(cfg.fix.workdir, 'state.json');
}

function loadState(cfg) {
  try {
    return JSON.parse(readFileSync(statePath(cfg), 'utf8'));
  } catch {
    return { pending: [], agent: { status: 'ready', until: null }, last_sweep: null };
  }
}

function saveState(cfg, state) {
  mkdirSync(cfg.fix.workdir, { recursive: true });
  writeFileSync(statePath(cfg), JSON.stringify(state, null, 2));
}

// ── canlı log ───────────────────────────────────────────────────────

function createLogUploader(api, job) {
  let seq = (Math.max(1, job.attempt || 1) - 1) * 100000;
  let buf = '';
  let stopped = false;
  let chain = Promise.resolve();

  const send = (chunk) => {
    if (stopped || !chunk) return chain;
    const body = { seq: ++seq, chunk: redact(chunk) };
    chain = chain
      .then(() => api('POST', `/v1/fix/jobs/${job.id}/logs`, body))
      .then((res) => {
        if (res?.truncated) stopped = true;
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) stopped = true;
      });
    return chain;
  };

  const flush = () => {
    while (buf.length) {
      const part = buf.slice(0, LOG_CHUNK_MAX);
      buf = buf.slice(LOG_CHUNK_MAX);
      send(part);
    }
    return chain;
  };

  const timer = setInterval(flush, LOG_FLUSH_MS);

  return {
    line(text) {
      const s = String(text ?? '');
      if (!s) return;
      console.log(`  │ ${redact(s).split('\n').join('\n  │ ')}`);
      buf += s.endsWith('\n') ? s : s + '\n';
      if (buf.length >= LOG_CHUNK_MAX) flush();
    },
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}

// ── düzeltici ───────────────────────────────────────────────────────

export class FixRunner {
  constructor({ cfg, openPr = ghOpenPr }) {
    this.cfg = cfg;
    this.openPr = openPr;
    this.api = fixClient(cfg);
    this.state = loadState(cfg);
    this.busy = false;
    this.current = null; // { job, abort }
    this.wake = null;
    this.stopping = false;
    this.socket = null;
    this.socketChannel = null;
  }

  agentStatus() {
    const a = this.state.agent || { status: 'ready' };
    if (a.status === 'rate_limited' && a.until && Date.now() > Date.parse(a.until)) {
      this.state.agent = { status: 'ready', until: null };
      saveState(this.cfg, this.state);
    }
    return this.state.agent?.status || 'ready';
  }

  setAgentStatus(status) {
    this.state.agent = {
      status,
      until: status === 'rate_limited' ? new Date(Date.now() + LIMIT_COOLDOWN_MS).toISOString() : null,
    };
    saveState(this.cfg, this.state);
  }

  // Ayar dosyası ve proje kökü her turda yeniden okunur: `fix link` ya da
  // klasöre yeni bir proje eklemek yeniden başlatma gerektirmez.
  reloadLinks() {
    try {
      const fresh = loadConfig().fix;
      this.cfg.fix.links = fresh.links;
      this.cfg.fix.roots = fresh.roots;
    } catch (err) {
      warn(err.message);
    }
    // Kök hiç ayarlanmamışsa (yarım kalmış login) kendisi bulur ve kaydeder.
    if (!(this.cfg.fix.roots || []).length && !this.rootGuessed) {
      this.rootGuessed = true;
      const guess = suggestRoots()[0]?.root;
      if (guess) {
        try {
          const full = loadConfig();
          full.fix.roots = [guess];
          saveConfig(full);
          this.cfg.fix.roots = [guess];
          log(`Proje kökü ayarlı değildi; bulundu ve kaydedildi: ${guess} (değiştirmek için: signalbird login --root <klasör>)`);
        } catch (err) {
          warn(`proje kökü kaydedilemedi: ${err.message}`);
        }
      }
    }
    this.projects = discoverProjects(this.cfg.fix.roots || []);
  }

  /** İşin çalışacağı yer: sunucunun seçtiği proje (§12.4) ya da yerel bağ. */
  resolveLink(job) {
    if (job.project) {
      let p = (this.projects || []).find((x) => x.name === job.project);
      if (!p) {
        this.projects = discoverProjects(this.cfg.fix.roots || []);
        p = this.projects.find((x) => x.name === job.project);
      }
      if (p) {
        // Aynı domain için yerel bağ varsa hedef dal / repo kısıtı oradan gelir.
        const local = findLink(this.cfg.fix.links, job);
        return { root: p.path, base: local?.base ?? null, repos: local?.repos ?? null };
      }
    }
    return findLink(this.cfg.fix.links, job);
  }

  async hello() {
    this.reloadLinks();
    const version = this.claudeVersionCache ?? (this.claudeVersionCache = claudeVersion(this.cfg));
    const status = version ? this.agentStatus() : 'not_installed';
    const res = await this.api('POST', '/v1/fix/hello', {
      hostname: os.hostname(),
      platform: `${os.platform()}-${os.arch()}`,
      version: VERSION,
      protocol: FIX_PROTOCOL,
      links: this.cfg.fix.links.map((l) => (l.domain ? { domain: l.domain } : { channel: l.channel })),
      // Kök bilinmiyorsa alan hiç gönderilmez: sunucudaki son liste silinmesin.
      projects: (this.cfg.fix.roots || []).length ? (this.projects || []).map((p) => ({ name: p.name, repos: p.repos.slice(0, 50) })) : undefined,
      agents: { claude: { version, status } },
      busy_job_id: this.current?.job.id || null,
    });

    if (res.release?.is_outdated) {
      warn(`Yeni sürüm var: ${res.release.version} (kurulu ${VERSION}). Güncellemek için: npm i -g signalbird-cli`);
    }

    for (const c of res.cleanup || []) await this.cleanupJob(c);
    if (res.socket?.url && res.socket?.channel) this.connectSocket(res.socket).catch((e) => warn(`socket: ${e.message}`));

    return res;
  }

  async cleanupJob({ job_id, code, state }) {
    // Sunucu kodu göndermezse iş klasöründeki işaretten bulunur.
    const entry = listJobs(this.cfg.fix.workdir).find((j) => (code && j.code === code) || j.marker?.job_id === job_id);
    if (this.current?.job.id === job_id) return; // çalışan iş: önce durdurulur, sonra temizlenir
    let removed = [];
    if (entry) {
      const res = removeJob(this.cfg.fix.workdir, entry.code, { force: state !== 'failed' });
      removed = res.removed;
      if (res.kept.length) {
        warn(`${entry.code}: bazı klonlar korunuyor → ${res.kept.map((k) => `${k.name} (${k.reasons.join(', ')})`).join('; ')}`);
        return;
      }
      log(`${entry.code}: iş ${state} → yerel klonlar silindi (${removed.join(', ') || 'boş'}).`);
    }
    try {
      await this.api('POST', `/v1/fix/jobs/${job_id}/cleaned`, { removed });
    } catch (err) {
      warn(`temizlik bildirilemedi (${job_id}): ${err.message}`);
    }
  }

  async connectSocket({ url, channel }) {
    if (this.socket && this.socketChannel === channel) return;
    let io;
    try {
      ({ io } = await import('socket.io-client'));
    } catch {
      return; // paket yoksa yoklama yeter
    }
    this.socket?.close();
    this.socketChannel = channel;
    const socket = io(url, { transports: ['websocket'], reconnection: true, reconnectionDelayMax: 30000 });
    this.socket = socket;

    socket.on('connect', async () => {
      try {
        const auth = await this.api('POST', '/v1/fix/socket/auth', { socket_id: socket.id, channel });
        socket.emit('subscribe', { channel, auth: auth.auth, at: auth.at }, (ack) => {
          if (!ack?.ok) warn(`socket aboneliği reddedildi: ${ack?.code}`);
        });
      } catch (err) {
        warn(`socket yetkisi alınamadı: ${err.message}`);
      }
    });

    const onEvent = (name, data) => {
      if (name === 'fix.cancel' && data?.job_id && this.current?.job.id === data.job_id) {
        this.current.abort.abort();
        return;
      }
      this.poke();
    };
    socket.onAny(onEvent);
  }

  poke() {
    if (this.wake) this.wake();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  async flushPending() {
    const keep = [];
    for (const p of this.state.pending || []) {
      try {
        await this.api('PATCH', `/v1/fix/jobs/${p.job_id}`, p.body);
      } catch (err) {
        if (err instanceof ApiError && !err.transient) continue; // 409/404: iş kapanmış, bırak
        keep.push(p);
      }
    }
    this.state.pending = keep;
    saveState(this.cfg, this.state);
  }

  async report(jobId, body) {
    try {
      await this.api('PATCH', `/v1/fix/jobs/${jobId}`, body);
    } catch (err) {
      if (err instanceof ApiError && !err.transient) {
        warn(`rapor reddedildi (${err.status} ${err.code}); iş sunucuda kapanmış olabilir.`);
        return false;
      }
      warn(`rapor gönderilemedi, sonra tekrar denenecek: ${err.message}`);
      this.state.pending = [...(this.state.pending || []), { job_id: jobId, body, at: new Date().toISOString() }];
      saveState(this.cfg, this.state);
    }
    return true;
  }

  localSweep() {
    const last = this.state.last_sweep ? Date.parse(this.state.last_sweep) : 0;
    if (Date.now() - last < 6 * 3600000) return;
    const cutoff = Date.now() - LOCAL_SWEEP_DAYS * 86400000;
    for (const j of listJobs(this.cfg.fix.workdir)) {
      if (j.touchedAt > cutoff || this.current?.job.code === j.code) continue;
      const res = removeJob(this.cfg.fix.workdir, j.code);
      if (res.removed.length && !res.kept.length) log(`${j.code}: ${LOCAL_SWEEP_DAYS} gündür dokunulmamış, silindi.`);
    }
    this.state.last_sweep = new Date().toISOString();
    saveState(this.cfg, this.state);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.hello();
      await this.flushPending();
      this.localSweep();

      if (this.agentStatus() !== 'ready') return;
      if (!this.cfg.fix.links.length && !(this.projects || []).length) return;

      for (;;) {
        const res = await this.api('POST', '/v1/fix/jobs/claim');
        if (!res.job) break;
        await this.processJob(res.job);
        if (this.stopping || this.agentStatus() !== 'ready') break;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        warn('Oturum geçersiz (401): bu bilgisayar panelden silinmiş ya da anahtarı yenilenmiş olabilir. Tekrar bağlamak için: signalbird login');
        // Çıkış kodu 0: servis yöneticisi yeniden başlatıp 401 döngüsüne girmesin.
        // `fix login` yeni anahtarı yazınca servisi kendisi yeniden başlatır.
        this.stopping = true;
      } else if (err instanceof ApiError && err.status === 403) {
        warn(`Sunucu reddetti (${err.code}). Bekleniyor.`);
      } else {
        warn(err.message);
      }
    } finally {
      this.busy = false;
    }
  }

  async processJob(job) {
    const link = this.resolveLink(job);
    const abort = new AbortController();
    this.current = { job, abort };
    const logs = createLogUploader(this.api, job);
    const started = Date.now();

    log(`▶ ${job.code} (${targetLabel(job.domain ? { domain: job.domain } : { channel: job.channel?.key })}, deneme ${job.attempt}) ${String(job.event?.message || '').split('\n')[0].slice(0, 120)}`);

    let cancelTimer;
    try {
      if (!link) {
        throw new Error(job.project
          ? `"${job.project}" projesi bu bilgisayarda bulunamadı (proje kökü: ${(this.cfg.fix.roots || []).join(', ') || 'yok'}).`
          : 'Bu iş için bu bilgisayarda proje yok. Panelde Janet → Projeler bölümünden eşleyin.');
      }

      await this.report(job.id, { status: 'running' });
      logs.line(`● ${job.code} başladı · ${os.hostname()} · ${link.root}`);

      const ws = prepare({ job, link, workdir: this.cfg.fix.workdir, log: (m) => logs.line(`● ${m}`) });
      logs.line(`● çalışma alanı hazır: ${ws.repos.map((r) => `${r.name}→${r.base}`).join(', ')} · dal ${ws.branch}`);

      cancelTimer = setInterval(async () => {
        try {
          const s = await this.api('GET', `/v1/fix/jobs/${job.id}`);
          if (['canceled', 'resolved', 'rejected'].includes(s.status)) abort.abort();
        } catch {}
      }, CANCEL_POLL_MS);

      const result = await runClaude({
        cfg: this.cfg,
        cwd: ws.repos.length > 1 ? ws.dir : ws.repos[0].clone,
        prompt: buildPrompt({ job, ws }),
        model: null,
        timeoutMinutes: job.limits?.timeout_minutes || this.cfg.fix.claude.timeout_minutes || 60,
        cancelSignal: abort.signal,
        onLine: (l) => logs.line(l),
      });
      clearInterval(cancelTimer);

      if (result.canceled) {
        logs.line('● durduruldu; klonlar temizleniyor');
        await logs.close();
        removeJob(this.cfg.fix.workdir, job.code, { force: true });
        await this.api('POST', `/v1/fix/jobs/${job.id}/cleaned`, { removed: ws.repos.map((r) => r.name) }).catch(() => {});
        return;
      }

      if (!result.ok) {
        if (result.failure === 'auth_required' || result.failure === 'rate_limited' || result.failure === 'not_installed') {
          this.setAgentStatus(result.failure);
        }
        const why = result.timedOut
          ? `Zaman aşımı (${job.limits?.timeout_minutes || 60} dk).`
          : result.failure === 'auth_required'
            ? 'Claude oturumu düşmüş: bu bilgisayarda `claude` çalıştırıp giriş yapın, sonra `signalbird fix doctor`.'
            : result.failure === 'rate_limited'
              ? 'Claude kullanım limiti doldu; makine 30 dk iş almayacak.'
              : `Claude hata ile bitti (çıkış ${result.exitCode}).`;
        writeMarker(ws.dir, { status: 'failed' });
        await logs.close();
        await this.report(job.id, { status: 'failed', error: redact(`${why}\n\n${result.tail.slice(-3000)}`).slice(0, 4500) });
        log(`✗ ${job.code}: ${why}`);
        return;
      }

      const summary = redact(extractSummary(result.finalText));
      const title = prTitle(job, summary);
      logs.line('● ajan bitti; değişiklikler push ediliyor');

      const fin = finalize({
        job,
        ws,
        title,
        body: null,
        openPr: ({ repo, branch }) => this.openPr({ repo, branch, title, body: prBody({ job, summary, ws, repo }) }),
        log: (m) => logs.line(`● ${m}`),
      });

      for (const p of fin.prs) logs.line(`● PR: ${p.url}`);
      for (const p of fin.problems) logs.line(`✗ ${p}`);
      await logs.close();

      const mins = Math.round((Date.now() - started) / 60000);
      if (fin.prs.length) {
        writeMarker(ws.dir, { status: 'pr_open' });
        await this.report(job.id, {
          status: 'pr_open',
          branch: ws.branch,
          prs: fin.prs,
          summary,
          error: fin.problems.length ? fin.problems.join('\n').slice(0, 4500) : null,
        });
        log(`✓ ${job.code}: ${fin.prs.length} PR (${mins} dk) ${fin.prs.map((p) => p.url).join(' ')}`);
      } else if (fin.problems.length) {
        writeMarker(ws.dir, { status: 'failed' });
        await this.report(job.id, { status: 'failed', summary, error: fin.problems.join('\n').slice(0, 4500) });
        log(`✗ ${job.code}: ${fin.problems[0]}`);
      } else {
        await this.report(job.id, { status: 'no_change', summary });
        log(`○ ${job.code}: kod değişikliği yok (${mins} dk).`);
      }
    } catch (err) {
      clearInterval(cancelTimer);
      const msg = redact(errText(err));
      logs.line(`✗ ${msg}`);
      await logs.close();
      if (existsSync(jobDir(this.cfg.fix.workdir, job.code))) writeMarker(jobDir(this.cfg.fix.workdir, job.code), { status: 'failed' });
      await this.report(job.id, { status: 'failed', error: msg.slice(0, 4500) });
      warn(`${job.code}: ${msg}`);
    } finally {
      this.current = null;
    }
  }

  async start() {
    assertFixAllowed(this.cfg);
    mkdirSync(this.cfg.fix.workdir, { recursive: true });
    this.reloadLinks();
    log(`Janet ${VERSION} başladı · ${this.cfg.api} · ${(this.projects || []).length} proje (${(this.cfg.fix.roots || []).join(', ') || 'kök yok'}) · ${this.cfg.fix.links.length} yerel bağ`);
    if (!(this.projects || []).length && !this.cfg.fix.links.length) warn('Hiç proje yok. Proje kökünü ayarlamak için: signalbird login --root ~/git');

    const stop = () => {
      if (this.stopping) process.exit(1);
      this.stopping = true;
      log('kapanıyor (çalışan iş varsa bitmesi bekleniyor; zorla kapatmak için tekrar Ctrl+C)');
      this.poke();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    while (!this.stopping) {
      await this.tick();
      if (this.stopping) break;
      await this.sleep(TICK_MS);
    }
    this.socket?.close();
  }
}
