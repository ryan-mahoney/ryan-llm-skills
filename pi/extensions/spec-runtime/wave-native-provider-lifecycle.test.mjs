// Regression for the reviewer completion-loop fixture defect.
//
// The loopback provider is exercised over its real HTTP POST SSE route
// (/v1/reviewer/<encoded record path>/<pid>/chat/completions) rather than by
// calling the reply function directly, so the assertions observe the wire
// protocol a real Pi reviewer session sees.
//
// A reviewer session asks for its reply repeatedly. The first request carries
// no assistant messages (turn 0); every later request carries the assistant
// tool call plus its tool result. The fixture must submit spec_stage_complete
// at most once per reviewing/confirming record: after the completion call the
// next turn has to be terminal text, otherwise the reviewer transcript keeps a
// completion tool call in flight and the session loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLoopbackProvider } from './wave-native-provider.mjs';

const TEST_TIMEOUT_MS = 30000;
const COMPLETION_TOOL = 'spec_stage_complete';

function completeSse(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') continue;
    events.push(JSON.parse(payload));
  }
  const toolCalls = [];
  let text = '';
  let finishReason = null;
  for (const event of events) {
    for (const choice of event.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content !== '') text += delta.content;
      for (const call of delta.tool_calls ?? []) {
        const index = Number.isInteger(call.index) ? call.index : toolCalls.length;
        if (!toolCalls[index]) toolCalls[index] = { type: 'function', function: { name: '', arguments: '' } };
        if (call.type) toolCalls[index].type = call.type;
        if (call.function?.name) toolCalls[index].function.name += call.function.name;
        if (call.function?.arguments) toolCalls[index].function.arguments += call.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  const calls = toolCalls.filter(Boolean).map(call => ({
    type: call.type ?? 'function',
    name: call.function.name,
    arguments: call.function.arguments === '' ? null : JSON.parse(call.function.arguments),
  }));
  return { text, toolCalls: calls, finishReason };
}

async function postCompletion(port, role, recordPath, body) {
  const url = `http://127.0.0.1:${port}/v1/${encodeURIComponent(role)}/${encodeURIComponent(recordPath)}/${process.pid}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', ...completeSse(raw) };
}

function record(phase, stepNumber) {
  return {
    wave_id: `wave-native-provider-lifecycle-${phase}-${stepNumber}`,
    wave_bindings: { wave_id: `wave-native-provider-lifecycle-${phase}-${stepNumber}`, phase, step_number: stepNumber },
  };
}

function completionCalls(reply) {
  return reply.toolCalls.filter(call => call.name === COMPLETION_TOOL);
}

function turnZeroMessages(prompt) {
  return [{ role: 'user', content: prompt }];
}

function turnOneMessages(prompt, call, resultText) {
  return [
    { role: 'user', content: prompt },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
    { role: 'tool', tool_call_id: 'call_0', content: resultText },
  ];
}

function turnTwoMessages(prompt, call0, call1) {
  return [
    { role: 'user', content: prompt },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: call0.name, arguments: JSON.stringify(call0.arguments) } }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'wave-loopback: write path is not allowed' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: call1.name, arguments: JSON.stringify(call1.arguments) } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ];
}

async function withProvider(script, run) {
  const dir = mkdtempSync(join(tmpdir(), 'wave-native-provider-lifecycle-'));
  const provider = await startLoopbackProvider({ script });
  try {
    await run({ provider, dir });
  } finally {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRecord(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

test('wave native provider lifecycle: reviewing reviewer submits completion once then goes terminal', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withProvider({ case: 'provider-lifecycle-reviewing' }, async ({ provider, dir }) => {
    const recordPath = writeRecord(dir, 'reviewing.json', record('reviewing', 3));
    const prompt = 'REVIEW: wave implementation head=0123456789abcdef0123456789abcdef01234567';

    const first = await postCompletion(provider.port, 'reviewer', recordPath, { messages: turnZeroMessages(prompt) });
    assert.equal(first.status, 200);
    assert.match(first.contentType, /text\/event-stream/);
    const firstCompletions = completionCalls(first);
    assert.equal(firstCompletions.length, 1, 'reviewing record must submit spec_stage_complete on the first request');

    const second = await postCompletion(provider.port, 'reviewer', recordPath, {
      messages: turnOneMessages(prompt, firstCompletions[0], 'ok'),
    });
    assert.equal(second.status, 200);
    assert.equal(second.toolCalls.length, 0, 'reviewing reviewer must not call tools again after submitting completion');
    assert.equal(second.finishReason, 'stop');
    assert.notEqual(second.text.trim(), '', 'reviewing reviewer must return terminal text after submitting completion');
  });
});

test('wave native provider lifecycle: confirming reviewer submits completion once then goes terminal', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withProvider({ case: 'provider-lifecycle-confirming' }, async ({ provider, dir }) => {
    const recordPath = writeRecord(dir, 'confirming.json', record('confirming', 2));
    const prompt = 'CONFIRM: decide the fixed decision in src/step-02.txt';

    const first = await postCompletion(provider.port, 'reviewer', recordPath, { messages: turnZeroMessages(prompt) });
    assert.equal(first.status, 200);
    const firstCompletions = completionCalls(first);
    assert.equal(firstCompletions.length, 1, 'confirming record must submit spec_stage_complete on the first request');

    const second = await postCompletion(provider.port, 'reviewer', recordPath, {
      messages: turnOneMessages(prompt, firstCompletions[0], 'ok'),
    });
    assert.equal(second.status, 200);
    assert.equal(second.toolCalls.length, 0, 'confirming reviewer must not call tools again after submitting completion');
    assert.equal(second.finishReason, 'stop');
    assert.notEqual(second.text.trim(), '', 'confirming reviewer must return terminal text after submitting completion');
  });
});

test('wave native provider lifecycle: reviewing reviewer keeps its write, completion and terminal order', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withProvider({ case: 'provider-lifecycle-defect', defectStep: 2 }, async ({ provider, dir }) => {
    const recordPath = writeRecord(dir, 'step-02.json', record('reviewing', 2));
    const prompt = 'REVIEW: wave implementation head=0123456789abcdef0123456789abcdef01234567';

    const turn0 = await postCompletion(provider.port, 'reviewer', recordPath, { messages: turnZeroMessages(prompt) });
    assert.equal(turn0.status, 200);
    assert.equal(turn0.toolCalls.length, 1);
    assert.equal(turn0.toolCalls[0].name, 'write', 'the defect reviewer must write a file at turn 0');
    assert.equal(completionCalls(turn0).length, 0, 'the defect reviewer must not submit completion at turn 0');

    const turn1 = await postCompletion(provider.port, 'reviewer', recordPath, {
      messages: turnOneMessages(prompt, turn0.toolCalls[0], 'wave-loopback: write path is not allowed'),
    });
    assert.equal(turn1.status, 200);
    assert.equal(turn1.toolCalls.length, 1);
    const turn1Completions = completionCalls(turn1);
    assert.equal(turn1Completions.length, 1, 'the defect reviewer must submit completion at turn 1');
    assert.equal(turn1Completions[0].arguments.verdict, 'needs-fix');

    const turn2 = await postCompletion(provider.port, 'reviewer', recordPath, {
      messages: turnTwoMessages(prompt, turn0.toolCalls[0], turn1Completions[0]),
    });
    assert.equal(turn2.status, 200);
    assert.equal(turn2.toolCalls.length, 0, 'the defect reviewer must not call tools after submitting completion');
    assert.equal(turn2.finishReason, 'stop');
    assert.notEqual(turn2.text.trim(), '', 'the defect reviewer must return terminal text at turn 2');
  });
});
