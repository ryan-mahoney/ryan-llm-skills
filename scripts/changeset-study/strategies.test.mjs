// node --test scripts/changeset-study/strategies.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchEditor } from './strategies.mjs';

test('bounded editor edits preserve unrelated source and reject stale anchors or unowned writes', async () => {
  const files = { 'source.txt': 'preserve\nold\ntail\n', 'foreign.txt': 'private' };
  const operation = { writes: ['source.txt'], instruction: 'Change old to new' };
  const edit = { kind: 'replace', path: 'source.txt', search: 'old', text: 'new' };
  const model = edits => ({ json: async () => ({ edits }) });
  const applied = await patchEditor(model([edit]), 'editor', 'contract', { operation, files });
  assert.deepEqual({ ...applied.files }, { 'source.txt': 'preserve\nnew\ntail\n' });
  await assert.rejects(patchEditor(model([{ ...edit, search: 'stale' }]), 'editor', 'contract', { operation, files }), /count mismatch/);
  await assert.rejects(patchEditor(model([{ ...edit, path: 'foreign.txt', search: 'private' }]), 'editor', 'contract', { operation, files }), /Unowned write/);
  assert.equal(files['source.txt'], 'preserve\nold\ntail\n');
});
