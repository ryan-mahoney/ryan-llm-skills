import type { Envelope, WireRecord } from '../model';
import type { StatusTone } from '../primitives';
import type { RouteState } from '../route';
import type { CatalogEntry } from '../scope';
import { base, str, stale } from '../format';
import { epicStats } from '../observation-format';
import { catalogEntryForRecord, workspaceRelativePath } from '../scope';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function visibleEpics(epics: WireRecord[], query: string): WireRecord[] {
  const list = (epics ?? []).filter(Boolean);
  const q = (text(query) ?? '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(epic => {
    const members = Array.isArray(epic.members) ? epic.members : [];
    return [epic.title, epic.epic, epic.workspace, ...members.map((member: WireRecord) => member?.name)]
      .some(value => str(value).toLowerCase().includes(q));
  });
}

const RECORDED_STATE_LABELS: Record<string, string> = {
  planned: 'Planned',
  active: 'Active',
  complete: 'Complete',
  abandoned: 'Abandoned',
};

export function epicRecordedState(epic: WireRecord): { label: string; tone: StatusTone; conflict: boolean } {
  const state = text(epic?.state);
  if (!state) return { label: 'Not recorded', tone: 'neutral', conflict: false };
  const label = Object.hasOwn(RECORDED_STATE_LABELS, state) ? RECORDED_STATE_LABELS[state] : undefined;
  if (!label) return { label: state, tone: 'neutral', conflict: false };
  if (state !== 'complete') return { label, tone: 'neutral', conflict: false };
  const { landed, total } = epicStats(epic);
  if (landed < total) return { label: 'Recorded complete', tone: 'warning', conflict: true };
  return { label, tone: 'success', conflict: false };
}

const MEMBER_STATUSES: Record<string, { label: string; tone: StatusTone }> = {
  merged: { label: 'Merged', tone: 'success' },
  complete: { label: 'Marked complete', tone: 'success' },
  published: { label: 'PR published', tone: 'info' },
  'in-progress': { label: 'In progress', tone: 'info' },
  prepared: { label: 'Prepared', tone: 'neutral' },
  proposed: { label: 'Proposed', tone: 'neutral' },
  missing: { label: 'Package missing', tone: 'warning' },
  unobserved: { label: 'Not observed', tone: 'warning' },
  unknown: { label: 'Evidence incomplete', tone: 'warning' },
};

export function epicMemberStatus(member: WireRecord): { label: string; tone: StatusTone } {
  const status = text(member?.status);
  if (!status) return { label: 'Not recorded', tone: 'neutral' };
  const known = Object.hasOwn(MEMBER_STATUSES, status) ? MEMBER_STATUSES[status] : undefined;
  if (!known) return { label: status, tone: 'neutral' };
  if (status !== 'in-progress') return known;
  const position = Number.isSafeInteger(member?.step?.position) ? member.step.position : null;
  const total = Number.isSafeInteger(member?.step?.total) ? member.step.total : null;
  const step = position !== null && total !== null ? ` · step ${position} of ${total}` : '';
  if (member?.attention === true) return { label: `${known.label}${step} · needs attention`, tone: 'warning' };
  return { label: `${known.label}${step}`, tone: known.tone };
}

export function epicMemberRequires(member: WireRecord): { names: string[]; waiting: string[]; declared: boolean } {
  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && Boolean(name)) : [];
  const waiting = stringList(member?.waiting_on);
  const declared = Array.isArray(member?.requires);
  return { names: declared ? stringList(member.requires) : [...waiting], waiting: [...waiting], declared };
}

export function memberRecords(records: WireRecord[], workspace: string, slug: string): WireRecord[] {
  return (records ?? []).filter(record => record?.workspace === workspace && base(record?.package) === slug);
}

export function focusMember(epic: WireRecord): { name: string; reason: 'attention' | 'evidence' | 'next' | 'in-progress' | 'published' } | null {
  const members = (Array.isArray(epic?.members) ? epic.members : []).filter((member: WireRecord) => text(member?.name));
  const first = (predicate: (member: WireRecord) => boolean) => members.find(predicate);
  const attention = first(member => member.attention === true);
  if (attention) return { name: attention.name, reason: 'attention' };
  const evidence = first(member => ['unknown', 'missing', 'unobserved'].includes(member.status));
  if (evidence) return { name: evidence.name, reason: 'evidence' };
  const next = members.find(member => member.name === epic?.next);
  if (next) return { name: next.name, reason: 'next' };
  const inProgress = first(member => member.status === 'in-progress');
  if (inProgress) return { name: inProgress.name, reason: 'in-progress' };
  const published = first(member => member.status === 'published');
  if (published) return { name: published.name, reason: 'published' };
  return null;
}

export function epicCoverageReasons(epic: WireRecord): string[] {
  const reasons = Array.isArray(epic?.coverage?.reasons) ? epic.coverage.reasons : [];
  return reasons.map((reason: unknown) => {
    const value = String(reason);
    const incomplete = /^member-incomplete:(.+)$/.exec(value);
    if (incomplete) return `${incomplete[1]}: receipts or checkpoints could not be fully read`;
    const unobserved = /^member-unobserved:(.+)$/.exec(value);
    if (unobserved) return `${unobserved[1]}: workspace not observed`;
    return value;
  });
}

export type EpicViewState = {
  read: 'loading' | 'error' | 'ready';
  empty: 'none' | 'no-epics' | 'unsupported' | 'no-snapshot' | 'no-matches';
  partial: boolean;
  offline: boolean;
  stale: boolean;
  observedAt: string | null;
};

export function epicViewState(input: {
  payload: Envelope | null;
  live: boolean;
  connectionFailed: boolean;
  imported: boolean;
  epicSupport: string | null | undefined;
  scoped: WireRecord[];
  visible: WireRecord[];
  selected: WireRecord | null;
}): EpicViewState {
  const scoped = Array.isArray(input.scoped) ? input.scoped : [];
  const visible = Array.isArray(input.visible) ? input.visible : [];
  const selected = input.selected ?? null;
  if (!input.live && !input.payload) {
    return { read: 'ready', empty: 'no-snapshot', partial: false, offline: false, stale: false, observedAt: null };
  }
  if (!input.payload) {
    return { read: input.connectionFailed ? 'error' : 'loading', empty: 'none', partial: false, offline: false, stale: false, observedAt: null };
  }
  const offline = input.live && !input.imported && input.connectionFailed;
  const evidenceIncomplete = Array.isArray(selected?.members)
    && selected.members.some((member: WireRecord) => ['unknown', 'missing', 'unobserved'].includes(member?.status));
  const partial = selected !== null
    && (selected.coverage?.state !== 'complete' || epicRecordedState(selected).conflict || evidenceIncomplete);
  const observedAt = text(selected?.observer?.snapshot?.coverage?.observed_at)
    ?? text(selected?.coverage?.observed_at)
    ?? null;
  const staleView = input.live && !input.imported && !offline && selected !== null
    && (selected.observer?.state !== 'observing' || stale(selected.observer?.snapshot?.coverage?.observed_at));
  const empty = scoped.length === 0
    ? (input.epicSupport === 'No observer snapshots' ? 'no-snapshot'
      : input.epicSupport === 'Epic data unavailable' ? 'unsupported' : 'no-epics')
    : (visible.length === 0 ? 'no-matches' : 'none');
  return { read: 'ready', empty, partial, offline, stale: staleView, observedAt };
}

export function epicDocumentLinks(epic: WireRecord, catalog: CatalogEntry[], preferredId?: string): {
  plan: { name: string; source: string; route: RouteState | null } | null;
  designs: { name: string; source: string; route: RouteState | null }[];
} {
  const entries = Array.isArray(catalog) ? catalog : [];
  const planPath = text(epic?.plan);
  let plan: { name: string; source: string; route: RouteState | null } | null = null;
  if (planPath) {
    const entry = catalogEntryForRecord(epic, 'epic', entries, preferredId);
    const relative = entry ? workspaceRelativePath(entry.directory, planPath) : null;
    plan = {
      name: base(planPath),
      source: planPath,
      route: entry && relative ? { dest: 'files', ws: entry.id, source: 'workspace', path: relative } : null,
    };
  }
  const designs: { name: string; source: string; route: RouteState | null }[] =
    (Array.isArray(epic?.designs) ? epic.designs : []).flatMap((design: WireRecord) => {
      const name = text(design?.design);
      if (!name) return [];
      const declared = text(design?.workspace);
      const idMatch = declared ? entries.find(entry => entry?.id === declared) : undefined;
      const entry = idMatch ?? (declared ? catalogEntryForRecord({ workspace: declared }, 'epic', entries, preferredId) : undefined);
      return [{
        name,
        source: text(design?.path) ?? declared ?? name,
        route: entry ? { dest: 'designs', ws: entry.id, id: name } : null,
      }];
    });
  return { plan, designs };
}
