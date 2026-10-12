export const assignmentLabels: Record<string, string> = {
  live: 'Live', 'live-unrecorded': 'Live (unrecorded)', launching: 'Launching',
  'launch-unconfirmed': 'Launch unconfirmed', 'exited-unrecorded': 'Exited (unrecorded)',
  'terminal-lost': 'Terminal lost', unknown: 'Unknown', ended: 'Ended', 'launch-failed': 'Launch failed',
};
export const assignmentTones: Record<string, string> = {
  live: 'good', 'live-unrecorded': 'good', launching: 'muted', 'launch-unconfirmed': 'warn',
  'exited-unrecorded': 'muted', 'terminal-lost': 'warn', unknown: 'warn', ended: 'muted', 'launch-failed': 'muted',
};
export const assignmentEnded = (a: any) => a?.display === 'ended' || a?.display === 'launch-failed';
export const assignmentLabel = (a: any) => assignmentLabels[a?.display] || 'Unknown';
export const assignmentTone = (a: any) => assignmentTones[a?.display] || 'muted';
export const completionLabel = (r: any) => r?.completion_basis === 'manual' ? 'Marked complete'
  : r?.completion_basis === 'merged-pr' ? 'PR merged' : r?.completion_basis === 'ready-pr' ? 'Ready PR published' : 'Workflow marked complete';
export const runState = (r: any, isRunningUnconfirmed: (record: any) => boolean) => {
  if (r?.recent_completion) return 'Completed';
  if (isRunningUnconfirmed(r)) return 'Running unconfirmed';
  const workflow: Record<string, string> = { ready: 'Ready for next action', 'waiting-worker': 'Waiting for worker', 'waiting-external': 'Waiting externally', 'decision-required': 'Decision needed', blocked: 'Blocked', 'user-held': 'On hold' };
  if (r?.is_current_assignment === true && ['ready', 'waiting-worker', 'waiting-external', 'decision-required', 'blocked', 'user-held'].includes(r.workflow_state) && ['completed', 'complete', 'failed', 'cancelled', 'stale', 'stopped', 'closed', 'aborted', 'done'].includes(r.execution)) return workflow[r.workflow_state];
  return r?.execution || 'Unknown';
};
export const epicStats = (e: any) => {
  const summary = e?.summary || {}, members = e?.members || [];
  const n = (v: unknown, fallback: number) => Number.isFinite(v) ? Number(v) : fallback;
  return { total: n(summary.total, members.length), landed: n(summary.merged, members.filter((m: any) => m.status === 'merged').length) + n(summary.complete, members.filter((m: any) => m.status === 'complete').length), attention: n(summary.attention, members.filter((m: any) => m.attention === true).length) };
};
export const epicMemberTone = (m: any) => m.status === 'merged' || m.status === 'complete' ? 'good'
  : m.attention === true || !m.status || ['missing', 'unobserved', 'unknown'].includes(m.status) ? 'warn' : 'muted';
export const specProgress = (r: any) => {
  const p = r?.spec_progress || {}, total = Number.isSafeInteger(p.total_steps) && p.total_steps >= 0 ? p.total_steps : null;
  const position = Number.isSafeInteger(p.current_position) && p.current_position > 0 && total !== null && p.current_position <= total ? p.current_position : null;
  return { total, position, label: position !== null ? `Step ${position} of ${total}` : total === 0 ? 'No prepared steps' : total !== null ? `Current step unknown · ${total} steps` : 'Spec size unknown', name: position !== null ? p.current_name : null };
};
export const duration = (start: unknown, end: unknown) => {
  const a = Date.parse(String(start || '')), b = Date.parse(String(end || ''));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 'Unknown';
  const s = Math.floor((b - a) / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
export const packageViewUrl = (packagePath: string, file: string) => {
  const bytes = new TextEncoder().encode(packagePath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `/package-view/${encoded}/${file.split('/').map(encodeURIComponent).join('/')}`;
};
