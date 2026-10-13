// Kabuk yok: her komut execFile ile, argüman listesiyle çalışır.
// Böylece olay metninden gelen hiçbir değer kabukta yorumlanmaz.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

/**
 * launchd/systemd kısıtlı PATH ile başlatır; claude/gh/node genelde nvm,
 * homebrew ya da ~/.local/bin altındadır. Bu dizinler PATH'e eklenir.
 */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH || '').split(':'),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];

  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of readdirSync(nvmRoot).sort().reverse()) dirs.push(join(nvmRoot, v, 'bin'));
  } catch {}

  return [...new Set(dirs.filter(Boolean))];
}

export const BIN_DIRS = candidateDirs();
export const EXTENDED_PATH = BIN_DIRS.join(':');

export function resolveBin(name) {
  if (!name) return null;
  if (name.includes('/')) return existsSync(name) ? name : null;
  for (const dir of BIN_DIRS) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export function run(bin, args, { cwd, input, timeout = 300000, env } = {}) {
  return execFileSync(resolveBin(bin) || bin, args, {
    cwd,
    input,
    timeout,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: EXTENDED_PATH, GIT_TERMINAL_PROMPT: '0', ...env },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function tryRun(bin, args, opts) {
  try {
    return run(bin, args, opts);
  } catch {
    return null;
  }
}

export const git = (cwd, ...args) => run('git', args, { cwd });
export const tryGit = (cwd, ...args) => tryRun('git', args, { cwd });

export function errText(err) {
  const stderr = err?.stderr ? String(err.stderr).trim() : '';
  return stderr || err?.message || String(err);
}

export function isGitRepo(dir) {
  return existsSync(join(dir, '.git'));
}

/**
 * GitHub "Org/repo" kısaltması. https, ssh ve ssh takma ad (git@github-is:Org/repo)
 * biçimlerini tanır; GitHub dışı bir adreste null döner.
 */
export function parseSlug(url) {
  if (!url) return null;
  const u = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let m = u.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) m = u.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/);
  if (!m) m = u.match(/^(?:[^@/]+@)?([^:/]+):([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const [, host, owner, repo] = m;
  if (!/github/i.test(host)) return null;
  return `${owner}/${repo}`;
}
