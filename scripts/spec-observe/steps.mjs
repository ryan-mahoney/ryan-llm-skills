// Step-index semantics for spec-observe: canonical write identities, dependency
// waves and the metadata contract that lint and startup validation share.
// validateStepIndex is the only owner of readiness checks; callers only render
// its result. Nothing here writes files or resolves repositories.

import { epicWaves } from './epics.mjs';

const GATE_KINDS = new Set(['focused-test', 'integration-test', 'deterministic-inspection']);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Splits a canonical checkout-relative POSIX path from its optional trailing
// directory slash and reports every violation instead of the first one.
function canonicalPath(value) {
  if (typeof value !== 'string' || !value) return { problems: ['is not a nonempty path string'], path: '', dir: false };
  const problems = [];
  if (value.includes('\\')) problems.push('contains a backslash');
  if (value.startsWith('/')) problems.push('is absolute');
  if (value.includes('//')) problems.push('contains an empty segment');
  if (/[*?[\]]/.test(value)) problems.push('contains a glob character');
  let path = value;
  let dir = false;
  if (path.endsWith('/')) {
    dir = true;
    path = path.slice(0, -1);
  }
  if (!path) problems.push('is empty');
  for (const segment of path ? path.split('/') : []) {
    if (!segment) problems.push('contains an empty segment');
    else if (segment === '.' || segment === '..') problems.push(`contains the relative segment ${segment}`);
    else if (segment === '.git') problems.push('contains a .git segment');
  }
  return { problems, path, dir };
}

// Canonicalizes one declared write against the package targets. A string may
// carry an explicit `target:path` prefix; a changed-path record carries
// `{path, deleted?}` and takes its target from the sole target or repository.
export function normalizeWrite(entry, options = {}) {
  const targets = Array.isArray(options?.targets) ? options.targets : null;
  const repository = options?.repository;
  if (!targets || !targets.length || targets.some(target => typeof target !== 'string' || !target)
    || new Set(targets).size !== targets.length) {
    return { ok: false, errors: ['write options need a nonempty list of unique target ids'] };
  }

  const errors = [];
  const record = isObject(entry);
  let text;
  let deleted = false;
  if (record) {
    for (const key of Object.keys(entry)) {
      if (key !== 'path' && key !== 'deleted') errors.push(`changed-path record has unknown field ${JSON.stringify(key)}`);
    }
    if (typeof entry.path !== 'string') errors.push('changed-path record needs a string path');
    else text = entry.path;
    if (entry.deleted !== undefined && typeof entry.deleted !== 'boolean') errors.push('changed-path record deleted must be a boolean');
    else deleted = entry.deleted === true;
  } else if (typeof entry === 'string') {
    text = entry;
  } else {
    return { ok: false, errors: ['write entry must be a canonical path string or a changed-path record'] };
  }

  let prefix = null;
  if (!record && text !== undefined) {
    const colon = text.indexOf(':');
    if (colon >= 0) {
      prefix = text.slice(0, colon);
      text = text.slice(colon + 1);
    }
  }

  let target = null;
  if (record) {
    if (targets.length === 1) target = targets[0];
    else if (typeof repository === 'string' && targets.includes(repository)) target = repository;
    else errors.push('multi-target changed-path records need a repository target');
  } else if (prefix !== null) {
    if (!targets.includes(prefix)) errors.push(`unknown target prefix ${JSON.stringify(prefix)}`);
    else if (targets.length > 1 && prefix !== repository) errors.push(`write target ${prefix} does not match repository ${JSON.stringify(repository)}`);
    else target = prefix;
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    errors.push('multi-target writes need an explicit target prefix matching the step repository');
  }

  const canonical = canonicalPath(text ?? '');
  errors.push(...canonical.problems);
  if (errors.length) return { ok: false, errors };
  return { ok: true, target, path: canonical.path, dir: canonical.dir, deleted, identity: `${target}:${canonical.path}` };
}

// True when two canonical writes touch the same target and either the exact
// same path or one is a strict segment-prefix ancestor of the other.
export function writeConflicts(left, right) {
  if (!left?.ok || !right?.ok || left.target !== right.target) return false;
  if (left.path === right.path) return true;
  const leftSegments = left.path.split('/');
  const rightSegments = right.path.split('/');
  if (leftSegments.length === rightSegments.length) return false;
  const [shorter, longer] = leftSegments.length < rightSegments.length
    ? [leftSegments, rightSegments]
    : [rightSegments, leftSegments];
  return shorter.every((segment, index) => longer[index] === segment);
}

// Effective dependencies: declared requires plus every lower-numbered step
// that shares an exclusive resource key, so shared allocations serialize
// visibly instead of relying on a runtime guess.
function effectiveRequires(steps) {
  const effective = new Map();
  steps.forEach((entry, position) => {
    effective.set(position, new Set(Array.isArray(entry?.requires) ? entry.requires : []));
  });
  steps.forEach((entry, position) => {
    const resources = Array.isArray(entry?.resources) ? entry.resources : [];
    if (!resources.length || !Number.isInteger(entry?.step)) return;
    steps.forEach((other, otherPosition) => {
      if (otherPosition === position || !Number.isInteger(other?.step)) return;
      if (other.step >= entry.step) return;
      const otherResources = Array.isArray(other.resources) ? other.resources : [];
      if (otherResources.some(key => resources.includes(key))) effective.get(position).add(other.step);
    });
  });
  return effective;
}

// Wave layering delegates to epicWaves through a positional member adapter;
// unknown dependencies keep a name that can never be placed, which surfaces
// as a cycle instead of silently dropping the requirement.
function deriveWaves(steps) {
  const effective = effectiveRequires(steps);
  const memberIndex = new Map();
  steps.forEach((entry, position) => {
    if (Number.isInteger(entry?.step) && !memberIndex.has(entry.step)) memberIndex.set(entry.step, position);
  });
  const packages = steps.map((entry, position) => ({
    package: position,
    requires: [...effective.get(position)].map(dependency => memberIndex.has(dependency) ? memberIndex.get(dependency) : `missing:${String(dependency)}`),
  }));
  const fan_in = steps
    .filter((entry, position) => effective.get(position).size >= 2)
    .map(entry => entry?.step)
    .sort((left, right) => left - right);
  const outcome = epicWaves(packages);
  if (outcome.cycle) {
    return { waves: [], longest_chain: 0, fan_in, cycle: outcome.cycle.map(position => steps[position]?.step) };
  }
  const waves = (outcome.waves ?? []).map(wave => wave.map(position => steps[position]?.step));
  const chain = new Map();
  for (const wave of waves) {
    for (const stepNumber of wave) {
      const position = memberIndex.get(stepNumber);
      let depth = 0;
      for (const dependency of effective.get(position)) depth = Math.max(depth, chain.get(dependency) ?? 0);
      chain.set(stepNumber, depth + 1);
    }
  }
  const longest_chain = chain.size ? Math.max(...chain.values()) : 0;
  return { waves, longest_chain, fan_in, cycle: null };
}

export function stepWaves(steps) {
  const { waves, longest_chain, fan_in } = deriveWaves(Array.isArray(steps) ? steps : []);
  return { waves, longest_chain, fan_in };
}

// A setup value is the literal "none" or a prepared-command object. Lockfiles
// are unique canonical target-relative files; environment lists unique valid
// variable names, never values.
function setupValueProblem(value) {
  if (value === 'none') return null;
  if (!isObject(value)) return 'value must be "none" or an object with command, lockfiles and environment';
  for (const key of Object.keys(value)) {
    if (key !== 'command' && key !== 'lockfiles' && key !== 'environment') return `has unknown field ${JSON.stringify(key)}`;
  }
  if (typeof value.command !== 'string' || !value.command.trim()) return 'command must be a nonempty string';
  if (!Array.isArray(value.lockfiles)) return 'lockfiles must be an array';
  if (!Array.isArray(value.environment)) return 'environment must be an array';
  const files = new Set();
  for (const file of value.lockfiles) {
    const canonical = canonicalPath(file);
    if (canonical.problems.length || canonical.dir) return `lockfile ${JSON.stringify(file)} is not a canonical target-relative file`;
    if (files.has(canonical.path)) return `lockfile ${JSON.stringify(file)} is repeated`;
    files.add(canonical.path);
  }
  const names = new Set();
  for (const name of value.environment) {
    if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name)) return `environment entry ${JSON.stringify(name)} is not a variable name`;
    if (names.has(name)) return `environment entry ${name} is repeated`;
    names.add(name);
  }
  return null;
}

// Validates one parsed step index and reports the derived contract. `ok` means
// the metadata is well formed; `concurrency_ready` additionally requires one
// target, complete wave checks bound to required merge gates and complete
// setup. Reasons explain why valid metadata still runs serially.
export function validateStepIndex(index, options = {}) {
  const errors = [];
  const reasons = [];
  const result = {
    ok: false,
    legacy: false,
    waves: [],
    longest_chain: 0,
    fan_in: [],
    errors,
    concurrency_ready: false,
    reasons,
  };

  const targets = Array.isArray(options.targets) ? options.targets : [];
  if (!targets.length || targets.some(target => typeof target !== 'string' || !target) || new Set(targets).size !== targets.length) {
    errors.push('validation targets must be a nonempty list of unique target ids');
    return result;
  }
  if (!isObject(index) || !Array.isArray(index.steps)) {
    errors.push('step index must be an object with a steps array');
    return result;
  }

  const steps = index.steps;
  const newStyle = steps.some(entry => isObject(entry) && (hasOwn(entry, 'requires') || hasOwn(entry, 'writes')));
  result.legacy = !newStyle;

  if (!newStyle) {
    const numbers = new Set();
    for (let position = 0; position < steps.length; position++) {
      const entry = steps[position];
      if (!isObject(entry) || !Number.isInteger(entry.step) || entry.step < 1) {
        errors.push(`legacy step ${position + 1} is not an object with a step number`);
        continue;
      }
      if (numbers.has(entry.step)) errors.push(`duplicate step number ${entry.step}`);
      numbers.add(entry.step);
    }
    if (errors.length) return result;
    // Legacy indexes declare no dependencies, so serial order stays input order.
    result.waves = steps.map(entry => [entry.step]);
    result.longest_chain = steps.length;
    reasons.push('legacy-serial');
    result.ok = true;
    return result;
  }

  // New contract: every step declares both requires and writes.
  const members = new Map();
  let shapesOk = true;
  for (let position = 0; position < steps.length; position++) {
    const entry = steps[position];
    const label = isObject(entry) && Number.isInteger(entry.step) ? entry.step : position + 1;
    if (!isObject(entry)) {
      errors.push(`step ${position + 1} is not an object`);
      shapesOk = false;
      continue;
    }
    if (!hasOwn(entry, 'requires') || !hasOwn(entry, 'writes')) {
      errors.push(`step ${label} must declare requires and writes because other steps do`);
      shapesOk = false;
      continue;
    }
    if (!Number.isInteger(entry.step) || entry.step < 1) {
      errors.push(`step ${position + 1} has an invalid step number`);
      shapesOk = false;
    } else if (members.has(entry.step)) {
      errors.push(`duplicate step number ${entry.step}`);
      shapesOk = false;
    } else {
      members.set(entry.step, entry);
    }
    if (!Array.isArray(entry.requires)) {
      errors.push(`step ${label} requires must be an array`);
      shapesOk = false;
    }
    if (!Array.isArray(entry.writes) || !entry.writes.length) {
      errors.push(`step ${label} writes must be a nonempty array`);
      shapesOk = false;
    }
    if (entry.resources !== undefined) {
      if (!Array.isArray(entry.resources) || entry.resources.some(key => typeof key !== 'string' || !key)) {
        errors.push(`step ${label} resources must be a list of names`);
      } else if (new Set(entry.resources).size !== entry.resources.length) {
        errors.push(`step ${label} repeats a resource key`);
      }
    }
    if (entry.repository !== undefined && (typeof entry.repository !== 'string' || !entry.repository)) {
      errors.push(`step ${label} repository must be a target id`);
    }
  }
  if (!shapesOk) return result;

  for (const entry of steps) {
    const seen = new Set();
    for (const dependency of entry.requires) {
      if (!Number.isInteger(dependency) || dependency < 1) errors.push(`step ${entry.step} requires a non-integer dependency ${JSON.stringify(dependency)}`);
      else if (dependency === entry.step) errors.push(`step ${entry.step} requires itself`);
      else if (dependency > entry.step) errors.push(`step ${entry.step} requires future step ${dependency}`);
      else if (!members.has(dependency)) errors.push(`step ${entry.step} requires unknown step ${dependency}`);
      if (seen.has(dependency)) errors.push(`step ${entry.step} repeats dependency ${JSON.stringify(dependency)}`);
      seen.add(dependency);
    }
  }

  const derived = deriveWaves(steps);
  result.waves = derived.waves;
  result.longest_chain = derived.longest_chain;
  result.fan_in = derived.fan_in;
  if (derived.cycle) errors.push(`requires form a cycle among steps ${derived.cycle.join(', ')}`);

  const writesByStep = new Map();
  for (const entry of steps) {
    const seen = new Set();
    const normalized = [];
    for (const item of entry.writes) {
      const parsed = normalizeWrite(item, { targets, repository: entry.repository });
      if (!parsed.ok) errors.push(`step ${entry.step} write ${typeof item === 'string' ? JSON.stringify(item) : 'record'}: ${parsed.errors.join('; ')}`);
      else if (seen.has(parsed.identity)) errors.push(`step ${entry.step} repeats write ${parsed.identity}`);
      else {
        seen.add(parsed.identity);
        normalized.push(parsed);
      }
    }
    writesByStep.set(entry.step, normalized);
  }
  for (let waveIndex = 0; waveIndex < result.waves.length; waveIndex++) {
    const wave = result.waves[waveIndex];
    for (let a = 0; a < wave.length; a++) {
      for (let b = a + 1; b < wave.length; b++) {
        for (const left of writesByStep.get(wave[a]) ?? []) {
          for (const right of writesByStep.get(wave[b]) ?? []) {
            if (writeConflicts(left, right)) {
              errors.push(`wave ${waveIndex + 1} has conflicting writes: step ${wave[a]} writes ${left.identity} and step ${wave[b]} writes ${right.identity}`);
            }
          }
        }
      }
    }
  }

  let checksComplete = false;
  if (index.wave_checks === undefined) {
    checksComplete = false;
  } else if (!Array.isArray(index.wave_checks)) {
    errors.push('wave_checks must be an array of {after, owner_step, gates} rows');
  } else {
    const seenAfter = new Set();
    const covered = new Set();
    let rowsComplete = true;
    for (let rowIndex = 0; rowIndex < index.wave_checks.length; rowIndex++) {
      const row = index.wave_checks[rowIndex];
      if (!isObject(row)) {
        errors.push(`wave_checks[${rowIndex}] is not an object`);
        rowsComplete = false;
        continue;
      }
      const { after, owner_step: owner, gates } = row;
      if (!Number.isInteger(after)) errors.push(`wave_checks[${rowIndex}] after must be an integer`);
      else if (seenAfter.has(after)) errors.push(`wave_checks repeats after ${after}`);
      else seenAfter.add(after);
      if (!Number.isInteger(owner)) errors.push(`wave_checks[${rowIndex}] owner_step must be an integer`);
      const wave = Number.isInteger(owner) ? result.waves.find(candidate => candidate.includes(owner)) ?? null : null;
      if (Number.isInteger(owner) && !wave) errors.push(`wave_checks[${rowIndex}] owner_step ${owner} is not a member of any wave`);
      if (wave && Number.isInteger(after) && after !== wave[wave.length - 1]) {
        errors.push(`wave_checks[${rowIndex}] after ${after} is stale: the wave containing owner_step ${owner} ends at step ${wave[wave.length - 1]}`);
      }
      if (wave) covered.add(wave);
      if (!Array.isArray(gates) || gates.some(id => typeof id !== 'string' || !id)) {
        errors.push(`wave_checks[${rowIndex}] gates must be a list of gate ids`);
        rowsComplete = false;
      } else if (!gates.length) {
        rowsComplete = false;
      } else {
        const planGates = isObject(options.evidencePlan) && Array.isArray(options.evidencePlan.gates) ? options.evidencePlan.gates : null;
        if (!planGates) {
          errors.push(`wave_checks[${rowIndex}] references gates but the evidence plan has no gates`);
          continue;
        }
        const rowSeen = new Set();
        for (const gateId of gates) {
          if (rowSeen.has(gateId)) {
            errors.push(`wave_checks[${rowIndex}] repeats gate ${gateId}`);
            continue;
          }
          rowSeen.add(gateId);
          const gate = planGates.find(candidate => isObject(candidate) && candidate.id === gateId);
          if (!gate) {
            errors.push(`wave_checks[${rowIndex}] names unknown gate ${gateId}`);
            continue;
          }
          if (gate.required !== true) errors.push(`wave_checks[${rowIndex}] gate ${gateId} is not required`);
          if (gate.phase !== 'merge') errors.push(`wave_checks[${rowIndex}] gate ${gateId} is not a merge-phase gate`);
          if (!GATE_KINDS.has(gate.kind)) errors.push(`wave_checks[${rowIndex}] gate ${gateId} kind ${JSON.stringify(gate.kind)} cannot gate a wave`);
          if (Number.isInteger(owner) && gate.ownerStep !== owner) {
            errors.push(`wave_checks[${rowIndex}] gate ${gateId} belongs to step ${JSON.stringify(gate.ownerStep)}, not ${owner}`);
          }
          if (typeof gate.command !== 'string' || !gate.command.trim()) errors.push(`wave_checks[${rowIndex}] gate ${gateId} has no command`);
          if (typeof gate.artifact !== 'string' || !gate.artifact.trim()) errors.push(`wave_checks[${rowIndex}] gate ${gateId} has no artifact`);
        }
      }
    }
    let coverageOk = true;
    for (const wave of result.waves) {
      if (wave.length && !covered.has(wave)) {
        coverageOk = false;
        errors.push(`wave_checks is missing a row for the wave ending at step ${wave[wave.length - 1]}`);
      }
    }
    checksComplete = rowsComplete && coverageOk && index.wave_checks.length > 0;
  }

  let setupMissing = true;
  if (index.setup === undefined) {
    setupMissing = true;
  } else if (!isObject(index.setup)) {
    errors.push('setup must be an object keyed by target id');
  } else {
    for (const [key, value] of Object.entries(index.setup)) {
      const problem = setupValueProblem(value);
      if (problem) errors.push(`setup.${key} ${problem}`);
    }
    setupMissing = targets.some(target => !hasOwn(index.setup, target));
  }

  if (!checksComplete) reasons.push('wave-checks-incomplete');
  if (setupMissing) reasons.push('setup-missing');
  if (targets.length !== 1) reasons.push('multiple-targets');

  result.ok = errors.length === 0;
  result.concurrency_ready = result.ok && targets.length === 1 && checksComplete && !setupMissing;
  return result;
}
