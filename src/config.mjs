// Yerel ayar: ~/.signalbird/config.json (0600). Anahtarlar ve yerel yollar
// yalnız burada durur; API'ye yol gönderilmez (PROTOCOL.md §1.4).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_API = 'https://live.signalbird.io/api';

export function homeDir() {
  return process.env.SIGNALBIRD_HOME || join(os.homedir(), '.signalbird');
}

export function configPath() {
  return process.env.SIGNALBIRD_CONFIG || join(homeDir(), 'config.json');
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return join(os.homedir(), p.slice(2));
  return resolve(p);
}

export function defaults() {
  return {
    api: DEFAULT_API,
    fix: {
      key: null,
      workdir: join(homeDir(), 'fix'),
      agent: 'claude',
      claude: { bin: null, model: null, extra_args: [], timeout_minutes: 60 },
      links: [],
    },
    send: { key: null },
  };
}

export function loadConfig() {
  const base = defaults();
  const path = configPath();
  if (!existsSync(path)) return base;

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Ayar dosyası okunamadı (${path}): ${err.message}`);
  }

  return {
    ...base,
    ...raw,
    fix: {
      ...base.fix,
      ...(raw.fix || {}),
      claude: { ...base.fix.claude, ...(raw.fix?.claude || {}) },
      links: Array.isArray(raw.fix?.links) ? raw.fix.links : [],
    },
    send: { ...base.send, ...(raw.send || {}) },
  };
}

export function saveConfig(cfg) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** "adall.io" → domain, "#kanal" ya da noktasız → kanal. */
export function parseTarget(target, { channel = false } = {}) {
  const t = String(target || '').trim();
  if (!t) throw new Error('Hedef boş: domain (adall.io) ya da kanal anahtarı verin.');
  if (channel || t.startsWith('#')) return { channel: t.replace(/^#/, '') };
  if (!t.includes('.')) return { channel: t };
  return { domain: t.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') };
}

export function sameTarget(a, b) {
  return (a.domain && a.domain === b.domain) || (a.channel && a.channel === b.channel);
}

export function targetLabel(t) {
  return t.domain ? t.domain : `#${t.channel}`;
}

/** İş hangi bağa düşer: önce domain, sonra kanal. */
export function findLink(links, job) {
  const domain = job.domain ? String(job.domain).toLowerCase() : null;
  const channel = job.channel?.key || null;
  return (
    (domain && links.find((l) => l.domain === domain)) ||
    (channel && links.find((l) => l.channel === channel)) ||
    null
  );
}
