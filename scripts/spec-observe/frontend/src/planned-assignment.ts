export type PlannedTarget = {
  id: string;
  primary: string;
  worktree?: string | null;
};

export type PlannedTargetChoice = {
  key: string;
  id: string;
  path: string;
};

export {plannedBriefTitle, plannedBriefContent} from '../../../workspaces/spec-prompt.mjs';

/**
 * Keep only absolute primary paths from the canonical package target inventory.
 * The assignment backend resolves each selected path against workspace
 * repositories and refuses missing or ambiguous bindings.
 */
export function plannedTargetChoices(
  packageTargets: PlannedTarget[] | null | undefined,
): PlannedTargetChoice[] {
  if (!Array.isArray(packageTargets)) return [];
  const choices = new Map<string, PlannedTargetChoice>();
  for (const target of packageTargets) {
    if (!target || typeof target.id !== 'string' || !target.id || typeof target.primary !== 'string' || !target.primary.startsWith('/')) continue;
    const path = target.primary;
    const key = `${target.id}\n${path}`;
    choices.set(key, { key, id: target.id, path });
  }
  return [...choices.values()].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
}

export function plannedTargetLabel(target: PlannedTargetChoice) {
  return `${target.id} · ${target.path}`;
}
