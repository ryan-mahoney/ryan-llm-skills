import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  writeFileSync(file, JSON.stringify({ id: 'fixture', completion_contract: 1, package: root, step: join(root, 'step-001-subspec.md'), state: 'running', checkout: root }));
  for (const role of ['owner', 'editor', undefined]) {
    if (role) process.env.SPEC_RUNTIME_ROLE = role; else delete process.env.SPEC_RUNTIME_ROLE;
    process.env.SPEC_RUNTIME_RECORD = file;
    const loaded = await loadExtensions([resolve('pi/extensions/spec-runtime/index.ts')], root, undefined, createExtensionRuntime());
    assert.deepEqual(loaded.errors, []);
    const ext = loaded.extensions[0]; extensions.push(ext);
    assert.equal(ext.tools.has('spec_complete'), role === 'owner');
    assert.equal(ext.tools.has('spec_checkpoint'), !role);
    assert.ok(ext.handlers.has('context'));
    if (role) {
      const reply = await ext.handlers.get('context')[0]({ messages: [] }, {});
      assert.match(reply.messages[0].content, new RegExp(`role=${role}`));
    }
  }
});
