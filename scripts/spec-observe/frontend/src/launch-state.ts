// Launch-domain in-memory state owner. Entries are keyed by workspace/thread/
// package/skill so the editable target can move without losing typed work, and
// pending work stays with its originating entry so navigation cannot drop a
// submitted operation. Synchronous reads/transitions are local; the async
// operations submit only through launch-client.ts (api.ts stays the sole
// transport/decoder owner) and settle captured entries by entry identity, so a
// replacement draft or a late response cannot corrupt current state.
import { createSignal } from 'solid-js';
import { HttpError } from './api';
import type { BriefReference, InputPreview } from './composerTypes';
import { previewLaunchAssignment, saveLaunchBrief, submitLaunchAssignment } from './launch-client';
import type { LaunchContext, LaunchPreview, LaunchReply } from './launch-client';
import type { WireRecord } from './model';

export type { LaunchContext, LaunchPreview, LaunchReply } from './launch-client';

export type LaunchStage = 'brief' | 'review' | 'result';
export type LaunchStageView = LaunchStage | 'inspection';
export type LaunchReviewStatus = 'idle' | 'resolving' | 'current' | 'stale' | 'denied' | 'error';

export type SavedLaunchBrief = {
  requestId: string; title: string; content: string; references: BriefReference[]; brief: string;
};

export type LaunchPreviewState = {
  record: WireRecord; contractDigest: string; inputPreview?: InputPreview;
  revision: number; target: string | null;
};

export type LaunchResult = {
  kind: 'launched' | 'unconfirmed' | 'failed'; assignmentId: string;
  assignment?: WireRecord; observation?: WireRecord;
};

export type LaunchPending = {
  kind: 'save' | 'preview' | 'launch'; revision: number;
  requestId: string; assignmentId?: string; target: string | null;
  promise: Promise<unknown>;
};

export type LaunchDraftError = {
  operation: 'save' | 'review' | 'launch';
  status?: number; reason?: string; assignmentId?: string; message?: string;
};

export type LaunchDraft = {
  title: string; content: string; references: BriefReference[];
  target: string | null; stageLabel?: string; revision: number;
  saved?: SavedLaunchBrief;
  requestId?: string; assignmentId?: string;
  preview?: LaunchPreviewState;
  // Last reviewed facts, retained separately from the current approval so
  // stale/denied states can present previous/unapproved facts after the
  // store clears preview. Current requested facts (workspace/target/brief)
  // stay in saved/draft; dispatch still requires a current preview.
  lastReviewed?: LaunchPreviewState;
  result?: LaunchResult;
  pending?: LaunchPending;
  reviewStatus: LaunchReviewStatus;
  error?: LaunchDraftError;
};

export type LaunchSeed = { title: string; content: string; references?: BriefReference[]; stage?: LaunchStage };
export type LaunchDraftChanges = { title?: string; content?: string; references?: BriefReference[] };
export type LaunchStageRequest = { tab?: string | null; id?: string | null };

export type LaunchStore = {
  getLaunchDraft: (context: LaunchContext) => LaunchDraft | undefined;
  seedLaunchDraft: (context: LaunchContext, seed: LaunchSeed) => LaunchDraft;
  editLaunchDraft: (context: LaunchContext, changes: LaunchDraftChanges) => LaunchDraft | undefined;
  changeLaunchTarget: (context: LaunchContext, target: string | null) => LaunchDraft | undefined;
  saveLaunchDraft: (context: LaunchContext, token: string) => Promise<WireRecord>;
  reviewLaunchDraft: (context: LaunchContext, token: string) => Promise<LaunchPreview>;
  launchReviewedDraft: (context: LaunchContext, token: string) => Promise<LaunchReply>;
  beginCorrectedAttempt: (context: LaunchContext) => LaunchResult | undefined;
};

// The editable target is deliberately not part of the identity tuple.
export const contextKey = (context: LaunchContext): string =>
  JSON.stringify([context.ws, context.thread ?? null, context.package ?? null, context.skill ?? null]);

const sameReferenceIdentities = (a: readonly BriefReference[], b: readonly BriefReference[]): boolean =>
  a.length === b.length && a.every((reference, index) => reference.kind === b[index].kind && reference.id === b[index].id);

// Caller-owned arrays are copied into the store so later mutations cannot
// silently change a submitted identity.
const cloneReferences = (references: readonly BriefReference[]): BriefReference[] =>
  references.map(reference => ({ ...reference }));

const savedMatchesDraft = (draft: LaunchDraft): boolean => {
  const saved = draft.saved;
  return saved !== undefined
    && saved.requestId === draft.requestId
    && saved.title === draft.title
    && saved.content === draft.content
    && sameReferenceIdentities(saved.references, draft.references);
};

const draftError = (operation: LaunchDraftError['operation'], error: unknown): LaunchDraftError => {
  if (error instanceof HttpError) {
    return { operation, status: error.status, reason: error.reason, assignmentId: error.assignmentId, message: error.message };
  }
  return { operation, message: error instanceof Error ? error.message : String(error) };
};

const briefPathOf = (value: unknown): string =>
  value !== null && typeof value === 'object' && typeof (value as WireRecord).brief === 'string' ? (value as WireRecord).brief : '';

const isDeniedRefusal = (error: unknown): boolean =>
  error instanceof HttpError
  && (error.status === 403 || error.reason === 'target-busy' || error.reason === 'run-active' || error.reason === 'service-unavailable');

export function createLaunchStore(): LaunchStore {
  const entries = new Map<string, LaunchDraft>();
  const [version, setVersion] = createSignal(0);
  const notify = (): void => { setVersion(current => current + 1); };

  type PendingOutcome = { value?: unknown; error?: unknown };

  // Defer the adapter call one microtask so the captured pending identity is
  // registered before any submission can start; the returned promise is the
  // submitted operation itself so duplicate calls can share it exactly.
  const registerPending = <T>(
    key: string,
    entry: LaunchDraft,
    kind: LaunchPending['kind'],
    requestId: string,
    assignmentId: string | undefined,
    run: () => Promise<T>,
    settle: (outcome: PendingOutcome) => void,
  ): Promise<T> => {
    const promise = Promise.resolve().then(run);
    entry.pending = { kind, revision: entry.revision, requestId, assignmentId, target: entry.target, promise };
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

  const getLaunchDraft = (context: LaunchContext): LaunchDraft | undefined => {
    version(); // subscribe Solid readers to every entry transition
    const draft = entries.get(contextKey(context));
    return draft ? { ...draft } : undefined;
  };

  const seedLaunchDraft = (context: LaunchContext, seed: LaunchSeed): LaunchDraft => {
    const key = contextKey(context);
    const retained = entries.get(key);
    // Never clobber in-flight or unconfirmed work; failures require the explicit
    // correction transition. After acknowledged success, an explicit seed starts
    // an independent draft, leaving the prior entry and its identities untouched.
    if (retained?.pending || (retained?.result && retained.result.kind !== 'launched')) return retained;
    const draft: LaunchDraft = {
      title: seed.title,
      content: seed.content,
      references: cloneReferences(seed.references ?? []),
      target: context.target ?? null,
      revision: 0,
      reviewStatus: 'idle',
    };
    if (seed.stage !== undefined) draft.stageLabel = seed.stage;
    entries.set(key, draft);
    notify();
    return draft;
  };

  const editLaunchDraft = (context: LaunchContext, changes: LaunchDraftChanges): LaunchDraft | undefined => {
    const key = contextKey(context);
    let draft = entries.get(key);
    if (draft?.pending || draft?.result) return draft;
    const title = changes.title ?? draft?.title ?? '';
    const content = changes.content ?? draft?.content ?? '';
    const references = changes.references ?? draft?.references ?? [];
    if (draft) {
      const textChanged = title !== draft.title || content !== draft.content;
      const referenceChanged = changes.references !== undefined && !sameReferenceIdentities(references, draft.references);
      if (!textChanged && !referenceChanged) return draft;
    } else if (changes.title === undefined && changes.content === undefined && changes.references === undefined) {
      return undefined;
    }
    if (!draft) {
      draft = { title: '', content: '', references: [], target: context.target ?? null, revision: 0, reviewStatus: 'idle' };
      entries.set(key, draft);
    }
    draft.title = title;
    draft.content = content;
    draft.references = cloneReferences(references);
    draft.revision += 1;
    // Changed brief bytes mint a fresh request identity; the previous saved
    // handoff and approval no longer describe this draft.
    draft.requestId = crypto.randomUUID();
    draft.assignmentId = undefined;
    draft.saved = undefined;
    draft.preview = undefined;
    draft.lastReviewed = undefined;
    draft.reviewStatus = 'idle';
    draft.error = undefined;
    notify();
    return draft;
  };

  const changeLaunchTarget = (context: LaunchContext, target: string | null): LaunchDraft | undefined => {
    const draft = entries.get(contextKey(context));
    if (!draft || draft.result) return draft;
    // A submitted launch has locked its reviewed facts; only save/preview
    // responses may be invalidated by moving the target.
    if (draft.pending?.kind === 'launch') return draft;
    if (draft.target === target) return draft;
    const hadPreview = draft.preview !== undefined;
    draft.target = target;
    draft.revision += 1;
    // Typed work, references and the saved request identity move with the
    // draft; the approval was bound to the old target and cannot be reused.
    // lastReviewed is retained so the stale view can present previous
    // facts beside the current requested target.
    draft.preview = undefined;
    draft.assignmentId = undefined;
    draft.reviewStatus = hadPreview ? 'stale' : 'idle';
    draft.error = undefined;
    notify();
    return draft;
  };

  const saveLaunchDraft = (context: LaunchContext, token: string): Promise<WireRecord> => {
    const key = contextKey(context);
    const entry = entries.get(key);
    if (entry?.pending) return entry.pending.promise as Promise<WireRecord>;
    if (!entry) return Promise.reject(new Error('No launch draft to save.'));
    if (entry.result) return Promise.reject(new Error('A recorded launch outcome cannot be saved over.'));
    const requestId = entry.requestId ?? crypto.randomUUID(); // unchanged retries keep one identity
    entry.requestId = requestId;
    entry.error = undefined;
    const title = entry.title;
    const content = entry.content;
    const references = cloneReferences(entry.references);
    const revision = entry.revision;
    const requestContext: LaunchContext = { ...context, target: entry.target };
    return registerPending(key, entry, 'save', requestId, undefined,
      () => saveLaunchBrief(requestContext, requestId, { title, content, references }, token),
      outcome => {
        if (outcome.error !== undefined) {
          entry.error = draftError('save', outcome.error);
          return;
        }
        const unchangedBytes = entry.title === title && entry.content === content
          && sameReferenceIdentities(entry.references, references);
        if (entry.revision === revision || unchangedBytes) {
          // A target-only revision move may retain the saved bytes, but it
          // never approves them.
          entry.saved = { requestId, title, content, references, brief: briefPathOf(outcome.value) };
        }
        entry.error = undefined;
      });
  };

  const reviewLaunchDraft = (context: LaunchContext, token: string): Promise<LaunchPreview> => {
    const key = contextKey(context);
    const entry = entries.get(key);
    if (entry?.pending) return entry.pending.promise as Promise<LaunchPreview>;
    if (!entry) return Promise.reject(new Error('No launch draft to review.'));
    if (entry.result) return Promise.reject(new Error('A recorded launch outcome cannot be reviewed.'));
    const saved = entry.saved;
    if (!saved || !savedMatchesDraft(entry)) return Promise.reject(new Error('Save the current brief before reviewing it.'));
    const requestId = saved.requestId;
    const assignmentId = entry.assignmentId ?? crypto.randomUUID();
    entry.assignmentId = assignmentId;
    const references = cloneReferences(saved.references);
    const revision = entry.revision;
    const target = entry.target;
    entry.error = undefined;
    entry.reviewStatus = 'resolving';
    entry.preview = undefined; // no approval is current while a new resolve runs
    const requestContext: LaunchContext = { ...context, target };
    return registerPending(key, entry, 'preview', requestId, assignmentId,
      () => previewLaunchAssignment(requestContext, { requestId, assignmentId, references }, token),
      outcome => {
        if (outcome.error !== undefined) {
          if (entry.revision !== revision || entry.target !== target) return; // captured refusal no longer applies
          const error = outcome.error;
          entry.error = draftError('review', error);
          if (error instanceof HttpError && error.reason === 'stale-preview') {
            entry.reviewStatus = 'stale';
            return; // lastReviewed retained for previous-facts presentation
          }
          if (error instanceof HttpError && error.reason === 'request-conflict') {
            // This request is linked elsewhere; a fresh request identity is the
            // only recovery, so the next save mints one.
            entry.saved = undefined;
            entry.requestId = undefined;
            entry.assignmentId = undefined;
            entry.reviewStatus = 'error';
            return;
          }
          if (isDeniedRefusal(error)) {
            entry.reviewStatus = 'denied';
            return; // lastReviewed retained; dispatch stays withheld
          }
          entry.reviewStatus = 'error'; // other 4xx and ambiguous preview failures
          return;
        }
        const preview = outcome.value as LaunchPreview;
        if (entry.revision === revision && entry.target === target) {
          entry.preview = {
            record: preview.record,
            contractDigest: preview.contractDigest,
            inputPreview: preview.inputPreview,
            revision,
            target,
          };
          // Retain the reviewed facts separately from the current approval;
          // later stale/denied transitions clear preview but keep this.
          entry.lastReviewed = {
            record: preview.record,
            contractDigest: preview.contractDigest,
            inputPreview: preview.inputPreview,
            revision,
            target,
          };
          entry.reviewStatus = 'current';
        } else if (entry.reviewStatus === 'resolving') {
          entry.reviewStatus = 'stale'; // the captured response no longer matches
        }
        entry.error = undefined;
      });
  };

  const launchReviewedDraft = (context: LaunchContext, token: string): Promise<LaunchReply> => {
    const key = contextKey(context);
    const entry = entries.get(key);
    if (entry?.pending) return entry.pending.promise as Promise<LaunchReply>;
    if (!entry) return Promise.reject(new Error('No reviewed draft to launch.'));
    if (entry.result) return Promise.reject(new Error('This draft already has a recorded launch outcome.'));
    const saved = entry.saved;
    if (!saved || !savedMatchesDraft(entry)) return Promise.reject(new Error('The reviewed brief is no longer current.'));
    const preview = entry.preview;
    const target = entry.target;
    if (!preview || preview.revision !== entry.revision || preview.target !== target) {
      return Promise.reject(new Error('Review the current target before launching.'));
    }
    if (!entry.assignmentId) return Promise.reject(new Error('The reviewed assignment identity is missing.'));
    const requestId = saved.requestId;
    const assignmentId = entry.assignmentId;
    const references = cloneReferences(saved.references);
    const expectedDigest = preview.contractDigest;
    const requestContext: LaunchContext = { ...context, target };
    entry.error = undefined;
    return registerPending(key, entry, 'launch', requestId, assignmentId,
      () => submitLaunchAssignment(requestContext, { requestId, assignmentId, references, expectedDigest }, token),
      outcome => {
        if (outcome.error !== undefined) {
          const error = outcome.error;
          entry.error = draftError('launch', error);
          if (error instanceof HttpError && error.reason === 'stale-preview') {
            entry.preview = undefined;
            entry.reviewStatus = 'stale';
            return;
          }
          if (error instanceof HttpError && error.reason === 'request-conflict') {
            entry.saved = undefined;
            entry.requestId = undefined;
            entry.assignmentId = undefined;
            entry.preview = undefined;
            entry.reviewStatus = 'error';
            return;
          }
          if (isDeniedRefusal(error)) {
            entry.preview = undefined;
            entry.reviewStatus = 'denied';
            return; // lastReviewed retained; dispatch stays withheld
          }
          if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
            entry.preview = undefined; // invalidate approval; require another review
            entry.reviewStatus = 'error';
            return;
          }
          // A transport failure or unknown 5xx after submission may have
          // reached the service: keep the reviewed facts and inspect.
          entry.result = { kind: 'unconfirmed', assignmentId };
          return;
        }
        const reply = outcome.value as LaunchReply;
        const state = reply.assignment?.state;
        const kind = state === 'live' ? 'launched' : state === 'launch_failed' ? 'failed' : 'unconfirmed';
        // The client-minted UUID identifies the attempt even when the reply
        // omits or replaces record fields.
        entry.result = { kind, assignmentId, assignment: reply.assignment, observation: reply.observation };
        entry.error = undefined;
      });
  };

  const beginCorrectedAttempt = (context: LaunchContext): LaunchResult | undefined => {
    const draft = entries.get(contextKey(context));
    if (!draft || draft.pending || draft.result?.kind !== 'failed') return undefined;
    const previous = draft.result;
    draft.result = undefined;
    draft.saved = undefined;
    draft.preview = undefined;
    draft.lastReviewed = undefined;
    // Both identities change even when the operator keeps the same text so the
    // stored handoff and failed assignment stay untouched.
    draft.requestId = crypto.randomUUID();
    draft.assignmentId = crypto.randomUUID();
    draft.revision += 1;
    draft.reviewStatus = 'idle';
    draft.error = undefined;
    notify();
    return previous;
  };

  return {
    getLaunchDraft,
    seedLaunchDraft,
    editLaunchDraft,
    changeLaunchTarget,
    saveLaunchDraft,
    reviewLaunchDraft,
    launchReviewedDraft,
    beginCorrectedAttempt,
  };
}

const launchStore = createLaunchStore();

export const getLaunchDraft = launchStore.getLaunchDraft;
export const seedLaunchDraft = launchStore.seedLaunchDraft;
export const editLaunchDraft = launchStore.editLaunchDraft;
export const changeLaunchTarget = launchStore.changeLaunchTarget;
export const saveLaunchDraft = launchStore.saveLaunchDraft;
export const reviewLaunchDraft = launchStore.reviewLaunchDraft;
export const launchReviewedDraft = launchStore.launchReviewedDraft;
export const beginCorrectedAttempt = launchStore.beginCorrectedAttempt;

// Side-effect-free route normalization: a cold review URL falls back to the
// brief, and a result URL is only honored when it matches the local result ID.
export function resolveLaunchStage(draft: LaunchDraft | undefined, request: LaunchStageRequest = {}): LaunchStageView {
  if (request.tab === 'review') return draft?.saved || draft?.preview ? 'review' : 'brief';
  if (request.tab === 'result') {
    const id = typeof request.id === 'string' && request.id ? request.id : undefined;
    if (!id) return 'brief';
    return draft?.result && draft.result.assignmentId === id ? 'result' : 'inspection';
  }
  return 'brief';
}

// One-use conversation draft seed for the result return journey. Step 10's
// Threads surface consumes this for the exact requested thread and fills an
// unsent composer draft; seeding never mutates a thread or sends a message.
export type ThreadDraftSeed = {
  assignmentId: string;
  requestId: string;
  outcome: LaunchResult['kind'];
  title: string;
  brief: string;
  executionDir: string;
  draft: string;
};

const threadDraftSeeds = new Map<string, ThreadDraftSeed>();
const threadDraftKey = (ws: string, thread: string): string => JSON.stringify([ws, thread]);

export function seedThreadDraft(ws: string, thread: string, seed: ThreadDraftSeed): void {
  if (!ws || !thread) return;
  threadDraftSeeds.set(threadDraftKey(ws, thread), { ...seed });
}

// Consuming clears the seed so a thread switch or remount cannot replay it.
export function consumeThreadDraft(ws: string, thread: string): ThreadDraftSeed | undefined {
  const key = threadDraftKey(ws, thread);
  const seed = threadDraftSeeds.get(key);
  if (seed) threadDraftSeeds.delete(key);
  return seed;
}
