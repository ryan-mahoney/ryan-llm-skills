import { Type } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, realpathSync } from 'node:path';
import { homedir } from 'node:os';
import { Runtime, loadRun, summary, assertLease, runEditor, runCommand, runVerification, runAdvice, runCompletion, canonicalPackage, assertIdleWriter, event as runtimeEvent } from './runtime.mjs';
import { assertModelSelector } from './model-selector.mjs';
import { createCommunication } from './communication.mjs';
import { createMonitor } from './monitor.mjs';
import { createSentinelObserver, createVerificationRecorder, recordCheckpoint as recordSentinelCheckpoint, readInboxGuard, readCheckpointRecord, observeInput, reconcileRuntimeReturn, checkpointPath, createSentinelAuthority, createDiagnosisController, activatePolicy, disablePolicy, handleBeforeSettle, finishIntent, considerCancellation } from './sentinel.mjs';
import { createScout, SCOUT_MODEL } from './scout.mjs';
import { installProgressContext, recordCheckpoint, refreshProgress } from './completion.mjs';
import { metrics, formatMetrics } from './metrics.mjs';

const result = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, isError });
const optional = (description: string) => Type.Optional(Type.String({ description }));

// Coordinator identity is taken from the actual session manager (session file /
// stable session id), never from a model field. A checkout is accepted only from
// an already bound checkpoint or a matching real Runtime dispatch receipt.
const coordinatorIdentity = (ctx: any): string => {
  const manager = ctx?.sessionManager;
  const file = typeof manager?.getSessionFile === 'function' ? manager.getSessionFile() : null;
  if (typeof file === 'string' && file) return file;
  const id = typeof manager?.getSessionId === 'function' ? manager.getSessionId() : null;
  if (typeof id === 'string' && id) return id;
  // A missing/empty native session identity is refused, never a shared constant:
  // a checkpoint or dispatch must be bound to the real owning SDK session.
  throw new Error('coordinator session identity is unavailable; refusing a checkpoint or dispatch without the native SDK session');
};

// Maps a workflow to its assigned checkout from a real dispatch receipt or an
// already bound checkpoint; a model-supplied checkout is never trusted.
const boundCheckout = (packagePath: string, workflowId: string, dispatches: Map<string, any>): string | null => {
  const bound = dispatches.get(workflowId);
  if (bound?.checkout) return bound.checkout;
  try {
    const record: any = readCheckpointRecord(canonicalPackage(packagePath).packagePath, workflowId);
    return record?.checkout ?? null;
  } catch { return null; }
};

// The durable assignment link the runtime writes at launch: assignment ID ->
// run ID. Used to resolve a declared working worker to its actual run.
function assignmentRunId(packagePath: string, assignmentId: string): string | null {
  try {
    const link: any = JSON.parse(readFileSync(join(packagePath, 'runtime', 'assignments',
      `${createHash('sha256').update(assignmentId).digest('hex')}.json`), 'utf8'));
    return typeof link?.run_id === 'string' && link.run_id ? link.run_id : null;
  } catch { return null; }
}

// A workflow conflicts with a new dispatch only through a genuinely active
// assignment: each declared working worker is resolved to its actual runtime
// run, and terminal runs free the workflow for its next assignment (successive
// steps reuse one workflow). An unreadable run cannot prove the writer exited,
// so it stays a conflict until a coordinator checkpoint reconciles it. A
// resume of the same assignment or of the ledger's own run is not a conflict.
function activeAssignmentConflict(packagePath: string, record: any, args: any): { id: string; state: string } | null {
  const candidateKey = typeof args?.assignment_id === 'string' && args.assignment_id ? args.assignment_id
    : args?.action === 'start' && typeof args?.step === 'string' && args.step ? realpathStep(args.step) : null;
  let ledgerRunId: string | null = null;
  if (args?.action !== 'start' && !args?.step) {
    try { const latest: any = loadRun(packagePath); ledgerRunId = typeof latest?.id === 'string' ? latest.id : null; } catch { ledgerRunId = null; }
  }
  for (const worker of record?.workers ?? []) {
    if (worker?.state !== 'working' || typeof worker?.id !== 'string' || !worker.id) continue;
    if (candidateKey && worker.id === candidateKey) continue;
    // A defaulted dispatch declares the run UUID itself, so the run record is
    // the fallback when no assignment link exists for the worker ID.
    const runId = assignmentRunId(packagePath, worker.id) ?? worker.id;
    if (ledgerRunId !== null && runId === ledgerRunId) continue;
    let state: string | null = null;
    try { state = summary(loadRun(packagePath, runId))?.state ?? null; } catch { state = null; }
    if (state === null || !['completed', 'failed', 'cancelled'].includes(state)) {
      return { id: worker.id, state: state ?? 'unresolved' };
    }
  }
  return null;
}

// The runtime keys an assignment by the realpath of its step card; mirror that
// normalization for same-assignment resume detection.
function realpathStep(step: string): string {
  try { return realpathSync(step); } catch { return step; }
}

export default function (pi: any) {
  const role = process.env.SPEC_RUNTIME_ROLE;
  if (role) {
    const record = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_RECORD!, 'utf8'));
    installProgressContext(pi, { record, role });
    const communication = createCommunication(pi, record, role, { onEvent: (name: string, detail: any) => runtimeEvent(record, name, detail) });
    const allowed = role === 'owner' ? ['read', 'grep', 'find', 'ls', 'spec_editor', 'spec_answer', 'spec_verify', 'spec_scout', 'spec_advice', 'spec_complete'] : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'spec_question'];
    pi.on('session_shutdown', () => communication.close());
    pi.on('session_start', (_event: any, ctx: any) => {
      // Apply the process guard only to an authenticated managed worker lease.
      if (!['owner', 'editor'].includes(role) || !record.id || !record.token) return;
      assertLease(record);
      try { assertModelSelector(record[`${role}_model`], ctx.model); }
      catch (error: any) {
        // Extension hook errors are caught by Pi. Exit this managed child before
        // an API request can use a fuzzy match or a restored session's model.
        process.stderr.write(`${error.message}\n`);
        process.exit(78);
      }
      pi.setActiveTools(allowed);
    });
    pi.on('tool_call', (event: any) => {
      try {
        assertLease(record);
        if (!allowed.includes(event.toolName)) return { block: true, reason: 'This tool is outside the managed worker role.' };
        if (['bash', 'spec_verify'].includes(event.toolName) && /\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b/.test(event.input.command)) return { block: true, reason: 'Hard resets are not allowed in a managed step. Return the recovery decision to the coordinator.' };
        if (event.toolName === 'spec_verify' && /\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b/.test(event.input.server?.command || '')) return { block: true, reason: 'Hard resets are not allowed in managed server commands.' };
      } catch (error: any) { return { block: true, reason: error.message }; }
    });
    if (role === 'owner') {
      pi.registerTool({ name: 'spec_complete', label: 'Record step handoff', description: 'After edits, focused checks and any commit, record the step outcome and material judgments. Runtime writes canonical learning, supplies HEAD and verification receipts, and refreshes progress/history. Does not accept independent review or certify evidence. Supply exactly the prepared step-owned EV IDs; use spec_verify receipt_id for observed checks, applicability for earlier/dirty revisions. External evidence requires command, observedCommit, applicability and artifact. Use checkpoint for unresolved required merge evidence. introduced lists reusable implementation code in checkout-relative paths; use [] for evidence helpers or package artifacts. Evidence paths accept canonical absolute, .specs repo-relative, or existing package-relative paths. Empty decisions/gaps/findings/introduced arrays are allowed; do not add process narration.',
        parameters: Type.Object({ outcome: Type.Union(['as-specified', 'adapted', 'checkpoint', 'no-artifact', 'decision-required', 'needs-spec-correction'].map(v => Type.Literal(v))),
          strategy: Type.Union([Type.Literal('test-first'), Type.Literal('implementation-first')]),
          fix_attempts: Type.Optional(Type.Number({ minimum: 0 })),
          decisions: Type.Array(Type.String()), gaps: Type.Array(Type.String()), findings: Type.Array(Type.String()),
          introduced: Type.Array(Type.Object({ symbol: Type.String(), path: Type.String(), purpose: Type.String() })),
          evidence: Type.Array(Type.Object({ id: Type.String(), status: Type.Union(['passed', 'failed', 'blocked', 'pending'].map(v => Type.Literal(v))), proof_boundary: Type.String(),
            receipt_id: optional('Observed spec_verify receipt ID'), artifact: optional('Existing artifact; defaults to prepared gate artifact'),
            applicability: optional('Why existing evidence applies without claiming a new execution'), command: optional('Exact command for owner-reported external evidence'), observedCommit: optional('Actual execution SHA for external evidence') })) }),
        async execute(_id: string, args: any) {
          try { return result(await runCompletion(record, args)); }
          catch (error: any) { return result({ error: error.message, next: 'Repair only the missing handoff information; do not repeat valid checks.' }, true); }
        } });

      pi.registerTool({ name: 'spec_advice', label: 'Jev advice', description: 'Batch Jev verification scheduling before expensive/repeated checks, or triage actionable review findings. Uses the assigned checkout after the editor returns. Supply the version 1 input from ~/.agents/scripts/jev/README.md: change_summary, policy, acceptance_criteria, mandatory_gates, focused_checks/planned_ci_checks, evidence or findings. No shell JSON construction or editor handoff needed. Advisory only; never waives acceptance or certifies passes. Reuse a still-applicable decision; do not call per edit or retry uncertain advice unchanged.',
        parameters: Type.Object({ task: Type.Union([Type.Literal('verification'), Type.Literal('review-triage')]), input: Type.Object({}, { additionalProperties: true }), offline: Type.Optional(Type.Boolean()) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { return result(await runAdvice(record, args.task, args.input, { offline: args.offline, signal })); }
          catch (error: any) { return result({ error: error.message, fallback: 'main_agent_judgment' }, true); }
        } });
      const scout = createScout(pi.events, { ownerRunId: record.id, cwd: record.checkout, model: record.scout_model || SCOUT_MODEL });
      pi.on('session_shutdown', () => scout.close());
      pi.registerTool({ name: 'spec_scout', label: 'Scout source', description: 'Use the installed scout profile to trace an unfamiliar failing path, find an existing integration pattern, or locate affected callers/guards. Supply one decision-relevant question, scoped paths and known evidence; ask for supporting snippets and the first unresolved boundary. No edits, checks or repair decisions. Direct reads are faster for a known small region; scouting is optional.',
        parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 6000 }) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try {
            assertLease(record);
            const reply: any = await scout.run(args.task, signal);
            const path = join(record.package, 'runtime/runs', `${record.id}-scout-${randomUUID()}.txt`);
            writeFileSync(path, reply.result, { mode: 0o600 });
            const truncated = reply.result.length > 8000;
            return result({ ...reply, result: truncated ? reply.result.slice(0, 7000) + `\n[Truncated: read ${path}; do not repeat scouting.]` : reply.result, result_truncated: truncated, full_result_path: path });
          } catch (error: any) { return result({ error: error.message, next: 'Use direct source reads or diagnose this scout failure; do not switch models.' }, true); }
        } });
      pi.registerTool({ name: 'spec_verify', label: 'Verify step', description: 'Owner runs a necessary focused check or diagnostic after the editor returns. Never edit source, commit, or run broad suites through this tool. Reuse valid evidence; do not check every packet automatically. Commands are bounded and cannot overlap editor work. Build/test artifacts and canonical evidence output are allowed. Pipelines preserve failures; raw output is retained, so omit tail/tee wrappers. For UI capture supply server {command, ready_url, readiness_timeout}: runtime starts it, waits, runs command, and cleans up before returning. Never start a server in a separate background call.',
        parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })), server: Type.Optional(Type.Object({ command: Type.String({ description: 'Foreground dev server command; no nohup or background ampersand. Runtime owns startup and cleanup.' }), ready_url: Type.String({ description: 'Loopback HTTP(S) readiness URL on an owned free port' }), readiness_timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })) })) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { const reply = await runVerification(record, args.command, args.timeout, signal, args.server); return result(reply, Boolean(reply.error) || reply.exit_code !== 0); }
          catch (error: any) { return result({ error: error.message, receipt_id: error.receipt_id }, true); }
        } });
      pi.registerTool({ name: 'spec_editor', label: 'Spec editor', description: 'Apply a bounded transformation whose behavior and architectural approach the owner has chosen; let the editor choose local implementation details. Send a Change/Edits/Preserve/Return packet with named symbols and concrete operations. The owner reads/searches source directly; reserve facts-only requests for a blocking fact unavailable through those tools. Return a compact result and artifact paths. The editor does not run verification; the owner uses spec_verify after the return. Do not delegate whole-step design or open-ended repair. Assess the return before the next assignment; commit is separate. No polling.',
        parameters: Type.Object({ assignment: Type.String() }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { const reply = await communication.beginEditor(() => runEditor(record, args.assignment, signal), signal); return result(reply, Boolean(reply.error)); }
          catch (error: any) { return result({ error: error.message, ...(signal?.aborted ? { requires_cancellation: true } : {}), next: 'resolve this failure; do not start an unmanaged replacement' }, true); }
        } });
      pi.registerTool({ name: 'spec_answer', label: 'Answer editor', description: 'Answer the retained editor\'s pending decision and await the same editor process. Do not start a replacement editor.',
        parameters: Type.Object({ request_id: Type.String(), answer: Type.String() }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { const reply = await communication.answer(args.request_id, args.answer, signal); return result(reply, Boolean(reply.error)); }
          catch (error: any) { return result({ error: error.message, ...(signal?.aborted ? { requires_cancellation: true } : {}), next: 'resolve the pending editor question without launching another writer' }, true); }
        } });
    } else {
      pi.registerTool({ name: 'spec_question', label: 'Ask step owner', description: 'Ask the current step owner one concrete implementation decision. Wait for its answer in this same editor process. Include relevant source excerpts or diagnostics; do not contact other sessions.',
        parameters: Type.Object({ question: Type.String() }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { return result(await communication.question(args.question, signal)); }
          catch (error: any) { return result({ error: error.message, next: 'return the unresolved decision to the owner; do not assume permission or launch another agent' }, true); }
        } });
      pi.registerTool({ name: 'bash', label: 'Managed bash', description: 'Run a bounded foreground editing, formatting or explicitly assigned commit command in the code checkout. Do not run tests, compile/build checks, lint or other verification; the owner runs those after your return. Do not leave background or detached processes alive after it returns. Large output is saved to the run log.',
        parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          const reply = await runCommand(record, args.command, args.timeout, signal);
          return result(reply, Boolean(reply.error) || reply.exit_code !== 0);
        } });
    }
    return;
  }
  const progress = installProgressContext(pi);
  const monitor = createMonitor();
  pi.registerTool({ name: 'spec_checkpoint', label: 'Record workflow decision', description: 'Record the current stage, next action and material decisions in the managed workflow ledger. Runtime records worker/check/review-arrival facts automatically; do not transcribe those. Complete is a coordinator assessment backed by artifact references, never inferred from worker exit. Known skill stage names are normalized (spec-run to implementation, spec-pr to publication). Complete implementation/publication requires finished workers and complete handoffs; use publication-draft for a draft checkpoint, never ready publication. Preserve human holds and unresolved obligations.',
    parameters: Type.Object({ package: Type.String(), stage: Type.String(), status: Type.Union(['pending', 'running', 'complete', 'blocked'].map(v => Type.Literal(v))), next: Type.String(), decisions: Type.Array(Type.String()), artifacts: Type.Array(Type.String({ description: 'Existing package-relative, .specs repo-relative, or canonical absolute artifact paths; future session/evidence paths are not evidence' })) }),
    async execute(_id: string, args: any) {
      try { const { packagePath } = canonicalPackage(args.package); await refreshProgress(packagePath); const receipt = recordCheckpoint(packagePath, args); progress.attach(packagePath); await refreshProgress(packagePath); return result(receipt); }
      catch (error: any) { return result({ error: error.message }, true); }
    } });
  // Session-local sentinel observation: read-only, and only for packages this
  // session explicitly dispatched plus discovered and optionally pinned primaries.
  const ownPackages: string[] = [];
  let sentinel: ReturnType<typeof createSentinelObserver> | undefined;
  let sentinelAuthority: ReturnType<typeof createSentinelAuthority> | null = null;
  let diagnosisController: ReturnType<typeof createDiagnosisController> | null = null;
  let sentinelScope: any = null;
  let pendingContinuation: any = null;
  let sessionCtx: any = null;
  // Session-local native-input guard and workflow->dispatch checkout bindings for
  // the coordinator branch. Interactive/RPC input advances the revision before
  // processing; extension-originated messages never do. Never model-supplied.
  let inputGuard = { input_revision: 0, active_prompts: 0 };
  const dispatchBindings = new Map<string, any>();
  // Revocation epoch for the sentinel authority: incremented synchronously at
  // every disable/off command entry and session reset, so an activation still
  // queued behind workflow work can never re-arm behind a revocation.
  let disableEpoch = 0;
  // spec_sentinel_checkpoint and spec_dispatch share checkpoint/mapping state; serialize
  // their tool execution so concurrent calls cannot interleave reads and writes.
  let workflowQueue: Promise<unknown> = Promise.resolve();
  const serializeWorkflow = <T>(task: () => Promise<T>): Promise<T> => {
    const run = workflowQueue.then(task, task);
    workflowQueue = run.then(() => undefined, () => undefined);
    return run;
  };
  pi.on('input', (event: any) => {
    // Only interactive/RPC input increments the revision before processing.
    if (event?.source === 'interactive' || event?.source === 'rpc') inputGuard = observeInput(inputGuard, { type: 'input', source: event.source });
  });
  pi.on('ui_prompt_start', () => { inputGuard = observeInput(inputGuard, { type: 'prompt_start' }); });
  pi.on('ui_prompt_end', () => { inputGuard = observeInput(inputGuard, { type: 'prompt_end' }); });
  // Coordinator-only checkpoint registration. Identity comes from the live
  // session manager and a checkout already bound by a prior checkpoint or a real
  // Runtime dispatch receipt; the model supplies neither. A runtime return is
  // reconciliation work, never acceptance. No recovery authority is granted.
  pi.registerTool({ name: 'spec_sentinel_checkpoint', label: 'Record sentinel workflow checkpoint',
    description: 'Coordinator-only: record the current workflow obligation and stop state against canonical sources. Supply the workflow_id registered for this coordinator, expected_revision from the previous receipt (0 for the first registration), the current state, obligation with prepared artifacts, declared workers and inbox outcomes, and reconciles_input_revision equal to the current native input revision. Identical stable obligation keys keep obligation_revision; changing source hashes alone does not. It never grants recovery authority.',
    parameters: Type.Object({
      package: Type.String({ description: 'Absolute canonical .specs feature directory or its spec.md in the primary checkout' }),
      workflow_id: Type.String({ minLength: 1, maxLength: 128, description: 'Registered workflow identity for this coordinator session' }),
      expected_revision: Type.Number({ minimum: 0, description: 'Revision from the previous checkpoint receipt; 0 for the first registration' }),
      state: Type.Union([Type.Literal('ready'), Type.Literal('waiting-worker'), Type.Literal('waiting-external'), Type.Literal('decision-required'), Type.Literal('blocked'), Type.Literal('user-held'), Type.Literal('complete'), Type.Literal('unknown')]),
      obligation: Type.Object({
        key: Type.String({ minLength: 1, maxLength: 160, description: 'Stable obligation key; identical keys keep obligation_revision' }),
        stage: Type.String({ minLength: 1 }),
        step: optional('Optional prepared step identity'),
        summary: Type.String({ minLength: 1, maxLength: 160 }),
        artifacts: Type.Array(Type.Object({ path: Type.String({ minLength: 1, description: 'Package-contained artifact path' }), sha256: Type.String({ minLength: 64, maxLength: 64, description: 'Exact sha256 of the prepared artifact' }) })),
      }),
      workers: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), kind: Type.String({ minLength: 1 }),
        state: Type.Union([Type.Literal('ready'), Type.Literal('working'), Type.Literal('waiting-external'), Type.Literal('decision-required'), Type.Literal('blocked'), Type.Literal('user-held'), Type.Literal('complete'), Type.Literal('failed'), Type.Literal('aborted'), Type.Literal('cancelled'), Type.Literal('unknown')]) }))),
      inbox: Type.Optional(Type.Object({ items: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 128 }), sha256: Type.String({ minLength: 64, maxLength: 64 }),
        outcome: Type.Union([Type.Literal('applied'), Type.Literal('not-applicable'), Type.Literal('held'), Type.Literal('decision-required'), Type.Literal('needs-spec-correction')]),
        release_source_id: optional('Required to release a held original: the later direction ID') })) })),
      reconciles_input_revision: Type.Number({ minimum: 0, description: 'Must equal the current native input revision' }),
    }),
    async execute(_id: string, args: any, _signal: AbortSignal, _update: any, ctx: any) {
      return serializeWorkflow(async () => {
      try {
        const coordinator_session = coordinatorIdentity(ctx);
        if (args.reconciles_input_revision !== inputGuard.input_revision) {
          return result({ error: `reconciles_input_revision ${args.reconciles_input_revision} does not match the current native input revision ${inputGuard.input_revision}`, next: 'record the checkpoint against the current input revision; a stale value is refused' }, true);
        }
        const checkout = boundCheckout(args.package, args.workflow_id, dispatchBindings);
        const receipt = recordSentinelCheckpoint({ package: args.package, workflow_id: args.workflow_id,
          expected_revision: args.expected_revision, state: args.state, obligation: args.obligation,
          workers: args.workers ?? [], inbox: args.inbox ?? {},
          reconciles_input_revision: args.reconciles_input_revision, coordinator_session, checkout });
        return result(receipt);
      } catch (error: any) { return result({ error: error.message, next: 'correct this checkpoint error; do not assume recovery authority' }, true); }
      });
    } });
  pi.registerCommand('spec-metrics', {
    description: 'Read-only timing, model/tool calls, test submissions and cost: /spec-metrics /absolute/canonical/package',
    handler: async (args: string, ctx: any) => {
      try {
        const packagePath = args.trim();
        if (!packagePath) { ctx.ui.notify('Usage: /spec-metrics /absolute/repo/.specs/feature', 'info'); return; }
        const value = await metrics(packagePath);
        ctx.ui.notify(formatMetrics(value), 'info');
      } catch (error: any) { ctx.ui.notify(`Metrics unavailable: ${error.message}`, 'error'); }
    },
  });
  pi.on('session_start', (_event: any, ctx: any) => {
    sentinel?.close();
    // One fresh, disarmed capability per coordinator session. Only the native
    // command handler can arm it; the authority object is never exposed and no
    // tool, load, checkpoint or file can arm it. Session reset clears the live
    // scope and any pending requested continuation before durable revocation.
    sentinelScope = null;
    pendingContinuation = null;
    sessionCtx = ctx;
    diagnosisController?.close();
    diagnosisController = null;
    const authority = createSentinelAuthority();
    sentinelAuthority = authority;
    sentinel = createSentinelObserver({ pi, context: ctx, agentDir: getAgentDir(), scope: process.env.PI_INTERCOM_SCOPE_ID ?? null, ownPackages,
      nativeRun: () => monitor.currentRun(),
      enablePolicy: (policyPath: string, commandCtx: any) => {
        // Captured at command entry, before queueing: a disable that arrives
        // while this activation waits behind workflow work must win.
        const arrivalEpoch = disableEpoch;
        return serializeWorkflow(async () => {
          // A session reset replaced the live capability: this late activation
          // may not arm or re-publish a grant for the retired one.
          if (sentinelAuthority !== authority) return { fenced: true };
          const receipt = await activatePolicy(authority, { policy_path: policyPath,
            coordinator_session: coordinatorIdentity(commandCtx), command: `/spec-sentinel enable ${policyPath}` });
          if (disableEpoch !== arrivalEpoch || sentinelAuthority !== authority) {
            // A disable arrived while this activation was queued: revoke again
            // so the activation cannot re-arm behind the revocation.
            disablePolicy(authority, { reason: 'disabled-during-activation' });
            return { ...receipt, fenced: true };
          }
          // Replace any prior controller only after the fence and a successful
          // activation, so a controller can never outlive or precede its grant.
          diagnosisController?.close();
          diagnosisController = createDiagnosisController({ authority, workflow_id: receipt.workflow_id, events: pi.events });
          // Store the validated scope only after a successful activation.
          sentinelScope = { package: receipt.package, workflow_id: receipt.workflow_id,
            coordinator_session: receipt.coordinator_session, mode: receipt.mode };
          return receipt;
        });
      },
      disablePolicy: () => {
        // AC-11: disable revokes the live authority before disk I/O. The
        // capability is disarmed synchronously at command entry, independent
        // of queued workflow work (a pending dispatch's awaits included); only
        // its own bounded persistence follows, still inside this call.
        disableEpoch += 1;
        sentinelScope = null;
        pendingContinuation = null;
        // Revocation cancels only the owned diagnosis before the authority is disarmed.
        diagnosisController?.close();
        diagnosisController = null;
        return disablePolicy(authority);
      } });
    monitor.close();
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const message = entries[i].message;
      if (message?.role !== 'toolResult' || message.toolName !== 'spec_dispatch') continue;
      const receipt = message.details;
      if (!receipt?.package || !receipt.run_id) continue;
      try { const record = loadRun(receipt.package, receipt.run_id); monitor.attach(record, ctx); progress.attach(record.package); } catch { /* Missing historical record. */ }
      break;
    }
  });
  pi.registerCommand('spec-monitor', {
    description: 'Observe a canonical spec package without taking ownership: /spec-monitor /repo/.specs/feature; /spec-monitor off hides it.',
    handler: async (args: string, ctx: any) => {
      const path = args.trim();
      if (path === 'off' || path === 'hide') { monitor.close(); return; }
      try { monitor.attach(loadRun(path), ctx); }
      catch { ctx.ui.notify('Cannot open that package runtime receipt. Use /spec-monitor /absolute/repo/.specs/feature', 'error'); }
    },
  });
  const verificationRecorder = createVerificationRecorder();
  const runtime = new Runtime({ notify: (value: any) => {
    // On a mapped terminal runtime notification, reconcile the checkpoint before
    // sending the existing native completion message. A runtime return is
    // reconciliation work, never acceptance; any reconcile error is reported
    // without suppressing the runtime completion message.
    try {
      const v: any = value;
      let mapped = v?.package && v?.run_id ? dispatchBindings.get(`${v.package}\u0000${v.run_id}`) : null;
      const notificationWorkflow = typeof v?.workflow_id === 'string' && v.workflow_id ? v.workflow_id : null;
      if (!mapped && notificationWorkflow && v?.package) {
        // Persisted notification identity fallback: read the checkpoint for its
        // owning coordinator and bound checkout rather than trusting the notification.
        try {
          const persisted: any = readCheckpointRecord(v.package, notificationWorkflow);
          if (persisted) {
            mapped = { package: v.package, run_id: v.run_id, workflow_id: notificationWorkflow,
              assignment_id: typeof v.assignment_id === 'string' && v.assignment_id ? v.assignment_id : null,
              checkout: persisted.checkout ?? null, coordinator_session: persisted.coordinator_session };
          }
        } catch { /* Unreadable checkpoint stays unmapped; the completion message still sends. */ }
      }
      if (mapped?.workflow_id && ['completed', 'failed', 'cancelled', 'blocked'].includes(v?.state)) {
        try {
          const record: any = readCheckpointRecord(mapped.package, mapped.workflow_id);
          reconcileRuntimeReturn({
            package: mapped.package,
            workflow_id: mapped.workflow_id,
            expected_revision: record?.revision ?? 0,
            assignment_id: mapped.assignment_id ?? mapped.run_id,
            return_state: v.state,
            workers: record?.workers ?? [],
            // The live input revision is deliberately not passed: only a successful
            // spec_sentinel_checkpoint acknowledges native input, so reconciliation preserves
            // the checkpoint's stored input_revision.
            coordinator_session: mapped.coordinator_session,
            checkout: mapped.checkout,
          });
        } catch (reconcileError: any) {
          pi.sendMessage({ customType: 'spec-runtime', content: JSON.stringify({ reconcile_error: reconcileError?.message ?? String(reconcileError), workflow_id: mapped.workflow_id }), display: true }, { triggerTurn: false });
        }
      }
    } catch { /* Never suppress the runtime completion message. */ }
    pi.sendMessage({ customType: 'spec-runtime', content: JSON.stringify(value), display: true }, { triggerTurn: true });
  },
    onWorkerEvent: (record: any, event: any) => {
      // Incident observation never affects run lifecycle: diagnosis is
      // fire-and-forget and any failure is contained. An applied
      // cancel-candidate offers guarded cancellation through the same serialized
      // workflow path and the exact live identities.
      const observed = verificationRecorder.observe(record, event);
      if (!observed?.incident || !diagnosisController || !sentinelAuthority || !sentinelScope) return;
      const authority = sentinelAuthority;
      const scope = sentinelScope;
      const controller = diagnosisController;
      const incident = observed.incident;
      controller.diagnose(record, incident).then((attempt: any) => {
        if (!attempt || attempt.launched !== true || attempt.state !== 'applied' || attempt.decision !== 'cancel-candidate') return;
        return serializeWorkflow(async () => {
          if (sentinelAuthority !== authority || sentinelScope !== scope || diagnosisController !== controller) return;
          const result = await considerCancellation({
            authority, record, incident, packet_sha256: attempt.packet_sha256,
            adapter: (target: any) => runtime.cancel(target.package, target.id),
            idleWriter: assertIdleWriter,
            activeHandle: (target: any) => runtime.active.get(target.id) ?? null,
            inputGuard: () => inputGuard,
            now: Date.now,
          });
          // Surface only accepted shadow/applied/unknown transitions; duplicates
          // and guard abstentions stay silent.
          if (result.state === 'applied') {
            try { runtime.notify(summary(loadRun(record.package, record.id))); } catch { /* Notification is best effort. */ }
            try { sessionCtx?.ui?.notify(`Sentinel cancelled diagnosed work for ${scope.workflow_id}.`, 'warning'); } catch { /* UI failure contained. */ }
          } else if (result.state === 'shadow') {
            try { sessionCtx?.ui?.notify(`Sentinel shadow would-cancel diagnosed work for ${scope.workflow_id}; the worker stays alive.`, 'info'); } catch { /* UI failure contained. */ }
          } else if (result.state === 'unknown') {
            try { sessionCtx?.ui?.notify(`Sentinel cancellation outcome unknown for ${scope.workflow_id}; the writer lease is retained.`, 'warning'); } catch { /* UI failure contained. */ }
          }
        });
      }).catch(() => { /* Diagnosis/cancellation failure never affects the lifecycle. */ });
    } });
  // Bounded continuation: only a live armed authority with an exact scope is
  // consulted, through the shared workflow serialization. A requested identity is
  // held only until the immediately accepted continuation turn starts or the
  // session settles without it (delivery only, never acceptance).
  pi.on('agent_before_settle', (event: any) => {
    if (!sentinelAuthority || !sentinelScope) return undefined;
    const authority = sentinelAuthority;
    const scope = sentinelScope;
    return serializeWorkflow(async () => {
      if (sentinelAuthority !== authority || sentinelScope !== scope) return undefined;
      return handleBeforeSettle(event, { authority, workflow_id: scope.workflow_id,
        package: scope.package, coordinator_session: scope.coordinator_session,
        inputGuard: () => inputGuard, activeManaged: () => runtime.active.size > 0,
        onRequested: (intent: any) => {
          pendingContinuation = { workflow_id: scope.workflow_id, intent_id: typeof intent?.id === 'string' ? intent.id : null };
        } });
    });
  });
  pi.on('agent_start', () => {
    if (!pendingContinuation || !sentinelAuthority || !sentinelScope) return undefined;
    const authority = sentinelAuthority;
    const scope = sentinelScope;
    const pending = pendingContinuation;
    pendingContinuation = null;
    // This agent_start follows the reservation with no intervening settlement,
    // so it is the immediately accepted continuation turn the SDK started for
    // that exact intent — never an arbitrary later turn. Return the promise so
    // Pi awaits the requested->applied delivery record before the turn
    // proceeds; never retry on failure.
    return serializeWorkflow(async () => {
      if (sentinelAuthority !== authority || sentinelScope !== scope || !pending.intent_id) return;
      try {
        finishIntent(authority, { workflow_id: pending.workflow_id, intent_id: pending.intent_id,
          state: 'applied', reason_code: 'delivered' });
      } catch { /* Delivery observation only; never retry or refill capacity. */ }
    });
  });
  // A session that settles while a requested continuation is still pending was
  // never delivered: the boundary result was aborted after this handler
  // reserved, or a later boundary handler vetoed the draft. Retire the request
  // without delivery — the consumed slot stays spent and the explicitly unknown
  // outcome blocks automatic retry until an authorized reconciliation (AC-11),
  // instead of letting an unrelated later turn mint a false delivery receipt.
  pi.on('agent_settled', () => {
    if (!pendingContinuation || !sentinelAuthority || !sentinelScope) return undefined;
    const authority = sentinelAuthority;
    const scope = sentinelScope;
    const pending = pendingContinuation;
    pendingContinuation = null;
    return serializeWorkflow(async () => {
      if (sentinelAuthority !== authority || sentinelScope !== scope || !pending.intent_id) return;
      try {
        finishIntent(authority, { workflow_id: pending.workflow_id, intent_id: pending.intent_id,
          state: 'unknown', reason_code: 'undelivered' });
      } catch { /* Retirement observation only; the retained request stays spent and blocking. */ }
    });
  });
  pi.on('session_shutdown', async () => {
    monitor.close();
    await sentinel?.close();
    sentinel = undefined;
    sessionCtx = null;
    diagnosisController?.close();
    diagnosisController = null;
    await Promise.allSettled([...runtime.active.values()].map(({ record }: any) => runtime.cancel(record.package, record.id)));
  });
  pi.registerTool({ name: 'spec_dispatch', label: 'Spec step runtime', description: 'Use startup to enter a prepared package in one call: first-step selection, recorded difficulty routing, checkout/lease setup and dispatch; existing progress returns a resume obligation without replay. Start launches an explicit prepared spec step with an owner and retained editor. Creates/reuses the checkout, holds its exclusive writer lease, and delivers a completion event. Repeated assignment IDs are idempotent. Status is for explicit recovery, never polling. Cancellation returns only after confirmed process-group termination.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('startup'), Type.Literal('start'), Type.Literal('status'), Type.Literal('cancel')]), package: Type.String({ description: 'Absolute canonical .specs feature directory or its spec.md in the primary checkout' }),
      strong_owner_model: optional('Optional STRONG_OWNER; startup routes prepared hard steps here'), owner_override: optional('Explicit owner for the selected step; takes precedence over owner_model in start and startup, including tier routing'),
      step: optional('Absolute canonical prepared subspec path; required for start'), owner_model: optional('provider/model[:thinking]; required unless owner_override is supplied'), editor_model: optional('provider/model[:thinking]; required for start'), scout_model: optional('SCOUT_AGENT selector as provider/model[:thinking]; default openai-codex/gpt-6-luna:low'),
      checkout: optional('Existing checkout or desired new worktree path'), branch: optional('Requested worktree branch'), base: optional('Start ref for a new branch, default HEAD'),
      assignment_id: optional('Stable ID for this step attempt. Omit to use step path. Use a new ID only for an intentional subsequent attempt.'), run_id: optional('Existing run ID, otherwise latest'), workflow_id: optional('Registered workflow ID from a prior spec_sentinel_checkpoint; binds this real dispatch to its checkpoint'),
      instructions: optional('Scoped task direction, acceptance constraints and publication authority'), timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: 86400000, description: 'Whole assignment deadline, default 7200000 (2 hours)' })), child_extensions: Type.Optional(Type.Array(Type.String({ description: 'Explicit trusted pi-intercom and provider/compat extension paths; discovery is disabled in managed children' }))) }),
    async execute(_id: string, args: any, _signal: AbortSignal, _update: any, ctx: any) {
      return serializeWorkflow(async () => {
      try {
        const { packagePath } = canonicalPackage(args.package); progress.attach(packagePath);
        if (args.action === 'status') { const record = loadRun(args.package, args.run_id); monitor.attach(record, ctx); return result(summary(record)); }
        if (args.action === 'cancel') return result(await runtime.cancel(args.package, args.run_id));
        // A supplied workflow_id is a registered mapping key, validated before any
        // dispatch side effect. Dispatch never mints workflow ownership: a missing,
        // malformed, differently-owned or checkout-conflicting checkpoint is refused
        // before runtime.start/startup can launch or resume work.
        const workflowId = typeof args.workflow_id === 'string' && args.workflow_id ? args.workflow_id : null;
        let registeredWorkflow: any = null;
        if (workflowId) {
          registeredWorkflow = readCheckpointRecord(canonicalPackage(args.package).packagePath, workflowId);
          if (!registeredWorkflow) {
            return result({ error: `workflow ${workflowId} has no registered checkpoint; spec_dispatch never mints workflow ownership`, next: 'register the workflow with spec_sentinel_checkpoint first' }, true);
          }
          if (registeredWorkflow.coordinator_session !== coordinatorIdentity(ctx)) {
            return result({ error: `workflow ${workflowId} is owned by another coordinator session; refusing an unowned mapping`, next: 'do not overwrite workflow ownership' }, true);
          }
          if (registeredWorkflow.checkout && args.checkout && resolve(args.checkout) !== resolve(registeredWorkflow.checkout)) {
            return result({ error: `workflow ${workflowId} is bound to checkout ${registeredWorkflow.checkout}; refusing a different requested checkout`, next: 'omit checkout to reuse the registered one or use a new workflow_id' }, true);
          }
          if ((registeredWorkflow.input_revision ?? 0) !== inputGuard.input_revision) {
            return result({ error: `workflow ${workflowId} has unreconciled native input: checkpoint revision ${registeredWorkflow.input_revision ?? 0} does not match the current native input revision ${inputGuard.input_revision}`, next: 'record a successful spec_sentinel_checkpoint for the current input revision before dispatch' }, true);
          }
          if (typeof args.assignment_id === 'string' && !/^[A-Za-z0-9_-]{1,128}$/.test(args.assignment_id)) {
            return result({ error: 'assignment_id must be 1-128 ASCII letters/digits/underscore/hyphen; the checkpoint worker identity validates it', next: 'supply a valid stable attempt ID or omit it to use the run identity' }, true);
          }
          // A genuinely active assignment under this workflow conflicts with a
          // new dispatch. Validated from durable state BEFORE launch so no
          // lease, run record or process precedes a refusal; terminal
          // assignments free the workflow for its next assignment while the
          // per-run notification mappings stay retained.
          const conflict = activeAssignmentConflict(canonicalPackage(args.package).packagePath, registeredWorkflow, args);
          if (conflict) {
            return result({ error: `workflow ${workflowId} still has active assignment ${conflict.id} (run state ${conflict.state}); refusing a concurrent dispatch`, next: 'await its completion or confirmed cancellation, or reconcile the assignment with spec_sentinel_checkpoint before dispatching the next one' }, true);
          }
        }
        const configFile = join(homedir(), '.pi/agent/spec-runtime.json');
        const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
        const input = { ...args, scout_model: args.scout_model ?? config.scout_model ?? SCOUT_MODEL, child_extensions: args.child_extensions ?? config.child_extensions ?? [],
          ...(workflowId && !args.checkout && registeredWorkflow?.checkout ? { checkout: registeredWorkflow.checkout } : {}) };
        const receipt = args.action === 'startup' ? await runtime.startup(input, ctx.sessionManager.getSessionFile()) : runtime.start(input, ctx.sessionManager.getSessionFile());
        if (receipt.run_id) monitor.attach(loadRun(args.package, receipt.run_id), ctx);
        if (receipt.run_id && !ownPackages.includes(args.package)) ownPackages.push(args.package);
        // The actual receipt binds its run/checkout to the workflow validated above
        // and is retained so the terminal notification reconciles to
        // `reconcile:<assignment-id>`. Dispatch never mints workflow ownership.
        // Successive assignments under one workflow replace the workflow-level
        // binding while every per-run mapping is retained for its own terminal
        // notification; only a genuinely active assignment was refused above.
        if (workflowId && receipt.run_id) {
          const coordinator_session = coordinatorIdentity(ctx);
          const packagePath = canonicalPackage(args.package).packagePath;
          const existing: any = readCheckpointRecord(packagePath, workflowId);
          if (!existing) {
            return result({ error: `workflow ${workflowId} has no registered checkpoint; spec_dispatch never mints workflow ownership`, next: 'register the workflow with spec_sentinel_checkpoint first' }, true);
          }
          if (existing.coordinator_session !== coordinator_session) {
            return result({ error: `workflow ${workflowId} is owned by another coordinator session; refusing an unowned mapping`, next: 'do not overwrite workflow ownership' }, true);
          }
          // A defaulted runtime assignment key is the absolute prepared card
          // path, which cannot be a checkpoint worker identity. The declared
          // worker is the caller's explicit attempt ID or the real run UUID;
          // the runtime assignment key stays in the receipt untouched.
          const assignmentId = args.assignment_id ?? receipt.run_id;
          const boundCheckoutValue = receipt.checkout ?? existing.checkout ?? null;
          const alreadyBound = existing.checkout === boundCheckoutValue
            && (existing.workers ?? []).some((worker: any) => worker.id === assignmentId
              && ['working', 'complete', 'failed', 'cancelled'].includes(worker.state));
          let revision = existing.revision;
          const workers = [...(existing.workers ?? [])].filter((worker: any) => worker.id !== assignmentId)
            .concat([{ id: assignmentId, kind: 'owner', state: 'working' }]);
          if (!alreadyBound) {
            const updated = recordSentinelCheckpoint({ package: packagePath, workflow_id: workflowId,
              expected_revision: existing.revision, state: 'waiting-worker', obligation: existing.obligation,
              workers, inbox: existing.inbox ?? { items: [] },
              reconciles_input_revision: existing.input_revision ?? 0, coordinator_session, checkout: boundCheckoutValue });
            revision = updated.revision;
          }
          // A terminal receipt (a startup resume or idempotent start of an
          // already finished run) never emits another completion notification:
          // reconcile it now through the production reducer instead of
          // declaring an exited worker active.
          if (['completed', 'failed', 'cancelled'].includes(receipt.state)) {
            const reconciled = reconcileRuntimeReturn({ package: packagePath, workflow_id: workflowId,
              expected_revision: revision, assignment_id: assignmentId, return_state: receipt.state,
              workers, coordinator_session, checkout: boundCheckoutValue });
            revision = reconciled.revision;
          }
          const binding = { package: packagePath, run_id: receipt.run_id, workflow_id: workflowId,
            assignment_id: assignmentId, checkout: boundCheckoutValue, coordinator_session };
          dispatchBindings.set(`${packagePath}\u0000${receipt.run_id}`, binding);
          dispatchBindings.set(workflowId, binding);
          receipt.workflow_id = workflowId;
          receipt.checkpoint_revision = revision;
        }
        return result(receipt);
      } catch (error: any) { return result({ error: error.message, next: 'correct this specific runtime error; do not probe unrelated models or launch another writer' }, true); }
      });
    } });
}
