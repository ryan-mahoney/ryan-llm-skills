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
const aliases = new Map([['dirty_paths,dirty_count', ['dirty_paths', 'dirty_count']]]);
function findAliases(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'ObjectExpression') {
    const pair = ['dirty_paths', 'dirty_count'].map(key => node.properties.find(p => (p.key?.name ?? p.key?.value) === key)?.value);
    if (pair.every(n => n?.type === 'Identifier')) aliases.set(pair.map(n => n.name).join(','), pair.map(n => n.name));
  }
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(findAliases); else if (value && typeof value === 'object') findAliases(value);
}
findAliases(tree);
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'BlockStatement') for (let i = 0; i < node.body.length; i++) {
    const first = node.body[i], next = node.body[i + 1];
    const pair = first.type === 'VariableDeclaration' && [...aliases.values()].find(names => names.every(name => first.declarations.some(d => d.id.name === name)));
    if (pair && next?.type === 'TryStatement') {
      slices.push({ source: source.slice(first.start, next.end), names: pair });
    }
  }
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
}
visit(tree);
// Editors may extract the entire calculation to a same-file function instead of
// retaining the original inline declaration. Execute that exact function when
// its return shape and call site identify it unambiguously.
const returnsDirtyState = node => {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'ReturnStatement' && node.argument?.type === 'ObjectExpression' &&
      ['dirty_paths', 'dirty_count'].every(key => node.argument.properties.some(p => (p.key?.name ?? p.key?.value) === key))) return true;
  return Object.values(node).some(value => Array.isArray(value) ? value.some(returnsDirtyState) : returnsDirtyState(value));
};
const helpers = functions.filter(n => n.params.length === 1 && n.params[0].name === 'record' && returnsDirtyState(n.body));
const callsWithRecord = (node, name) => {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'CallExpression' && node.callee?.name === name && node.arguments.length === 1 && node.arguments[0].name === 'record') return true;
  return Object.values(node).some(value => Array.isArray(value) ? value.some(n => callsWithRecord(n, name)) : callsWithRecord(value, name));
};
let calculation, selection;
if (slices.length === 1) {
  calculation = '(() => {' + slices[0].source + `;return {dirty_paths:${slices[0].names[0]},dirty_count:${slices[0].names[1]}};})()`;
  selection = 'inline-dirty-state-block';
} else if (slices.length === 0 && helpers.length === 1 && callsWithRecord(tree, helpers[0].id.name)) {
  calculation = `${helpers[0].id.name}(record)`;
  selection = `same-file-function:${helpers[0].id.name}`;
} else throw new Error('Diagnostic requires one identifiable dirty-state block or function; inspect candidate before adapting diagnostic');
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
      actual = vm.runInContext(declarations + '\n' + calculation, context, { timeout: 3000 });
    } catch (e) { error = e.message; }
    rows.push({ case: name, expected, actual, error,
      passed: !error && JSON.stringify(actual.dirty_paths) === JSON.stringify(expected) && actual.dirty_count === (expected?.length ?? null) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const result = { schema_version: 4, selection, scope: 'Exact candidate dirty-state block or function against real disposable Git repositories. Local aliases are resolved from dirty_paths/dirty_count object fields. Does not exercise prompt launch or receipt loading. Posthoc only; no model feedback.',
  candidate_hash: createHash('sha256').update(bytes).digest('hex'), passed: rows.every(r => r.passed), rows, elapsed_ms: performance.now() - began };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
