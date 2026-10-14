// "adall git/adall altında" demek yeter: alt repolar, origin adresleri ve
// hedef dallar iş anında keşfedilir (PROTOCOL.md §8). Yeni bir repo eklemek
// için ayar gerekmez.

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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

// ── Projeler (protokol 2, PROTOCOL.md §12.4) ─────────────────────────
// Kökün altındaki her klasör bir projedir: ya kendisi git deposudur (tek
// repolu proje) ya da bir alt seviyesinde git depoları vardır. Sunucuya
// yalnız ADLAR gider; tam yol bilgisayarda kalır.

const MAX_PROJECTS = 200;

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @returns {Array<{ name: string, root: string, path: string, repos: string[] }>} */
export function discoverProjects(roots = []) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith('.') || SKIP_DIRS.has(name) || seen.has(name) || name.includes('/')) continue;
      const path = join(root, name);
      if (!isDir(path)) continue;
      let repos;
      if (isGitRepo(path)) {
        repos = [name];
      } else {
        try {
          repos = readdirSync(path)
            .filter((n) => !n.startsWith('.') && !SKIP_DIRS.has(n) && isDir(join(path, n)) && isGitRepo(join(path, n)))
            .sort((a, b) => a.localeCompare(b));
        } catch {
          repos = [];
        }
      }
      if (!repos.length) continue;
      seen.add(name);
      out.push({ name, root, path, repos });
      if (out.length >= MAX_PROJECTS) return out;
    }
  }
  return out;
}

/** Proje kökü adayları: içinde en az bir proje olan yaygın klasörler. */
export function suggestRoots(cwd = process.cwd()) {
  const home = process.env.HOME || '';
  const candidates = [];

  // Bir git deposunun içindeysek: depo kökünün iki üstü (…/git/adall/adall.api → …/git)
  // ya da bir üstü (…/git/penyu → …/git).
  const top = tryRun('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top) {
    const parent = join(top, '..');
    const grand = join(top, '..', '..');
    candidates.push(isGitRepo(parent) ? join(parent, '..') : grand, parent);
  }
  for (const d of ['git', 'code', 'Code', 'Projects', 'projects', 'src', 'Developer', 'dev', 'repos']) candidates.push(join(home, d));
  try {
    for (const v of readdirSync('/Volumes')) candidates.push(join('/Volumes', v, 'git'));
  } catch {}

  // ~/git çoğu zaman başka bir diske kısayoldur; gerçek yola göre tekilleştir.
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const uniq = [...new Set(candidates.map(real))];
  return uniq
    .map((root) => ({ root, count: discoverProjects([root]).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
}
