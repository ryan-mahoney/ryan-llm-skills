import { mkdirSync, rmSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compile } from '../../../scripts/changeset/engine.mjs';
import { Workspace, hash, diskPath } from '../../../scripts/changeset/workspace.mjs';
import { dispatchChangeset, validateDispatchPlan } from '../../../scripts/changeset/dispatch.mjs';
import { focusedPacketRules } from '../../../scripts/changeset/focused-editors.mjs';
import { createEditTrace, writeArtifact } from '../../../scripts/changeset/telemetry.mjs';
import { modelRuntime, parseJson, parseSelector } from '../../../scripts/changeset/models.mjs';
import { ModelJsonParseError } from '../../../scripts/changeset/errors.mjs';

export const CHANGESET_ROUTE = 'changeset-v1';
export const plannerPrompt = `Plan a bounded code change. Read the canonical step/stage and current source yourself.
Keep the requesting owner's settled behavior and scope. You plan writes, not verification or review.
Return only JSON {"schema_version":1,"operations":[...]}.
Each operation has id, executor (simple or involved), reads, writes, depends_on, objective, instruction, requirements, context.
Do not emit code edits or invoke a writer. No implementation brief or separate query planner is required.
${focusedPacketRules}
For an existing formatter or source generator, use executor "generated", reads/writes/depends_on/instruction,
and generator:{argv:[executable,...arguments]}. Declare every source input, script, configuration, and output.
The runtime copies declared source to isolated staging and publishes only declared outputs.
Never embed implementation code in command arguments. Generated operations may own several output files.
Use existing repository commands; scripts and configurations must be declared reads. Model writing stays simple/involved.`;

export function editIdentity(record, id) {
  return { edit_id: id, run_id: record.id, workflow_id: record.workflow_id ?? null,
    assignment_id: record.assignment_id ?? null,
    package_ref: record.package_ref ?? null, target: record.target ?? null,
    wave_id: record.wave_bindings?.wave_id ?? null, step: record.step ?? null,
    generation: record.wave_bindings?.generation ?? null, wave_attempt_id: record.wave_bindings?.attempt_id ?? null,
    stage: record.stage?.role ?? 'implementation', attempt_kind: record.attempt_kind ?? null,
    stage_kind: record.stage?.kind ?? record.stage?.role ?? 'implementation',
    stage_label: record.stage?.label ?? null, review_round: record.stage?.round ?? null,
    owner_model: record.owner_model, planner_model: record.planner_model, editor_model: record.editor_model,
    runtime_revision: record.revisions?.runtime ?? null };
}

// No tools are supplied to completeSimple. Model output is data until the engine
// validates and stages it. Keep full payloads private, outside the shared event log.
export async function writerClient(selector, { trace, signal, runtime, maxCalls = 400, counter = { calls: 0 } }) {
  runtime ??= await modelRuntime();
  const selected = parseSelector(selector), model = runtime.getModel(selected.provider, selected.id);
  if (!model || model.id !== selected.id || model.provider !== selected.provider || !runtime.hasConfiguredAuth(selected.provider))
    throw new Error(`Configured writer unavailable: ${selector}`);
  const client = { selector, calls: 0, signal };
  const request = async (format, systemPrompt, payload, stage, metadata) => {
    signal?.throwIfAborted();
    if (++counter.calls > maxCalls) throw new Error('Changeset model-call limit exceeded');
    client.calls++;
    const callId = randomUUID(), began = performance.now();
    const call = { call_id: callId, selector, stage, ...metadata, format, status: 'running', usage: null };
    trace.calls.push(call);
    trace.artifact(`call-${callId}-request.json`, { systemPrompt, payload });
    trace.emit('writer_request_started', { call_id: callId, selector, stage, ...metadata, format,
      input_bytes: Buffer.byteLength(systemPrompt + JSON.stringify(payload)) });
    let response;
    try {
      response = await runtime.completeSimple(model, { systemPrompt, messages: [{ role: 'user', content: JSON.stringify(payload), timestamp: Date.now() }] }, {
        reasoning: selected.reasoning === 'off' ? undefined : selected.reasoning,
        maxTokens: Math.min(model.maxTokens ?? 32000, 32000), maxRetries: 0, timeoutMs: 120000,
        signal: AbortSignal.any([AbortSignal.timeout(120000), ...[signal].filter(Boolean)]) });
      signal?.throwIfAborted();
      trace.artifact(`call-${callId}-response.json`, response);
      call.usage = response.usage ?? null; call.stop_reason = response.stopReason ?? null;
      if (response.stopReason !== 'stop') throw new Error(`Writer stopped: ${response.stopReason}: ${response.errorMessage ?? ''}`);
      const text = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      let result = text;
      if (format === 'json') {
        try { result = parseJson(text); } catch (error) { throw new ModelJsonParseError(error, text); }
      }
      call.status = 'completed'; return result;
    } catch (error) {
      call.status = signal?.aborted ? 'cancelled' : 'failed';
      call.error = error.message; call.usage ??= response?.usage ?? null;
      throw error;
    } finally {
      call.elapsed_ms = performance.now() - began;
      trace.artifact(`call-${callId}.json`, call);
      trace.emit('writer_request_finished', { ...call, error: call.error ? 'See private call receipt' : undefined });
    }
  };
  client.text = (system, payload, stage, metadata) => request('text', system, payload, stage, metadata);
  client.json = (system, payload, stage, metadata) => request('json', system, payload, stage, metadata);
  return client;
}

export async function runManagedChangeset(record, assignment, signal, {
  assertActive, plan, submittedPlan, submittedModel, paths, onEvent, createClient = writerClient, parse, generate,
} = {}) {
  assertActive();
  if (!record.planner_model || record.planner_model !== record.strong_owner_model)
    throw new Error('A configured STRONG_OWNER binding is required for write planning');
  if (submittedPlan && submittedModel !== record.planner_model)
    throw new Error('Only the bound strong-owner session can submit a plan');
  if (!submittedPlan && (typeof assignment !== 'string' || !assignment.trim() || assignment.length > 24000))
    throw new Error('Supply a bounded change request or a strong-owner plan');
  const slot = diskPath(record.package, `runtime/runs/${record.id}-editor-slot`);
  try { mkdirSync(slot); } catch { throw new Error('An edit or verification operation already holds the writer slot'); }
  const id = randomUUID(), directory = join(record.package, 'runtime/runs', `${record.id}-edits`, id);
  let trace, published = false, phase = 'planning', planningBegan;
  try {
    trace = createEditTrace({ directory, root: record.package, identity: editIdentity(record, id), onEvent });
    trace.artifact('request.json', { assignment: assignment ?? null, paths: paths ?? null, submitted_plan: Boolean(submittedPlan) });
    trace.emit('edit_started', { mode: submittedPlan ? 'strong-owner-plan' : 'strong-planner-request' });
    let candidatePlan = submittedPlan, workspace, operations;
    planningBegan = performance.now();
    trace.summary.planning_mode = submittedPlan ? 'in-owner-session' : 'dedicated-strong-planner';
    for (let correction = 0; correction < 2; correction++) {
      signal?.throwIfAborted(); assertActive();
      try {
        if (!candidatePlan) {
          if (!plan) throw new Error('Strong planner transport is unavailable');
          const attemptBegan = performance.now();
          trace.emit('planning_started', { correction, selector: record.planner_model });
          const reply = await plan({ assignment, correction, directory, trace, signal });
          trace.artifact(`planning-${correction}.json`, reply);
          candidatePlan = typeof reply === 'string' ? parseJson(reply) : reply.plan;
          trace.emit('planning_finished', { correction, elapsed_ms: performance.now() - attemptBegan,
            selector: record.planner_model, usage: reply.usage ?? null });
        }
        operations = compile(candidatePlan);
        if (operations.some(operation => operation.executor === 'deterministic' && operation.edits.some(edit =>
          !['delete', 'rename'].includes(edit.kind) && !(edit.kind === 'compose' && edit.parts.every(part => part.path && !Object.hasOwn(part, 'text'))))))
          throw new Error('Delegate authored source text to the editor; deterministic operations may only move, copy, or delete existing source');
        workspace = Workspace.loadPaths(record.checkout, operations.flatMap(op => [...op.reads, ...op.writes]));
        validateDispatchPlan(candidatePlan, workspace, { parse, paths });
        break;
      } catch (error) {
        trace.artifact(`planning-${correction}-failure.json`, { error: error.message, plan: candidatePlan ?? null });
        trace.emit('planning_rejected', { correction, reason: 'See private planning failure receipt' });
        if (submittedPlan || correction === 1 || error.planner_transport || signal?.aborted) throw error;
        candidatePlan = null;
      }
    }
    const before = Object.fromEntries([...new Set(operations.flatMap(op => [...op.reads, ...op.writes]))]
      .map(path => [path, { sha256: hash(workspace.read(path)), mode: workspace.modes[path] ?? null }]));
    trace.artifact('source-state.json', before);
    trace.summary.planning_mode = submittedPlan ? 'in-owner-session' : 'dedicated-strong-planner';
    trace.summary.planning_ms = submittedPlan ? null : performance.now() - planningBegan;
    trace.summary.plan_validation_ms = submittedPlan ? performance.now() - planningBegan : null;
    const counter = { calls: 0 }, hasWriters = operations.some(operation => ['simple', 'involved'].includes(operation.executor));
    const model = hasWriters ? await createClient(record.editor_model, { trace, signal, counter }) : null;
    // The measured retry is the same model at low reasoning. Preserve explicit
    // thinking settings; only the route's :off selector permits this escalation.
    const retrySelector = record.editor_model.endsWith(':off') ? record.editor_model.replace(/:off$/, ':low') : record.editor_model;
    const retryModel = !hasWriters || retrySelector === record.editor_model ? model : await createClient(retrySelector, { trace, signal, counter });
    trace.summary.retry_model = retrySelector;
    phase = 'writing';
    const report = await dispatchChangeset(candidatePlan, workspace, { model, retryModel, signal, parse, paths, trace, generate,
      onDraft: draft => trace.artifact('candidate.json', draft), options: { concurrency: 8 } });
    trace.summary.execution_ms = report.metrics.execution_ms;
    if (!report.ok) throw new Error('Changeset application failed; no candidate was published');
    signal?.throwIfAborted(); assertActive();
    phase = 'publication';
    trace.summary.publication = 'pending';
    trace.artifact('publication.json', { state: 'pending', changes: report.changes });
    trace.emit('publication_started', { paths: report.changes.map(change => change.path) });
    const publicationBegan = performance.now();
    const changed = workspace.publish({ beforeWrite: () => { signal?.throwIfAborted(); assertActive(); } });
    published = true;
    phase = 'finalization';
    trace.summary.publication = 'published';
    trace.artifact('publication.json', { state: 'published', changes: report.changes });
    trace.emit('publication_finished', { paths: changed, source_state_sha256: hash(JSON.stringify(before)) });
    trace.summary.publication_ms = performance.now() - publicationBegan;
    const summary = trace.finish('applied', { changed_paths: changed });
    writeArtifact(diskPath(record.package, `runtime/runs/${record.id}-editor-outcome.json`), {
      version: 1, state: 'completed', edit_id: id, writing_route: CHANGESET_ROUTE,
      full_result_path: join(directory, 'summary.json'), recorded_at: new Date().toISOString() });
    return { result: 'Changeset applied. Verification and review remain with the owner.', edit_id: id,
      changed_paths: changed, full_result_path: join(directory, 'summary.json'),
      telemetry: { model_calls: summary.model_calls, unknown_usage_calls: summary.unknown_usage_calls,
        elapsed_ms: summary.elapsed_ms, planning_ms: summary.planning_ms, execution_ms: summary.execution_ms }, publication: 'published' };
  } catch (error) {
    const failure = { error: error.message, failure_phase: phase,
      publication: published ? 'published' : error.publication_uncertain ? 'uncertain' : 'not-published',
      edit_id: id, full_result_path: join(directory, 'summary.json'),
      ...(published || error.publication_uncertain ? { requires_reconciliation: true } : {}), ...(signal?.aborted ? { cancelled: true } : {}),
      ...(error.requires_cancellation ? { requires_cancellation: true } : {}) };
    if (trace) {
      trace.summary.publication = failure.publication;
      if (phase === 'planning' && planningBegan !== undefined) trace.summary.planning_ms = submittedPlan ? null : performance.now() - planningBegan;
      trace.summary.failure_phase = phase;
      try { trace.finish(signal?.aborted ? 'cancelled' : 'failed', { error: error.message,
        requires_reconciliation: failure.requires_reconciliation ?? false,
        requires_cancellation: failure.requires_cancellation ?? false }); }
      catch (telemetryError) { failure.telemetry_error = telemetryError.message; }
    }
    writeArtifact(diskPath(record.package, `runtime/runs/${record.id}-editor-outcome.json`), {
      version: 1, state: 'incomplete', ...failure, recorded_at: new Date().toISOString() });
    return failure;
  } finally { rmSync(slot, { recursive: true, force: true }); }
}

export function latestEditSummary(record) {
  const file = join(record.package, 'runtime/runs', `${record.id}-editor-outcome.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
