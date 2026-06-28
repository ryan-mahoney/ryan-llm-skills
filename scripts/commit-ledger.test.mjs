import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LENSES,
  matches,
  targetsForFiles,
  isValidLens,
  parseLedger,
  serializeLedger,
  coveredShas,
  uncoveredCommits,
  buildRecord,
  frontierFor,
  advanceFrontier,
  reconcilePlan,
  commitType,
  isRevert,
  churnByUnit,
} from "./commit-ledger.mjs";

function manifest() {
  return {
    targets: [
      { slug: "api", source_globs: ["lib/api/**"] },
      { slug: "worker", source_globs: ["lib/worker/**"] },
      { slug: "root", source_globs: ["*"] },
      { slug: "scripts", source_globs: ["scripts/*"] },
    ],
  };
}

function commit(overrides) {
  return {
    commit: "a".repeat(40),
    abbrev: "aaaaaaaaaaaa",
    tree: "t".repeat(40),
    author: "Ada Lovelace",
    email: "ada@example.com",
    date: "2026-01-01T00:00:00Z",
    subject: "feat(api): add endpoint",
    files: ["lib/api/handler.js"],
    targets: ["api"],
    ...overrides,
  };
}

// --- glob matching -----------------------------------------------------------

test("matches resolves the four supported glob shapes", () => {
  assert.equal(matches("anything/here.js", "**"), true);
  assert.equal(matches("root.js", "*"), true);
  assert.equal(matches("dir/root.js", "*"), false);
  assert.equal(matches("lib/api/handler.js", "lib/api/**"), true);
  assert.equal(matches("lib/api", "lib/api/**"), true);
  assert.equal(matches("lib/worker/job.js", "lib/api/**"), false);
  assert.equal(matches("scripts/build.sh", "scripts/*"), true);
  assert.equal(matches("scripts/nested/build.sh", "scripts/*"), false);
});

test("matches throws on an unsupported glob shape", () => {
  assert.throws(() => matches("a/b.js", "a/*.js"), /unsupported glob shape/);
});

// --- file to target mapping --------------------------------------------------

test("targetsForFiles maps owned files and collects unowned ones", () => {
  const result = targetsForFiles(manifest(), [
    "lib/api/handler.js",
    "lib/worker/job.js",
    "vendor/third-party.js",
  ]);
  assert.deepEqual(result.targets, ["api", "worker"]);
  assert.deepEqual(result.unowned_files, ["vendor/third-party.js"]);
});

test("targetsForFiles attributes a file to every matching target", () => {
  const overlap = {
    targets: [
      { slug: "all", source_globs: ["**"] },
      { slug: "api", source_globs: ["lib/api/**"] },
    ],
  };
  const result = targetsForFiles(overlap, ["lib/api/handler.js"]);
  assert.deepEqual(result.targets, ["all", "api"]);
});

// --- lens validation ---------------------------------------------------------

test("isValidLens accepts known lenses and rejects others", () => {
  for (const lens of LENSES) assert.equal(isValidLens(lens), true);
  assert.equal(isValidLens("history"), false);
});

// --- ledger parse / serialize ------------------------------------------------

test("parseLedger ignores blank lines and parses each row", () => {
  const text = '{"commit":"x","lens":"doc"}\n\n  \n{"commit":"y","lens":"intent"}\n';
  const records = parseLedger(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].commit, "x");
  assert.equal(records[1].lens, "intent");
});

test("parseLedger returns empty array for empty input", () => {
  assert.deepEqual(parseLedger(""), []);
  assert.deepEqual(parseLedger(undefined), []);
});

test("serializeLedger round-trips through parseLedger", () => {
  const records = [
    { commit: "x", lens: "doc" },
    { commit: "y", lens: "rework" },
  ];
  assert.deepEqual(parseLedger(serializeLedger(records)), records);
});

test("serializeLedger emits nothing for no records", () => {
  assert.equal(serializeLedger([]), "");
});

// --- coverage sets -----------------------------------------------------------

test("coveredShas returns only SHAs for the requested lens", () => {
  const records = [
    { commit: "a", lens: "doc" },
    { commit: "b", lens: "doc" },
    { commit: "a", lens: "intent" },
  ];
  assert.deepEqual([...coveredShas(records, "doc")].sort(), ["a", "b"]);
  assert.deepEqual([...coveredShas(records, "intent")], ["a"]);
  assert.equal(coveredShas(records, "rework").size, 0);
});

test("uncoveredCommits drops covered commits and keeps input order", () => {
  const commits = [commit({ commit: "a" }), commit({ commit: "b" }), commit({ commit: "c" })];
  const records = [{ commit: "b", lens: "doc" }];
  const result = uncoveredCommits(commits, records, "doc");
  assert.deepEqual(result.map((commit) => commit.commit), ["a", "c"]);
});

test("uncoveredCommits treats a commit covered under another lens as uncovered", () => {
  const commits = [commit({ commit: "a" })];
  const records = [{ commit: "a", lens: "intent" }];
  assert.equal(uncoveredCommits(commits, records, "doc").length, 1);
});

// --- record construction -----------------------------------------------------

test("buildRecord stamps the injected timestamp and carries commit fields", () => {
  const record = buildRecord(commit(), "doc", "2026-06-28T12:00:00Z");
  assert.equal(record.lens, "doc");
  assert.equal(record.recorded_at, "2026-06-28T12:00:00Z");
  assert.equal(record.email, "ada@example.com");
  assert.deepEqual(record.targets, ["api"]);
  assert.deepEqual(record.collapsed_from, []);
});

test("buildRecord derives an abbrev when one is absent", () => {
  const record = buildRecord({ commit: "0123456789abcdef" }, "intent", "now");
  assert.equal(record.abbrev, "0123456789ab");
});

// --- frontier ----------------------------------------------------------------

test("advanceFrontier sets the lens entry without disturbing others", () => {
  const start = { doc: { commit: "old", tree: "t1", date: "d1" } };
  const next = advanceFrontier(start, "intent", commit({ commit: "new", tree: "t2", date: "d2" }));
  assert.deepEqual(frontierFor(next, "doc"), { commit: "old", tree: "t1", date: "d1" });
  assert.deepEqual(frontierFor(next, "intent"), { commit: "new", tree: "t2", date: "d2" });
});

test("frontierFor returns null for an unset lens", () => {
  assert.equal(frontierFor({}, "doc"), null);
  assert.equal(frontierFor(null, "doc"), null);
});

// --- reconcile planning (squash survival) ------------------------------------

test("reconcilePlan reports initial when no frontier exists", () => {
  const plan = reconcilePlan({ lens: "doc", frontier: {}, ledgerRecords: [], reachableMap: {} });
  assert.equal(plan.kind, "initial");
});

test("reconcilePlan walks when the frontier is still reachable", () => {
  const frontier = { doc: { commit: "f1" } };
  const plan = reconcilePlan({
    lens: "doc",
    frontier,
    ledgerRecords: [{ commit: "f1", lens: "doc" }],
    reachableMap: { f1: true },
  });
  assert.equal(plan.kind, "walk");
  assert.equal(plan.reanchorTo, "f1");
  assert.deepEqual(plan.orphaned, []);
});

test("reconcilePlan re-anchors to the newest reachable covered commit after a rewrite", () => {
  const frontier = { doc: { commit: "f3" } };
  const ledger = [
    { commit: "f1", lens: "doc" },
    { commit: "f2", lens: "doc" },
    { commit: "f3", lens: "doc" },
  ];
  const plan = reconcilePlan({
    lens: "doc",
    frontier,
    ledgerRecords: ledger,
    reachableMap: { f3: false, f2: true, f1: true },
  });
  assert.equal(plan.kind, "reanchor");
  assert.equal(plan.reanchorTo, "f2");
  assert.deepEqual(plan.orphaned, ["f3"]);
});

test("reconcilePlan collapses to a HEAD boundary when nothing is reachable", () => {
  const frontier = { doc: { commit: "f2" } };
  const ledger = [
    { commit: "f1", lens: "doc" },
    { commit: "f2", lens: "doc" },
  ];
  const head = commit({ commit: "squash" });
  const plan = reconcilePlan({
    lens: "doc",
    frontier,
    ledgerRecords: ledger,
    reachableMap: { f2: false, f1: false },
    headCommit: head,
  });
  assert.equal(plan.kind, "collapse");
  assert.deepEqual(plan.orphaned, ["f1", "f2"]);
  assert.equal(plan.boundary.commit, "squash");
});

// --- commit classification ---------------------------------------------------

test("commitType extracts the conventional-commit type or falls back to other", () => {
  assert.equal(commitType("feat(api): add"), "feat");
  assert.equal(commitType("fix: bug"), "fix");
  assert.equal(commitType("refactor(core)!: breaking"), "refactor");
  assert.equal(commitType("no convention here"), "other");
});

test("isRevert detects revert subjects and revert bodies", () => {
  assert.equal(isRevert({ subject: 'Revert "feat: thing"' }), true);
  assert.equal(isRevert({ subject: "revert: thing" }), true);
  assert.equal(isRevert({ subject: "feat: thing", body: "This reverts commit abc123." }), true);
  assert.equal(isRevert({ subject: "feat: revertible design" }), false);
});

// --- churn aggregation -------------------------------------------------------

test("churnByUnit aggregates touches, authors, types, and reverts by target", () => {
  const commits = [
    commit({ commit: "1", email: "ada@x.com", subject: "feat(api): a", files: ["lib/api/a.js"], date: "2026-01-01T00:00:00Z" }),
    commit({ commit: "2", email: "ada@x.com", subject: "fix(api): b", files: ["lib/api/b.js"], date: "2026-01-05T00:00:00Z" }),
    commit({ commit: "3", email: "bob@x.com", subject: 'Revert "feat(api): a"', files: ["lib/api/a.js"], date: "2026-01-10T00:00:00Z" }),
    commit({ commit: "4", email: "bob@x.com", subject: "feat(worker): w", files: ["lib/worker/w.js"], date: "2026-01-02T00:00:00Z" }),
  ];

  const units = churnByUnit(commits, manifest(), "target");
  const api = units.find((unit) => unit.unit === "api");

  assert.equal(api.touches, 3);
  assert.equal(api.author_count, 2);
  assert.deepEqual(api.authors, ["ada@x.com", "bob@x.com"]);
  assert.equal(api.first_touch, "2026-01-01T00:00:00Z");
  assert.equal(api.last_touch, "2026-01-10T00:00:00Z");
  assert.equal(api.type_counts.feat, 1);
  assert.equal(api.type_counts.fix, 1);
  assert.equal(api.reverts, 1);
  // (fix 1 + reverts 1) / 3 touches
  assert.equal(api.fix_ratio, 0.667);
});

test("churnByUnit sorts units by touch count descending", () => {
  const commits = [
    commit({ commit: "1", files: ["lib/api/a.js"] }),
    commit({ commit: "2", files: ["lib/api/b.js"] }),
    commit({ commit: "3", files: ["lib/worker/w.js"] }),
  ];
  const units = churnByUnit(commits, manifest(), "target");
  assert.deepEqual(units.map((unit) => unit.unit), ["api", "worker"]);
});

test("churnByUnit can aggregate by file instead of target", () => {
  const commits = [
    commit({ commit: "1", files: ["lib/api/a.js", "lib/api/b.js"] }),
    commit({ commit: "2", files: ["lib/api/a.js"] }),
  ];
  const units = churnByUnit(commits, manifest(), "file");
  const fileA = units.find((unit) => unit.unit === "lib/api/a.js");
  assert.equal(fileA.touches, 2);
  assert.equal(units.find((unit) => unit.unit === "lib/api/b.js").touches, 1);
});
