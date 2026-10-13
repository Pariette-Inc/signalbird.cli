// "adall git/adall altında" demek yeter: alt repolar, origin adresleri ve
// hedef dallar iş anında keşfedilir (PROTOCOL.md §8). Yeni bir repo eklemek
// için ayar gerekmez.

import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isGitRepo, parseSlug, tryGit, tryRun } from './git.mjs';

export const BASE_CANDIDATES = ['test', 'development', 'develop', 'dev'];

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'dist', 'build']);

/** Kök bir git deposuysa kendisi; değilse bir alt seviyedeki git depoları. */
export function discoverRepos(root, only = null) {
  let repos;

  if (isGitRepo(root)) {
    repos = [{ name: basename(root), path: root }];
  } else {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch (err) {
      throw new Error(`Klasör okunamadı: ${root} (${err.code || err.message})`);
    }
    repos = entries
      .filter((n) => !n.startsWith('.') && !SKIP_DIRS.has(n))
      .map((n) => ({ name: n, path: join(root, n) }))
      .filter((r) => {
        try {
          return statSync(r.path).isDirectory() && isGitRepo(r.path);
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (Array.isArray(only) && only.length) {
    const want = new Set(only);
    repos = repos.filter((r) => want.has(r.name));
  }

  return repos.map((r) => {
    const origin = tryGit(r.path, 'config', '--get', 'remote.origin.url');
    return { ...r, origin, slug: parseSlug(origin) };
  });
}

/** Uzaktaki dal adları (tek ağ çağrısı). */
export function remoteHeads(dir) {
  const out = tryRun('git', ['ls-remote', '--heads', '--symref', 'origin'], { cwd: dir, timeout: 60000 });
  if (out === null) return null;
  const heads = [];
  let head = null;
  for (const line of out.split('\n')) {
    const sym = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) {
      head = sym[1];
      continue;
    }
    const m = line.match(/\trefs\/heads\/(.+)$/);
    if (m) heads.push(m[1]);
  }
  return { heads, head };
}

/**
 * Hedef dal: ayar → test/development/develop/dev → origin'in varsayılanı.
 * `override` ya tüm repolar için bir dal adıdır ("test") ya da repo başına
 * harita ({"adall.api":"test"}). Repo başına verilen dal yoksa hata;
 * genel dal o repoda yoksa otomatik seçime düşülür (her repo aynı dalları
 * taşımaz).
 */
export function chooseBase({ heads, head }, override = null, repoName = null) {
  const perRepo = override && typeof override === 'object' ? override[repoName] : null;
  if (perRepo) {
    if (!heads.includes(perRepo)) {
      throw new Error(`"${perRepo}" dalı uzakta yok. Mevcut dallar: ${heads.slice(0, 15).join(', ')}`);
    }
    return perRepo;
  }
  if (typeof override === 'string' && heads.includes(override)) return override;
  for (const c of BASE_CANDIDATES) if (heads.includes(c)) return c;
  if (head && heads.includes(head)) return head;
  for (const c of ['main', 'master']) if (heads.includes(c)) return c;
  if (heads.length) return heads[0];
  throw new Error('Uzakta hiç dal yok.');
}

/** `fix link` çıktısı ve `fix doctor` için: repo → hedef dal özeti. */
export function describeLink(link) {
  const repos = discoverRepos(link.root, link.repos);
  return repos.map((r) => {
    if (!r.origin) return { ...r, base: null, problem: 'origin yok' };
    if (!r.slug) return { ...r, base: null, problem: 'GitHub deposu değil (PR açılamaz)' };
    const remote = remoteHeads(r.path);
    if (!remote) return { ...r, base: null, problem: 'origin\'e erişilemedi' };
    try {
      return { ...r, base: chooseBase(remote, link.base, r.name) };
    } catch (err) {
      return { ...r, base: null, problem: err.message };
    }
  });
}
