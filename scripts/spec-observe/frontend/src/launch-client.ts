// Launch-domain adapter over the existing JSON transport. The direct dispatch
// surface and the thread handoff surface bind identities and prerequisites
// differently but return the same review and launch facts; this module owns
// endpoint selection, the fixed instruction and the field mapping. It adds no
// fetch stack: api.ts stays the only JSON decoder.
import { getJson, postJson } from './api';
import type { InputPreview, ReferenceIdentity } from './composerTypes';
import type { WireRecord } from './model';

import type { ModelChoice } from './models-state';

export type LaunchStop = 'critique' | 'proposal' | 'prepared';
export type LaunchContext = { ws: string; thread?: string; target?: string | null; package?: string; skill?: string; authority?: 'none' | 'draft-pr'; model?: ModelChoice | null; stop?: LaunchStop };
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
  ...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.model } : {}),
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
  ...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.model } : {}),
});

// A bound direct hand-off carries the package's canonical primary path, while
// the assignment backend binds targets by repository id. Resolve the requested
// absolute path against the workspace's usable repository inventory: exactly
// one usable repository must match its stored canonical_path (physical
// realpath) or, for older snapshots, its declared path as written or relative
// to the workspace directory. Already-resolved repository ids, generic direct
// contexts and thread contexts pass through, and an absent or ambiguous match
// refuses explicitly instead of guessing a package alias.
const boundRepositoryId = async (ctx: LaunchContext, signal?: AbortSignal): Promise<string | null> => {
  if (ctx.thread || !ctx.package || typeof ctx.target !== 'string' || !ctx.target.startsWith('/')) return ctx.target ?? null;
  const workspace = await getJson<WireRecord>('/api/workspace?' + new URLSearchParams({ id: ctx.ws }).toString(), signal);
  const directory = typeof workspace.directory === 'string' ? workspace.directory.replace(/\/+$/, '') : '';
  const declares = (repository: WireRecord): boolean => {
    // The stored physical checkout wins; the declared path stays the fallback
    // for older snapshots and fixtures that predate canonical_path.
    if (repository.canonical_path === ctx.target) return true;
    const path = repository.path;
    if (typeof path !== 'string' || path === '' || path.startsWith('~')) return false;
    if (path === ctx.target) return true;
    return !path.startsWith('/') && directory !== '' && `${directory}/${path.replace(/^\.\//, '')}` === ctx.target;
  };
  const matches = (Array.isArray(workspace.repositories) ? workspace.repositories : [])
    .filter(repository => repository && repository.status === 'ok' && typeof repository.id === 'string' && repository.id && declares(repository));
  if (matches.length === 0) throw new Error(`The package target ${ctx.target} is not a usable repository in this workspace.`);
  if (matches.length > 1) throw new Error(`The package target ${ctx.target} matches more than one repository in this workspace.`);
  return matches[0].id as string;
};

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
  const bound: LaunchContext = { ...ctx, target: await boundRepositoryId(ctx, signal) };
  if (bound.package) await postJson('/api/dispatch/prepare-spec-target', {
    workspace_id: bound.ws, spec_package: bound.package,
    ...(bound.thread ? { thread_id: bound.thread } : { repository_id: bound.target }),
  }, token, signal);
  const data = bound.thread
    ? await postJson<WireRecord>(THREAD_PREVIEW, threadAssignmentBody(bound, input), token, signal)
    : await postJson<WireRecord>(DIRECT_PREVIEW, directAssignmentBody(bound, input), token, signal);
  return normalizePreview(data);
}

export async function submitLaunchAssignment(ctx: LaunchContext, input: LaunchSubmitInput, token: string, signal?: AbortSignal): Promise<LaunchReply> {
  const ids = { requestId: input.requestId, assignmentId: input.assignmentId, references: input.references };
  const bound: LaunchContext = { ...ctx, target: await boundRepositoryId(ctx, signal) };
  const body = bound.thread ? threadAssignmentBody(bound, ids) : directAssignmentBody(bound, ids);
  const data = await postJson<WireRecord>(bound.thread ? THREAD_LAUNCH : DIRECT_LAUNCH, { ...body, expectedDigest: input.expectedDigest }, token, signal);
  return normalizeReply(data);
}
