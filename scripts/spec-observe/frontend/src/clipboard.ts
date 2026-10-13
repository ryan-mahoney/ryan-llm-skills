// Minimal native copy owner shared by SessionPanel and AgentDetail. Clipboard
// denial never blocks the surface: the caller supplies a readonly textarea so
// the operator can select and copy manually. No command runs and no POST is
// issued here; callers own their own feedback text.
export type CopyResult = 'copied' | 'manual';

export async function copyText(
  text: string,
  fallbackEl?: HTMLTextAreaElement | null,
): Promise<CopyResult> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    if (fallbackEl) {
      fallbackEl.focus();
      fallbackEl.select();
    }
    return 'manual';
  }
}
