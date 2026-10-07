import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sdk = process.env.SPEC_PI_SDK || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const loader = join(sdk, 'dist/core/extensions/loader.js');
test('installed Pi loads completion/checkpoint tools and restores obligation hooks for each role', { skip: !existsSync(loader) && 'Pi SDK unavailable' }, async t => {
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(loader));
  const root = mkdtempSync(join(tmpdir(), 'completion-sdk-'));
  const previous = { SPEC_RUNTIME_ROLE: process.env.SPEC_RUNTIME_ROLE, SPEC_RUNTIME_RECORD: process.env.SPEC_RUNTIME_RECORD };
  const extensions = [];
  t.after(async () => {
    for (const ext of extensions) for (const hook of ext.handlers.get('session_shutdown') || []) await hook({}, {});
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  });
  const file = join(root, 'run.json');
  mkdirSync(join(root, 'runtime/runs'), { recursive: true });
  const lock = join(root, 'lease'); mkdirSync(lock);
  writeFileSync(join(lock, 'lease.json'), JSON.stringify({ id: 'fixture', token: 'fixture-token' }));
  writeFileSync(file, JSON.stringify({ lock, token: 'fixture-token', owner_model: 'fixture/owner', editor_model: 'fixture/editor', id: 'fixture', completion_contract: 1, package: root, step: join(root, 'step-001-subspec.md'), state: 'running', checkout: root }));
  for (const role of ['owner', 'editor', undefined]) {
    if (role) process.env.SPEC_RUNTIME_ROLE = role; else delete process.env.SPEC_RUNTIME_ROLE;
    process.env.SPEC_RUNTIME_RECORD = file;
    const persisted = [], runtime = createExtensionRuntime();
    runtime.appendEntry = (customType, data) => persisted.push({ customType, data });
    const loaded = await loadExtensions([resolve('pi/extensions/spec-runtime/index.ts')], root, undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const ext = loaded.extensions[0]; extensions.push(ext);
    assert.equal(ext.tools.has('spec_complete'), role === 'owner');
    assert.equal(ext.tools.has('spec_checkpoint'), !role);
    assert.equal(ext.tools.has('spec_sentinel_checkpoint'), !role);
    assert.ok(ext.handlers.has('context'));
    if (!role) {
      const hooks = ext.handlers.get('input');
      // The installed SDK's InputEvent uses source + text, not message role.
      // Deliver to every registered consumer, including sentinel's input guard.
      for (const hook of hooks) await hook({ type: 'input', text: 'Human RPC follow-up', source: 'rpc', streamingBehavior: 'followUp' }, {});
      for (const hook of hooks) await hook({ type: 'input', text: 'Automated continuation', source: 'extension', streamingBehavior: 'steer' }, {});
      assert.equal(persisted.filter(entry => entry.customType === 'spec-progress-input').length, 1);
    }
    if (role) {
      // Exercise the actual worker guard with a valid lease and matching model.
      await ext.handlers.get('session_start')[0]({}, { model: { provider: 'fixture', id: role } });
      const reply = await ext.handlers.get('context')[0]({ messages: [] }, {});
      assert.match(reply.messages[0].content, new RegExp(`role=${role}`));
    }
  }
});

test('real worker startup exits before provider work when Pi selects a different model', { skip: !existsSync(loader) && 'Pi SDK unavailable' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'selector-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'runtime/runs'), { recursive: true });
  const lock = join(root, 'lease'); mkdirSync(lock);
  writeFileSync(join(lock, 'lease.json'), JSON.stringify({ id: 'fixture', token: 'fixture-token' }));
  const recordFile = join(root, 'run.json');
  writeFileSync(recordFile, JSON.stringify({ id: 'fixture', token: 'fixture-token', lock, package: root,
    step: join(root, 'step-001-subspec.md'), checkout: root, state: 'running', completion_contract: 1,
    editor_model: 'fixture/team/requested-model:high' }));
  const script = join(root, 'mismatch.mjs');
  writeFileSync(script, `
    import { loadExtensions, createExtensionRuntime } from ${JSON.stringify(pathToFileURL(loader).href)};
    const loaded = await loadExtensions([${JSON.stringify(resolve('pi/extensions/spec-runtime/index.ts'))}], ${JSON.stringify(root)}, undefined, createExtensionRuntime());
    if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
    const extension = loaded.extensions[0];
    for (const hook of extension.handlers.get('session_start'))
      await hook({ type: 'session_start' }, { model: { provider: 'fixture', id: 'team/requested-model:batch' } });
    console.log('PROVIDER_REQUEST_PATH_REACHED');
  `);
  const child = spawnSync(process.execPath, [script], {
    env: { ...process.env, SPEC_RUNTIME_ROLE: 'editor', SPEC_RUNTIME_RECORD: recordFile },
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, 'SDK child must settle within the finite deadline');
  assert.equal(child.status, 78);
  assert.match(child.stderr, /SPEC_MODEL_SELECTOR_MISMATCH/);
  assert.match(child.stderr, /fixture\/team\/requested-model:high/);
  assert.match(child.stderr, /selected fixture\/team\/requested-model:batch/);
  assert.doesNotMatch(child.stdout, /PROVIDER_REQUEST_PATH_REACHED/);
});
