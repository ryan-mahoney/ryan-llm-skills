// Step 5 focused cases for the terminal presentation-state owner and the
// allowlisted terminal failure metadata in api.ts. State cases call the pure
// rule directly; the HTTP case scopes a fake fetch that returns real Response
// objects so the real postJson/readJson decoding runs, then restores the
// previous fetch. No case uses timers, sleeps or HTTP.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, postJson } from './api';
import { terminalPanelState, type TerminalPanelInput } from './terminal-state';

const TOKEN = 'test-action-token';
const ASSIGNMENT_ID = '22222222-2222-4222-8222-222222222222';

type FetchScope = { after: (callback: () => void) => void };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function scopeFetch(t: FetchScope, responses: Response[]): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
}

const panel = (overrides: Partial<TerminalPanelInput> = {}) =>
  terminalPanelState({ live: true, localOnly: false, hasToken: true, display: 'live', connection: 'open', connectingDelayed: false, ...overrides });

test('host-local, local-only and tokenless panels hide the player even for an open connection', () => {
  const hostLocal = panel({ live: false });
  assert.equal(hostLocal.label, 'Unavailable');
  assert.equal(hostLocal.tone, 'warning');
  assert.equal(hostLocal.message, "The live terminal is available on the host's local dashboard.");
  assert.equal(hostLocal.retry, false);
  assert.equal(hostLocal.player, false);
  assert.deepEqual(panel({ localOnly: true }), hostLocal);
  const tokenless = panel({ hasToken: false });
  assert.equal(tokenless.label, 'Unavailable');
  assert.equal(tokenless.tone, 'warning');
  assert.equal(tokenless.message, 'Reconnect to the live dashboard to open the terminal.');
  assert.equal(tokenless.retry, false);
  assert.equal(tokenless.player, false);
});

test('ended displays end the panel while live-unrecorded follows the connection', () => {
  for (const display of ['ended', 'launch-failed', 'exited-unrecorded']) {
    const state = panel({ display });
    assert.equal(state.label, 'Ended', display);
    assert.equal(state.tone, 'neutral', display);
    assert.equal(state.message, "This agent's terminal has ended.", display);
    assert.equal(state.retry, false, display);
    assert.equal(state.player, false, display);
  }
  assert.equal(panel({ display: 'live-unrecorded' }).label, 'Live');
  const connecting = panel({ display: 'live-unrecorded', connection: 'connecting' });
  assert.equal(connecting.label, 'Connecting…');
  assert.equal(connecting.player, false);
});

test('a non-live display appends the shared assignment label', () => {
  const unknown = panel({ display: 'unknown' });
  assert.equal(unknown.label, 'Unavailable');
  assert.equal(unknown.tone, 'warning');
  assert.equal(unknown.player, false);
  assert.equal(unknown.message, 'The terminal view opens while the session is live. Unknown');
  assert.equal(panel({ display: 'launching' }).message, 'The terminal view opens while the session is live. Launching');
  assert.equal(panel({ display: 'terminal-lost' }).message, 'The terminal view opens while the session is live. Terminal lost');
  assert.equal(panel({ display: null }).label, 'Live');
});

test('the connecting explanation appears only after the delayed flag', () => {
  for (const connection of ['connecting', 'idle'] as const) {
    const early = panel({ connection, connectingDelayed: false });
    assert.equal(early.label, 'Connecting…');
    assert.equal(early.tone, 'neutral');
    assert.equal(early.message, '');
    assert.equal(early.retry, false);
    assert.equal(early.player, false);
    const delayed = panel({ connection, connectingDelayed: true });
    assert.equal(delayed.label, 'Connecting…');
    assert.equal(delayed.message, 'Connecting to the live terminal…');
  }
});

test('retryable stream failures, changed, missing binary and not-live keep distinct recovery copy', () => {
  const retryable = [
    ['failed', 'The terminal stream could not be started. Retry.'],
    ['busy', 'Terminal streams are unavailable. Try again shortly.'],
    ['not-running', 'The terminal stream is not running. Retry.'],
    ['network', 'The terminal stream could not be reached. Check the connection and retry.'],
  ] as const;
  for (const [connection, message] of retryable) {
    const state = panel({ connection });
    assert.equal(state.label, 'Unavailable', connection);
    assert.equal(state.tone, 'warning', connection);
    assert.equal(state.message, message, connection);
    assert.equal(state.retry, true, connection);
    assert.equal(state.player, false, connection);
  }
  const changed = panel({ connection: 'changed' });
  assert.equal(changed.label, 'Unavailable');
  assert.equal(changed.tone, 'warning');
  assert.equal(changed.message, 'The terminal no longer belongs to this agent. Reconcile it with the locate command.');
  assert.equal(changed.retry, false);
  assert.equal(changed.player, false);
  const missing = panel({ connection: 'not-installed' });
  assert.equal(missing.label, 'Not installed');
  assert.equal(missing.tone, 'warning');
  assert.equal(missing.message, 'Install asciinema 3.x on the host to watch agent terminals here (see host setup).');
  assert.equal(missing.retry, false);
  assert.equal(missing.player, false);
  const notLive = panel({ connection: 'not-live' });
  assert.equal(notLive.label, 'Ended');
  assert.equal(notLive.tone, 'neutral');
  assert.equal(notLive.message, "This agent's terminal has ended.");
  assert.equal(notLive.retry, false);
  assert.equal(notLive.player, false);
});

test('an open connection presents the live player', () => {
  assert.deepEqual(panel(), { label: 'Live', tone: 'success', message: 'Live terminal stream.', retry: false, player: true });
});

test('postJson preserves only allowlisted terminal state with existing refusal metadata', async (t) => {
  const allowlisted = ['not-live', 'changed', 'not-installed', 'failed', 'busy', 'not-running'];
  scopeFetch(t, [
    ...allowlisted.map(state => jsonResponse(503, { error: 'Terminal unavailable.', reason: 'service-unavailable', assignment_id: ASSIGNMENT_ID, state })),
    jsonResponse(503, { error: 'Terminal unavailable.', reason: 'service-unavailable', assignment_id: ASSIGNMENT_ID, state: 'network' }),
    jsonResponse(503, { error: 'Terminal unavailable.', reason: 'service-unavailable', assignment_id: ASSIGNMENT_ID, state: 'made-up-state' }),
    jsonResponse(503, { error: 'Terminal unavailable.' }),
  ]);
  const errors: HttpError[] = [];
  for (let index = 0; index < allowlisted.length + 3; index += 1) {
    await assert.rejects(postJson('/api/assignment-terminal/open', { assignment_id: ASSIGNMENT_ID }, TOKEN), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      errors.push(error);
      return true;
    });
  }
  assert.deepEqual(errors.slice(0, allowlisted.length).map(error => error.terminalState), allowlisted);
  for (const error of errors.slice(0, allowlisted.length)) {
    assert.equal(error.status, 503);
    assert.equal(error.reason, 'service-unavailable');
    assert.equal(error.assignmentId, ASSIGNMENT_ID);
  }
  assert.deepEqual(errors.slice(allowlisted.length).map(error => error.terminalState), [undefined, undefined, undefined]);
  assert.equal(errors[6].reason, 'service-unavailable');
  assert.equal(errors[6].assignmentId, ASSIGNMENT_ID);
  assert.equal(errors[7].reason, 'service-unavailable');
  assert.equal(errors[7].assignmentId, ASSIGNMENT_ID);
  assert.equal(errors[8].reason, undefined);
  assert.equal(errors[8].assignmentId, undefined);
  assert.equal(errors[8].message, 'Terminal unavailable.');
});
