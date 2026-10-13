// Sunucu ajanı sabitleri. Sözleşme: docs/AGENT-PROTOCOL.md (protokol 1).
//
// AGENT_VERSION paketin sürümünden (package.json) AYRIDIR: sunucu bu değeri
// AgentRelease (kind=server) kaydıyla karşılaştırır ve eskiyse takıma
// "güncelleme var" bildirimi yollar (AGENT-PROTOCOL.md §8). CLI'nin 0.x
// sürümünü göndermek her sunucuyu "eski" gösterirdi. Bash ajanı 1.0.1'de;
// Node sürümü aynı protokolün yeni bir uygulamasıdır ve 1.1.0 ile başlar.

export const AGENT_VERSION = '1.1.0';
export const AGENT_PROTOCOL = 1;

export const DEFAULT_ALLOW = '/var/log';
export const SERVICE_NAME = 'signalbird-agent';

// 401'de süreç bu kodla çıkar; systemd birimi RestartPreventExitStatus ile
// bu kodda yeniden başlatmaz (§9: "sonsuz döngüde 401 üretmez").
export const EXIT_AUTH = 78;

// Ayar çekilemediğinde kullanılan aralıklar (§4 sınırlarıyla).
export const DEFAULT_INTERVAL = 60;
export const DEFAULT_REFRESH = 300;

// Sunucudaki doğrulamayla aynı sınırlar (AgentIngestController). Ajan kırpar.
export const LIMITS = Object.freeze({
  eventsPerRequest: 100,
  message: 3900, // sunucu 4000; bash ajanıyla aynı pay bırakılır
  source: 110, // sunucu 120
  contextPath: 200,
  channel: 40,
  level: 20,
  signalKey: 60,
  signalMessage: 500,
  maxLinesDefault: 200,
  maxLinesCap: 500,
  processesCap: 20,
  portsCap: 50,
  readBytesPerFile: 1024 * 1024,
});

/** Dosya yolları. Ortam değişkenleri yalnız test ve özel kurulum içindir. */
export function agentPaths(env = process.env) {
  const stateDir = env.SIGNALBIRD_AGENT_STATE_DIR || '/var/lib/signalbird';
  return {
    conf: env.SIGNALBIRD_AGENT_CONF || '/etc/signalbird/agent.conf',
    stateDir,
    state: `${stateDir}/state`,
    configCache: `${stateDir}/config.json`,
    log: env.SIGNALBIRD_AGENT_LOG || '/var/log/signalbird-agent.log',
    unit: env.SIGNALBIRD_AGENT_UNIT || `/etc/systemd/system/${SERVICE_NAME}.service`,
  };
}
