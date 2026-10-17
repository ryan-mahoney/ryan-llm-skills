// RED regression: native case1's genuine SDK tool-result error marker.
//
// The step 2 reviewer's `write` call is blocked by the role tool_call guard, so
// the SDK itself reports a failed tool outcome. This test pins the observation
// of that genuine SDK error marker and its survival across the provider wire:
//
//   1. `runToolCall` from the installed @earendil-works/pi-agent-core is
//      invoked for an unknown `write` with tools:[] and must return
//      isError true plus the SDK's error text. The marker is produced by the
//      SDK, never inferred from message text.
//   2. A generated loopback extension (writeLoopbackExtension) registers the
//      loopback provider and an event handler. A context handler must exist —
//      this assertion fails at baseline because the generated extension
//      registers no context observer yet.
//   3. The context handler receives a genuine role:'toolResult' message built
//      from the actual runToolCall outcome; the provider's HTTP completion
//      route is then POSTed with the wire role:'tool' body (no fabricated
//      flag) and the captured SDK messages must carry that exact result with
//      isError true while the wire body stays a plain OpenAI tool message.
//   4. A non-error control keeps isError false: the flag is carried by the SDK
//      message, not manufactured by the transport.
//
// The test is RED by construction until the native context observer exists;
// it deliberately contains no implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startLoopbackProvider, writeLoopbackExtension } from './wave-native-provider.mjs';

const TEST_TIMEOUT_MS = 30000;
const CALL_ID = 'unknown-write';

// Local copy of the driver's SDK resolution (wave-native-driver.mjs declares
// resolveSdkRoot without exporting it). Same order: SPEC_PI_SDK wins, otherwise
// the normal package layout three directories above the real `pi` binary, then
// the managed release named by current-version.
function resolveSdkRoot(env) {
  const fromEnv = env?.SPEC_PI_SDK;
  if (fromEnv && existsSync(join(fromEnv, 'dist', 'index.js'))) return fromEnv;
  const bin = execFileSync('which', ['pi'], { encoding: 'utf8', env }).trim();
  const realBin = realpathSync(bin);
  const normal = dirname(dirname(dirname(realBin)));
  if (existsSync(join(normal, 'dist', 'index.js'))) return normal;
  const agentRoot = dirname(dirname(realBin));
  const version = readFileSync(join(agentRoot, 'install', 'current-version'), 'utf8').trim();
  if (!/^(?!\.\.?$)[^/\\]+$/.test(version)) throw new Error(`wave-native-tool-result: invalid current-version ${JSON.stringify(version)}`);
  return join(agentRoot, 'install', 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
}

// @earendil-works/pi-agent-core sits beside pi-coding-agent in the same install.
async function loadRunToolCall() {
  const sdkRoot = resolveSdkRoot(process.env);
  const agentLoop = join(dirname(sdkRoot), 'pi-agent-core', 'dist', 'agent-loop.js');
  if (!existsSync(agentLoop)) throw new Error(`wave-native-tool-result: missing agent-loop at ${agentLoop}`);
  const mod = await import(pathToFileURL(agentLoop).href);
  if (typeof mod.runToolCall !== 'function') throw new Error('wave-native-tool-result: pi-agent-core does not export runToolCall');
  return mod.runToolCall;
}

function assistantMessage(toolName, args) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: CALL_ID, name: toolName, arguments: args }],
  };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  if (content && typeof content.text === 'string') return content.text;
  if (content == null) return '';
  return JSON.stringify(content);
}

// Captures the generated extension's registrations without changing behavior:
// the mock pi records providers and every event handler so the test can invoke
// the context observer directly. Handlers are stored by event name and must not
// mutate the context handed to them.
function mockPi() {
  const providers = [];
  const handlers = new Map();
  const pi = {
    registerProvider(name, config) { providers.push({ name, config }); },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  };
  return { pi, providers, handlers, handler: event => handlers.get(event)?.at(-1) };
}

async function postCompletion(port, role, recordPath, body) {
  const url = `http://127.0.0.1:${port}/v1/${encodeURIComponent(role)}/${encodeURIComponent(recordPath)}/${process.pid}/chat/completions`;
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, raw };
}

function step2ReviewingRecord() {
  return {
    wave_id: 'wave-native-tool-result',
    wave_bindings: { wave_id: 'wave-native-tool-result', phase: 'reviewing', step_number: 2 },
  };
}

test('wave native: genuine SDK tool error marker is observed by the native context handler alongside provider serialization', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave-native-tool-result-'));
  const provider = await startLoopbackProvider({ script: { case: 'tool-result', defectStep: 2 } });
  try {
    const runToolCall = await loadRunToolCall();

    // 1. Genuine SDK error outcome: unknown `write` with no tools registered.
    const message = assistantMessage('write', { path: 'src/hack.txt', content: 'hack\n' });
    const actual = await runToolCall(message.content[0], { tools: [], context: { tools: [] }, assistantMessage: message });
    assert.equal(actual.isError, true, 'unknown write must be a genuine SDK error outcome');
    assert.notEqual(resultText(actual.result?.content ?? actual.result), '', 'SDK error outcome must carry error text');

    // 2. Generated loopback extension: provider registration plus a context handler.
    //    The observer writes a sidecar for the route record path and this pid, so
    //    the extension must be registered while that identity is in scope.
    const extensionPath = writeLoopbackExtension(dir, provider.port);
    const priorRole = process.env.SPEC_RUNTIME_ROLE;
    const priorRecord = process.env.SPEC_RUNTIME_RECORD;
    process.env.SPEC_RUNTIME_ROLE = 'reviewer';
    const recordPath = join(dir, 'reviewing-step-02.json');
    writeFileSync(recordPath, JSON.stringify(step2ReviewingRecord(), null, 2));
    process.env.SPEC_RUNTIME_RECORD = recordPath;
    const { pi, providers, handler } = mockPi();
    try {
      const extension = await import(pathToFileURL(extensionPath).href);
      await extension.default(pi);
      assert.equal(providers.length, 1, 'generated extension must register the loopback provider');

      const contextHandler = handler('context');
      assert.equal(typeof contextHandler, 'function', 'native extension must register a context handler that observes tool results');
    } finally {
      if (priorRole === undefined) delete process.env.SPEC_RUNTIME_ROLE;
      else process.env.SPEC_RUNTIME_ROLE = priorRole;
      if (priorRecord === undefined) delete process.env.SPEC_RUNTIME_RECORD;
      else process.env.SPEC_RUNTIME_RECORD = priorRecord;
    }
    assert.equal(process.env.SPEC_RUNTIME_ROLE, priorRole, 'generated extension registration restores SPEC_RUNTIME_ROLE to its prior value');
    assert.equal(process.env.SPEC_RUNTIME_RECORD, priorRecord, 'generated extension registration restores SPEC_RUNTIME_RECORD to its prior value');
    assert.equal('SPEC_RUNTIME_ROLE' in process.env, priorRole !== undefined, 'generated extension registration restores SPEC_RUNTIME_ROLE presence');
    assert.equal('SPEC_RUNTIME_RECORD' in process.env, priorRecord !== undefined, 'generated extension registration restores SPEC_RUNTIME_RECORD presence');

    // 3. The observer must not mutate the context it receives. The non-error
    //    control is part of the observed messages before the handler runs, so
    //    the captured SDK messages carry both outcomes from one observation.
    const controlMessage = {
      role: 'toolResult',
      toolCallId: 'allowed-read',
      toolName: 'read',
      content: 'src/step-02.txt',
      isError: false,
    };
    const contextSnapshot = {
      messages: [
        { role: 'user', content: 'REVIEW: wave implementation' },
        message,
        { role: 'toolResult', toolCallId: CALL_ID, toolName: 'write', content: actual.result?.content ?? actual.result, isError: actual.isError },
        controlMessage,
      ],
    };
    const before = JSON.stringify(contextSnapshot);
    const observed = await handler('context')(contextSnapshot, undefined);
    assert.equal(JSON.stringify(contextSnapshot), before, 'context handler must not modify its context');
    assert.equal(observed, undefined, 'context handler must behave as a pure observer');

    // 4. Provider wire round trip: the SDK result travels as a plain OpenAI
    //    tool message and the captured SDK messages keep the genuine marker.
    const wireBody = {
      model: 'scripted',
      messages: [
        { role: 'user', content: 'REVIEW: wave implementation' },
        { role: 'assistant', content: '', tool_calls: [{ id: CALL_ID, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'src/hack.txt', content: 'hack\n' }) } }] },
        { role: 'tool', tool_call_id: CALL_ID, content: resultText(actual.result?.content ?? actual.result) },
      ],
    };
    const reply = await postCompletion(provider.port, 'reviewer', recordPath, wireBody);
    assert.equal(reply.status, 200);

    const wireToolMessage = wireBody.messages[2];
    assert.equal(wireToolMessage.role, 'tool');
    assert.equal(wireToolMessage.tool_call_id, CALL_ID);
    assert.equal('isError' in wireToolMessage, false, 'wire body must not fabricate the isError flag');
    assert.equal('is_error' in wireToolMessage, false, 'wire body must not fabricate an is_error flag');

    const request = provider.requests[0];
    assert.ok(request, 'provider must capture the completion request');
    const sdkMessages = request.sdkMessages;
    assert.ok(Array.isArray(sdkMessages), 'captured request must expose sdkMessages');

    const sdkResult = sdkMessages.find(entry => entry?.role === 'toolResult' && entry?.toolCallId === CALL_ID);
    assert.ok(sdkResult, 'captured SDK messages must contain the exact SDK tool result');
    assert.equal(sdkResult.toolName, 'write');
    assert.equal(sdkResult.isError, true, 'the genuine SDK error marker must survive into the captured SDK messages');
    assert.deepEqual(sdkResult.content, JSON.parse(JSON.stringify(contextSnapshot.messages[2].content)),
      'captured SDK result content must match the SDK outcome (JSON round trip)');

    // 5. Non-error control: isError false stays false rather than being inferred.
    const controlSdkResult = sdkMessages.find(entry => entry?.role === 'toolResult' && entry?.toolCallId === 'allowed-read');
    assert.ok(controlSdkResult, 'captured SDK messages must contain the non-error control result');
    assert.equal(controlSdkResult.isError, false, 'a non-error tool result must stay isError false');
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
