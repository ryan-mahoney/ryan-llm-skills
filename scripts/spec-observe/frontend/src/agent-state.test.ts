import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCounts,
  agentCoverage,
  agentGuidance,
  agentViewState,
  effectiveAgentFilter,
  identityUncertain,
  retainSelectedAgent,
  visibleAgents,
} from "./agent-state";
import { setClock, stale } from "./format";

const T = "2026-03-04T05:06:07.000Z";
const T_OLD = "2026-03-04T04:00:00.000Z";
const T_FRESH = "2026-03-04T05:06:00.000Z";
const T_LEGACY = "2026-03-04T03:00:00.000Z";

const filterRows = [
  {
    key: "k-live",
    assignment_id: "live-1",
    display: "live",
    spec_package: "pkg/live",
  },
  {
    key: "k-ended",
    assignment_id: "ended-1",
    display: "ended",
    spec_package: "pkg/ended",
  },
  {
    key: "k-failed",
    assignment_id: "failed-1",
    display: "launch-failed",
    spec_package: "pkg/failed",
  },
  {
    key: "k-unknown",
    assignment_id: "unknown-1",
    display: "unknown",
    spec_package: "pkg/unknown",
  },
];

test("effectiveAgentFilter: explicit ended filter wins over an active row id", () => {
  assert.equal(
    effectiveAgentFilter(
      { dest: "agents", filter: "ended", id: "k-live" },
      filterRows,
    ),
    "ended",
  );
});

test("effectiveAgentFilter: explicit active filter wins over an ended row id", () => {
  assert.equal(
    effectiveAgentFilter(
      { dest: "agents", filter: "active", id: "k-ended" },
      filterRows,
    ),
    "active",
  );
});

test("effectiveAgentFilter: an ended key infers ended", () => {
  assert.equal(
    effectiveAgentFilter({ dest: "agents", id: "k-ended" }, filterRows),
    "ended",
  );
});

test("effectiveAgentFilter: an ended assignment_id infers ended when no key matches", () => {
  assert.equal(
    effectiveAgentFilter({ dest: "agents", id: "ended-1" }, filterRows),
    "ended",
  );
});

test("effectiveAgentFilter: a launch-failed key infers ended", () => {
  assert.equal(
    effectiveAgentFilter({ dest: "agents", id: "k-failed" }, filterRows),
    "ended",
  );
});

test("effectiveAgentFilter: an ended-only query with no active match infers ended", () => {
  assert.equal(
    effectiveAgentFilter({ dest: "agents", q: "  pkg/failed  " }, filterRows),
    "ended",
  );
});

test("effectiveAgentFilter: a query matching active rows stays active", () => {
  assert.equal(
    effectiveAgentFilter({ dest: "agents", q: "pkg/live" }, filterRows),
    "active",
  );
});

test("effectiveAgentFilter: an empty query defaults active despite ended rows", () => {
  assert.equal(effectiveAgentFilter({ dest: "agents" }, filterRows), "active");
  assert.equal(
    effectiveAgentFilter({ dest: "agents", q: "   " }, filterRows),
    "active",
  );
});

test("effectiveAgentFilter: an uncertain matched key never infers ended", () => {
  assert.equal(
    effectiveAgentFilter({ dest: "agents", id: "k-unknown" }, filterRows),
    "active",
  );
  assert.equal(
    effectiveAgentFilter({ dest: "agents", id: "unknown-1" }, filterRows),
    "active",
  );
});

test("effectiveAgentFilter: an unmatched id falls through to query inference", () => {
  assert.equal(
    effectiveAgentFilter(
      { dest: "agents", id: "k-missing", q: "pkg/failed" },
      filterRows,
    ),
    "ended",
  );
  assert.equal(
    effectiveAgentFilter(
      { dest: "agents", id: "k-missing", q: "nope" },
      filterRows,
    ),
    "active",
  );
});

test("visibleAgents: group filter applies before search", () => {
  const rows = [
    {
      key: "k-live",
      assignment_id: "live-1",
      display: "live",
      spec_package: "pkg/shared",
    },
    {
      key: "k-ended",
      assignment_id: "ended-1",
      display: "ended",
      spec_package: "pkg/shared",
    },
  ];
  assert.deepEqual(
    visibleAgents(rows, "active", "pkg/shared").map((a) => a.key),
    ["k-live"],
  );
  assert.deepEqual(
    visibleAgents(rows, "ended", "pkg/shared").map((a) => a.key),
    ["k-ended"],
  );
});

test("visibleAgents: execution_dir participates in search", () => {
  const rows = [
    {
      key: "k-live",
      assignment_id: "live-1",
      display: "live",
      spec_package: "pkg/one",
      execution_dir: "/repo/worktrees/Alpha",
    },
  ];
  assert.deepEqual(
    visibleAgents(rows, "active", "WORKTREES/alp").map((a) => a.key),
    ["k-live"],
  );
  assert.deepEqual(visibleAgents(rows, "active", "workspace-other"), []);
});

test("visibleAgents: uncertain rows sort first, then spec_package, then assignment_id", () => {
  const rows = [
    {
      key: "k-z",
      assignment_id: "z-9",
      display: "terminal-lost",
      spec_package: "pkg/aaa",
    },
    {
      key: "k-a",
      assignment_id: "a-2",
      display: "live",
      spec_package: "pkg/one",
    },
    {
      key: "k-b",
      assignment_id: "a-1",
      display: "live",
      spec_package: "pkg/one",
    },
  ];
  assert.deepEqual(
    visibleAgents(rows, "active", "").map((a) => a.key),
    ["k-z", "k-b", "k-a"],
  );
});

test("visibleAgents: never mutates or reorders its input", () => {
  const rows = [
    {
      key: "k-1",
      assignment_id: "z-1",
      display: "live",
      spec_package: "pkg/z",
    },
    {
      key: "k-2",
      assignment_id: "a-1",
      display: "live",
      spec_package: "pkg/a",
    },
  ];
  const before = rows.map((row) => ({ ...row }));
  visibleAgents(rows, "active", "");
  assert.deepEqual(rows, before);
  assert.deepEqual(
    rows.map((row) => row.key),
    ["k-1", "k-2"],
  );
});

test("agentCounts: counts both groups before any query", () => {
  assert.deepEqual(
    agentCounts([
      { key: "k-1", assignment_id: "a-1", display: "live" },
      { key: "k-2", assignment_id: "a-2", display: "unknown" },
      { key: "k-3", assignment_id: "a-3", display: "ended" },
      { key: "k-4", assignment_id: "a-4", display: "launch-failed" },
    ]),
    { active: 2, ended: 2 },
  );
  assert.deepEqual(agentCounts([]), { active: 0, ended: 0 });
});

test("agentViewState: first read failure without payload is error", () => {
  assert.equal(
    agentViewState({
      payloadPresent: false,
      live: true,
      connectionFailed: true,
      sourceUnavailable: true,
      observationStale: false,
      total: 0,
      visible: 0,
      query: "",
    }),
    "error",
  );
});

test("agentViewState: no payload pending is loading before source errors", () => {
  assert.equal(
    agentViewState({
      payloadPresent: false,
      live: true,
      connectionFailed: false,
      sourceUnavailable: true,
      observationStale: false,
      total: 0,
      visible: 0,
      query: "",
    }),
    "loading",
  );
});

test("agentViewState: unavailable source with payload is error before empty", () => {
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: true,
      connectionFailed: false,
      sourceUnavailable: true,
      observationStale: false,
      total: 0,
      visible: 0,
      query: "",
    }),
    "error",
  );
});

test("agentViewState: payload with failed connection is offline before empty", () => {
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: true,
      connectionFailed: true,
      sourceUnavailable: false,
      observationStale: false,
      total: 0,
      visible: 0,
      query: "",
    }),
    "offline",
  );
});

test("agentViewState: connected old observation is stale", () => {
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: true,
      connectionFailed: false,
      sourceUnavailable: false,
      observationStale: true,
      total: 2,
      visible: 2,
      query: "",
    }),
    "stale",
  );
});

test("agentViewState: a non-live stale flag cannot mark an imported snapshot stale", () => {
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: false,
      connectionFailed: false,
      sourceUnavailable: false,
      observationStale: true,
      total: 0,
      visible: 0,
      query: "",
    }),
    "empty",
  );
});

test("agentViewState: zero total is empty", () => {
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: true,
      connectionFailed: false,
      sourceUnavailable: false,
      observationStale: false,
      total: 0,
      visible: 0,
      query: "",
    }),
    "empty",
  );
});

test("agentViewState: positive total with zero visible is no-matches", () => {
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: true,
      connectionFailed: false,
      sourceUnavailable: false,
      observationStale: false,
      total: 2,
      visible: 0,
      query: "zzz",
    }),
    "no-matches",
  );
});

test("agentViewState: visible rows are ready", () => {
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: true,
      connectionFailed: false,
      sourceUnavailable: false,
      observationStale: false,
      total: 2,
      visible: 1,
      query: "",
    }),
    "ready",
  );
});

test("nonexistent selected group with catalog rows reports no-matches rather than empty", () => {
  const assignments = [
    {
      key: "k-1",
      assignment_id: "a-1",
      display: "live",
      spec_package: "pkg/one",
    },
    {
      key: "k-2",
      assignment_id: "a-2",
      display: "live",
      spec_package: "pkg/two",
    },
  ];
  const counts = agentCounts(assignments);
  const visible = visibleAgents(assignments, "ended", "");
  assert.deepEqual(visible, []);
  assert.equal(
    agentViewState({
      payloadPresent: true,
      live: true,
      connectionFailed: false,
      sourceUnavailable: false,
      observationStale: false,
      total: counts.active + counts.ended,
      visible: visible.length,
      query: "",
    }),
    "no-matches",
  );
});

test("agentCoverage: the selected old owner stays stale despite a fresh unrelated observer", () => {
  setClock(T);
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: T_OLD },
          coverage: { state: "complete", observed_at: T_OLD },
        },
      },
      {
        observer_id: "obs-b",
        state: "observing",
        published_at: T_FRESH,
        snapshot: {
          workspace: "beta",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: T_FRESH },
          coverage: { state: "complete", observed_at: T_FRESH },
        },
      },
    ],
  };
  const selected = {
    key: "k-alpha",
    workspace: "alpha",
    assignment_id: "a-1",
    display: "live",
    assignment_coverage: { state: "complete", observed_at: T_OLD },
  };
  const coverage = agentCoverage(payload, [{ workspace: "alpha" }], selected);
  assert.equal(coverage.selectedObservedAt, T_OLD);
  assert.equal(stale(coverage.selectedObservedAt), true);
  assert.equal(stale(T_FRESH), false);
  assert.equal(coverage.sourceUnavailable, false);
});

test("agentCoverage: an unavailable selected owner stays unavailable with a healthy list source", () => {
  setClock(T);
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "unavailable", observed_at: T_OLD },
          coverage: { state: "unavailable", observed_at: T_OLD },
        },
      },
      {
        observer_id: "obs-b",
        state: "observing",
        published_at: T_FRESH,
        snapshot: {
          workspace: "beta",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: T_FRESH },
          coverage: { state: "complete", observed_at: T_FRESH },
        },
      },
    ],
  };
  const selected = {
    key: "k-alpha",
    workspace: "alpha",
    assignment_id: "a-1",
    display: "live",
    assignment_coverage: { state: "unavailable", observed_at: T_OLD },
  };
  const coverage = agentCoverage(
    payload,
    [{ workspace: "alpha" }, { workspace: "beta" }],
    selected,
  );
  assert.equal(coverage.sourceUnavailable, true);
  assert.equal(coverage.selectedObservedAt, T_OLD);
  assert.equal(coverage.listPartial, true);
});

test("agentCoverage: every mapped source unavailable is sourceUnavailable", () => {
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "unavailable", observed_at: T_OLD },
          coverage: { state: "unavailable", observed_at: T_OLD },
        },
      },
      {
        observer_id: "obs-b",
        state: "observing",
        published_at: T_FRESH,
        snapshot: {
          workspace: "beta",
          runs: [],
          coverage: { state: "unavailable", observed_at: T_FRESH },
        },
      },
    ],
  };
  const coverage = agentCoverage(
    payload,
    [{ workspace: "alpha" }, { workspace: "beta" }],
    null,
  );
  assert.equal(coverage.sourceUnavailable, true);
  assert.equal(coverage.listPartial, false);
});

test("agentCoverage: mixed mapped coverage is listPartial", () => {
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: T_FRESH },
          coverage: { state: "complete", observed_at: T_FRESH },
        },
      },
      {
        observer_id: "obs-b",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "beta",
          runs: [],
          assignment_coverage: { state: "unavailable", observed_at: T_OLD },
          coverage: { state: "unavailable", observed_at: T_OLD },
        },
      },
    ],
  };
  const coverage = agentCoverage(
    payload,
    [{ workspace: "alpha" }, { workspace: "beta" }],
    null,
  );
  assert.equal(coverage.sourceUnavailable, false);
  assert.equal(coverage.listPartial, true);
  assert.equal(coverage.listObservedAt, T_FRESH);
});

test("agentCoverage: explicit partial coverage is listPartial", () => {
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: T_OLD },
          coverage: { state: "complete", observed_at: T_OLD },
        },
      },
      {
        observer_id: "obs-b",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "beta",
          runs: [],
          assignment_coverage: { state: "partial", observed_at: T_FRESH },
          coverage: { state: "partial", observed_at: T_FRESH },
        },
      },
    ],
  };
  const coverage = agentCoverage(payload, [{ workspace: "beta" }], null);
  assert.equal(coverage.listPartial, true);
  assert.equal(coverage.sourceUnavailable, false);
});

test("agentCoverage: no mapped sources means null timestamps and false flags", () => {
  const noPayload = agentCoverage(null, [], null);
  assert.deepEqual(noPayload, {
    sourceUnavailable: false,
    listPartial: false,
    selectedObservedAt: null,
    listObservedAt: null,
  });
  const noObservers = agentCoverage(
    { observers: [] },
    [{ workspace: "alpha" }],
    null,
  );
  assert.deepEqual(noObservers, {
    sourceUnavailable: false,
    listPartial: false,
    selectedObservedAt: null,
    listObservedAt: null,
  });
});

test("agentCoverage: a legacy observer falls back to workspace coverage but stays unavailable", () => {
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          coverage: { state: "complete", observed_at: T_LEGACY },
        },
      },
    ],
  };
  const selected = {
    key: "k-alpha",
    workspace: "alpha",
    assignment_id: "a-1",
    display: "live",
  };
  const coverage = agentCoverage(payload, [selected], selected);
  assert.equal(coverage.selectedObservedAt, T_LEGACY);
  assert.equal(coverage.sourceUnavailable, true);
  assert.equal(coverage.listObservedAt, T_LEGACY);
});

test("agentCoverage: invalid observed_at values stay null, not fresh", () => {
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: "not-a-date" },
          coverage: { state: "complete", observed_at: "not-a-date" },
        },
      },
    ],
  };
  const selected = {
    key: "k-alpha",
    workspace: "alpha",
    assignment_id: "a-1",
    display: "live",
  };
  const coverage = agentCoverage(payload, [selected], selected);
  assert.equal(coverage.selectedObservedAt, null);
  assert.equal(coverage.listObservedAt, null);
});

test("agentCoverage: present assignment coverage with an unusable timestamp never falls back to fresh workspace coverage", () => {
  setClock(T);
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_FRESH,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: "not-a-date" },
          coverage: { state: "complete", observed_at: T_FRESH },
        },
      },
      {
        observer_id: "obs-b",
        state: "observing",
        published_at: T_FRESH,
        snapshot: {
          workspace: "beta",
          runs: [],
          assignment_coverage: { state: "complete" },
          coverage: { state: "complete", observed_at: T_FRESH },
        },
      },
    ],
  };
  const selected = {
    key: "k-alpha",
    workspace: "alpha",
    assignment_id: "a-1",
    display: "live",
  };
  const coverage = agentCoverage(
    payload,
    [{ workspace: "alpha" }, { workspace: "beta" }],
    selected,
  );
  assert.equal(coverage.selectedObservedAt, null);
  assert.equal(coverage.listObservedAt, null);
  assert.equal(stale(coverage.selectedObservedAt), true);
});

test("agentCoverage: partial coverage is independent of a ready view state", () => {
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: T_OLD },
          coverage: { state: "complete", observed_at: T_OLD },
        },
      },
      {
        observer_id: "obs-b",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "beta",
          runs: [],
          assignment_coverage: { state: "partial", observed_at: T_FRESH },
          coverage: { state: "partial", observed_at: T_FRESH },
        },
      },
    ],
  };
  const coverage = agentCoverage(
    payload,
    [{ workspace: "alpha" }, { workspace: "beta" }],
    null,
  );
  const state = agentViewState({
    payloadPresent: true,
    live: true,
    connectionFailed: false,
    sourceUnavailable: coverage.sourceUnavailable,
    observationStale: false,
    total: 3,
    visible: 3,
    query: "",
  });
  assert.equal(coverage.listPartial, true);
  assert.equal(state, "ready");
});

test("agentCoverage: an absent clock reads every observation conservatively stale", () => {
  setClock(undefined);
  const payload = {
    observers: [
      {
        observer_id: "obs-a",
        state: "observing",
        published_at: T_OLD,
        snapshot: {
          workspace: "alpha",
          runs: [],
          assignment_coverage: { state: "complete", observed_at: T_OLD },
          coverage: { state: "complete", observed_at: T_OLD },
        },
      },
    ],
  };
  const selected = {
    key: "k-alpha",
    workspace: "alpha",
    assignment_id: "a-1",
    display: "live",
  };
  const coverage = agentCoverage(payload, [selected], selected);
  assert.equal(coverage.selectedObservedAt, T_OLD);
  assert.equal(stale(coverage.selectedObservedAt), true);
  assert.equal(stale(T_FRESH), true);
});

test("retainSelectedAgent: keeps the current row on unchanged context", () => {
  const current = { key: "k-current", workspace: "alpha" };
  const previous = { key: "k-previous", workspace: "alpha" };
  assert.equal(retainSelectedAgent(current, previous, true, false), current);
  assert.equal(retainSelectedAgent(current, previous, true, true), current);
});

test("retainSelectedAgent: retains a missing previous row only under incomplete reads", () => {
  const previous = { key: "k-previous", workspace: "alpha" };
  assert.equal(retainSelectedAgent(null, previous, true, false), previous);
});

test("retainSelectedAgent: complete absence clears retained facts", () => {
  const previous = { key: "k-previous", workspace: "alpha" };
  assert.equal(retainSelectedAgent(null, previous, true, true), null);
});

test("retainSelectedAgent: a context change keeps the new current row but drops previous-only facts", () => {
  const current = { key: "k-current", workspace: "beta" };
  const previous = { key: "k-previous", workspace: "alpha" };
  assert.equal(retainSelectedAgent(current, previous, false, false), current);
  assert.equal(retainSelectedAgent(current, previous, false, true), current);
  assert.equal(retainSelectedAgent(null, previous, false, false), null);
});

test("retainSelectedAgent: null rows stay null", () => {
  assert.equal(retainSelectedAgent(null, null, true, false), null);
  assert.equal(retainSelectedAgent(null, null, true, true), null);
});

test("agentGuidance: warns for each identity-uncertain display", () => {
  for (const display of [
    "unknown",
    "terminal-lost",
    "launch-unconfirmed",
    "live-unrecorded",
    "exited-unrecorded",
  ]) {
    const guidance = agentGuidance({ display, nextAction: "Wait" }, true);
    assert.equal(
      guidance.caution,
      "Do not start another writer while this assignment’s liveness is uncertain.",
      display,
    );
    assert.equal(guidance.primary, "copy-locate", display);
  }
});

test("agentGuidance: warns for unconfirmed workers even when the display is ended", () => {
  const guidance = agentGuidance(
    { display: "ended", workersUnconfirmed: true, nextAction: "History" },
    true,
  );
  assert.equal(
    guidance.caution,
    "Do not start another writer while this assignment’s liveness is uncertain.",
  );
  assert.equal(guidance.primary, "copy-locate");
  assert.equal(
    identityUncertain({ display: "ended", workersUnconfirmed: true }),
    true,
  );
});

test("agentGuidance: certain displays carry no caution", () => {
  for (const display of ["live", "launching", "ended", "launch-failed"]) {
    const guidance = agentGuidance({ display, nextAction: "Do it" }, true);
    assert.equal(guidance.caution, undefined, display);
    assert.equal("caution" in guidance, false, display);
  }
});

test("agentGuidance: quiet and attached counts alone add no caution or grouping change", () => {
  const quiet = {
    key: "k-quiet",
    assignment_id: "q-1",
    display: "live",
    quiet: true,
    attachedCount: 4,
    nextAction: "Attach command",
  };
  assert.equal(identityUncertain(quiet), false);
  assert.equal(agentGuidance(quiet, true).caution, undefined);
  const rows = [
    quiet,
    { key: "k-ended", assignment_id: "e-1", display: "ended" },
  ];
  assert.deepEqual(
    visibleAgents(rows, "active", "").map((a) => a.key),
    ["k-quiet"],
  );
  assert.equal(
    effectiveAgentFilter({ dest: "agents", id: "k-quiet" }, rows),
    "active",
  );
});

test("agentGuidance: the locate headline translates only the exact locate command", () => {
  const locate =
    "node ~/.agents/scripts/workspaces/cli.mjs locate 11111111-1111-4111-8111-111111111111";
  assert.equal(
    agentGuidance(
      {
        display: "launch-unconfirmed",
        nextAction: locate,
        locate_command: locate,
      },
      true,
    ).headline,
    "Locate this assignment and confirm its recorded process identity.",
  );
  assert.equal(
    agentGuidance(
      { display: "live", nextAction: "Attach command", locate_command: locate },
      true,
    ).headline,
    "Attach command",
  );
  assert.equal(
    agentGuidance({ display: "live", nextAction: "", locate_command: "" }, true)
      .headline,
    "",
  );
});

test("agentGuidance: primary follows uncertainty or a missing related spec", () => {
  assert.equal(
    agentGuidance({ display: "live", nextAction: "Attach command" }, true)
      .primary,
    "open-spec",
  );
  assert.equal(
    agentGuidance({ display: "live", nextAction: "Attach command" }, false)
      .primary,
    "copy-locate",
  );
  assert.equal(
    agentGuidance(
      { display: "unknown", nextAction: "Fix probe; no relaunch" },
      true,
    ).primary,
    "copy-locate",
  );
});
