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

export const plannedBriefTitle = (packageRef: string) =>
  `Resume ${packageRef} through PR publication`.slice(0, 200);

export const plannedBriefContent = (packageRef: string) =>
  `/spec-end-to-end Resume after spec-write for ${packageRef}.\n` +
  `Continue through PR publication.\n\n` +
  `DEFAULT_OWNER: meta/muse-spark-1.3-contributor:xhigh from openrouter\n` +
  `STRONG_OWNER: gpt-6.1-sol:medium from openai-codex\n` +
  `EDITOR_AGENT: deepseek-flash:max from deepseek\n` +
  `REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex\n` +
  `SCOUT_AGENT: gpt-6-luna:low from openai-codex\n` +
  `FINAL_REVIEWER: gpt-6.1-sol:xhigh from openai-codex\n` +
  `PACKAGE: ${packageRef}`;

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
