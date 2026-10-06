import { randomUUID } from 'node:crypto';

const REGISTER = 'intercom:extension-register';
const IDENTITY = 'intercom:session-identity';
const MAX_BYTES = 12000;
const text = value => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_BYTES)
    throw new Error('Communication text must be non-empty and at most 12000 UTF-8 bytes.');
  return value;
};

// This adapter uses pi-intercom's extension channel only. It never injects a model
// turn or uses the conversational ask path (busy print sessions cannot answer it).
export function createCommunication(pi, record, role, { timeoutMs = 600000, readyTimeoutMs = 10000, onEvent: report = () => {} } = {}) {
  if (!['owner', 'editor'].includes(role)) throw new Error('Invalid communication role');
  const self = `spec-${role}-${record.id}`;
  const peer = `spec-${role === 'owner' ? 'editor' : 'owner'}-${record.id}`;
  let channel, closed = false, active, pending, asking;
  const waiters = new Set(), seen = new Set();
  const wake = () => { for (const fn of [...waiters]) fn(); };
  const remember = id => { seen.add(id); if (seen.size > 128) seen.delete(seen.values().next().value); };
  const envelope = (kind, detail) => ({ version: 1, run_id: record.id, kind, ...detail });
  const publish = (kind, detail) => {
    if (closed) throw new Error('Communication session closed');
    const snapshot = channel?.snapshot();
    if (!snapshot?.connected || !snapshot.supported) throw new Error('pi-intercom extension channel is unavailable');
    if (role === 'owner' && snapshot.owner?.sessionId !== self) throw new Error('This session is not the elected step owner');
    const payload = envelope(kind, detail);
    if (Buffer.byteLength(JSON.stringify(payload)) > 16000) throw new Error('Encoded communication payload exceeds the intercom channel limit');
    channel.publish(payload, role === 'editor' ? { audience: 'owner' } : { audience: 'capable', ownerOnly: true });
  };
  const clearPending = () => { if (pending) clearTimeout(pending.timer); pending = undefined; };
  const wait = (read, signal, ms) => new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { waiters.delete(check); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = error => { cleanup(); reject(error); };
    const abort = () => fail(new Error('Communication interrupted'));
    const check = () => {
      if (closed) return fail(new Error('Communication session closed'));
      try { const value = read(); if (value !== undefined) { cleanup(); resolve(value); } }
      catch (error) { fail(error); }
    };
    waiters.add(check);
    signal?.addEventListener('abort', abort, { once: true });
    if (ms) timer = setTimeout(() => fail(new Error('Communication deadline exceeded')), ms);
    if (signal?.aborted) abort(); else check();
  });
  const ready = signal => wait(() => {
    const snapshot = channel?.snapshot();
    return snapshot?.connected && snapshot.supported ? channel : undefined;
  }, signal, readyTimeoutMs);
  const onEvent = event => {
    if (event.type !== 'message') { wake(); return; }
    if (closed || event.fromSessionId !== peer) return;
    const p = event.payload;
    if (!p || p.version !== 1 || p.run_id !== record.id || typeof p.request_id !== 'string' || p.request_id.length > 128) return;
    if (role === 'owner' && p.kind === 'question') {
      if (!active || pending || seen.has(p.request_id) || !Number.isFinite(p.expires_at) || p.expires_at <= Date.now() || p.expires_at > Date.now() + timeoutMs + 1000) return;
      try { text(p.question); } catch { return; }
      remember(p.request_id);
      pending = { request_id: p.request_id, question: p.question, expires_at: p.expires_at };
      pending.timer = setTimeout(() => { clearPending(); wake(); }, Math.max(1, p.expires_at - Date.now()));
      wake();
    } else if (role === 'owner' && p.kind === 'cancel' && pending?.request_id === p.request_id) {
      clearPending(); wake();
    } else if (role === 'editor' && p.kind === 'answer' && asking?.request_id === p.request_id && !asking.answer && asking.expires_at > Date.now()) {
      if (event.owner && event.owner.sessionId !== peer) return;
      try { asking.answer = text(p.answer); } catch { return; }
      wake();
    }
  };
  const unsubscribe = pi.events.on(IDENTITY, request => { if (request?.version === 1) request.claim(self); });
  pi.on('session_start', () => pi.events.emit(REGISTER, {
    namespace: `spec-runtime/${record.id}`, ownerEligible: role === 'owner', onEvent,
    onReady: value => { channel = value; wake(); },
  }));
  const close = () => { closed = true; clearPending(); unsubscribe?.(); wake(); };
  pi.on('session_shutdown', close);
  const awaitEditor = signal => wait(() => {
    if (!active) throw new Error('No editor assignment is active');
    if (active.finished) { const result = active.result; active = undefined; clearPending(); return { kind: 'done', result }; }
    if (pending) return { kind: 'question', result: { state: 'needs_decision', request_id: pending.request_id, question: pending.question } };
    return undefined;
  }, signal).then(value => value.result);
  return {
    ready, close,
    async question(question, signal) {
      if (role !== 'editor') throw new Error('Only the editor asks step questions');
      if (asking) throw new Error('A question is already awaiting its owner');
      text(question);
      const request = { request_id: randomUUID(), question, expires_at: Date.now() + timeoutMs };
      const started = Date.now();
      asking = request;
      try {
        await ready(signal);
        request.expires_at = Date.now() + timeoutMs;
        publish('question', request);
        report('question_sent', { request_id: request.request_id });
        const answer = await wait(() => asking?.answer, signal, timeoutMs);
        report('question_answered', { request_id: request.request_id, duration_ms: Date.now() - started });
        return answer;
      } catch (error) {
        report('question_failed', { request_id: request.request_id, duration_ms: Date.now() - started,
          reason: signal?.aborted ? 'aborted' : /deadline/.test(error.message) ? 'timeout' : closed ? 'session_closed' : 'unavailable' });
        throw error;
      } finally {
        try { publish('cancel', { request_id: request.request_id }); } catch { /* lease/session may be shutting down */ }
        asking = undefined;
      }
    },
    async beginEditor(factory, signal) {
      if (role !== 'owner') throw new Error('Only the owner starts an editor assignment');
      if (active?.finished) return awaitEditor(signal);
      if (active) throw new Error('An editor assignment is already active; answer its pending question or await completion');
      if (closed) throw new Error('Communication session closed');
      active = { finished: false };
      const current = active;
      try {
        Promise.resolve(factory()).then(result => { current.finished = true; current.result = result; wake(); }, error => {
          current.finished = true; current.result = { error: error.message }; wake();
        });
      } catch (error) { active = undefined; throw error; }
      return awaitEditor(signal);
    },
    async answer(requestId, answer, signal) {
      if (role !== 'owner') throw new Error('Only the owner answers step questions');
      text(answer);
      if (!pending || pending.request_id !== requestId || pending.expires_at <= Date.now()) throw new Error('Question is stale, expired, or already answered');
      publish('answer', { request_id: requestId, answer });
      clearPending();
      return awaitEditor(signal);
    },
  };
}
