// Derived-state limits include real files, SQLite sidecars and abandoned builds.
import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";

export const MAX_COMMITTED_BYTES = 2 * 1024 ** 3;
export const MAX_TEMPORARY_BYTES = 1024 ** 3;
export const MAX_DUMP_BYTES = 512 * 1024 ** 2;
export const SQLITE_WRITE_HEADROOM = 1024 * 1024;
export type GrowthCheck = (temporaryBytes?: number, committedBytes?: number) => void;
export class ResourceBudgetError extends Error {
  readonly code = "budget-exceeded";
}
export function ownedTreeBytes(path: string): number {
  let info;
  try { info = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  // Account only the link itself; its target is not owned state. Mutation
  // owners independently reject links at the exact write/delete boundary.
  if (info.isSymbolicLink()) return info.size;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) throw new ResourceBudgetError(`state accounting refuses nonregular path: ${path}`);
  try { return readdirSync(path).reduce((sum, name) => sum + ownedTreeBytes(join(path, name)), 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
export function measureState(root: string): { committed: number; temporary: number } {
  let committed = 0, temporary = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (name !== "generations") { committed += ownedTreeBytes(path); continue; }
    if (lstatSync(path).isSymbolicLink()) throw new ResourceBudgetError("generations directory is a symlink");
    for (const generation of readdirSync(path)) {
      const bytes = ownedTreeBytes(join(path, generation));
      if (generation.endsWith(".tmp")) temporary += bytes;
      else committed += bytes;
    }
  }
  return { committed, temporary };
}
export function assertStateGrowth(root: string, temporaryBytes = 0, committedBytes = 0,
  limits = { committed: MAX_COMMITTED_BYTES, temporary: MAX_TEMPORARY_BYTES },
  availableBytes?: number,
  diskGrowthBytes = Math.max(0, temporaryBytes) + Math.max(0, committedBytes),
): void {
  const measured = measureState(root);
  if (measured.committed + committedBytes > limits.committed || measured.temporary + temporaryBytes > limits.temporary) {
    throw new ResourceBudgetError("derived state would exceed committed or temporary byte budget; prune unreferenced state");
  }
  const disk = availableBytes ?? (() => { const fs = statfsSync(root); return fs.bavail * fs.bsize; })();
  if (disk < diskGrowthBytes) {
    throw new ResourceBudgetError("insufficient available disk for reserved derived-state growth");
  }
}
