// Launch brief composition and the explicit review/dispatch surface for the
// hidden Agents-child flow. This surface edits one workspace-scoped draft
// owned by launch-state.ts; every mutation goes through the store, and api.ts
// remains the only transport owner. Resolution is read-only; only the
// explicit launch control submits the reviewed contract.
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount } from 'solid-js';
import { getJson } from './api';
import BriefComposer from './BriefComposer';
import { ActionBar, RegionalSkeleton, StateNotice, StatusText } from './primitives';
import { str } from './format';
import {
  beginCorrectedAttempt, changeLaunchTarget, editLaunchDraft, getLaunchDraft, launchReviewedDraft, resolveLaunchStage,
  reviewLaunchDraft, saveLaunchDraft, seedLaunchDraft, seedThreadDraft,
  type LaunchContext, type LaunchDraftError, type LaunchPreview,
} from './launch-state';
import { PackageContract, PackageDenied, packageReviewKind } from './launch-package';
import { publicationAuthorityForSkill } from './launch-handoff';
import type { BriefReference } from './composerTypes';
import type { WireRecord } from './model';
import type { RouteState } from './route';
import { busyAgentsHref } from './route';
import { suggestionSourceFor } from './launch-client';

export type LaunchProps = {
  route: RouteState;
  live: boolean;
  token?: string;
  workspace?: WireRecord;
  workspaceName: string;
  assignments?: WireRecord[];
  // Observed snapshot rows for the bound package review's statuses and links;
  // they never supply execution, authority or model facts.
  records?: WireRecord[];
  epics?: WireRecord[];
  onNavigate?(next: RouteState): void;
  onReturnToAgents(): void;
};

type ContractFact = { key: string; label: string; value: string };
type ThreadTarget = { kind: 'repository' | 'worktree' | 'workspace'; label: string };

// Read-only display of the target stored on the exact requested thread. A
// worktree keeps its stored path and is never collapsed to an inferred
// repository; only the stored record, never route.target, supplies the value.
function threadTargetOf(record: WireRecord | null | undefined): ThreadTarget | null {
  if (!record) return null;
  const target = record.target;
  if (target !== null && typeof target === 'object') {
    if (target.kind === 'repository' && typeof target.repository_id === 'string' && target.repository_id) {
      return { kind: 'repository', label: target.repository_id };
    }
    if (target.kind === 'worktree' && typeof target.path === 'string' && target.path) {
      return { kind: 'worktree', label: target.path };
    }
  }
  return { kind: 'workspace', label: 'Whole workspace' };
}

// Resolved assignment facts plus the captured input disclosure. This is a
// presentation-only contract: operation actions stay with the launch review
// owner, and the planned newui-13 panel can reuse the same facts.
export function AssignmentContract(props: { preview: LaunchPreview }) {
  const record = () => props.preview.record;
  const input = () => props.preview.inputPreview;
  // Display-only normalization: the wire value stays untouched for dispatch,
  // while empty or any casing of "none" keeps the design's title-case label.
  const authority = () => {
    const value = str(record().publication_authority);
    return !value || value.toLowerCase() === 'none' ? 'None' : value;
  };
  const facts = (): ContractFact[] => [
    { key: 'workspace', label: 'Workspace', value: str(record().workspace_id) || 'Workspace' },
    { key: 'target', label: 'Target', value: str(record().repository_id) || 'Whole workspace' },
    { key: 'execution', label: 'Execution directory', value: str(record().execution_dir) || 'Unresolved' },
    ...(record().execution_branch ? [{ key: 'branch', label: 'Branch', value: str(record().execution_branch) }] : []),
    { key: 'brief', label: 'Saved brief', value: str(record().brief) || 'Recorded' },
    { key: 'skill', label: 'Skill', value: str(record().skill) || 'General' },
    { key: 'model', label: 'Model', value: str(record().model) || 'Pi default' },
    { key: 'authority', label: 'Publication authority', value: authority() },
    { key: 'assignment', label: 'Assignment', value: str(record().assignment_id) },
    { key: 'digest', label: 'Contract digest', value: props.preview.contractDigest },
  ];
  return (
    <div class="launch-contract">
      <dl class="launch-facts" aria-label="Resolved assignment facts">
        <For each={facts()}>{fact => (
          <div data-fact={fact.key}>
            <dt>{fact.label}</dt>
            <dd class="mono">{fact.value}</dd>
          </div>
        )}</For>
      </dl>
      <Show when={input()}>
        <div id="launch-what-pi" class="launch-input">
          <h3>What Pi will receive</h3>
          <p class="small muted">The saved brief and selected contents below are captured together. Changed source contents require a new review before launch.</p>
          <For each={input()?.references ?? []}>{reference => (
            <details>
              <summary>{reference.kind === 'skill' ? 'Skill' : 'File'}: {reference.label}{reference.source ? ` · ${reference.source}` : ''}</summary>
              <p class="small mono">{reference.path}</p>
              <p class="small mono">SHA-256 {reference.sha256}</p>
              <pre>{reference.content}</pre>
            </details>
          )}</For>
          <details><summary>Complete brief and context</summary><pre>{input()?.brief}</pre></details>
          <details><summary>Assignment instructions</summary><pre>{input()?.instruction}</pre></details>
        </div>
      </Show>
    </div>
  );
}

function RequestedFacts(props: { workspace: string; target: string; brief: string; previousDigest?: string; assignment?: string; digest?: string }) {
  return (
    <dl class="launch-facts" id="launch-review-requested" aria-label="Requested assignment facts">
      <div data-fact="workspace"><dt>Workspace</dt><dd>{props.workspace}</dd></div>
      <div data-fact="target"><dt>Requested target</dt><dd>{props.target}</dd></div>
      <div data-fact="brief"><dt>Saved brief</dt><dd class="mono">{props.brief}</dd></div>
      <Show when={props.previousDigest}><div data-fact="previous-digest"><dt>Previous digest</dt><dd class="mono">{props.previousDigest}</dd></div></Show>
      <Show when={props.assignment}><div data-fact="assignment"><dt>Assignment</dt><dd class="mono">{props.assignment}</dd></div></Show>
      <Show when={props.digest}><div data-fact="digest"><dt>Contract digest</dt><dd class="mono">{props.digest}</dd></div></Show>
    </dl>
  );
}

// Previous reviewed facts, retained separately from the current approval and
// presented explicitly as unapproved in stale/denied states. Dispatch stays
// withheld: this block never enables launch; the current requested facts
// above remain the separate source for the next review.
function PreviousReviewedFacts(props: { preview: LaunchPreview }) {
  const record = () => props.preview.record;
  const authority = () => {
    const value = str(record().publication_authority);
    return !value || value.toLowerCase() === 'none' ? 'None' : value;
  };
  return (
    <div id="launch-review-previous">
      <h4>Previous reviewed facts (not approved for launch)</h4>
      <dl class="launch-facts" aria-label="Previous reviewed facts">
        <div data-fact="previous-workspace"><dt>Workspace</dt><dd>{str(record().workspace_id) || 'Workspace'}</dd></div>
        <div data-fact="previous-target"><dt>Reviewed target</dt><dd>{str(record().repository_id) || 'Whole workspace'}</dd></div>
        <div data-fact="previous-execution"><dt>Execution directory</dt><dd class="mono">{str(record().execution_dir) || 'Unresolved'}</dd></div>
        <div data-fact="previous-brief"><dt>Reviewed brief</dt><dd class="mono">{str(record().brief) || 'Recorded'}</dd></div>
        <div data-fact="previous-skill"><dt>Skill</dt><dd>{str(record().skill) || 'General'}</dd></div>
        <div data-fact="previous-model"><dt>Model</dt><dd>{str(record().model) || 'Pi default'}</dd></div>
        <div data-fact="previous-authority"><dt>Publication authority</dt><dd>{authority()}</dd></div>
        <div data-fact="previous-assignment"><dt>Reviewed assignment</dt><dd class="mono">{str(record().assignment_id)}</dd></div>
        <div data-fact="previous-contract-digest"><dt>Reviewed digest</dt><dd class="mono">{props.preview.contractDigest}</dd></div>
      </dl>
    </div>
  );
}

type ReviewView = 'resolving' | 'dispatching' | 'current' | 'stale' | 'denied' | 'error' | 'result' | 'inspection' | 'saved' | 'unsaved';

export default function Launch(props: LaunchProps) {
  let heading: HTMLHeadingElement | undefined;
  let titleInput: HTMLInputElement | undefined;
  let errorRegion: HTMLDivElement | undefined;
  let reviewErrorRegion: HTMLDivElement | undefined;
  const [titleError, setTitleError] = createSignal('');
  const [announcer, setAnnouncer] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [previousDigest, setPreviousDigest] = createSignal('');
  const [threadRecord, setThreadRecord] = createSignal<WireRecord | null | undefined>(undefined);
  let threadGeneration = 0;

  const ws = () => props.route.ws ?? '';
  const context = (): LaunchContext => {
    // Bound package authority is derived from the route's hand-off skill by the
    // owning derivation; a generic or absent skill keeps the ordinary body.
    const authority = props.route.package ? publicationAuthorityForSkill(props.route.skill) : undefined;
    return {
      ws: ws(),
      ...(props.route.thread ? { thread: props.route.thread } : {}),
      target: props.route.target ?? null,
      ...(props.route.package ? { package: props.route.package } : {}),
      ...(props.route.skill ? { skill: props.route.skill } : {}),
      ...(authority ? { authority } : {}),
    };
  };
  const draft = createMemo(() => (ws() ? getLaunchDraft(context()) : undefined));
  const title = () => draft()?.title ?? '';
  const content = () => draft()?.content ?? '';
  const references = () => draft()?.references ?? [];
  const target = () => draft()?.target ?? null;
  const pending = () => draft()?.pending;
  const saving = () => pending()?.kind === 'save';
  const reviewing = () => pending()?.kind === 'preview';
  const starting = () => pending()?.kind === 'launch';
  const saved = () => draft()?.saved;
  const previewState = () => draft()?.preview;
  const reviewStatus = () => draft()?.reviewStatus ?? 'idle';
  // Bound package review detection: a package route plus one of the plan or
  // implement hand-off skills (resolved preview first, requested route skill
  // before resolution) selects the package contract presentation. Generic
  // package skills keep the ordinary assignment contract.
  const previewSkill = () => str(previewState()?.record?.skill) || props.route.skill || '';
  const packageKind = () => (props.route.package ? packageReviewKind(previewSkill()) : null);
  const bound = () => packageKind() !== null;
  const packageRef = () => props.route.package ?? '';
  const launchLabel = () => packageKind() === 'plan' ? 'Start planning' : packageKind() === 'implement' ? 'Start implementation' : 'Launch agent';
  const startingLabel = () => packageKind() === 'plan' ? 'Starting planning…' : packageKind() === 'implement' ? 'Starting implementation…' : 'Starting agent…';
  const editLabel = () => bound() ? 'Edit brief' : 'Edit assignment';
  const savedCurrent = () => {
    const value = saved();
    if (!value) return false;
    return value.title === title() && value.content === content()
      && value.references.length === references().length
      && value.references.every((reference, index) => reference.kind === references()[index].kind && reference.id === references()[index].id);
  };
  const saveFailure = (): LaunchDraftError | undefined => {
    const error = draft()?.error;
    return error?.operation === 'save' ? error : undefined;
  };
  const enabled = () => props.live && Boolean(props.token) && Boolean(ws());
  const threadBound = () => Boolean(context().thread);
  // pending until the exact UUID is read, bound for a stored record, missing
  // when the list does not contain it; no fallback record is ever substituted.
  const threadState = () => !threadBound() ? 'direct' : threadRecord() === undefined ? 'pending' : threadRecord() === null ? 'missing' : 'bound';
  const threadTarget = () => threadTargetOf(threadRecord());
  const threadTargetKind = () => threadState() === 'bound' ? threadTarget()?.kind ?? 'workspace' : threadState();
  const threadUsable = () => !threadBound() || threadState() === 'bound';
  const locked = () => Boolean(pending()) || !enabled() || !threadUsable();
  const stage = () => resolveLaunchStage(draft(), { tab: props.route.tab, id: props.route.id });
  const repositories = () => {
    const list = props.workspace?.repositories;
    return Array.isArray(list) ? list as Array<{ id?: unknown; status?: unknown }> : [];
  };
  // Suggestions follow the identity that owns the target: thread contexts use
  // the thread endpoint with the exact UUID (the route target has no authority
  // there), while direct contexts keep the retained draft target so an edit
  // moves the request and its full-source cancellation signature together.
  const suggestionSource = createMemo(() => suggestionSourceFor(context(), target()));
  const targetLabel = (value: string | null | undefined) => value || 'Whole workspace';
  const requestedTargetLabel = () => !threadBound()
    ? targetLabel(target())
    : threadState() === 'pending' ? 'Reading thread target…'
      : threadState() === 'missing' ? 'Thread unavailable'
        : threadTarget()?.label ?? 'Whole workspace';

  // Review ownership: the review surface resolves one saved handoff and keeps
  // the stage heading meaningful; the brief composition stays available for
  // corrections.
  const reviewSurface = () => props.route.tab === 'review';
  // A matched result URL renders the full result stage; an id that does not
  // match the local result keeps retained inspection guidance and never claims
  // local confirmation.
  const resultSurface = () => stage() === 'result' || stage() === 'inspection';
  const showBrief = () => !(reviewSurface() || resultSurface()) || stage() === 'brief' || editing();
  const reviewContext = () => stage() === 'review' || stage() === 'result' || stage() === 'inspection'
    || Boolean(saved()) || Boolean(previewState())
    || reviewing() || starting() || reviewStatus() !== 'idle' || Boolean(draft()?.result) || editing();
  const reviewView = (): ReviewView => {
    if (starting()) return 'dispatching';
    if (reviewing()) return 'resolving';
    if (stage() === 'inspection') return 'inspection';
    if (draft()?.result) return 'result';
    const status = reviewStatus();
    if (status === 'stale') return 'stale';
    if (status === 'denied') return 'denied';
    if (status === 'error') return 'error';
    if (previewState()) return 'current';
    if (saved()) return 'saved';
    return 'unsaved';
  };
  const canReview = () => enabled() && !pending() && !draft()?.result && threadUsable() && Boolean(saved()) && savedCurrent();
  const canLaunch = () => {
    const value = previewState();
    const state = draft();
    return enabled() && !pending() && !state?.result && threadUsable()
      && Boolean(saved()) && savedCurrent()
      && reviewStatus() === 'current' && Boolean(value)
      && value!.revision === state?.revision && value!.target === target();
  };
  const shortAssignment = () => (draft()?.pending?.assignmentId ?? draft()?.assignmentId ?? '').slice(0, 8);
  const lastReviewed = () => draft()?.lastReviewed;
  // Busy-denial inspection link follows the client navigation contract:
  // the matching observed assignment key when available, otherwise a
  // workspace-scoped q=conflictingUUID route so an unrelated first row is
  // never selected and an absent conflict filters instead of misdirecting.
  const agentsHref = () => busyAgentsHref(ws(), draft()?.error?.assignmentId, props.assignments ?? []);
  // Result identity and navigation. Open agent uses the exact observed row key
  // when this assignment is already observed, otherwise a workspace-scoped
  // UUID filter so App cannot replace the selection with an unrelated row.
  const resultKind = () => draft()?.result?.kind;
  const resultHeading = () => resultKind() === 'launched' ? 'Agent is live' : resultKind() === 'failed' ? 'Agent could not start' : 'Launch is unconfirmed';
  const resultRecord = () => previewState()?.record ?? lastReviewed()?.record ?? {};
  const resultExecution = () => str(resultRecord().execution_dir) || 'Unresolved';
  const resultAgentsHref = () => busyAgentsHref(ws(), draft()?.result?.assignmentId, props.assignments ?? []);
  const inspectionHref = () => busyAgentsHref(ws(), props.route.id, props.assignments ?? []);
  const resultObservation = () => resultKind() === 'launched'
    ? 'Live process confirmed'
    : resultKind() === 'failed' ? 'launch_failed · process confirmed gone' : 'Unknown identity · not observed';

  // Seed one draft per launch context; retained typed work is never clobbered.
  createEffect(() => {
    const ctx = context();
    if (!ctx.ws) return;
    if (!getLaunchDraft(ctx)) seedLaunchDraft(ctx, { title: '', content: '' });
  });

  // Read the exact stored thread record once per requested UUID. The read-only
  // Runs in display and thread suggestions depend on this record, so a missing
  // or unreadable thread renders unavailable and never borrows route.target.
  // The key changes only when the UUID, workspace or liveness changes, so tab
  // and result-id moves keep the already-read binding.
  const threadFetchKey = createMemo(() => `${ws()}\u0000${props.route.thread ?? ''}\u0000${props.live ? 'live' : 'inactive'}`);
  createEffect(on(threadFetchKey, key => {
    const request = ++threadGeneration;
    setThreadRecord(undefined);
    const [workspace, id, live] = key.split('\u0000');
    if (!workspace || !id || live !== 'live') return;
    void getJson<unknown>(`/api/threads?${new URLSearchParams({ workspace_id: workspace })}`)
      .then(data => {
        if (request !== threadGeneration) return;
        const rows = Array.isArray(data)
          ? data
          : data !== null && typeof data === 'object' && Array.isArray((data as WireRecord).threads) ? (data as WireRecord).threads as WireRecord[] : [];
        setThreadRecord(rows.find(row => row?.thread_id === id) ?? null);
      })
      .catch(() => { if (request === threadGeneration) setThreadRecord(null); });
  }));

  createEffect(on(saving, (isSaving, wasSaving) => {
    if (isSaving && !wasSaving) setAnnouncer('Saving brief… The assignment has not started.');
  }, { defer: true }));
  createEffect(on(() => saved()?.requestId, (id, previous) => {
    if (!id || id === previous) return;
    setEditing(false);
    if (reviewSurface()) {
      setAnnouncer('Brief saved. Resolving the execution contract before any launch.');
      return;
    }
    setAnnouncer('Brief saved. Saving the brief does not start an agent or send a thread message.');
    // Ordinary brief-entry save transitions to review through the route
    // owner, then the review-surface effect resolves it. This runs only
    // while the originating context is still active: navigation away
    // unmounts this surface (or switches its context), so no redirect can
    // fire after the operator leaves.
    const current = props.route;
    if (current.dest !== 'launch' || !ws()) return;
    if (current.tab === 'result' && current.id) return;
    props.onNavigate?.({
      dest: 'launch',
      ws: ws(),
      tab: 'review',
      ...(current.thread ? { thread: current.thread } : {}),
      ...(current.target ? { target: current.target } : {}),
      ...(current.package ? { package: current.package } : {}),
      ...(current.skill ? { skill: current.skill } : {}),
    });
  }, { defer: true }));
  // A recorded result opens its own result route so the URL carries the
  // submitted assignment identity. This runs only while the launch surface is
  // still mounted for this draft; leaving the surface stops the redirect.
  createEffect(on(() => draft()?.result?.assignmentId, (id, previous) => {
    if (!id || id === previous) return;
    if (props.route.dest !== 'launch') return;
    if (props.route.tab === 'result' && props.route.id) return;
    const current = props.route;
    props.onNavigate?.({
      dest: 'launch',
      ws: ws(),
      tab: 'result',
      id,
      ...(current.thread ? { thread: current.thread } : {}),
      ...(current.target ? { target: current.target } : {}),
      ...(current.package ? { package: current.package } : {}),
      ...(current.skill ? { skill: current.skill } : {}),
    });
  }, { defer: true }));
  createEffect(on(saveFailure, failure => {
    if (!failure) return;
    setAnnouncer('Brief could not be saved. Your title, content and selected target are kept. Retry the same brief.');
    queueMicrotask(() => errorRegion?.focus({ preventScroll: true }));
  }, { defer: true }));

  // A saved handoff on the review surface resolves automatically once; failures
  // keep their explicit status until the operator retries Review assignment.
  createEffect(() => {
    if (!reviewSurface() || !enabled() || !threadUsable()) return;
    if (!saved() || !savedCurrent()) return;
    if (previewState() || pending() || draft()?.result) return;
    if (reviewStatus() !== 'idle') return;
    void reviewLaunchDraft(context(), props.token!).catch(() => undefined);
  });

  // Keep the expired review identifiable after the store clears its preview.
  createEffect(() => {
    const digest = previewState()?.contractDigest;
    if (digest) setPreviousDigest(digest);
  });

  createEffect(on(stage, (value, previous) => {
    if ((value === 'review' || value === 'result' || value === 'inspection') && previous !== value) {
      queueMicrotask(() => heading?.focus({ preventScroll: true }));
    }
  }, { defer: true }));
  createEffect(on(() => {
    const error = draft()?.error;
    return error && error.operation !== 'save'
      ? `${error.operation}|${error.status ?? ''}|${error.reason ?? ''}|${error.assignmentId ?? ''}|${error.message ?? ''}`
      : '';
  }, key => {
    if (!key) return;
    queueMicrotask(() => reviewErrorRegion?.focus({ preventScroll: true }));
  }, { defer: true }));
  createEffect(on(reviewStatus, (value, previous) => {
    if (!value || value === previous) return;
    if (value === 'resolving') setAnnouncer('Resolving the execution contract. The assignment has not started.');
    else if (value === 'current') setAnnouncer('Resolved contract ready. Review the details, then launch the assignment.');
    else if (value === 'stale') setAnnouncer('The reviewed contract changed. Review the saved brief again before launching.');
    else if (value === 'denied') setAnnouncer('The target cannot accept this assignment. The launch is withheld.');
    else if (value === 'error') setAnnouncer('The contract could not be resolved. No process has started; the saved brief and target are kept.');
  }, { defer: true }));
  createEffect(on(starting, (value, previous) => {
    if (value && !previous) setAnnouncer('Starting the reviewed assignment. A second launch is unavailable.');
  }, { defer: true }));
  createEffect(on(() => draft()?.result?.kind, (kind, previous) => {
    if (!kind || kind === previous) return;
    if (kind === 'launched') setAnnouncer('The assignment started. Work completion has not been established.');
    else if (kind === 'failed') setAnnouncer('The host confirmed the assignment could not start. Correct the assignment before another review.');
    else setAnnouncer('The launch outcome is unconfirmed. Locate the submitted assignment before launching again.');
  }, { defer: true }));

  onMount(() => queueMicrotask(() => heading?.focus({ preventScroll: true })));

  function edit(changes: { title?: string; content?: string; references?: BriefReference[] }) {
    if (!ws() || locked()) return;
    editLaunchDraft(context(), changes);
  }

  function save() {
    if (locked()) return;
    if (savedCurrent()) {
      setAnnouncer('The brief is already saved. Review the saved facts before continuing.');
      return;
    }
    if (!title().trim()) {
      setTitleError('Enter a brief title.');
      queueMicrotask(() => titleInput?.focus({ preventScroll: true }));
      return;
    }
    setTitleError('');
    void saveLaunchDraft(context(), props.token!).catch(() => undefined);
  }

  function review() {
    if (!canReview()) return;
    void reviewLaunchDraft(context(), props.token!).catch(() => undefined);
  }

  function launch() {
    if (!canLaunch()) return;
    void launchReviewedDraft(context(), props.token!).catch(() => undefined);
  }

  function editAssignment() {
    setEditing(true);
    queueMicrotask(() => titleInput?.focus({ preventScroll: true }));
  }

  // Confirmed failure correction: mint both fresh identities, keep the typed
  // text and return to the brief; the operator must save and review again.
  function correct() {
    const previous = beginCorrectedAttempt(context());
    if (!previous) return;
    setAnnouncer('Corrected assignment prepared. Save the retained brief and review it before another launch.');
    props.onNavigate?.({
      dest: 'launch',
      ws: ws(),
      tab: 'brief',
      ...(props.route.thread ? { thread: props.route.thread } : {}),
      ...(props.route.target ? { target: props.route.target } : {}),
      ...(props.route.package ? { package: props.route.package } : {}),
      ...(props.route.skill ? { skill: props.route.skill } : {}),
    });
  }

  // Discuss result is bound-thread only: seed the exact thread's unsent draft
  // for step 10 and navigate. No thread is mutated and nothing is sent.
  function discuss() {
    const value = draft()?.result;
    const thread = props.route.thread;
    if (!value || !thread) return;
    seedThreadDraft(ws(), thread, {
      assignmentId: value.assignmentId,
      requestId: saved()?.requestId ?? '',
      outcome: value.kind,
      title: saved()?.title ?? '',
      brief: saved()?.brief ?? '',
      executionDir: resultExecution(),
      draft: value.kind === 'launched'
        ? `Assignment ${value.assignmentId} started.`
        : value.kind === 'failed'
          ? `Assignment ${value.assignmentId} could not start.`
          : `Assignment ${value.assignmentId} is unconfirmed; locate it before launching again.`,
    });
    setAnnouncer('Opening the originating conversation with an unsent result draft.');
    props.onNavigate?.({ dest: 'conversations', ws: ws(), id: thread });
  }

  return (
    <div class="full-page">
      <div class="flow">
        <Show when={ws()} fallback={<StateNotice tone="info" title="Choose a workspace">Select a workspace in the rail to prepare an assignment brief.</StateNotice>}>
          <nav class="flow-steps" aria-label="Assignment steps">
            <span class={stage() === 'brief' ? 'current' : ''}><b>1</b>Brief</span>
            <span class={stage() === 'review' ? 'current' : ''}><b>2</b>Review</span>
            <span class={stage() === 'result' || stage() === 'inspection' ? 'current' : ''}><b>3</b>Result</span>
          </nav>
          <h2 id="launch-heading" tabindex="-1" ref={heading}>
            {stage() === 'review' ? (bound() ? `Review ${packageKind() === 'plan' ? 'planning' : 'implementation'} assignment` : 'Review assignment')
              : stage() === 'result' ? resultHeading()
                : stage() === 'inspection' ? 'Launch result unavailable'
                  : 'Prepare assignment'}
          </h2>
          <p class="muted">{stage() === 'review'
            ? bound()
              ? packageKind() === 'plan'
                ? 'Check the resolved planning contract before starting the agent; the package stops before implementation.'
                : 'Check the resolved implementation contract before starting the agent; a draft pull request is the limit.'
              : 'Check the resolved contract before starting the agent.'
            : stage() === 'result' || stage() === 'inspection' ? props.workspaceName : `${props.workspaceName} · New background agent`}</p>
          <Show when={props.live} fallback={<StateNotice tone="info" title="Launch requires the live dashboard">Open the host dashboard to prepare and save an assignment brief. Imported snapshots cannot reach the launch service.</StateNotice>}>
            <Show when={showBrief()}>
              <form id="launch-form" onSubmit={event => { event.preventDefault(); save(); }}>
                <div class="field">
                  <Show when={threadBound()} fallback={<>
                    <label for="launch-target">Runs in</label>
                    <select id="launch-target" class="ds-input" value={target() ?? ''} disabled={locked()} onChange={event => changeLaunchTarget(context(), event.currentTarget.value || null)}>
                      <option value="" selected={!target()}>Whole workspace</option>
                      <For each={repositories()}>{repository => {
                        const id = String(repository.id ?? '');
                        return <option value={id} selected={target() === id}>{id}{repository.status && repository.status !== 'ok' ? ` (${String(repository.status)})` : ''}</option>;
                      }}</For>
                      <Show when={target() && !repositories().some(repository => String(repository.id ?? '') === target())}>
                        <option value={target()!} selected>{target()}</option>
                      </Show>
                    </select>
                  </>}>
                    <label for="launch-thread-target">Runs in</label>
                    <output id="launch-thread-target" class="mono" data-thread-target-kind={threadTargetKind()} aria-describedby="launch-thread-binding">{requestedTargetLabel()}</output>
                    <small id="launch-thread-binding">Bound to the target stored on the originating thread. The server resolves it at review; it cannot be changed on this screen.</small>
                    <Show when={threadState() === 'pending'}>
                      <p id="launch-thread-pending" class="small muted" role="status">Reading the stored thread target…</p>
                    </Show>
                    <Show when={threadState() === 'missing'}>
                      <p id="launch-thread-unavailable" class="field-error" role="alert">This thread is unavailable in this workspace. Nothing can be saved, reviewed or launched for it; return to Conversations and choose an available thread.</p>
                    </Show>
                  </Show>
                </div>
                <div class="field">
                  <label for="launch-brief-title">Brief title</label>
                  <input id="launch-brief-title" class="ds-input" type="text" maxlength="200" required value={title()} disabled={locked()}
                    aria-describedby="launch-brief-title-help" aria-invalid={titleError() ? 'true' : undefined} ref={titleInput}
                    onInput={event => { if (titleError()) setTitleError(''); edit({ title: event.currentTarget.value }); }}
                    onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); } }} />
                  <small id="launch-brief-title-help">Used to identify the saved assignment brief.</small>
                  <Show when={titleError()}><p id="launch-title-validation" class="field-error" role="alert">{titleError()}</p></Show>
                </div>
                <div class="field">
                  <label for="launch-brief-content">Brief content</label>
                  <BriefComposer id="launch-brief-content" value={content()} references={references()} workspaceId={ws()} suggestionSource={suggestionSource()}
                    enabled={!locked()} disabled={locked()} onChange={value => edit({ content: value })} onReferencesChange={next => edit({ references: next })} onSave={save} />
                </div>
                <details>
                  <summary>Execution defaults</summary>
                  <p>General assignment · host model default · no publication authority. The resolved execution contract is reviewed before launch.</p>
                </details>
                <Show when={saveFailure()}>
                  <div id="launch-error" ref={errorRegion} tabindex="-1" role="alert">
                    <StateNotice tone="error" title="Brief could not be saved" announce={false} action={<button class="ds-btn" type="button" disabled={locked()} onClick={save}>Retry save</button>}>
                      Your title, content and selected target are kept. Retry saving the same brief.
                    </StateNotice>
                  </div>
                </Show>
                <Show when={saved()} keyed>
                  {value => (
                    <div id="launch-saved" class="launch-review">
                      <StateNotice tone="success" title="Brief saved" announce={false}>
                        The brief is held for review. Saving does not start an agent or send a thread message.
                      </StateNotice>
                      <dl class="launch-facts" aria-label="Saved brief facts">
                        <div><dt>Title</dt><dd>{value.title}</dd></div>
                        <div><dt>Runs in</dt><dd>{requestedTargetLabel()}</dd></div>
                        <div><dt>Brief file</dt><dd class="mono">{value.brief || 'Recorded'}</dd></div>
                        <div><dt>Request</dt><dd class="mono">{value.requestId}</dd></div>
                      </dl>
                    </div>
                  )}
                </Show>
                <ActionBar variant="inline">
                  <button id="launch-save" class="ds-btn ds-btn--primary" type="button" disabled={locked() || savedCurrent()} aria-busy={saving()} onClick={save}>
                    {saving() ? 'Saving brief…' : 'Save brief'}
                  </button>
                  <button class="ds-btn" type="button" onClick={props.onReturnToAgents}>Return to agents</button>
                </ActionBar>
              </form>
              <p class="contract-note">Saving the brief does not start an agent or send a thread message.</p>
            </Show>
            <Show when={(reviewSurface() || resultSurface()) && reviewContext()}>
              <section id="launch-review" class="launch-review" aria-labelledby="launch-review-heading">
                <div class="section-heading">
                  <h3 id="launch-review-heading">{reviewView() === 'result' || reviewView() === 'inspection' ? 'Launch result' : bound() ? (packageKind() === 'plan' ? 'Review planning assignment' : 'Review implementation assignment') : 'Assignment review'}</h3>
                  <Switch>
                    <Match when={reviewView() === 'current'}><StatusText tone="success">Reviewed</StatusText></Match>
                    <Match when={reviewView() === 'resolving'}><StatusText tone="info">Resolving</StatusText></Match>
                    <Match when={reviewView() === 'dispatching'}><StatusText tone="info">Dispatching</StatusText></Match>
                    <Match when={reviewView() === 'stale'}><StatusText tone="warning">Expired</StatusText></Match>
                    <Match when={reviewView() === 'denied'}><StatusText tone="error">Unavailable</StatusText></Match>
                    <Match when={reviewView() === 'error'}><StatusText tone="error">Failed</StatusText></Match>
                    <Match when={reviewView() === 'result'}><StatusText tone={resultKind() === 'launched' ? 'success' : resultKind() === 'failed' ? 'error' : 'warning'}>{resultKind() === 'launched' ? 'Live' : resultKind() === 'failed' ? 'Failed' : 'Unconfirmed'}</StatusText></Match>
                    <Match when={reviewView() === 'inspection'}><StatusText tone="info">Unavailable</StatusText></Match>
                  </Switch>
                </div>
                <Switch>
                  <Match when={reviewView() === 'resolving'}>
                    <StatusText id="launch-review-status" tone="info">Resolving execution contract…</StatusText>
                    <RegionalSkeleton rows={3} announce={false} label="Resolving execution contract" />
                    <RequestedFacts workspace={props.workspaceName || ws()} target={requestedTargetLabel()} brief={saved()?.brief || 'Recorded'} />
                    <ActionBar variant="inline">
                      <button id="launch-assignment-launch" class="ds-btn ds-btn--primary" type="button" disabled>{launchLabel()}</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'dispatching'}>
                    <StateNotice tone="info" title={`Starting assignment ${shortAssignment()}`} announce={false}>
                      Dispatch uses the reviewed contract. Wait for identity confirmation; a second launch is unavailable.
                    </StateNotice>
                    <Show when={previewState()} keyed>{preview => bound()
                      ? <PackageContract preview={preview} packageRef={packageRef()} kind={packageKind()!} records={props.records} epics={props.epics} />
                      : <AssignmentContract preview={preview} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-launch" class="ds-btn ds-btn--primary" type="button" disabled aria-busy="true">{startingLabel()}</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'current'}>
                    <Show when={previewState()} keyed>{preview => bound()
                      ? <PackageContract preview={preview} packageRef={packageRef()} kind={packageKind()!} records={props.records} epics={props.epics} />
                      : <AssignmentContract preview={preview} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-launch" class="ds-btn ds-btn--primary" type="button" disabled={!canLaunch()} onClick={launch}>{launchLabel()}</button>
                      <button id="launch-assignment-review" class="ds-btn" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>{editLabel()}</button>
                    </ActionBar>
                    <p class="contract-note">{bound()
                      ? packageKind() === 'plan'
                        ? 'Starting planning runs one package-bound planning assignment and stops before implementation. No branch push or pull request is authorized.'
                        : 'Starting implementation runs one package-bound assignment and may open a draft pull request. Merge stays with the operator.'
                      : 'Launching starts a separate background assignment. It does not send a message or grant merge or deployment authority.'}</p>
                  </Match>
                  <Match when={reviewView() === 'stale'}>
                    <div id="launch-review-error" class="launch-review-error" tabindex="-1" ref={reviewErrorRegion}>
                      <StateNotice tone="warning" title="The reviewed contract changed" announce={false}>
                        The target or saved brief differs from this review. Review again to obtain a current contract; the previous digest does not authorize a launch.
                      </StateNotice>
                    </div>
                    <RequestedFacts workspace={props.workspaceName || ws()} target={requestedTargetLabel()} brief={saved()?.brief || 'Recorded'} previousDigest={previousDigest() || undefined} />
                    <Show when={lastReviewed()} keyed>{previous => <PreviousReviewedFacts preview={previous} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>{editLabel()}</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'denied'}>
                    <div id="launch-review-error" class="launch-review-error" tabindex="-1" ref={reviewErrorRegion}>
                      <Switch>
                        <Match when={bound()}>
                          <PackageDenied reason={draft()?.error?.reason} conflictingAssignment={draft()?.error?.assignmentId} agentHref={agentsHref()} packageRef={packageRef()} kind={packageKind()!} ws={ws()} records={props.records} />
                        </Match>
                        <Match when={draft()?.error?.reason === 'target-busy'}>
                          <StateNotice tone="error" title="This directory already has a writer" announce={false} action={<a class="ds-btn" href={agentsHref()}>Open agent</a>}>
                            <Show when={draft()?.error?.assignmentId} fallback={<span>Another assignment is still live or unconfirmed in {requestedTargetLabel()}. Inspect it before choosing this execution directory.</span>}>
                              Assignment <a id="launch-review-busy" class="mono" href={agentsHref()}>{str(draft()?.error?.assignmentId)}</a> is still live or unconfirmed in {requestedTargetLabel()}. Inspect it before choosing this execution directory.
                            </Show>
                          </StateNotice>
                        </Match>
                        <Match when={draft()?.error?.reason === 'run-active'}>
                          <StateNotice tone="error" title="This spec package has an active run" announce={false}>
                            A spec run is still active for this package. Inspect it before launching another assignment.
                          </StateNotice>
                        </Match>
                        <Match when={draft()?.error?.reason === 'service-unavailable'}>
                          <StateNotice tone="error" title="Dispatch service unavailable" announce={false}>
                            The dispatch service did not answer. The saved brief and target are kept; review again to retry.
                          </StateNotice>
                        </Match>
                        <Match when={true}>
                          <StateNotice tone="error" title="Launch is not authorized" announce={false}>
                            This dashboard cannot start assignments from here. Review the saved brief again from an authorized dashboard.
                          </StateNotice>
                        </Match>
                      </Switch>
                    </div>
                    <RequestedFacts workspace={props.workspaceName || ws()} target={requestedTargetLabel()} brief={saved()?.brief || 'Recorded'} />
                    <Show when={lastReviewed()} keyed>{previous => <PreviousReviewedFacts preview={previous} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>{editLabel()}</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'error'}>
                    <div id="launch-review-error" class="launch-review-error" tabindex="-1" ref={reviewErrorRegion}>
                      <StateNotice tone="error" title="Contract could not be resolved" announce={false}>
                        No process has started and no assignment is reserved. The saved brief and target are kept; review again to retry.
                      </StateNotice>
                    </div>
                    <RequestedFacts workspace={props.workspaceName || ws()} target={requestedTargetLabel()} brief={saved()?.brief || 'Recorded'} assignment="Not reserved" digest="Unavailable" />
                    <ActionBar variant="inline">
                      <Show when={saved()} fallback={<button id="launch-assignment-save" class="ds-btn ds-btn--primary" type="button" disabled={locked() || !title().trim()} onClick={save}>Save brief</button>}>
                        <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      </Show>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>{editLabel()}</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'result'}>
                    <Show when={draft()?.result} keyed>{value => (
                      <div class="launch-result">
                        <StateNotice
                          tone={value.kind === 'launched' ? 'success' : value.kind === 'failed' ? 'error' : 'warning'}
                          announce={false}
                          title={value.kind === 'launched' ? 'Assignment started' : value.kind === 'failed' ? 'Process startup failed' : 'The launch acknowledgement was lost'}
                        >
                          {value.kind === 'launched'
                            ? 'The host recorded this assignment as live. Work completion has not been established.'
                            : value.kind === 'failed'
                              ? 'The host recorded a confirmed launch failure. The assignment and saved brief are retained for inspection.'
                              : 'The submitted assignment may already be running; do not launch it again. Locate the submitted identity in Agents before starting another assignment; this dashboard has no confirmed record of it.'}
                        </StateNotice>
                        <dl class="launch-facts" id="launch-result-facts" aria-label="Launch result facts">
                          <div data-fact="request"><dt>Request</dt><dd class="mono">{saved()?.requestId ?? 'Recorded'}</dd></div>
                          <div data-fact="assignment"><dt>Assignment</dt><dd class="mono">{value.assignmentId}</dd></div>
                          <div data-fact="execution"><dt>Execution directory</dt><dd class="mono">{resultExecution()}</dd></div>
                          <div data-fact="brief"><dt>Brief</dt><dd>{saved()?.title || 'Recorded'}</dd></div>
                          <Show when={props.route.thread}><div data-fact="thread"><dt>Originating thread</dt><dd class="mono">{props.route.thread}</dd></div></Show>
                          <div data-fact="observation"><dt>Observation</dt><dd>{resultObservation()}</dd></div>
                        </dl>
                        <ActionBar variant="inline">
                          <a id="launch-result-open-agent" class="ds-btn ds-btn--primary" href={resultAgentsHref()}>Open agent</a>
                          <Show when={value.kind === 'failed'}>
                            <button id="launch-result-correct" class="ds-btn" type="button" onClick={correct}>Correct assignment</button>
                          </Show>
                          <Show when={props.route.thread}>
                            <button id="launch-result-discuss" class="ds-btn" type="button" onClick={discuss}>Discuss result</button>
                          </Show>
                        </ActionBar>
                        <Show when={props.route.thread}>
                          <p class="contract-note">Discuss result opens the originating conversation with an unsent result draft. Review it before sending.</p>
                        </Show>
                      </div>
                    )}</Show>
                  </Match>
                  <Match when={reviewView() === 'inspection'}>
                    <div id="launch-result-inspection" class="launch-result-inspection" tabindex="-1">
                      <StateNotice tone="info" title="This result link has no local record" announce={false} action={<a class="ds-btn" href={inspectionHref()}>Open agents</a>}>
                        The dashboard has not confirmed an assignment for this result link and has started nothing. Locate the submitted identity in Agents before acting on it.
                      </StateNotice>
                    </div>
                    <dl class="launch-facts" aria-label="Requested result facts">
                      <div data-fact="requested-result"><dt>Requested result</dt><dd class="mono">{props.route.id}</dd></div>
                      <div data-fact="local-result"><dt>Local result</dt><dd class="mono">{draft()?.result?.assignmentId ?? 'Not recorded'}</dd></div>
                    </dl>
                  </Match>
                  <Match when={reviewView() === 'saved'}>
                    <StatusText id="launch-review-status" tone="info">Saved brief ready to review</StatusText>
                    <RequestedFacts workspace={props.workspaceName || ws()} target={requestedTargetLabel()} brief={saved()?.brief || 'Recorded'} />
                    <ActionBar variant="inline">
                      <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>{editLabel()}</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'unsaved'}>
                    <div id="launch-review-unsaved">
                      <StateNotice tone="warning" title="Unsaved changes are not reviewed" announce={false}>
                        Review cannot approve unsaved edits. Save the brief to review the current text, or edit the assignment.
                      </StateNotice>
                    </div>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-save" class="ds-btn ds-btn--primary" type="button" disabled={locked() || !title().trim()} onClick={save}>Save brief</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>{editLabel()}</button>
                    </ActionBar>
                  </Match>
                </Switch>
              </section>
            </Show>
          </Show>
          <span class="sr-only" aria-live="polite">{announcer()}</span>
        </Show>
      </div>
    </div>
  );
}
