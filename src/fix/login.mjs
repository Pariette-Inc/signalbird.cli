// `signalbird login`: hesapla giriş (cihaz akışı, PROTOCOL.md §12.2).
//
// Tarayıcı açılır, kullanıcı Signalbird oturumuyla "Bu bilgisayarı bağla"
// der; CLI onay gelene kadar bekler ve makine anahtarını (sbf_live_) alır.
// Anahtar kopyalamak yok. Makine onaylayan kullanıcıya aittir: üyesi olduğu
// her takımın Janet işlerini alabilir.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { ApiError, createClient } from '../api.mjs';
import { VERSION } from '../version.mjs';

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ api: string, onCode?: (info) => void, sleep?: (ms) => Promise<void>, open?: (url) => boolean }} p
 * @returns {Promise<{ token: string, machine: { id: number, name: string } }>}
 */
export async function deviceLogin({ api, onCode = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), open = openBrowser }) {
  const client = createClient({ api, role: 'login', headers: {}, retry: true });

  const start = await client('POST', '/v1/fix/device/start', {
    hostname: os.hostname(),
    platform: `${os.platform()}-${os.arch()}`,
    version: VERSION,
  });

  const opened = open(start.verify_url);
  onCode({ ...start, opened });

  const deadline = Date.now() + (start.expires_in || 600) * 1000;
  let interval = Math.max(1, Number(start.interval) || 3) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      const res = await client('POST', '/v1/fix/device/token', { device_code: start.device_code });
      if (res?.token) return { token: res.token, machine: res.machine || {} };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 428) continue; // onay bekleniyor
      if (err.status === 429) {
        interval += 2000;
        continue;
      }
      if (err.status === 403) throw new Error('Bağlantı tarayıcıda reddedildi.');
      if (err.status === 410) throw new Error('Kodun süresi doldu. Tekrar: signalbird login');
      throw err;
    }
  }
  throw new Error('Kodun süresi doldu. Tekrar: signalbird login');
}
