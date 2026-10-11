import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDirOf } from './runtime.mjs';
import { recordCheckpoint, readCheckpointRecord } from './sentinel.mjs';

const TERMINAL_WORKER = new Set(['complete', 'failed', 'aborted', 'cancelled']);
const RECEIPT_WORKER_STATE = { completed: 'complete', failed: 'failed', cancelled: 'cancelled' };
const UNRESOLVED_INBOX = new Set(['held', 'decision-required', 'needs-spec-correction']);
const SUMMARY_MAX = 160;

// Decide whether a workflow's last sentinel checkpoint can be closed from facts
// the runtime already holds. Pure: never invents a worker state, only maps a
// terminal run receipt (matched by run id or assignment id) onto the declared
// worker, and refuses to close over a human hold or an unresolved direction.
export function decideFinalCheckpoint(checkpoint, receipts = []) {
  if (checkpoint?.state === 'complete') return { action: 'skip', reason: 'already-complete' };
  if (['user-held', 'decision-required'].includes(checkpoint?.state)) return { action: 'skip', reason: `state: ${checkpoint.state}` };
  const unresolved = (checkpoint?.inbox?.items ?? []).find(item => UNRESOLVED_INBOX.has(item?.outcome));
  if (unresolved) return { action: 'skip', reason: `inbox-unresolved: ${unresolved.id}` };
  const workers = [];
  for (const worker of checkpoint?.workers ?? []) {
    if (TERMINAL_WORKER.has(worker.state)) { workers.push({ id: worker.id, kind: worker.kind, state: worker.state }); continue; }
    const matches = receipts.filter(r => r?.id === worker.id || r?.assignment_id === worker.id);
    // A run id is unique; an assignment id can span retries, so the latest wins.
    const receipt = matches.find(r => r.id === worker.id)
      ?? matches.sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? ''))).at(-1);
    if (!receipt) return { action: 'skip', reason: `worker-unknown: ${worker.id}` };
    const state = RECEIPT_WORKER_STATE[receipt.state];
    if (!state) return { action: 'skip', reason: `worker-active: ${worker.id}` };
    workers.push({ id: worker.id, kind: worker.kind, state });
  }
  return { action: 'complete', workers };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// Run receipts are runtime/runs/<id>.json; sibling logs and verification or
// completion files are not receipts.
function readReceipts(packagePath) {
  const dir = join(packagePath, 'runtime', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => ({ name, value: readJson(join(dir, name)) }))
    .filter(({ name, value }) => typeof value?.id === 'string' && name === `${value.id}.json`).map(({ value }) => value);
}

function sentinelWorkflows(packagePath, coordinatorSession) {
  const dir = join(packagePath, 'runtime', 'sentinel');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    try { return readCheckpointRecord(packagePath, entry.name)?.coordinator_session === coordinatorSession ? [entry.name] : []; }
    catch { return []; }
  });
}

// pr-url.json is { package_ref, targets: { <repo id>: { url, ... } } }; a single target names its URL.
function summaryFor(packagePath) {
  const entries = Object.values(readJson(join(packagePath, 'pr-url.json'))?.targets ?? {});
  const url = entries.length === 1 ? entries[0]?.url : undefined;
  const summary = typeof url === 'string' ? `Publication complete: ${url}` : '';
  return summary && summary.length <= SUMMARY_MAX ? summary : 'Publication complete';
}

// After the coordinator records publication complete, close each workflow it
// registered for the package whose declared workers all have terminal receipts.
// Never throws: a skip or failure leaves the explicit coordinator checkpoint as
// the way to finish.
export async function completeWorkflowsAfterPublication({ package: packageInput, known = [], coordinator_session: coordinatorSession,
  input_revision: inputRevision, checkoutFor = () => null, location = {} }) {
  let packagePath;
  try { packagePath = await packageDirOf(packageInput, location); } catch { return []; }
  const registered = new Set();
  for (const value of known) {
    try { if (await packageDirOf(value.package, location) === packagePath) registered.add(value.workflow_id); } catch { /* unrelated package */ }
  }
  const workflows = registered.size ? [...registered] : sentinelWorkflows(packagePath, coordinatorSession);
  return workflows.map(workflowId => {
    try {
      const record = readCheckpointRecord(packagePath, workflowId);
      if (!record) return { workflow_id: workflowId, outcome: 'skipped', reason: 'checkpoint-unavailable' };
      const decision = decideFinalCheckpoint(record, readReceipts(packagePath));
      if (decision.action !== 'complete') return { workflow_id: workflowId, outcome: 'skipped', reason: decision.reason };
      const receipt = recordCheckpoint({ package: packagePath, workflow_id: workflowId, expected_revision: record.revision,
        state: 'complete', obligation: { key: 'publication-complete', stage: 'publication', summary: summaryFor(packagePath), artifacts: [] },
        workers: decision.workers,
        // Items without a recorded outcome are retained by the checkpoint itself.
        inbox: { items: (record.inbox?.items ?? []).filter(item => item.outcome).map(({ id, sha256, outcome, release_source_id }) =>
          ({ id, sha256, outcome, ...(release_source_id ? { release_source_id } : {}) })) },
        reconciles_input_revision: inputRevision, coordinator_session: coordinatorSession, checkout: checkoutFor(packagePath, workflowId) });
      return { workflow_id: workflowId, outcome: 'complete', revision: receipt.revision };
    } catch (error) { return { workflow_id: workflowId, outcome: 'skipped', reason: error.message }; }
  });
}
