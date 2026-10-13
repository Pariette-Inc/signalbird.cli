// Yerel ayar dosyası: /etc/signalbird/agent.conf (AGENT-PROTOCOL.md §5).
// Bash ajanıyla aynı biçim (anahtar=değer), aynı dosya: bash ajanından Node
// ajanına geçen sunucuda anahtar, izinli yollar ve veritabanı bilgisi korunur.
//
// Dosya hiçbir zaman çalıştırılmaz/yorumlanmaz; yalnız satır satır okunur.
// Veritabanı bilgisi bu dosyada kalır ve Signalbird'e gönderilmez (§1.4).

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DEFAULT_API } from '../config.mjs';
import { DEFAULT_ALLOW } from './constants.mjs';

export const AGENT_KEY_PREFIX = 'sba_live_';
const KNOWN = ['token', 'api_base', 'allow_paths', 'db_driver', 'db_host', 'db_port', 'db_user', 'db_pass', 'db_name'];

export function parseConf(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).replace(/\s+/g, '');
    if (!key || key.startsWith('#')) continue;
    // Değerin baştaki/sondaki boşluğu atılır, içerisi korunur (parolada boşluk olabilir).
    const value = raw.slice(eq + 1).replace(/\r$/, '').trim();
    if (KNOWN.includes(key)) out[key] = value;
  }
  return out;
}

export function splitAllow(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function assertAgentKey(token) {
  if (!token) throw new Error('Ajan anahtarı yok (token=sba_live_…).');
  if (!String(token).startsWith(AGENT_KEY_PREFIX)) {
    throw new Error('Sunucu ajanı yalnız sba_live_… anahtarıyla çalışır (sbf_ düzeltici, sb_secret_ gönderici içindir).');
  }
}

/** Ayarı okur ve doğrular. `log` uyarı yazmak içindir. */
export function loadConf(path, log = () => {}) {
  if (!existsSync(path)) throw new Error(`Ayar dosyası yok: ${path} (önce: sudo signalbird agent install --token=sba_live_…)`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Ayar dosyası okunamadı (${path}): ${err.code === 'EACCES' ? 'izin yok, sudo ile çalıştırın' : err.message}`);
  }
  const c = parseConf(text);
  assertAgentKey(c.token);

  let api = c.api_base || '';
  // 1.0.0 kurulumlarında var olmayan bir adres yazıldı; bash 1.0.1 ile aynı kural.
  if (/signalbird\.app/.test(api)) {
    log('uyari', `Ayar dosyasındaki api_base geçersiz (${api}), ${DEFAULT_API} kullanılıyor.`);
    api = '';
  }

  return {
    token: c.token,
    api: (api || DEFAULT_API).replace(/\/+$/, ''),
    allowPaths: splitAllow(c.allow_paths || DEFAULT_ALLOW),
    db: {
      driver: c.db_driver || '',
      host: c.db_host || '',
      port: c.db_port || '',
      user: c.db_user || '',
      pass: c.db_pass || '',
      name: c.db_name || '',
    },
  };
}

export function confTemplate({ token, api, allow }) {
  return `# Signalbird ajan yerel ayarı. Bu dosya sunucudan dışarı çıkmaz.
# Belgeler: https://github.com/Pariette-Inc/signalbird.cli (docs/AGENT-PROTOCOL.md §5)

token=${token}
api_base=${api}

# Panelden seçilen log yolları YALNIZ bu köklerin altındaysa okunur.
# Virgülle çoğaltılır: /var/log,/srv/uygulama/storage/logs
allow_paths=${allow}

# Veritabanı izleme açıksa kullanılır. Panele GÖNDERİLMEZ, panelde GÖRÜNMEZ.
# Salt okunur bir kullanıcı verin.
#db_driver=mysql
#db_host=127.0.0.1
#db_port=3306
#db_user=signalbird_ro
#db_pass=
#db_name=
`;
}

/**
 * Kurulumda ayarı yazar. Dosya varsa yalnız token ve api_base (ve açıkça
 * verildiyse allow_paths) değişir; veritabanı satırları korunur.
 */
export function writeConf(path, { token, api, allow = null }) {
  let text;
  if (existsSync(path)) {
    const keep = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(token|api_base)\s*=/.test(l) && !(allow && /^\s*allow_paths\s*=/.test(l)));
    while (keep.length && keep[keep.length - 1] === '') keep.pop();
    keep.push(`token=${token}`, `api_base=${api}`);
    if (allow) keep.push(`allow_paths=${allow}`);
    text = keep.join('\n') + '\n';
  } else {
    text = confTemplate({ token, api, allow: allow || DEFAULT_ALLOW });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
