// Uçtan uca: sahte API + sahte claude + yerel "GitHub". Bir iş alınır,
// klonlanır, "ajan" commit atar, dal push edilir, PR açılır, müşteri
// "Çözüldü" der, yerel klon silinir.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gitUrlRewriteEnv, makeRepo, sh, tmp } from './helpers.mjs';

const base = tmp();
Object.assign(process.env, gitUrlRewriteEnv(base), { SIGNALBIRD_HOME: join(base, 'home'), SIGNALBIRD_CONFIG: join(base, 'home', 'config.json') });

const { FixRunner } = await import('../src/fix/runner.mjs');
const { prepare, finalize, removeJob, listJobs } = await import('../src/fix/workspace.mjs');
const { discoverRepos } = await import('../src/fix/discover.mjs');
const { defaults } = await import('../src/config.mjs');

const api = makeRepo(base, 'adall.api', { branches: ['main', 'test'] });
makeRepo(base, 'adall.web', { branches: ['main'] });
const project = api.project;

// Sahte claude: stdin'i okur, adall.api/app.txt'yi düzeltir, commit eder.
const fakeClaude = join(base, 'fake-claude.mjs');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  writeFileSync(process.env.SB_TEST_PROMPT, input);
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: 'system', subtype: 'init', model: 'fake' });
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'adall.api/app.txt' } }] } });
  writeFileSync('adall.api/app.txt', 'fixed\\n');
  execFileSync('git', ['-C', 'adall.api', 'commit', '-qam', 'SBF-T1: düzelt']);
  const text = 'tamam\\nÖZET: app.txt düzeltildi\\nKÖK NEDEN: yazım';
  say({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 1000 });
});
`,
);
chmodSync(fakeClaude, 0o755);
process.env.SB_TEST_PROMPT = join(base, 'prompt.txt');

// ── sahte API ──
const calls = [];
let jobQueue = [];
let cleanupList = [];
let server;
let apiUrl;

const JOB = {
  id: 'fix_01T1',
  code: 'SBF-T1',
  attempt: 1,
  status: 'claimed',
  domain: 'adall.io',
  channel: { key: 'adallCritical', title: 'Adall kritik' },
  instruction: null,
  previous_summary: null,
  branch: null,
  prs: [],
  event: { id: 'rev_1', level: 'critical', message: 'bug in app.txt', context: { file: 'app.txt' }, source: 'adall.api', occurred_at: '2026-10-13T20:58:11Z' },
  repeat_count: 3,
  limits: { timeout_minutes: 2 },
};

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      calls.push({ method: req.method, url: req.url, body: json, auth: req.headers.authorization });
      const send = (o, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/api/v1/fix/hello') return send({ ok: true, machine: { id: 1, name: 'test', team_id: 1 }, pending: jobQueue.length, cleanup: cleanupList.splice(0) });
      if (req.url === '/api/v1/fix/jobs/claim') return send({ ok: true, job: jobQueue.shift() || null });
      if (req.method === 'GET' && req.url.startsWith('/api/v1/fix/jobs/')) return send({ ok: true, status: 'running' });
      if (req.method === 'PATCH') return send({ ok: true });
      if (req.url.endsWith('/logs')) return send({ ok: true });
      if (req.url.endsWith('/cleaned')) return send({ ok: true });
      send({ ok: false, code: 'NOT_FOUND' }, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server?.close());

function cfg() {
  const c = defaults();
  c.api = apiUrl;
  c.fix.key = 'sbf_live_' + 'x'.repeat(40);
  c.fix.workdir = join(base, 'home', 'fix');
  c.fix.claude.bin = fakeClaude;
  c.fix.links = [{ domain: 'adall.io', root: project, base: null, repos: null }];
  return c;
}

test('discoverRepos: kök altındaki repolar ve slug', () => {
  const repos = discoverRepos(project);
  assert.deepEqual(repos.map((r) => r.name), ['adall.api', 'adall.web']);
  assert.equal(repos[0].slug, 'Org/adall.api');
});

test('iş: claim → klon → claude → push → PR → çözüldü → silindi', async () => {
  const prs = [];
  const runner = new FixRunner({
    cfg: cfg(),
    openPr: ({ repo, branch, title, body }) => {
      prs.push({ repo: repo.slug, base: repo.base, branch, title, body });
      return { url: `https://github.com/${repo.slug}/pull/7`, number: 7 };
    },
  });
  // Ayar dosyası yok; reloadLinks boş bağ okumasın.
  runner.reloadLinks = () => {};

  jobQueue = [{ ...JOB }];
  await runner.tick();

  const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
  assert.equal(patches[0].status, 'running');
  const final = patches.at(-1);
  assert.equal(final.status, 'pr_open', JSON.stringify(final));
  assert.equal(final.branch, 'janet/SBF-T1');
  assert.equal(final.prs.length, 1);
  assert.equal(final.prs[0].repo, 'Org/adall.api');
  assert.equal(final.prs[0].base, 'test'); // test dalı main'e tercih edilir
  assert.match(final.summary, /^ÖZET: app.txt düzeltildi/);

  // PR yalnız değişen repo için; adall.web klonu hemen silinmiş olmalı.
  assert.equal(prs.length, 1);
  assert.match(prs[0].title, /^SBF-T1: app.txt düzeltildi/);
  const jobdir = join(base, 'home', 'fix', 'jobs', 'SBF-T1');
  assert.ok(existsSync(join(jobdir, 'adall.api')));
  assert.ok(!existsSync(join(jobdir, 'adall.web')));

  // Dal gerçekten "GitHub"a gitti ve düzeltmeyi taşıyor.
  assert.equal(sh(api.bare, 'show', 'janet/SBF-T1:app.txt'), 'fixed');
  // Ana yerel repo hiç değişmedi, worktree kaydı yok.
  assert.equal(readFileSync(join(api.local, 'app.txt'), 'utf8'), 'bug\n');
  assert.doesNotMatch(sh(api.local, 'worktree', 'list'), /SBF-T1/);

  // Prompt stdin'den geldi, olay bloğu içinde.
  const prompt = readFileSync(process.env.SB_TEST_PROMPT, 'utf8');
  assert.match(prompt, /<<<TELSIZ_OLAYI[\s\S]*bug in app.txt[\s\S]*TELSIZ_OLAYI>>>/);

  // Canlı log gönderildi, seq 1'den başlıyor.
  const logs = calls.filter((c) => c.url.endsWith('/logs'));
  assert.ok(logs.length >= 1);
  assert.equal(logs[0].body.seq, 1);

  // Müşteri "Çözüldü" dedi → sonraki hello temizlik listesi getirir.
  cleanupList = [{ job_id: 'fix_01T1', state: 'resolved' }];
  await runner.tick();
  assert.ok(!existsSync(jobdir), 'iş klasörü silinmeli');
  const cleaned = calls.find((c) => c.url === '/api/v1/fix/jobs/fix_01T1/cleaned');
  assert.deepEqual(cleaned.body.removed, ['adall.api']);
});

test('takip: aynı dala devam eder, mevcut PR\'a push eder', async () => {
  const c = cfg();
  const job = { ...JOB, id: 'fix_02', code: 'SBF-T2', attempt: 1 };
  const ws1 = prepare({ job, link: c.fix.links[0], workdir: c.fix.workdir });
  writeFileSync(join(ws1.dir, 'adall.api', 'app.txt'), 'v1\n');
  sh(join(ws1.dir, 'adall.api'), 'commit', '-qam', 'v1');
  let opened = 0;
  const openPr = () => ({ url: 'u', number: ++opened });
  finalize({ job, ws: ws1, title: 't', openPr });
  assert.equal(sh(api.bare, 'show', 'janet/SBF-T2:app.txt'), 'v1');

  // Klon silinmiş olsa bile uzaktaki iş dalından yeniden kurulur.
  removeJob(c.fix.workdir, 'SBF-T2', { force: true });
  const job2 = { ...job, attempt: 2, branch: 'janet/SBF-T2', instruction: 'devam' };
  const ws2 = prepare({ job: job2, link: c.fix.links[0], workdir: c.fix.workdir });
  const clone = join(ws2.dir, 'adall.api');
  assert.equal(readFileSync(join(clone, 'app.txt'), 'utf8'), 'v1\n');
  writeFileSync(join(clone, 'app.txt'), 'v2\n');
  sh(clone, 'commit', '-qam', 'v2');
  const fin = finalize({ job: job2, ws: ws2, title: 't', openPr });
  assert.equal(fin.problems.length, 0, fin.problems.join());
  assert.equal(sh(api.bare, 'show', 'janet/SBF-T2:app.txt'), 'v2');
});

test('removeJob: pushlanmamış commit varsa force olmadan korur', () => {
  const c = cfg();
  const job = { ...JOB, id: 'fix_03', code: 'SBF-T3' };
  const ws = prepare({ job, link: c.fix.links[0], workdir: c.fix.workdir });
  const clone = join(ws.dir, 'adall.api');
  writeFileSync(join(clone, 'app.txt'), 'local only\n');
  sh(clone, 'commit', '-qam', 'local');
  const res = removeJob(c.fix.workdir, 'SBF-T3');
  assert.equal(res.kept.length, 1);
  assert.match(res.kept[0].reasons.join(), /pushlanmamış/);
  assert.ok(existsSync(clone));
  const forced = removeJob(c.fix.workdir, 'SBF-T3', { force: true });
  assert.ok(forced.removed.includes('adall.api'));
  assert.ok(!listJobs(c.fix.workdir).some((j) => j.code === 'SBF-T3'));
});

test('fix root ile ya da yanlış anahtarla çalışmaz', async () => {
  const { assertFixAllowed } = await import('../src/fix/runner.mjs');
  const c = cfg();
  c.fix.key = 'sba_live_' + 'x'.repeat(40);
  assert.throws(() => assertFixAllowed(c), /düzeltici anahtarı değil/);
});

test('protokol 2: yerel bağ yok, sunucu projeyi seçer; hello projeleri bildirir', async () => {
  const { discoverProjects } = await import('../src/fix/discover.mjs');
  const c = cfg();
  c.fix.links = [];
  c.fix.roots = [join(project, '..')];
  const runner = new FixRunner({ cfg: c, openPr: ({ repo }) => ({ url: `https://github.com/${repo.slug}/pull/9`, number: 9 }) });
  runner.reloadLinks = () => {
    runner.projects = discoverProjects(c.fix.roots);
  };

  calls.length = 0;
  jobQueue = [{ ...JOB, id: 'fix_P2', code: 'SBF-P2', domain: 'baska.io', project: 'project' }];
  await runner.tick();

  const hello = calls.find((x) => x.url === '/api/v1/fix/hello');
  const names = hello.body.projects.map((p) => p.name);
  assert.ok(names.includes('project'), names.join());
  assert.deepEqual(hello.body.projects.find((p) => p.name === 'project').repos, ['adall.api', 'adall.web']);
  assert.equal(hello.body.protocol, 3);

  const final = calls.filter((x) => x.method === 'PATCH' && x.url.endsWith('/fix_P2')).at(-1).body;
  assert.equal(final.status, 'pr_open', JSON.stringify(final));
  assert.equal(final.branch, 'janet/SBF-P2');
});

test('protokol 2: seçilen proje bu bilgisayarda yoksa iş anlaşılır hatayla düşer', async () => {
  const c = cfg();
  c.fix.links = [];
  c.fix.roots = [join(project, '..')];
  const runner = new FixRunner({ cfg: c, openPr: () => ({ url: 'u', number: 1 }) });
  runner.reloadLinks = () => {
    runner.projects = [];
  };
  calls.length = 0;
  jobQueue = [{ ...JOB, id: 'fix_P3', code: 'SBF-P3', domain: 'baska.io', project: 'yok-boyle-proje' }];
  // projects boşken tick claim etmez; doğrudan işle.
  await runner.processJob(jobQueue.shift());
  const final = calls.filter((x) => x.method === 'PATCH' && x.url.endsWith('/fix_P3')).at(-1).body;
  assert.equal(final.status, 'failed');
  assert.match(final.error, /yok-boyle-proje/);
});

test('bağımlılık kısayolu (vendor/ → symlink) commit edilmez, PR açılmaz', async () => {
  const { symlinkSync, mkdirSync: mk } = await import('node:fs');
  const c = cfg();
  const job = { ...JOB, id: 'fix_V1', code: 'SBF-V1' };
  const ws = prepare({ job, link: c.fix.links[0], workdir: c.fix.workdir });
  const clone = join(ws.dir, 'adall.api');
  writeFileSync(join(clone, '.gitignore'), 'vendor/\nnode_modules/\n');
  sh(clone, 'add', '.gitignore');
  sh(clone, 'commit', '-qm', 'gitignore');
  sh(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${ws.repos[0].base}`);
  sh(clone, 'fetch', '-q', 'origin');
  sh(clone, 'reset', '-q', '--hard', `origin/${ws.repos[0].base}`);
  const real = join(base, 'real-vendor');
  mk(real, { recursive: true });
  symlinkSync(real, join(clone, 'vendor'), 'dir');
  let opened = 0;
  const fin = finalize({ job, ws, title: 't', openPr: () => ({ url: 'u', number: ++opened }) });
  assert.equal(opened, 0, 'PR açılmamalı');
  assert.deepEqual(fin.prs, []);
});

test('protokol 3: kod değiştirmeden soru soran Janet → needs_input', async () => {
  const { writeFileSync: w, chmodSync: ch } = await import('node:fs');
  const ask = join(base, 'fake-claude-ask.mjs');
  w(ask, `#!/usr/bin/env node
let i=''; process.stdin.on('data',d=>i+=d); process.stdin.on('end',()=>{
  const t='ÖZET: iki seçenek var\\nSORU: contracts tablosunu mu yoksa agreements tablosunu mu kullanalım?';
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:t}));
});
`);
  ch(ask, 0o755);
  const c = cfg();
  c.fix.claude.bin = ask;
  const runner = new FixRunner({ cfg: c, openPr: () => ({ url: 'u', number: 1 }) });
  runner.reloadLinks = () => {};
  calls.length = 0;
  jobQueue = [{ ...JOB, id: 'fix_Q1', code: 'SBF-Q1' }];
  await runner.tick();
  const final = calls.filter((x) => x.method === 'PATCH' && x.url.endsWith('/fix_Q1')).at(-1).body;
  assert.equal(final.status, 'needs_input', JSON.stringify(final));
  assert.match(final.question, /contracts tablosunu mu/);
});
