#!/usr/bin/env node
// Posthoc boundary diagnostic, separate from frozen terminal grading and model input.
// Usage: node path-audit.mjs CANDIDATE_JSON ACORN_MODULE OUTPUT_JSON
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const [candidate, parser, output] = process.argv.slice(2);
const began = performance.now();
const bytes = readFileSync(candidate), files = JSON.parse(bytes);
const { parse } = await import(parser);
const source = files['pi/extensions/spec-runtime/runtime.mjs'];
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const functions = tree.body.map(n => n.declaration ?? n).filter(n => n.type === 'FunctionDeclaration');
const targets = functions.filter(n => source.slice(n.start, n.end).includes('PREVIOUS PACKET INCOMPLETE:'));
if (targets.length !== 1) throw new Error('Diagnostic requires one packet formatter; inspect this candidate before adapting the diagnostic');
const declarations = functions.map(n => source.slice(n.start, n.end)).join('\n');
const cases = [
  ['unstaged', ' M file.txt\0', ['file.txt']],
  ['staged', 'M  file.txt\0', ['file.txt']],
  ['rename', 'R  new.txt\0old.txt\0', ['new.txt']],
  ['mixed', 'M  staged.txt\0 M unstaged.txt\0?? new.txt\0', ['staged.txt', 'unstaged.txt', 'new.txt']],
  ['leading-space-name', ' M  leading.txt\0', [' leading.txt']],
];
const rows = [];
for (const [name, raw, expected] of cases) {
  const previous = { state: 'incomplete', session: 'previous', stop_reason: 'length', error: null, full_result_path: '/receipt' };
  // Real candidate formatter and git helper; only external command/file I/O is stubbed.
  const context = vm.createContext({ execFileSync: () => raw, spawnSync: () => ({ status: 0, stdout: raw }),
    readFileSync: () => JSON.stringify(previous), existsSync: () => true, read: () => previous,
    editorOutcome: () => previous, editorOutcomeFile: () => '/receipt', join, basename, dirname });
  let actual, error;
  try {
    const packet = vm.runInContext(declarations + `\n${targets[0].id.name}({checkout:'/work',package:'/package',id:'sample'})`, context, { timeout: 1000 });
    const data = JSON.parse(packet.split('\n')[0].replace('PREVIOUS PACKET INCOMPLETE: ', ''));
    actual = { dirty_paths: data.dirty_paths, dirty_count: data.dirty_count };
  } catch (e) { error = e.message; }
  rows.push({ case: name, expected, actual, error,
    passed: !error && JSON.stringify(actual.dirty_paths) === JSON.stringify(expected) && actual.dirty_count === expected.length });
}
const result = { schema_version: 1, scope: 'Exact candidate packet formatter and same-file functions with controlled external I/O. Posthoc diagnostic; not terminal grading or model feedback.',
  candidate_hash: createHash('sha256').update(bytes).digest('hex'), passed: rows.every(r => r.passed), rows, elapsed_ms: performance.now() - began };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
