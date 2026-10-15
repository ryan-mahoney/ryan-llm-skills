// Request-domain in-memory state owner. One workspace-keyed entry carries the
// typed transcript, removable page scope, selected refs and the request
// identity; pending work stays with its originating entry so navigation cannot
// drop a submitted operation. Synchronous reads/transitions are local; the
// async operations submit only through injectable final boundaries (defaults
// wire api.ts postAudio/postJson and request-audio startCapture) and settle
// captured immutable request snapshots, so an edited transcript, moved scope,
// changed refs, an accepted new recording or a new request discards late
// successes AND late errors while retaining the previous proposal marked
// stale. Audio clips stay in memory only: nothing is persisted, an explicit
// discard clears clip bytes and text, and Cancel recording discards just the
// captured audio. This module's core (store + derivations) is DOM-free,
// transport-free and Node-free.
import { createSignal } from 'solid-js';
import { HttpError, postAudio, postJson } from './api';
import { seedNewThreadDraft } from './conversations-state';
import { base } from './format';
import {
  packageLaunchPresentation,
  plannedTargetChoices,
  seedColdHandoff,
  specHandoffInput,
  startPackageHandoff,
} from './launch-handoff';
import type { HandoffInput } from './launch-handoff';
import {
  editLaunchDraft,
  getLaunchDraft,
  launchReviewedDraft,
  reviewLaunchDraft,
  saveLaunchDraft,
  seedLaunchDraft,
} from './launch-state';
import type { LaunchContext } from './launch-state';
import type { WireRecord } from './model';
import {
  coverageStateOf,
  observedSpecReadiness,
  planningAssignmentFor,
  planningFactsFor,
} from './readiness';
import { startCapture } from './request-audio';
import { busyAgentsHref, parseHash } from './route';
import type { RouteState } from './route';
import { REQUEST_ACTIONS, requestBrief } from '../../../workspaces/request-actions.mjs';

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
  clipNeedsTranscription: boolean;
  recording: boolean;
  signature: string | null;
  pending: RequestPending | null;
  revision: number;
  binding: ProposalBinding | null;
  primaryAction: { enabled: boolean; reason: string };
};

export type CaptureHandle = { stop(): Promise<Float32Array>; cancel(): void };
// Capture level/limit callbacks forwarded through the boundary to request-audio
// startCapture; the recording limit drives the auto-transcribe path.
export type CaptureHooks = { onLevel?: (level: number) => void; onLimit?: () => void };
export type TranscribeBoundary = (clip: Float32Array, requestId: string, signal?: AbortSignal) => Promise<unknown>;
export type InterpretBoundary = (body: RequestSnapshot, signal?: AbortSignal) => Promise<unknown>;
export type CaptureBoundary = (hooks?: CaptureHooks) => Promise<CaptureHandle>;
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
  beginRecording: (workspace: string, hooks?: CaptureHooks) => Promise<RequestWork>;
  finishRecording: (workspace: string) => Promise<RequestWork>;
  cancelRecording: (workspace: string) => RequestWork;
  transcribeClip: (workspace: string, token: string) => Promise<RequestWork>;
  submitRequest: (workspace: string, token: string) => Promise<RequestReply>;
  enterPreview: (workspace: string, signature: string) => RequestWork;
  closePanel: (workspace: string) => RequestWork | undefined;
  discardRequest: (workspace: string) => RequestWork;
  prepareProposal: (workspace: string, candidate: ProposalCandidate, environment: ProposalEnvironment, options?: PrepareProposalOptions) => Promise<ProposalOutcome>;
  reviewProposal: (workspace: string, environment: ProposalEnvironment) => Promise<ProposalOutcome>;
  launchProposal: (workspace: string, environment: ProposalEnvironment) => Promise<ProposalOutcome>;
  startConversation: (workspace: string, environment: ProposalEnvironment) => RequestWork | undefined;
  openAgent: (workspace: string, environment: ProposalEnvironment, assignmentId: string) => void;
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

// The owning route shapes: serveTranscribe replies {request_id, text, seconds}
// and serveInterpret replies {request_id, resolution, candidates, clarification}.
// Decode those fields explicitly so real speech, a real single-candidate
// proposal and a real clarification survive; anything unrecognized is plain
// conversation.
const transcriptOf = (value: unknown): string =>
  object(value) && typeof value.text === 'string' ? value.text : '';

const variantOf = (value: unknown): RequestResultVariant => {
  const record = object(value) ? value : {};
  const resolution = record.resolution;
  if (resolution === 'clarification') return 'clarification';
  if (resolution === 'proposal') return list(record.candidates).length > 1 ? 'alternatives' : 'proposal';
  return 'conversation'; // 'unsupported' and unrecognized replies
};

// The shipped HTTP contracts: POST /api/request/transcribe?request_id=<uuid>
// carries the mono PCM clip as its body, and POST /api/request/interpret
// carries {request_id, workspace_id, transcript, context, resolved_refs}. The
// scope's entity page becomes the navigation context and typed refs serialize
// as their <kind>:<id> route strings.
const transcribePath = (requestId: string): string => `/api/request/transcribe?request_id=${requestId}`;
const interpretBodyOf = (snapshot: RequestSnapshot): RequestReply => ({
  request_id: snapshot.requestId,
  workspace_id: text(snapshot.scope?.workspace),
  transcript: snapshot.transcript,
  context: {
    ...(snapshot.scope?.design ? { design: snapshot.scope.design } : {}),
    ...(snapshot.scope?.spec ? { spec: snapshot.scope.spec } : {}),
  },
  resolved_refs: snapshot.refs.map(reference => `${reference.kind}:${reference.id}`),
});

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
// The shipped candidate shape from request-interpret: the entity is a typed
// catalog reference (spec:<slug>, design:<slug> or workspace:<id>) and the
// remaining fields are the validated canonical uses/resolved_refs/research and
// the quoted goal/constraints text.
export type ProposalCandidate = {
  action: string;
  goal?: string;
  workspace?: string;
  package?: string;
  entity?: string;
  uses?: string[];
  resolved_refs?: string[];
  research?: Record<string, string>;
  constraints?: string[];
};
export type ProposalContext = {
  record?: WireRecord | null;
  epics?: WireRecord[];
  assignments?: WireRecord[];
  coverage?: WireRecord | null;
  design?: WireRecord | null;
  // Observed design planning inputs supplied by the environment; the design
  // launch gate reads these facts instead of inferring from screen count.
  designIndex?: boolean | null;
  designBrief?: boolean | null;
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

// The environment boundary for explicit proposal composition. observe() is
// re-read before every awaited store operation so live/token/facts are never
// captured stale; navigate() receives only resolved RouteState values and
// close() is the optional request-panel dismissal.
export type ProposalObservation = {
  live: boolean;
  token: string | null;
  signature: string | null;
  context: ProposalContext;
};
export type ProposalEnvironment = {
  observe: () => ProposalObservation;
  navigate: (route: RouteState) => void;
  close?: () => void;
};

// The selected candidate, the observed context and the preview signature bound
// to one request entry. The launch context is the ordinary launch-state
// identity (no new identity is minted here) so a later surface can read the
// composed draft with getLaunchDraft(binding.launch).
export type ProposalBinding = {
  candidate: ProposalCandidate;
  context: ProposalContext;
  launch: LaunchContext;
  signature: string | null;
  revision: number;
  requestId: string | null;
  status: 'inspect' | 'composed' | 'reviewed';
};

export type PrepareProposalOptions = { newRequest?: boolean };
export type ProposalStatus = 'brief' | 'reviewed' | 'inspect';
export type ProposalOutcome =
  | { ok: true; status: ProposalStatus; work: RequestWork }
  | { ok: false; reason: string; work: RequestWork };

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

// The readiness gate re-run before every approval refresh and dispatch:
// implement_spec re-derives its readiness decision (an active owner or missing
// preparation refuses), and build_screens requires the observed design index
// and design brief rather than screen count. plan_epic carries no extra gate.
const proposalGateReason = (candidate: ProposalCandidate, context: ProposalContext): string => {
  const action = text(candidate.action);
  if (action === 'implement_spec') {
    const decision = deriveProposal(candidate, context);
    return decision.action === 'launchable' ? '' : decision.reason;
  }
  if (action === 'build_screens' || action === 'build-screens') {
    return context.designIndex === true && context.designBrief === true
      ? ''
      : 'A design request needs an observed valid design index and design brief.';
  }
  return '';
};

// Readiness authority must describe the exact package resolved by the handoff
// owner, not another ready record (even one with the same entity basename).
const bindingGateReason = (binding: ProposalBinding, context: ProposalContext): string => {
  if (binding.candidate.action === 'implement_spec') {
    const record = object(context.record) ? context.record : null;
    const observed = record ? specHandoffInput(record, 'implement', planningFactsFor(record)) : null;
    if (!observed || observed.ws !== binding.launch.ws || observed.packageRef !== binding.launch.package) {
      return 'The observed package record does not match the prepared proposal; refresh the observation before reviewing or launching.';
    }
  }
  return proposalGateReason(binding.candidate, context);
};

// ---- explicit proposal composition ---------------------------------------
// One delimited Request work section per launch brief. The section carries the
// requestBrief content and is replaced in place on re-prepare, so the canonical
// base text and ordinary retained draft text survive untouched and repeated
// prepares never append the request again.
const REQUEST_SECTION_BEGIN = '--- Begin request work ---';
const REQUEST_SECTION_END = '--- End request work ---';

const withRequestWorkSection = (content: string, section: string): string => {
  const block = `${REQUEST_SECTION_BEGIN}\n${section}\n${REQUEST_SECTION_END}`;
  const begin = content.indexOf(REQUEST_SECTION_BEGIN);
  const end = content.indexOf(REQUEST_SECTION_END);
  if (begin !== -1 && end > begin) {
    return content.slice(0, begin) + block + content.slice(end + REQUEST_SECTION_END.length);
  }
  const baseText = content.replace(/\s+$/, '');
  return baseText === '' ? block : `${baseText}\n\n${block}`;
};

// The action catalog is the only skill/authority source; an own property is
// required so inherited names never resolve to an action.
type RequestActionDefinition = {
  id: string;
  targetType: string;
  skill?: string;
  authority?: string;
  presentationOwner?: string;
  prerequisites?: readonly string[];
};

const requestActionOf = (action: string): RequestActionDefinition | undefined =>
  Object.hasOwn(REQUEST_ACTIONS, action)
    ? (REQUEST_ACTIONS as unknown as Record<string, RequestActionDefinition>)[action]
    : undefined;

type RequestBrief = { title: string; content: string; launchable: boolean; reason?: string };

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const researchOf = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (object(value)) {
    for (const key of Object.keys(value)) {
      const flag = (value as WireRecord)[key];
      if (typeof flag === 'string') out[key] = flag;
    }
  }
  return out;
};

// Comparable identity over the shipped candidate fields so the selected
// proposal is exactly one of the current result's candidates.
const candidateKey = (candidate: WireRecord | ProposalCandidate): string => {
  const raw = candidate as WireRecord;
  const research = researchOf(raw.research);
  return JSON.stringify([
    text(raw.action),
    text(raw.workspace),
    text(raw.entity),
    text(raw.goal),
    stringsOf(raw.uses),
    stringsOf(raw.resolved_refs),
    stringsOf(raw.constraints),
    Object.keys(research).sort().map(key => [key, research[key]]),
  ]);
};

const refTypeOf = (value: string): string => (value.includes(':') ? value.slice(0, value.indexOf(':')) : '');
const refSlugOf = (value: string): string => (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);

// The typed spec entity carries the catalog's pkg.slug. It matches the
// observed record's own slug/name or the basename of its canonical package
// and package_ref; this basename policy applies only to request entity
// matching and is never applied to readiness owner joins. An unmatched record
// is refused outright; an unrelated record is never substituted.
const specRecordMatches = (entity: string, record: WireRecord): boolean => {
  const slug = refSlugOf(text(entity));
  if (slug === '') return false;
  const candidates = [text(record.slug), text(record.name)];
  for (const source of [text(record.package), text(record.package_ref)]) {
    if (source !== '') candidates.push(base(source));
  }
  return candidates.some(value => value === slug);
};

const proposalFailure = (operation: 'save' | 'review' | 'launch', error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return operation === 'save'
    ? 'The brief could not be saved. Retry the same brief.'
    : operation === 'review'
      ? 'The brief could not be reviewed. Retry the same brief.'
      : 'The launch could not be recorded. Inspect the recorded outcome before retrying.';
};

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
  clipNeedsTranscription: boolean;
  recording: boolean;
  signature: string | null;
  pending: RequestPending | null;
  revision: number;
  binding: ProposalBinding | null;
};

const primaryActionOf = (entry: RequestEntry): { enabled: boolean; reason: string } =>
  entry.stale && entry.result ? { enabled: false, reason: entry.staleReason ?? STALE_REASON }
  : entry.workspaceSelection ? { enabled: false, reason: entry.workspaceSelection }
  : { enabled: true, reason: '' };

export function createRequestStore(options: RequestStoreOptions = {}): RequestStore {
  const entries = new Map<string, RequestEntry>();
  const handles = new Map<string, CaptureHandle>();
  // Capture lifecycle ownership: one monotonic recording generation per entry.
  // beginRecording mints it for its session; closePanel/discardRequest advance
  // it to invalidate in-flight acquisitions and stops, so a late handle is
  // cancelled and a late stop never restores discarded bytes. The acquiring
  // latch keeps a single acquisition at a time so a second beginRecording
  // cannot orphan the first handle.
  const generations = new Map<string, number>();
  const acquiring = new Map<string, number>();
  const generationOf = (key: string): number => generations.get(key) ?? 0;
  const newGeneration = (key: string): number => {
    const generation = generationOf(key) + 1;
    generations.set(key, generation);
    return generation;
  };
  const now = options.now ?? (() => Date.now());
  const [version, setVersion] = createSignal(0); // mounted readers subscribe to every entry transition
  const notify = (): void => { setVersion(current => current + 1); };

  const view = (entry: RequestEntry): RequestWork => ({
    ...entry,
    refs: cloneRefs(entry.refs),
    binding: entry.binding ? { ...entry.binding, candidate: { ...entry.binding.candidate } } : null,
    primaryAction: primaryActionOf(entry),
  });

  const ensureEntry = (key: string): RequestEntry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        phase: 'ready', transcript: '', scope: key ? { workspace: key } : null, workspaceSelection: null,
        refs: [], requestId: crypto.randomUUID(), snapshot: null, result: null, failure: null,
        stale: false, staleReason: null, clip: null, clipNeedsTranscription: false, recording: false,
        signature: null, pending: null, revision: 0, binding: null,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  // Every transcript/scope/ref change and every accepted recording mints a new
  // request identity, clears the captured snapshot (late replies become
  // inapplicable) and marks a retained proposal stale with the primary action
  // disabled. Failure state belongs to the old request and clears; clip and
  // text survive every non-discard path.
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
      if (entry.pending?.promise === promise) entry.pending = null; // clear only our own latch
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

  const beginRecording = async (workspace: string, hooks?: CaptureHooks): Promise<RequestWork> => {
    const entry = ensureEntry(workspace);
    if (entry.recording || acquiring.has(workspace)) return view(entry);
    const generation = newGeneration(workspace);
    acquiring.set(workspace, generation);
    // The default boundary forwards the level/limit hooks to request-audio;
    // injected zero-arg capture boundaries stay assignable.
    const capture = options.capture ?? ((boundaryHooks?: CaptureHooks): Promise<CaptureHandle> =>
      startCapture({ onLevel: boundaryHooks?.onLevel, onLimit: boundaryHooks?.onLimit }));
    try {
      const handle = await capture(hooks);
      if (generationOf(workspace) !== generation) {
        handle.cancel(); // a later generation owns the entry: drop the late handle
        return view(entry);
      }
      acquiring.delete(workspace);
      handles.set(workspace, handle);
      entry.recording = true;
      entry.phase = 'recording';
      entry.failure = null;
    } catch (error) {
      if (generationOf(workspace) !== generation) return view(entry); // stale failure
      acquiring.delete(workspace);
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
    const generation = generationOf(workspace);
    try {
      // stop() resolves and retains the downsampled clip (step-06 contract).
      const clip = await handle.stop();
      if (generationOf(workspace) !== generation) return view(entry); // discarded/closed: never restore
      entry.clip = clip;
      // This clip has not been transcribed yet; retained later only for retry.
      entry.clipNeedsTranscription = true;
      // Accepting a recording is a new request-content generation: late replies
      // lose acceptance, a fresh identity is minted and retained results go
      // stale, while an unchanged retry of this clip keeps the new identity.
      contentChanged(entry);
      entry.phase = entry.result ? 'result' : 'ready';
    } catch (error) {
      // A cancelled handle drops clip bytes; a later stop() rejects 'cancelled'.
      if (generationOf(workspace) !== generation) return view(entry);
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'mic-denied') entry.failure = 'mic-denied';
      else if (code !== 'cancelled') entry.failure = 'mic-unavailable';
      entry.phase = entry.failure ? 'failure' : entry.result ? 'result' : 'ready';
    }
    notify();
    return view(entry);
  };

  // The one transcribe-stage body shared by submitRequest's pipeline and the
  // transcribe-only limit path (transcribeClip): the transcribing phase
  // transition, the wire call through the injectable options.transcribe
  // boundary (default POST /api/request/transcribe?request_id=<uuid>) and the
  // spoken install. The caller owns acceptance through isCurrent and moves its
  // captured snapshot in install; clipNeedsTranscription clears only while the
  // same clip is retained.
  const runTranscribeStage = async (
    entry: RequestEntry,
    clip: Float32Array,
    requestId: string,
    token: string,
    isCurrent: () => boolean,
    install: (spoken: string) => void,
  ): Promise<void> => {
    if (isCurrent()) { entry.phase = 'transcribing'; notify(); }
    const transcribe = options.transcribe ?? ((body: Float32Array, id: string, signal?: AbortSignal) =>
      postAudio(transcribePath(id), body, token, signal));
    const transcription = await transcribe(clip, requestId);
    // The clip has been transcribed once; retained bytes serve explicit
    // retry after a failed transcription and recovery only. They must not
    // re-run (and overwrite operator-edited text) on later submissions.
    if (entry.clip === clip) entry.clipNeedsTranscription = false;
    const spoken = transcriptOf(transcription);
    // The transcribed text joins the same request: identity is unchanged and
    // the snapshot moves together, keeping the interpret reply acceptable.
    if (spoken && isCurrent()) {
      install(spoken);
      notify();
    }
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
    const clipNeedsTranscription = entry.clipNeedsTranscription;
    const interpret = options.interpret ?? ((body: RequestSnapshot, signal?: AbortSignal) =>
      postJson('/api/request/interpret', interpretBodyOf(body), token, signal));
    // The captured snapshot alone owns acceptance; edits, scope/refs changes and
    // new requests move entry.snapshot and silently discard late outcomes.
    const isCurrent = (): boolean => entries.get(key) === entry && sameSnapshot(entry.snapshot, accepted);
    let stage: 'transcribe' | 'interpret' = 'interpret';
    const run = async (): Promise<RequestReply> => {
      if (clip && clipNeedsTranscription) {
        stage = 'transcribe';
        await runTranscribeStage(entry, clip, requestId, token, isCurrent, spoken => {
          entry.transcript = spoken;
          accepted = { ...accepted, transcript: spoken };
          entry.snapshot = accepted;
        });
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

  // Transcribe-only stage for the recording-limit path and its retry: run the
  // shared transcribe stage over the retained clip under the clip's existing
  // request identity (never minting a new UUID), then wait here for the
  // explicit Interpret request. An unchanged retry or double tap shares one
  // promise; a late outcome after a content change or clip discard is silently
  // discarded. Failure retains the clip bytes and typed text so the retry
  // re-sends the same bytes under the same request id.
  const clipTranscriptions = new Map<string, { clip: Float32Array; promise: Promise<RequestWork> }>();

  const transcribeClip = (workspace: string, token: string): Promise<RequestWork> => {
    const key = workspace;
    const entry = ensureEntry(key);
    const clip = entry.clip;
    if (!clip || !entry.clipNeedsTranscription) return Promise.resolve(view(entry));
    const running = clipTranscriptions.get(key);
    if (running && running.clip === clip) return running.promise;
    const requestId = entry.snapshot?.requestId ?? entry.requestId;
    if (!requestId) return Promise.resolve(view(entry)); // never mint an identity here
    const accepted = entry.snapshot;
    // The clip and its request identity alone own acceptance: an edit, a
    // scope/refs change, a new recording or a discard moves them and silently
    // discards this outcome (submitRequest's isCurrent style).
    const isCurrent = (): boolean => entries.get(key) === entry
      && entry.clip === clip && entry.requestId === requestId && entry.snapshot === accepted;
    const run = async (): Promise<void> => {
      await runTranscribeStage(entry, clip, requestId, token, isCurrent, spoken => {
        entry.transcript = spoken;
        // The spoken text joins the same request: identity unchanged and an
        // existing snapshot moves together exactly like submitRequest.
        if (entry.snapshot) entry.snapshot = { ...entry.snapshot, transcript: spoken };
      });
    };
    const promise = Promise.resolve()
      .then(run)
      .then(
        () => {
          if (isCurrent()) {
            entry.failure = null;
            entry.phase = entry.result ? 'result' : 'ready'; // limit path waits here
          }
          notify();
          return view(entry);
        },
        (error: unknown) => {
          // Failure retains clip bytes and typed text for the explicit retry.
          if (isCurrent()) {
            entry.failure = failureOf(error, 'transcribe');
            entry.phase = 'failure';
          }
          notify();
          throw error;
        },
      )
      .finally(() => {
        const running = clipTranscriptions.get(key);
        if (running?.promise === promise) clipTranscriptions.delete(key);
      });
    clipTranscriptions.set(key, { clip, promise });
    return promise;
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

  // Shared capture-cancel semantics: bump the generation so a late acquisition
  // or stop cannot install results, clear the acquiring latch, and cancel plus
  // drop any installed handle. closePanel, discardRequest and cancelRecording
  // all release the capture session through this block.
  const cancelCapture = (key: string, entry: RequestEntry): void => {
    newGeneration(key);
    acquiring.delete(key);
    const handle = handles.get(key);
    if (handle) {
      handles.delete(key);
      handle.cancel();
      entry.recording = false;
    }
  };

  // Close while recording cancels the capture session (tracks stop inside the
  // request-audio cleanup) and invalidates its generation so a late
  // acquisition or stop cannot install results into the closed entry; every
  // other phase retains state and a pending request continues.
  const closePanel = (workspace: string): RequestWork | undefined => {
    const entry = entries.get(workspace);
    if (!entry) return undefined;
    cancelCapture(workspace, entry);
    if (entry.phase === 'recording') entry.phase = entry.result ? 'result' : 'ready';
    notify();
    return view(entry);
  };

  // The only transition that clears audio clip bytes and typed text; it also
  // invalidates the recording generation so a late stop never restores the
  // explicitly discarded bytes.
  const discardRequest = (workspace: string): RequestWork => {
    const entry = ensureEntry(workspace);
    cancelCapture(workspace, entry);
    entry.transcript = '';
    entry.clip = null;
    entry.clipNeedsTranscription = false;
    entry.result = null;
    entry.failure = null;
    entry.stale = false;
    entry.staleReason = null;
    entry.snapshot = null;
    entry.signature = null;
    entry.binding = null;
    entry.requestId = crypto.randomUUID();
    entry.phase = 'ready';
    entry.revision += 1;
    notify();
    return view(entry);
  };

  // Explicit cancel-recording (the recording path's Cancel action): shares
  // closePanel's capture-cancel semantics and additionally discards the
  // captured audio (clip bytes and their pending transcription) while typed
  // transcript, scope, refs, result and identity stay untouched — no
  // contentChanged minting. A late stop after this cancel never installs bytes.
  const cancelRecording = (workspace: string): RequestWork => {
    const entry = ensureEntry(workspace);
    cancelCapture(workspace, entry);
    entry.clip = null;
    entry.clipNeedsTranscription = false;
    entry.phase = entry.result ? 'result' : 'ready';
    notify();
    return view(entry);
  };

  // ---- explicit proposal selection, review and launch --------------------
  // The guard captures the request entry's revision and snapshot so awaits
  // never review or overwrite a newer entry after an edit or a new request.
  const entryGuard = (key: string, entry: RequestEntry): (() => boolean) => {
    const revision = entry.revision;
    const snapshot = entry.snapshot;
    const binding = entry.binding;
    return () => entries.get(key) === entry && entry.revision === revision && entry.snapshot === snapshot
      && entry.binding === binding;
  };

  const runPrepare = async (
    workspace: string,
    candidate: ProposalCandidate,
    environment: ProposalEnvironment,
    options: PrepareProposalOptions,
  ): Promise<ProposalOutcome> => {
    const entry = ensureEntry(workspace);
    const inspect = (): ProposalOutcome => ({ ok: true, status: 'inspect', work: view(entry) });
    const refuse = (reason: string): ProposalOutcome => ({ ok: false, reason, work: view(entry) });

    // Only a candidate carried by the current, non-stale interpretation of this
    // workspace's request may be selected.
    const result = entry.result;
    if (!result || entry.stale) return refuse('Submit the current request and select a proposal from its result again.');
    const selected = list(result.reply.candidates).find(raw => candidateKey(raw) === candidateKey(candidate));
    if (!selected) return refuse('The selected proposal is not one of the current result candidates.');
    if (text(selected.workspace) !== workspace) return refuse('The selected proposal does not match this request workspace.');
    const definition = requestActionOf(text(selected.action));
    if (!definition) return refuse('An unknown request action was named.');

    const observed = environment.observe();
    const initialSignature = observed.signature;

    // Entity typing follows the action's catalog target type: a design action
    // names a design, and a workspace action names exactly this workspace.
    const entity = text(selected.entity);
    const entityType = refTypeOf(entity);
    const entitySlug = refSlugOf(entity);
    if (definition.id === 'build_screens' && (entityType !== 'design' || entitySlug === '')) {
      return refuse('The selected proposal does not name a design.');
    }
    if (definition.id === 'plan_epic' && entity !== `workspace:${workspace}`) {
      return refuse('The selected proposal does not name this workspace.');
    }

    // Resolve the launch identity through the existing owners first, without
    // seeding: implement_spec composes the package-bound hand-off and its
    // canonical presentation/targets, plan_epic and build_screens the
    // whole-workspace catalog context.
    let launch: LaunchContext;
    let handoff: HandoffInput | null = null;
    let multi = false;
    let seedTitle = '';
    let seedBase = '';
    if (definition.id === 'implement_spec') {
      if (entityType !== 'spec') return refuse('The selected proposal does not name a spec package.');
      const record = object(observed.context.record) ? observed.context.record : null;
      if (!record || text(record.workspace) !== workspace || !specRecordMatches(entity, record)) {
        return refuse('The observed package record does not match the selected spec; refresh the observation before preparing this launch.');
      }
      handoff = specHandoffInput(record, 'implement', planningFactsFor(record));
      const choices = plannedTargetChoices(handoff.targets);
      multi = choices.length > 1;
      const presentation = packageLaunchPresentation('implement', handoff.packageRef);
      seedTitle = presentation.title;
      seedBase = presentation.content;
      // The same identity seedColdHandoff derives, resolved before any gate so
      // retained outcomes stay inspectable (also offline) on fresh re-entry.
      launch = {
        ws: workspace,
        package: handoff.packageRef,
        skill: presentation.skill,
        authority: presentation.authority,
        target: choices.length === 1 ? choices[0].path : null,
      };
    } else {
      launch = { ws: workspace, skill: text(definition.skill), authority: 'none', target: null };
    }

    // The binding is installed before any protected-state return so re-entry
    // can inspect existing work. This selection is not evidence that its brief
    // has been composed: no prior request/candidate approval carries over.
    const retained = getLaunchDraft(launch);
    const binding: ProposalBinding = {
      candidate: { ...candidate },
      context: { ...observed.context },
      launch: retained ? { ...launch, target: retained.target ?? null } : launch,
      signature: null,
      revision: entry.revision,
      requestId: entry.requestId,
      status: 'inspect',
    };
    entry.binding = binding;
    entry.signature = null;
    const guard = entryGuard(workspace, entry);

    // Retained pending or ANY recorded outcome is inspect-only. Only an
    // explicit newRequest replaces an acknowledged launched outcome, and
    // unconfirmed/failed outcomes never begin a corrected attempt here.
    const replace = options.newRequest === true && retained?.result?.kind === 'launched';
    if (!replace && (retained?.pending || retained?.result)) {
      notify();
      return inspect();
    }

    // Readiness gates run only once retained work is protected: implement
    // re-derives its readiness decision, and build_screens requires the
    // observed design index and design brief, never screen count alone.
    const gateReason = proposalGateReason(candidate, observed.context);
    if (gateReason) {
      notify();
      return refuse(gateReason);
    }

    // The delimited Request work section carries requestBrief content; for
    // build_screens the same brief also gates launchability on the observed
    // design index and design brief, never on screen count alone.
    let brief: RequestBrief;
    try {
      brief = requestBrief(text(selected.action), {
        workspace,
        entity: refSlugOf(text(selected.entity)) || undefined,
        transcript: entry.transcript,
        source: entry.clip && !entry.clipNeedsTranscription ? 'spoken' : 'typed',
        goal: text(selected.goal),
        constraints: stringsOf(selected.constraints),
        uses: stringsOf(selected.uses),
        research: researchOf(selected.research),
        observed: {
          designIndex: observed.context.designIndex === true,
          designBrief: observed.context.designBrief === true,
        },
      }) as RequestBrief;
    } catch (error) {
      return refuse(error instanceof Error && error.message ? error.message : 'The request brief could not be composed.');
    }
    if (definition.id === 'build_screens' && brief.launchable !== true) {
      return refuse(brief.reason ?? 'A design request needs an observed valid design index and design brief.');
    }
    const section = brief.content;
    if (definition.id !== 'implement_spec') {
      seedTitle = brief.title;
      seedBase = '';
    }

    // Live/token gate before any store write; observe() is re-read before each
    // awaited store operation below.
    const ready = environment.observe();
    if (!ready.live) return refuse('Connect to the live workspace service to prepare this proposal.');
    if (!ready.token) return refuse('The workspace action token is unavailable.');
    const token = ready.token;

    // Several canonical targets cannot be guessed: carry the operator's
    // request into the target-choice brief and delegate the existing hand-off,
    // then close the panel. Protected outcomes were already checked above so a
    // recorded success is never relaunched; the draft is re-read before every
    // write so a pending or recorded outcome is never written over, and
    // startPackageHandoff keeps owning routing and target selection without any
    // save or preview here.
    if (multi && handoff) {
      let chooserDraft = getLaunchDraft(launch);
      if (!replace && (chooserDraft?.pending || chooserDraft?.result)) return inspect();
      if (replace || !chooserDraft) {
        seedLaunchDraft(launch, { title: seedTitle, content: withRequestWorkSection(seedBase, section), stage: 'brief' });
      } else {
        const content = withRequestWorkSection(text(chooserDraft.content), section);
        if (content !== text(chooserDraft.content)) {
          chooserDraft = getLaunchDraft(launch);
          if (!replace && (chooserDraft?.pending || chooserDraft?.result)) return inspect();
          editLaunchDraft(launch, { content });
        }
      }
      const outcome = await startPackageHandoff('implement', handoff, token, route => environment.navigate(route));
      environment.close?.();
      return outcome.ok
        ? { ok: true, status: 'brief', work: view(entry) }
        : { ok: false, reason: outcome.reason, work: view(entry) };
    }

    // Only after protected-state handling, the live/token gate and the
    // readiness gates may the single-target implement hand-off seed its
    // canonical brief; the multi-target path above delegates instead.
    if (handoff) {
      const cold = seedColdHandoff('implement', handoff);
      if (!cold.ok) return refuse(cold.reason);
    }

    // Preserve a retained model/target and draft text: one delimited Request
    // work section is added or replaced idempotently instead of appending. The
    // draft is re-read before every edit/save/review so a pending or recorded
    // outcome is never written over.
    let draft = getLaunchDraft(launch);
    if (!replace && (draft?.pending || draft?.result)) return inspect();
    if (replace || !draft) {
      seedLaunchDraft(launch, { title: seedTitle, content: withRequestWorkSection(seedBase, section), stage: 'brief' });
    } else {
      const content = withRequestWorkSection(text(draft.content), section);
      if (content !== text(draft.content)) {
        draft = getLaunchDraft(launch);
        if (!replace && (draft?.pending || draft?.result)) return inspect();
        editLaunchDraft(launch, { content });
      }
    }

    draft = getLaunchDraft(launch);
    if (!replace && (draft?.pending || draft?.result)) return inspect();
    const beforeSave = environment.observe();
    if (!beforeSave.live || !beforeSave.token) return refuse('Connect to the live workspace service to save this brief.');
    try {
      await saveLaunchDraft(launch, beforeSave.token);
    } catch (error) {
      return refuse(proposalFailure('save', error));
    }
    if (!guard()) return refuse('The request changed while the brief was being saved; prepare it again.');
    binding.status = 'composed';
    notify();

    // Readiness that moved since the initial observation refuses the review
    // instead of reviewing stale readiness.
    const afterSave = environment.observe();
    const afterSaveGate = bindingGateReason(binding, afterSave.context);
    if (afterSaveGate) return refuse(afterSaveGate);
    if (afterSave.signature !== initialSignature) {
      return refuse('Observed readiness facts changed while this proposal was being prepared; prepare it again.');
    }
    if (!afterSave.live || !afterSave.token) return refuse('Connect to the live workspace service to review this brief.');
    draft = getLaunchDraft(launch);
    if (!replace && (draft?.pending || draft?.result)) return inspect();
    try {
      await reviewLaunchDraft(launch, afterSave.token);
    } catch (error) {
      return refuse(proposalFailure('review', error));
    }
    if (!guard()) return refuse('The request changed while the brief was being reviewed; prepare it again.');

    // The preview signature is stored from the latest observation, and only
    // while it still matches the initial one the whole composition ran under.
    const latest = environment.observe();
    const latestGate = bindingGateReason(binding, latest.context);
    if (latestGate) return refuse(latestGate);
    if (latest.signature !== initialSignature) {
      return refuse('Observed readiness facts changed while the brief was being reviewed; review it again.');
    }
    entry.signature = latest.signature;
    entry.binding = { ...binding, status: 'reviewed', signature: latest.signature };
    notify();
    return { ok: true, status: 'reviewed', work: view(entry) };
  };

  // Duplicate prepare calls share exactly one promise through this synchronous
  // workspace latch; the seed/save/review composition runs once per selection.
  const preparations = new Map<string, Promise<ProposalOutcome>>();

  const prepareProposal = (
    workspace: string,
    candidate: ProposalCandidate,
    environment: ProposalEnvironment,
    options: PrepareProposalOptions = {},
  ): Promise<ProposalOutcome> => {
    const running = preparations.get(workspace);
    if (running) return running;
    const promise = runPrepare(workspace, candidate, environment, options).finally(() => {
      if (preparations.get(workspace) === promise) preparations.delete(workspace);
    });
    preparations.set(workspace, promise);
    return promise;
  };

  // Re-review of the bound brief. The current signature is stored only after a
  // successful current preview, so a refused or stale preview never advances
  // the recorded facts.
  const reviewProposal = async (workspace: string, environment: ProposalEnvironment): Promise<ProposalOutcome> => {
    const entry = ensureEntry(workspace);
    const inspect = (): ProposalOutcome => ({ ok: true, status: 'inspect', work: view(entry) });
    const refuse = (reason: string): ProposalOutcome => ({ ok: false, reason, work: view(entry) });
    const binding = entry.binding;
    if (!binding) return refuse('Select a proposal and prepare it before reviewing.');
    if (entry.revision !== binding.revision || entry.requestId !== binding.requestId) {
      return refuse('The request changed after this proposal was prepared; prepare it again.');
    }
    const retained = getLaunchDraft(binding.launch);
    if (retained?.pending || retained?.result) return inspect();
    if (binding.status === 'inspect') return refuse('Prepare this proposal successfully before reviewing its brief.');
    const guard = entryGuard(workspace, entry);
    const observed = environment.observe();
    if (!observed.live) return refuse('Connect to the live workspace service to review this brief.');
    if (!observed.token) return refuse('The workspace action token is unavailable.');
    // The implement/design readiness gates re-run before any approval is
    // refreshed, so a stale binding can never re-approve moved facts.
    const gateReason = bindingGateReason(binding, observed.context);
    if (gateReason) return refuse(gateReason);
    const previewSignature = observed.signature;
    try {
      await reviewLaunchDraft(binding.launch, observed.token);
    } catch (error) {
      return refuse(proposalFailure('review', error));
    }
    if (!guard()) return refuse('The request changed while the brief was being reviewed; prepare it again.');
    // The signature must be unchanged across the preview await, and the stored
    // preview signature comes from the latest observation.
    const latest = environment.observe();
    const latestGate = bindingGateReason(binding, latest.context);
    if (latestGate) return refuse(latestGate);
    if (latest.signature !== previewSignature) {
      return refuse('Observed readiness facts changed while the brief was being reviewed; review it again.');
    }
    entry.signature = latest.signature;
    entry.binding = { ...binding, status: 'reviewed', signature: latest.signature };
    notify();
    return { ok: true, status: 'reviewed', work: view(entry) };
  };

  // Dispatch is delegated to launch-state only after the current live/token/
  // signature and request checks pass; the launch owner's own pending latch
  // shares duplicate launches.
  const launchProposal = async (workspace: string, environment: ProposalEnvironment): Promise<ProposalOutcome> => {
    const entry = ensureEntry(workspace);
    const inspect = (): ProposalOutcome => ({ ok: true, status: 'inspect', work: view(entry) });
    const refuse = (reason: string): ProposalOutcome => ({ ok: false, reason, work: view(entry) });
    const binding = entry.binding;
    if (!binding) return refuse('Select a proposal and prepare it before launching.');
    if (entry.revision !== binding.revision || entry.requestId !== binding.requestId) {
      return refuse('The request changed after this proposal was prepared; prepare it again.');
    }
    const retained = getLaunchDraft(binding.launch);
    if (retained?.pending || retained?.result) return inspect();
    if (binding.status !== 'reviewed') return refuse('Prepare and review this proposal successfully before launching.');
    const guard = entryGuard(workspace, entry);
    const observed = environment.observe();
    if (!observed.live) return refuse('Connect to the live workspace service to launch.');
    if (!observed.token) return refuse('The workspace action token is unavailable.');
    if (observed.signature !== binding.signature) {
      return refuse('Observed readiness facts changed since this proposal was reviewed; review it again before launching.');
    }
    // The current implement/design readiness gates hold at dispatch too.
    const gateReason = bindingGateReason(binding, observed.context);
    if (gateReason) return refuse(gateReason);
    try {
      await launchReviewedDraft(binding.launch, observed.token);
    } catch (error) {
      const settled = getLaunchDraft(binding.launch);
      if (settled?.result) return inspect();
      return refuse(proposalFailure('launch', error));
    }
    if (!guard()) return refuse('The request changed while the launch was being recorded.');
    notify();
    return inspect();
  };

  // Conversation entry: one-use transcript seed, the Conversations tab=new
  // route only, then the panel closes. No thread is created here.
  const startConversation = (workspace: string, environment: ProposalEnvironment): RequestWork | undefined => {
    const entry = entries.get(workspace);
    if (!entry) return undefined;
    seedNewThreadDraft(workspace, { text: entry.transcript });
    environment.navigate({ dest: 'conversations', ws: workspace, tab: 'new' });
    environment.close?.();
    return view(entry);
  };

  // Agent entry resolves the observed assignment key inventory so an agent
  // click selects the observed row instead of the first list row.
  const openAgent = (workspace: string, environment: ProposalEnvironment, assignmentId: string): void => {
    const observed = environment.observe();
    environment.navigate(parseHash(busyAgentsHref(workspace, text(assignmentId) || undefined, list(observed.context.assignments))));
  };

  return {
    getRequest,
    editTranscript,
    changeScope,
    changeRefs,
    beginRecording,
    finishRecording,
    cancelRecording,
    transcribeClip,
    submitRequest,
    enterPreview,
    closePanel,
    discardRequest,
    prepareProposal,
    reviewProposal,
    launchProposal,
    startConversation,
    openAgent,
  };
}

const requestStore = createRequestStore();

export const getRequest = requestStore.getRequest;
export const editTranscript = requestStore.editTranscript;
export const changeScope = requestStore.changeScope;
export const changeRefs = requestStore.changeRefs;
export const beginRecording = requestStore.beginRecording;
export const finishRecording = requestStore.finishRecording;
export const cancelRecording = requestStore.cancelRecording;
export const transcribeClip = requestStore.transcribeClip;
export const submitRequest = requestStore.submitRequest;
export const enterPreview = requestStore.enterPreview;
export const closePanel = requestStore.closePanel;
export const discardRequest = requestStore.discardRequest;
export const prepareProposal = requestStore.prepareProposal;
export const reviewProposal = requestStore.reviewProposal;
export const launchProposal = requestStore.launchProposal;
export const startConversation = requestStore.startConversation;
export const openAgent = requestStore.openAgent;
