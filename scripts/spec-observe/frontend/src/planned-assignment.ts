// Legacy planned-assignment surface: brief bytes stay owned by
// scripts/workspaces/spec-prompt.mjs and the canonical target helpers now live
// with the bound hand-off owner. This module re-exports both so existing
// PlannedAssignment callers and tests keep their imports unchanged.
export { plannedTargetChoices, plannedTargetLabel } from './launch-handoff';
export type { PlannedTarget, PlannedTargetChoice } from './launch-handoff';

export {plannedBriefTitle, plannedBriefContent} from '../../../workspaces/spec-prompt.mjs';
