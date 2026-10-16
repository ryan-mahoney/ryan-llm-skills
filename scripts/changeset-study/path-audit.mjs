#!/usr/bin/env node
// Posthoc diagnostic, separate from frozen terminal grading and model input.
// Usage: node path-audit.mjs CANDIDATE_JSON ACORN_MODULE OUTPUT_JSON
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
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
const declarations = functions.map(n => source.slice(n.start, n.end)).join('\n');
const slices = [];
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'BlockStatement') for (let i = 0; i < node.body.length; i++) {
    const first = node.body[i], next = node.body[i + 1];
    if (first.type === 'VariableDeclaration' && ['dirty_paths', 'dirty_count'].every(name => first.declarations.some(d => d.id.name === name)) && next?.type === 'TryStatement') {
      slices.push(source.slice(first.start, next.end));
    }
  }
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
}
visit(tree);
if (slices.length !== 1) throw new Error('Diagnostic requires one dirty-state block; inspect this candidate before adapting the diagnostic');
const cases = [
  ['unstaged', ['file.txt']], ['staged', ['file.txt']], ['rename', ['new.txt']],
  ['mixed', ['staged.txt', 'unstaged.txt', 'new.txt']], ['leading-space-name', [' leading.txt']], ['git-error', null],
];
const rows = [];
for (const [name, expected] of cases) {
  const root = mkdtempSync(join(tmpdir(), 'changeset-path-audit-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    for (const path of ['file.txt', 'old.txt', 'staged.txt', 'unstaged.txt', ' leading.txt']) writeFileSync(join(root, path), 'initial\n');
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Initial fixture');
    if (['unstaged', 'staged'].includes(name)) writeFileSync(join(root, 'file.txt'), 'changed\n');
    if (name === 'staged') git('add', 'file.txt');
    if (name === 'rename') git('mv', 'old.txt', 'new.txt');
    if (name === 'mixed') {
      writeFileSync(join(root, 'staged.txt'), 'changed\n'); git('add', 'staged.txt');
      writeFileSync(join(root, 'unstaged.txt'), 'changed\n'); writeFileSync(join(root, 'new.txt'), 'new\n');
    }
    if (name === 'leading-space-name') writeFileSync(join(root, ' leading.txt'), 'changed\n');
    const context = vm.createContext({ execFileSync, spawnSync, record: { checkout: name === 'git-error' ? join(root, 'missing') : root } });
    let actual, error;
    try {
      actual = vm.runInContext(declarations + '\n(() => {' + slices[0] + ';return {dirty_paths,dirty_count};})()', context, { timeout: 3000 });
    } catch (e) { error = e.message; }
    rows.push({ case: name, expected, actual, error,
      passed: !error && JSON.stringify(actual.dirty_paths) === JSON.stringify(expected) && actual.dirty_count === (expected?.length ?? null) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const result = { schema_version: 2, scope: 'Exact candidate dirty-state block and same-file functions against real disposable Git repositories. Does not exercise prompt launch or receipt loading. Posthoc only; no model feedback.',
  candidate_hash: createHash('sha256').update(bytes).digest('hex'), passed: rows.every(r => r.passed), rows, elapsed_ms: performance.now() - began };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
