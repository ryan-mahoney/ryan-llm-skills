// Request-domain in-memory state owner. One workspace-keyed entry carries the
// typed transcript, removable page scope, selected refs and the request
// identity; pending work stays with its originating entry so navigation cannot
// drop a submitted operation. Synchronous reads/transitions are local; the
// async operations submit only through injectable final boundaries (defaults
// wire api.ts postAudio/postJson and request-audio startCapture) and settle
// captured immutable request snapshots, so an edited transcript, moved scope,
// changed refs or a new request discards late successes AND late errors while
// retaining the previous proposal marked stale. Audio clips stay in memory
// only: nothing is persisted, and only an explicit discard clears clip bytes
// and text. This module's core (store + derivations) is DOM-free,
// transport-free and Node-free.
import { createSignal } from 'solid-js';
import { HttpError, postAudio, postJson } from './api';
import type { WireRecord } from './model';
import {
  coverageStateOf,
  observedSpecReadiness,
  planningAssignmentFor,
} from './readiness';
import { startCapture } from './request-audio';

export type RequestPhase = 'ready' | 'recording' | 'transcribing' | 'interpreting' | 'result' | 'preview' | 'failure';
export type RequestResultVariant = 'proposal' | 'alternatives' | 'clarification' | 'conversation';
export type RequestFailure =
  | 'mic-denied' | 'mic-unavailable' | 'speech-unavailable'
  | 'transcription-failed' | 'no-speech' | 'interpretation-failed'
  | 'offline' | 'input-too-long';

// Request scope: the route workspace plus the optional design or spec entity
// shown as the panel's removable scope line.
export type RequestScope = { workspace: string; design?: string; spec?: string };
export type RequestReference = { kind: string; id: string };

// Immutable request snapshot captured at submit; it alone owns response
// acceptance. The transcribed text of a voice request joins the same snapshot
// (identity unchanged) before interpretation.
export type RequestSnapshot = {
  requestId: string; transcript: string; scope: RequestScope | null; refs: RequestReference[];
};
export type RequestReply = Record<string, unknown>;
export type RequestResult = {
  variant: RequestResultVariant; reply: RequestReply; snapshot: RequestSnapshot;
};
export type RequestPending = {
  kind: 'request'; revision: number; requestId: string;
  snapshot: RequestSnapshot; startedAt: number; promise: Promise<unknown>;
};
export type RequestWork = {
  phase: RequestPhase;
  transcript: string;
  scope: RequestScope | null;
  workspaceSelection: string | null;
  refs: RequestReference[];
  requestId: string | null;
  snapshot: RequestSnapshot | null;
  result: RequestResult | null;
  failure: RequestFailure | null;
  stale: boolean;
  staleReason: string | null;
  clip: Float32Array | null;
  recording: boolean;
  signature: string | null;
  pending: RequestPending | null;
  revision: number;
  primaryAction: { enabled: boolean; reason: string };
};

export type CaptureHandle = { stop(): Promise<Float32Array>; cancel(): void };
export type TranscribeBoundary = (clip: Float32Array, requestId: string, signal?: AbortSignal) => Promise<unknown>;
export type InterpretBoundary = (body: RequestSnapshot, signal?: AbortSignal) => Promise<unknown>;
export type CaptureBoundary = () => Promise<CaptureHandle>;
export type RequestStoreOptions = {
  transcribe?: TranscribeBoundary;
  interpret?: InterpretBoundary;
  capture?: CaptureBoundary;
  now?: () => number;
};

export type RequestStore = {
  getRequest: (workspace: string) => RequestWork | undefined;
  editTranscript: (workspace: string, transcript: string) => RequestWork;
  changeScope: (workspace: string, scope: RequestScope | null, candidates?: string[]) => RequestWork;
  changeRefs: (workspace: string, refs: RequestReference[]) => RequestWork;
  beginRecording: (workspace: string) => Promise<RequestWork>;
  finishRecording: (workspace: string) => Promise<RequestWork>;
  submitRequest: (workspace: string, token: string) => Promise<RequestReply>;
  enterPreview: (workspace: string, signature: string) => RequestWork;
  closePanel: (workspace: string) => RequestWork | undefined;
  discardRequest: (workspace: string) => RequestWork;
};

const STALE_REASON = 'The request changed after this result was returned; submit the current transcript, scope and references again.';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): value is WireRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): WireRecord[] => Array.isArray(value) ? value.filter(object) : [];
const bool = (value: unknown): boolean | null => value === true ? true : value === false ? false : null;

const cloneScope = (scope: RequestScope | null): RequestScope | null => scope ? { ...scope } : null;
const cloneRefs = (refs: readonly RequestReference[]): RequestReference[] =>
  refs.map(reference => ({ kind: reference.kind, id: reference.id }));

const sameScope = (a: RequestScope | null, b: RequestScope | null): boolean =>
  a === b || (!!a && !!b && a.workspace === b.workspace
    && (a.design ?? '') === (b.design ?? '') && (a.spec ?? '') === (b.spec ?? ''));
const sameRefs = (a: readonly RequestReference[], b: readonly RequestReference[]): boolean =>
  a.length === b.length && a.every((reference, index) => reference.kind === b[index].kind && reference.id === b[index].id);

type RequestContent = { transcript: string; scope: RequestScope | null; refs: RequestReference[] };
const sameContent = (snapshot: RequestSnapshot | null, content: RequestContent): boolean =>
  !!snapshot && snapshot.transcript === content.transcript
  && sameScope(snapshot.scope, content.scope) && sameRefs(snapshot.refs, content.refs);
const sameSnapshot = (a: RequestSnapshot | null, b: RequestSnapshot | null): boolean =>
  !!a && !!b && a.requestId === b.requestId && sameContent(a, b);

const transcriptOf = (value: unknown): string =>
  object(value) && typeof value.transcript === 'string' ? value.transcript : '';

const variantOf = (value: unknown): RequestResultVariant => {
  const variant = object(value) ? value.variant : undefined;
  if (variant === 'proposal' || variant === 'alternatives' || variant === 'clarification' || variant === 'conversation') return variant;
  const record = object(value) ? value : {};
  if (list(record.candidates).length > 1) return 'alternatives';
  if (typeof record.question === 'string' && record.question) return 'clarification';
  if (record.proposal) return 'proposal';
  return 'conversation';
};

const failureOf = (error: unknown, stage: 'transcribe' | 'interpret'): RequestFailure => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'mic-denied') return 'mic-denied';
  if (code === 'mic-unavailable') return 'mic-unavailable';
  if (error instanceof HttpError) {
    if (error.reason === 'input-too-long') return 'input-too-long';
    if (error.reason === 'no-speech') return 'no-speech';
    if (error.reason === 'unavailable') return 'speech-unavailable';
    return stage === 'transcribe' ? 'transcription-failed' : 'interpretation-failed';
  }
  return 'offline'; // the transport never produced a decodable reply
};

// Derives the request scope from route/destination parameters so the panel's
// removable scope line reflects the current page. A single candidate workspace
// is not a guess; several candidates require an explicit selection instead.
export type PageContextInput = {
  workspace?: string | null;
  design?: string | null;
  spec?: string | null;
  candidates?: string[];
};
export type PageContext = { scope: RequestScope | null; workspaceSelection: string | null };

export function pageContext(input: PageContextInput = {}): PageContext {
  const candidates = (input.candidates ?? []).filter(value => typeof value === 'string' && Boolean(value));
  const workspace = text(input.workspace) || (candidates.length === 1 ? candidates[0] : '');
  if (!workspace) {
    return {
      scope: null,
      workspaceSelection: candidates.length > 1 ? 'Select a workspace for this request.' : null,
    };
  }
  const design = text(input.design);
  const spec = text(input.spec);
  return {
    scope: design ? { workspace, design } : spec ? { workspace, spec } : { workspace },
    workspaceSelection: null,
  };
}

// Pure derivation of the Implement-spec-style proposal. Owner joining uses
// planningAssignmentFor's exact canonical package identity (exact workspace
// plus exact canonical package path; basename-only must never join).
export type ProposalCandidate = {
  action: string;
  goal?: string;
  workspace?: string;
  package?: string;
  entity?: string;
};
export type ProposalContext = {
  record?: WireRecord | null;
  epics?: WireRecord[];
  assignments?: WireRecord[];
  coverage?: WireRecord | null;
  design?: WireRecord | null;
};
export type ProposalFacts = {
  readiness: string;
  prepared: boolean | null;
  launchable: boolean;
  coverage: string;
  owner: string | null;
  designScreens: number | null;
};
export type ProposalDecision = {
  action: 'open-assignment' | 'prerequisite-missing' | 'launchable';
  reason: string;
  facts: ProposalFacts;
};

const ownerIdentity = (owner: WireRecord): string =>
  [text(owner.display), text(owner.id) || text(owner.assignment_id), text(owner.spec_package)]
    .filter(Boolean).join(' ') || 'live assignment';

export function deriveProposal(candidate: ProposalCandidate, context: ProposalContext = {}): ProposalDecision {
  const record = object(context.record) ? context.record : {};
  const owner = planningAssignmentFor(record, context.assignments);
  const readiness = observedSpecReadiness(record, context.epics ?? [], context.assignments).readiness;
  const coverage = coverageStateOf(record, context.coverage ? { coverage: context.coverage } : {});
  const prepared = readiness.facts?.prepared ?? null;
  const designScreens = object(context.design) ? list(context.design.screens).length : null;
  const facts: ProposalFacts = {
    readiness: readiness.state,
    prepared,
    launchable: readiness.launchable,
    coverage,
    owner: owner ? ownerIdentity(owner) : null,
    designScreens,
  };
  const screenRun = candidate.action === 'build_screens' || candidate.action === 'build-screens';
  if (owner) {
    return { action: 'open-assignment', reason: readiness.reason ?? 'A live assignment owns this package.', facts };
  }
  const missing: string[] = [];
  if (readiness.state !== 'ready' || !readiness.launchable || prepared !== true) {
    missing.push(readiness.reason ?? readiness.proposal + '.');
  }
  if (coverage !== 'complete') missing.push(`Assignment coverage is ${coverage}.`);
  if (screenRun && !(designScreens !== null && designScreens > 0)) {
    missing.push('Observed design planning inputs are missing: no planned screens are recorded.');
  }
  if (missing.length) return { action: 'prerequisite-missing', reason: missing.join(' '), facts };
  return {
    action: 'launchable',
    reason: screenRun ? 'Ready to build the planned screens.' : 'Ready to implement.',
    facts,
  };
}

// Stable comparable signature over preparation facts, prerequisite states,
// owner assignment identity and target choice (workspace/package/target/model).
// Observation timestamps are deliberately excluded: a refreshed observation of
// the same facts must not stale a signature recorded at preview before launch.
export type SignatureFacts = {
  proposal?: boolean | null;
  critique?: boolean | null;
  critiqueRecommended?: boolean | null;
  prepared?: boolean | null;
  steps?: number | null;
  preparation?: WireRecord | null;
  prerequisites?: { name: string; state: string }[];
  owner?: WireRecord | null;
  workspace?: string | null;
  package?: string | null;
  target?: string | null;
  model?: string | null;
  observedAt?: unknown;
  publishedAt?: unknown;
};

export const readinessSignature = (facts: SignatureFacts): string =>
  JSON.stringify([
    [bool(facts.proposal), bool(facts.critique), bool(facts.critiqueRecommended), bool(facts.prepared),
      Number.isSafeInteger(facts.steps) ? facts.steps : null],
    text(facts.preparation?.outcome),
    (facts.prerequisites ?? [])
      .map(fact => [text(fact.name), text(fact.state)])
      .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])),
    object(facts.owner)
      ? [text(facts.owner.id) || text(facts.owner.assignment_id), text(facts.owner.display),
          text(facts.owner.spec_package), text(facts.owner.workspace) || text(facts.owner.workspace_id)]
      : null,
    [text(facts.workspace), text(facts.package), facts.target ?? null, facts.model ?? null],
  ]);

export const signatureChanged = (a: string, b: string): boolean => a !== b;

type RequestEntry = {
  phase: RequestPhase;
  transcript: string;
  scope: RequestScope | null;
  workspaceSelection: string | null;
  refs: RequestReference[];
  requestId: string | null;
  snapshot: RequestSnapshot | null;
  result: RequestResult | null;
  failure: RequestFailure | null;
  stale: boolean;
  staleReason: string | null;
  clip: Float32Array | null;
  recording: boolean;
  signature: string | null;
  pending: RequestPending | null;
  revision: number;
};

const primaryActionOf = (entry: RequestEntry): { enabled: boolean; reason: string } =>
  entry.stale && entry.result ? { enabled: false, reason: entry.staleReason ?? STALE_REASON }
  : entry.workspaceSelection ? { enabled: false, reason: entry.workspaceSelection }
  : { enabled: true, reason: '' };

export function createRequestStore(options: RequestStoreOptions = {}): RequestStore {
  const entries = new Map<string, RequestEntry>();
  const handles = new Map<string, CaptureHandle>();
  const now = options.now ?? (() => Date.now());
  const [version, setVersion] = createSignal(0); // mounted readers subscribe to every entry transition
  const notify = (): void => { setVersion(current => current + 1); };

  const view = (entry: RequestEntry): RequestWork => ({
    ...entry,
    refs: cloneRefs(entry.refs),
    primaryAction: primaryActionOf(entry),
  });

  const ensureEntry = (key: string): RequestEntry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        phase: 'ready', transcript: '', scope: key ? { workspace: key } : null, workspaceSelection: null,
        refs: [], requestId: crypto.randomUUID(), snapshot: null, result: null, failure: null,
        stale: false, staleReason: null, clip: null, recording: false, signature: null,
        pending: null, revision: 0,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  // Every transcript/scope/ref change mints a new request identity, clears the
  // captured snapshot (late replies become inapplicable) and marks a retained
  // proposal stale with the primary action disabled. Failure state belongs to
  // the old request and clears; clip and text survive every non-discard path.
  const contentChanged = (entry: RequestEntry): void => {
    entry.revision += 1;
    entry.requestId = crypto.randomUUID();
    entry.snapshot = null;
    entry.failure = null;
    entry.signature = null;
    if (entry.result) {
      entry.stale = true;
      entry.staleReason = STALE_REASON;
    } else {
      entry.stale = false;
      entry.staleReason = null;
    }
    if (entry.phase === 'transcribing' || entry.phase === 'interpreting' || entry.phase === 'failure') entry.phase = 'ready';
    notify();
  };

  type PendingOutcome = { value?: unknown; error?: unknown };

  // Same registerPending idiom as launch-state: defer one microtask so the
  // captured pending identity is registered before submission starts, share
  // the returned promise exactly for double taps, clear only our own latch,
  // and settle captured snapshots only while the entry is still current.
  const registerPending = <T>(
    key: string,
    entry: RequestEntry,
    requestId: string,
    snapshot: RequestSnapshot,
    run: () => Promise<T>,
    settle: (outcome: PendingOutcome) => void,
  ): Promise<T> => {
    const promise = Promise.resolve().then(run);
    entry.pending = {
      kind: 'request', revision: entry.revision, requestId,
      snapshot, startedAt: now(), promise,
    };
    notify(); // mounted observers see the pending operation begin
    const complete = (outcome: PendingOutcome): void => {
      if (entry.pending?.promise === promise) entry.pending = undefined; // clear only our own latch
      try {
        if (entries.get(key) === entry) settle(outcome);
      } finally {
        notify();
      }
    };
    promise.then(value => complete({ value }), error => complete({ error })).catch(() => undefined);
    return promise;
  };

  const getRequest = (workspace: string): RequestWork | undefined => {
    version(); // subscribe Solid readers to every entry transition
    const entry = entries.get(workspace);
    return entry ? view(entry) : undefined;
  };

  const editTranscript = (workspace: string, transcript: string): RequestWork => {
    const entry = ensureEntry(workspace);
    if (entry.transcript === transcript) return view(entry);
    entry.transcript = transcript;
    contentChanged(entry);
    return view(entry);
  };

  const changeScope = (workspace: string, scope: RequestScope | null, candidates: string[] = []): RequestWork => {
    const entry = ensureEntry(workspace);
    // Removing the entity scope falls back to the same workspace scope; with no
    // route workspace and several candidates an explicit selection is required.
    const derived = scope
      ? {
          scope: {
            workspace: scope.workspace || workspace,
            ...(scope.design ? { design: scope.design } : {}),
            ...(scope.spec ? { spec: scope.spec } : {}),
          },
          workspaceSelection: null,
        }
      : pageContext({ workspace, candidates });
    if (sameScope(entry.scope, derived.scope) && entry.workspaceSelection === derived.workspaceSelection) return view(entry);
    entry.scope = cloneScope(derived.scope);
    entry.workspaceSelection = derived.workspaceSelection;
    contentChanged(entry);
    return view(entry);
  };

  const changeRefs = (workspace: string, refs: RequestReference[]): RequestWork => {
    const entry = ensureEntry(workspace);
    const next = cloneRefs(refs);
    if (sameRefs(entry.refs, next)) return view(entry);
    entry.refs = next;
    contentChanged(entry);
    return view(entry);
  };

  const beginRecording = async (workspace: string): Promise<RequestWork> => {
    const entry = ensureEntry(workspace);
    if (entry.recording) return view(entry);
    const capture = options.capture ?? ((): Promise<CaptureHandle> => startCapture());
    try {
      handles.set(workspace, await capture());
      entry.recording = true;
      entry.phase = 'recording';
      entry.failure = null;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      entry.failure = code === 'mic-denied' ? 'mic-denied' : 'mic-unavailable';
      entry.phase = 'failure';
    }
    notify();
    return view(entry);
  };

  const finishRecording = async (workspace: string): Promise<RequestWork> => {
    const entry = ensureEntry(workspace);
    const handle = handles.get(workspace);
    if (!handle) return view(entry);
    handles.delete(workspace);
    entry.recording = false;
    try {
      // stop() resolves and retains the downsampled clip (step-06 contract).
      entry.clip = await handle.stop();
      entry.phase = entry.result ? 'result' : 'ready';
    } catch (error) {
      // A cancelled handle drops clip bytes; a later stop() rejects 'cancelled'.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'mic-denied') entry.failure = 'mic-denied';
      else if (code !== 'cancelled') entry.failure = 'mic-unavailable';
      entry.phase = entry.failure ? 'failure' : entry.result ? 'result' : 'ready';
    }
    notify();
    return view(entry);
  };

  const submitRequest = (workspace: string, token: string): Promise<RequestReply> => {
    const key = workspace;
    const entry = ensureEntry(key);
    const content: RequestContent = {
      transcript: entry.transcript, scope: cloneScope(entry.scope), refs: cloneRefs(entry.refs),
    };
    const inFlight = entry.pending;
    // An unchanged retry or double tap joins/shares the in-flight promise.
    if (inFlight && sameContent(entry.snapshot, content)) return inFlight.promise as Promise<RequestReply>;
    // An unchanged retry reuses the same UUID; changed content already minted a
    // fresh one through contentChanged.
    const requestId = (sameContent(entry.snapshot, content) ? entry.snapshot!.requestId : entry.requestId) ?? crypto.randomUUID();
    entry.requestId = requestId;
    let accepted: RequestSnapshot = { requestId, ...content };
    entry.snapshot = accepted;
    entry.failure = null;
    const clip = entry.clip;
    const transcribe = options.transcribe ?? ((body: Float32Array, _requestId: string, signal?: AbortSignal) =>
      postAudio('/api/request/transcribe', body, token, signal));
    const interpret = options.interpret ?? ((body: RequestSnapshot, signal?: AbortSignal) =>
      postJson('/api/request/interpret', body, token, signal));
    // The captured snapshot alone owns acceptance; edits, scope/refs changes and
    // new requests move entry.snapshot and silently discard late outcomes.
    const isCurrent = (): boolean => entries.get(key) === entry && sameSnapshot(entry.snapshot, accepted);
    let stage: 'transcribe' | 'interpret' = 'interpret';
    const run = async (): Promise<RequestReply> => {
      if (clip) {
        stage = 'transcribe';
        if (isCurrent()) { entry.phase = 'transcribing'; notify(); }
        const transcription = await transcribe(clip, requestId);
        const spoken = transcriptOf(transcription);
        // The transcribed text joins the same request: identity is unchanged and
        // the snapshot moves together, keeping the interpret reply acceptable.
        if (spoken && isCurrent()) {
          entry.transcript = spoken;
          accepted = { ...accepted, transcript: spoken };
          entry.snapshot = accepted;
          notify();
        }
      }
      stage = 'interpret';
      if (isCurrent()) { entry.phase = 'interpreting'; notify(); }
      return (await interpret(accepted)) as RequestReply;
    };
    return registerPending(key, entry, requestId, accepted, run, outcome => {
      if (!sameSnapshot(entry.snapshot, accepted)) return; // superseded: discard silently
      if (outcome.error !== undefined) {
        // Failure variants retain the transcript; transcription/interpretation
        // failures also retain the clip for retry.
        entry.failure = failureOf(outcome.error, stage);
        entry.phase = 'failure';
        return;
      }
      entry.result = { variant: variantOf(outcome.value), reply: object(outcome.value) ? outcome.value : {}, snapshot: accepted };
      entry.failure = null;
      entry.stale = false;
      entry.staleReason = null;
      entry.phase = 'result';
    });
  };

  // Preview records the readiness signature; before launch a changed signature
  // means relevant facts moved since the preview.
  const enterPreview = (workspace: string, signature: string): RequestWork => {
    const entry = ensureEntry(workspace);
    entry.signature = signature;
    if (entry.result) entry.phase = 'preview';
    notify();
    return view(entry);
  };

  // Close while recording cancels the capture handle (tracks stop inside the
  // request-audio cleanup); every other phase retains state and a pending
  // request continues.
  const closePanel = (workspace: string): RequestWork | undefined => {
    const entry = entries.get(workspace);
    if (!entry) return undefined;
    const handle = handles.get(workspace);
    if (handle) {
      handles.delete(workspace);
      handle.cancel();
      entry.recording = false;
      if (entry.phase === 'recording') entry.phase = entry.result ? 'result' : 'ready';
      notify();
    }
    return view(entry);
  };

  // The only transition that clears audio clip bytes and typed text.
  const discardRequest = (workspace: string): RequestWork => {
    const entry = ensureEntry(workspace);
    const handle = handles.get(workspace);
    if (handle) {
      handles.delete(workspace);
      handle.cancel();
      entry.recording = false;
    }
    entry.transcript = '';
    entry.clip = null;
    entry.result = null;
    entry.failure = null;
    entry.stale = false;
    entry.staleReason = null;
    entry.snapshot = null;
    entry.signature = null;
    entry.requestId = crypto.randomUUID();
    entry.phase = 'ready';
    entry.revision += 1;
    notify();
    return view(entry);
  };

  return {
    getRequest,
    editTranscript,
    changeScope,
    changeRefs,
    beginRecording,
    finishRecording,
    submitRequest,
    enterPreview,
    closePanel,
    discardRequest,
  };
}

const requestStore = createRequestStore();

export const getRequest = requestStore.getRequest;
export const editTranscript = requestStore.editTranscript;
export const changeScope = requestStore.changeScope;
export const changeRefs = requestStore.changeRefs;
export const beginRecording = requestStore.beginRecording;
export const finishRecording = requestStore.finishRecording;
export const submitRequest = requestStore.submitRequest;
export const enterPreview = requestStore.enterPreview;
export const closePanel = requestStore.closePanel;
export const discardRequest = requestStore.discardRequest;
