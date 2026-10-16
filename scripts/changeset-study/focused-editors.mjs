// Keep the complete specification with the planner; editors get bounded assignments.
export const focusedPlanner = `
Act as the query planner and dispatcher. You retain the full task and own completeness,
interfaces and dependencies. You produce one plan; there is no later owner review or repair. Editors implement one small outcome
each; they do NOT receive the original task. This overrides earlier grouping advice and
statements that editors receive the original task. Resolve design decisions yourself.

Every operation must have exactly ONE writable file, plus:
- objective: one outcome, at most 240 characters. A helper, one behavior in a function,
  one regression scenario, one profile update, or one mechanical source move is an outcome.
- instruction: resolved local recipe, at most 2400 characters. Do not bundle independent
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

export function validateFocusedPlan(plan) {
  for (const op of plan.operations) {
    if (op.writes?.length !== 1) throw new Error(`Focused packet must own exactly one file: ${op.id}`);
    if (typeof op.objective !== 'string' || !op.objective.trim() || op.objective.length > 240 ||
        typeof op.instruction !== 'string' || !op.instruction.trim() || op.instruction.length > 2400 ||
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

export function focusedInput(operation, files) {
  validateFocusedPlan({ operations: [operation] });
  const excerpts = operation.context.map(({ path, start, end }) => {
    const text = files[path];
    if (typeof text !== 'string') throw new Error(`Excerpt file missing: ${path}`);
    const anchor = (value, fallback) => {
      if (value === null) return fallback;
      if (text.split(value).length !== 2) throw new Error(`Excerpt anchor must be unique: ${path}`);
      return text.indexOf(value);
    };
    const a = anchor(start, 0), b = anchor(end, text.length);
    if (b <= a) throw new Error(`Invalid excerpt ordering: ${path}`);
    return { path, start, end, text: text.slice(a, b) };
  });
  if (excerpts.reduce((n, c) => n + c.text.length, 0) > 32000) throw new Error(`Focused source exceeds 32000 characters: ${operation.id}`);
  for (const [path, text] of Object.entries(files)) {
    if (text !== null && !excerpts.some(c => c.path === path)) throw new Error(`Missing declared file excerpt: ${path}`);
  }
  return { objective: operation.objective, instruction: operation.instruction, requirements: operation.requirements,
    writes: operation.writes, absent_files: Object.keys(files).filter(p => files[p] === null), excerpts };
}
