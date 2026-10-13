// `signalbird agent …` — sunucu ajanı rolü. Sözleşme: docs/AGENT-PROTOCOL.md.
// Düzeltici (fix) rolünden tamamen ayrıdır: farklı anahtar (sba_live_),
// farklı ayar dosyası (/etc/signalbird/agent.conf), root olarak çalışır.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_API } from '../config.mjs';
import { VERSION } from '../version.mjs';
import { makeAgentClient } from './client.mjs';
import { defaultIO } from './collect.mjs';
import { assertAgentKey, loadConf, writeConf } from './conf.mjs';
import { AGENT_PROTOCOL, AGENT_VERSION, agentPaths, EXIT_AUTH, SERVICE_NAME } from './constants.mjs';
import { makeLogger } from './logger.mjs';
import { AgentRunner, AuthError } from './runner.mjs';
import { BIN, ephemeralBin, installUnit, uninstallUnit, unitState } from './service.mjs';

export const AGENT_HELP = `Sunucu ajanı (müşteri sunucusu, root) — ölçüm + log + beklenen sinyal; komut ALMAZ
  sudo signalbird agent install --token=sba_live_… [--api URL] [--allow=/var/log,/srv/app/logs]
                                         Ayarı yazar, systemd servisini kurar ve başlatır
  signalbird agent run                   Sürekli çalışır (servis bunu kullanır)
  signalbird agent once                  Tek tur: ayar, log, dosya sinyalleri, ölçüm
  signalbird agent signal <anahtar> [ok|fail] [mesaj]
                                         Beklenen sinyali iletir (yedek betiğinin sonunda)
  signalbird agent status                Yerel ayar, servis durumu, bağlantı denemesi
  signalbird agent uninstall             Servisi kaldırır (ayar ve durum dosyaları kalır)
  signalbird agent version`;

const out = (...a) => console.log(...a);

function fail(msg, code = 1) {
  const e = new Error(msg);
  e.exitCode = code;
  throw e;
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function setup({ needConf = true } = {}) {
  const paths = agentPaths();
  try {
    mkdirSync(paths.stateDir, { recursive: true });
  } catch {}
  const log = makeLogger({ file: paths.log });
  const conf = needConf ? loadConf(paths.conf, log) : null;
  return { paths, log, conf };
}

function runner({ paths, log, conf }) {
  return new AgentRunner({ conf, paths, log, io: defaultIO(), client: makeAgentClient({ api: conf.api, token: conf.token }) });
}

// ── komutlar ────────────────────────────────────────────────────────

async function install(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { token: { type: 'string' }, api: { type: 'string' }, allow: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  });

  if (process.platform !== 'linux') fail('agent install yalnız Linux (systemd) içindir. Bu sistemde "signalbird agent run" ile ön planda çalıştırabilirsiniz.');
  if (!isRoot()) fail('Kurulum root gerektirir: sudo signalbird agent install --token=sba_live_…');
  if (Number(process.versions.node.split('.')[0]) < 20) fail(`Node 20+ gerekli (bu: ${process.version}).`);
  const token = (values.token || '').trim();
  assertAgentKey(token);
  if (ephemeralBin(BIN)) fail('npx ile servis kurulmaz (dosyalar geçici klasörde). Önce: sudo npm i -g signalbird-cli');

  const paths = agentPaths();
  const api = (values.api || DEFAULT_API).replace(/\/+$/, '');
  const allow = values.allow ? values.allow.split(',').map((s) => s.trim()).filter(Boolean).join(',') : null;

  // Yazmadan önce dene: yanlış anahtar ayar dosyasına ve servise girmesin.
  const probe = new AgentRunner({
    conf: { api, token, allowPaths: [], db: {} },
    paths: { ...paths, configCache: `${paths.stateDir}/config.json` },
    io: defaultIO(),
    client: makeAgentClient({ api, token }),
    log: (lvl, msg) => lvl !== 'bilgi' && out(`• ${msg}`),
  });
  mkdirSync(paths.stateDir, { recursive: true });
  try {
    if (await probe.hello()) out('✓ Signalbird anahtarı kabul etti.');
    else out('• Bağlantı doğrulanamadı; kurulum yine de yapılıyor (servis tekrar deneyecek).');
  } catch (err) {
    if (err instanceof AuthError) fail(err.message);
    throw err;
  }

  mkdirSync('/etc/signalbird', { recursive: true });
  const existed = existsSync(paths.conf);
  writeConf(paths.conf, { token, api, allow });
  await installUnit({ unitPath: paths.unit, stateDir: paths.stateDir });

  out(`\nKurulum tamam.\n`);
  out(`  Ayar dosyası : ${paths.conf}${existed ? ' (mevcut ayar korundu, anahtar güncellendi)' : ''}`);
  out(`  Servis       : systemctl status ${SERVICE_NAME}`);
  out(`  Günlük       : ${paths.log}  ·  journalctl -u ${SERVICE_NAME}`);
  out(`  Sinyal örneği: signalbird agent signal db-backup ok "yedek bitti"`);
  if (existsSync('/usr/local/bin/signalbird-agent')) {
    out(`\n  Not: eski bash ajanı (/usr/local/bin/signalbird-agent) artık servis tarafından kullanılmıyor; isterseniz silebilirsiniz.`);
  }
}

async function uninstall() {
  if (process.platform !== 'linux') fail('agent uninstall yalnız Linux (systemd) içindir.');
  if (!isRoot()) fail('Kaldırma root gerektirir: sudo signalbird agent uninstall');
  const paths = agentPaths();
  await uninstallUnit({ unitPath: paths.unit });
  // Ayar ve durum dosyaları BIRAKILIR: yeniden kurulumda anahtar ve log konumları kaybolmasın.
  out(`✓ Servis kaldırıldı. Ayar dosyası duruyor: ${paths.conf} · durum: ${paths.stateDir}`);
}

async function run() {
  const ctx = setup();
  const r = runner(ctx);
  const stop = () => r.stop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await r.run();
}

async function once() {
  const ctx = setup();
  const r = runner(ctx);
  await r.hello();
  if (!(await r.cycle())) fail(r.blocked ? `Signalbird veri kabul etmiyor (${r.blocked}).` : 'Ayar alınamadı; tur çalışmadı.');
  out('Tek tur tamamlandı.');
}

async function signal(argv) {
  const [key, status = 'ok', ...msg] = argv;
  if (!key) fail('Sinyal anahtarı gerekli: signalbird agent signal db-backup ok "mesaj"');
  const ctx = setup();
  const res = await runner(ctx).sendSignal(key, status, msg.join(' '));
  if (!res.ok) fail(res.code === 'UNKNOWN_SIGNAL_KEY' ? `"${key}" anahtarıyla bir izleme yok (panelde sinyal anahtarını kontrol edin).` : `Sinyal iletilemedi (HTTP ${res.status}).`);
  out(`✓ sinyal iletildi: ${key} (${status})`);
}

async function status() {
  const ctx = setup();
  const { paths, conf } = ctx;
  out(`Signalbird ajanı ${AGENT_VERSION} (signalbird-cli ${VERSION}, protokol ${AGENT_PROTOCOL})`);
  out(`  API        : ${conf.api}`);
  out(`  Anahtar    : ${conf.token.slice(0, 16)}…`);
  out(`  İzinli yol : ${conf.allowPaths.join(',')}`);
  out(`  Veritabanı : ${conf.db.driver || 'yerel ayarda yok'}`);
  let cv = 'henüz çekilmedi';
  try {
    if (existsSync(paths.configCache)) cv = String(JSON.parse(readFileSync(paths.configCache, 'utf8')).config_version ?? '?');
  } catch {}
  out(`  Ayar sürümü: ${cv}`);
  if (process.platform === 'linux') out(`  Servis     : ${(await unitState()) ?? 'systemctl yok'}`);
  out('\nBağlantı deneniyor...');
  const r = runner({ ...ctx, log: makeLogger({ file: null }) });
  if (await r.hello()) out('Bağlantı tamam.');
  else process.exitCode = 1;
}

export async function agentMain(argv) {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case 'install':
        return await install(rest);
      case 'uninstall':
        return await uninstall();
      case 'run':
        return await run();
      case 'once':
        return await once();
      case 'signal':
        return await signal(rest);
      case 'status':
        return await status();
      case 'version':
      case '--version':
      case '-v':
        return out(AGENT_VERSION);
      default:
        out(AGENT_HELP);
        if (sub && sub !== 'help' && sub !== '--help' && sub !== '-h') process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof AuthError) {
      try {
        makeLogger({ file: agentPaths().log, stderr: false })('hata', err.message);
      } catch {}
      console.error(`hata: ${err.message}`);
      process.exit(EXIT_AUTH);
    }
    console.error(`hata: ${err.message}`);
    process.exit(err.exitCode || 1);
  }
}
