// Codex ve Gemini sürücüleri: gerçek CLI'ların JSON akışını taklit eden
// sahte ikililerle uçtan uca (stdin'den prompt, dosya değişikliği, son cevap).
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyFailure, describeCodexEvent, describeGeminiEvent, runAgent } from '../src/fix/agent.mjs';
import { defaults } from '../src/config.mjs';

const base = mkdtempSync(join(os.tmpdir(), 'sb-agents-'));

function fake(name, body) {
  const p = join(base, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

const fakeCodex = fake('codex', `
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const say = (o) => console.log(JSON.stringify(o));
  if (!args.includes('--dangerously-bypass-approvals-and-sandbox') || args.at(-1) !== '-') { say({ type: 'error', message: 'bad args' }); process.exit(2); }
  say({ type: 'thread.started', thread_id: 't1' });
  say({ type: 'item.started', item: { type: 'command_execution', command: "/bin/zsh -lc 'echo fix >> a.txt'" } });
  fs.appendFileSync('a.txt', 'fix ' + input.trim() + '\\n');
  say({ type: 'item.completed', item: { type: 'agent_message', text: 'ÖZET: düzeldi' } });
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'ÖZET: düzeldi');
  say({ type: 'turn.completed', usage: {} });
});
`);

const fakeGemini = fake('gemini', `
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: 'init', model: 'gemini-x' });
  say({ type: 'message', role: 'assistant', content: 'Bakıyorum', delta: true });
  say({ type: 'tool_use', tool_name: 'write_file', parameters: { file_path: 'a.txt' } });
  fs.appendFileSync('a.txt', 'gemini ' + input.trim() + '\\n');
  say({ type: 'tool_result', status: 'success' });
  say({ type: 'message', role: 'assistant', content: 'ÖZET: ', delta: true });
  say({ type: 'message', role: 'assistant', content: 'tamam', delta: true });
  say({ type: 'result', status: 'success', stats: { duration_ms: 1200 } });
});
`);

const fakeGeminiAuth = fake('gemini-auth', `
process.stdin.resume();
process.stdin.on('end', () => {
  console.error('This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var.');
  process.exit(41);
});
`);

function cfgWith(name, bin) {
  const c = defaults();
  c.fix.agent = name;
  c.fix[name].bin = bin;
  return c;
}

test('codex: prompt stdin\'den gider, son cevap --output-last-message dosyasından okunur', async () => {
  const dir = mkdtempSync(join(base, 'w-'));
  const lines = [];
  const r = await runAgent({ cfg: cfgWith('codex', fakeCodex), cwd: dir, prompt: 'görev', timeoutMinutes: 1, onLine: (l) => lines.push(l) });
  assert.equal(r.ok, true, r.tail);
  assert.equal(r.finalText, 'ÖZET: düzeldi');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'fix görev\n');
  assert.ok(lines.some((l) => l.startsWith('▸ shell: ')));
});

test('gemini: parça parça mesaj birleşir, son cevap sondaki metindir', async () => {
  const dir = mkdtempSync(join(base, 'w-'));
  const lines = [];
  const r = await runAgent({ cfg: cfgWith('gemini', fakeGemini), cwd: dir, prompt: 'görev', timeoutMinutes: 1, onLine: (l) => lines.push(l) });
  assert.equal(r.ok, true, r.tail);
  assert.equal(r.finalText, 'ÖZET: tamam');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'gemini görev\n');
  assert.ok(lines.some((l) => l.includes('▸ write_file: a.txt')));
});

test('gemini: oturum hatası auth_required olarak sınıflanır', async () => {
  const dir = mkdtempSync(join(base, 'w-'));
  const r = await runAgent({ cfg: cfgWith('gemini', fakeGeminiAuth), cwd: dir, prompt: 'görev', timeoutMinutes: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'auth_required');
});

test('kurulu olmayan ajan not_installed döner', async () => {
  const r = await runAgent({ cfg: cfgWith('codex', join(base, 'yok')), cwd: base, prompt: 'x', timeoutMinutes: 1 });
  assert.equal(r.failure, 'not_installed');
});

test('codex ve gemini olayları log satırına çevrilir', () => {
  const st = {};
  assert.equal(describeCodexEvent({ type: 'turn.failed', error: { message: 'boom' } }, st), '● hata: boom');
  assert.equal(st.error, true);
  assert.equal(describeCodexEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'x.php' }] } }), '▸ edit: x.php');
  const g = {};
  assert.equal(describeGeminiEvent({ type: 'result', status: 'error', error: { message: 'quota' } }, g), '● bitti (error)');
  assert.equal(g.error, true);
  assert.equal(classifyFailure('RESOURCE_EXHAUSTED: quota'), 'rate_limited');
  assert.equal(classifyFailure("Not logged in. Run `codex login`"), 'auth_required');
});
