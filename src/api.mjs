// Signalbird API istemcisi. Geçici hatalar (ağ, 5xx, 429) üç kez denenir;
// 4xx hemen fırlatılır — tekrar denemek kalıcı bir hatayı düzeltmez.

import os from 'node:os';
import { VERSION } from './version.mjs';

const RETRY_DELAYS_MS = [2000, 5000, 15000];

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }

  get transient() {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export function userAgent(role) {
  return `signalbird-cli/${VERSION} (${os.platform()}; ${role})`;
}

/**
 * @param {{ api: string, headers: Record<string,string>, role: string, log?: Function, retry?: boolean }} opts
 */
export function createClient({ api, headers, role, log = () => {}, retry = true }) {
  const base = api.replace(/\/+$/, '');

  return async function request(method, path, body) {
    const delays = retry ? RETRY_DELAYS_MS : [];
    let lastErr;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const res = await fetch(base + path, {
          method,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': userAgent(role),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });

        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = null;
        }

        if (res.ok) return json ?? {};

        throw new ApiError(
          `${method} ${path} → ${res.status} ${json?.code || ''} ${json?.message || text.slice(0, 200)}`.trim(),
          { status: res.status, code: json?.code || null, body: json },
        );
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(`${method} ${path} → ${err.message}`);
        if (!e.transient) throw e;
        lastErr = e;
      }

      if (attempt < delays.length) {
        log(`API geçici hata, ${delays[attempt] / 1000} sn sonra tekrar: ${lastErr.message}`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }

    throw lastErr;
  };
}
