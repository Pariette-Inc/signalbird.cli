// Yerel günlük. Sunucunun kendi diskine yazar, Signalbird'e gitmez: ajan
// Signalbird'e ulaşamadığında sorunun izini burada bırakır. Servis olarak
// çalışırken stderr journald'a düşer, elle çalışırken ekrana.

import { appendFileSync } from 'node:fs';
import { redact } from '../log.mjs';

export function makeLogger({ file = null, stderr = true } = {}) {
  return function log(level, message) {
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
    const line = `${stamp} [${level}] ${redact(message)}`;
    if (file) {
      try {
        appendFileSync(file, line + '\n');
      } catch {}
    }
    if (stderr) process.stderr.write(line + '\n');
  };
}

export const silentLogger = () => {};
