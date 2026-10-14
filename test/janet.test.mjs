// Protokol 2: cihaz girişi, proje taraması, sunucunun seçtiği projeyle iş.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { makeRepo, sh, tmp } from './helpers.mjs';

const { deviceLogin } = await import('../src/fix/login.mjs');
const { discoverProjects } = await import('../src/fix/discover.mjs');

let server;
let api;
let tokenCalls = 0;
let deny = false;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const send = (o, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/api/v1/fix/device/start') {
        const b = JSON.parse(body);
        assert.ok(b.hostname && b.platform && b.version);
        return send({ device_code: 'd'.repeat(40), user_code: 'ABCD-2345', verify_url: 'https://x/janet/connect?code=ABCD-2345', interval: 1, expires_in: 30 });
      }
      if (req.url === '/api/v1/fix/device/token') {
        tokenCalls++;
        if (deny) return send({ ok: false, code: 'ACCESS_DENIED' }, 403);
        if (tokenCalls < 3) return send({ ok: false, code: 'AUTHORIZATION_PENDING' }, 428);
        return send({ token: 'sbf_live_' + 'y'.repeat(40), machine: { id: 7, name: 'ahmet-mbp' } });
      }
      send({}, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server?.close());

test('cihaz girişi: bekler, onaylanınca anahtarı alır; tarayıcı açılır', async () => {
  let shown;
  let opened;
  const res = await deviceLogin({
    api,
    sleep: async () => {},
    open: (url) => ((opened = url), true),
    onCode: (c) => (shown = c),
  });
  assert.equal(shown.user_code, 'ABCD-2345');
  assert.equal(opened, 'https://x/janet/connect?code=ABCD-2345');
  assert.match(res.token, /^sbf_live_/);
  assert.equal(res.machine.name, 'ahmet-mbp');
  assert.equal(tokenCalls, 3);
});

test('cihaz girişi: reddedilirse anlaşılır hata', async () => {
  deny = true;
  await assert.rejects(deviceLogin({ api, sleep: async () => {}, open: () => false }), /reddedildi/);
  deny = false;
});

test('proje taraması: çok repolu, tek repolu, git olmayan klasör, gizli klasör', () => {
  const base = tmp();
  const a = makeRepo(base, 'adall.api');
  makeRepo(base, 'adall.web');
  // makeRepo hepsini base/project altına koyar → "project" tek çok repolu proje olur.
  const root = join(base, 'root');
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, '.cache', 'x'), { recursive: true });
  sh(base, 'clone', '-q', a.bare, join(root, 'penyu'));
  sh(base, 'clone', '-q', a.bare, join(root, 'adall', 'adall.api'));
  sh(base, 'clone', '-q', a.bare, join(root, 'adall', 'app.adall'));
  writeFileSync(join(root, 'adall', 'README.md'), 'x');

  const p = discoverProjects([root]);
  assert.deepEqual(p.map((x) => [x.name, x.repos]), [
    ['adall', ['adall.api', 'app.adall']],
    ['penyu', ['penyu']],
  ]);
  assert.equal(p[0].path, join(root, 'adall'));
  assert.deepEqual(discoverProjects([join(base, 'yok')]), []);
});
