import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';

// Call only after spec-location has resolved the assignment's canonical package.
// A per-launch value avoids widening every session to the adjacent storage root.
export function artifactEnvironment(packagePath) {
  if (typeof packagePath !== 'string' || !isAbsolute(packagePath)) throw new Error('Canonical package path must be absolute');
  const root = realpathSync(packagePath);
  if (dirname(root) === root || root.includes(':') || !statSync(root).isDirectory())
    throw new Error('Package cannot be represented as a bounded Warden host path');
  return { PI_WARDEN_HOST_PATHS: root };
}
