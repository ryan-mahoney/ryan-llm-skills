// Cross-journey derivation for the collection canvas. Pure: manifests in, nodes and edges out.
// Layout and HTML stay in render-journey-map.mjs.

const JOURNEY_ID = /^JRNY-\d{3,}$/;

const byJourneyId = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Minimal, defensible normalization: whitespace and one or more trailing slashes.
// Routes are matched exactly otherwise; no fuzzy matching of parameter names or hosts.
export const normalizeRoute = (route) => {
  const trimmed = String(route ?? "").trim();
  return trimmed.replace(/\/+$/, "") || trimmed;
};

export const surfaceId = (endpoint) => `surface:${String(endpoint?.repo ?? "").trim()}|${normalizeRoute(endpoint?.route)}`;

const seamsOf = (manifest) => new Set([
  ...(manifest.journey?.seams || []),
  ...(manifest.upstreamSeams || []).map((seam) => seam.id),
  ...(manifest.steps || []).map((step) => step?.transition?.seam),
].filter(Boolean));

const journeyIdError = (value, ownId, path) => {
  if (typeof value !== "string" || !JOURNEY_ID.test(value)) return `${path} must match JRNY-###`;
  if (value === ownId) return `${path} cannot name its own journey`;
  return null;
};

// Validates the optional cross-journey pointers. A target outside the collection is not an
// error here; the canvas draws it as an unmapped journey.
export const validateCrossJourneyLinks = (manifest) => {
  const ownId = manifest?.journey?.id;
  const errors = [];
  const optional = (value, path) => {
    if (value == null) return;
    const error = journeyIdError(value, ownId, path);
    if (error) errors.push(error);
  };
  for (const [index, step] of (manifest?.steps || []).entries()) {
    for (const [branchIndex, branch] of (step?.transition?.branches || []).entries()) {
      optional(branch?.toJourney, `steps[${index}].transition.branches[${branchIndex}].toJourney`);
    }
  }
  for (const [index, exit] of (manifest?.exitPoints || []).entries()) {
    optional(exit?.toJourney, `exitPoints[${index}].toJourney`);
  }
  const continuesIn = manifest?.terminal?.continuesIn;
  if (continuesIn != null && !Array.isArray(continuesIn)) {
    errors.push("terminal.continuesIn must be an array of journey IDs");
  } else if (Array.isArray(continuesIn)) {
    const seen = new Set();
    for (const [index, value] of continuesIn.entries()) {
      const error = journeyIdError(value, ownId, `terminal.continuesIn[${index}]`);
      if (error) errors.push(error);
      else if (seen.has(value)) errors.push(`terminal.continuesIn[${index}] repeats ${value}`);
      seen.add(value);
    }
  }
  return errors;
};

const crossJourneyTargets = (manifest) => [
  ...(manifest.steps || []).flatMap((step) => (step?.transition?.branches || [])
    .filter((branch) => branch?.toJourney)
    .map((branch) => ({ toJourney: branch.toJourney, label: branch.label, fromStep: step.id, source: "branch" }))),
  ...(manifest.exitPoints || [])
    .filter((exit) => exit?.toJourney)
    .map((exit) => ({ toJourney: exit.toJourney, label: exit.label, fromStep: exit.atStep, source: "exit" })),
];

export const buildJourneyGraph = (manifests) => {
  const ordered = [...manifests].sort((a, b) => byJourneyId(a.journey.id, b.journey.id));
  const mapped = new Set(ordered.map((manifest) => manifest.journey.id));
  const repositories = [];
  const repoIds = new Set();
  const surfaces = new Map();
  const unresolved = new Map();
  const journeys = [];
  const edges = [];

  const touchSurface = (endpoint, journeyId, role) => {
    const id = surfaceId(endpoint);
    if (!surfaces.has(id)) {
      surfaces.set(id, { id, repo: String(endpoint.repo).trim(), route: normalizeRoute(endpoint.route), label: endpoint.label, entryOf: [], terminalOf: [] });
    }
    surfaces.get(id)[role].push(journeyId);
    return id;
  };

  for (const manifest of ordered) {
    for (const repo of manifest.repositories) {
      if (repoIds.has(repo.id)) continue;
      repoIds.add(repo.id);
      repositories.push({ id: repo.id, label: repo.label, host: repo.host, color: repo.color });
    }
    const id = manifest.journey.id;
    const entry = touchSurface(manifest.entry, id, "entryOf");
    const terminal = touchSurface(manifest.terminal, id, "terminalOf");
    journeys.push({
      id,
      title: manifest.journey.title,
      entry,
      terminal,
      entryRepo: String(manifest.entry.repo).trim(),
      terminalRepo: String(manifest.terminal.repo).trim(),
      repoPath: manifest.steps.map((step) => step.repo).filter((repo, index, all) => repo !== all[index - 1]),
      terminalStep: manifest.steps.at(-1)?.id,
      continuesIn: manifest.terminal.continuesIn || [],
      seams: [...seamsOf(manifest)].sort(),
    });
    edges.push({ type: "entry", from: entry, to: id, label: "Begins" });
    edges.push({ type: "terminal", from: id, to: terminal, label: "Ends" });
  }

  const rememberUnresolved = (id, from) => {
    if (!unresolved.has(id)) unresolved.set(id, { id, referencedBy: [] });
    const record = unresolved.get(id);
    if (!record.referencedBy.includes(from)) record.referencedBy.push(from);
  };

  // A pair declared in terminal.continuesIn and also derived from a matching terminal and entry
  // is one relationship, so the declaration is kept and the derived duplicate is dropped.
  const continuationSeen = new Set();
  const addContinuation = (from, to, source) => {
    const key = `${from.id}|${to}`;
    if (continuationSeen.has(key)) return;
    continuationSeen.add(key);
    const resolved = mapped.has(to);
    if (!resolved) rememberUnresolved(to, from.id);
    edges.push({ type: "continuation", from: from.id, to, label: "Continues in", fromStep: from.terminalStep, source, resolved });
  };
  for (const journey of journeys) for (const target of journey.continuesIn) addContinuation(journey, target, "declared");
  for (const from of journeys) {
    for (const to of journeys) {
      if (from.id !== to.id && from.terminal === to.entry) addContinuation(from, to.id, "derived");
    }
  }

  const branchSeen = new Set();
  for (const manifest of ordered) {
    const from = manifest.journey.id;
    for (const target of crossJourneyTargets(manifest)) {
      // One handoff can be recorded as both a branch and an exit point on the same step.
      const key = `${from}|${target.toJourney}|${target.fromStep}`;
      if (branchSeen.has(key)) continue;
      branchSeen.add(key);
      const resolved = mapped.has(target.toJourney);
      if (!resolved) rememberUnresolved(target.toJourney, from);
      edges.push({ type: "branch", from, to: target.toJourney, label: target.label, fromStep: target.fromStep, source: target.source, resolved });
    }
  }

  const journeysBySeam = new Map();
  for (const journey of journeys) {
    for (const seam of journey.seams) {
      if (!journeysBySeam.has(seam)) journeysBySeam.set(seam, []);
      journeysBySeam.get(seam).push(journey.id);
    }
  }
  for (const [seam, ids] of [...journeysBySeam].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (ids.length < 2) continue;
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        edges.push({ type: "seam", from: ids[left], to: ids[right], label: seam, seam });
      }
    }
  }

  return {
    repositories,
    journeys,
    surfaces: [...surfaces.values()],
    unresolved: [...unresolved.values()].sort((a, b) => byJourneyId(a.id, b.id)),
    edges,
  };
};
