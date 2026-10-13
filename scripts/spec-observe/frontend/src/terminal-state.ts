// Pure presentation-state owner for the live terminal panel. One rule turns
// page eligibility, assignment display and the transport connection into the
// label/tone/message/retry/player contract so every browser boundary shares
// the same states. Reuses the shared assignment label vocabulary and the
// StatusText tone type; no DOM or transport concerns live here.
import { assignmentLabel } from './observation-format';
import type { StatusTone } from './primitives';

export type TerminalConnection = 'idle' | 'connecting' | 'open' | 'not-live' | 'not-running' | 'changed' | 'not-installed' | 'failed' | 'busy' | 'network';

export type TerminalPanelInput = {
  live: boolean;
  localOnly: boolean;
  hasToken: boolean;
  display?: string | null;
  connection: TerminalConnection;
  connectingDelayed: boolean;
};

export type TerminalPanelState = {
  label: 'Live' | 'Connecting…' | 'Ended' | 'Unavailable' | 'Not installed';
  tone: StatusTone;
  message: string;
  retry: boolean;
  player: boolean;
};

const HOST_LOCAL_MESSAGE = "The live terminal is available on the host's local dashboard.";
const TOKEN_MESSAGE = 'Reconnect to the live dashboard to open the terminal.';
const ENDED_MESSAGE = "This agent's terminal has ended.";
const ENDED_DISPLAYS = new Set(['ended', 'launch-failed', 'exited-unrecorded']);
const LIVE_DISPLAYS = new Set(['live', 'live-unrecorded']);
const RETRY_MESSAGES: Partial<Record<TerminalConnection, string>> = {
  failed: 'The terminal stream could not be started. Retry.',
  busy: 'Terminal streams are unavailable. Try again shortly.',
  'not-running': 'The terminal stream is not running. Retry.',
  network: 'The terminal stream could not be reached. Check the connection and retry.',
};

const unavailable = (message: string, retry = false): TerminalPanelState =>
  ({ label: 'Unavailable', tone: 'warning', message, retry, player: false });
const ended = (): TerminalPanelState =>
  ({ label: 'Ended', tone: 'neutral', message: ENDED_MESSAGE, retry: false, player: false });

export function terminalPanelState(input: TerminalPanelInput): TerminalPanelState {
  if (!input.live || input.localOnly) return unavailable(HOST_LOCAL_MESSAGE);
  if (!input.hasToken) return unavailable(TOKEN_MESSAGE);
  const display = input.display ?? undefined;
  if (display !== undefined && ENDED_DISPLAYS.has(display)) return ended();
  if (display !== undefined && !LIVE_DISPLAYS.has(display)) {
    return unavailable(`The terminal view opens while the session is live. ${assignmentLabel({ display })}`);
  }
  if (input.connection === 'not-installed') {
    return { label: 'Not installed', tone: 'warning', message: 'Install asciinema 3.x on the host to watch agent terminals here (see host setup).', retry: false, player: false };
  }
  if (input.connection === 'changed') {
    return unavailable('The terminal no longer belongs to this agent. Reconcile it with the locate command.');
  }
  if (input.connection === 'not-live') return ended();
  const retryMessage = RETRY_MESSAGES[input.connection];
  if (retryMessage !== undefined) return unavailable(retryMessage, true);
  if (input.connection === 'connecting' || input.connection === 'idle') {
    return { label: 'Connecting…', tone: 'neutral', message: input.connectingDelayed ? 'Connecting to the live terminal…' : '', retry: false, player: false };
  }
  return { label: 'Live', tone: 'success', message: 'Live terminal stream.', retry: false, player: true };
}
