// §18: panelden ajan seçimi. hello kurulu tüm ajanları bildirir, iş
// `job.agent`teki ajanla çalışır, engel ajan başınadır. Sahte API + sahte
// ajan ikilileri; gerçek ayar ve servis kullanılmaz.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { gitUrlRewriteEnv, makeRepo, tmp } from './helpers.mjs';

const base = tmp('sb-select-');
Object.assign(process.env, gitUrlRewriteEnv(base), { SIGNALBIRD_HOME: join(base, 'home'), SIGNALBIRD_CONFIG: join(base, 'home', 'config.json') });

const { FixRunner, loadState } = await import('../src/fix/runner.mjs');
const { defaults } = await import('../src/config.mjs');

const { project } = makeRepo(base, 'app.api', { branches: ['main'] });
const RAN = join(base, 'ran.txt');
process.env.SB_TEST_RAN = RAN;

// Hangi ajanın çalıştığını SB_TEST_RAN dosyasına yazan sahte ikililer.
function fake(name, body) {
  const p = join(base, 'bin', name);
  mkdirSync(join(base, 'bin'), { recursive: true });
  writeFileSync(p, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('${name} 1.0.0'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.SB_TEST_RAN, '${name}\\n');
  const say = (o) => console.log(JSON.stringify(o));
  const args = process.argv.slice(2);
${body}
});
`);
  chmodSync(p, 0o755);
  return p;
}

const CLAUDE = fake('claude', `  say({ type: 'result', subtype: 'success', is_error: false, result: 'ÖZET: claude baktı' });`);
const CODEX = fake('codex', `
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'ÖZET: codex baktı');
  say({ type: 'thread.started' });
  say({ type: 'turn.completed' });`);
const CODEX_LIMIT = fake('codex-limit', `
  say({ type: 'turn.failed', error: { message: "You've hit your usage limit." } });
  process.exit(1);`);
const NONE = join(base, 'bin', 'yok');

// ── sahte API ──
const calls = [];
let jobQueue = [];
let machine = { id: 1, name: 'test', team_id: 1, default_agent: null };
let server;
let apiUrl;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (o) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/api/v1/fix/hello') return send({ ok: true, machine, pending: jobQueue.length, cleanup: [], open_prs: [] });
      if (req.url === '/api/v1/fix/jobs/claim') return send({ ok: true, job: jobQueue.shift() || null });
      if (req.method === 'GET') return send({ ok: true, status: 'running' });
      send({ ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server?.close());

beforeEach(() => {
  calls.length = 0;
  jobQueue = [];
  machine = { id: 1, name: 'test', team_id: 1, default_agent: null };
  rmSync(RAN, { force: true });
  rmSync(join(base, 'home', 'fix'), { recursive: true, force: true });
});

function cfg({ agent = 'claude', claude = CLAUDE, codex = CODEX, gemini = NONE } = {}) {
  const c = defaults();
  c.api = apiUrl;
  c.fix.key = 'sbf_live_' + 'x'.repeat(40);
  c.fix.workdir = join(base, 'home', 'fix');
  c.fix.agent = agent;
  c.fix.claude.bin = claude;
  c.fix.codex.bin = codex;
  c.fix.gemini.bin = gemini;
  c.fix.links = [{ domain: 'app.io', root: project, base: null, repos: null }];
  return c;
}

function runner(c = cfg()) {
  const r = new FixRunner({ cfg: c, openPr: () => ({ url: 'u', number: 1 }) });
  r.reloadLinks = () => {};
  return r;
}

let seq = 0;
function job(extra = {}) {
  seq += 1;
  return { id: `fix_S${seq}`, code: `SBF-S${seq}`, attempt: 1, domain: 'app.io', channel: null, event: { id: 'e', level: 'error', message: 'hata' }, limits: { timeout_minutes: 1 }, ...extra };
}

const ran = () => (existsSync(RAN) ? readFileSync(RAN, 'utf8').trim().split('\n') : []);
const hellos = () => calls.filter((c) => c.url === '/api/v1/fix/hello').map((c) => c.body);
const finalOf = (j) => calls.filter((c) => c.method === 'PATCH' && c.url.endsWith(`/${j.id}`)).at(-1)?.body;
const logOf = (j) => calls.filter((c) => c.url.endsWith(`/${j.id}/logs`)).map((c) => c.body.chunk).join('');

test('hello: yerel varsayılan + kurulu tüm ajanlar; kurulu olmayan yerel ajan not_installed', async () => {
  const r = runner();
  await r.hello();
  const h = hellos().at(-1);
  assert.equal(h.agent, 'claude');
  assert.deepEqual(h.agents, {
    claude: { version: 'claude 1.0.0', status: 'ready' },
    codex: { version: 'codex 1.0.0', status: 'ready' },
  });

  // Yerel varsayılan gemini ama kurulu değil: yine listelenir.
  const r2 = runner(cfg({ agent: 'gemini' }));
  r2.setAgentStatus('codex', 'rate_limited');
  await r2.hello();
  const h2 = hellos().at(-1);
  assert.equal(h2.agent, 'gemini');
  assert.deepEqual(h2.agents.gemini, { version: null, status: 'not_installed' });
  assert.equal(h2.agents.codex.status, 'rate_limited');
  assert.ok(Date.parse(h2.agents.codex.until) > Date.now());
  assert.equal(h2.agents.claude.status, 'ready');
});

test('hello: panel seçimi saklanır, yerel fix.agent değişmez; sürüm önbelleklenir', async () => {
  machine = { ...machine, default_agent: 'codex' };
  const c = cfg();
  const r = runner(c);
  await r.hello();
  assert.equal(r.agentSelect, true);
  assert.equal(loadState(c).default_agent, 'codex');
  assert.equal(c.fix.agent, 'claude');

  const cached = r.agentCache;
  await r.hello();
  assert.equal(r.agentCache, cached, 'ikinci hello sürümleri yeniden okumaz');
  // Yerel ayar değişince tazelenir.
  c.fix.agent = 'codex';
  await r.hello();
  assert.notEqual(r.agentCache, cached);
  assert.equal(hellos().at(-1).agent, 'codex');
});

test('claim: job.agent seçili olmayan ajanı çalıştırır, log nedenini yazar', async () => {
  const j = job({ agent: 'codex' });
  jobQueue = [j];
  const r = runner();
  machine = { ...machine, default_agent: 'codex' };
  await r.tick();
  assert.deepEqual(ran(), ['codex']);
  assert.equal(finalOf(j).status, 'no_change', JSON.stringify(finalOf(j)));
  assert.match(logOf(j), /^● ajan: Codex \(ChatGPT\) codex 1\.0\.0 · panel seçimi/);

  // job.agent yok → yerel fix.agent.
  const j2 = job();
  jobQueue = [j2];
  await r.tick();
  assert.deepEqual(ran(), ['codex', 'claude']);
  assert.match(logOf(j2), /● ajan: Claude Code .* · bu bilgisayardaki seçim/);
});

test('engel ajan başına: claude limitteyken codex işi alınır; eski API\'de alınmaz', async () => {
  const r = runner();
  r.setAgentStatus('claude', 'rate_limited');
  const j = job({ agent: 'codex' });
  jobQueue = [j];
  await r.tick();
  assert.deepEqual(ran(), ['codex']);
  assert.ok(calls.some((c) => c.url === '/api/v1/fix/jobs/claim'));

  // Eski API (machine.default_agent yok): iş hep yerel ajana gider, o limitte → claim yok.
  delete machine.default_agent;
  calls.length = 0;
  jobQueue = [job({ agent: 'codex' })];
  await r.tick();
  assert.equal(r.agentSelect, false);
  assert.ok(!calls.some((c) => c.url === '/api/v1/fix/jobs/claim'));
});

test('limit: ajan limite düşünce sonraki claim\'den önce hello; diğer ajanın işi sürer', async () => {
  const r = runner(cfg({ codex: CODEX_LIMIT }));
  const j1 = job({ agent: 'codex' });
  const j2 = job();
  jobQueue = [j1, j2];
  await r.tick();

  assert.equal(finalOf(j1).status, 'failed');
  assert.match(finalOf(j1).error, /Codex \(ChatGPT\) kullanım limiti doldu/);
  assert.equal(r.state.agents.codex.status, 'rate_limited');
  assert.equal(r.agentStatus('claude'), 'ready');
  assert.equal(finalOf(j2).status, 'no_change');

  // Sıra: hello, claim(j1), hello (codex limitte), claim(j2).
  const seqUrls = calls.filter((c) => c.url.endsWith('/hello') || c.url.endsWith('/claim')).map((c) => c.url.split('/').pop());
  assert.deepEqual(seqUrls.slice(0, 4), ['hello', 'claim', 'hello', 'claim']);
  assert.equal(hellos()[1].agents.codex.status, 'rate_limited');
});

test('bilinmeyen ya da kurulu olmayan job.agent → failed, başka ajan çalışmaz', async () => {
  const r = runner();
  const unknown = job({ agent: 'copilot' });
  const missing = job({ agent: 'gemini' });
  jobQueue = [unknown, missing];
  await r.tick();

  assert.deepEqual(ran(), []);
  assert.equal(finalOf(unknown).status, 'failed');
  assert.match(finalOf(unknown).error, /"copilot" bu CLI sürümünde tanınmıyor/);
  assert.equal(finalOf(missing).status, 'failed');
  assert.match(finalOf(missing).error, /Gemini CLI bu bilgisayarda kurulu değil \(panel seçimi\)/);
  assert.match(finalOf(missing).error, /başka ajanla çalıştırılmadı/);
  // Hiçbiri "running" raporlanmadı.
  assert.ok(!calls.some((c) => c.method === 'PATCH' && c.body?.status === 'running'));
});

test('hazır olmayan job.agent (limitte) → failed, başka ajan çalışmaz', async () => {
  const r = runner();
  r.setAgentStatus('codex', 'rate_limited');
  const j = job({ agent: 'codex' });
  await r.processJob(j);
  assert.deepEqual(ran(), []);
  assert.equal(finalOf(j).status, 'failed');
  assert.match(finalOf(j).error, /Codex \(ChatGPT\) kullanım limitinde \(panel seçimi, bitiş/);
});

test('eski state.agent yerel varsayılan ajana taşınır', () => {
  const c = cfg({ agent: 'codex' });
  mkdirSync(c.fix.workdir, { recursive: true });
  const until = new Date(Date.now() + 600000).toISOString();
  writeFileSync(join(c.fix.workdir, 'state.json'), JSON.stringify({ pending: [{ job_id: 'x', body: {} }], agent: { status: 'rate_limited', until }, last_sweep: null }));
  const st = loadState(c);
  assert.deepEqual(st.agents, { codex: { status: 'rate_limited', until } });
  assert.equal(st.agent, undefined);
  assert.equal(st.pending.length, 1);

  const r = runner(c);
  assert.equal(r.agentStatus('codex'), 'rate_limited');
  assert.equal(r.agentStatus('claude'), 'ready');

  // ready / not_installed taşınmaz; dosya yoksa boş başlar.
  writeFileSync(join(c.fix.workdir, 'state.json'), JSON.stringify({ agent: { status: 'not_installed', until: null } }));
  assert.deepEqual(loadState(c).agents, {});
  rmSync(join(c.fix.workdir, 'state.json'));
  assert.deepEqual(loadState(c), { pending: [], last_sweep: null, agents: {} });
});
