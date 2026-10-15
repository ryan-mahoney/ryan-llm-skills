import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('./setup-speech.mjs', import.meta.url));

async function fixture(t, fail) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speech-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'writer with spaces');
  const bin = path.join(root, 'bin');
  await mkdir(path.join(checkout, 'server/asr'), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(checkout, 'server/asr/asrDaemonWorker.ts'), '// fixture');
  await writeFile(path.join(bin, 'bun'), `#!${process.execPath}
if (process.argv[2] !== 'run') process.exit(0);
console.log(JSON.stringify({type:'ready',protocolVersion:1}));
let pending = '';
process.stdin.on('data', chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\\n')) !== -1) {
    const event = JSON.parse(pending.slice(0,end)); pending = pending.slice(end+1);
    if (event.type === 'audio') {
      if (!Buffer.from(event.pcm,'base64').length) process.exit(5);
      console.log(JSON.stringify(${fail ? "{type:'error',message:'missing model'}" : "{type:'model-ready'}"}));
    }
    if (event.type === 'shutdown') process.exit(0);
  }
});
`, { mode: 0o755 });
  await writeFile(path.join(bin, 'systemctl'), `#!${process.execPath}\nprocess.exit(process.argv.slice(2).join(' ') === '--user daemon-reload' ? 0 : 2);\n`, { mode: 0o755 });
  const config = path.join(root, 'config');
  const dropin = path.join(config, 'systemd/user/spec-sentinel.service.d/speech.conf');
  const invoke = (args = ['--checkout', checkout]) => new Promise(resolve => {
    const child = spawn(process.execPath, [installer, ...args], {
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: config, SENTINEL_SPEECH_BUN: path.join(bin, 'bun'), PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({ code, output }));
  });
  return { root, checkout, dropin, invoke };
}

// Run alone: node --test --test-name-pattern='setup saves' scripts/spec-observe/setup-speech.test.mjs
test('setup saves service paths after lazy engine load and permits repeat setup', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, false);
  const first = await f.invoke();
  assert.equal(first.code, 0, first.output);
  const config = await readFile(f.dropin, 'utf8');
  assert.ok(config.includes(`SENTINEL_SPEECH_CHECKOUT=${f.checkout}`));
  assert.ok(config.includes(`PATH=${f.root}/bin:`));
  const second = await f.invoke(['--auto']);
  assert.equal(second.code, 0, second.output);
  assert.equal(await readFile(f.dropin, 'utf8'), config);
});

// Run alone: node --test --test-name-pattern='failed model' scripts/spec-observe/setup-speech.test.mjs
test('failed model load preserves existing service configuration', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, true);
  const first = await f.invoke();
  assert.notEqual(first.code, 0);
  assert.match(first.output, /missing model/);
  await assert.rejects(access(f.dropin));
  await mkdir(path.dirname(f.dropin), { recursive: true });
  await writeFile(f.dropin, 'previous working configuration');
  const retry = await f.invoke();
  assert.notEqual(retry.code, 0);
  assert.equal(await readFile(f.dropin, 'utf8'), 'previous working configuration');
});
