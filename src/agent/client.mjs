// Ajanın HTTP katmanı (AGENT-PROTOCOL.md §2). Mevcut createClient kullanılır
// ama TEKRAR DENEMESİZ: konum kuralları (§9) her yanıtın durum kodunu ister
// ve 2/5/15 sn'lik denemeler bir turu yarım dakika dondururdu. Tekrar, bir
// sonraki turdur.

import os from 'node:os';
import { ApiError, createClient } from '../api.mjs';
import { VERSION } from '../version.mjs';
import { AGENT_VERSION } from './constants.mjs';

export function agentUserAgent(platform = os.platform()) {
  return `signalbird-agent/${AGENT_VERSION} (${platform === 'darwin' ? 'macos' : platform}; signalbird-cli ${VERSION})`;
}

/**
 * @returns {(method: string, path: string, body?: object) => Promise<{ status: number, json: any, error?: string }>}
 *   status 0 = ağ hatası. Asla fırlatmaz.
 */
export function makeAgentClient({ api, token }) {
  const request = createClient({
    api,
    role: 'agent',
    retry: false,
    headers: {
      // Accept: application/json createClient'ta zaten var ve zorunlu (§2):
      // yoksa Laravel 422 yerine 302 döner.
      Authorization: `Bearer ${token}`,
      'User-Agent': agentUserAgent(),
    },
  });

  return async function call(method, path, body) {
    try {
      const json = await request(method, path, body);
      // createClient yalnız res.ok'ta döner; 200 ile 202 ayrımı gerekmiyor.
      return { status: 200, json };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, json: err.body, error: err.message };
      return { status: 0, json: null, error: err.message };
    }
  };
}
