import { assignmentEnded } from "./observation-format";
import { authoritativeObservers } from "./model";
import type { Envelope, WireRecord } from "./model";
import type { RouteState } from "./route";

export type AgentFilter = "active" | "ended";
export type AgentViewState =
  "loading" | "error" | "empty" | "no-matches" | "offline" | "stale" | "ready";
export type AgentGuidance = {
  headline: string;
  caution?: string;
  primary: "open-spec" | "copy-locate";
};
export type AgentCoverage = {
  sourceUnavailable: boolean;
  listPartial: boolean;
  selectedObservedAt: string | null;
  listObservedAt: string | null;
};

const UNCERTAIN_DISPLAYS = new Set([
  "unknown",
  "terminal-lost",
  "launch-unconfirmed",
  "live-unrecorded",
  "exited-unrecorded",
]);
const LOCATE_HEADLINE =
  "Locate this assignment and confirm its recorded process identity.";
const UNCERTAIN_CAUTION =
  "Do not start another writer while this assignment’s liveness is uncertain.";
const SEARCH_FIELDS = [
  "assignment_id",
  "spec_package",
  "workflow_id",
  "display",
  "nextAction",
  "safeAction",
  "execution_dir",
] as const;

const searchText = (value: unknown): string =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
const foldQuery = (query: unknown): string =>
  (typeof query === "string" ? query : "").trim().toLowerCase();
const queryMatches = (a: WireRecord, foldedQuery: string): boolean =>
  !foldedQuery ||
  SEARCH_FIELDS.some((field) =>
    searchText(a?.[field]).toLowerCase().includes(foldedQuery),
  );
const observerWorkspace = (observer: WireRecord): string =>
  observer?.snapshot?.workspace ||
  observer?.observer_id ||
  observer?.source ||
  "unknown";
const parsedTime = (value: unknown): number | null => {
  const time = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(time) ? time : null;
};
const coverageObservedAt = (
  coverage: WireRecord | null | undefined,
): string | null =>
  typeof coverage?.observed_at === "string" &&
  parsedTime(coverage.observed_at) !== null
    ? coverage.observed_at
    : null;

// Process death is never inferred from presentation: only the projected
// uncertain displays plus workersUnconfirmed qualify. Quiet and attached
// presence are informational and never grant control or change the group.
export function identityUncertain(a: WireRecord): boolean {
  return UNCERTAIN_DISPLAYS.has(a?.display) || a?.workersUnconfirmed === true;
}

export function effectiveAgentFilter(
  route: RouteState,
  assignments: WireRecord[],
): AgentFilter {
  const explicit = route?.filter;
  if (explicit === "active" || explicit === "ended") return explicit;
  const id = typeof route?.id === "string" && route.id ? route.id : null;
  if (id) {
    const matched =
      assignments.find((item) => item?.key === id) ??
      assignments.find((item) => item?.assignment_id === id);
    if (matched) return assignmentEnded(matched) ? "ended" : "active";
  }
  const query = foldQuery(route?.q);
  if (query) {
    const activeMatches = assignments.filter(
      (item) => !assignmentEnded(item) && queryMatches(item, query),
    );
    if (!activeMatches.length) {
      const endedMatches = assignments.filter(
        (item) => assignmentEnded(item) && queryMatches(item, query),
      );
      if (endedMatches.length) return "ended";
    }
  }
  return "active";
}

export function visibleAgents(
  assignments: WireRecord[],
  filter: AgentFilter,
  query: string,
): WireRecord[] {
  const folded = foldQuery(query);
  return assignments
    .filter(
      (item) =>
        (filter === "ended") === assignmentEnded(item) &&
        queryMatches(item, folded),
    )
    .sort(
      (a, b) =>
        Number(identityUncertain(b)) - Number(identityUncertain(a)) ||
        searchText(a.spec_package).localeCompare(searchText(b.spec_package)) ||
        searchText(a.assignment_id).localeCompare(
          searchText(b.assignment_id),
        ) ||
        searchText(a.key).localeCompare(searchText(b.key)),
    );
}

export function agentCounts(assignments: WireRecord[]): {
  active: number;
  ended: number;
} {
  let active = 0,
    ended = 0;
  for (const item of assignments) assignmentEnded(item) ? ended++ : active++;
  return { active, ended };
}

export function agentViewState(input: {
  payloadPresent: boolean;
  live: boolean;
  connectionFailed: boolean;
  sourceUnavailable: boolean;
  observationStale: boolean;
  total: number;
  visible: number;
  query: string;
}): AgentViewState {
  if (!input.payloadPresent && input.connectionFailed) return "error";
  if (!input.payloadPresent) return "loading";
  if (input.sourceUnavailable) return "error";
  if (input.connectionFailed) return "offline";
  if (input.live && input.observationStale) return "stale";
  if (input.total === 0) return "empty";
  if (input.visible === 0) return "no-matches";
  return "ready";
}

// Resolves observation timestamps only; the caller classifies them with
// stale(). Never falls through to a newer unrelated observer or heartbeat.
export function agentCoverage(
  payload: Envelope | null,
  scopedRows: WireRecord[],
  selected: WireRecord | null,
): AgentCoverage {
  const observers = authoritativeObservers(payload?.observers ?? []);
  const owners = new Map<string, WireRecord>();
  for (const observer of observers)
    owners.set(observerWorkspace(observer), observer);

  const selectedWorkspace =
    typeof selected?.workspace === "string" && selected.workspace
      ? selected.workspace
      : null;
  const selectedOwner = selectedWorkspace
    ? (owners.get(selectedWorkspace) ?? null)
    : null;
  const selectedCoverage = selectedOwner?.snapshot?.assignment_coverage ?? null;
  const selectedUnavailable =
    !selectedOwner ||
    !selectedCoverage ||
    selectedCoverage.state === "unavailable";
  let selectedObservedAt = coverageObservedAt(selectedCoverage);
  if (selectedObservedAt === null && selectedOwner && selectedCoverage == null)
    selectedObservedAt = coverageObservedAt(selectedOwner.snapshot?.coverage);
  if (selectedObservedAt === null)
    selectedObservedAt = coverageObservedAt(selected?.assignment_coverage);

  const mapped: WireRecord[] = [];
  if (scopedRows.length === 0) mapped.push(...observers);
  else {
    const seen = new Set<string>();
    for (const row of scopedRows) {
      const workspace = typeof row?.workspace === "string" ? row.workspace : "";
      if (!workspace || seen.has(workspace)) continue;
      seen.add(workspace);
      const owner = owners.get(workspace);
      if (owner) mapped.push(owner);
    }
  }

  let listObservedAt: string | null = null;
  let newest = -Infinity;
  let unavailable = 0;
  let partial = false;
  for (const owner of mapped) {
    const coverage = owner.snapshot?.assignment_coverage ?? null;
    if (!coverage || coverage.state === "unavailable") unavailable++;
    if (coverage?.state === "partial") partial = true;
    const candidate =
      coverageObservedAt(coverage) ??
      (coverage == null
        ? coverageObservedAt(owner.snapshot?.coverage)
        : null);
    const time = candidate === null ? null : parsedTime(candidate);
    if (time !== null && time > newest) {
      newest = time;
      listObservedAt = candidate;
    }
  }

  return {
    sourceUnavailable: selected
      ? selectedUnavailable
      : mapped.length > 0 && unavailable === mapped.length,
    listPartial:
      mapped.length > 0 &&
      (partial || (unavailable > 0 && unavailable < mapped.length)),
    selectedObservedAt,
    listObservedAt,
  };
}

export function retainSelectedAgent(
  current: WireRecord | null,
  previous: WireRecord | null,
  sameContext: boolean,
  sourceComplete: boolean,
): WireRecord | null {
  if (current != null) return current;
  if (!sameContext) return null;
  if (previous != null && !sourceComplete) return previous;
  return null;
}

export function agentGuidance(
  a: WireRecord,
  hasRelatedSpec: boolean,
): AgentGuidance {
  const locate =
    typeof a?.locate_command === "string" && a.locate_command
      ? a.locate_command
      : null;
  const next = typeof a?.nextAction === "string" ? a.nextAction : "";
  const uncertain = identityUncertain(a);
  return {
    headline: locate !== null && next === locate ? LOCATE_HEADLINE : next,
    ...(uncertain ? { caution: UNCERTAIN_CAUTION } : {}),
    primary: uncertain || !hasRelatedSpec ? "copy-locate" : "open-spec",
  };
}
