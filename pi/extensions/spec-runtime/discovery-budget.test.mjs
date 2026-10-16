import test from 'node:test';
import assert from 'node:assert/strict';
import { installDiscoveryBudget } from './discovery-budget.mjs';

test('editor checkpoints excessive exploration and resumes after an owner answer or successful edit', () => {
  const handlers = {}, events = [];
  let time = 0;
  installDiscoveryBudget({ on: (name, fn) => { handlers[name] = fn; } }, { limit: 2, maxMs: 100, now: () => time, report: (...args) => events.push(args) });
  const call = toolName => handlers.tool_call({ toolName });
  assert.equal(call('read'), undefined);
  assert.equal(call('grep'), undefined);
  assert.equal(call('read').block, true);
  assert.equal(call('bash').block, true, 'shell cannot bypass the checkpoint');
  assert.equal(events.length, 1);
  assert.equal(call('spec_question'), undefined, 'same-process owner question remains available');
  handlers.tool_result({ toolName: 'spec_question', isError: true });
  assert.equal(call('find').block, true);
  handlers.tool_result({ toolName: 'spec_question', isError: false });
  assert.equal(call('read'), undefined);
  time = 101;
  assert.equal(call('grep').block, true, 'elapsed discovery also checkpoints a slow provider');
  assert.equal(call('edit'), undefined, 'known edit can proceed');
  handlers.tool_result({ toolName: 'edit', isError: true });
  assert.equal(call('read').block, true);
  handlers.tool_result({ toolName: 'edit', isError: false });
  assert.equal(call('read'), undefined);
});

test('compaction grants a fresh allowance to re-read edit anchors', () => {
  const handlers = {};
  let time = 0;
  installDiscoveryBudget({ on: (name, fn) => { handlers[name] = fn; } }, { limit: 2, maxMs: 100, now: () => time });
  const call = toolName => handlers.tool_call({ toolName });
  call('read'); call('read');
  assert.equal(call('read').block, true);
  time = 50;
  handlers.session_compact({});
  assert.equal(call('read'), undefined, 'anchors dropped by compaction can be read again');
  assert.equal(call('read'), undefined);
  assert.equal(call('read').block, true, 'the fresh allowance is still bounded');
});
