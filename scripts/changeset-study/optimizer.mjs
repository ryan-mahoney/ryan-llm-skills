// Conservative plan contraction: preserve every original instruction and dependency.
import { compile } from '../changeset/engine.mjs';
import { focusedInput, validateFocusedPlan } from './focused-editors.mjs';

const unique = values => [...new Set(values)];
const contexts = values => [...new Map(values.map(c => [JSON.stringify(c), c])).values()];
export function planMetrics(plan) {
  const ops = compile(plan), depths = new Map();
  for (const op of ops) depths.set(op.id, 1 + Math.max(0, ...op.depends_on.map(id => depths.get(id))));
  return { assignments: ops.length, dependency_depth: Math.max(...depths.values()),
    context_selections: ops.reduce((n, op) => n + op.context.length, 0) };
}
function mergedPair(ops, index, files) {
  const a = ops[index], b = ops[index + 1];
  if (!b || a.writes[0] !== b.writes[0] || a.preconditions || b.preconditions ||
      (a.members?.length ?? 1) + (b.members?.length ?? 1) > 2) return null;
  // A consumer needing A's intermediate state must still run before B. Contract
  // only when every other descendant of A is already a descendant of B.
  const descendants = id => {
    const found = new Set([id]);
    for (const op of ops) if (op.depends_on.some(d => found.has(d))) found.add(op.id);
    return found;
  };
  const da = descendants(a.id), db = descendants(b.id);
  if ([...da].some(id => id !== a.id && !db.has(id))) return null;
  const merged = { ...a, objective: 'Apply the following related edits in order.',
    instruction: `${a.objective}\n${a.instruction}\n\nThen: ${b.objective}\n${b.instruction}`,
    requirements: [`${a.objective}:\n${a.requirements.join('\n')}`, `${b.objective}:\n${b.requirements.join('\n')}`], reads: unique([...a.reads, ...b.reads]),
    depends_on: unique([...a.depends_on, ...b.depends_on]).filter(id => id !== a.id),
    context: contexts([...a.context, ...b.context]), members: [...(a.members ?? [a.id]), ...(b.members ?? [b.id])] };
  try {
    validateFocusedPlan({ operations: [merged] });
    focusedInput(merged, Object.fromEntries(unique([...merged.reads, ...merged.writes]).map(p => [p, files[p] ?? null])));
  } catch { return null; }
  return merged;
}
export function mergeCandidates(plan, files) {
  const ops = compile(plan), rows = [];
  for (let i = 0; i < ops.length - 1; i++) if (mergedPair(ops, i, files)) rows.push({
    key: `${ops[i].id}+${ops[i + 1].id}`, first: ops[i], second: ops[i + 1] });
  return rows;
}
export function optimizePlan(plan, files, { mode = 'deterministic', mergeChoices = {}, contextChoices = {} } = {}) {
  const before = planMetrics(plan), changes = [];
  let ops = compile(plan).map(op => ({ ...op, context: contexts(op.context) }));
  if (mode !== 'none') {
    for (let i = 0; i < ops.length - 1;) {
      const a = ops[i], b = ops[i + 1], key = `${a.id}+${b.id}`;
      const merged = mergedPair(ops, i, files);
      if (!merged || (mode === 'contextual' && mergeChoices[key] === 'separate')) { i++; continue; }
      changes.push({ kind: 'merge', members: merged.members, into: a.id });
      ops.splice(i, 2, merged);
      ops = ops.map(op => ({ ...op, depends_on: unique(op.depends_on.map(id => id === b.id ? a.id : id)).filter(id => id !== op.id) }));
      // Recompile before considering another contraction; all original conflicts remain.
      ops = compile({ schema_version: 1, operations: ops });
    }
    if (mode === 'contextual') for (const op of ops) {
      if (contextChoices[op.id] !== 'whole-small-files') continue;
      const paths = unique([...op.reads, ...op.writes]);
      if (ops.some(other => other.id !== op.id && other.writes.some(path => paths.includes(path)))) continue;
      // The only expansion policy is bounded, complete small files. It never
      // removes context or reads an undeclared file. Current staged text is used.
      if (paths.some(p => files[p] != null && files[p].length > 8000) ||
          paths.reduce((n, p) => n + (files[p]?.length ?? 0), 0) > 16000) continue;
      op.context = paths.filter(p => files[p] != null).map(path => ({ path, start: null, end: null }));
      changes.push({ kind: 'context', id: op.id, policy: 'whole-small-files' });
    }
  }
  const optimized = { ...plan, operations: ops };
  validateFocusedPlan(optimized); compile(optimized);
  return { plan: optimized, metrics: { before, after: planMetrics(optimized), changes } };
}
