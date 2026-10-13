import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export function sh(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

export function tmp(prefix = 'sbcli-') {
  return mkdtempSync(join(os.tmpdir(), prefix));
}

/**
 * Bir "GitHub" (çıplak depo) ve geliştiricinin yerel klonunu kurar.
 * origin adresi github.com'a benzemeli ki parseSlug kabul etsin: insteadOf ile
 * https://github.com/Org/<name> → yerel çıplak depoya yönlendirilir.
 */
export function makeRepo(base, name, { branches = ['main', 'test'] } = {}) {
  const bare = join(base, 'remote', `${name}.git`);
  mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '--bare', '-q', '-b', branches[0]);

  const seed = join(base, 'seed', name);
  mkdirSync(seed, { recursive: true });
  sh(seed, 'init', '-q', '-b', branches[0]);
  sh(seed, 'config', 'user.name', 't');
  sh(seed, 'config', 'user.email', 't@t');
  writeFileSync(join(seed, 'app.txt'), 'bug\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'remote', 'add', 'origin', bare);
  for (const b of branches) sh(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${b}`);

  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  const local = join(project, name);
  sh(base, 'clone', '-q', bare, local);
  sh(local, 'config', 'user.name', 't');
  sh(local, 'config', 'user.email', 't@t');
  sh(local, 'remote', 'set-url', 'origin', `https://github.com/Org/${name}.git`);
  return { bare, local, project };
}

/** git'in https://github.com/Org/ adresini yerel çıplak depolara çevirmesi. */
export function gitUrlRewriteEnv(base) {
  const cfg = join(base, 'gitconfig');
  writeFileSync(cfg, `[url "${join(base, 'remote')}/"]\n\tinsteadOf = https://github.com/Org/\n[user]\n\tname = t\n\temail = t@t\n[protocol "file"]\n\tallow = always\n`);
  return { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
}
