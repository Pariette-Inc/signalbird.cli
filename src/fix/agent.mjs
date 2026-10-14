// Claude Code'u başsız çalıştırır. Prompt stdin'den gider (ps çıktısında
// görünmez, uzunluk sınırı yok); çıktı stream-json olarak okunup canlı loga
// insan okunur satırlar hâlinde aktarılır.

import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { EXTENDED_PATH, resolveBin, tryRun } from './git.mjs';

export function claudeBin(cfg) {
  return resolveBin(cfg.fix.claude.bin || 'claude');
}

/**
 * Claude'un ortamı. `fix.claude.env` (ör. CLAUDE_CODE_OAUTH_TOKEN, `claude
 * setup-token` ile alınan uzun ömürlü anahtar) burada eklenir: terminal
 * oturumu düşse de arka plan servisi çalışmaya devam eder.
 */
export function claudeEnv(cfg) {
  return { ...process.env, ...(cfg.fix.claude.env || {}), PATH: EXTENDED_PATH, CI: '1', SIGNALBIRD_FIX: '1' };
}

/**
 * Claude gerçekten çalışıyor mu? Sürüm komutu oturumu denetlemez; tek
 * kelimelik bir istek gönderilir (~birkaç saniye, maliyeti yok denecek kadar az).
 * @returns {{ ok: boolean, failure: string|null, detail: string }}
 */
export function probeClaude(cfg) {
  const bin = claudeBin(cfg);
  if (!bin) return { ok: false, failure: 'not_installed', detail: 'claude bulunamadı' };
  let out;
  try {
    out = execFileSync(bin, ['-p', '--output-format', 'json', '--max-turns', '1'], {
      input: 'Sadece OK yaz.',
      encoding: 'utf8',
      timeout: 90000,
      env: claudeEnv(cfg),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: os.tmpdir(),
    });
  } catch (err) {
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  let res = null;
  try {
    res = JSON.parse(out.trim().split('\n').pop());
  } catch {}
  const text = res ? String(res.result ?? '') : out;
  if (res && !res.is_error) return { ok: true, failure: null, detail: '' };
  return { ok: false, failure: classifyFailure(text) || 'error', detail: text.slice(0, 200) };
}

export function claudeVersion(cfg) {
  const bin = claudeBin(cfg);
  if (!bin) return null;
  const out = tryRun(bin, ['--version'], { timeout: 20000 });
  // Sunucu en fazla 40 karakter kabul eder; uzun / beklenmedik çıktı hello'yu düşürmesin.
  return out ? out.split('\n')[0].trim().slice(0, 40) || null : null;
}

const AUTH_RE = [/failed to authenticate/i, /oauth token (has )?expired/i, /not logged in/i, /please run \/login/i, /invalid api key/i, /authentication_error/i];
const LIMIT_RE = [/usage limit reached/i, /rate[_ ]limit/i, /limit will reset/i, /out of (extended )?usage/i, /overloaded_error/i];

export function classifyFailure(text) {
  const s = String(text || '');
  if (AUTH_RE.some((r) => r.test(s))) return 'auth_required';
  if (LIMIT_RE.some((r) => r.test(s))) return 'rate_limited';
  return null;
}

function short(v, n = 160) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** stream-json olayını bir log satırına çevirir. */
export function describeEvent(ev) {
  if (ev.type === 'system' && ev.subtype === 'init') return `● oturum başladı (model ${ev.model || '?'})`;
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    return ev.message.content
      .map((c) => {
        if (c.type === 'text' && c.text?.trim()) return c.text.trim();
        if (c.type === 'tool_use') {
          const i = c.input || {};
          const arg = i.command || i.file_path || i.pattern || i.path || i.url || i.description || i;
          return `▸ ${c.name}: ${short(arg)}`;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    const errs = ev.message.content.filter((c) => c.type === 'tool_result' && c.is_error);
    if (errs.length) return errs.map((c) => `  ✗ ${short(c.content, 240)}`).join('\n');
    return null;
  }
  if (ev.type === 'result') {
    const cost = ev.total_cost_usd != null ? `, $${Number(ev.total_cost_usd).toFixed(2)}` : '';
    const dur = ev.duration_ms ? `, ${Math.round(ev.duration_ms / 1000)} sn` : '';
    return `● bitti (${ev.is_error ? 'hata' : ev.subtype || 'result'}${dur}${cost})`;
  }
  return null;
}

/**
 * @returns {Promise<{ ok: boolean, finalText: string, exitCode: number|null, timedOut: boolean, canceled: boolean, failure: string|null, tail: string }>}
 */
export function runClaude({ cfg, cwd, prompt, model, onLine = () => {}, timeoutMinutes, cancelSignal }) {
  const bin = claudeBin(cfg);
  if (!bin) {
    return Promise.resolve({ ok: false, finalText: '', exitCode: null, timedOut: false, canceled: false, failure: 'not_installed', tail: 'claude bulunamadı' });
  }

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  const m = model || cfg.fix.claude.model;
  if (m) args.push('--model', m);
  args.push(...(cfg.fix.claude.extra_args || []));

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: claudeEnv(cfg),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let finalText = '';
    let resultEvent = null;
    let lastAssistantText = '';
    let tail = '';
    let buf = '';
    let timedOut = false;
    let canceled = false;
    const keepTail = (s) => {
      tail = (tail + s).slice(-6000);
    };

    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      onLine(`● zaman aşımı (${timeoutMinutes} dk), durduruluyor`);
      kill();
    }, timeoutMinutes * 60000);

    cancelSignal?.addEventListener('abort', () => {
      canceled = true;
      onLine('● iş panelden durduruldu');
      kill();
    });

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          keepTail(line + '\n');
          onLine(line);
          continue;
        }
        if (ev.type === 'result') {
          resultEvent = ev;
          finalText = typeof ev.result === 'string' ? ev.result : '';
        }
        if (ev.type === 'assistant') {
          const t = (ev.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
          if (t) lastAssistantText = t;
        }
        const text = describeEvent(ev);
        if (text) {
          keepTail(text + '\n');
          onLine(text);
        }
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      keepTail(s);
      onLine(s.trimEnd());
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!finalText) finalText = lastAssistantText;
      const isError = resultEvent ? Boolean(resultEvent.is_error) : code !== 0;
      const failure = isError ? classifyFailure(`${finalText}\n${tail}`) : null;
      resolve({
        ok: !isError && !timedOut && !canceled,
        finalText,
        exitCode: code,
        timedOut,
        canceled,
        failure,
        tail,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, finalText: '', exitCode: null, timedOut: false, canceled: false, failure: null, tail: err.message });
    });
  });
}
