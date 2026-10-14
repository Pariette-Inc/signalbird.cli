// Beklenen sinyaller (AGENT-PROTOCOL.md §3.5). Sinyalin NE ZAMAN beklendiğine
// Signalbird karar verir; ajan yalnız "oldu" der.

import { statSync } from 'node:fs';
import { LIMITS } from './constants.mjs';

const head = (s, n) => Array.from(String(s ?? '')).slice(0, n).join('');

export function signalBody(key, status = 'ok', message = '') {
  if (!key || !String(key).trim()) throw new Error('Sinyal anahtarı gerekli: signalbird agent signal db-backup ok');
  if (status !== 'ok' && status !== 'fail') throw new Error(`Sinyal durumu "ok" ya da "fail" olmalı (verilen: ${status}).`);
  const body = { key: head(String(key).trim(), LIMITS.signalKey), status };
  if (message) body.message = head(message, LIMITS.signalMessage);
  return body;
}

export function humanSize(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n}${units[i]}` : `${n < 10 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

/**
 * `mode: file` sinyalleri: dosyanın değişim zamanına bakılır. Tazeyse "ok",
 * yoksa "fail"; bayatsa HİÇBİR ŞEY gönderilmez (pencere Signalbird'de kapanır
 * ve alarm oradan çalar). Bash ajanıyla aynı: her turda yeniden değerlendirilir.
 *
 * @returns {{ key: string, status: 'ok'|'fail', message: string }[]}
 */
export function fileSignals(specs, { now = Date.now(), stat = statSync } = {}) {
  const out = [];
  for (const s of Array.isArray(specs) ? specs : []) {
    if (!s || s.mode !== 'file' || !s.key || !s.path) continue;
    const maxAge = Number.isInteger(Number(s.max_age_minutes)) && Number(s.max_age_minutes) >= 0 ? Number(s.max_age_minutes) : 70;
    let st;
    try {
      st = stat(s.path);
    } catch {
      out.push({ key: s.key, status: 'fail', message: `dosya yok: ${s.path}` });
      continue;
    }
    if (!st.isFile()) {
      out.push({ key: s.key, status: 'fail', message: `dosya yok: ${s.path}` });
      continue;
    }
    const age = Math.max(0, Math.floor((now - st.mtimeMs) / 60000)); // saat kayması: gelecekteki mtime = 0
    if (age <= maxAge) out.push({ key: s.key, status: 'ok', message: `dosya ${age} dakika önce güncellendi (${humanSize(st.size)})` });
  }
  return out;
}
