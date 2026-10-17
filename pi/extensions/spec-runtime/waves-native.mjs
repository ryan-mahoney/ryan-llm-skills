// Native wave-routing boundary split out of index.ts (step 10).
//
// `nativeWaveAction` classifies a dispatch action as one delivered to the
// native wave controller, or null when the action stays on the legacy per-run
// route. `createNativeWaveController` binds the shared ownership facade, host
// policy budgets and the lifecycle seam, then builds the wave controller
// through the injected `createController` seam.
import { join } from 'node:path';

import { createWaveController, phaseLifecycle } from './waves.mjs';
import * as reviewNamespace from './wave-review.mjs';
import * as integrationNamespace from './wave-integration.mjs';
import { readCheckpointRecord, recordCheckpoint, reconcileRuntimeReturn } from './sentinel.mjs';
import { runtimeHostCommand } from './linux-resources.mjs';
import { createOwnership } from './ownership.mjs';

// startup/advance/recover are always native wave entries. status/cancel are
// native only when a nonempty wave_id names a durable wave; a run_id alone (or
// a missing/empty/whitespace wave_id) stays on the legacy per-run route. start
// never routes to a wave.
export function nativeWaveAction(input = {}) {
  const action = input && input.action;
  if (action === 'startup' || action === 'advance' || action === 'recover') return action;
  if (action === 'status' || action === 'cancel') {
    const waveId = input.wave_id;
    return typeof waveId === 'string' && waveId.trim() !== '' ? action : null;
  }
  return null;
}

// One stable delegating facade is installed on both the runtime and the deps
// handed to the controller. Before a successful host probe the facade delegates
// to the runtime's existing ownership handle; a ready policy swaps in a
// budgeted backend. Function members are read through the current backend and
// bound to it, so callers holding the facade always reach the live backend.
function installOwnershipFacade(target, initialBackend) {
  let backend = initialBackend;
  const facade = new Proxy({}, {
    get(_unused, property) {
      const value = backend ? backend[property] : undefined;
      return typeof value === 'function' ? value.bind(backend) : value;
    },
    has(_unused, property) {
      return backend ? property in backend : false;
    }
  });
  return {
    facade,
    replace(nextBackend) {
      backend = nextBackend;
    }
  };
}

export function createNativeWaveController(options = {}) {
  const {
    runtime,
    coordinator,
    send,
    indexDir,
    hostCheck = async args => (await runtimeHostCommand('check', {}, args)).result,
    ownershipFactory = createOwnership,
    review = reviewNamespace,
    integration = integrationNamespace,
    checkpoint = { readCheckpointRecord, recordCheckpoint, reconcileRuntimeReturn },
    location = runtime ? runtime.location : undefined,
    createController = createWaveController,
    ...rest
  } = options;

  const ownershipHandle = installOwnershipFacade(runtime, runtime ? runtime.ownership : undefined);
  const ownership = ownershipHandle.facade;

  // The facade is the single stable ownership identity shared by the runtime
  // and the controller deps. Construction never probes the host.
  if (runtime) runtime.ownership = ownership;

  const hostCheckSeam = async args => {
    const result = await hostCheck({ ...args, mode: 'probe' });
    if (result && result.status === 'ready' && result.policy) {
      const policy = result.policy;
      const backend = ownershipFactory({
        registryRoot: join(indexDir, 'ownership'),
        budgets: { memoryBytes: policy.poolMemoryBytes, tasks: policy.aggregateTasks }
      });
      ownershipHandle.replace(backend);
    }
    return result;
  };

  const lifecycle = phaseLifecycle({ serviceAdapter: runtime ? runtime.serviceAdapter : undefined });

  const deps = {
    ...rest,
    runtime,
    coordinator,
    ownership,
    hostCheck: hostCheckSeam,
    review,
    integration,
    checkpoint,
    send,
    location,
    lifecycle
  };

  return createController(deps);
}
