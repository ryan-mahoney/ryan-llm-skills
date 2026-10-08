// Intercom's public channel contract; production native SDK composition is
// exercised separately. Routing addresses are assigned here, never by payloads.
export function controlBus() {
  const peers = new Map();
  const registrations = new Map();
  const attach = (id, registration) => {
    registrations.set(id, registration);
    peers.set(id, registration);
    registration.onReady({ snapshot: () => ({ connected: peers.has(id), supported: true }),
      publish: payload => {
        for (const peer of [...peers.values()]) peer.onEvent({ type: 'message', fromSessionId: id, payload });
      } });
    for (const [other, peer] of peers) if (other !== id) peer.onEvent({ type: 'session_joined', session: { id } });
  };
  return {
    events: id => ({ emit(name, value) { if (name === 'intercom:extension-register') attach(id, value); } }),
    extension: id => pi => pi.events.on('intercom:extension-register', value => attach(id, value)),
    disconnect(id) {
      peers.delete(id);
      registrations.get(id)?.onEvent({ type: 'connection', connected: false, supported: true });
      for (const peer of peers.values()) peer.onEvent({ type: 'session_left', sessionId: id });
    },
  };
}
