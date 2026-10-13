// Launch-domain adapter over the existing JSON transport. The direct dispatch
// surface and the thread handoff surface bind identities and prerequisites
// differently but return the same review and launch facts; this module owns
// endpoint selection, the fixed instruction and the field mapping. It adds no
// fetch stack: api.ts stays the only JSON decoder.
import { postJson } from './api';
import type { InputPreview, ReferenceIdentity } from './composerTypes';
import type { WireRecord } from './model';

export type LaunchContext = { ws: string; thread?: string; target?: string | null; package?: string; skill?: string; authority?: 'none' | 'draft-pr' };
export type LaunchPreview = { record: WireRecord; contractDigest: string; inputPreview?: InputPreview };
export type LaunchReply = { assignment: WireRecord; observation: WireRecord };
export const FIXED_INSTRUCTION = 'Perform the attached assignment brief.';

export type LaunchBriefInput = { title: string; content: string; references?: readonly ReferenceIdentity[] };
export type LaunchPreviewInput = { requestId: string; assignmentId: string; references?: readonly ReferenceIdentity[] };
export type LaunchSubmitInput = LaunchPreviewInput & { expectedDigest: string };

const THREAD_SAVE = '/api/thread/save-brief';
const THREAD_PREVIEW = '/api/thread/preview-assignment';
const THREAD_LAUNCH = '/api/thread/launch-assignment';
const DIRECT_SAVE = '/api/dispatch/save-brief';
const DIRECT_PREVIEW = '/api/dispatch/preview';
const DIRECT_LAUNCH = '/api/dispatch/launch';

// References cross the wire as identity only; labels, tokens and paths stay in
// the browser. Direct preview/launch send them per request; thread preview and
// launch reuse the identities stored with the saved brief instead.
const identityOnly = (references: readonly ReferenceIdentity[] | undefined): ReferenceIdentity[] =>
  (references ?? []).map(({ kind, id }) => ({ kind, id }));

const asRecord = (value: unknown): WireRecord =>
  value !== null && typeof value === 'object' ? value as WireRecord : {};

const normalizePreview = (data: WireRecord | null | undefined): LaunchPreview => {
  const preview: LaunchPreview = {
    record: asRecord(data?.record),
    contractDigest: typeof data?.contractDigest === 'string' ? data.contractDigest : '',
  };
  if (data?.inputPreview !== null && typeof data?.inputPreview === 'object') preview.inputPreview = data.inputPreview as InputPreview;
  return preview;
};

const normalizeReply = (data: WireRecord | null | undefined): LaunchReply => ({
  assignment: asRecord(data?.assignment),
  observation: asRecord(data?.observation),
});

const skillOf = (ctx: LaunchContext): string => ctx.skill || 'general';

// Suggestions follow the identity that owns the target. Thread contexts read
// the stored thread binding through the thread endpoint and never carry the
// route target; direct contexts keep the retained draft target so an edit
// retargets the request and its cancellation signature together.
export type LaunchSuggestionSource = { path: string; params: Record<string, string> };

export function suggestionSourceFor(context: LaunchContext, target: string | null): LaunchSuggestionSource {
  if (context.thread) {
    return { path: '/api/thread/suggestions', params: { workspace_id: context.ws, thread_id: context.thread } };
  }
  return {
    path: '/api/dispatch/suggestions',
    params: { workspace_id: context.ws, ...(target ? { repository_id: target } : {}) },
  };
}

const threadAssignmentBody = (ctx: LaunchContext, ids: LaunchPreviewInput) => ({
  workspace_id: ctx.ws,
  thread_id: ctx.thread,
  request_id: ids.requestId,
  assignment_id: ids.assignmentId,
  instructions: FIXED_INSTRUCTION,
  skill: skillOf(ctx),
  ...(ctx.package ? { specPackage: ctx.package } : {}),
});

const directAssignmentBody = (ctx: LaunchContext, ids: LaunchPreviewInput) => ({
  workspace_id: ctx.ws,
  ...(ctx.target ? { repository_id: ctx.target } : {}),
  request_id: ids.requestId,
  assignment_id: ids.assignmentId,
  instructions: FIXED_INSTRUCTION,
  references: identityOnly(ids.references),
  skill: skillOf(ctx),
  ...(ctx.package ? { spec_package: ctx.package } : {}),
  // The bound presentation owns publication authority; only an explicitly
  // derived value crosses the wire, and thread bodies never carry it.
  ...(ctx.authority ? { publication_authority: ctx.authority } : {}),
});

export function saveLaunchBrief(ctx: LaunchContext, requestId: string, brief: LaunchBriefInput, token: string, signal?: AbortSignal): Promise<WireRecord> {
  if (ctx.thread) {
    return postJson<WireRecord>(THREAD_SAVE, {
      workspace_id: ctx.ws,
      thread_id: ctx.thread,
      request_id: requestId,
      title: brief.title,
      content: brief.content,
      references: identityOnly(brief.references),
    }, token, signal);
  }
  return postJson<WireRecord>(DIRECT_SAVE, {
    workspace_id: ctx.ws,
    request_id: requestId,
    title: brief.title,
    content: brief.content,
  }, token, signal);
}

export async function previewLaunchAssignment(ctx: LaunchContext, input: LaunchPreviewInput, token: string, signal?: AbortSignal): Promise<LaunchPreview> {
  if (ctx.package) await postJson('/api/dispatch/prepare-spec-target', {
    workspace_id: ctx.ws, spec_package: ctx.package,
    ...(ctx.thread ? { thread_id: ctx.thread } : { repository_id: ctx.target }),
  }, token, signal);
  const data = ctx.thread
    ? await postJson<WireRecord>(THREAD_PREVIEW, threadAssignmentBody(ctx, input), token, signal)
    : await postJson<WireRecord>(DIRECT_PREVIEW, directAssignmentBody(ctx, input), token, signal);
  return normalizePreview(data);
}

export async function submitLaunchAssignment(ctx: LaunchContext, input: LaunchSubmitInput, token: string, signal?: AbortSignal): Promise<LaunchReply> {
  const ids = { requestId: input.requestId, assignmentId: input.assignmentId, references: input.references };
  const body = ctx.thread ? threadAssignmentBody(ctx, ids) : directAssignmentBody(ctx, ids);
  const data = await postJson<WireRecord>(ctx.thread ? THREAD_LAUNCH : DIRECT_LAUNCH, { ...body, expectedDigest: input.expectedDigest }, token, signal);
  return normalizeReply(data);
}
