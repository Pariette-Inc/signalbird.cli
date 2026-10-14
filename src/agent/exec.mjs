// Ajanın çalıştırabildiği dış komutlar. Liste BURADA sabittir ve panelden
// genişletilemez (AGENT-PROTOCOL.md §1.1). Listede olmayan bir komut
// çağrılırsa hata fırlatılır; böylece "yalnız şu komutlar çalışır" iddiası
// kodda denetlenebilir. Tam döküm: docs/AGENT-COMMANDS.md.
//
// Kabuk yok: her komut execFile ile argüman listesi olarak çalışır.

import { execFile } from 'node:child_process';

export const ALLOWED_COMMANDS = Object.freeze(['df', 'systemctl', 'ss', 'ps', 'mysql', 'psql']);

/**
 * @returns {(cmd: string, args: string[], opts?: { env?: object, timeout?: number }) =>
 *   Promise<{ ok: boolean, stdout: string, stderr: string, missing: boolean }>}
 */
export function makeExec({ timeoutMs = 10000 } = {}) {
  return function exec(cmd, args = [], { env, timeout } = {}) {
    if (!ALLOWED_COMMANDS.includes(cmd)) {
      return Promise.reject(new Error(`izinsiz komut: ${cmd} (bkz. docs/AGENT-COMMANDS.md)`));
    }
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          env: env ? { ...process.env, ...env } : process.env,
          timeout: timeout ?? timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            stdout: stdout || '',
            stderr: stderr || '',
            missing: err?.code === 'ENOENT',
          });
        },
      );
    });
  };
}
