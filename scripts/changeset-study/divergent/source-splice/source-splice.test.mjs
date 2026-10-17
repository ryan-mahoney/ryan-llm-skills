import assert from 'node:assert/strict';
import test from 'node:test';
import { hash } from '../../../changeset/workspace.mjs';
import { spliceExisting } from './source-splice.mjs';

test('splices exact source into an existing file and replaces only the declared gap', () => {
  const snapshot = {
    'src/target.mjs': 'export const before = 1;\n// INSERT HERE\n// END\nexport const after = 3;\n',
    'src/source.mjs': 'export const middle = 2;\nexport const spare = 9;\n',
  };
  const original = structuredClone(snapshot);
  const inserted = spliceExisting({
    snapshot, reads: ['src/target.mjs', 'src/source.mjs'], writes: ['src/target.mjs'],
    target: { path: 'src/target.mjs', sha256: hash(snapshot['src/target.mjs']), start_anchor: '// INSERT HERE\n', end_anchor: '// END\n' },
    parts: [
      { kind: 'literal', text: '/* copied below */\n' },
      { kind: 'source', path: 'src/source.mjs', sha256: hash(snapshot['src/source.mjs']), start_anchor: 'export const middle = 2;\n', end_anchor: 'export const spare = 9;\n' },
    ],
  });
  assert.equal(inserted.preview['src/target.mjs'], 'export const before = 1;\n// INSERT HERE\n/* copied below */\nexport const middle = 2;\n// END\nexport const after = 3;\n');
  assert.deepEqual(snapshot, original, 'preview leaves the input snapshot untouched');

  const replaced = spliceExisting({
    snapshot: inserted.preview, reads: ['src/target.mjs'], writes: ['src/target.mjs'],
    target: { path: 'src/target.mjs', sha256: hash(inserted.preview['src/target.mjs']), start_anchor: '// INSERT HERE\n', end_anchor: '// END\n' },
    parts: [{ kind: 'literal', text: 'export const replacement = 4;\n' }],
  });
  assert.equal(replaced.preview['src/target.mjs'], 'export const before = 1;\n// INSERT HERE\nexport const replacement = 4;\n// END\nexport const after = 3;\n');
  assert.equal(snapshot['src/target.mjs'], original['src/target.mjs']);
});

test('refuses stale snapshots, ambiguous anchors, and unowned targets without changing input', () => {
  const snapshot = { 'src/target.mjs': 'const a = 1;\n// gap\nconst b = 2;\n', 'src/source.mjs': 'same\nsame\n' };
  const original = structuredClone(snapshot);
  const base = {
    snapshot, reads: ['src/target.mjs', 'src/source.mjs'], writes: ['src/target.mjs'],
    target: { path: 'src/target.mjs', sha256: hash(snapshot['src/target.mjs']), start_anchor: 'const a = 1;\n', end_anchor: 'const b = 2;\n' },
    parts: [{ kind: 'literal', text: 'replacement\n' }],
  };
  assert.throws(() => spliceExisting({ ...base, target: { ...base.target, sha256: '0'.repeat(64) } }), /Stale target snapshot/);
  assert.throws(() => spliceExisting({ ...base, target: { ...base.target, start_anchor: 'const' } }), /start anchor must occur exactly once/);
  assert.throws(() => spliceExisting({ ...base, writes: [] }), /not owned for writing/);
  assert.throws(() => spliceExisting({ ...base, parts: [{ kind: 'source', path: 'src/source.mjs', sha256: '0'.repeat(64), start_anchor: 'same', end_anchor: null }] }), /Stale source snapshot/);
  assert.throws(() => spliceExisting({ ...base, parts: [{ kind: 'source', path: 'src/source.mjs', sha256: hash(snapshot['src/source.mjs']), start_anchor: 'same', end_anchor: null }] }), /start anchor must occur exactly once/);
  const overlapSource = { 'src/target.mjs': snapshot['src/target.mjs'], 'src/overlap.mjs': 'aaa' };
  assert.throws(() => spliceExisting({
    ...base, snapshot: overlapSource, reads: ['src/target.mjs', 'src/overlap.mjs'],
    parts: [{ kind: 'source', path: 'src/overlap.mjs', sha256: hash(overlapSource['src/overlap.mjs']), start_anchor: 'aa', end_anchor: null }],
  }), /Source start anchor must occur exactly once/);
  assert.throws(() => spliceExisting({
    snapshot: { 'src/overlap-target.mjs': 'aaa' }, reads: ['src/overlap-target.mjs'], writes: ['src/overlap-target.mjs'],
    target: { path: 'src/overlap-target.mjs', sha256: hash('aaa'), start_anchor: 'aa', end_anchor: null },
    parts: [{ kind: 'literal', text: 'b' }],
  }), /Target start anchor must occur exactly once/);
  assert.deepEqual(snapshot, original);
});

test('syntax rejection keeps an invalid candidate private', () => {
  const snapshot = { 'src/target.mjs': 'const before = 1;\n// gap\nconst after = 2;\n' };
  const original = structuredClone(snapshot);
  assert.throws(() => spliceExisting({
    snapshot, reads: ['src/target.mjs'], writes: ['src/target.mjs'],
    target: { path: 'src/target.mjs', sha256: hash(snapshot['src/target.mjs']), start_anchor: 'const before = 1;\n', end_anchor: 'const after = 2;\n' },
    parts: [{ kind: 'literal', text: 'const = ;\n' }],
  }), /Syntax check failed for src\/target\.mjs/);
  assert.deepEqual(snapshot, original);
});
