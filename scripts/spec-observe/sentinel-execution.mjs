// Package execution is projected from durable journals independently of receipts.
// Derived dependency layers describe future work; only journals establish progress.
import { ACTIVE_MEMBER_PHASES } from './core.mjs';
import { waveRows } from './sentinel-waves.mjs';
import { publicHint } from '../../pi/extensions/spec-runtime/monitor.mjs';

const ACTIVE_CANDIDATE = new Set(['assembling', 'assembled', 'checking', 'repairing', 'implementing', 'reviewing', 'fixing', 'confirming']);
const newest = values => Math.max(0, ...values.map(value => Date.parse(value) || 0));
const countsOf = members => ({ integrated: members.filter(x => x.integrated).length,
  active: members.filter(x => ACTIVE_MEMBER_PHASES.includes(x.phase) || x.phase === 'running').length,
  blocked: members.filter(x => ['blocked', 'failed', 'cancelled'].includes(x.phase)).length,
  queued: members.filter(x => ['queued', 'waiting_dependencies'].includes(x.phase)).length,
  unknown: members.filter(x => x.phase === 'unknown').length });

export function packageExecution(fact, limits, observedAt) {
  const index = fact.stepIndex ?? { steps: [], source: null };
  const indexSteps = index.steps.map(step => ({ ...step, name: typeof step.name === 'string' ? publicHint(step.name) : null }));
  const discoveryComplete = !(fact.waveNotes?.length);
  const reasons = [...(fact.waveNotes ?? []), ...(fact.stepIndexNotes ?? [])];
  if (fact.receiptsIncomplete) reasons.push('receipts-incomplete');
  if (fact.staleReceipts) reasons.push('receipts-stale');
  let omitted = 0;
  const names = new Map(indexSteps.map(step => [step.step, step.name]));
  const current = fact.candidates?.find(item => item.id === fact.currentAssignment);
  const waveTime = newest((fact.waves ?? []).flatMap(wave => wave.transitions.map(item => item.at)));
  const newerSerialReceipt = current && !current.receipt.wave_bindings && !current.receipt.command_phase
    && newest([current.receipt.started_at, current.receipt.dispatch_requested_at]) > waveTime;
  // Receipt recency cannot retire a live or unreadable journal. A serial handoff
  // supersedes wave display only after complete discovery proves all waves ended.
  const serialSelected = newerSerialReceipt && discoveryComplete && !(fact.invalidWaves?.length)
    && (fact.waves ?? []).every(wave => ['integrated', 'cancelled'].includes(wave.state));
  const hasWaves = !!(fact.hasWaveFiles || fact.waveNotes?.length);
  if (newerSerialReceipt && hasWaves && !serialSelected) reasons.push('serial-wave-lifecycle-conflict');
  const mode = serialSelected ? 'serial' : hasWaves ? 'waves'
    : fact.candidates?.length || index.execution_plan?.legacy ? 'serial' : 'unknown';
  let waves = waveRows(fact, limits);
  const knownSteps = new Map();
  let canDerive = discoveryComplete && mode === 'waves' && !!index.execution_plan && !!index.source;
  const ordinals = new Set();
  for (const wave of waves) {
    if (wave.state === 'unknown') { reasons.push(`wave-invalid: ${wave.wave_id}`); canDerive = false; }
    const matches = !!wave.index_sha256 && wave.index_sha256 === index.digest;
    wave.plan_match = matches ? 'matched' : wave.index_sha256 ? 'mismatch' : 'unknown';
    if (!matches) { reasons.push(`wave-index-${wave.plan_match}: ${wave.wave_id}`); canDerive = false; }
    if (!wave.ordinal) { reasons.push(`wave-ordinal-unknown: ${wave.wave_id}`); canDerive = false; }
    else if (ordinals.has(wave.ordinal)) { reasons.push(`wave-ordinal-conflict: ${wave.ordinal}`); canDerive = false; }
    ordinals.add(wave.ordinal);
    // Count from the full bounded journal projection before display omission.
    const full = fact.waves?.find(item => item.wave_id === wave.wave_id)?.members ?? [];
    const plannedMembers = index.execution_plan?.waves[wave.ordinal - 1];
    if (matches && plannedMembers && JSON.stringify(full.map(member => member.step).sort((a,b) => a-b)) !== JSON.stringify([...plannedMembers].sort((a,b) => a-b))) {
      reasons.push(`wave-membership-mismatch: ${wave.wave_id}`); canDerive = false;
    }
    const decorate = member => ({ ...member, name: matches ? names.get(member.step) ?? null : null,
      integrated: wave.state === 'integrated' && member.phase === 'sealed' });
    wave.members = wave.members.map(decorate);
    wave.counts = countsOf(full.map(decorate));
    omitted += wave.omitted_count;
    if (matches) for (const member of full.map(decorate)) {
      if (knownSteps.has(member.step)) reasons.push(`step-wave-conflict: ${member.step}`);
      else knownSteps.set(member.step, { step: member.step, name: member.name, phase: member.phase,
        integrated: member.integrated, wave_id: wave.wave_id, run_id: member.run_id ?? null });
    }
  }
  if (canDerive) for (const [position, numbers] of index.execution_plan.waves.entries()) {
    const ordinal = position + 1;
    if (ordinals.has(ordinal)) continue;
    const earlier = index.execution_plan.waves.slice(0, position).flat();
    const ready = earlier.every(step => knownSteps.get(step)?.integrated === true);
    const missing = ordinal < Math.max(0, ...ordinals);
    if (missing) reasons.push(`wave-record-missing: ${ordinal}`);
    const phase = missing ? 'unknown' : ready ? 'queued' : 'waiting_dependencies';
    const members = numbers.map(step => ({ step, name: names.get(step) ?? null, phase,
      integrated: false, run_id: null, queue_reason: null, blocking_reason: null, transitions: [] }));
    waves.push({ wave_id: null, ordinal, state: phase, observed: false, plan_match: 'matched',
      generation: null, record_path: null, requested_width: numbers.length, admitted_width: null,
      member_count: numbers.length, active_count: 0, sealed_count: 0, blocked_count: 0,
      queued_count: missing ? 0 : numbers.length, cancelled_count: 0, omitted_count: Math.max(0, members.length - limits.waveMembers),
      members: members.slice(0, limits.waveMembers), candidate: null, blocking_reason: missing ? 'wave-record-missing' : null, transitions: [], counts: countsOf(members) });
    omitted += Math.max(0, members.length - limits.waveMembers);
    for (const member of members) knownSteps.set(member.step, { ...member, wave_id: null });
  }
  waves.sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity)
    || String(a.record_path).localeCompare(String(b.record_path)));
  const serialSteps = indexSteps.map(step => {
    // Receipts describe worker lifecycle only; none establish integration.
    const candidate = [...(fact.candidates ?? [])].filter(item => {
      const value = item.receipt.step;
      const number = typeof value === 'string' ? Number(value.match(/(?:^|[/\\])step-(\d+)-subspec\.md$/)?.[1] ?? value.match(/^\s*(\d+)$/)?.[1]) : null;
      return number === step.step && !item.receipt.wave_bindings && !item.receipt.command_phase;
    }).sort((a, b) => newest([b.receipt.started_at, b.receipt.dispatch_requested_at]) - newest([a.receipt.started_at, a.receipt.dispatch_requested_at]))[0];
    const state = candidate?.receipt.state;
    const phase = ['running', 'starting', 'dispatching'].includes(state) ? 'running'
      : state === 'completed' ? 'worker_completed' : ['failed', 'cancelled', 'queued'].includes(state) ? state : 'unknown';
    return { ...step, phase, integrated: false, run_id: candidate?.id ?? null, wave_id: null };
  });
  const steps = mode === 'waves' ? indexSteps.map(step => knownSteps.get(step.step)
    ?? { ...step, phase: 'unknown', integrated: false, run_id: null, wave_id: null }) : serialSteps;
  const counts = countsOf(steps);
  if (mode === 'waves' && !index.source) reasons.push('step-index-unavailable');
  if (mode === 'serial' && fact.candidates?.length && steps.some(step => step.phase === 'unknown')) reasons.push('serial-step-status-unavailable');
  // Journal members remain observable when the plan is missing or changed.
  const active = mode === 'waves' ? Math.max(counts.active, waves.reduce((sum, wave) => sum + wave.counts.active, 0)) : counts.active;
  const blocked = mode === 'waves' ? Math.max(counts.blocked, waves.reduce((sum, wave) => sum + wave.counts.blocked, 0)) : counts.blocked;
  const candidateActive = mode === 'waves' && waves.some(wave => !['integrated', 'cancelled'].includes(wave.state) && (ACTIVE_CANDIDATE.has(wave.candidate?.phase) || ['ready-to-integrate', 'integrating', 'verifying', 'repairing', 'promoting'].includes(wave.state)));
  const attention = !fact.completion && (blocked > 0 || mode === 'waves' && waves.some(wave => wave.state === 'blocked' || wave.candidate?.blocking_reason)
    || fact.incidents?.some(item => ['open', 'unknown'].includes(item.state))
    || fact.actions?.some(item => ['unknown', 'blocked', 'failed'].includes(item.state)) || false);
  const phase = fact.completion ? 'complete' : fact.plannedInventory ? 'planned' : active || candidateActive ? 'running' : attention ? 'blocked'
    : reasons.length ? 'unknown' : steps.length && counts.integrated === steps.length ? 'integrated'
      : counts.queued ? 'queued' : 'unknown';
  const execution_summary = { mode, phase, attention, step_count: index.source ? index.steps.length : null,
    integrated_count: discoveryComplete && mode === 'waves' && waves.every(wave => wave.plan_match === 'matched') && index.source && !reasons.some(reason => /mismatch|conflict|missing/.test(reason)) ? counts.integrated : null, active_count: active, blocked_count: blocked, queued_count: counts.queued,
    waves: mode === 'waves' ? waves : [], steps, coverage: { state: mode === 'waves' && !waves.some(wave => wave.state !== 'unknown') ? 'unknown' : reasons.length || omitted ? 'partial' : 'complete',
      reasons: [...new Set(reasons)].slice(0, 50), omitted: fact.waveNotes?.length ? null : omitted } };
  return { workspace: fact.workspace, package: fact.packagePath, package_ref: fact.ref,
    targets: fact.targets.map(({ id, primary }) => ({ id, primary })),
    source_paths: [...new Set([...(fact.sources?.values() ?? [])].map(source => source.file).concat(waves.map(wave => wave.record_path).filter(Boolean)))],
    observed_at: observedAt, execution_summary, timing: { attempts: (fact.candidates ?? []).map(({ id, receipt }) => ({
      run_id: id, started_at: receipt.started_at ?? receipt.dispatch_requested_at ?? null }))
      .concat((fact.waves ?? []).map(wave => ({ wave_id: wave.wave_id, started_at: wave.opened_at ?? null }))) },
    completion_revision: fact.completionRevision ?? null,
    ...(fact.completion ?? {}) };
}
