// F10-6 installed-SDK composition helper.
//
// The two regressions at the bottom of waves-index.test.mjs need the REAL
// index.ts to run through the installed package loader while every native seam
// is supplied by the fixture. Rather than stub index.ts, this helper copies it
// to a temporary directory, rewrites only its relative import specifiers to
// the absolute original paths, and replaces only its `./waves-native.mjs`
// import with a generated wrapper. The wrapper calls the REAL synchronous
// createNativeWaveController over the fixture seams while keeping index.ts's
// own coordinator/send bindings (the F10-6 contracts under test).
//
// The wrapper reads its fixture dependencies from a unique globalThis registry
// key so the test can register `fixture.controllerDependencies()` before the
// loader runs and read back the composed controller afterwards.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SPEC_RUNTIME_INDEX } from './wave-review-fixture.mjs';
import { calculateResourcePolicy, MIB } from './linux-resources.mjs';

const here = dirname(fileURLToPath(new URL(import.meta.url)));
export const REAL_WAVES_NATIVE = join(here, 'waves-native.mjs');

export const MODELS = {
  owner_model: 'fixture-provider/team/owner',
  strong_owner_model: 'fixture-provider/team/owner',
  editor_model: 'fixture-provider/team/owner',
  review_model: 'fixture-provider/team/reviewer:high',
  fix_model_override: 'fixture-provider/team/owner',
  scout_model: 'fixture-provider/team/scout'
};

// The exact ready-host shape the fixture's default hostCheck returns. Reused
// verbatim so the composed controller sees an unchanged admission contract.
export function readyHost({ readyMembers = 16, explicitCap = null } = {}) {
  const policy = calculateResourcePolicy({
    physicalMemoryBytes: 256 * 1024 * MIB,
    aggregateTasks: 32768,
    readyMembers,
    explicitCap
  });
  return {
    version: 1,
    status: 'ready',
    ok: true,
    reason: 'ready',
    remedy: null,
    nativeReady: true,
    softwareCeiling: policy.softwareCeiling,
    route: 'native',
    fallback: null,
    host: { host_id: 'fixture-host', boot_id: 'fixture-boot', uid: process.getuid?.() ?? 1000 },
    admission: {
      status: 'ready', reason: 'admitted', remedy: null,
      admittedWidth: policy.admittedWidth, binding: 'ready-width',
      bindings: policy.bindings, launchable: true, slots: policy.slots, free: policy.free
    },
    policy,
    overlay: { status: 'unavailable', reason: 'fixture-worktree-transport', remedy: null, fallbackEligible: true }
  };
}

// Ready for the initial two-member wave but refuse a lone ready member: the
// dependent next-wave check sees one ready step, so denying it forces a REAL
// controller next-wave outcome and its routine (triggerTurn:false) send.
export function twoWaveHostCheck() {
  return async ({ readyMembers = 16, explicitCap = null } = {}) => {
    if (readyMembers === 1) {
      return {
        version: 1,
        status: 'setup-required',
        ok: false,
        reason: 'fixture-next-wave-gate',
        remedy: null,
        nativeReady: false,
        softwareCeiling: null,
        route: 'setup-required',
        fallback: null,
        host: { host_id: 'fixture-host', boot_id: 'fixture-boot', uid: process.getuid?.() ?? 1000 },
        admission: {
          status: 'setup-required', reason: 'fixture-next-wave-gate', remedy: null,
          admittedWidth: 0, binding: 'fixture-next-wave-gate',
          bindings: [], launchable: false, slots: 0, free: 0
        },
        overlay: { status: 'unavailable', reason: 'fixture-worktree-transport', remedy: null, fallbackEligible: true }
      };
    }
    return readyHost({ readyMembers, explicitCap });
  };
}

// Valid two-wave index over three generated members: steps 1/2 open the first
// wave, the dependent step 3 opens the second.
export function mutateTwoWaveIndex(index, evidencePlan) {
  index.steps[2].requires = [1, 2];
  index.wave_checks = [
    { after: 2, owner_step: 2, gates: ['EV-1'] },
    { after: 3, owner_step: 3, gates: ['EV-2'] }
  ];
  evidencePlan.gates[0].ownerStep = 2;
  const ev2 = JSON.parse(JSON.stringify(evidencePlan.gates[0]));
  ev2.id = 'EV-2';
  ev2.ownerStep = 3;
  ev2.artifact = 'evidence/EV-2.txt';
  evidencePlan.gates.push(ev2);
}

// The exact current adapter expressions in the real index.ts, and the pre-fix
// adapters each WAVES_INDEX_MUTANT mode substitutes for it. The modes let the
// owner execute each new regression against its corresponding old adapter.
const CURRENT_ADAPTER = {
  epoch: 'coordinator: () => ({ session: coordinatorIdentity(sessionCtx), epoch: nativeCoordinatorEpoch, ...nativeCoordinatorProcess }),',
  send: 'send: (message: any, options: any) => pi.sendMessage(message, options),'
};
const MUTANT_ADAPTER = {
  epoch: 'coordinator: () => ({ session: coordinatorIdentity(sessionCtx), ...nativeCoordinatorProcess }),',
  send: 'send: (value: any) => pi.sendMessage({ customType: \'spec-runtime\', content: JSON.stringify(value), display: true }, { triggerTurn: true }),'
};

function applyMutant(source) {
  const mode = process.env.WAVES_INDEX_MUTANT;
  if (!mode) return source;
  const current = CURRENT_ADAPTER[mode];
  const mutant = MUTANT_ADAPTER[mode];
  assert.ok(current, `unknown WAVES_INDEX_MUTANT=${mode} (expected epoch or send)`);
  const parts = source.split(current);
  assert.equal(parts.length - 1, 1,
    `WAVES_INDEX_MUTANT=${mode} must replace exactly one current adapter expression`);
  return parts.join(mutant);
}

// Rewrite only relative module specifiers to absolute original paths. The
// `./waves-native.mjs` specifier alone points at the generated wrapper.
function rewriteRelativeSpecifiers(source, baseDir, wrapperUrl) {
  return source.replace(
    /(\bimport\s*\(?\s*|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s+[^'"]*?\bfrom\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (whole, prefix, quote, spec) => {
      if (spec === './waves-native.mjs' || spec === './waves-native.js' || spec === './waves-native.ts') {
        return `${prefix}${quote}${wrapperUrl}${quote}`;
      }
      return `${prefix}${quote}${pathToFileURL(resolve(baseDir, spec)).href}${quote}`;
    }
  );
}

function wrapperSource({ realNativeUrl, key }) {
  return [
    '// GENERATED by waves-index-fixture.mjs for the F10-6 installed-SDK harness.',
    `import { createNativeWaveController as realCreateNativeWaveController, nativeWaveAction } from ${JSON.stringify(realNativeUrl)};`,
    '',
    'export { nativeWaveAction };',
    '',
    'export function createNativeWaveController(options = {}) {',
    `  const deps = globalThis[${JSON.stringify(key)}];`,
    "  if (!deps) throw new Error('waves-index-fixture: fixture deps are not registered');",
    '  const controller = realCreateNativeWaveController({',
    '    ...options,',
    '    runtime: deps.runtime,',
    '    location: deps.location,',
    '    indexDir: deps.indexDir,',
    '    hostCheck: deps.hostCheck,',
    '    ownershipFactory: () => deps.ownership,',
    '    review: deps.review,',
    '    integration: deps.integration,',
    '    checkpoint: deps.checkpoint,',
    '    lifecycle: deps.lifecycle,',
    '  });',
    '  deps.controller = controller;',
    '  return controller;',
    '}',
    ''
  ].join('\n');
}

// Copy the real index.ts into a temporary directory, install the wrapper, and
// register `deps` under the unique global key the wrapper reads. Callers must
// invoke cleanup() from t.after to remove the copied tree and the global key.
export function installInstalledIndex({ root, deps }) {
  const dir = mkdtempSync(join(root ?? tmpdir(), 'waves-index-copy-'));
  const key = `__waves_index_fixture_${randomUUID().replace(/-/g, '')}__`;
  const wrapperPath = join(dir, 'waves-native-wrapper.mjs');
  writeFileSync(wrapperPath, wrapperSource({
    realNativeUrl: pathToFileURL(REAL_WAVES_NATIVE).href,
    key
  }));
  const original = readFileSync(SPEC_RUNTIME_INDEX, 'utf8');
  const rewritten = rewriteRelativeSpecifiers(
    applyMutant(original),
    dirname(SPEC_RUNTIME_INDEX),
    pathToFileURL(wrapperPath).href
  );
  const indexPath = join(dir, 'index.ts');
  writeFileSync(indexPath, rewritten);

  globalThis[key] = deps;
  return {
    dir,
    indexPath,
    key,
    get controller() {
      return globalThis[key]?.controller ?? null;
    },
    cleanup() {
      delete globalThis[key];
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
