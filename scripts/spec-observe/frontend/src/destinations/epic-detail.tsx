import { For, Show, type JSX } from 'solid-js';
import { ActionBar, StateNotice, StatusText } from '../primitives';
import type { WireRecord } from '../model';
import { epicStats } from '../observation-format';
import {
  epicCoverageReasons,
  epicMemberRequires,
  epicMemberStatus,
  epicRecordedState,
  focusMember,
  memberRecords,
} from './epic-state';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): WireRecord[] => (Array.isArray(value) ? value.filter(Boolean) : []);
const memberName = (member: WireRecord): string => text(member?.name);
const memberWorkspace = (epic: WireRecord, member: WireRecord): string => text(member?.workspace) || text(epic?.workspace);
const epicTitle = (epic: WireRecord): string => text(epic?.title) || text(epic?.epic) || 'Untitled epic';
const recordedFact = (recorded: { label: string; conflict: boolean }): string => {
  if (!recorded.conflict) return recorded.label;
  const state = recorded.label.replace(/^Recorded /, '');
  return state.charAt(0).toUpperCase() + state.slice(1);
};

export function EpicObjectHead(props: { epic: WireRecord }) {
  const recorded = () => epicRecordedState(props.epic);
  const trail = () => [text(props.epic.workspace), text(props.epic.epic)].filter(Boolean).join(' / ');
  return (
    <div class="object-head">
      <div class="object-top">
        <h2>{epicTitle(props.epic)}</h2>
        <StatusText tone={recorded().tone}>{recorded().label}</StatusText>
      </div>
      <p>{trail() || 'Epic record'}</p>
    </div>
  );
}

export function EpicConflictNotice(props: { epic: WireRecord }) {
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);
  return (
    <Show when={recorded().conflict}>
      <StateNotice tone="warning" title="Recorded state conflicts with member evidence">
        {`The epic is recorded as ${recordedFact(recorded())}, but landing is confirmed for ${stats().landed} of ${stats().total} members in this observation. The records have not been rewritten; the conflicting evidence is preserved.`}
      </StateNotice>
    </Show>
  );
}

function nextFact(epic: WireRecord): { label: string; note: string } {
  const candidate = text(epic.next) || '';
  if (!candidate) {
    const waiting = list(epic.members).filter(member => epicMemberRequires(member).waiting.length).length;
    if (waiting > 0) return { label: 'None eligible', note: `${waiting} members wait on unlanded requirements` };
    const stats = epicStats(epic);
    if (stats.total > 0 && stats.landed >= stats.total) return { label: 'None eligible', note: 'All members landed' };
    return { label: 'None eligible', note: 'No eligible candidate in this observation' };
  }
  const member = list(epic.members).find(item => memberName(item) === candidate) ?? null;
  if (!member) return { label: candidate, note: 'No requirements' };
  const requires = epicMemberRequires(member);
  if (!requires.declared) return { label: candidate, note: 'Only unmet requirements reported' };
  if (requires.names.length) return { label: candidate, note: `Requires ${requires.names.join(', ')}` };
  return { label: candidate, note: 'No requirements' };
}

export function EpicFacts(props: { epic: WireRecord }) {
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);
  const next = () => nextFact(props.epic);
  return (
    <div class="facts">
      <div class="fact">
        <label>Recorded epic state</label>
        <strong>{recordedFact(recorded())}</strong>
        <p>Operator-managed record</p>
      </div>
      <div class="fact">
        <label>Members landed</label>
        <strong class="mono">{`${stats().landed} of ${stats().total}`}</strong>
        <p>Derived from member evidence</p>
      </div>
      <div class="fact">
        <label>Next candidate</label>
        <strong>{next().label}</strong>
        <p>{next().note}</p>
      </div>
    </div>
  );
}

export function EpicMembersTable(props: {
  epic: WireRecord;
  records: WireRecord[];
  rememberedMember?: string | null;
  onSelectPackage: (workspace: string, slug: string) => void;
}) {
  const members = () => list(props.epic.members);
  const unmetOnly = () => members().some(member => !epicMemberRequires(member).declared);
  return (
    <section class="section">
      <div class="section-heading"><h3>Dependency order</h3><span class="muted" /></div>
      <Show when={members().length} fallback={<p class="muted">No members recorded.</p>}>
        <div class="table-wrap">
          <table class="epic-members">
            <caption class="sr-only">{`Members of ${epicTitle(props.epic)} in dependency order`}</caption>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Requires</th>
                <th scope="col">Observed status</th>
              </tr>
            </thead>
            <tbody>
              <For each={members()}>{member => {
                const name = () => memberName(member);
                const workspace = () => memberWorkspace(props.epic, member);
                const requires = () => epicMemberRequires(member);
                const observed = () => epicMemberStatus(member);
                const matched = () => memberRecords(props.records, workspace(), name()).length > 0;
                const remembered = () => Boolean(name()) && props.rememberedMember === name();
                return (
                  <tr data-remembered-member={remembered() ? 'true' : undefined}>
                    <th scope="row">
                      <Show
                        when={matched()}
                        fallback={
                          <>
                            <span class="mono">{name() || 'Unnamed member'}</span>
                            <br />
                            <small class="muted">No observed package matches this member in scope.</small>
                          </>
                        }
                      >
                        <button
                          type="button"
                          class="text-link mono"
                          aria-current={remembered() ? 'true' : undefined}
                          onClick={() => props.onSelectPackage(workspace(), name())}
                        >
                          {name() || 'Unnamed member'}
                        </button>
                      </Show>
                    </th>
                    <td>{requires().names.length ? requires().names.map(name => requires().waiting.includes(name) ? `${name} \u00b7 waiting` : name).join(', ') : '—'}</td>
                    <td><StatusText tone={observed().tone}>{observed().label}</StatusText></td>
                  </tr>
                );
              }}</For>
            </tbody>
          </table>
        </div>
        <Show when={unmetOnly()}>
          <p class="section-note">This observer reports only unmet requirements.</p>
        </Show>
      </Show>
    </section>
  );
}

export function EpicNext(props: { epic: WireRecord }) {
  const members = () => list(props.epic.members);
  const focus = () => focusMember(props.epic);
  const lead = () => {
    const target = focus();
    if (!target) return 'No member requires inspection in this observation.';
    switch (target.reason) {
      case 'attention':
        return `Inspect ${target.name}: its recorded observation needs attention.`;
      case 'evidence':
        return `Inspect ${target.name}: landing evidence is missing or incomplete.`;
      case 'next':
        return `Inspect ${target.name}, the next member in the dependency order.`;
      case 'in-progress':
        return `Inspect ${target.name}: work is recorded in progress.`;
      default:
        return `Inspect ${target.name}: its PR is published, but landing is not confirmed.`;
    }
  };
  const detail = () => {
    const parts: string[] = [];
    const last = [...members()].reverse().find(member => epicMemberRequires(member).names.length);
    if (last) parts.push(`${memberName(last)} depends on ${epicMemberRequires(last).names.join(', ')}.`);
    const statuses = new Set(members().map(member => text(member.status)));
    if (statuses.has('prepared')) parts.push('Prepared work is not landed work.');
    if (statuses.has('published')) parts.push('PR-published work is not landed work.');
    return parts.join(' ');
  };
  return (
    <section class="section">
      <div class="section-heading"><h3>Next member</h3><span class="muted" /></div>
      <div class="obligation">
        {lead()}
        <Show when={detail()}><p>{detail()}</p></Show>
      </div>
    </section>
  );
}

export function EpicNotes(props: { epic: WireRecord }) {
  const notes = () => list(props.epic.members).filter(member => text(member?.note));
  return (
    <Show when={notes().length}>
      <section class="section">
        <div class="section-heading"><h3>Member notes</h3><span class="muted" /></div>
        <For each={notes()}>
          {member => <p>{`${memberName(member) || 'Unnamed member'}: ${text(member.note)}`}</p>}
        </For>
      </section>
    </Show>
  );
}

export function EpicDetail(props: {
  epic: WireRecord;
  records: WireRecord[];
  rememberedMember?: string | null;
  onSelectPackage: (workspace: string, slug: string) => void;
  notice?: JSX.Element;
  transportPrimary?: boolean;
}) {
  const target = () => focusMember(props.epic);
  const openMember = () => {
    const focus = target();
    if (!focus) return null;
    const member = list(props.epic.members).find(item => memberName(item) === focus.name) ?? null;
    if (!member) return null;
    return memberRecords(props.records, memberWorkspace(props.epic, member), focus.name).length ? member : null;
  };
  const openReason = () => {
    const focus = target();
    if (!focus) return 'No member needs inspection in this observation.';
    return `${focus.name} has no observed spec in this snapshot.`;
  };
  const openSpec = () => {
    const member = openMember();
    if (!member) return;
    props.onSelectPackage(memberWorkspace(props.epic, member), memberName(member));
  };
  const coverage = () => epicCoverageReasons(props.epic);
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);
  const conflictCompact = () => {
    if (!props.transportPrimary || !recorded().conflict) return '';
    return `The epic is recorded as ${recordedFact(recorded())}, but landing is confirmed for ${stats().landed} of ${stats().total} members in this observation. The records have not been rewritten; the conflicting evidence is preserved.`;
  };
  return (
    <>
      <EpicObjectHead epic={props.epic} />
      <div class="detail-body">
        {/* Regional notice slot: epics.tsx owns offline > stale > partial as
            the single live notice. When transport wins, the completion
            conflict stays as compact non-live text beside the landed fact
            and never becomes a second live region. */}
        <Show when={props.notice}>{props.notice}</Show>
        <Show when={conflictCompact()}>{compact => <p class="section-note">{compact()}</p>}</Show>
        <EpicFacts epic={props.epic} />
        <Show when={coverage().length}>
          <p class="section-note">{`Coverage ${text(props.epic.coverage?.state) || 'partial'}: ${coverage().join('; ')}`}</p>
        </Show>
        <EpicMembersTable epic={props.epic} records={props.records} rememberedMember={props.rememberedMember} onSelectPackage={props.onSelectPackage} />
        <EpicNext epic={props.epic} />
        <EpicNotes epic={props.epic} />
      </div>
      <ActionBar>
        <button
          type="button"
          class={props.transportPrimary ? 'ds-btn' : 'ds-btn ds-btn--primary'}
          disabled={!openMember()}
          aria-describedby={!openMember() ? 'epic-open-spec-help' : undefined}
          onClick={openSpec}
        >
          Open spec
        </button>
        <Show when={!openMember()}>
          <p id="epic-open-spec-help" class="small muted">{openReason()}</p>
        </Show>
      </ActionBar>
    </>
  );
}
