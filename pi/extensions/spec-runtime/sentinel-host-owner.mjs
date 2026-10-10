// Thin host composition for the shared keyed ownership claim: one host per
// canonical agent directory regardless of scope or dashboard port. Step 6 owns
// CLI invocation and lifecycle; importing this module creates no host.
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { claimOwner } from '../../../scripts/spec-observe/owner-claim.mjs';

export const HOST_OWNER_KEY = 'sentinel-host';

function ownedDirectory(directory) {
  let current;
  try {
    current = lstatSync(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Sentinel host state directory ${directory} is unreadable (${error.code ?? error.message})`);
    }
  }
  if (current === undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    current = lstatSync(directory);
  }
  if (current.isSymbolicLink()) throw new Error(`Sentinel host state directory ${directory} is a symlink; refusing to follow it`);
  if (!current.isDirectory()) throw new Error(`Sentinel host state directory ${directory} is not a directory`);
  chmodSync(directory, 0o700);
}

export function claimHost({ agentDir } = {}) {
  if (typeof agentDir !== 'string' || agentDir.length === 0) {
    throw new Error('claimHost requires an agentDir path');
  }
  try {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Sentinel host agent directory ${agentDir} is unavailable (${error.code ?? error.message})`);
  }
  const canonicalAgentDir = realpathSync(agentDir);
  const stateDir = join(canonicalAgentDir, 'spec-sentinel');
  ownedDirectory(stateDir);
  return claimOwner({ database: join(stateDir, 'coordination.sqlite'), key: HOST_OWNER_KEY });
}
