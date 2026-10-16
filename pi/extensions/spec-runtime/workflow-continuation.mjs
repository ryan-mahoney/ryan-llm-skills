// A coordinator's own explicitly registered end-to-end obligation. This does not
// arm Sentinel, supervise another session, or grant publication/recovery authority.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCheckpointRecord, readInboxGuard } from './sentinel.mjs';
import { unfinishedPreparedSteps } from './completion.mjs';

const ENTRY = 'spec-workflow-continuation';
const TERMINAL = new Set(['complete', 'failed', 'aborted', 'cancelled']);
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const key = value => `${value.package}\u0000${value.workflow_id}`;

export function createWorkflowContinuation(pi) {
  const workflows = new Map();
  const save = value => { pi.appendEntry(ENTRY, value); workflows.set(key(value), value); return value; };
  function restore(ctx) {
    workflows.clear();
    const session = ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === ENTRY && entry.data?.version === 1
        && entry.data.coordinator_session === session) workflows.set(key(entry.data), entry.data);
    }
  }
  function register(checkpoint, objective, completionStage = 'publication', update) {
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 2000)
      throw new Error('Supply the explicitly requested whole-workflow objective and its authority limits');
    if (!['implementation', 'work-tour', 'publication'].includes(completionStage)) throw new Error('Invalid completion stage');
    const previous = workflows.get(key(checkpoint));
    if (previous) {
      if (previous.objective !== objective || previous.completion_stage !== completionStage) {
        if (!update || update.expected_revision !== (previous.objective_revision ?? 1)
          || typeof update.authority !== 'string' || !update.authority.trim() || update.authority.length > 2000)
          throw new Error('Updating the retained objective requires its expected_revision and the current user/inbox authority; preserve all remaining limits');
        return save({ ...previous, objective, completion_stage: completionStage,
          objective_revision: (previous.objective_revision ?? 1) + 1,
          updated_from_input_revision: checkpoint.input_revision, update_authority: update.authority });
      }
      return previous; // Repeated registration never replenishes continuation attempts.
    }
    return save({ version: 1, package: checkpoint.package, workflow_id: checkpoint.workflow_id,
      coordinator_session: checkpoint.coordinator_session, objective, completion_stage: completionStage,
      objective_revision: 1, obligation_revision: null, nudges: 0, stalled_notice: false });
  }
  function completionRecorded(value) {
    try {
      const progress = read(join(value.package, 'runtime/progress.json'));
      if (unfinishedPreparedSteps(value.package, progress).length) return false;
      const stage = read(join(value.package, 'runtime/stages', `${value.completion_stage}.json`));
      if (stage.status !== 'complete' || !stage.artifacts?.length) return false;
      if (value.completion_stage === 'publication') {
        const targets = read(join(value.package, 'locations.json')).targets;
        const published = read(join(value.package, 'pr-url.json')).targets;
        if (!targets.length || targets.some(t => typeof published?.[t.id]?.url !== 'string')) return false;
      }
      return true;
    } catch { return false; }
  }
  function beforeSettle(event, { coordinator_session, inputGuard, activeManaged, notify = () => {} }) {
    if (event.continue || event.outcome !== 'completed' || !Array.isArray(event.entries)
      || !Array.isArray(event.context?.pendingMessages) || event.context.pendingMessages.length
      || activeManaged !== false || inputGuard.active_prompts !== 0) return;
    for (const value of [...workflows.values()].reverse()) {
      if (value.coordinator_session !== coordinator_session) continue;
      try {
        const checkpoint = readCheckpointRecord(value.package, value.workflow_id);
        if (!checkpoint || checkpoint.coordinator_session !== coordinator_session
          || !Number.isInteger(inputGuard.input_revision) || inputGuard.input_revision < 0
          || checkpoint.input_revision !== inputGuard.input_revision
          || !['ready', 'complete'].includes(checkpoint.state)
          || !Array.isArray(checkpoint.workers) || checkpoint.workers.some(w => !TERMINAL.has(w.state))) continue;
        const inbox = readInboxGuard(value.package, { priorItems: checkpoint.inbox?.items ?? [],
          items: checkpoint.inbox?.items ?? [], priorDirectories: checkpoint.inbox?.observed_directories ?? [] });
        if (inbox.blocking !== false || completionRecorded(value)) continue;
        if (!checkpoint.obligation_revision || !checkpoint.obligation?.key) continue;
        const nudges = value.obligation_revision === checkpoint.obligation_revision ? value.nudges : 0;
        if (nudges >= 2) {
          if (!value.stalled_notice) {
            save({ ...value, stalled_notice: true });
            notify(`Workflow stalled on ${checkpoint.obligation.key} after two continuations. Its objective remains unfinished; inspect the blocker before resuming.`);
          }
          continue;
        }
        // Consume before proposing the turn. Reload, a later veto or an abort
        // cannot repeat an uncertain delivery or silently reset this allowance.
        save({ ...value, obligation_revision: checkpoint.obligation_revision, nudges: nudges + 1, stalled_notice: false });
        return { entries: [...event.entries, { type: 'custom_message', customType: ENTRY, display: true,
          content: `${retainedContext(value)}\nCurrent obligation: ${checkpoint.obligation.key}: ${checkpoint.obligation.summary}. Reconcile current canonical handoffs, reviews and inbox outcomes, then perform the next authorized action. A completed step or status response does not finish the package. If blocked, record the concrete blocker and stop state; preserve holds and publication limits. Do not repeat completed checks or launch another writer while one is active.` }], continue: true };
      } catch { /* Unknown state grants no continuation; retain the objective. */ }
    }
  }
  function context(event) {
    if (!workflows.size) return;
    const content = [...workflows.values()].map(retainedContext).join('\n');
    return { messages: [...event.messages.filter(m => m.customType !== ENTRY),
      { role: 'custom', customType: ENTRY, content, display: false, timestamp: Date.now() }] };
  }
  return { register, restore, beforeSettle, context };
}

function retainedContext(value) {
  return `Retained outcome (revision ${value.objective_revision ?? 1}): ${value.objective}\nPackage: ${value.package}. Workflow: ${value.workflow_id}. Final stage: ${value.completion_stage}.\nThis is an outcome and authority reminder, not a snapshot of current execution. Read runtime/progress.json, the current workflow checkpoint and reconciled inbox outcomes for remaining work and routing; read locations.json and Git for checkout/revision facts. Later authorized directions supersede historical routing or progress embedded in this objective. Preserve publication limits and explicit holds; reconcile an outdated objective with spec_workflow's revision-checked update. Intermediate checkpoints are not the final outcome.`;
}
