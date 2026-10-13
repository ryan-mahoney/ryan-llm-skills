// Standard package prompt shared by first launch and relaunch.
export const plannedBriefTitle = (packageRef) =>
  `Resume ${packageRef} through PR publication`.slice(0, 200);

export const plannedBriefContent = (packageRef) =>
  `/spec-end-to-end Resume after spec-write for ${packageRef}.\n` +
  `Continue through PR publication.\n\n` +
  `DEFAULT_OWNER: meta/muse-spark-1.3-contributor:xhigh from openrouter\n` +
  `STRONG_OWNER: gpt-6.1-sol:medium from openai-codex\n` +
  `EDITOR_AGENT: deepseek-flash:max from deepseek\n` +
  `REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex\n` +
  `SCOUT_AGENT: gpt-6-luna:low from openai-codex\n` +
  `FINAL_REVIEWER: gpt-6.1-sol:xhigh from openai-codex\n` +
  `PACKAGE: ${packageRef}`;
