// Launch brief composition and the explicit review/dispatch surface for the
// hidden Agents-child flow. This surface edits one workspace-scoped draft
// owned by launch-state.ts; every mutation goes through the store, and api.ts
// remains the only transport owner. Resolution is read-only; only the
// explicit launch control submits the reviewed contract.
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount } from 'solid-js';
import BriefComposer from './BriefComposer';
import { ActionBar, RegionalSkeleton, StateNotice, StatusText } from './primitives';
import { str } from './format';
import {
  changeLaunchTarget, editLaunchDraft, getLaunchDraft, launchReviewedDraft, resolveLaunchStage,
  reviewLaunchDraft, saveLaunchDraft, seedLaunchDraft,
  type LaunchContext, type LaunchDraftError, type LaunchPreview,
} from './launch-state';
import type { BriefReference } from './composerTypes';
import type { WireRecord } from './model';
import type { RouteState } from './route';
import { busyAgentsHref } from './route';

export type LaunchProps = {
  route: RouteState;
  live: boolean;
  token?: string;
  workspace?: WireRecord;
  workspaceName: string;
  assignments?: WireRecord[];
  onNavigate?(next: RouteState): void;
  onReturnToAgents(): void;
};

type ContractFact = { key: string; label: string; value: string };

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

type ReviewView = 'resolving' | 'dispatching' | 'current' | 'stale' | 'denied' | 'error' | 'result' | 'saved' | 'unsaved';

export default function Launch(props: LaunchProps) {
  let heading: HTMLHeadingElement | undefined;
  let titleInput: HTMLInputElement | undefined;
  let errorRegion: HTMLDivElement | undefined;
  let reviewErrorRegion: HTMLDivElement | undefined;
  const [titleError, setTitleError] = createSignal('');
  const [announcer, setAnnouncer] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [previousDigest, setPreviousDigest] = createSignal('');

  const ws = () => props.route.ws ?? '';
  const context = (): LaunchContext => ({
    ws: ws(),
    ...(props.route.thread ? { thread: props.route.thread } : {}),
    target: props.route.target ?? null,
    ...(props.route.package ? { package: props.route.package } : {}),
    ...(props.route.skill ? { skill: props.route.skill } : {}),
  });
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
  const locked = () => Boolean(pending()) || !enabled();
  const stage = () => resolveLaunchStage(draft(), { tab: props.route.tab, id: props.route.id });
  const repositories = () => {
    const list = props.workspace?.repositories;
    return Array.isArray(list) ? list as Array<{ id?: unknown; status?: unknown }> : [];
  };
  // Suggestions follow the retained draft target, not the route seed: Runs in
  // edits move the request params and the full-source cancellation
  // signature, so a stale old-target response cannot populate the list.
  const suggestionSource = createMemo(() => ({
    path: '/api/dispatch/suggestions',
    params: {
      workspace_id: ws(),
      ...(target() ? { repository_id: target()! } : {}),
    },
  }));
  const targetLabel = (value: string | null | undefined) => value || 'Whole workspace';

  // Review ownership: the review surface resolves one saved handoff and keeps
  // the stage heading meaningful; the brief composition stays available for
  // corrections.
  const reviewSurface = () => props.route.tab === 'review';
  const showBrief = () => !reviewSurface() || stage() === 'brief' || editing();
  const reviewContext = () => stage() === 'review' || Boolean(saved()) || Boolean(previewState())
    || reviewing() || starting() || reviewStatus() !== 'idle' || Boolean(draft()?.result) || editing();
  const reviewView = (): ReviewView => {
    if (starting()) return 'dispatching';
    if (reviewing()) return 'resolving';
    if (draft()?.result) return 'result';
    const status = reviewStatus();
    if (status === 'stale') return 'stale';
    if (status === 'denied') return 'denied';
    if (status === 'error') return 'error';
    if (previewState()) return 'current';
    if (saved()) return 'saved';
    return 'unsaved';
  };
  const canReview = () => enabled() && !pending() && !draft()?.result && Boolean(saved()) && savedCurrent();
  const canLaunch = () => {
    const value = previewState();
    const state = draft();
    return enabled() && !pending() && !state?.result
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

  // Seed one draft per launch context; retained typed work is never clobbered.
  createEffect(() => {
    const ctx = context();
    if (!ctx.ws) return;
    if (!getLaunchDraft(ctx)) seedLaunchDraft(ctx, { title: '', content: '' });
  });

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
  createEffect(on(saveFailure, failure => {
    if (!failure) return;
    setAnnouncer('Brief could not be saved. Your title, content and selected target are kept. Retry the same brief.');
    queueMicrotask(() => errorRegion?.focus({ preventScroll: true }));
  }, { defer: true }));

  // A saved handoff on the review surface resolves automatically once; failures
  // keep their explicit status until the operator retries Review assignment.
  createEffect(() => {
    if (!reviewSurface() || !enabled()) return;
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
    if (value === 'review' && previous !== 'review') queueMicrotask(() => heading?.focus({ preventScroll: true }));
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

  onMount(() => queueMicrotask(() => heading?.focus({ preventScroll: true })));

  function edit(changes: { title?: string; content?: string; references?: BriefReference[] }) {
    if (!ws() || locked()) return;
    editLaunchDraft(context(), changes);
  }

  function save() {
    if (!enabled() || pending()) return;
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

  return (
    <div class="full-page">
      <div class="flow">
        <Show when={ws()} fallback={<StateNotice tone="info" title="Choose a workspace">Select a workspace in the rail to prepare an assignment brief.</StateNotice>}>
          <nav class="flow-steps" aria-label="Assignment steps">
            <span class={stage() === 'brief' ? 'current' : ''}><b>1</b>Brief</span>
            <span class={stage() === 'review' ? 'current' : ''}><b>2</b>Review</span>
            <span class={stage() === 'result' || stage() === 'inspection' ? 'current' : ''}><b>3</b>Result</span>
          </nav>
          <h2 id="launch-heading" tabindex="-1" ref={heading}>{stage() === 'review' ? 'Review assignment' : 'Prepare assignment'}</h2>
          <p class="muted">{stage() === 'review' ? 'Check the resolved contract before starting the agent.' : `${props.workspaceName} · New background agent`}</p>
          <Show when={props.live} fallback={<StateNotice tone="info" title="Launch requires the live dashboard">Open the host dashboard to prepare and save an assignment brief. Imported snapshots cannot reach the launch service.</StateNotice>}>
            <Show when={showBrief()}>
              <form id="launch-form" onSubmit={event => { event.preventDefault(); save(); }}>
                <div class="field">
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
                        <div><dt>Runs in</dt><dd>{targetLabel(target())}</dd></div>
                        <div><dt>Brief file</dt><dd class="mono">{value.brief || 'Recorded'}</dd></div>
                        <div><dt>Request</dt><dd class="mono">{value.requestId}</dd></div>
                      </dl>
                    </div>
                  )}
                </Show>
                <ActionBar variant="inline">
                  <button id="launch-save" class="ds-btn ds-btn--primary" type="button" disabled={!enabled() || Boolean(pending()) || savedCurrent()} aria-busy={saving()} onClick={save}>
                    {saving() ? 'Saving brief…' : 'Save brief'}
                  </button>
                  <button class="ds-btn" type="button" onClick={props.onReturnToAgents}>Return to agents</button>
                </ActionBar>
              </form>
              <p class="contract-note">Saving the brief does not start an agent or send a thread message.</p>
            </Show>
            <Show when={reviewSurface() && reviewContext()}>
              <section id="launch-review" class="launch-review" aria-labelledby="launch-review-heading">
                <div class="section-heading">
                  <h3 id="launch-review-heading">Assignment review</h3>
                  <Switch>
                    <Match when={reviewView() === 'current'}><StatusText tone="success">Reviewed</StatusText></Match>
                    <Match when={reviewView() === 'resolving'}><StatusText tone="info">Resolving</StatusText></Match>
                    <Match when={reviewView() === 'dispatching'}><StatusText tone="info">Dispatching</StatusText></Match>
                    <Match when={reviewView() === 'stale'}><StatusText tone="warning">Expired</StatusText></Match>
                    <Match when={reviewView() === 'denied'}><StatusText tone="error">Unavailable</StatusText></Match>
                    <Match when={reviewView() === 'error'}><StatusText tone="error">Failed</StatusText></Match>
                    <Match when={reviewView() === 'result'}><StatusText tone={draft()?.result?.kind === 'launched' ? 'success' : 'warning'}>{draft()?.result?.kind === 'launched' ? 'Started' : 'Unconfirmed'}</StatusText></Match>
                  </Switch>
                </div>
                <Switch>
                  <Match when={reviewView() === 'resolving'}>
                    <StatusText id="launch-review-status" tone="info">Resolving execution contract…</StatusText>
                    <RegionalSkeleton rows={3} announce={false} label="Resolving execution contract" />
                    <RequestedFacts workspace={props.workspaceName || ws()} target={targetLabel(target())} brief={saved()?.brief || 'Recorded'} />
                    <ActionBar variant="inline">
                      <button id="launch-assignment-launch" class="ds-btn ds-btn--primary" type="button" disabled>Launch agent</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'dispatching'}>
                    <StateNotice tone="info" title={`Starting assignment ${shortAssignment()}`} announce={false}>
                      Dispatch uses the reviewed contract. Wait for identity confirmation; a second launch is unavailable.
                    </StateNotice>
                    <Show when={previewState()} keyed>{preview => <AssignmentContract preview={preview} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-launch" class="ds-btn ds-btn--primary" type="button" disabled aria-busy="true">Starting agent…</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'current'}>
                    <Show when={previewState()} keyed>{preview => <AssignmentContract preview={preview} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-launch" class="ds-btn ds-btn--primary" type="button" disabled={!canLaunch()} onClick={launch}>Launch agent</button>
                      <button id="launch-assignment-review" class="ds-btn" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>Edit assignment</button>
                    </ActionBar>
                    <p class="contract-note">Launching starts a separate background assignment. It does not send a message or grant merge or deployment authority.</p>
                  </Match>
                  <Match when={reviewView() === 'stale'}>
                    <div id="launch-review-error" class="launch-review-error" tabindex="-1" ref={reviewErrorRegion}>
                      <StateNotice tone="warning" title="The reviewed contract changed" announce={false}>
                        The target or saved brief differs from this review. Review again to obtain a current contract; the previous digest does not authorize a launch.
                      </StateNotice>
                    </div>
                    <RequestedFacts workspace={props.workspaceName || ws()} target={targetLabel(target())} brief={saved()?.brief || 'Recorded'} previousDigest={previousDigest() || undefined} />
                    <Show when={lastReviewed()} keyed>{previous => <PreviousReviewedFacts preview={previous} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>Edit assignment</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'denied'}>
                    <div id="launch-review-error" class="launch-review-error" tabindex="-1" ref={reviewErrorRegion}>
                      <Switch>
                        <Match when={draft()?.error?.reason === 'target-busy'}>
                          <StateNotice tone="error" title="This directory already has a writer" announce={false} action={<a class="ds-btn" href={agentsHref()}>Open agent</a>}>
                            <Show when={draft()?.error?.assignmentId} fallback={<span>Another assignment is still live or unconfirmed in {targetLabel(target())}. Inspect it before choosing this execution directory.</span>}>
                              Assignment <a id="launch-review-busy" class="mono" href={agentsHref()}>{str(draft()?.error?.assignmentId)}</a> is still live or unconfirmed in {targetLabel(target())}. Inspect it before choosing this execution directory.
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
                    <RequestedFacts workspace={props.workspaceName || ws()} target={targetLabel(target())} brief={saved()?.brief || 'Recorded'} />
                    <Show when={lastReviewed()} keyed>{previous => <PreviousReviewedFacts preview={previous} />}</Show>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>Edit assignment</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'error'}>
                    <div id="launch-review-error" class="launch-review-error" tabindex="-1" ref={reviewErrorRegion}>
                      <StateNotice tone="error" title="Contract could not be resolved" announce={false}>
                        No process has started and no assignment is reserved. The saved brief and target are kept; review again to retry.
                      </StateNotice>
                    </div>
                    <RequestedFacts workspace={props.workspaceName || ws()} target={targetLabel(target())} brief={saved()?.brief || 'Recorded'} assignment="Not reserved" digest="Unavailable" />
                    <ActionBar variant="inline">
                      <Show when={saved()} fallback={<button id="launch-assignment-save" class="ds-btn ds-btn--primary" type="button" disabled={!enabled() || Boolean(pending()) || !title().trim()} onClick={save}>Save brief</button>}>
                        <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      </Show>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>Edit assignment</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'result'}>
                    <StateNotice tone={draft()?.result?.kind === 'launched' ? 'success' : 'warning'} announce={false}
                      title={draft()?.result?.kind === 'launched' ? 'Assignment started' : draft()?.result?.kind === 'failed' ? 'Assignment could not start' : 'Launch outcome unconfirmed'}>
                      {draft()?.result?.kind === 'launched'
                        ? 'The host recorded this assignment; starting another from this review is unavailable.'
                        : draft()?.result?.kind === 'failed'
                          ? 'The host confirmed the failure. Correct the assignment before another review.'
                          : 'The acknowledgement was lost after submission. Inspect the recorded result before starting another assignment.'}
                    </StateNotice>
                    <Show when={previewState()} keyed>{preview => <AssignmentContract preview={preview} />}</Show>
                  </Match>
                  <Match when={reviewView() === 'saved'}>
                    <StatusText id="launch-review-status" tone="info">Saved brief ready to review</StatusText>
                    <RequestedFacts workspace={props.workspaceName || ws()} target={targetLabel(target())} brief={saved()?.brief || 'Recorded'} />
                    <ActionBar variant="inline">
                      <button id="launch-assignment-review" class="ds-btn ds-btn--primary" type="button" disabled={!canReview()} onClick={review}>Review assignment</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>Edit assignment</button>
                    </ActionBar>
                  </Match>
                  <Match when={reviewView() === 'unsaved'}>
                    <div id="launch-review-unsaved">
                      <StateNotice tone="warning" title="Unsaved changes are not reviewed" announce={false}>
                        Review cannot approve unsaved edits. Save the brief to review the current text, or edit the assignment.
                      </StateNotice>
                    </div>
                    <ActionBar variant="inline">
                      <button id="launch-assignment-save" class="ds-btn ds-btn--primary" type="button" disabled={!enabled() || Boolean(pending()) || !title().trim()} onClick={save}>Save brief</button>
                      <button id="launch-assignment-edit" class="ds-btn" type="button" onClick={editAssignment}>Edit assignment</button>
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
