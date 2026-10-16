// Run alone: node --test scripts/spec-gym/runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editorSessionsFor, runRootFor } from './runner.mjs';

test('run root refuses a directory inside the gym checkout and defaults outside it', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spec-gym-root-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const gym = join(base, 'gym');
  mkdirSync(join(gym, 'tmp'), { recursive: true });
  assert.throws(() => runRootFor(gym, join(gym, 'tmp', 'spec-gym')), /inside the gym checkout/);
  assert.throws(() => runRootFor(gym, gym), /inside the gym checkout/);
  assert.equal(runRootFor(gym, join(base, 'runs')), join(base, 'runs'));
  const state = process.env.XDG_STATE_HOME;
  t.after(() => { if (state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = state; });
  process.env.XDG_STATE_HOME = join(base, 'state');
  assert.equal(runRootFor(gym), join(base, 'state', 'spec-gym'));
});

test('cell usage covers every fresh editor session, not only the legacy anchor', t => {
  const pkg = realpathSync(mkdtempSync(join(tmpdir(), 'spec-gym-editors-')));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  mkdirSync(join(pkg, 'runtime/runs'), { recursive: true });
  const record = { package: pkg, id: 'run-1', editor_session: join(pkg, 'pair/editor.jsonl') };
  assert.deepEqual(editorSessionsFor(record), [record.editor_session], 'no manifest: only the legacy path');
  const a = join(pkg, 'pair/editors/a.jsonl'), b = join(pkg, 'pair/editors/b.jsonl');
  writeFileSync(join(pkg, 'runtime/runs/run-1-editor-sessions.json'), JSON.stringify([a, b, a]));
  assert.deepEqual(editorSessionsFor(record), [a, b, record.editor_session]);
});
