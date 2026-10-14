// Log takibi (AGENT-PROTOCOL.md §3.4, §6, §9).
//
// Her dosya için en son gönderilen baytın konumu durum dosyasında tutulur.
// Biçim bash ajanıyla aynıdır (`log:_var_log_nginx_error.log=8123`), böylece
// bash ajanından geçen sunucu konumlarını kaybetmez. Node ajanı yanına dosya
// kimliğini (inode) de yazar: `ino:_var_log_nginx_error.log=1234`.
//
// Kurallar:
// - İlk görülen dosyanın geçmişi gönderilmez; konum dosya sonuna konur.
// - Dosya döndüyse (inode değişti ya da boyut küçüldü) BAŞTAN okunur.
//   (Bash 1.0.1'de dönen dosya "ilk görülen" sayılıp tamamen atlanıyordu.)
// - Konum yalnız gönderilen/elenen TAM satırların sonuna ilerler. max_lines,
//   istek başına 100 kayıt ya da 1 MiB okuma sınırında kalan satırlar bir
//   sonraki turda okunur; sonu "\n" ile bitmeyen yarım satır tamamlanana
//   kadar bekletilir. (Bash, sınırı aşan satırları atlayıp dosya sonuna
//   geçiyordu.)
// - Gönderim sonucu: 2xx ve 4xx (401 ve 429 hariç) konumu ilerletir; 5xx,
//   ağ hatası ve 429 ilerletmez; 401 döngüyü durdurur ve konuma dokunmaz.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { LIMITS } from './constants.mjs';

// ── durum dosyası ───────────────────────────────────────────────────

export class StateStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.dirty = false;
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) this.map.set(line.slice(0, eq), line.slice(eq + 1));
      }
    }
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    if (this.map.get(key) === String(value)) return;
    this.map.set(key, String(value));
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    writeFileSync(tmp, [...this.map].map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.dirty = false;
  }
}

export const stateKey = (path) => `log:${path.split('/').join('_')}`;
export const inodeKey = (path) => `ino:${path.split('/').join('_')}`;

// ── izinli yollar ───────────────────────────────────────────────────

/**
 * Panelden gelen yol, yerel `allow_paths` köklerinden birinin altında mı?
 * (§1.3: Signalbird hesabı ele geçse bile yeni bir dosya okutulamaz.)
 * Sembolik bağla dışarı çıkılmasın diye gerçek yol karşılaştırılır.
 */
export function pathAllowed(path, allowPaths, { realpath = realpathSync } = {}) {
  if (!path || !isAbsolute(String(path))) return false;
  if (String(path).split('/').includes('..')) return false;
  let real;
  try {
    real = realpath(path);
  } catch {
    real = resolve(path);
  }
  for (const rawRoot of allowPaths || []) {
    const root = String(rawRoot).trim().replace(/\/+$/, '');
    if (!root || !isAbsolute(root)) continue;
    const roots = new Set([root]);
    try {
      roots.add(realpath(root));
    } catch {}
    for (const r of roots) {
      if (real === r || real.startsWith(r + sep)) return true;
    }
  }
  return false;
}

// ── okuma ───────────────────────────────────────────────────────────

function openLog(path, maxBytes) {
  const fd = openSync(path, 'r');
  let st;
  try {
    st = fstatSync(fd);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return {
    st,
    read(from) {
      const len = Math.max(0, Math.min(maxBytes, st.size - from));
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      return buf.subarray(0, got);
    },
    close: () => closeSync(fd),
  };
}

/**
 * Tampondaki tam satırları verir: [{ text, end }]: `end` satırın "\n"
 * dahil bittiği göreli bayt. "\n" baytı UTF-8 çok baytlı dizilerin içinde
 * geçmez, bu yüzden bayt düzeyinde bölmek güvenlidir.
 */
export function splitLines(buf, { atEof, windowFull }) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push({ text: buf.subarray(start, i).toString('utf8').replace(/\r$/, ''), end: i + 1 });
      start = i + 1;
    }
  }
  // Yarım satır: dosya sonundaysa tamamlanmasını bekle. Pencere doluysa ve
  // içinde hiç "\n" yoksa (1 MiB'tan uzun tek satır) kırpılmış hâliyle tüketilir.
  if (start < buf.length && !atEof && windowFull && lines.length === 0) {
    lines.push({ text: buf.subarray(start).toString('utf8'), end: buf.length });
  }
  return lines;
}

const tail = (s, n) => {
  const a = Array.from(String(s));
  return a.length > n ? a.slice(-n).join('') : String(s);
};
const head = (s, n) => {
  const a = Array.from(String(s));
  return a.length > n ? a.slice(0, n).join('') : String(s);
};

function specInt(v, d) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : d;
}

/**
 * Panel ayarındaki `logs` listesinden bu turun kayıtlarını toplar.
 * Durum dosyasına yalnız "ilk görülme" yazılır; gönderime bağlı konumlar
 * `pending` olarak döner ve `commitPending` ile işlenir.
 *
 * @returns {{ events: object[], pending: Map<string,{offset:number, ino:number}>, rejected: string[] }}
 */
export function collectLogs({ specs, allowPaths, state, hostname, log = () => {}, warnedPaths = new Set(), realpath }) {
  const events = [];
  const pending = new Map();
  const rejected = [];

  for (const spec of Array.isArray(specs) ? specs : []) {
    if (!spec || typeof spec !== 'object') continue;
    const path = String(spec.path || '');
    if (!path) continue;

    if (!pathAllowed(path, allowPaths, realpath ? { realpath } : undefined)) {
      rejected.push(path);
      if (!warnedPaths.has(path)) {
        warnedPaths.add(path);
        log('uyari', `log yolu izinli değil, atlandı: ${path} (izinli kökler: ${allowPaths.join(',')})`);
      }
      continue;
    }

    const channel = head(spec.channel || 'sunucu', LIMITS.channel);
    const level = head(spec.level || 'error', LIMITS.level);
    const maxLines = Math.min(specInt(spec.max_lines, LIMITS.maxLinesDefault) || LIMITS.maxLinesDefault, LIMITS.maxLinesCap);
    let re = null;
    if (spec.match) {
      try {
        re = new RegExp(spec.match);
      } catch {
        log('uyari', `log süzgeci geçersiz, atlandı: ${path} (${spec.match})`);
        continue;
      }
    }

    let win;
    try {
      win = openLog(path, LIMITS.readBytesPerFile);
    } catch {
      log('uyari', `log okunamıyor: ${path}`);
      continue;
    }

    try {
      if (!win.st.isFile()) {
        // Klasör ya da FIFO: readSync EISDIR fırlatıp bütün turu durdururdu.
        if (!warnedPaths.has(`nf:${path}`)) {
          warnedPaths.add(`nf:${path}`);
          log('uyari', `log yolu bir dosya değil, atlandı: ${path}`);
        }
        continue;
      }
      const key = stateKey(path);
      const ikey = inodeKey(path);
      const size = win.st.size;
      const ino = Number(win.st.ino);

      // İlk görülme: geçmiş gönderilmez (müşteri kotasını bir yıllık loga yakmasın).
      if (!state.has(key)) {
        state.set(key, size);
        state.set(ikey, ino);
        continue;
      }

      let offset = specInt(state.get(key), 0);
      const knownIno = state.has(ikey) ? Number(state.get(ikey)) : null;
      if ((knownIno !== null && knownIno !== ino) || size < offset) offset = 0; // döndü
      if (knownIno === null) state.set(ikey, ino); // bash'ten gelen kayıt: kimlik eklenir

      if (size <= offset) {
        if (offset !== specInt(state.get(key), 0) || knownIno !== ino) pending.set(key, { offset, ino, path });
        continue;
      }
      if (events.length >= LIMITS.eventsPerRequest) continue; // bu istek dolu; sonraki tur

      const buf = win.read(offset);
      const atEof = offset + buf.length >= size;
      const lines = splitLines(buf, { atEof, windowFull: buf.length >= LIMITS.readBytesPerFile });

      let consumed = 0;
      let count = 0;
      for (const line of lines) {
        if (count >= maxLines) break;
        const text = line.text;
        const wanted = text.trim() !== '' && (!re || re.test(text));
        if (wanted && events.length >= LIMITS.eventsPerRequest) break;
        count++;
        consumed = line.end;
        if (!wanted) continue;
        events.push({
          channel,
          level,
          message: head(text, LIMITS.message),
          source: tail(`${hostname}:${path}`, LIMITS.source),
          context: { path: tail(path, LIMITS.contextPath) },
        });
      }

      if (consumed > 0 || offset !== specInt(state.get(key), 0) || knownIno !== ino) {
        pending.set(key, { offset: offset + consumed, ino, path });
      }
    } finally {
      win.close();
    }
  }

  return { events, pending, rejected };
}

export function commitPending(state, pending) {
  for (const [key, { offset, ino, path }] of pending) {
    state.set(key, offset);
    state.set(inodeKey(path), ino);
  }
}

/**
 * Gönderim sonucuna göre konum kararı (§9).
 * @returns {'advance'|'hold'|'fatal'}
 */
export function offsetDecision(status) {
  if (status >= 200 && status < 300) return 'advance';
  if (status === 401) return 'fatal';
  if (status === 429) return 'hold';
  if (status >= 400 && status < 500) return 'advance';
  return 'hold'; // 0 (ağ), 5xx, 3xx
}
