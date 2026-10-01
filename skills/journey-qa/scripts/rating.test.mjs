import { test } from "node:test";
import assert from "node:assert/strict";

import { agreement, bandOf, rate, stepMinimum } from "./rating.mjs";

const proxies = (overrides = {}) => ({
  actions: 10,
  backtracks: 0,
  errorsSeen: { total: 0 },
  endedInError: false,
  actionsToEntryRoute: 1,
  ...overrides,
});

// Efficiency: referenceActions / actions, both sides of each edge.

test("efficiency at the direct edge is direct", () => {
  assert.equal(bandOf("efficiency", 0.8), "direct");
});

test("efficiency just under the direct edge is detours", () => {
  assert.equal(bandOf("efficiency", 0.79), "detours");
});

test("efficiency at the detours edge is detours", () => {
  assert.equal(bandOf("efficiency", 0.5), "detours");
});

test("efficiency just under the detours edge is lost", () => {
  assert.equal(bandOf("efficiency", 0.49), "lost");
});

test("efficiency takes actions and reference actions", () => {
  assert.equal(bandOf("efficiency", { actions: 10, referenceActions: 8 }), "direct");
});

test("efficiency with zero actions is lost", () => {
  assert.equal(bandOf("efficiency", { actions: 0, referenceActions: 0 }), "lost");
});

// Backtracks: 0-1 direct, 2-3 detours, 4+ lost.

test("one backtrack is direct", () => {
  assert.equal(bandOf("backtracks", 1), "direct");
});

test("two backtracks is detours", () => {
  assert.equal(bandOf("backtracks", 2), "detours");
});

test("three backtracks is detours", () => {
  assert.equal(bandOf("backtracks", 3), "detours");
});

test("four backtracks is lost", () => {
  assert.equal(bandOf("backtracks", 4), "lost");
});

// Errors: 0 direct, 1-2 detours, 3+ or endedInError lost.

test("zero errors is direct", () => {
  assert.equal(bandOf("errors", { total: 0, endedInError: false }), "direct");
});

test("one error is detours", () => {
  assert.equal(bandOf("errors", { total: 1, endedInError: false }), "detours");
});

test("two errors is detours", () => {
  assert.equal(bandOf("errors", { total: 2, endedInError: false }), "detours");
});

test("three errors is lost", () => {
  assert.equal(bandOf("errors", { total: 3, endedInError: false }), "lost");
});

test("ending in an error is lost whatever the count", () => {
  assert.equal(bandOf("errors", { total: 0, endedInError: true }), "lost");
});

// Entry actions: 0-2 direct, 3-5 detours, 6+ or never reached lost.

test("two entry actions is direct", () => {
  assert.equal(bandOf("entryActions", 2), "direct");
});

test("three entry actions is detours", () => {
  assert.equal(bandOf("entryActions", 3), "detours");
});

test("five entry actions is detours", () => {
  assert.equal(bandOf("entryActions", 5), "detours");
});

test("six entry actions is lost", () => {
  assert.equal(bandOf("entryActions", 6), "lost");
});

test("entry actions of null is lost", () => {
  assert.equal(bandOf("entryActions", null), "lost");
});

test("an unknown metric is rejected", () => {
  assert.throws(() => bandOf("elapsedSeconds", 12), /unknown metric/);
});

// Step minimum over q1-q4.

test("step minimum ignores unscored questions", () => {
  assert.equal(stepMinimum([{ n: 1, q1: 2, q2: null, q3: 2, q4: 1 }, { n: 2, q1: 1, q2: 2, q3: 1, q4: 0 }]), 0);
});

test("step minimum is null when nothing is scored", () => {
  assert.equal(stepMinimum([{ n: 1, q1: null, q2: null, q3: null, q4: null }]), null);
});

// Ratings.

test("a harness error is not rated", () => {
  const result = rate({ status: "harness-error", checkPass: null, proxies: proxies(), referenceActions: 8, stepMinimum: 2 });
  assert.equal(result.rating, "Not rated");
  assert.equal(result.attribution, null);
});

test("a null check on a completed status is not rated", () => {
  const result = rate({ status: "completed", checkPass: null, proxies: proxies(), referenceActions: 8, stepMinimum: 2 });
  assert.equal(result.rating, "Not rated");
});

test("a false check is not completed and keeps its attribution", () => {
  const result = rate({
    status: "not-completed",
    checkPass: false,
    proxies: proxies(),
    referenceActions: 8,
    stepMinimum: 2,
    attribution: "product",
  });
  assert.equal(result.rating, "Not completed");
  assert.equal(result.attribution, "product");
});

test("a false check without attribution is rejected", () => {
  assert.throws(
    () => rate({ status: "not-completed", checkPass: false, proxies: proxies(), referenceActions: 8, stepMinimum: 2, attribution: "operator" }),
    /attribution/,
  );
});

test("every band direct with a minimum question of 1 is direct", () => {
  const result = rate({
    status: "completed",
    checkPass: true,
    proxies: proxies(),
    referenceActions: 8,
    stepMinimum: 1,
  });
  assert.deepEqual(result.bands, { efficiency: "direct", backtracks: "direct", errors: "direct", entryActions: "direct" });
  assert.equal(result.rating, "Direct");
});

test("every band direct with a minimum question of 0 is detours", () => {
  const result = rate({ status: "completed", checkPass: true, proxies: proxies(), referenceActions: 8, stepMinimum: 0 });
  assert.equal(result.rating, "Detours");
});

test("a single detours band is detours", () => {
  const result = rate({
    status: "completed",
    checkPass: true,
    proxies: proxies({ backtracks: 2 }),
    referenceActions: 8,
    stepMinimum: 1,
  });
  assert.equal(result.bands.backtracks, "detours");
  assert.equal(result.rating, "Detours");
});

test("a lost band outranks a detours band", () => {
  const result = rate({
    status: "completed",
    checkPass: true,
    proxies: proxies({ backtracks: 2, actionsToEntryRoute: 6 }),
    referenceActions: 8,
    stepMinimum: 1,
  });
  assert.deepEqual(result.bands, { efficiency: "direct", backtracks: "detours", errors: "direct", entryActions: "lost" });
  assert.equal(result.rating, "Lost");
});

// Repeatability between two reviewers.

const review = (steps) => ({ steps });

test("agreement counts exact and within-one matches over shared steps", () => {
  const a = review([
    { n: 1, q1: 2, q2: 2, q3: 2, q4: 1 },
    { n: 2, q1: 1, q2: 0, q3: 2, q4: 1 },
  ]);
  const b = review([
    { n: 1, q1: 2, q2: 2, q3: 2, q4: 1 },
    { n: 2, q1: 2, q2: 1, q3: 2, q4: 1 },
  ]);
  assert.deepEqual(agreement(a, b), { n: 8, exact: 6, withinOne: 8 });
});

test("agreement skips unscored questions", () => {
  const a = review([{ n: 1, q1: 2, q2: 1, q3: null, q4: 2 }]);
  const b = review([{ n: 1, q1: 2, q2: 2, q3: 1, q4: 0 }]);
  assert.deepEqual(agreement(a, b), { n: 3, exact: 1, withinOne: 2 });
});

test("agreement skips steps only one reviewer scored", () => {
  const a = review([
    { n: 1, q1: 2, q2: 2, q3: 2, q4: 2 },
    { n: 2, q1: 1, q2: 1, q3: 1, q4: 1 },
  ]);
  const b = review([{ n: 1, q1: 2, q2: 2, q3: 2, q4: 2 }]);
  assert.deepEqual(agreement(a, b), { n: 4, exact: 4, withinOne: 4 });
});