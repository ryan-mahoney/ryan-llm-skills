import { Workspace } from './workspace.mjs';
import { execute } from './engine.mjs';

// The expensive reviewer runs at a batch boundary. A failed operation never
// starts a local conversation. Successful staged outputs survive a repair round.
export async function runWorkflow(plan, workspace, { review, verify, adapters = {}, concurrency = 4, maxRepairs = 1, onPlan, onDraft, signal } = {}) {
  if (typeof review !== 'function' || typeof verify !== 'function') throw new Error('Workflow requires impact review and behavioral verification');
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2) throw new Error('Repair bound must be 0..2');
  const started = Date.now(), original = workspace.snapshot();
  let candidate = new Workspace(original, null, { ...workspace.modes }), currentPlan = plan;
  const rounds = [];
  for (let round = 0; round <= maxRepairs; round++) {
    onPlan?.(currentPlan, round);
    let draft = { files: candidate.snapshot(), modes: { ...candidate.modes } }, report;
    try { report = await execute(currentPlan, candidate, { adapters, concurrency, verify, signal, onDraft: value => { draft = value; } }); }
    catch (error) { report = { ok: false, error: error.message, operations: [], verification: { status: 'not-run' } }; }
    await onDraft?.(draft, round);
    let audit;
    try {
      audit = await review({ files: draft.files, report, history: rounds, round, canRepair: round < maxRepairs });
      if (typeof audit?.accepted !== 'boolean' || !Array.isArray(audit.findings)) throw new Error('Invalid impact review response');
    } catch (error) { audit = { accepted: false, findings: [{ reason: error.message }], repair_plan: null }; }
    rounds.push({ round, report, audit });
    if (report.ok && audit.accepted) {
      const all = new Set([...Object.keys(original), ...Object.keys(draft.files)]);
      workspace.apply(Object.fromEntries([...all].filter(p => (original[p] ?? null) !== (draft.files[p] ?? null)).map(p => [p, draft.files[p] ?? null])));
      workspace.modes = { ...draft.modes };
      return { ok: true, first_pass: round === 0, repairs: round, rounds, elapsed_ms: Date.now() - started };
    }
    if (round === maxRepairs || !audit.repair_plan || signal?.aborted) break;
    candidate = new Workspace(draft.files, null, draft.modes);
    currentPlan = audit.repair_plan;
  }
  return { ok: false, first_pass: false, repairs: rounds.length - 1, rounds, elapsed_ms: Date.now() - started };
}
