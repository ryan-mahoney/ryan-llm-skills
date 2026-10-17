import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewContext } from './review-context.mjs';

test('review includes unchanged helper semantics hidden outside changed function and method diffs', async () => {
  const { parse } = await import(process.env.CHANGESET_TEST_PARSER || 'acorn');
  const original = "function read(){return ' value'.trim();}\nfunction unused(){return 42;}\nclass Owner { value(){return 1;} }";
  const updated = original.replace('return 1;', 'return read();') + '\nfunction added(){return read();}';
  const result = reviewContext({ 'file.mjs': original }, { 'file.mjs': updated }, parse);
  assert.deepEqual(result.helpers, [{ path: 'file.mjs', name: 'read', source: "function read(){return ' value'.trim();}" }]);
  assert.deepEqual(result.unavailable, []);
  const bounded = reviewContext({ 'file.mjs': original }, { 'file.mjs': updated }, parse, 1);
  assert.deepEqual(bounded.helpers, []);
  assert.deepEqual(bounded.omitted, [{ path: 'file.mjs', name: 'read' }]);
  assert.deepEqual(reviewContext({}, { 'broken.mjs': 'export {' }, parse).unavailable, ['broken.mjs']);
});
