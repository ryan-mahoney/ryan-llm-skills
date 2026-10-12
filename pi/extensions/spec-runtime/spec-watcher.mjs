import { watch } from 'chokidar';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

// Discovery and the managed index are read separately; only a workspace's
// `specs/` and `epics/` directories under the storage root get watches.
export function watchSpecTree(directory, invalidate) {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root)
    throw new Error('Sentinel watches require a canonical directory');
  const outside = path => {
    const rel = relative(root, resolve(path));
    return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
  };
  return watch(root, {
    ignoreInitial: true, followSymlinks: false, usePolling: false,
    atomic: true, awaitWriteFinish: false,
    ignored: (path, stat) => outside(path) || Boolean(stat?.isSymbolicLink()),
  }).on('all', (_event, path) => { if (!outside(path)) invalidate(); });
}
