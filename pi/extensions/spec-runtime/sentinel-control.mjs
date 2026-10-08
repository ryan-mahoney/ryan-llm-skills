import { randomUUID } from 'node:crypto';
import { parseSentinelStart } from './sentinel-options.mjs';

// Native intercom extension traffic: no transcript messages, prompting or file
// polling. Every coordinator participates, regardless of its working directory.
export const SENTINEL_CHANNEL = 'spec-sentinel/v1';
export function createSentinelControl(events, { onChange = () => {}, onReport = () => {} } = {}) {
  let channel, current = null, owned = null, closed = false;
  const revoked = new Set();
  const change = next => {
    if (current?.token === next?.token) return;
    current = next;
    onChange(next);
  };
  const ready = () => !closed && channel?.snapshot().connected && channel.snapshot().supported;
  const publish = payload => { if (ready()) channel.publish(payload, { audience: 'capable' }); };
  const announce = () => { if (owned) publish({ type: 'start', ...owned }); };
  const stop = () => {
    if (owned) publish({ type: 'stop', token: owned.token });
    else if (current) publish({ type: 'stop-request', token: current.token });
    if (current) revoked.add(current.token);
    owned = null;
    change(null);
  };
  const receive = event => {
    if (closed) return;
    if (event.type === 'connection' && (!event.connected || !event.supported)) {
      owned = null;
      change(null);
    } else if (event.type === 'connection' && event.connected && event.supported) {
      publish({ type: 'hello', token: randomUUID() });
    } else if (event.type === 'session_left' && event.sessionId === current?.controller) {
      change(null);
    } else if (event.type === 'session_joined') {
      announce();
    } else if (event.type === 'message') {
      const value = event.payload;
      if (!value || typeof value.token !== 'string' || value.token.length > 128) return;
      if (value.type === 'start' && !revoked.has(value.token)) {
        // Require the exact public options, with no injected workflow identity.
        let options;
        try {
          options = parseSentinelStart(`${value.options?.mode} --model ${value.options?.model}`);
          if (!['shadow', 'recover'].includes(options.mode)) return;
        } catch { return; }
        if (current?.token === value.token) return;
        if (current) revoked.add(current.token);
        // A newer explicit controller replaces this session's old controller.
        if (owned && owned.token !== value.token) owned = null;
        change({ token: value.token, controller: event.fromSessionId, options });
      } else if (value.type === 'stop' && current?.token === value.token && event.fromSessionId === current.controller) {
        revoked.add(value.token);
        change(null);
      } else if (value.type === 'stop-request' && owned?.token === value.token) {
        stop();
      } else if (value.type === 'report' && owned?.token === value.token) {
        onReport(value.report, event.fromSessionId);
      }
    }
  };
  return {
    register() {
      events.emit('intercom:extension-register', { namespace: SENTINEL_CHANNEL, ownerEligible: false,
        onReady: value => { if (!closed) { channel = value; publish({ type: 'hello', token: randomUUID() }); } },
        onEvent: event => {
          if (event.type === 'message' && event.payload?.type === 'hello') announce();
          else receive(event);
        } });
    },
    start(options) {
      if (!ready()) throw new Error('Global sentinel modes require a connected pi-intercom extension with extension-channel support. Observe mode remains available.');
      stop();
      owned = { token: randomUUID(), options };
      announce();
      return { mode: options.mode, model: options.model, scope: 'all connected sentinel coordinators' };
    },
    current: () => current,
    report(report) { if (current) publish({ type: 'report', token: current.token, report }); },
    stop,
    close() {
      // A participating worker closing does not stop the global controller.
      if (owned) publish({ type: 'stop', token: owned.token });
      owned = null;
      change(null);
      closed = true;
    },
  };
}
