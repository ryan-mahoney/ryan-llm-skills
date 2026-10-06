import { Type } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Runtime, loadRun, summary, assertLease, runEditor, runCommand, runVerification, runAdvice, runCompletion, canonicalPackage, event as runtimeEvent } from './runtime.mjs';
import { createCommunication } from './communication.mjs';
import { createMonitor } from './monitor.mjs';
import { createSentinelObserver, createVerificationRecorder, recordCheckpoint, readInboxGuard, readCheckpointRecord, observeInput, reconcileRuntimeReturn, checkpointPath } from './sentinel.mjs';
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

export default function (pi: any) {
  const role = process.env.SPEC_RUNTIME_ROLE;
  if (role) {
    const record = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_RECORD!, 'utf8'));
    installProgressContext(pi, { record, role });
    const communication = createCommunication(pi, record, role, { onEvent: (name: string, detail: any) => runtimeEvent(record, name, detail) });
    const allowed = role === 'owner' ? ['read', 'grep', 'find', 'ls', 'spec_editor', 'spec_answer', 'spec_verify', 'spec_scout', 'spec_advice', 'spec_complete'] : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'spec_question'];
    pi.on('session_shutdown', () => communication.close());
    pi.on('session_start', () => pi.setActiveTools(allowed));
    pi.on('tool_call', (event: any) => {
      try {
        assertLease(record);
        if (!allowed.includes(event.toolName)) return { block: true, reason: 'This tool is outside the managed worker role.' };
        if (['bash', 'spec_verify'].includes(event.toolName) && /\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b/.test(event.input.command)) return { block: true, reason: 'Hard resets are not allowed in a managed step. Return the recovery decision to the coordinator.' };
        if (event.toolName === 'spec_verify' && /\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b/.test(event.input.server?.command || '')) return { block: true, reason: 'Hard resets are not allowed in managed server commands.' };
      } catch (error: any) { return { block: true, reason: error.message }; }
    });
    if (role === 'owner') {
      pi.registerTool({ name: 'spec_complete', label: 'Record step handoff', description: 'After edits, focused checks and any commit, record the step outcome and material judgments. Runtime writes canonical learning, supplies HEAD and verification receipts, and refreshes progress/history. Does not accept independent review or certify evidence. Supply exactly the prepared step-owned EV IDs; use spec_verify receipt_id for observed checks, applicability for earlier/dirty revisions. External evidence requires command, observedCommit, applicability and artifact. Use checkpoint for unresolved required merge evidence. Empty decisions/gaps/findings/introduced arrays are allowed; do not add process narration.',
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
  pi.registerTool({ name: 'spec_checkpoint', label: 'Record workflow decision', description: 'Record the current stage, next action and material decisions in the managed workflow ledger. Runtime records worker/check/review-arrival facts automatically; do not transcribe those. Complete is a coordinator assessment backed by artifact references, never inferred from worker exit. Preserve human holds and unresolved obligations.',
    parameters: Type.Object({ package: Type.String(), stage: Type.String(), status: Type.Union(['pending', 'running', 'complete', 'blocked'].map(v => Type.Literal(v))), next: Type.String(), decisions: Type.Array(Type.String()), artifacts: Type.Array(Type.String({ description: 'Canonical package-relative evidence/decision artifact paths' })) }),
    async execute(_id: string, args: any) {
      try { const { packagePath } = canonicalPackage(args.package); await refreshProgress(packagePath); const receipt = recordCheckpoint(packagePath, args); progress.attach(packagePath); await refreshProgress(packagePath); return result(receipt); }
      catch (error: any) { return result({ error: error.message }, true); }
    } });
  // Session-local sentinel observation: read-only, and only for packages this
  // session explicitly dispatched plus explicitly enrolled primaries.
  const ownPackages: string[] = [];
  let sentinel: ReturnType<typeof createSentinelObserver> | undefined;
  // Session-local native-input guard and workflow->dispatch checkout bindings for
  // the coordinator branch. Interactive/RPC input advances the revision before
  // processing; extension-originated messages never do. Never model-supplied.
  let inputGuard = { input_revision: 0, active_prompts: 0 };
  const dispatchBindings = new Map<string, any>();
  // spec_checkpoint and spec_dispatch share checkpoint/mapping state; serialize
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
        const receipt = recordCheckpoint({ package: args.package, workflow_id: args.workflow_id,
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
    sentinel = createSentinelObserver({ pi, context: ctx, agentDir: getAgentDir(), scope: process.env.PI_INTERCOM_SCOPE_ID ?? null, ownPackages,
      nativeRun: () => monitor.currentRun() });
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
            // spec_checkpoint acknowledges native input, so reconciliation preserves
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
    onWorkerEvent: (record: any, event: any) => verificationRecorder.observe(record, event) });
  pi.on('session_shutdown', async () => {
    monitor.close();
    sentinel?.close();
    sentinel = undefined;
    await Promise.allSettled([...runtime.active.values()].map(({ record }: any) => runtime.cancel(record.package, record.id)));
  });
  pi.registerTool({ name: 'spec_dispatch', label: 'Spec step runtime', description: 'Use startup to enter a prepared package in one call: first-step selection, recorded difficulty routing, checkout/lease setup and dispatch; existing progress returns a resume obligation without replay. Start launches an explicit prepared spec step with an owner and retained editor. Creates/reuses the checkout, holds its exclusive writer lease, and delivers a completion event. Repeated assignment IDs are idempotent. Status is for explicit recovery, never polling. Cancellation returns only after confirmed process-group termination.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('startup'), Type.Literal('start'), Type.Literal('status'), Type.Literal('cancel')]), package: Type.String({ description: 'Absolute canonical .specs feature directory or its spec.md in the primary checkout' }),
      strong_owner_model: optional('Optional STRONG_OWNER; startup routes prepared hard steps here'), owner_override: optional('Explicit owner for the selected step; takes precedence over owner_model in start and startup, including tier routing'),
      step: optional('Absolute canonical prepared subspec path; required for start'), owner_model: optional('provider/model[:thinking]; required unless owner_override is supplied'), editor_model: optional('provider/model[:thinking]; required for start'), scout_model: optional('SCOUT_AGENT selector as provider/model[:thinking]; default openai-codex/gpt-6-luna:low'),
      checkout: optional('Existing checkout or desired new worktree path'), branch: optional('Requested worktree branch'), base: optional('Start ref for a new branch, default HEAD'),
      assignment_id: optional('Stable ID for this step attempt. Omit to use step path. Use a new ID only for an intentional subsequent attempt.'), run_id: optional('Existing run ID, otherwise latest'), workflow_id: optional('Registered workflow ID from a prior spec_checkpoint; binds this real dispatch to its checkpoint'),
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
            return result({ error: `workflow ${workflowId} has no registered checkpoint; spec_dispatch never mints workflow ownership`, next: 'register the workflow with spec_checkpoint first' }, true);
          }
          if (registeredWorkflow.coordinator_session !== coordinatorIdentity(ctx)) {
            return result({ error: `workflow ${workflowId} is owned by another coordinator session; refusing an unowned mapping`, next: 'do not overwrite workflow ownership' }, true);
          }
          if (registeredWorkflow.checkout && args.checkout && resolve(args.checkout) !== resolve(registeredWorkflow.checkout)) {
            return result({ error: `workflow ${workflowId} is bound to checkout ${registeredWorkflow.checkout}; refusing a different requested checkout`, next: 'omit checkout to reuse the registered one or use a new workflow_id' }, true);
          }
          if ((registeredWorkflow.input_revision ?? 0) !== inputGuard.input_revision) {
            return result({ error: `workflow ${workflowId} has unreconciled native input: checkpoint revision ${registeredWorkflow.input_revision ?? 0} does not match the current native input revision ${inputGuard.input_revision}`, next: 'record a successful spec_checkpoint for the current input revision before dispatch' }, true);
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
        if (workflowId && receipt.run_id) {
          const coordinator_session = coordinatorIdentity(ctx);
          const packagePath = canonicalPackage(args.package).packagePath;
          const existing: any = readCheckpointRecord(packagePath, workflowId);
          if (!existing) {
            return result({ error: `workflow ${workflowId} has no registered checkpoint; spec_dispatch never mints workflow ownership`, next: 'register the workflow with spec_checkpoint first' }, true);
          }
          if (existing.coordinator_session !== coordinator_session) {
            return result({ error: `workflow ${workflowId} is owned by another coordinator session; refusing an unowned mapping`, next: 'do not overwrite workflow ownership' }, true);
          }
          const assignmentId = args.assignment_id ?? receipt.assignment_id ?? receipt.run_id;
          const prior = dispatchBindings.get(workflowId);
          if (prior && (prior.run_id !== receipt.run_id || prior.assignment_id !== assignmentId)) {
            return result({ error: `workflow ${workflowId} is already mapped to a different dispatch; refusing a conflicting mapping`, next: 'reuse the registered assignment or register a new workflow_id' }, true);
          }
          const boundCheckoutValue = receipt.checkout ?? existing.checkout ?? null;
          const alreadyBound = existing.checkout === boundCheckoutValue
            && (existing.workers ?? []).some((worker: any) => worker.id === assignmentId && worker.state === 'working');
          let revision = existing.revision;
          if (!alreadyBound) {
            const workers = [...(existing.workers ?? [])].filter((worker: any) => worker.id !== assignmentId)
              .concat([{ id: assignmentId, kind: 'owner', state: 'working' }]);
            const updated = recordCheckpoint({ package: packagePath, workflow_id: workflowId,
              expected_revision: existing.revision, state: 'waiting-worker', obligation: existing.obligation,
              workers, inbox: existing.inbox ?? { items: [] },
              reconciles_input_revision: existing.input_revision ?? 0, coordinator_session, checkout: boundCheckoutValue });
            revision = updated.revision;
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
