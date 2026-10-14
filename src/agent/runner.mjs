// Ajan döngüsü: hello → (log, dosya sinyali, ölçüm) → bekle → … ve her
// config_refresh_seconds'ta bir hello. AGENT-PROTOCOL.md §3, §4, §9.
//
// Ajan komut ALMAZ: sunucudan gelen tek şey `config`tir (hangi ölçüm açık,
// hangi aralıkla, hangi dosya). Ne çalıştırılacağına bu kaynak karar verir.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AGENT_PROTOCOL, AGENT_VERSION, DEFAULT_INTERVAL, DEFAULT_REFRESH } from './constants.mjs';
import { buildMetrics, defaultIO, helloPayload } from './collect.mjs';
import { collectLogs, commitPending, offsetDecision, StateStore } from './logs.mjs';
import { fileSignals, signalBody } from './signals.mjs';

export class AuthError extends Error {}

export function intervals(config) {
  const n = (v, d) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const interval = Math.min(3600, Math.max(30, n(config?.interval_seconds, DEFAULT_INTERVAL)));
  const refresh = Math.max(60, n(config?.config_refresh_seconds, DEFAULT_REFRESH));
  return { interval, refresh };
}

const ok2xx = (s) => s >= 200 && s < 300;

export class AgentRunner {
  /**
   * @param {{ conf: object, paths: object, client: Function, io?: object, log?: Function, cpuSampleMs?: number }} o
   */
  constructor({ conf, paths, client, io = defaultIO(), log = () => {}, cpuSampleMs = 1000 }) {
    this.conf = conf;
    this.paths = paths;
    this.client = client;
    this.io = io;
    this.log = log;
    this.cpuSampleMs = cpuSampleMs;
    this.config = null;
    this.blocked = null; // 403 kodu (MODULE_DISABLED); modül açılınca hello temizler
    this.startedAt = io.now();
    this.notifiedRelease = null;
    this.lastConfigVersion = null;
    this.warnedPaths = new Set();
    this.stopping = false;
    this.wake = null;
  }

  // ── ayar ──────────────────────────────────────────────────────────

  loadCachedConfig() {
    try {
      if (existsSync(this.paths.configCache)) this.setConfig(JSON.parse(readFileSync(this.paths.configCache, 'utf8')), false);
    } catch (err) {
      this.log('uyari', `ayar önbelleği okunamadı: ${err.message}`);
    }
  }

  setConfig(config, persist = true) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return;
    this.config = config;
    if (persist) {
      try {
        mkdirSync(dirname(this.paths.configCache), { recursive: true });
        const tmp = `${this.paths.configCache}.tmp`;
        writeFileSync(tmp, JSON.stringify(config), { mode: 0o600 });
        renameSync(tmp, this.paths.configCache);
      } catch (err) {
        this.log('uyari', `ayar önbelleğe yazılamadı: ${err.message}`);
      }
    }
    if (config.config_version !== undefined && config.config_version !== this.lastConfigVersion) {
      this.lastConfigVersion = config.config_version;
      this.log('bilgi', `ayar sürümü ${config.config_version} (aralık ${this.intervals().interval} sn)`);
    }
  }

  intervals() {
    return intervals(this.config);
  }

  /**
   * Açılışta ve her tazelemede. Hata hâlinde son bilinen ayarla devam.
   * @returns {Promise<boolean>} ayar sunucudan alındı mı
   */
  async hello() {
    const body = helloPayload(this.io, { version: AGENT_VERSION, protocol: AGENT_PROTOCOL, startedAt: this.startedAt });
    const res = await this.client('POST', '/v1/agent/hello', body);

    if (res.status === 401) throw new AuthError(`Anahtar reddedildi (HTTP 401${res.json?.code ? ` ${res.json.code}` : ''}). Panelden anahtarı yenileyip "signalbird agent install --token=…" çalıştırın.`);

    if (res.status === 403) {
      const code = res.json?.code || 'FORBIDDEN';
      if (this.blocked !== code) this.log('uyari', `Signalbird bu sunucudan veri kabul etmiyor (HTTP 403 ${code}). Paket/modül açılınca kendiliğinden devam eder.`);
      this.blocked = code;
      if (!this.config) this.loadCachedConfig();
      return false;
    }

    if (!ok2xx(res.status)) {
      this.log('uyari', `hello başarısız (HTTP ${res.status}), ayar ayrıca deneniyor`);
      // §3.2: GET /config aynı ayarı gövdesiz döner.
      const cfg = await this.client('GET', '/v1/agent/config');
      if (cfg.status === 401) throw new AuthError('Anahtar reddedildi (HTTP 401).');
      if (ok2xx(cfg.status) && cfg.json?.config) {
        this.blocked = null;
        this.setConfig(cfg.json.config);
        return true;
      }
      this.log('uyari', 'ayar çekilemedi, son bilinen ayarla devam');
      if (!this.config) this.loadCachedConfig();
      return false;
    }

    if (this.blocked) this.log('bilgi', 'Signalbird yeniden veri kabul ediyor.');
    this.blocked = null;
    if (res.json?.config) this.setConfig(res.json.config);
    else if (!this.config) this.loadCachedConfig();

    // Sürüm uyarısı. Ajan kendini GÜNCELLEMEZ (§3.1): yalnız haber verir.
    const rel = res.json?.release;
    if (rel?.is_outdated && rel.version && this.notifiedRelease !== rel.version) {
      this.notifiedRelease = rel.version;
      this.log('bilgi', `Yeni ajan sürümü var: ${rel.version} (kurulu: ${AGENT_VERSION}). Güncelleme kararı sizindir: npm i -g signalbird-cli${rel.notes_url ? ` · ${rel.notes_url}` : ''}`);
    }
    return true;
  }

  // ── tur ───────────────────────────────────────────────────────────

  async shipLogs() {
    const specs = this.config?.logs;
    if (!Array.isArray(specs) || !specs.length) return;

    const state = new StateStore(this.paths.state);
    const { events, pending } = collectLogs({
      specs,
      allowPaths: this.conf.allowPaths,
      state,
      hostname: this.io.os.hostname(),
      log: this.log,
      warnedPaths: this.warnedPaths,
    });

    if (!events.length) {
      // Gönderilecek satır yok (hepsi süzgeçte elendi ya da dönme): konum ilerler.
      commitPending(state, pending);
      state.save();
      return;
    }

    const res = await this.client('POST', '/v1/agent/logs', { events });
    const decision = offsetDecision(res.status);

    if (decision === 'fatal') {
      state.save(); // yalnız ilk-görülme kayıtları
      throw new AuthError('Anahtar reddedildi (HTTP 401).');
    }
    if (decision === 'advance') commitPending(state, pending);
    state.save();

    if (ok2xx(res.status)) {
      const accepted = Number(res.json?.accepted ?? events.length);
      if (accepted < events.length) {
        const codes = [...new Set(Object.values(res.json?.results || {}).filter((r) => r && !r.ok).map((r) => r.code))].join(',');
        this.log('uyari', `${events.length} log satırından ${events.length - accepted} tanesi Signalbird'de düştü (${codes || res.json?.code || '?'})`);
      } else {
        this.log('bilgi', `${events.length} log satırı gönderildi`);
      }
    } else if (decision === 'advance') {
      this.log('uyari', `log reddedildi (HTTP ${res.status}), ${events.length} satır atlandı`);
    } else {
      this.log('uyari', `log gönderilemedi (HTTP ${res.status}), konum ilerletilmedi`);
    }
  }

  async sendSignal(key, status = 'ok', message = '') {
    const body = signalBody(key, status, message);
    const res = await this.client('POST', '/v1/agent/signal', body);
    if (res.status === 401) throw new AuthError('Anahtar reddedildi (HTTP 401).');
    if (ok2xx(res.status)) {
      this.log('bilgi', `sinyal iletildi: ${body.key} (${body.status})`);
      return { ok: true, status: res.status };
    }
    const code = res.json?.code || '';
    const hint = code === 'UNKNOWN_SIGNAL_KEY' ? ': panelde bu anahtarla bir izleme yok' : '';
    this.log('uyari', `sinyal iletilemedi: ${body.key} (HTTP ${res.status}${code ? ` ${code}` : ''})${hint}`);
    return { ok: false, status: res.status, code };
  }

  async checkFileSignals() {
    for (const s of fileSignals(this.config?.signals, { now: this.io.now().getTime() })) {
      await this.sendSignal(s.key, s.status, s.message);
    }
  }

  async sendMetrics() {
    const body = await buildMetrics(this.io, this.config, this.conf, { log: this.log, cpuSampleMs: this.cpuSampleMs });
    const res = await this.client('POST', '/v1/agent/metrics', body);
    if (res.status === 401) throw new AuthError('Anahtar reddedildi (HTTP 401).');
    if (!ok2xx(res.status)) {
      this.log('uyari', `ölçüm gönderilemedi (HTTP ${res.status})`);
      return false;
    }
    return true;
  }

  /** Tek tur: log, dosya sinyalleri, ölçüm (bash ajanıyla aynı sıra). */
  async cycle() {
    if (this.blocked) return false;
    // §9: ilk açılışta ayar yoksa yalnız hello denenir.
    if (!this.config) {
      this.log('uyari', 'henüz ayar yok; yalnız hello deneniyor');
      return false;
    }
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof AuthError) throw err;
        this.log('uyari', `${name} adımı başarısız: ${err.message}`);
      }
    };
    await step('log', () => this.shipLogs());
    await step('sinyal', () => this.checkFileSignals());
    await step('ölçüm', () => this.sendMetrics());
    return true;
  }

  // ── döngü ─────────────────────────────────────────────────────────

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  stop() {
    this.stopping = true;
    this.wake?.();
  }

  /** Sürekli çalışır. 401'de AuthError fırlatır (çağıran çıkış koduyla çıkar). */
  async run() {
    this.log('bilgi', `ajan başladı (sürüm ${AGENT_VERSION}, ${this.conf.api})`);
    await this.hello();
    let lastRefresh = Date.now();

    while (!this.stopping) {
      await this.cycle();
      if (this.stopping) break;

      if ((Date.now() - lastRefresh) / 1000 >= this.intervals().refresh || !this.config) {
        await this.hello();
        lastRefresh = Date.now();
      }

      await this.sleep(this.intervals().interval * 1000);
    }
    this.log('bilgi', 'ajan durdu');
  }
}
