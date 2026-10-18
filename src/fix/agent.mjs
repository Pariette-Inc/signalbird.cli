// Janet'ın kodu düzelttiği yerel ajan: Claude Code, Codex (ChatGPT) ya da
// Gemini CLI. Üçü de kullanıcının KENDİ bilgisayarında, KENDİ hesabıyla
// çalışır; Signalbird yapay zekâ çağrısı yapmaz ve ücretini ödemez.
//
// Prompt her zaman stdin'den gider (ps çıktısında görünmez, uzunluk sınırı
// yok). Her ajanın kendi JSON akışı okunup canlı loga insan okunur satırlar
// hâlinde aktarılır.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { EXTENDED_PATH, resolveBin, tryRun } from './git.mjs';

/** Desteklenen ajanlar. Sıra, `login`in kendiliğinden seçtiği sıradır. */
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude setup-token  →  çıkan anahtarla: signalbird fix claude-token',
  },
  codex: {
    label: 'Codex (ChatGPT)',
    bin: 'codex',
    install: 'npm i -g @openai/codex',
    login: 'codex login   (ChatGPT hesabınızla)',
  },
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    install: 'npm i -g @google/gemini-cli',
    login: 'gemini (Google ile giriş) ya da: signalbird fix agent gemini --key <GEMINI_API_KEY>  (Workspace hesabı: --env GOOGLE_CLOUD_PROJECT=<proje>)',
  },
};

export const AGENT_NAMES = Object.keys(AGENTS);

export function agentName(cfg) {
  return AGENTS[cfg.fix.agent] ? cfg.fix.agent : 'claude';
}

function agentCfg(cfg, name) {
  return cfg.fix[name] || {};
}

export function agentBin(cfg, name = agentName(cfg)) {
  return resolveBin(agentCfg(cfg, name).bin || AGENTS[name].bin);
}

/**
 * Ajanın ortamı. `fix.<ajan>.env` burada eklenir (ör. Claude için
 * `claude setup-token` anahtarı, Gemini için GEMINI_API_KEY): terminal
 * oturumu düşse de arka plan servisi çalışmaya devam eder.
 */
export function agentEnv(cfg, name = agentName(cfg)) {
  return { ...process.env, ...(agentCfg(cfg, name).env || {}), PATH: EXTENDED_PATH, CI: '1', SIGNALBIRD_FIX: '1' };
}

export function agentVersion(cfg, name = agentName(cfg)) {
  const bin = agentBin(cfg, name);
  if (!bin) return null;
  const out = tryRun(bin, ['--version'], { timeout: 20000, env: agentEnv(cfg, name) });
  // Sunucu en fazla 40 karakter kabul eder; uzun / beklenmedik çıktı hello'yu düşürmesin.
  return out ? out.split('\n')[0].trim().slice(0, 40) || null : null;
}

const AUTH_RE = [
  /failed to authenticate/i, /oauth token (has )?expired/i, /not logged in/i, /please run \/login/i, /invalid api key/i,
  /authentication_error/i, /please (log ?in|sign in)/i, /run `?codex login/i, /401 unauthorized/i,
  /GOOGLE_CLOUD_PROJECT/, /GEMINI_API_KEY/, /auth(entication)? (method|required)/i,
];
const LIMIT_RE = [
  /usage limit reached/i, /rate[_ ]limit/i, /limit will reset/i, /out of (extended )?usage/i, /overloaded_error/i,
  /quota exceeded/i, /RESOURCE_EXHAUSTED/, /you've hit your usage limit/i,
];

export function classifyFailure(text) {
  const s = String(text || '');
  if (AUTH_RE.some((r) => r.test(s))) return 'auth_required';
  if (LIMIT_RE.some((r) => r.test(s))) return 'rate_limited';
  return null;
}

/**
 * Ajan gerçekten çalışıyor mu? Sürüm komutu oturumu denetlemez.
 * Claude ve Gemini'ye tek kelimelik istek gider; Codex kendi oturum
 * komutunu verir (istek harcamaz).
 * @returns {{ ok: boolean, failure: string|null, detail: string }}
 */
export function probeAgent(cfg, name = agentName(cfg)) {
  const bin = agentBin(cfg, name);
  if (!bin) return { ok: false, failure: 'not_installed', detail: `${AGENTS[name].bin} bulunamadı` };
  const run = (args, input) => {
    try {
      return {
        code: 0,
        out: execFileSync(bin, args, { input, encoding: 'utf8', timeout: 90000, env: agentEnv(cfg, name), stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() }),
      };
    } catch (err) {
      return { code: err.status ?? 1, out: String(err.stdout || '') + String(err.stderr || '') };
    }
  };

  if (name === 'codex') {
    const r = run(['login', 'status'], '');
    if (r.code === 0) return { ok: true, failure: null, detail: r.out.trim().slice(0, 200) };
    return { ok: false, failure: classifyFailure(r.out) || 'auth_required', detail: r.out.trim().slice(0, 200) };
  }

  if (name === 'gemini') {
    const r = run(['--output-format', 'json', 'Sadece OK yaz.'], '');
    let res = null;
    try {
      res = JSON.parse(r.out.slice(r.out.indexOf('{')));
    } catch {}
    if (r.code === 0 && res && !res.error) return { ok: true, failure: null, detail: '' };
    const text = res?.error?.message || r.out;
    return { ok: false, failure: classifyFailure(text) || 'error', detail: String(text).trim().slice(0, 200) };
  }

  const r = run(['-p', '--output-format', 'json', '--max-turns', '1'], 'Sadece OK yaz.');
  let res = null;
  try {
    res = JSON.parse(r.out.trim().split('\n').pop());
  } catch {}
  const text = res ? String(res.result ?? '') : r.out;
  if (res && !res.is_error) return { ok: true, failure: null, detail: '' };
  return { ok: false, failure: classifyFailure(text) || 'error', detail: text.slice(0, 200) };
}

function short(v, n = 160) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** Claude Code stream-json olayını bir log satırına çevirir. */
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
 * Her ajan için: argümanlar ve JSON olay okuyucusu. Okuyucu bir durum nesnesi
 * (`st`) tutar: `final` (son cevap), `error` (ajan hata bildirdi mi),
 * `errorText`. Döndürdüğü metin canlı loga yazılır.
 */
const DRIVERS = {
  claude: {
    args: (c, m) => ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...(m ? ['--model', m] : []), ...(c.extra_args || [])],
    read(ev, st) {
      if (ev.type === 'result') {
        st.done = true;
        st.error = Boolean(ev.is_error);
        if (typeof ev.result === 'string') st.final = ev.result;
      }
      if (ev.type === 'assistant') {
        const t = (ev.message?.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
        if (t) st.last = t;
      }
      return describeEvent(ev);
    },
  },

  // codex exec --json: thread.started, item.started/completed (agent_message,
  // command_execution, file_change, reasoning…), turn.completed / turn.failed, error.
  codex: {
    args: (c, m, st) => [
      'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
      '--output-last-message', st.lastFile, ...(m ? ['-m', m] : []), ...(c.extra_args || []), '-',
    ],
    read(ev, st) {
      return describeCodexEvent(ev, st);
    },
  },

  // gemini --output-format stream-json: init, message (delta), tool_use,
  // tool_result, error, result. Prompt stdin'den gelir; kısa konumsal istem
  // tek seferlik (etkileşimsiz) çalışmayı garantiler.
  gemini: {
    args: (c, m) => ['--yolo', '--output-format', 'stream-json', ...(m ? ['-m', m] : []), ...(c.extra_args || []), 'Yukarıdaki görevi uygula.'],
    read(ev, st) {
      return describeGeminiEvent(ev, st);
    },
  },
};

export function describeCodexEvent(ev, st = {}) {
  const it = ev.item || {};
  if (ev.type === 'thread.started') return '● oturum başladı (codex)';
  if (ev.type === 'item.completed' && it.type === 'agent_message' && it.text?.trim()) {
    st.last = it.text.trim();
    return st.last;
  }
  if (ev.type === 'item.started' && it.type === 'command_execution') return `▸ shell: ${short(String(it.command || '').replace(/^\/bin\/\w+ -lc /, ''))}`;
  if (ev.type === 'item.completed' && it.type === 'command_execution' && it.exit_code) return `  ✗ çıkış ${it.exit_code}: ${short(it.aggregated_output, 240)}`;
  if (ev.type === 'item.completed' && it.type === 'file_change') return `▸ edit: ${short((it.changes || []).map((x) => x.path).join(', '))}`;
  if (ev.type === 'turn.completed') {
    st.done = true;
    return '● bitti';
  }
  if (ev.type === 'turn.failed' || ev.type === 'error') {
    st.error = true;
    st.errorText = ev.error?.message || ev.message || JSON.stringify(ev);
    return `● hata: ${short(st.errorText, 240)}`;
  }
  return null;
}

export function describeGeminiEvent(ev, st = {}) {
  if (ev.type === 'init') return `● oturum başladı (model ${ev.model || '?'})`;
  if (ev.type === 'message' && ev.role === 'assistant') {
    // Parça parça gelir; tam cümle bir araç çağrısında ya da sonda yazılır.
    st.buf = (st.buf || '') + (ev.content || '');
    return null;
  }
  const flush = () => {
    const t = (st.buf || '').trim();
    st.buf = '';
    if (t) st.last = t;
    return t;
  };
  if (ev.type === 'tool_use') {
    const p = ev.parameters || {};
    const arg = p.command || p.file_path || p.absolute_path || p.path || p.pattern || p;
    return [flush(), `▸ ${ev.tool_name}: ${short(arg)}`].filter(Boolean).join('\n');
  }
  if (ev.type === 'tool_result' && ev.status === 'error') return `  ✗ ${short(ev.error?.message || ev.output, 240)}`;
  if (ev.type === 'error') {
    if (ev.severity === 'error') {
      st.error = true;
      st.errorText = ev.message;
    }
    return `● ${ev.severity || 'hata'}: ${short(ev.message, 240)}`;
  }
  if (ev.type === 'result') {
    st.done = true;
    if (ev.status === 'error') {
      st.error = true;
      st.errorText = ev.error?.message || 'hata';
    }
    const dur = ev.stats?.duration_ms ? `, ${Math.round(ev.stats.duration_ms / 1000)} sn` : '';
    return [flush(), `● bitti (${ev.status || 'result'}${dur})`].filter(Boolean).join('\n');
  }
  return null;
}

/**
 * Seçili ajanı görev klasöründe çalıştırır.
 * @returns {Promise<{ ok: boolean, finalText: string, exitCode: number|null, timedOut: boolean, canceled: boolean, failure: string|null, tail: string }>}
 */
export function runAgent({ cfg, name = agentName(cfg), cwd, prompt, model, env = {}, onLine = () => {}, timeoutMinutes, cancelSignal }) {
  const bin = agentBin(cfg, name);
  if (!bin) {
    return Promise.resolve({ ok: false, finalText: '', exitCode: null, timedOut: false, canceled: false, failure: 'not_installed', tail: `${AGENTS[name].bin} bulunamadı` });
  }

  const driver = DRIVERS[name];
  const c = agentCfg(cfg, name);
  const tmp = name === 'codex' ? mkdtempSync(join(os.tmpdir(), 'sbf-')) : null;
  const st = { final: '', last: '', error: false, errorText: '', done: false, lastFile: tmp ? join(tmp, 'last.txt') : null };
  const args = driver.args(c, model || c.model, st);

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...agentEnv(cfg, name), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });

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
        const text = driver.read(ev, st);
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

    const finish = (code) => {
      clearTimeout(timer);
      let finalText = st.final;
      if (!finalText && st.lastFile) {
        try {
          finalText = readFileSync(st.lastFile, 'utf8').trim();
        } catch {}
      }
      if (!finalText) finalText = (st.buf || '').trim() || st.last;
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      // Claude sonuç olayı verdiyse çıkış kodu değil o olay belirleyicidir.
      const isError = st.error || (code !== 0 && !(name === 'claude' && st.done));
      const failure = isError ? classifyFailure(`${st.errorText}\n${finalText}\n${tail}`) : null;
      resolve({ ok: !isError && !timedOut && !canceled, finalText, exitCode: code, timedOut, canceled, failure, tail });
    };

    child.on('close', finish);
    child.on('error', (err) => {
      clearTimeout(timer);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      resolve({ ok: false, finalText: '', exitCode: null, timedOut: false, canceled: false, failure: null, tail: err.message });
    });
  });
}
