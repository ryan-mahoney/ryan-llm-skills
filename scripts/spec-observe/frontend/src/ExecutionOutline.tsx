import { For, Show, createSignal } from 'solid-js';
import { executionCounts, executionSteps, executionSummary, executionWaves, phaseLabel, recordedRuns, packageAttempts, stepAttempts, stepRuns, candidateAttempts, waveSealedCount, waveExpanded, waveIdentity, waveNeedsAttention } from './execution-state';
import { str, terminal, time } from './format';
import { duration } from './observation-format';
import { observationEnd, packageRelative, type ObservationContext } from './spec-state';
import { StateNotice, StatusText, type StatusTone } from './primitives';
import type { WireRecord } from './model';

const list = (value: unknown): WireRecord[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
const tone = (phase: unknown): StatusTone => ['integrated','complete','completed'].includes(str(phase)) ? 'success' : ['blocked','failed','conflicted','unknown'].includes(str(phase)) ? 'warning' : ['running','implementing','verifying','assembling','repairing','promoting'].includes(str(phase)) ? 'info' : 'neutral';
export type ExecutionOutlineProps = { record: WireRecord; context: ObservationContext; activity?: boolean; onOpenFile?: (path: string) => void; onOpenAgent?: (assignmentId: string) => void };

// Components are keyed by canonical package/wave/step identities. Polling may
// replace every wire object; the user's expanded/collapsed choices survive.
export default function ExecutionOutline(props: ExecutionOutlineProps) {
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const waves = () => executionWaves(props.record);
  const waveIds = () => waves().map(wave => waveIdentity(wave, waves()));
  const waveFor = (id: string) => waves().find(wave => waveIdentity(wave, waves()) === id)!;
  const openSource = (path: unknown) => {
    const raw = str(path), relative = packageRelative(props.record, raw);
    if (relative) props.onOpenFile?.(relative);
    else if (raw && !raw.startsWith('/') && !raw.split('/').includes('..')) props.onOpenFile?.(raw);
  };
  const canOpen = (path: unknown): boolean => Boolean(props.onOpenFile) && Boolean(packageRelative(props.record, str(path)) || (str(path) && !str(path).startsWith('/') && !str(path).split('/').includes('..')));
  const summary = () => executionSummary(props.record);
  const coverage = () => summary()?.coverage;
  const attemptEnd = (attempt: WireRecord) => attempt.finished_at || (terminal.has(attempt.state) ? null : observationEnd(props.record, props.context));
  const Step = (stepProps: { step: WireRecord }) => {
    const step = () => stepProps.step;
    const attempts = () => stepAttempts(props.record, step());
    const runs = () => stepRuns(props.record, step());
    return <div class="execution-step" data-step={step().step}>
      <div class="execution-row"><strong>Step {step().step ?? '?'}{step().name ? ` · ${step().name}` : ''}</strong><StatusText tone={tone(step().integrated ? 'integrated' : step().phase)}>{step().integrated ? 'Integrated' : phaseLabel(step().phase)}</StatusText></div>
      <Show when={step().blocking_reason || step().queue_reason}><p class="small execution-reason">{phaseLabel(step().blocking_reason || step().queue_reason)}</p></Show>
      <Show when={props.activity}>
        <For each={attempts()}>{(attempt, index) => <div class="execution-attempt"><span>{phaseLabel(attempt.phase || attempt.attempt_kind)} · Attempt {index() + 1} · {phaseLabel(attempt.state)}</span><span class="mono">{duration(attempt.started_at, attemptEnd(attempt))} worker duration</span></div>}</For>
        <Show when={!attempts().length}><p class="small muted">No attempt timing observed.</p></Show>
        <For each={runs()}>{run => <div class="small muted execution-run">Run <span class="mono">{run.run_id || 'Unknown'}</span> · {phaseLabel(run.execution)}<Show when={run.assignment_id}> · <Show when={props.onOpenAgent} fallback={<span>Agent <span class="mono">{run.assignment_id}</span></span>}><button class="text-link" type="button" onClick={()=>props.onOpenAgent?.(run.assignment_id)}>Open agent</button></Show></Show></div>}</For>
      </Show>
    </div>;
  };
  const integration = (wave: () => WireRecord) => {
    const candidate = () => wave().candidate;
    const integrationPhase = () => ['integrated','verifying','integrating','assembling','repairing','promoting'].includes(wave().state) ? wave().state : candidate()?.phase || (wave().observed === false ? 'waiting_dependencies' : 'not_started');
    const attempts = () => candidateAttempts(props.record, wave());
    return <div class="wave-integration" data-integration-phase={integrationPhase()}>
      <div class="execution-row"><strong>Integration</strong><StatusText tone={tone(integrationPhase())}>{phaseLabel(integrationPhase())}</StatusText></div>
      <Show when={candidate()?.blocking_reason || wave().blocking_reason}><p class="small execution-reason">{phaseLabel(candidate()?.blocking_reason || wave().blocking_reason)}</p></Show>
      <Show when={candidate()?.phase && candidate().phase !== integrationPhase()}><p class="small muted">Candidate: {phaseLabel(candidate().phase)}</p></Show>
      <Show when={props.activity}>
        <For each={list(candidate()?.transitions)}>{transition => <p class="small muted">{phaseLabel(transition.phase || transition.state || transition.event)} · {time(transition.at || transition.observed_at)}</p>}</For>
        <Show when={candidate()?.run_id}><p class="small muted">Candidate run <span class="mono">{candidate().run_id}</span></p></Show>
        <For each={attempts()}>{(attempt, index) => <div class="execution-attempt"><span>{phaseLabel(attempt.phase || attempt.attempt_kind)} · Attempt {index() + 1} · {phaseLabel(attempt.state)}</span><span>{duration(attempt.started_at, attemptEnd(attempt))} worker duration</span></div>}</For>
      </Show>
    </div>;
  };
  return <section class="section execution-outline" data-execution-mode={summary()?.mode}>
    <div class="section-heading"><h3>{props.activity ? 'Execution activity' : summary()?.mode === 'waves' ? 'Wave execution' : 'Step execution'}</h3><StatusText tone={tone(summary()?.phase)}>{phaseLabel(summary()?.phase)}</StatusText></div>
    <p class="execution-counts">{executionCounts(props.record)}</p>
    <Show when={summary()?.mode === 'unknown'}><StateNotice tone="warning" title="Execution mode unknown">Wave records are unavailable or incomplete. This observation cannot establish serial execution.</StateNotice></Show>
    <Show when={waves().length > 0} fallback={<>
      <For each={executionSteps(props.record)}>{step => <Step step={step} />}</For>
    </>}>
      <p class="small muted">Sealed work awaits integration. Integrated steps do not establish workflow completion.</p>
      <For each={waveIds()}>{id => {
        const wave = () => waveFor(id);
        const identity = () => `${props.record.workspace}:${props.record.package}:${id}`;
        const isOpen = () => expanded()[identity()] ?? waveExpanded(wave());
        const members = () => list(wave().members).slice().sort((a,b) => Number(a.step) - Number(b.step));
        const memberIds = () => members().map(member => String(member.step));
        return <details class="execution-wave" data-wave-id={wave().wave_id ?? id} data-wave-state={wave().state} data-wave-observed={wave().observed !== false} open={isOpen()} onToggle={event => {
          const value = event.currentTarget.open;
          if (value !== isOpen()) setExpanded(previous => ({...previous, [identity()]: value}));
        }}>
          <summary><span class="wave-title">Wave {wave().ordinal ?? 'unknown'}</span><span>{phaseLabel(wave().state)}{wave().observed === false ? ' · Planned' : ''}</span><Show when={waveNeedsAttention(wave())}><StatusText tone="warning">Needs attention</StatusText></Show><span class="small muted">{wave().member_count ?? members().length} steps · width {wave().admitted_width ?? '?'} / {wave().requested_width ?? '?'} requested</span></summary>
          <div class="wave-body">
            <p class="small muted">{wave().counts?.integrated ?? '?'} integrated · {waveSealedCount(wave())} sealed · {wave().counts?.active ?? '?'} active · {wave().counts?.blocked ?? '?'} blocked · {wave().counts?.queued ?? '?'} queued</p>
            <Show when={wave().observed === false}><p class="small muted">Planned wave · {wave().state === 'waiting_dependencies' ? 'Waiting for dependencies to integrate.' : 'Waiting for admission.'}</p></Show>
            <For each={memberIds()}>{stepId => <Step step={members().find(member=>String(member.step)===stepId)!} />}</For>
            {integration(wave)}
            <Show when={wave().record_path}><p class="small muted">Source: <Show when={canOpen(wave().record_path)} fallback={<span class="mono path">{wave().record_path}</span>}><button class="text-link mono" title={str(wave().record_path)} type="button" onClick={()=>openSource(wave().record_path)}>{packageRelative(props.record, str(wave().record_path)) || wave().record_path}</button></Show></p></Show>
          </div>
        </details>;
      }}</For>
    </Show>
    <Show when={coverage()?.state !== 'complete'}><StateNotice tone="warning" title={`Execution coverage ${coverage()?.state || 'unknown'}`}><For each={Array.isArray(coverage()?.reasons) ? coverage().reasons : []}>{reason => <p>{str(reason)}</p>}</For><p>{Number.isFinite(coverage()?.omitted) ? `${coverage().omitted} records omitted.` : 'Omission count unknown.'}</p></StateNotice></Show>
    <Show when={props.activity}><p class="small muted">Wall elapsed follows the package observation. Worker durations may overlap across concurrent steps; their sum is not wall elapsed.</p></Show>
  </section>;
}
