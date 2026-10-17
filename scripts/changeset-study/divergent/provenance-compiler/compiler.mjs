import { transform, validateFileSyntax } from '../../../changeset/engine.mjs';
import { hash, safePath } from '../../../changeset/workspace.mjs';

const own = (object, key) => Object.hasOwn(object, key);
const fail = message => { throw new Error(message); };
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function validatePlan(plan) {
  if (plan?.schema_version !== 1 || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 200) {
    fail('Expected schema_version 1 and 1..200 operations');
  }
  const ids = new Set();
  for (const op of plan.operations) {
    if (!op || typeof op.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(op.id) || ids.has(op.id)) fail('Invalid or duplicate operation ID');
    ids.add(op.id);
    if (!['simple', 'involved'].includes(op.executor)) fail(`Expected model-writer assignment: ${op.id}`);
    if (own(op, 'edits')) fail(`Input edits are not accepted: ${op.id}`);
    for (const key of ['reads', 'writes', 'depends_on']) {
      if (!Array.isArray(op[key]) || op[key].some(path => typeof path !== 'string') || new Set(op[key]).size !== op[key].length) fail(`Invalid ${key}: ${op.id}`);
    }
    [...op.reads, ...op.writes].forEach(safePath);
    if (!op.writes.length) fail(`Operation needs write ownership: ${op.id}`);
  }
  for (const op of plan.operations) if (op.depends_on.some(id => !ids.has(id) || id === op.id)) fail('Unknown or self dependency');
  const done = new Set();
  while (done.size < plan.operations.length) {
    const next = plan.operations.find(op => !done.has(op.id) && op.depends_on.every(id => done.has(id)));
    if (!next) fail('Dependency cycle');
    done.add(next.id);
  }
}

function codeRanges(brief) {
  const ranges = [];
  const lines = /[^\n]*(?:\n|$)/g;
  let offset = 0, open = null;
  for (const match of brief.matchAll(lines)) {
    const line = match[0], content = line.replace(/\r?\n$/, '');
    const opener = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const closer = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    if (open) {
      if (closer && closer[1][0] === open.marker && closer[1].length >= open.size) {
        ranges.push([open.contentStart, offset]); open = null;
      }
    } else if (opener && (opener[1][0] !== '`' || !opener[2].includes('`'))) {
      open = { marker: opener[1][0], size: opener[1].length, contentStart: offset + line.length };
    }
    offset += line.length;
    if (!line.length) break;
  }
  return ranges;
}

function integerRange(start, end, length, label) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > length) fail(`Invalid ${label} range`);
}

function inCodeFence(start, end, ranges) {
  return ranges.some(([a, b]) => start >= a && end <= b);
}

function recipeEdit(op, recipe, files, brief) {
  if (!recipe || recipe.version !== 1 || !['assemble', 'delete'].includes(recipe.action)) fail('unsupported-recipe');
  if (!['simple', 'involved'].includes(op.executor)) fail('recipe-requires-model-writer-assignment');
  if (typeof recipe.target !== 'string') fail('missing-target');
  const target = safePath(recipe.target);
  if (op.writes.length !== 1 || op.writes[0] !== target) fail('recipe-must-own-exactly-one-target');
  if (!Array.isArray(op.depends_on) || op.depends_on.length) fail('predecessor-dependent-recipe');
  if (recipe.brief_sha256 !== hash(brief)) fail('owner-brief-hash-mismatch');
  if (!Array.isArray(recipe.sources) || !Array.isArray(recipe.parts) || !Array.isArray(recipe.deleted_ranges)) fail('malformed-recipe-arrays');

  const sourceHashes = new Map();
  for (const source of recipe.sources) {
    if (!source || typeof source.path !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) fail('malformed-source-binding');
    const path = safePath(source.path);
    if (sourceHashes.has(path)) fail('duplicate-source-binding');
    if (!own(files, path) || files[path] === null || hash(files[path]) !== source.sha256) fail(`source-hash-mismatch:${path}`);
    if (path !== target && !op.reads.includes(path)) fail(`source-not-declared-read:${path}`);
    sourceHashes.set(path, source.sha256);
  }
  const targetExists = own(files, target) && files[target] !== null;
  if (targetExists && !sourceHashes.has(target)) fail('target-source-hash-required');
  if (!targetExists && sourceHashes.has(target)) fail('absent-target-has-source-binding');

  if (recipe.action === 'delete') {
    if (!targetExists || recipe.parts.length || recipe.deleted_ranges.length) fail('invalid-full-delete-recipe');
    if (sourceHashes.size !== 1 || !sourceHashes.has(target)) fail('full-delete-requires-only-target-binding');
    return { kind: 'delete', path: target };
  }

  const fences = codeRanges(brief);
  const targetText = targetExists ? files[target] : '';
  const intervals = [];
  let assembled = '';
  for (const part of recipe.parts) {
    if (!part || !['source', 'brief'].includes(part.kind)) fail('invalid-part-kind');
    integerRange(part.start, part.end, part.kind === 'brief' ? brief.length : (files[safePath(part.path)] ?? '').length, `${part.kind} part`);
    if (part.kind === 'brief') {
      if (own(part, 'path') || !inCodeFence(part.start, part.end, fences)) fail('brief-part-not-verbatim-code');
      assembled += brief.slice(part.start, part.end);
      continue;
    }
    const path = safePath(part.path);
    if (!sourceHashes.has(path) || !own(files, path) || files[path] === null) fail(`unbound-source-part:${path}`);
    if (path !== target && !op.reads.includes(path)) fail(`source-not-declared-read:${path}`);
    assembled += files[path].slice(part.start, part.end);
    if (path === target) intervals.push([part.start, part.end, 'copy']);
  }

  const deletions = recipe.deleted_ranges;
  if (!Array.isArray(deletions)) fail('malformed-deletions');
  if (!targetExists && deletions.length) fail('absent-target-cannot-have-deletions');
  for (const range of deletions) {
    if (!range || own(range, 'path')) fail('invalid-target-deletion-range');
    integerRange(range.start, range.end, targetText.length, 'target deletion');
    intervals.push([range.start, range.end, 'delete']);
  }
  if (targetExists) {
    intervals.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [start, end] of intervals) {
      if (start !== cursor) fail(start < cursor ? 'overlapping-target-ranges' : 'unaccounted-target-bytes');
      cursor = end;
    }
    if (cursor !== targetText.length) fail('unaccounted-target-bytes');
  } else if (intervals.length) fail('new-target-cannot-copy-target-ranges');
  if (!recipe.sources.every(source => recipe.parts.some(part => part.kind === 'source' && part.path === source.path) || source.path === target)) fail('unused-source-binding');

  if (!targetExists) return { kind: 'create', path: target, text: assembled };
  return { kind: 'replace', path: target, search: targetText, text: assembled, count: 1 };
}

// This prototype activates recipes only against the original snapshot. It deliberately
// leaves dependency scheduling and predecessor-aware provenance to the caller.
export function compileProvenancePlan(plan, { mode = 'forced-delegation', files, brief } = {}) {
  validatePlan(plan);
  if (!['forced-delegation', 'hybrid'].includes(mode)) fail('mode must be forced-delegation or hybrid');
  if (!files || typeof files !== 'object' || Array.isArray(files) || typeof brief !== 'string') fail('files and settled owner brief are required');
  const initial = { ...files };
  for (const [path, text] of Object.entries(initial)) {
    safePath(path);
    if (!(text === null || typeof text === 'string')) fail(`Invalid file snapshot: ${path}`);
  }
  const operations = structuredClone(plan.operations);
  const decisions = [];
  if (mode === 'forced-delegation') {
    for (const op of operations) {
      if (own(op, 'mechanical_recipe')) {
        delete op.mechanical_recipe;
        decisions.push({ id: op.id, status: 'ignored', reason: 'forced-delegation-default' });
      }
    }
    return { plan: { ...structuredClone(plan), operations }, files: initial, decisions };
  }

  let staged = { ...initial };
  for (const op of operations) {
    if (!own(op, 'mechanical_recipe')) continue;
    const recipe = op.mechanical_recipe;
    delete op.mechanical_recipe;
    let reason = null;
    try {
      const edit = recipeEdit(op, recipe, initial, brief);
      const sourcePaths = new Set((recipe.sources ?? []).map(source => source.path));
      const touched = new Set([recipe.target, ...sourcePaths]);
      for (const other of operations) {
        if (other.id === op.id) continue;
        if (other.writes.some(path => [...touched].some(input => overlaps(path, input)))) fail('another-operation-writes-recipe-input');
      }
      if (staged[recipe.target] !== initial[recipe.target]) fail('target-changed-before-recipe-application');
      const edits = [edit];
      const deterministic = { ...op, executor: 'deterministic', edits };
      const context = Object.fromEntries([...new Set([...op.reads, ...op.writes])].map(path => [path, staged[path] ?? null]));
      const changed = transform(deterministic, context);
      validateFileSyntax(changed);
      staged = { ...staged, ...changed };
      op.executor = 'deterministic';
      op.edits = edits;
      delete op.instruction;
      decisions.push({ id: op.id, status: 'activated', reason: 'hash-bound-verbatim-recipe' });
    } catch (error) {
      reason = error.message;
      decisions.push({ id: op.id, status: 'ineligible', reason });
    }
  }
  return { plan: { ...structuredClone(plan), operations }, files: staged, decisions };
}
