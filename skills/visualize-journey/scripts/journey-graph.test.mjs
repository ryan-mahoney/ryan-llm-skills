import { test } from "node:test";
import assert from "node:assert/strict";

import { buildJourneyGraph, normalizeRoute, surfaceId, validateCrossJourneyLinks } from "./journey-graph.mjs";

const repository = (id) => ({ id, label: id, host: `${id}.example`, color: "#17191d" });

const step = (overrides = {}) => ({
  id: "only-step",
  repo: "marketing",
  transition: { type: "terminal", label: "Done" },
  ...overrides,
});

const manifest = ({
  id,
  title = `Journey ${id}`,
  entry = { repo: "marketing", route: "/", label: "Marketing homepage" },
  terminal = { repo: "app", route: "/done", label: "Done" },
  repositories = [repository("marketing"), repository("app")],
  seams = [],
  steps = [step()],
  exitPoints = [],
  upstreamSeams = [],
}) => ({
  journey: { id, title, seams },
  entry,
  terminal,
  repositories,
  steps,
  exitPoints,
  upstreamSeams,
});

const edgesOfType = (graph, type) => graph.edges.filter((edge) => edge.type === type);

test("normalizeRoute keeps the site root intact", () => {
  assert.equal(normalizeRoute("/"), "/");
});

test("normalizeRoute strips surrounding space and trailing slashes", () => {
  assert.equal(normalizeRoute("  /jobkits/theme/  "), "/jobkits/theme");
});

test("derives no repositories, journeys, surfaces, or edges from an empty collection", () => {
  const graph = buildJourneyGraph([]);

  assert.deepEqual(graph, { repositories: [], journeys: [], surfaces: [], unresolved: [], edges: [] });
});

test("links a single journey to its entry and terminal surfaces", () => {
  const graph = buildJourneyGraph([manifest({ id: "JRNY-124" })]);

  assert.deepEqual(graph.surfaces.map((surface) => surface.id), ["surface:marketing|/", "surface:app|/done"]);
  assert.deepEqual(graph.edges, [
    { type: "entry", from: "surface:marketing|/", to: "JRNY-124", label: "Begins" },
    { type: "terminal", from: "JRNY-124", to: "surface:app|/done", label: "Ends" },
  ]);
});

test("records the repositories a journey's steps visit, without repeating a repeated repository", () => {
  const graph = buildJourneyGraph([manifest({
    id: "JRNY-124",
    steps: [
      step({ id: "one", repo: "marketing" }),
      step({ id: "two", repo: "app" }),
      step({ id: "three", repo: "app" }),
      step({ id: "four", repo: "marketing" }),
    ],
  })]);

  assert.deepEqual(graph.journeys[0].repoPath, ["marketing", "app", "marketing"]);
});

test("merges an entry surface shared by three journeys into one node", () => {
  const shared = { repo: "marketing", route: "/", label: "Marketing homepage" };
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", entry: shared, terminal: { repo: "app", route: "/a", label: "A" } }),
    manifest({ id: "JRNY-125", entry: shared, terminal: { repo: "app", route: "/b", label: "B" } }),
    manifest({ id: "JRNY-126", entry: shared, terminal: { repo: "app", route: "/c", label: "C" } }),
  ]);
  const entrySurface = graph.surfaces.find((surface) => surface.id === "surface:marketing|/");

  assert.deepEqual(entrySurface.entryOf, ["JRNY-124", "JRNY-125", "JRNY-126"]);
  assert.equal(edgesOfType(graph, "entry").length, 3);
});

test("treats entry routes that differ only by a trailing slash as one surface", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", entry: { repo: "marketing", route: "/jobkits/", label: "Catalogue" } }),
    manifest({ id: "JRNY-125", entry: { repo: "marketing", route: "/jobkits", label: "Catalogue" } }),
  ]);

  assert.equal(graph.surfaces.filter((surface) => surface.repo === "marketing").length, 1);
  assert.equal(surfaceId({ repo: "marketing", route: "/jobkits/" }), "surface:marketing|/jobkits");
});

test("keeps the same route in different repositories as separate surfaces", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", entry: { repo: "marketing", route: "/kits", label: "Marketing kits" } }),
    manifest({ id: "JRNY-125", entry: { repo: "app", route: "/kits", label: "App kits" } }),
  ]);

  assert.deepEqual(graph.surfaces.map((surface) => surface.id).sort(), [
    "surface:app|/done",
    "surface:app|/kits",
    "surface:marketing|/kits",
  ]);
});

test("adds a continuation edge when one journey's terminal is another journey's entry", () => {
  const handoff = { repo: "app", route: "/my-kits/:shortcode", label: "Purchased kit viewer" };
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", terminal: handoff }),
    manifest({ id: "JRNY-125", entry: handoff, terminal: { repo: "app", route: "/hire", label: "Hire" } }),
  ]);

  assert.deepEqual(edgesOfType(graph, "continuation"), [
    { type: "continuation", from: "JRNY-124", to: "JRNY-125", label: "Continues in", fromStep: "only-step", source: "derived", resolved: true },
  ]);
});

test("adds no continuation edge when the handoff repository differs from the entry repository", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", terminal: { repo: "app", route: "/my-kits/:shortcode", label: "Viewer" } }),
    manifest({ id: "JRNY-125", entry: { repo: "email", route: "/my-kits/:shortcode", label: "Delivery email" }, repositories: [repository("email"), repository("app")] }),
  ]);

  assert.deepEqual(edgesOfType(graph, "continuation"), []);
});

test("adds a continuation edge declared by terminal.continuesIn across unrelated surfaces", () => {
  const graph = buildJourneyGraph([
    manifest({
      id: "JRNY-124",
      steps: [step({ id: "conclude-owned-kit" })],
      terminal: { repo: "app", route: "/my-kits/:shortcode", label: "Viewer", continuesIn: ["JRNY-125"] },
    }),
    manifest({ id: "JRNY-125", entry: { repo: "email", route: "confirmation email", label: "Delivery email" }, repositories: [repository("email"), repository("app")] }),
  ]);

  assert.deepEqual(edgesOfType(graph, "continuation"), [
    { type: "continuation", from: "JRNY-124", to: "JRNY-125", label: "Continues in", fromStep: "conclude-owned-kit", source: "declared", resolved: true },
  ]);
});

test("keeps one continuation edge when the same pair is both declared and derived", () => {
  const handoff = { repo: "app", route: "/my-kits/:shortcode", label: "Purchased kit viewer" };
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", terminal: { ...handoff, continuesIn: ["JRNY-125"] } }),
    manifest({ id: "JRNY-125", entry: handoff, terminal: { repo: "app", route: "/hire", label: "Hire" } }),
  ]);

  assert.deepEqual(edgesOfType(graph, "continuation").map((edge) => edge.source), ["declared"]);
});

test("declares one continuation edge per named journey", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", terminal: { repo: "app", route: "/viewer", label: "Viewer", continuesIn: ["JRNY-125", "JRNY-126"] } }),
    manifest({ id: "JRNY-125" }),
    manifest({ id: "JRNY-126" }),
  ]);

  assert.deepEqual(edgesOfType(graph, "continuation").map((edge) => edge.to), ["JRNY-125", "JRNY-126"]);
});

test("marks a continuesIn target outside the collection as unmapped", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", terminal: { repo: "app", route: "/viewer", label: "Viewer", continuesIn: ["JRNY-131"] } }),
  ]);

  assert.deepEqual(graph.unresolved, [{ id: "JRNY-131", referencedBy: ["JRNY-124"] }]);
  assert.equal(edgesOfType(graph, "continuation")[0].resolved, false);
});

test("emits a branch edge carrying the departing step for a toJourney target in the collection", () => {
  const graph = buildJourneyGraph([
    manifest({
      id: "JRNY-124",
      steps: [step({
        id: "prepare-kit-detail",
        transition: { type: "terminal", label: "Done", branches: [{ label: "Buy instead", toJourney: "JRNY-125" }] },
      })],
    }),
    manifest({ id: "JRNY-125" }),
  ]);

  assert.deepEqual(edgesOfType(graph, "branch"), [
    { type: "branch", from: "JRNY-124", to: "JRNY-125", label: "Buy instead", fromStep: "prepare-kit-detail", source: "branch", resolved: true },
  ]);
});

test("emits a branch edge for an exit point that hands the user to another journey", () => {
  const graph = buildJourneyGraph([
    manifest({
      id: "JRNY-124",
      exitPoints: [{ atStep: "only-step", label: "Buy this kit", toJourney: "JRNY-125" }],
    }),
    manifest({ id: "JRNY-125" }),
  ]);

  assert.deepEqual(edgesOfType(graph, "branch"), [
    { type: "branch", from: "JRNY-124", to: "JRNY-125", label: "Buy this kit", fromStep: "only-step", source: "exit", resolved: true },
  ]);
});

test("collapses a branch and an exit point that leave the same step for the same journey", () => {
  const graph = buildJourneyGraph([
    manifest({
      id: "JRNY-124",
      steps: [step({
        id: "prepare-kit-detail",
        transition: { type: "terminal", label: "Done", branches: [{ label: "Buy instead", toJourney: "JRNY-125" }] },
      })],
      exitPoints: [{ atStep: "prepare-kit-detail", label: "Buy this kit", toJourney: "JRNY-125" }],
    }),
    manifest({ id: "JRNY-125" }),
  ]);

  assert.deepEqual(edgesOfType(graph, "branch").map((edge) => edge.label), ["Buy instead"]);
});

test("marks a toJourney target outside the collection as unmapped instead of failing", () => {
  const graph = buildJourneyGraph([
    manifest({
      id: "JRNY-124",
      exitPoints: [{ atStep: "only-step", label: "Request a custom kit", toJourney: "JRNY-131" }],
    }),
  ]);

  assert.deepEqual(graph.unresolved, [{ id: "JRNY-131", referencedBy: ["JRNY-124"] }]);
  assert.equal(edgesOfType(graph, "branch")[0].resolved, false);
});

test("names an unmapped target once even when two steps point at it", () => {
  const graph = buildJourneyGraph([
    manifest({
      id: "JRNY-124",
      steps: [
        step({ id: "one", transition: { type: "route", label: "Next", branches: [{ label: "Leave", toJourney: "JRNY-131" }] } }),
        step({ id: "two", transition: { type: "terminal", label: "Done", branches: [{ label: "Leave later", toJourney: "JRNY-131" }] } }),
      ],
    }),
  ]);

  assert.deepEqual(graph.unresolved, [{ id: "JRNY-131", referencedBy: ["JRNY-124"] }]);
  assert.equal(edgesOfType(graph, "branch").length, 2);
});

test("records a seam shared by two journeys as one edge between them", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", seams: ["SEAM-001"] }),
    manifest({ id: "JRNY-127", seams: ["SEAM-001"] }),
  ]);

  assert.deepEqual(edgesOfType(graph, "seam"), [
    { type: "seam", from: "JRNY-124", to: "JRNY-127", label: "SEAM-001", seam: "SEAM-001" },
  ]);
});

test("records a seam shared by three journeys as one edge per pair", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", seams: ["SEAM-001"] }),
    manifest({ id: "JRNY-125", seams: ["SEAM-001"] }),
    manifest({ id: "JRNY-126", seams: ["SEAM-001"] }),
  ]);

  assert.deepEqual(edgesOfType(graph, "seam").map((edge) => `${edge.from}-${edge.to}`), [
    "JRNY-124-JRNY-125",
    "JRNY-124-JRNY-126",
    "JRNY-125-JRNY-126",
  ]);
});

test("omits a seam that only one journey declares", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", seams: ["SEAM-001", "SEAM-002"] }),
    manifest({ id: "JRNY-127", seams: ["SEAM-001"] }),
  ]);

  assert.deepEqual(edgesOfType(graph, "seam").map((edge) => edge.seam), ["SEAM-001"]);
});

test("counts a seam projected only on a step transition as shared", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-124", steps: [step({ transition: { type: "terminal", label: "Done", seam: "SEAM-009" } })] }),
    manifest({ id: "JRNY-125", upstreamSeams: [{ id: "SEAM-009" }] }),
  ]);

  assert.deepEqual(edgesOfType(graph, "seam").map((edge) => edge.seam), ["SEAM-009"]);
});

test("orders journeys and the repository union by numeric journey id regardless of input order", () => {
  const graph = buildJourneyGraph([
    manifest({ id: "JRNY-127", repositories: [repository("stripe"), repository("app")] }),
    manifest({ id: "JRNY-124", repositories: [repository("marketing"), repository("app")] }),
  ]);

  assert.deepEqual(graph.journeys.map((journey) => journey.id), ["JRNY-124", "JRNY-127"]);
  assert.deepEqual(graph.repositories.map((repo) => repo.id), ["marketing", "app", "stripe"]);
});

test("validateCrossJourneyLinks accepts a manifest with no cross-journey pointers", () => {
  const errors = validateCrossJourneyLinks(manifest({ id: "JRNY-124" }));

  assert.deepEqual(errors, []);
});

test("validateCrossJourneyLinks rejects a branch toJourney naming its own journey", () => {
  const errors = validateCrossJourneyLinks(manifest({
    id: "JRNY-124",
    steps: [step({ transition: { type: "terminal", label: "Done", branches: [{ label: "Loop", toJourney: "JRNY-124" }] } })],
  }));

  assert.deepEqual(errors, ["steps[0].transition.branches[0].toJourney cannot name its own journey"]);
});

test("validateCrossJourneyLinks rejects an exit point toJourney that is not a journey id", () => {
  const errors = validateCrossJourneyLinks(manifest({
    id: "JRNY-124",
    exitPoints: [{ atStep: "only-step", label: "Leave", toJourney: "the purchase journey" }],
  }));

  assert.deepEqual(errors, ["exitPoints[0].toJourney must match JRNY-###"]);
});

test("validateCrossJourneyLinks rejects a terminal.continuesIn entry naming its own journey", () => {
  const errors = validateCrossJourneyLinks(manifest({
    id: "JRNY-124",
    terminal: { repo: "app", route: "/viewer", label: "Viewer", continuesIn: ["JRNY-124"] },
  }));

  assert.deepEqual(errors, ["terminal.continuesIn[0] cannot name its own journey"]);
});

test("validateCrossJourneyLinks rejects a repeated terminal.continuesIn entry", () => {
  const errors = validateCrossJourneyLinks(manifest({
    id: "JRNY-124",
    terminal: { repo: "app", route: "/viewer", label: "Viewer", continuesIn: ["JRNY-125", "JRNY-125"] },
  }));

  assert.deepEqual(errors, ["terminal.continuesIn[1] repeats JRNY-125"]);
});

test("validateCrossJourneyLinks rejects a terminal.continuesIn that is not an array", () => {
  const errors = validateCrossJourneyLinks(manifest({
    id: "JRNY-124",
    terminal: { repo: "app", route: "/viewer", label: "Viewer", continuesIn: "JRNY-125" },
  }));

  assert.deepEqual(errors, ["terminal.continuesIn must be an array of journey IDs"]);
});

test("validateCrossJourneyLinks accepts a four-digit journey id on an exit point", () => {
  const errors = validateCrossJourneyLinks(manifest({
    id: "JRNY-124",
    exitPoints: [{ atStep: "only-step", label: "Leave", toJourney: "JRNY-1240" }],
  }));

  assert.deepEqual(errors, []);
});
