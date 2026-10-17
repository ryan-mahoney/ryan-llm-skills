// Conservative plan contraction: preserve every original instruction and dependency.
import { compile } from '../changeset/engine.mjs';
import { focusedInput, validateFocusedPlan } from './focused-editors.mjs';

const unique = values => [...new Set(values)];
// Key on the three fields so key order in planner JSON cannot defeat deduplication.
// start/end are null or nonempty strings, so the empty string is unambiguous for null.
const contextKey = c => `${c.path}\u0000${c.start ?? ''}\u0000${c.end ?? ''}`;
const contexts = values => [...new Map(values.map(c => [contextKey(c), c])).values()];
const clip = (text, max) => text.length <= max ? text : text.slice(0, max - 3).trimEnd() + '...';
export function planMetrics(plan) {
  const ops = compile(plan), depths = new Map();
  for (const op of ops) depths.set(op.id, 1 + Math.max(0, ...op.depends_on.map(id => depths.get(id))));
  return { assignments: ops.length, dependency_depth: Math.max(...depths.values()),
    context_selections: ops.reduce((n, op) => n + op.context.length, 0) };
}
// Files some operation before `index` has written, excluding the pair itself. Their
// staged text is unknown here, so excerpt anchors on them are checked at preflight and
// execution rather than against the initial snapshot.
function dirtyBefore(ops, index, exclude) {
  const dirty = new Set();
  for (let i = 0; i < index; i++) if (!exclude.has(ops[i].id)) ops[i].writes.forEach(path => dirty.add(path));
  return dirty;
}
function mergedPair(ops, i, j, files) {
  const a = ops[i], b = ops[j];
  // OPTIMIZER-PROTOCOL.md: at most two original assignments combine. The size
  // constraint is the focused packet bound, which validateFocusedPlan enforces below.
  if (a.writes[0] !== b.writes[0] || a.preconditions || b.preconditions ||
      (a.members?.length ?? 1) + (b.members?.length ?? 1) > 2) return null;
  // A consumer needing A's intermediate state must still run before B. Contract
  // only when every other descendant of A is already a descendant of B. This also
  // refuses any operation between A and B that reads or writes their file.
  const descendants = id => {
    const found = new Set([id]);
    for (const op of ops) if (op.depends_on.some(d => found.has(d))) found.add(op.id);
    return found;
  };
  const da = descendants(a.id), db = descendants(b.id);
  if ([...da].some(id => id !== a.id && !db.has(id))) return null;
  const merged = { ...a, objective: clip(`${a.objective}; then ${b.objective}`, 240),
    instruction: `${a.objective}\n${a.instruction}\n\nThen: ${b.objective}\n${b.instruction}`,
    requirements: [`${a.objective}:\n${a.requirements.join('\n')}`, `${b.objective}:\n${b.requirements.join('\n')}`], reads: unique([...a.reads, ...b.reads]),
    depends_on: unique([...a.depends_on, ...b.depends_on]).filter(id => id !== a.id),
    context: contexts([...a.context, ...b.context]), members: [...(a.members ?? [a.id]), ...(b.members ?? [b.id])] };
  // Same rule as preflightFocusedPlan: validate excerpts only on files no earlier
  // operation has written. Checking a dirty file against the initial snapshot could
  // pass on text that will not exist when the merged packet runs.
  const dirty = dirtyBefore(ops, j, new Set([a.id, b.id]));
  const context = merged.context.filter(c => !dirty.has(c.path));
  const current = Object.fromEntries(unique([...merged.reads, ...merged.writes]).filter(p => !dirty.has(p)).map(p => [p, files[p] ?? null]));
  try {
    validateFocusedPlan({ operations: [merged] });
    focusedInput({ ...merged, context }, current);
  } catch { return null; }
  return { merged, deferred: unique(merged.context.filter(c => dirty.has(c.path)).map(c => c.path)) };
}
// Each operation pairs with the next writer of its file in compiled order, whatever
// sits between them; the descendant check above decides whether that is safe.
function candidatePairs(ops, files) {
  const rows = [];
  for (let i = 0; i < ops.length; i++) {
    const j = ops.findIndex((op, k) => k > i && op.writes[0] === ops[i].writes[0]);
    if (j < 0) continue;
    const result = mergedPair(ops, i, j, files);
    if (result) rows.push({ key: `${ops[i].id}+${ops[j].id}`, first: ops[i], second: ops[j], ...result });
  }
  return rows;
}
export function mergeCandidates(plan, files) {
  return candidatePairs(compile(plan), files).map(({ key, first, second }) => ({ key, first, second }));
}
export function optimizePlan(plan, files, { mode = 'deterministic', mergeChoices = {}, contextChoices = {} } = {}) {
  const before = planMetrics(plan), changes = [];
  let ops = compile(plan).map(op => ({ ...op, context: contexts(op.context) }));
  if (mode !== 'none') {
    // Recompiling after a merge can reorder operations, so recompute candidates from
    // the current plan each round instead of scanning by index.
    for (;;) {
      const pick = candidatePairs(ops, files).find(c => !(mode === 'contextual' && mergeChoices[c.key] === 'separate'));
      if (!pick) break;
      const { first: a, second: b, merged, deferred } = pick;
      changes.push({ kind: 'merge', members: merged.members, into: a.id, ...(deferred.length ? { deferred_excerpt_validation: deferred } : {}) });
      ops = ops.filter(op => op.id !== b.id).map(op => op.id === a.id ? merged
        : { ...op, depends_on: unique(op.depends_on.map(id => id === b.id ? a.id : id)).filter(id => id !== op.id) });
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

const overlapPath = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const intersects = (a, b) => a.some(x => b.some(y => overlapPath(x, y)));
// A declared edge with no file overlap only encodes planner sequencing, such as
// "the imported module must exist before its caller is edited". Writers never see
// the other file, so the edge cannot change any written byte, and compile() keeps
// every read/write overlap as a dependency. Dropping these edges lets independent
// chains run concurrently.
export function pruneDeclaredDependencies(plan) {
  const byId = new Map(plan.operations.map(op => [op.id, op])), removed = [];
  const operations = plan.operations.map(op => {
    const depends_on = (op.depends_on ?? []).filter(id => {
      const other = byId.get(id);
      const keep = !other || intersects(other.writes ?? [], [...(op.reads ?? []), ...(op.writes ?? [])]) || intersects(other.reads ?? [], op.writes ?? []);
      if (!keep) removed.push({ from: op.id, to: id });
      return keep;
    });
    return { ...op, depends_on };
  });
  return { plan: { ...plan, operations }, removed };
}
