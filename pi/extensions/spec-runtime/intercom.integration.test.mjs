import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createCommunication } from './communication.mjs';

const packageDir = process.env.SPEC_INTERCOM_PACKAGE || join(homedir(), '.pi/agent/npm/node_modules/pi-intercom');
const available = existsSync(join(packageDir, 'package.json'));

// Real broker/client transport, with only the Pi extension event-bus facade supplied
// here. This complements the SDK extension-load smoke without invoking any model.
test('isolated intercom transport yields an owner decision and resumes the same editor within its scope',
  { skip: available ? false : 'Install the pinned pi-intercom runtime dependency first', timeout: 15000 }, async t => {
    assert.equal(JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version, '0.16.1');
    const require = createRequire(join(packageDir, 'package.json'));
    const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api').replace(/\.cjs$/, '.mjs')).href);
    const unregister = register();
    const { IntercomClient } = await import(pathToFileURL(join(packageDir, 'broker/client.ts')).href);
    // A short explicit /tmp path avoids Unix socket path limits on macOS.
    const agentDir = mkdtempSync('/tmp/spec-intercom-');
    const keys = ['PI_CODING_AGENT_DIR', 'PI_INTERCOM_SCOPE_ID'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const broker = spawn(process.execPath, [require.resolve('tsx/cli'), join(packageDir, 'broker/broker.ts')], {
      cwd: packageDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise(resolve => broker.once('exit', (code, signal) => resolve({ code, signal })));
    const clients = [], adapters = [];
    let stderr = '';
    broker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    t.after(async () => {
      for (const adapter of adapters) adapter.close();
      await Promise.allSettled(clients.map(client => client.disconnect()));
      if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGTERM');
      const escalation = setTimeout(() => broker.kill('SIGKILL'), 1000);
      await exited;
      clearTimeout(escalation);
      for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      unregister();
      rmSync(agentDir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Isolated broker startup timed out: ${stderr}`)), 5000);
      broker.stdout.on('data', chunk => { if (chunk.toString().includes('Intercom broker started')) { clearTimeout(timer); resolve(); } });
      broker.once('error', error => { clearTimeout(timer); reject(error); });
      exited.then(value => { clearTimeout(timer); reject(new Error(`Isolated broker exited: ${JSON.stringify(value)} ${stderr}`)); });
    });
    const run = randomUUID();
    async function peer(role, scope = run) {
      const client = new IntercomClient(); clients.push(client);
      client.on('error', () => {});
      const hooks = new Map(), bus = new EventEmitter();
      let registration, owner;
      const ownerKnown = new Promise(resolve => {
        client.onBrokerMessage(message => {
          if (message.type === 'extension_owner') {
            owner = message.ownerId ? { sessionId: message.ownerId, epoch: message.ownerEpoch } : undefined;
            registration?.onEvent({ type: 'owner', owner });
            if (owner) resolve();
          } else if (message.type === 'extension_message') registration?.onEvent({
            type: 'message', fromSessionId: message.fromSessionId, payload: message.payload,
            ...(message.ownerId ? { owner: { sessionId: message.ownerId, epoch: message.ownerEpoch } } : {}),
          });
        });
      });
      const pi = { events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name, payload) => bus.emit(name, payload) },
        on(name, handler) { hooks.set(name, handler); } };
      bus.on('intercom:extension-register', value => { registration = value; });
      const adapter = createCommunication(pi, { id: run }, role, { timeoutMs: 3000, readyTimeoutMs: 3000 }); adapters.push(adapter);
      let identity;
      bus.emit('intercom:session-identity', { version: 1, claim(value) { identity = value; } });
      hooks.get('session_start')();
      process.env.PI_INTERCOM_SCOPE_ID = scope;
      await client.connect({ cwd: agentDir, model: 'no-model', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(),
        extensions: [{ namespace: registration.namespace, ownerEligible: registration.ownerEligible }] }, identity);
      registration.onReady({ snapshot: () => ({ connected: client.isConnected(), supported: client.supportsFeature('extension-bus-v1'), owner }),
        publish(payload, options) { client.sendExtensionMessage({ type: 'extension_publish', namespace: registration.namespace,
          audience: options.audience, ...(options.ownerOnly ? { ownerOnly: true, ownerEpoch: owner?.epoch } : {}), payload }); } });
      await ownerKnown;
      return { adapter, client, identity };
    }
    const owner = await peer('owner');
    const editor = await peer('editor');
    // Same stable identity and namespace in a different routing scope cannot steal ownership.
    const unrelated = await peer('owner', `${run}-unrelated`);
    assert.deepEqual((await owner.client.listSessions()).map(item => item.id).sort(), [owner.identity, editor.identity].sort());
    assert.equal((await unrelated.client.listSessions()).length, 1);
    let factoryCalls = 0;
    let editorAnswer;
    const yielded = await owner.adapter.beginEditor(async () => {
      factoryCalls++;
      editorAnswer = await editor.adapter.question('Keep the existing public behavior?');
      return { result: 'same editor completed' };
    });
    assert.equal(yielded.state, 'needs_decision');
    assert.equal(yielded.question, 'Keep the existing public behavior?');
    const completed = await owner.adapter.answer(yielded.request_id, 'Yes, preserve the public behavior.');
    assert.equal(editorAnswer, 'Yes, preserve the public behavior.');
    assert.deepEqual(completed, { result: 'same editor completed' });
    assert.equal(factoryCalls, 1);
  });
