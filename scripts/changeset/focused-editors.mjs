// Keep the complete specification with the planner; editors get bounded assignments.
import { compile } from './engine.mjs';
import { ambiguousAnchorMessage } from './workspace.mjs';
import { compactContext } from './context-compact.mjs';

export const focusedPacketRules = `Every operation must have exactly ONE writable file, plus:
- objective: one outcome, at most 240 characters. A helper, one behavior in a function,
  one regression scenario, one profile update, or one mechanical source move is an outcome.
- instruction: resolved local recipe within the total assignment character bound. Do not bundle independent
  algorithms or all tests into one packet. Prefer 1-3 concrete implementation steps.
- requirements: 1-5 short strings with the relevant interface, edge cases and preservation
  obligations. objective + instruction + requirements together must fit 4000 characters.
  Include all obligations this editor needs; do not refer it to omitted spec sections.
- context: [{path,start,end}, ...] selects source excerpts from declared reads/writes.
  start is a unique inclusive anchor or null for BOF; end is a unique exclusive anchor
  or null for EOF. Each selected range must be nonempty. At most 16 excerpts and 32000
  source characters TOTAL per packet. Every existing declared file needs an excerpt;
  absent new files need none. Use null/null only for a genuinely small complete file.
  Excerpts are taken from CURRENT staged files when the operation runs. Anticipate prior
  operations; do not use anchors they remove. Do not declare unrelated read files.

For large existing files select only the relevant function, import region, insertion
anchor or fixture helper. Include enough exact context to make unique replacements.
For pure moves, source-range operations copy from the full staged file even though the
editor sees only excerpts: supply boundary anchors and dependency details, not entire
unchanged bodies. Creating the extracted module and rewiring its caller are separate
packets with an explicit dependency; each intermediate file must parse on its own.
Keep independently owned files independent when their interfaces are already settled.
Do not add reads of changing files just for background: read/write conflicts serialize.
Multiple packets writing one file are allowed and execute in dependency order against
updated content. Never coalesce them merely to reduce calls. Declare true dependencies.
Split implementation and regression scenarios. Before returning the plan, map every
original obligation to a packet or existing verified behavior, including required tests.
Return the ordinary plan JSON; no edits,
deterministic operations, or extra contract object. Every write goes to the editor.
`;

export const focusedPlanner = `
Act as the query planner and dispatcher. You retain the full task and own completeness,
interfaces and dependencies. You produce one plan; there is no later owner review or repair. Editors implement one small outcome
each; they do NOT receive the original task. This overrides earlier grouping advice and
statements that editors receive the original task. Resolve design decisions yourself.
Before dispatch, the runtime validates the plan and current-source excerpts. If it
returns planning_validation_errors, correct your own plan once; no editor has run.
Check exact callback signatures and fixture invocation arguments when assigning tests.

` + focusedPacketRules;

export function validateFocusedPlan(plan) {
  for (const op of plan.operations) {
    if (op.writes?.length !== 1) throw new Error(`Focused packet must own exactly one file: ${op.id}`);
    if (typeof op.objective !== 'string' || !op.objective.trim() || op.objective.length > 240 ||
        typeof op.instruction !== 'string' || !op.instruction.trim() || op.instruction.length > 4000 ||
        !Array.isArray(op.requirements) || !op.requirements.length || op.requirements.length > 5 ||
        op.requirements.some(x => typeof x !== 'string' || !x.trim()) ||
        op.objective.length + op.instruction.length + op.requirements.join('').length > 4000 || op.contract !== undefined) {
      throw new Error(`Focused packet needs a short objective, instruction and 1-5 requirements: ${op.id}`);
    }
    if (!Array.isArray(op.context) || op.context.length > 16 || op.context.some(c =>
      !c || ![...(op.reads ?? []), ...op.writes].includes(c.path) ||
      [c.start, c.end].some(a => a !== null && (typeof a !== 'string' || !a.length)))) {
      throw new Error(`Focused packet needs valid context excerpts from declared paths: ${op.id}`);
    }
  }
}

// An anchor the planner bound against the original file can become ambiguous once an
// earlier packet has edited that file. When the original holds the anchor exactly once,
// the staged occurrence whose surrounding text matches the original's is the intended
// one; any other ambiguity still fails.
export function resolveAnchor(text, value, path, original = null) {
  const count = text.split(value).length - 1;
  if (count === 1) return text.indexOf(value);
  if (count > 1 && typeof original === 'string' && original.split(value).length === 2) {
    const at = original.indexOf(value), after = original.slice(at + value.length, at + value.length + 40), before = original.slice(Math.max(0, at - 40), at);
    const positions = []; let found = text.indexOf(value);
    while (found >= 0) { positions.push(found); found = text.indexOf(value, found + 1); }
    for (const window of [p => text.startsWith(after, p + value.length) && text.slice(Math.max(0, p - before.length), p) === before, p => text.startsWith(after, p + value.length)]) {
      const matches = positions.filter(window);
      if (matches.length === 1) return matches[0];
    }
  }
  throw new Error(`Excerpt anchor must be unique: ${ambiguousAnchorMessage(path, value, text)}`);
}

export function focusedInput(operation, files, { parse, original = null } = {}) {
  validateFocusedPlan({ operations: [operation] });
  let excerpts = operation.context.map(({ path, start, end }) => {
    const text = files[path];
    if (typeof text !== 'string') throw new Error(`Excerpt file missing: ${path}`);
    const anchor = (value, fallback) => value === null ? fallback : resolveAnchor(text, value, path, original?.[path] ?? null);
    const a = anchor(start, 0), b = anchor(end, text.length);
    if (b <= a) throw new Error(`Invalid excerpt ordering: ${path}`);
    return { path, start, end, source_start: a, source_end: b, text: text.slice(a, b) };
  });
  let compaction = null;
  if (excerpts.reduce((n, c) => n + c.text.length, 0) > 32000) {
    try { ({ excerpts, compaction } = compactContext(excerpts, files, { parse })); }
    catch (error) { throw new Error(`${error.message}: ${operation.id}`); }
  }
  if (!compaction) excerpts = excerpts.map(({ source_start, source_end, ...excerpt }) => excerpt);
  for (const [path, text] of Object.entries(files)) {
    if (text !== null && !excerpts.some(c => c.path === path)) throw new Error(`Missing declared file excerpt: ${path}`);
  }
  return { objective: operation.objective, instruction: operation.instruction, requirements: operation.requirements,
    writes: operation.writes, absent_files: Object.keys(files).filter(p => files[p] === null), excerpts, ...(compaction ? { source_compaction: compaction } : {}) };
}

// Validate only source that has not been written by an earlier operation. Future
// generated source remains checked at execution against the actual staged state.
export function preflightFocusedPlan(plan, files, { parse } = {}) {
  const errors = [], changed = new Set();
  for (const operation of compile(plan)) {
    const context = operation.context.filter(c => !changed.has(c.path));
    const current = Object.fromEntries([...new Set([...operation.reads, ...operation.writes])]
      .filter(path => !changed.has(path)).map(path => [path, files[path] ?? null]));
    try { focusedInput({ ...operation, context }, current, { parse }); }
    catch (error) { errors.push(`${operation.id}: ${error.message}`); }
    operation.writes.forEach(path => changed.add(path));
  }
  return errors;
}
