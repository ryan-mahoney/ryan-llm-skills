import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, transform } from '../../../changeset/engine.mjs';
import { Workspace, hash } from '../../../changeset/workspace.mjs';
import { same } from '../writer-control/support.mjs';
import { grade } from '../../sandbox.mjs';
import { applyV4A } from './applier.mjs';

export function applyJSON(text, fixture) {
  const original = structuredClone(fixture.files), gates = { parsed: false, paths: null, applied: false, unambiguous: null };
  let plan, operations, ambiguity = false;
  try { plan = JSON.parse(text); operations = compile(plan); if (operations.some(op => op.executor !== 'deterministic')) throw new Error('Only executable deterministic operations are allowed'); gates.parsed = true; }
  catch (error) { return { ok: false, files: original, gates, ambiguity, error: { code: 'json-schema', message: error.message } }; }
  const compileChanges = operations.map(op => { const raw = plan.operations.find(raw => raw.id === op.id); return { id: op.id, added_writes: op.writes.filter(path => !raw.writes.includes(path)), added_dependencies: op.depends_on.filter(id => !raw.depends_on.includes(id)) }; }).filter(row => row.added_writes.length || row.added_dependencies.length);
  const workspace = new Workspace(original), matches = [];
  try {
    if (operations.some(op => op.writes.some(path => !fixture.allowedPaths.includes(path) || fixture.protectedPaths?.includes(path)))) throw new Error('Write path is outside fixture ownership');
    gates.paths = true;
    for (const op of operations) {
      const context = workspace.snapshot([...new Set([...op.reads, ...op.writes])]);
      for (const [path, expected] of Object.entries(op.preconditions ?? {})) if (hash(context[path]) !== expected) throw new Error(`Precondition failed: ${path}`);
      // Transform edits one at a time so observed match counts refer to staged source.
      for (const edit of op.edits) {
        if (edit.kind === 'replace' && typeof context[edit.path] === 'string' && typeof edit.search === 'string' && edit.search) {
          const count = context[edit.path].split(edit.search).length - 1, requested = edit.count ?? 1;
          matches.push({ path: edit.path, kind: 'replace', matches: count, requested_count: requested });
          if (count > requested) ambiguity = true;
        }
        const changed = transform({ ...op, edits: [edit] }, context);
        Object.assign(context, changed);
      }
      workspace.apply(Object.fromEntries(op.writes.map(path => [path, context[path]])));
    }
    gates.applied = true; gates.unambiguous = !ambiguity;
    return { ok: true, files: workspace.snapshot(), gates, ambiguity, matchclass: 'exact-count', matches, plan, compiled_operations: operations, compile_changes: compileChanges, error: null };
  } catch (error) {
    gates.paths ??= false; gates.unambiguous = ambiguity ? false : null;
    return { ok: false, files: original, gates, ambiguity, matches, plan, compiled_operations: operations, compile_changes: compileChanges, error: { code: ambiguity ? 'ambiguous-match' : gates.paths ? 'application' : 'path', message: error.message } };
  }
}
export function syntaxGate(before, files) {
  const checked = [], errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (text === before[path]) continue;
    try {
      if (path.endsWith('.json')) { JSON.parse(text); checked.push(path); }
      const mode = path.endsWith('.cjs') ? 'commonjs' : /\.(?:mjs|js)$/.test(path) ? 'module' : null;
      if (mode) { execFileSync(process.execPath, [`--input-type=${mode}`, '--check'], { input: text, timeout: 3000, maxBuffer: 16384, stdio: ['pipe', 'pipe', 'pipe'] }); checked.push(path); }
    } catch (error) { errors.push({ path, message: String(error.stderr ?? error.message).slice(0, 2000) }); }
  }
  return { passed: errors.length === 0, checked, errors };
}
export async function evaluate(fixture, format, raw, { stopReason = 'stop', checkMs = 5000 } = {}) {
  const refusal = typeof raw === 'string' && /^REFUSE:\s*[^\r\n]+$/.test(raw.trim());
  const result = { gates: { stopped: stopReason === 'stop', parsed: null, paths: null, applied: false, unambiguous: null, syntax: null, correct: false }, refusal,
    expected_outcome: fixture.expectedOutcome, applied_incorrect: false, files: structuredClone(fixture.files), error: null };
  if (stopReason !== 'stop' || typeof raw !== 'string') { result.error = { code: stopReason === 'length' ? 'truncation' : 'provider-stop', message: `Provider stopped: ${stopReason}` }; return result; }
  if (refusal) { result.gates.correct = fixture.expectedOutcome === 'refusal'; result.error = result.gates.correct ? null : { code: 'unexpected-refusal', message: 'Expected an edit, received refusal' }; return result; }
  const applied = format === 'json' ? applyJSON(raw, fixture) : applyV4A({ patch: raw, files: fixture.files, allowedPaths: fixture.allowedPaths, envelope: 'strict' });
  result.application = applied; Object.assign(result.gates, applied.gates); result.files = applied.files;
  if (format === 'v4a') result.lenient_wrapper_diagnostic = applyV4A({ patch: raw, files: fixture.files, allowedPaths: fixture.allowedPaths, envelope: 'lenient-wrapper' });
  result.error = applied.error;
  if (!applied.ok) return result;
  const protectedIntact = (fixture.protectedPaths ?? []).every(path => applied.files[path] === fixture.files[path]);
  result.gates.paths &&= protectedIntact;
  const syntax = syntaxGate(fixture.files, applied.files); result.syntax = syntax; result.gates.syntax = syntax.passed;
  if (fixture.expectedOutcome === 'refusal') { result.error = { code: 'expected-refusal', message: 'An edit was emitted for an impossible instruction' }; result.applied_incorrect = true; return result; }
  if (fixture.track === 'encoding') {
    result.exact_gold_match = same(applied.files, fixture.goldFiles); result.gates.correct = protectedIntact && result.exact_gold_match;
  } else {
    const root = mkdtempSync(join(tmpdir(), 'writer-suite-'));
    try {
      const candidate = join(root, 'candidate'); new Workspace(applied.files).materialize(candidate);
      const oracle = join(root, 'oracle.mjs');
      try { result.behavior = await grade(candidate, fixture.check, { oracle, maxMs: checkMs, signal: AbortSignal.timeout(checkMs) }); }
      catch (error) { result.behavior = { ok: false, error: error.message }; }
      result.gates.correct = protectedIntact && result.behavior.ok;
      result.reference_gold_exact = same(applied.files, fixture.goldFiles);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  result.applied_incorrect = result.gates.applied && (!result.gates.correct || !result.gates.syntax || !result.gates.paths);
  if (result.applied_incorrect) result.error ??= { code: !result.gates.paths ? 'protected-path' : !result.gates.syntax ? 'syntax' : fixture.track === 'encoding' ? 'gold-mismatch' : 'behavior', message: 'Applied candidate failed a required preserved-path, syntax or correctness gate; candidate retained.' };
  return result;
}
