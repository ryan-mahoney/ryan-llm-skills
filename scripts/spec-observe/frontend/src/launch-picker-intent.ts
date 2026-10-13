// Explicit new-assignment intent through the workspace picker.
//
// The Agents Launch agent action resets an acknowledged launched draft
// immediately when a concrete workspace scope exists. From All workspaces
// there is no concrete draft yet, so the intent is armed and applied once
// the picker choice provides the workspace — without resetting drafts on
// generic scope/history navigation and without touching pending, failed,
// unconfirmed or absent entries. launch-state.ts remains the single owner
// of the draft store; this module owns only the intent state machine and
// the acknowledged-success guard so it stays testable without a DOM.
export type LaunchPickerIntent = { armed: boolean };

export function createLaunchPickerIntent(): LaunchPickerIntent {
  return { armed: false };
}

export function armLaunchPickerIntent(state: LaunchPickerIntent): void {
  state.armed = true;
}

export function cancelLaunchPickerIntent(state: LaunchPickerIntent): void {
  state.armed = false;
}

// True only for the explicit picker choice that completes an armed
// Agents -> All workspaces -> Launch agent entry. Generic scope changes,
// rail navigation and history entries never satisfy this, even when they
// land on the same launch destination.
export function shouldApplyPickerReset(state: LaunchPickerIntent, dest: string): boolean {
  return state.armed && dest === 'launch';
}

// True only for an acknowledged successful launch with no pending
// operation. Pending, failed, unconfirmed, absent and editable entries
// never satisfy this and are left untouched.
export function shouldResetAcknowledgedDraft(
  draft: { pending?: unknown; result?: { kind?: string } } | undefined,
): boolean {
  return Boolean(draft) && !draft!.pending && draft!.result?.kind === 'launched';
}
