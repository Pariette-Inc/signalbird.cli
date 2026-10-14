// `fix install`: açılışta kendiliğinden başlayan kullanıcı servisi.
// macOS → launchd LaunchAgent, Linux → systemd --user. Root servisi değil.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from '../config.mjs';
import { EXTENDED_PATH, tryRun } from './git.mjs';

const LABEL = 'io.signalbird.fix';
const BIN = fileURLToPath(new URL('../../bin/signalbird.mjs', import.meta.url));

export function logFile() {
  return join(homeDir(), 'fix', 'fix.log');
}

function plistPath() {
  return join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function unitPath() {
  return join(os.homedir(), '.config', 'systemd', 'user', 'signalbird-fix.service');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function install() {
  mkdirSync(join(homeDir(), 'fix'), { recursive: true });
  const args = [process.execPath, BIN, 'fix', 'start'];

  if (process.platform === 'darwin') {
    const uid = process.getuid();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(EXTENDED_PATH)}</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logFile())}</string>
  <key>StandardErrorPath</key><string>${xml(logFile())}</string>
</dict>
</plist>
`;
    mkdirSync(join(os.homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    tryRun('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    writeFileSync(plistPath(), plist);
    // bootout eşzamansızdır: eski servis tam inmeden bootstrap "Input/output
    // error" (5) verir. İnmesini bekle, sonra birkaç kez dene (14 Eki 2026).
    for (let i = 0; i < 20 && tryRun('launchctl', ['print', `gui/${uid}/${LABEL}`]) !== null; i++) sleepMs(500);
    let ok = null;
    for (let i = 0; i < 5 && ok === null; i++) {
      if (i) sleepMs(1000);
      ok = tryRun('launchctl', ['bootstrap', `gui/${uid}`, plistPath()]);
    }
    if (ok === null) throw new Error(`launchctl bootstrap başarısız. Elle: launchctl bootstrap gui/${uid} ${plistPath()}`);
    return { kind: 'launchd', path: plistPath(), log: logFile() };
  }

  if (process.platform === 'linux') {
    const unit = `[Unit]
Description=Signalbird fix (telsiz alarmlarını düzelten yerel ajan)
After=network-online.target

[Service]
ExecStart=${args.map((a) => `"${a}"`).join(' ')}
Environment=PATH=${EXTENDED_PATH}
Restart=on-failure
RestartSec=30
StandardOutput=append:${logFile()}
StandardError=append:${logFile()}

[Install]
WantedBy=default.target
`;
    mkdirSync(join(os.homedir(), '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unitPath(), unit);
    tryRun('systemctl', ['--user', 'daemon-reload']);
    if (tryRun('systemctl', ['--user', 'enable', '--now', 'signalbird-fix.service']) === null) {
      throw new Error('systemctl --user enable başarısız.');
    }
    return { kind: 'systemd', path: unitPath(), log: logFile() };
  }

  throw new Error(`${process.platform} için servis kurulumu yok; "signalbird fix start" ile ön planda çalıştırın.`);
}

export function uninstall() {
  if (process.platform === 'darwin') {
    tryRun('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    if (existsSync(plistPath())) rmSync(plistPath());
    return true;
  }
  if (process.platform === 'linux') {
    tryRun('systemctl', ['--user', 'disable', '--now', 'signalbird-fix.service']);
    if (existsSync(unitPath())) rmSync(unitPath());
    tryRun('systemctl', ['--user', 'daemon-reload']);
    return true;
  }
  return false;
}

export function serviceStatus() {
  if (process.platform === 'darwin') {
    if (!existsSync(plistPath())) return { installed: false };
    const out = tryRun('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]) || '';
    const pid = out.match(/\bpid = (\d+)/)?.[1];
    return { installed: true, running: Boolean(pid), pid: pid ? Number(pid) : null };
  }
  if (process.platform === 'linux') {
    if (!existsSync(unitPath())) return { installed: false };
    const active = tryRun('systemctl', ['--user', 'is-active', 'signalbird-fix.service']);
    return { installed: true, running: active === 'active' };
  }
  return { installed: false };
}

/** Kuruluysa servisi yeniden başlatır (yeni anahtar / yeni bağ sonrası). */
export function restart() {
  const s = serviceStatus();
  if (!s.installed) return false;
  if (process.platform === 'darwin') return tryRun('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]) !== null;
  if (process.platform === 'linux') return tryRun('systemctl', ['--user', 'restart', 'signalbird-fix.service']) !== null;
  return false;
}
