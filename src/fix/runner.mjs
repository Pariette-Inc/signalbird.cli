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
import { AGENT_NAMES, AGENTS, agentName, agentVersion, agentVersions, probeAgent, runAgent } from './agent.mjs';
import { errText } from './git.mjs';
import { discoverProjects, suggestRoots } from './discover.mjs';
import { lookupCommand } from './lookup.mjs';
import { buildPrompt, extractQuestion, extractSummary, prBody, prTitle } from './prompt.mjs';
import { finalize, ghOpenPr, ghPrState, jobDir, listJobs, prepare, removeJob, writeMarker } from './workspace.mjs';

const TICK_MS = 60000;
const CANCEL_POLL_MS = 45000;
const LOG_FLUSH_MS = 3000;
const LOG_CHUNK_MAX = 15000;
const LIMIT_COOLDOWN_MS = 30 * 60000;
const AUTH_REPROBE_MS = 10 * 60000;
// Sürüm her hello'da üç ikiliyi çalıştırmasın; sonradan kurulan ajan yine
// yeniden başlatmadan görünsün.
const VERSION_TTL_MS = 10 * 60000;
const LOCAL_SWEEP_DAYS = 30;
const PR_SYNC_MS = 30 * 60000;
const CLOSED_STATES = ['resolved', 'rejected', 'canceled'];
const LOCAL_JOBS_MAX = 200;

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

export function loadState(cfg) {
  let st;
  try {
    st = JSON.parse(readFileSync(statePath(cfg), 'utf8'));
  } catch {
    st = { pending: [], last_sweep: null };
  }
  st.pending ||= [];
  if (!st.agents || typeof st.agents !== 'object') {
    st.agents = {};
    // ≤0.6.x makine başına tek durum tutuyordu; o durum o günkü seçili ajanındı.
    // not_installed saklanmaz: sürüm her hello'da yeniden okunur.
    const old = st.agent;
    if (old?.status === 'auth_required' || old?.status === 'rate_limited') {
      st.agents[agentName(cfg)] = { status: old.status, until: old.until ?? null };
    }
  }
  delete st.agent;
  return st;
}

export function saveState(cfg, state) {
  mkdirSync(cfg.fix.workdir, { recursive: true });
  writeFileSync(statePath(cfg), JSON.stringify(state, null, 2));
}

/** Kayıtlı durum (deneme yapmadan); limiti dolmuş soğuma `ready` sayılır. */
export function storedAgentStatus(state, name) {
  const a = state?.agents?.[name];
  if (!a || !['auth_required', 'rate_limited'].includes(a.status)) return { status: 'ready', until: null };
  if (a.status === 'rate_limited' && a.until && Date.now() > Date.parse(a.until)) return { status: 'ready', until: null };
  return { status: a.status, until: a.status === 'rate_limited' ? a.until ?? null : null };
}

/**
 * hello'nun ajan alanları (§18): `agent` = yerel varsayılan, `agents` = kurulu
 * TÜM ajanlar. Yerel varsayılan kurulu değilse yine `not_installed` olarak
 * listelenir; kurulu olmayan diğerleri listelenmez.
 */
export function helloAgents(cfg, state, versions = agentVersions(cfg)) {
  const local = agentName(cfg);
  const agents = {};
  for (const n of AGENT_NAMES) {
    const version = versions[n] || null;
    if (!version) {
      if (n === local) agents[n] = { version: null, status: 'not_installed' };
      continue;
    }
    const s = storedAgentStatus(state, n);
    agents[n] = { version, status: s.status, ...(s.until ? { until: s.until } : {}) };
  }
  return { agent: local, agents };
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
  constructor({ cfg, openPr = ghOpenPr, prState = ghPrState }) {
    this.cfg = cfg;
    this.openPr = openPr;
    this.prState = prState;
    this.keptWarned = new Set();
    this.lastPrSync = 0;
    this.api = fixClient(cfg);
    this.state = loadState(cfg);
    this.busy = false;
    this.current = null; // { job, abort }
    this.wake = null;
    this.stopping = false;
    this.socket = null;
    this.socketChannel = null;
    this.lastProbe = {}; // ajan → son oturum denetimi
    this.agentCache = null; // { key, at, versions }
    this.agentsDirty = false; // bir ajanın durumu değişti, sunucu henüz bilmiyor
    this.agentSelect = false; // API panelden ajan seçimini biliyor mu (§18)
  }

  /** Durum ajan başınadır (§18): biri limitteyken diğeri iş almaya devam eder. */
  agentStatus(name = agentName(this.cfg)) {
    const a = this.state.agents[name] || { status: 'ready' };
    // Oturum düşmüştü: kullanıcı ajanına yeniden giriş yaptıysa 10 dakikada
    // bir denenir, çalışıyorsa Janet o ajanla işe kendisi döner.
    if (a.status === 'auth_required' && Date.now() - (this.lastProbe[name] || 0) > AUTH_REPROBE_MS) {
      this.lastProbe[name] = Date.now();
      if (probeAgent(this.cfg, name).ok) {
        log(`${AGENTS[name].label} oturumu geri geldi; Janet bu ajanla görev almaya devam ediyor.`);
        this.setAgentStatus(name, 'ready');
      }
    }
    if (a.status === 'rate_limited' && a.until && Date.now() > Date.parse(a.until)) this.setAgentStatus(name, 'ready');
    return storedAgentStatus(this.state, name).status;
  }

  setAgentStatus(name, status) {
    const prev = storedAgentStatus(this.state, name).status;
    this.state.agents[name] = {
      status,
      until: status === 'rate_limited' ? new Date(Date.now() + LIMIT_COOLDOWN_MS).toISOString() : null,
    };
    if (prev !== status) this.agentsDirty = true;
    saveState(this.cfg, this.state);
  }

  /** Kurulu ajanların sürümü (önbellekli; ayar değişince ya da 10 dk'da bir tazelenir). */
  agentVersions() {
    const key = JSON.stringify([agentName(this.cfg), ...AGENT_NAMES.map((n) => this.cfg.fix[n]?.bin || null)]);
    const c = this.agentCache;
    if (!c || c.key !== key || Date.now() - c.at > VERSION_TTL_MS) {
      this.agentCache = { key, at: Date.now(), versions: agentVersions(this.cfg) };
    }
    return this.agentCache.versions;
  }

  /** Claim edilebilir mi: en az bir kurulu ajan `ready` (eski API'de yalnız yerel ajan). */
  canClaim() {
    const v = this.agentVersions();
    // Eski API `job.agent` göndermez; iş hep yerel ajana gider, ona bakılır.
    const names = this.agentSelect ? AGENT_NAMES : [agentName(this.cfg)];
    return names.some((n) => v[n] && this.agentStatus(n) === 'ready');
  }

  // Ayar dosyası ve proje kökü her turda yeniden okunur: `fix link`, `fix
  // agent` ya da klasöre yeni bir proje eklemek yeniden başlatma gerektirmez.
  reloadLinks() {
    try {
      const fresh = loadConfig().fix;
      this.cfg.fix.links = fresh.links;
      this.cfg.fix.roots = fresh.roots;
      for (const k of ['agent', ...AGENT_NAMES]) this.cfg.fix[k] = fresh[k];
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
    const versions = this.agentVersions();
    // Önce süresi dolan limit / geri gelen oturum işlenir, sonra bildirilir.
    for (const n of AGENT_NAMES) if (versions[n]) this.agentStatus(n);
    const { agent, agents } = helloAgents(this.cfg, this.state, versions);
    this.agentsDirty = false;
    const res = await this.api('POST', '/v1/fix/hello', {
      hostname: os.hostname(),
      platform: `${os.platform()}-${os.arch()}`,
      version: VERSION,
      protocol: FIX_PROTOCOL,
      links: this.cfg.fix.links.map((l) => (l.domain ? { domain: l.domain } : { channel: l.channel })),
      // Kök bilinmiyorsa alan hiç gönderilmez: sunucudaki son liste silinmesin.
      projects: (this.cfg.fix.roots || []).length ? (this.projects || []).map((p) => ({ name: p.name, repos: p.repos.slice(0, 50) })) : undefined,
      // §18: yerel varsayılan + kurulu tüm ajanlar; sunucu işi ajanı hazır olana verir.
      agent,
      agents,
      busy_job_id: this.current?.job.id || null,
      // §16.4: diskte duran iş klasörleri. Sunucu bitmiş olanları `cleanup`'a ekler.
      local_jobs: listJobs(this.cfg.fix.workdir).map((j) => j.code).slice(0, LOCAL_JOBS_MAX),
    });

    // Panel seçimi yalnız gösterilir (`fix status`); yerel `fix.agent` değişmez.
    // Alanı hiç taşımayan yanıt = eski API, ajan seçimi yok.
    const m = res.machine || {};
    this.agentSelect = Object.hasOwn(m, 'default_agent');
    const panel = this.agentSelect ? m.default_agent ?? null : null;
    if (this.state.default_agent !== panel || this.state.agent_select !== this.agentSelect) {
      this.state.default_agent = panel;
      this.state.agent_select = this.agentSelect;
      saveState(this.cfg, this.state);
    }

    if (res.release?.is_outdated) {
      warn(`Yeni sürüm var: ${res.release.version} (kurulu ${VERSION}). Güncellemek için: npm i -g signalbird-cli`);
    }

    for (const c of res.cleanup || []) await this.cleanupJob(c);
    await this.syncPrs(res.open_prs || []);
    if (res.socket?.url && res.socket?.channel) this.connectSocket(res.socket).catch((e) => warn(`socket: ${e.message}`));

    return res;
  }

  /**
   * Kapatılan iş klasörü silinir. Kapanmamış ama bitmiş iş (`failed`,
   * `no_change`) yalnız kaybolacak bir şey yoksa silinir ve sunucuya
   * bildirilmez: yeniden denenirse klon uzaktan kurulur.
   */
  async cleanupJob({ job_id, code, state }) {
    // Sunucu kodu göndermezse iş klasöründeki işaretten bulunur.
    const entry = listJobs(this.cfg.fix.workdir).find((j) => (code && j.code === code) || j.marker?.job_id === job_id);
    if (this.current?.job.id === job_id) return; // çalışan iş: önce durdurulur, sonra temizlenir
    const closed = CLOSED_STATES.includes(state);
    let removed = [];
    if (entry) {
      const res = removeJob(this.cfg.fix.workdir, entry.code, { force: closed });
      removed = res.removed;
      if (res.kept.length) {
        // Her turda tekrar gelir; günlüğü doldurmasın.
        if (!this.keptWarned.has(entry.code)) {
          this.keptWarned.add(entry.code);
          warn(`${entry.code}: bazı klonlar korunuyor → ${res.kept.map((k) => `${k.name} (${k.reasons.join(', ')})`).join('; ')}`);
        }
        return;
      }
      log(`${entry.code}: iş ${state} → yerel klonlar silindi (${removed.join(', ') || 'boş'}).`);
    }
    if (!closed) return;
    try {
      await this.api('POST', `/v1/fix/jobs/${job_id}/cleaned`, { removed });
    } catch (err) {
      warn(`temizlik bildirilemedi (${job_id}): ${err.message}`);
    }
  }

  /**
   * §16.5: açık PR'ların GitHub'daki durumu. Panel "birleşti" diye gösterir;
   * iş kendiliğinden kapanmaz, "çözüldü" bilgisi kullanıcıdan gelir (§3).
   */
  async syncPrs(openPrs) {
    if (!openPrs.length || Date.now() - this.lastPrSync < PR_SYNC_MS) return;
    this.lastPrSync = Date.now();
    for (const { job_id, prs } of openPrs) {
      if (this.current?.job.id === job_id) continue;
      const next = prs.map((pr) => {
        const state = pr.state === 'merged' || pr.state === 'closed' ? pr.state : this.prState(pr.url);
        return state ? { ...pr, state } : pr;
      });
      if (next.every((pr, i) => pr.state === prs[i].state)) continue;
      try {
        await this.api('PATCH', `/v1/fix/jobs/${job_id}`, { prs: next });
      } catch (err) {
        warn(`PR durumu bildirilemedi (${job_id}): ${err.message}`);
      }
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

      if (!this.canClaim()) return;
      if (!this.cfg.fix.links.length && !(this.projects || []).length) return;

      for (;;) {
        const res = await this.api('POST', '/v1/fix/jobs/claim');
        if (!res.job) break;
        await this.processJob(res.job);
        if (this.stopping) break;
        // Bir ajanın durumu değiştiyse sunucu bayat durumla iş vermesin (§18).
        if (this.agentsDirty) await this.hello();
        if (!this.canClaim()) break;
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

  /**
   * İşin ajanı (§18): `job.agent` doluysa o (panel/eşleme seçimi), yoksa yerel
   * `fix.agent`. Ajan çalışamıyorsa iş BAŞKA ajana verilmez: hata fırlatılır,
   * iş `failed` olur.
   */
  pickAgent(job) {
    const wanted = job.agent;
    if (wanted != null && wanted !== '' && !AGENTS[wanted]) {
      throw new Error(`Panelde seçilen ajan "${wanted}" bu CLI sürümünde tanınmıyor (desteklenen: ${AGENT_NAMES.join(', ')}). İş başka ajanla çalıştırılmadı; CLI'ı güncelleyin (npm i -g signalbird-cli) ya da panelden başka ajan seçip yeniden deneyin.`);
    }
    const name = wanted || agentName(this.cfg);
    const why = wanted ? 'panel seçimi' : 'bu bilgisayardaki seçim (fix.agent)';
    const a = AGENTS[name];
    let version = this.agentVersions()[name];
    if (!version) {
      // Önbellek bayat olabilir: ajan son tazelemeden sonra kurulmuş olabilir.
      version = agentVersion(this.cfg, name);
      this.agentCache = null;
      if (version) this.agentsDirty = true;
    }
    const rest = `İş başka ajanla çalıştırılmadı.`;
    if (!version) {
      this.agentsDirty = true;
      throw new Error(`${a.label} bu bilgisayarda kurulu değil (${why}). Kurmak için: ${a.install}. ${rest}`);
    }
    const status = this.agentStatus(name);
    if (status === 'auth_required') {
      throw new Error(`${a.label} oturumu düşmüş (${why}). Bilgisayarda: ${a.login}. ${rest} Oturum gelince panelden "Yeniden dene" deyin.`);
    }
    if (status === 'rate_limited') {
      const until = storedAgentStatus(this.state, name).until;
      const end = until ? `, bitiş ${new Date(until).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : '';
      throw new Error(`${a.label} kullanım limitinde (${why}${end}). ${rest}`);
    }
    return { name, version, why };
  }

  async processJob(job) {
    const link = this.resolveLink(job);
    const abort = new AbortController();
    this.current = { job, abort };
    const logs = createLogUploader(this.api, job);
    const started = Date.now();

    log(`▶ ${job.code} (${targetLabel(job.domain ? { domain: job.domain } : { channel: job.channel?.key })}, deneme ${job.attempt}) ${String(job.title || job.event?.message || '').split('\n')[0].slice(0, 120)}`);

    let cancelTimer;
    try {
      const agent = this.pickAgent(job);
      const a = AGENTS[agent.name];
      const timeout = job.limits?.timeout_minutes || this.cfg.fix[agent.name]?.timeout_minutes || 60;
      logs.line(`● ajan: ${a.label} ${agent.version} · ${agent.why}`);

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

      const result = await runAgent({
        cfg: this.cfg,
        name: agent.name,
        cwd: ws.repos.length > 1 ? ws.dir : ws.repos[0].clone,
        prompt: buildPrompt({ job, ws, lookup: lookupCommand(job.id) }),
        model: null,
        // §15: `fix lookup` işi buradan bulur (komut --job'u da taşır).
        env: { SIGNALBIRD_FIX_JOB: job.id },
        timeoutMinutes: timeout,
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
        if (result.failure === 'auth_required' || result.failure === 'rate_limited') this.setAgentStatus(agent.name, result.failure);
        if (result.failure === 'not_installed') {
          // Kurulu değil durumu saklanmaz; sürüm yeniden okunur, sunucu öğrenir.
          this.agentCache = null;
          this.agentsDirty = true;
        }
        const why = result.timedOut
          ? `Zaman aşımı (${timeout} dk).`
          : result.failure === 'auth_required'
            ? `${a.label} oturumu düşmüş. Bilgisayarda: ${a.login}. Janet oturum gelince kendisi devam eder; bu görevi panelden "Yeniden dene" ile tekrar kuyruğa alın.`
            : result.failure === 'rate_limited'
              ? `${a.label} kullanım limiti doldu; bu ajan 30 dk iş almayacak (kurulu diğer ajanlar çalışmaya devam eder).`
              : result.failure === 'not_installed'
                ? `${a.label} bu bilgisayarda bulunamadı: ${a.install}`
                : `${a.label} hata ile bitti (çıkış ${result.exitCode}).`;
        writeMarker(ws.dir, { status: 'failed' });
        await logs.close();
        await this.report(job.id, { status: 'failed', error: redact(`${why}\n\n${result.tail.slice(-3000)}`).slice(0, 4500) });
        log(`✗ ${job.code}: ${why}`);
        return;
      }

      const summary = redact(extractSummary(result.finalText));
      const question = extractQuestion(redact(result.finalText));
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
        // Her şey uzakta: klon artık gereksiz, takipte `janet/<code>`dan yeniden
        // kurulur. Kapanmayı beklerse iş başına bir klon günlerce diskte kalıyordu.
        if (!fin.problems.length) removeJob(this.cfg.fix.workdir, job.code);
      } else if (fin.problems.length) {
        writeMarker(ws.dir, { status: 'failed' });
        await this.report(job.id, { status: 'failed', summary, error: fin.problems.join('\n').slice(0, 4500) });
        log(`✗ ${job.code}: ${fin.problems[0]}`);
      } else if (question) {
        // Protokol 3 (§13.5): Janet bilgi istedi, kod değiştirmedi.
        await this.report(job.id, { status: 'needs_input', question, summary });
        log(`? ${job.code}: Janet soru sordu: ${question.split('\n')[0].slice(0, 120)}`);
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
