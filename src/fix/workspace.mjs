// İş klasörü yaşam döngüsü (PROTOCOL.md §9).
//
//   ~/.signalbird/fix/jobs/<code>/
//     .signalbird-job.json      ← işaret: hangi iş, hangi repolar, hangi süreç
//     adall.api/                ← yerel klon, dal janet/<code>
//     adall.web/
//
// Git worktree değil, yerel klon: ana repoya kayıt düşmez (VS Code'da
// görünmez, ana repodaki dal kilitlenmez) ve silmek klasörü silmektir.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseBase, discoverRepos, remoteHeads } from './discover.mjs';
import { errText, git, run, tryGit, tryRun } from './git.mjs';

export const MARKER = '.signalbird-job.json';
const DEP_DIRS = ['node_modules', 'vendor'];

export function jobsRoot(workdir) {
  return join(workdir, 'jobs');
}

export function jobDir(workdir, code) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) throw new Error(`Geçersiz iş kodu: ${code}`);
  return join(jobsRoot(workdir), code);
}

export function branchFor(job) {
  return job.branch || `janet/${job.code}`;
}

export function readMarker(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

export function writeMarker(dir, data) {
  mkdirSync(dir, { recursive: true });
  const prev = readMarker(dir) || {};
  writeFileSync(join(dir, MARKER), JSON.stringify({ ...prev, ...data, pid: process.pid, touched_at: new Date().toISOString() }, null, 2));
}

/** node_modules/vendor: aynı APFS diskinde klon (saniyeler), aksi hâlde symlink. */
/**
 * Bağımlılık bağlarını git'e görünmez yapar. `.gitignore` çoğu zaman
 * `vendor/` / `node_modules/` yazar; sondaki `/` yalnız KLASÖRÜ dışlar,
 * bizim koyduğumuz sembolik bağı değil. Git onu yeni dosya sanıyor, Janet de
 * "commit edilmemiş değişiklik" diye commit'leyip PR açıyordu (14 Eki,
 * veribenim.php.sdk#1). Yalnız bu klonun .git/info/exclude'una yazılır.
 */
function excludeDeps(dst) {
  try {
    const file = join(dst, '.git', 'info', 'exclude');
    mkdirSync(join(dst, '.git', 'info'), { recursive: true });
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const add = DEP_DIRS.map((d) => `/${d}`).filter((l) => !cur.split('\n').includes(l));
    if (add.length) writeFileSync(file, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + '# Janet: bağımlılık bağları\n' + add.join('\n') + '\n');
  } catch {}
}

function linkDeps(src, dst, log) {
  excludeDeps(dst);
  for (const dep of DEP_DIRS) {
    const from = join(src, dep);
    const to = join(dst, dep);
    if (!existsSync(from) || existsSync(to)) continue;
    const sameDisk = statSync(from).dev === statSync(dst).dev;
    if (sameDisk && process.platform === 'darwin' && tryRun('cp', ['-c', '-R', from, to], { timeout: 600000 }) !== null) continue;
    try {
      symlinkSync(from, to, 'dir');
    } catch (err) {
      log(`${dep} bağlanamadı: ${err.message}`);
    }
  }
}

/** Yarım kalmış rebase/merge/cherry-pick durumlarını kapatır. */
function abortPending(dir) {
  for (const op of [['rebase', '--abort'], ['merge', '--abort'], ['cherry-pick', '--abort']]) tryGit(dir, ...op);
}

/**
 * Repoları iş klasörüne hazırlar. Takip denemesinde (klon duruyorsa) aynı
 * dalda kalır; yoksa uzaktaki iş dalından, o da yoksa hedef daldan kurar.
 *
 * @returns {{ dir: string, branch: string, repos: Array<{name,path,clone,origin,slug,base}> }}
 */
export function prepare({ job, link, workdir, log = () => {} }) {
  const dir = jobDir(workdir, job.code);
  const branch = branchFor(job);
  mkdirSync(dir, { recursive: true });

  const discovered = discoverRepos(link.root, link.repos);
  if (!discovered.length) throw new Error(`${link.root} altında git deposu bulunamadı.`);

  const repos = [];
  for (const r of discovered) {
    if (!r.origin || !r.slug) {
      log(`${r.name}: GitHub origin'i yok, atlandı.`);
      continue;
    }

    const remote = remoteHeads(r.path);
    if (!remote) {
      log(`${r.name}: origin'e erişilemedi, atlandı.`);
      continue;
    }

    const base = chooseBase(remote, link.base, r.name);
    const clone = join(dir, r.name);
    const remoteHasBranch = remote.heads.includes(branch);

    if (existsSync(join(clone, '.git'))) {
      abortPending(clone);
      git(clone, 'fetch', 'origin', base, ...(remoteHasBranch ? [branch] : []));
      if (tryGit(clone, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) !== null) {
        git(clone, 'checkout', branch);
        // İnceleme sırasında başkası iş dalına push ettiyse onu da al.
        if (remoteHasBranch) tryGit(clone, 'merge', '--ff-only', `origin/${branch}`);
      } else {
        git(clone, 'checkout', '-B', branch, remoteHasBranch ? `origin/${branch}` : `origin/${base}`);
      }
    } else {
      log(`${r.name}: klonlanıyor (hedef ${base})`);
      // --shared: nesneler kopyalanmaz, ana repodan okunur (alternates). Repolar
      // ayrı bir diskteyse (ör. /Volumes/…) hardlink çalışmaz ve düz klon
      // tüm .git'i kopyalardı. Klon kısa ömürlü olduğu için risk düşük.
      run('git', ['clone', '--shared', '--no-checkout', '--quiet', r.path, clone], { timeout: 900000 });
      git(clone, 'remote', 'set-url', 'origin', r.origin);
      git(clone, 'fetch', '--quiet', 'origin', base, ...(remoteHasBranch ? [branch] : []));
      git(clone, 'checkout', '--quiet', '-B', branch, remoteHasBranch ? `origin/${branch}` : `origin/${base}`);
      // Kimlik ana repodan gelsin; global ayar yoksa commit düşmesin.
      for (const key of ['user.name', 'user.email']) {
        const v = tryGit(r.path, 'config', key);
        if (v) git(clone, 'config', key, v);
      }
      linkDeps(r.path, clone, log);
    }

    repos.push({ name: r.name, path: r.path, clone, origin: r.origin, slug: r.slug, base });
  }

  if (!repos.length) throw new Error('Çalışılabilecek repo kalmadı (origin/erişim sorunları yukarıda).');

  writeMarker(dir, {
    job_id: job.id,
    code: job.code,
    branch,
    status: 'running',
    repos: repos.map(({ name, base, slug }) => ({ name, base, slug })),
  });

  return { dir, branch, repos };
}

function aheadCount(clone, ref) {
  const n = tryGit(clone, 'rev-list', '--count', `${ref}..HEAD`);
  return n === null ? null : Number(n);
}

/**
 * Ajan bittikten sonra: değişikliği olmayan klonu siler, olanı push eder ve
 * PR'ını açar (ya da var olan PR'a push eder).
 *
 * @param {object} p
 * @param {Function} p.openPr  ({repo, branch, title, body}) → {url, number}
 */
export function finalize({ job, ws, title, body, openPr, log = () => {} }) {
  const prs = [];
  const problems = [];
  const touched = [];

  for (const r of ws.repos) {
    const { clone, base } = r;
    try {
      abortPending(clone);
      const head = tryGit(clone, 'rev-parse', '--abbrev-ref', 'HEAD');
      if (head !== ws.branch) {
        problems.push(`${r.name}: ajan dalı değiştirmiş (${head}); push edilmedi.`);
        touched.push(r.name);
        continue;
      }

      excludeDeps(clone);
      if (tryGit(clone, 'status', '--porcelain')) {
        git(clone, 'add', '-A');
        git(clone, 'commit', '-q', '-m', `${job.code}: ajanın commit etmediği değişiklikler`);
      }

      const vsBase = aheadCount(clone, `origin/${base}`);
      if (!vsBase) {
        log(`${r.name}: değişiklik yok, klon siliniyor.`);
        rmSync(clone, { recursive: true, force: true });
        continue;
      }

      touched.push(r.name);
      const remoteBranch = tryGit(clone, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ws.branch}`);
      const vsRemote = remoteBranch ? aheadCount(clone, `origin/${ws.branch}`) : vsBase;

      if (vsRemote > 0) {
        try {
          git(clone, 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${ws.branch}`);
        } catch (err) {
          // Uzak dal ilerlemiş: üstüne al ve tekrar dene. Force yok.
          log(`${r.name}: push reddedildi, rebase deneniyor (${errText(err).split('\n')[0]})`);
          git(clone, 'fetch', 'origin', ws.branch);
          try {
            git(clone, 'rebase', `origin/${ws.branch}`);
          } catch (e) {
            abortPending(clone);
            throw new Error(`rebase çakıştı; değişiklikler yerelde duruyor (${clone})`);
          }
          git(clone, 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${ws.branch}`);
        }
      }

      const pr = openPr({ repo: r, branch: ws.branch, title, body });
      prs.push({ repo: r.slug, url: pr.url, number: pr.number, base });
    } catch (err) {
      problems.push(`${r.name}: ${errText(err)}`);
      touched.push(r.name);
    }
  }

  writeMarker(ws.dir, { touched, prs });

  // Hiçbir repoda iz kalmadıysa iş klasörünün kendisi de gider.
  if (!touched.length) removeDir(ws.dir);

  return { prs, problems, touched };
}

/** gh ile PR açar; aynı dal için açık PR varsa onu döner. */
export function ghOpenPr({ repo, branch, title, body }) {
  const listed = tryRun('gh', ['pr', 'list', '--repo', repo.slug, '--head', branch, '--state', 'open', '--json', 'url,number', '--limit', '1'], { cwd: repo.clone, timeout: 60000 });
  if (listed) {
    const arr = JSON.parse(listed);
    if (arr.length) return { url: arr[0].url, number: arr[0].number };
  }

  const url = run('gh', ['pr', 'create', '--repo', repo.slug, '--base', repo.base, '--head', branch, '--title', title, '--body-file', '-'], { cwd: repo.clone, input: body, timeout: 120000 });
  const m = url.match(/\/pull\/(\d+)/);
  return { url: url.split('\n').pop(), number: m ? Number(m[1]) : null };
}

/** Klonda kaybolabilecek iş var mı: commit edilmemiş değişiklik ya da pushlanmamış commit. */
export function unsafeReasons(clone) {
  const reasons = [];
  if (tryGit(clone, 'status', '--porcelain')) reasons.push('commit edilmemiş değişiklik');
  const unpushed = tryGit(clone, 'log', '--branches', '--not', '--remotes', '--oneline');
  if (unpushed) reasons.push(`${unpushed.split('\n').length} pushlanmamış commit`);
  return reasons;
}

function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * İş klasörünü siler. `force` yoksa kaybolacak iş olan klon korunur ve
 * neden döner. Başka bir canlı süreç klasörü kullanıyorsa dokunulmaz.
 */
export function removeJob(workdir, code, { force = false, dryRun = false } = {}) {
  const dir = jobDir(workdir, code);
  if (!existsSync(dir)) return { removed: [], kept: [], missing: true };

  const marker = readMarker(dir);
  if (marker?.pid && pidAlive(marker.pid) && marker.status === 'running') {
    return { removed: [], kept: [{ name: code, reasons: [`süreç ${marker.pid} kullanıyor`] }] };
  }

  const removed = [];
  const kept = [];
  for (const name of readdirSync(dir)) {
    const clone = join(dir, name);
    if (name === MARKER || !statSync(clone).isDirectory()) continue;
    const reasons = existsSync(join(clone, '.git')) ? unsafeReasons(clone) : [];
    if (reasons.length && !force) {
      kept.push({ name, reasons });
      continue;
    }
    if (!dryRun) removeDir(clone);
    removed.push(name);
  }

  if (!kept.length && !dryRun) removeDir(dir);
  return { removed, kept };
}

/** Diskteki iş klasörleri, en eskisi önce. */
export function listJobs(workdir) {
  const root = jobsRoot(workdir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((code) => {
      const dir = join(root, code);
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) return null;
        const marker = readMarker(dir);
        const touched = marker?.touched_at ? Date.parse(marker.touched_at) : st.mtimeMs;
        return { code, dir, marker, touchedAt: touched };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.touchedAt - b.touchedAt);
}
