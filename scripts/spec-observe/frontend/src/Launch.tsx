// Launch brief composition for the hidden Agents-child flow. This surface
// edits one workspace-scoped draft owned by launch-state.ts; every mutation
// goes through the store, and api.ts remains the only transport owner.
import { For, Show, createEffect, createMemo, createSignal, on, onMount } from 'solid-js';
import BriefComposer from './BriefComposer';
import { ActionBar, StateNotice } from './primitives';
import { str } from './format';
import { changeLaunchTarget, editLaunchDraft, getLaunchDraft, resolveLaunchStage, saveLaunchDraft, seedLaunchDraft, type LaunchContext, type LaunchDraftError } from './launch-state';
import type { BriefReference } from './composerTypes';
import type { WireRecord } from './model';
import type { RouteState } from './route';

export type LaunchProps = {
  route: RouteState;
  live: boolean;
  token?: string;
  workspace?: WireRecord;
  workspaceName: string;
  onReturnToAgents(): void;
};

export default function Launch(props: LaunchProps) {
  let heading: HTMLHeadingElement | undefined;
  let titleInput: HTMLInputElement | undefined;
  let errorRegion: HTMLDivElement | undefined;
  const [titleError, setTitleError] = createSignal('');
  const [announcer, setAnnouncer] = createSignal('');

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
  const saved = () => draft()?.saved;
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
  const suggestionSource = createMemo(() => ({
    path: '/api/dispatch/suggestions',
    params: {
      workspace_id: ws(),
      ...(props.route.target ? { repository_id: props.route.target } : {}),
    },
  }));
  const targetLabel = (value: string | null | undefined) => value || 'Whole workspace';

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
    if (id && id !== previous) setAnnouncer('Brief saved. Saving the brief does not start an agent or send a thread message.');
  }, { defer: true }));
  createEffect(on(saveFailure, failure => {
    if (!failure) return;
    setAnnouncer('Brief could not be saved. Your title, content and selected target are kept. Retry the same brief.');
    queueMicrotask(() => errorRegion?.focus({ preventScroll: true }));
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

  return (
    <div class="full-page">
      <div class="flow">
        <Show when={ws()} fallback={<StateNotice tone="info" title="Choose a workspace">Select a workspace in the rail to prepare an assignment brief.</StateNotice>}>
          <nav class="flow-steps" aria-label="Assignment steps">
            <span class={stage() === 'brief' ? 'current' : ''}><b>1</b>Brief</span>
            <span class={stage() === 'review' ? 'current' : ''}><b>2</b>Review</span>
            <span class={stage() === 'result' || stage() === 'inspection' ? 'current' : ''}><b>3</b>Result</span>
          </nav>
          <h2 id="launch-heading" tabindex="-1" ref={heading}>Prepare assignment</h2>
          <p class="muted">{props.workspaceName} · New background agent</p>
          <Show when={props.live} fallback={<StateNotice tone="info" title="Launch requires the live dashboard">Open the host dashboard to prepare and save an assignment brief. Imported snapshots cannot reach the launch service.</StateNotice>}>
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
              <Show when={draft()?.preview} keyed>
                {preview => (
                  <section id="launch-review" class="launch-review" aria-labelledby="launch-review-heading">
                    <h3 id="launch-review-heading">Assignment review</h3>
                    <dl class="launch-facts">
                      <div><dt>Target</dt><dd class="mono">{str(preview.record.repository_id) || targetLabel(target())}</dd></div>
                      <div><dt>Brief</dt><dd class="mono">{str(preview.record.brief) || 'Recorded'}</dd></div>
                      <div><dt>Contract digest</dt><dd class="mono">{preview.contractDigest}</dd></div>
                    </dl>
                  </section>
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
          <span class="sr-only" aria-live="polite">{announcer()}</span>
        </Show>
      </div>
    </div>
  );
}
