export function log(...parts) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...parts);
}

export function warn(...parts) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] UYARI:`, ...parts);
}

// Log'a ve API'ye gitmeden önce bilinen gizli bilgi desenleri maskelenir
// (PROTOCOL.md §5.5). Amaç sızıntıyı azaltmak; tam güvence değildir.
const SECRET_PATTERNS = [
  /\bsb[a-z_]*_live_[A-Za-z0-9]{8,}/g,
  /\bsbf_live_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgho_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«gizlendi»');
  return out;
}
