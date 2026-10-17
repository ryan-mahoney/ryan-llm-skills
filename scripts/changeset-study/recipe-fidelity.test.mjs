// Run: node --test scripts/changeset-study/recipe-fidelity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeLiterals, recipeFidelity } from './recipe-fidelity.mjs';

const op = (instruction, requirements = []) => ({ instruction, requirements });

test('quoted insert text and shorthand objects are expectations; anchors and removal targets are not', () => {
  const rewire = op('Replace the environmentFacts definition range `export function en` to `// Sanit` with no definition. Before `export cl`, insert const waveLifecycle = createWaveLifecycle with the exact helper object below.',
    ['Factory object: { read, atomic, save, timestamp, runLockedMutation }. Do not inject waveCoordinator.']);
  const files = { 'runtime.mjs': 'function read() {}\nfunction atomic() {}\nfunction save() {}\nconst timestamp = () => 1;\nfunction runLockedMutation() {}\n' };
  assert.deepEqual(recipeLiterals(rewire, files), [{ kind: 'shorthand', names: ['read', 'atomic', 'save', 'timestamp', 'runLockedMutation'] }]);
  assert.deepEqual(recipeLiterals(rewire, {}), [], 'names unknown to the declared source are not binding expectations');
  const shape = op('Build detail {step, decisions, unresolved, remaining_work, findings, truncated}, mapping gaps to unresolved.');
  assert.deepEqual(recipeLiterals(shape, files), [], 'a result shape is not a shorthand expectation');
  const good = 'const waveLifecycle = createWaveLifecycle({\n  read,\n  atomic,\n  save,\n  timestamp,\n  runLockedMutation,\n});\n';
  assert.deepEqual(recipeFidelity(rewire, good, files), []);
  const rebound = 'const waveLifecycle = createWaveLifecycle({\n  read: readFileSync,\n  atomic: writeFileSync,\n  save: renameSync,\n  timestamp: () => Date.now(),\n  runLockedMutation,\n});\n';
  assert.match(recipeFidelity(rewire, rebound, files)[0], /shorthand members read, atomic, save, timestamp/);
  const register = op("After apply, replace the single `pi.on('session_start', apply);` registration with a local seedCalibration(ctx) and one combined registration. Register exactly `pi.on('session_start', (event, ctx) => { seedCalibration(ctx); return apply(event, ctx); });`.");
  assert.deepEqual(recipeLiterals(register), [{ kind: 'snippet', text: "pi.on('session_start', (event, ctx) => { seedCalibration(ctx); return apply(event, ctx); });" }]);
  assert.deepEqual(recipeFidelity(register, "pi.on('session_start', (event, ctx) => {\n  seedCalibration(ctx);\n  return apply(event, ctx);\n});\n"), []);
  assert.equal(recipeFidelity(register, "pi.on('session_start', apply);\n").length, 1);
  const anchors = op('Delete range `// The top-level setup declaration` through `export async function resolveInput(`. Copy `// A contained wave root reserves capacity` through `// Side-`.');
  assert.deepEqual(recipeLiterals(anchors), []);
});
