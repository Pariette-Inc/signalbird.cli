// `agent install`: systemd SİSTEM servisi (root). Ajan sunucuda çalışır ve
// /var/log altındaki logları okuması gerekir; bash ajanıyla aynı birim adı
// (signalbird-agent.service) ve aynı sertleştirme. Bash ajanı kuruluysa bu
// birim onun yerine geçer; ayar ve durum dosyaları ortaktır.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_AUTH, SERVICE_NAME } from './constants.mjs';
import { makeExec } from './exec.mjs';

export const BIN = fileURLToPath(new URL('../../bin/signalbird.mjs', import.meta.url));

/** npx önbelleğinden çalışan bir kurulum yeniden açılışta kaybolur. */
export function ephemeralBin(bin = BIN) {
  return /[\\/]_npx[\\/]/.test(bin);
}

const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

export function unitText({ execPath = process.execPath, bin = BIN, stateDir = '/var/lib/signalbird' } = {}) {
  return `[Unit]
Description=Signalbird sunucu ajanı (signalbird agent)
Documentation=https://github.com/Pariette-Inc/signalbird.cli
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${q(execPath)} ${q(bin)} agent run
Restart=always
RestartSec=15
# 401 (anahtar geçersiz): yeniden başlatma, sonsuz 401 üretme.
RestartPreventExitStatus=${EXIT_AUTH}
# Ajan yalnız okur. Yazabildiği tek yer kendi durum klasörü ve kendi günlüğü.
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=${stateDir} /var/log

[Install]
WantedBy=multi-user.target
`;
}

export async function installUnit({ unitPath, stateDir, exec = makeExec() }) {
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unitText({ stateDir }), { mode: 0o644 });
  const steps = [
    ['daemon-reload'],
    ['enable', `${SERVICE_NAME}.service`],
    // enable --now çalışan (ör. eski bash) servisi yeniden başlatmaz.
    ['restart', `${SERVICE_NAME}.service`],
  ];
  for (const args of steps) {
    const r = await exec('systemctl', args);
    if (!r.ok) throw new Error(`systemctl ${args.join(' ')} başarısız: ${r.stderr.trim() || 'bilinmeyen hata'}`);
  }
}

export async function uninstallUnit({ unitPath, exec = makeExec() }) {
  await exec('systemctl', ['disable', '--now', `${SERVICE_NAME}.service`]);
  if (existsSync(unitPath)) rmSync(unitPath);
  await exec('systemctl', ['daemon-reload']);
}

export async function unitState(exec = makeExec()) {
  const r = await exec('systemctl', ['is-active', `${SERVICE_NAME}.service`]);
  if (r.missing) return null;
  return r.stdout.trim() || 'unknown';
}
