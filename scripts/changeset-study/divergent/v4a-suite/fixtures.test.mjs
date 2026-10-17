// Focused corpus/reference checks; no provider initialization or inference.
// Run: node --test scripts/changeset-study/divergent/v4a-suite/fixtures.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fixtures, fixtureCorpusHash } from './fixtures.mjs';
import { applyV4A } from './applier.mjs';
import { inputContext } from './prompts.mjs';
import { transform } from '../../../changeset/engine.mjs';
import { grade } from '../../sandbox.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const encoding = fixtures.filter(fixture => fixture.track === 'encoding');
const implementation = fixtures.filter(fixture => fixture.track === 'implementation');

test('pilot corpus has stable identities, byte-sensitive golds and private oracle fields excluded from bounded prompts', () => {
  assert.equal(encoding.length, 8); assert.equal(implementation.length, 4);
  assert.equal(new Set(fixtures.map(fixture => fixture.id)).size, 12);
  assert.equal(fixtureCorpusHash, 'a7fd766c0f51d46fc53ac1f4ee30526ac4f14f5c8d7c58bd27ef8817ed5a58eb');
  for (const fixture of fixtures) {
    assert.equal(fixture.hashes.source, hash(fixture.files), fixture.id);
    assert.equal(fixture.hashes.instruction, hash(fixture.instruction), fixture.id);
    assert.ok(Buffer.byteLength(JSON.stringify(fixture.files)) < 8192, fixture.id);
    for (const path of fixture.protectedPaths) {
      assert.equal(fixture.allowedPaths.includes(path), false, fixture.id);
      if (fixture.goldFiles) assert.equal(fixture.goldFiles[path], fixture.files[path], fixture.id);
    }
    for (const format of fixture.track === 'encoding' ? ['json', 'v4a'] : ['json']) {
      const context = inputContext(fixture, format, 0);
      assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 32768, fixture.id);
      const input = JSON.parse(context.messages[0].content);
      assert.deepEqual(Object.keys(input).sort(), ['allowed_paths', 'files', 'instruction', 'protected_paths']);
      assert.equal(Object.hasOwn(input, 'goldFiles'), false);
      assert.equal(Object.hasOwn(input, 'check'), false);
      assert.equal(Object.hasOwn(input, 'referenceEdits'), false);
    }
  }
  const crlf = fixtures.find(f => f.id === 'enc-crlf-tabs-unicode');
  assert.equal(crlf.goldFiles['display-label.mjs'].split('\r\n').length, 6);
  assert.ok(crlf.goldFiles['display-label.mjs'].includes('\tconst label = "Résumé – prêt";'));
  const eof = fixtures.find(f => f.id === 'enc-eof-no-newline');
  assert.equal(eof.goldFiles['stop-reason.mjs'].endsWith('\n'), false);
});

test('independently authored exact maps agree with both V4A and ordered JSON reference edits', () => {
  for (const fixture of fixtures.filter(f => f.expectedOutcome === 'edit')) {
    const before = structuredClone(fixture.files);
    const context = { ...before, ...Object.fromEntries(fixture.allowedPaths.filter(path => !Object.hasOwn(before, path)).map(path => [path, null])) };
    const operation = { id: 'reference', executor: 'deterministic', reads: Object.keys(before), writes: fixture.allowedPaths, depends_on: [], edits: fixture.referenceEdits };
    const changed = transform(operation, context);
    const actual = { ...before };
    for (const [path, text] of Object.entries(changed)) { if (text === null) delete actual[path]; else actual[path] = text; }
    assert.deepEqual(actual, fixture.goldFiles, 'JSON reference: ' + fixture.id);
    const v4a = applyV4A({ patch: fixture.referenceV4A, files: before, allowedPaths: fixture.allowedPaths, envelope: 'strict' });
    assert.equal(v4a.ok, true, fixture.id + ': ' + JSON.stringify(v4a.error));
    assert.deepEqual(v4a.files, fixture.goldFiles, 'V4A reference: ' + fixture.id);
    assert.deepEqual(before, fixture.files, 'Reference input mutated: ' + fixture.id);
  }
});

test('impossible instruction requires refusal separately from the seven positive encoding cases', () => {
  const negative = encoding.filter(f => f.expectedOutcome === 'refusal');
  assert.equal(negative.length, 1);
  assert.equal(encoding.filter(f => f.expectedOutcome === 'edit').length, 7);
  const fixture = negative[0];
  assert.equal(fixture.id, 'enc-impossible-refusal');
  assert.equal(fixture.files['schedule.mjs'].includes('stopWorker'), false);
  assert.match(fixture.referenceRefusal, /^REFUSE: [^\r\n]+$/);
  assert.equal(Object.hasOwn(fixture, 'referenceEdits'), false);
  assert.equal(Object.hasOwn(fixture, 'referenceV4A'), false);
});

async function behavior(fixture, files) {
  const directory = mkdtempSync(join(tmpdir(), 'v4a-fixture-'));
  const root = join(directory, 'candidate'); mkdirSync(root);
  try {
    for (const [path, text] of Object.entries(files)) {
      const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
    }
    return await grade(root, fixture.check, { oracle: join(directory, 'oracle.mjs'), maxMs: 3000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('implementation behavior oracles accept gold and reject every unchanged source candidate in isolated no-network sandboxes', async () => {
  for (const fixture of implementation) {
    const passed = await behavior(fixture, fixture.goldFiles);
    assert.equal(passed.ok, true, fixture.id + ': ' + passed.output);
    const unchanged = await behavior(fixture, fixture.files);
    assert.equal(unchanged.ok, false, fixture.id + ' accepts the unimplemented source');
  }
});

test('implementation behavior scoring accepts a valid alternative with different source and AST', async () => {
  const fixture = implementation.find(f => f.id === 'impl-duration-helper');
  const alternative = { ...fixture.goldFiles, 'duration.mjs': "export function secondsToMilliseconds(value) {\n  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('seconds must be finite and nonnegative');\n  const milliseconds = value * 1000;\n  return Number.isInteger(milliseconds) ? milliseconds : Math.trunc(milliseconds) + 1;\n}\n" };
  assert.notDeepEqual(alternative, fixture.goldFiles);
  const result = await behavior(fixture, alternative);
  assert.equal(result.ok, true, result.output);
});
