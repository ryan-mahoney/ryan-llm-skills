import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { REQUEST_LIMITS } from '../../../workspaces/request-actions.mjs';
import { RegionalSkeleton, StateNotice } from './primitives';
import {
  beginRecording,
  cancelRecording as cancelRecordingAction,
  discardRequest,
  editTranscript,
  finishRecording,
  getRequest,
  submitRequest,
  transcribeClip,
} from './request-state';
import type { CaptureHooks, RequestFailure, RequestWork } from './request-state';

export type RequestWorkScopeLine = { label: string; kind: string };

// Speech readiness observed from GET /api/request/speech (cached by the app):
// 'checking' is the pre-fetch state, 'unavailable' carries the screen-18
// visible reason for the disabled recording control.
export type SpeechStatus = { state: 'ready' | 'unavailable' | 'checking'; host?: string; reason?: string };

export type RequestWorkPanelProps = {
  open: boolean;
  onClose(): void;
  scope?: RequestWorkScopeLine;
  onRemoveScope?: () => void;
  // Store key (the route workspace), the /api/request action token and the
  // live-connection flag; interpretation stays disabled without them.
  workspace?: string;
  token?: string;
  live?: boolean;
  speech?: SpeechStatus;
  children?: JSX.Element;
};

const EMPTY_WORK: RequestWork = {
  phase: 'ready', transcript: '', scope: null, workspaceSelection: null, refs: [],
  requestId: null, snapshot: null, result: null, failure: null, stale: false, staleReason: null,
  clip: null, clipNeedsTranscription: false, recording: false, signature: null, pending: null,
  revision: 0, binding: null, primaryAction: { enabled: true, reason: '' },
};

const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

// Screen-2 disclosure adapted to production names: the local speech host
// transcribes; the transcript and this context reach the interpretation model
// through Pi/OpenRouter.
const disclosureOf = (host: string | undefined): string =>
  `Up to 30 seconds. Audio is transcribed locally on ${host || 'the speech host'}; `
  + 'the transcript and this context go to the interpretation model through Pi/OpenRouter.';

// Failure copy per state (screens 17–20 + offline): the long body is the
// announce:false StateNotice text, the short line is what the single polite
// live region announces, and the hint is the field-adjacent reason line.
type FailureCopy = { body: string; announce: string; hint: string };
const failureCopyOf = (failure: RequestFailure, host: string | undefined, seconds: number): FailureCopy => {
  const on = host ? ` on ${host}` : '';
  const recorded = clock(seconds);
  switch (failure) {
    case 'mic-denied':
      return {
        body: 'This browser isn’t letting Sentinel use the microphone. Allow microphone access in the site settings, then choose Start recording. You can type your request now.',
        announce: 'Microphone blocked. You can type your request.',
        hint: 'Recording needs microphone access.',
      };
    case 'mic-unavailable':
      return {
        body: `Sentinel can’t reach a microphone${on}. Check the input device settings, then choose Start recording. You can type your request now.`,
        announce: 'Microphone unavailable. You can type your request.',
        hint: 'Recording needs microphone access.',
      };
    case 'speech-unavailable':
      return {
        body: 'The host’s speech model hasn’t been prepared, so recordings can’t be transcribed. Typing works normally.',
        announce: `Speech recognition is not ready${on}. Typing works.`,
        hint: 'Recording returns when the host’s speech model is prepared.',
      };
    case 'transcription-failed':
      return {
        body: `The speech service${on} stopped before returning text. Your ${recorded} recording is kept until you close this panel.`,
        announce: 'Transcription failed. Your recording is kept.',
        hint: `Recording kept · ${recorded}`,
      };
    case 'no-speech':
      return {
        body: `No speech was detected in your ${recorded} recording. It is kept until you close this panel; you can also type your request.`,
        announce: 'No speech was detected. Your recording is kept.',
        hint: `Recording kept · ${recorded}`,
      };
    case 'interpretation-failed':
      return {
        body: 'The interpretation model didn’t respond in time. Your request is unchanged; retry, or edit it first.',
        announce: 'Sentinel could not interpret this request. Your request is unchanged.',
        hint: recorded === '0:00' ? '' : `Recorded ${recorded}`,
      };
    case 'offline':
      return {
        body: 'Reconnecting. Your request is kept here and will be interpreted once Sentinel is reachable again.',
        announce: 'Connection lost. Reconnecting. Your request is kept.',
        hint: recorded === '0:00' ? '' : `Recorded ${recorded}`,
      };
    case 'input-too-long':
      return {
        body: `Requests are limited to ${REQUEST_LIMITS.transcriptChars} characters. Shorten the request, then interpret again.`,
        announce: 'The request is too long to interpret.',
        hint: '',
      };
  }
};

const tooLongCopy = `Requests are limited to ${REQUEST_LIMITS.transcriptChars} characters. Shorten the request before interpreting it.`;

// ---- body state blocks ----------------------------------------------------
// Each block mirrors one design screen (02–05, 16–20); every StateNotice and
// RegionalSkeleton is announce:false so the panel's single polite live region
// owns all announcements.

function RequestField(props: {
  value: string;
  overLimit: boolean;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  return (
    <div class="cmd-request">
      <textarea
        id="request-work-text"
        class="ds-input"
        rows={4}
        value={props.value}
        placeholder={props.placeholder}
        aria-describedby={props.overLimit ? 'request-work-length-error' : undefined}
        onInput={event => props.onInput(event.currentTarget.value)}
      />
    </div>
  );
}

function RecordingReadout(props: { elapsed: number; total: number; level: number }) {
  const filled = () => Math.round(Math.max(0, Math.min(1, props.level)) * 8);
  return (
    <>
      <div class="rec-live">
        <span class="rec-dot" aria-hidden="true" />
        <span class="rec-label">Recording</span>
        <div class="rec-levels" aria-hidden="true">
          <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
            {index => <span class={index < filled() ? 'on' : ''} />}
          </For>
        </div>
        <span class="rec-clock">{clock(props.elapsed)} of {clock(props.total)}</span>
      </div>
      <div class="rec-bar" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(1, (props.total - props.elapsed) / props.total)) * 100}%` }} />
      </div>
    </>
  );
}

function ReadyNotes() {
  return (
    <section class="req-notes">
      <h3>Sentinel can start</h3>
      <ul>
        <li><strong>Plan an epic</strong> — Split a workspace goal into member spec packages</li>
        <li><strong>Build screens</strong> — Produce a planned design package</li>
        <li><strong>Implement a spec</strong> — Run a prepared spec package</li>
      </ul>
      <p class="hint">Other requests can continue as a conversation.</p>
    </section>
  );
}

function LimitNotice() {
  return (
    <div class="req-notice">
      <StateNotice announce={false} tone="warning" title="Recording stopped at the 30 second limit">
        Everything up to the limit was transcribed. Type the rest of your request, or interpret what was captured.
      </StateNotice>
    </div>
  );
}

function TranscribingStatus(props: { seconds: number; host?: string }) {
  const text = () => `Transcribing ${clock(props.seconds)} of audio${props.host ? ` on ${props.host}` : ''}`;
  return (
    <div class="req-notice">
      <StateNotice announce={false}>{text()}</StateNotice>
      <RegionalSkeleton rows={2} announce={false} />
    </div>
  );
}

function InterpretingStatus(props: { scopeLabel: string }) {
  return (
    <div class="req-notice">
      <p class="hint">Editing the request replaces this interpretation.</p>
      <StateNotice announce={false}>{`Interpreting request with ${props.scopeLabel} context`}</StateNotice>
    </div>
  );
}

function FailureNotice(props: { copy: FailureCopy }) {
  return (
    <div class="req-notice" id="request-work-failure" tabindex={-1}>
      <StateNotice announce={false} tone="error">{props.copy.body}</StateNotice>
    </div>
  );
}

type FooterAction = {
  label: string;
  run: () => void;
  primary?: boolean;
  disabledReason?: string;
  // Visible explanation for an enabled action (screen 17's mic reason).
  note?: string;
  id?: string;
};

// Per-state footer (thumb zone): exactly one primary where a forward action
// exists; disabled actions keep the dashed variant and expose their visible
// reason through the shared foot-note and title.
function RequestFooter(props: { note: string; actions: FooterAction[]; placeholders?: boolean }) {
  return (
    <div class="cmd-foot">
      <Show
        when={!props.placeholders}
        fallback={
          <>
            <p class="foot-note">Actions become available once a request is interpreted.</p>
            <button type="button" class="ds-btn" disabled>Start conversation</button>
            <button type="button" class="ds-btn ds-btn--primary" disabled>Plan epic</button>
          </>
        }
      >
        <p class="foot-note" id="request-work-foot-note">{props.note}</p>
        <For each={props.actions}>
          {action => (
            <button
              type="button"
              id={action.id}
              class={action.primary ? 'ds-btn ds-btn--primary' : 'ds-btn'}
              disabled={Boolean(action.disabledReason)}
              title={action.disabledReason ?? action.note}
              aria-describedby={action.disabledReason || action.note ? 'request-work-foot-note' : undefined}
              onClick={() => action.run()}
            >
              {action.label}
            </button>
          )}
        </For>
      </Show>
    </div>
  );
}

// Step-9/10 command panel shell plus the request capture and recovery states
// (screens 2–5, 16–20). The native dialog supplies the modal and focus trap;
// Escape is routed through onCancel so closing this panel can never cancel
// launched work (INV-1). State authority is ./request-state (transcript,
// clip, identity, pending pipeline); this component owns only presentation,
// the recording timer/level readout and the action wiring. The export is named
// RequestWorkPanel because request-state.ts already exports a RequestWork
// type.
export default function RequestWorkPanel(props: RequestWorkPanelProps) {
  let dialog!: HTMLDialogElement;
  let heading!: HTMLHeadingElement;

  const work = createMemo((): RequestWork => getRequest(props.workspace ?? '') ?? EMPTY_WORK);
  const phase = createMemo(() => work().phase);
  const clipSeconds = createMemo(() => {
    const clip = work().clip;
    return clip ? clip.length / REQUEST_LIMITS.sampleRateHz : 0;
  });

  // Recording readout: local interval clock capped at the 30 s limit and a
  // level signal fed by the capture hook (throttled to ~150 ms).
  const [elapsed, setElapsed] = createSignal(0);
  const [level, setLevel] = createSignal(0);
  let lastLevelAt = 0;
  const hooks: CaptureHooks = {
    onLevel: value => {
      const at = Date.now();
      if (at - lastLevelAt < 150) return;
      lastLevelAt = at;
      setLevel(value);
    },
    onLimit: () => { void handleLimit(); },
  };
  createEffect(() => {
    if (!work().recording) {
      setElapsed(0);
      setLevel(0);
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Math.min(REQUEST_LIMITS.recordingSeconds, (Date.now() - startedAt) / 1000));
    }, 250);
    onCleanup(() => clearInterval(timer));
  });

  const ws = (): string => props.workspace ?? '';
  const token = (): string => props.token ?? '';

  // The limit path auto-transcribes only and then waits here for the explicit
  // Interpret request; the manual Stop path keeps submitRequest's
  // transcribe-then-interpret pipeline. limitPath picks the matching
  // transcription retry.
  const [limitNotice, setLimitNotice] = createSignal(false);
  const [limitPath, setLimitPath] = createSignal(false);

  const startRecording = (): void => {
    setLimitNotice(false);
    void beginRecording(ws(), hooks);
  };
  const stopRecording = (): void => {
    setLimitPath(false);
    setLimitNotice(false);
    void (async () => {
      await finishRecording(ws());
      await submitRequest(ws(), token());
    })().catch(() => undefined);
  };
  const handleLimit = async (): Promise<void> => {
    setLimitPath(true);
    setLimitNotice(true);
    await finishRecording(ws());
    try {
      await transcribeClip(ws(), token());
    } catch {
      // The store recorded the failure variant; the footer offers the retry.
    }
    // Screen 16: caret at the end of the installed transcript.
    const field = dialog.querySelector<HTMLTextAreaElement>('#request-work-text');
    if (field) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
  };
  const cancelRecording = (): void => {
    setLimitNotice(false);
    cancelRecordingAction(ws());
  };
  const cancelRequest = (): void => {
    setLimitNotice(false);
    setLimitPath(false);
    discardRequest(ws());
  };
  const retryTranscription = (): void => {
    const run = limitPath() ? transcribeClip(ws(), token()) : submitRequest(ws(), token());
    void Promise.resolve(run).catch(() => undefined);
  };
  const interpret = (): void => {
    setLimitNotice(false);
    void Promise.resolve(submitRequest(ws(), token())).catch(() => undefined);
  };

  // ---- derived state ------------------------------------------------------
  const overLimit = createMemo(() => work().transcript.length > REQUEST_LIMITS.transcriptChars);
  const speechHost = createMemo(() => props.speech?.host);
  const scopeLabel = createMemo(() => props.scope?.label ?? ws());

  const recordReason = createMemo((): string => {
    const speech = props.speech;
    if (speech?.state === 'ready') return '';
    if (speech?.state === 'checking') return 'Speech readiness is being checked.';
    return speech?.reason ?? 'Recording returns when the host’s speech model is prepared.';
  });
  // Mirrors App's newThreadUnavailableReason wording; checked in the order the
  // card lists: empty, over-limit, store primary reason, then live/token.
  const interpretReason = createMemo((): string => {
    const current = work();
    if (!current.transcript.trim()) return 'Type your request before interpreting.';
    if (overLimit()) return `Requests are limited to ${REQUEST_LIMITS.transcriptChars} characters.`;
    if (!current.primaryAction.enabled) return current.primaryAction.reason;
    if (props.live === false) return 'Interpret request is available on the live dashboard.';
    if (!token()) return 'Reconnect to the live dashboard before interpreting this request.';
    return '';
  });
  const interpretLabel = createMemo(() =>
    work().stale && work().result ? 'Interpret again' : 'Interpret request');

  const hintText = createMemo((): string => {
    const current = work();
    const recorded = clock(clipSeconds());
    if (current.phase === 'recording') return 'Text appears when you stop';
    if (current.phase === 'transcribing' || current.phase === 'interpreting') return `Recorded ${recorded}`;
    if (limitNotice() && current.phase === 'ready') return `Recorded ${recorded} · limit reached`;
    if (current.phase === 'failure' && current.failure) {
      return failureCopyOf(current.failure, speechHost(), clipSeconds()).hint;
    }
    return '';
  });

  const actions = createMemo((): FooterAction[] => {
    const current = work();
    // The interpret action always carries the interpretation gates (empty or
    // over-limit transcript, stale store result, missing live/token) as its
    // visible reason. Primary placement follows the reference footers.
    const interpretAction = (primary: boolean): FooterAction => ({
      label: interpretLabel(),
      primary,
      disabledReason: interpretReason() || undefined,
      run: interpret,
    });
    const startAction = (primary: boolean, note?: string): FooterAction => ({
      label: 'Start recording',
      primary,
      note,
      disabledReason: recordReason() || undefined,
      run: startRecording,
      id: 'request-work-start',
    });
    // Screens 16/19: Record again discards the kept clip and records anew.
    const recordAgain = (): void => {
      cancelRecording();
      startRecording();
    };
    if (current.phase === 'recording') {
      return [
        { label: 'Cancel recording', run: cancelRecording },
        { label: 'Stop recording', primary: true, run: stopRecording },
      ];
    }
    if (current.phase === 'transcribing' || current.phase === 'interpreting') {
      return [{ label: 'Cancel request', run: cancelRequest }];
    }
    if (current.phase === 'failure') {
      switch (current.failure) {
        case 'mic-denied':
        case 'mic-unavailable':
          // Screen 17: re-attempt recording is the primary; typing keeps working.
          return [
            interpretAction(false),
            startAction(true, 'Recording needs microphone access.'),
          ];
        case 'speech-unavailable':
          // Screen 18: Start recording stays disabled with its visible reason.
          return [startAction(false), interpretAction(true)];
        case 'transcription-failed':
        case 'no-speech':
          return [
            { label: 'Record again', run: recordAgain },
            { label: 'Retry transcription', primary: true, run: retryTranscription },
          ];
        case 'interpretation-failed':
        case 'input-too-long':
          return [
            { label: 'Record again', run: recordAgain },
            { label: 'Retry interpretation', primary: true, run: interpret },
          ];
        case 'offline':
          // Screen 23: Retry connection reconnects and interprets the kept request.
          return [
            { label: 'Cancel request', run: cancelRequest },
            { label: 'Retry connection', primary: true, run: interpret },
          ];
      }
    }
    if (limitNotice() && current.phase === 'ready') {
      return [{ label: 'Record again', run: recordAgain }, interpretAction(true)];
    }
    // Ready (screen 2): Start recording is the reference footer's one primary
    // and the interpret action stays gated with its visible reason.
    return [interpretAction(false), startAction(true)];
  });
  const footNote = createMemo(() =>
    actions().map(action => action.note ?? action.disabledReason).filter(Boolean).join(' '));

  // Exactly one polite live region announces recording started, transcribing,
  // interpreted and failures; the short lines come from the screen copy.
  const announcement = createMemo((): string => {
    const current = work();
    if (current.phase === 'recording') return 'Recording started.';
    if (current.phase === 'transcribing') return 'Transcribing.';
    if (current.phase === 'result') return 'Request interpreted.';
    if (current.phase === 'failure' && current.failure) {
      return failureCopyOf(current.failure, speechHost(), clipSeconds()).announce;
    }
    if (current.phase === 'ready' && limitNotice()) return 'Recording stopped at the 30 second limit.';
    if (current.phase === 'ready' && props.speech?.state === 'unavailable') {
      return failureCopyOf('speech-unavailable', speechHost(), 0).announce;
    }
    return '';
  });

  // ---- dialog + focus routing --------------------------------------------
  // Open in ready focuses Start recording (textarea when the control is
  // disabled); transcribing focuses the heading; failure focuses the notice
  // region (fallback: the typed field). Later transitions never steal focus
  // except into transcribing/failure. Heading focus suppression stays.
  let focusKey = '';
  createEffect(() => {
    if (props.open) {
      if (!dialog.open) dialog.showModal();
    } else {
      focusKey = '';
      if (dialog.open) dialog.close();
      return;
    }
    const current = phase();
    const opened = focusKey === '';
    if (current === focusKey) return;
    focusKey = current;
    if (!opened && current !== 'transcribing' && current !== 'failure') return;
    const start = dialog.querySelector<HTMLButtonElement>('#request-work-start');
    const field = dialog.querySelector<HTMLTextAreaElement>('#request-work-text');
    const failureRegion = dialog.querySelector<HTMLElement>('#request-work-failure');
    const target = current === 'transcribing' ? heading
      : current === 'failure' ? (failureRegion ?? field ?? heading)
      : current === 'recording' || current === 'interpreting' || current === 'result' || current === 'preview'
        ? heading
        : ((start && !start.disabled) ? start : (field ?? heading));
    target.focus({ preventScroll: true });
  });

  return (
    <dialog
      id="request-work-dialog"
      class="request-work"
      aria-labelledby="request-work-title"
      ref={dialog}
      onCancel={event => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div class="cmd-head">
        <h2 id="request-work-title" tabindex="-1" ref={heading}>Request work</h2>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close request panel"
          title="Close (Esc)"
          onClick={() => props.onClose()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <Show when={props.scope}>
        {scope => (
          <div class="cmd-context">
            <span class="ctx-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>
              <span>Context: <strong>{scope().label}</strong> · {scope().kind}</span>
            </span>
            <Show when={props.onRemoveScope}>
              <button
                type="button"
                class="ctx-remove"
                aria-label="Remove context"
                title="Remove context"
                onClick={() => props.onRemoveScope?.()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            </Show>
          </div>
        )}
      </Show>
      <div class="cmd-body">
        <Show when={limitNotice() && phase() === 'ready'}>
          <LimitNotice />
        </Show>
        <Show when={phase() === 'failure' && work().failure}>
          <FailureNotice copy={failureCopyOf(work().failure!, speechHost(), clipSeconds())} />
        </Show>
        <div class="req-top">
          <label for="request-work-text">Request</label>
          <span class="muted">{hintText()}</span>
        </div>
        <RequestField
          value={work().transcript}
          overLimit={overLimit()}
          placeholder={work().recording ? 'Text appears when you stop' : undefined}
          onInput={value => editTranscript(ws(), value)}
        />
        <Show when={overLimit()}>
          <p class="req-error" id="request-work-length-error">{tooLongCopy}</p>
        </Show>
        <Show when={phase() === 'ready' && !limitNotice()}>
          <div class="req-tools"><span class="hint">{disclosureOf(speechHost())}</span></div>
        </Show>
        <Show when={work().recording}>
          <RecordingReadout elapsed={elapsed()} total={REQUEST_LIMITS.recordingSeconds} level={level()} />
        </Show>
        <Show when={phase() === 'ready' && !limitNotice()}>
          <ReadyNotes />
        </Show>
        <Show when={phase() === 'transcribing'}>
          <TranscribingStatus seconds={clipSeconds()} host={speechHost()} />
        </Show>
        <Show when={phase() === 'interpreting'}>
          <InterpretingStatus scopeLabel={scopeLabel()} />
        </Show>
        <Show when={phase() === 'ready' && !limitNotice() && props.speech?.state === 'unavailable'}>
          <FailureNotice copy={failureCopyOf('speech-unavailable', speechHost(), 0)} />
        </Show>
        <Show when={phase() === 'result'}>
          <div class="req-notice">
            <StateNotice announce={false}>Request interpreted.</StateNotice>
          </div>
        </Show>
        {props.children}
      </div>
      <RequestFooter note={footNote()} actions={actions()} placeholders={phase() === 'result' || phase() === 'preview'} />
      <p class="sr-only" role="status" aria-live="polite">{announcement()}</p>
    </dialog>
  );
}
