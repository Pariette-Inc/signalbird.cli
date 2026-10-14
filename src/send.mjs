// `signalbird send`: telsize tek mesaj. Deploy betiği, cron, elle bildirim.
// Domain gizli anahtarı (sb_secret_live_) ister; düzeltici ya da sunucu
// anahtarıyla çalışmaz.

import { createClient } from './api.mjs';

export const LEVELS = ['debug', 'info', 'warn', 'error', 'critical'];

export async function send({ cfg, key, channel, level, message, source, context }) {
  const k = key || process.env.SIGNALBIRD_KEY || cfg.send.key;
  if (!k) throw new Error('Anahtar yok: --key sb_secret_live_… verin, SIGNALBIRD_KEY ortam değişkenini ya da "signalbird send login --key …" kullanın.');
  if (!k.startsWith('sb_secret_live_')) throw new Error('send için domain gizli anahtarı (sb_secret_live_…) gerekir.');
  if (!channel) throw new Error('Kanal yok: --channel <kanal-anahtarı>');
  if (!LEVELS.includes(level)) throw new Error(`Seviye şunlardan biri olmalı: ${LEVELS.join(', ')}`);
  if (!message) throw new Error('Mesaj boş.');

  const api = createClient({ api: cfg.api, role: 'send', headers: { 'X-Signalbird-Key': k } });
  const body = { key: channel, level, message: String(message).slice(0, 4000) };
  if (source) body.source = String(source).slice(0, 120);
  if (context) body.context = context;
  return api('POST', '/v1/radio/log', body);
}
