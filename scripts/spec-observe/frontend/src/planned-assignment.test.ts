// Run with: node --import tsx --test src/planned-assignment.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
// The legacy PlannedAssignment surface is retired; the brief bytes and canonical
// target helpers now live with spec-prompt and launch-handoff owners.
import { plannedBriefContent, plannedBriefTitle } from '../../../workspaces/spec-prompt.mjs';
import { plannedTargetChoices, plannedTargetLabel } from './launch-handoff';

test('prefills both package references and keeps the requested owner routing text', () => {
  const ref = '/workspace/specs/feature';
  assert.equal(plannedBriefTitle(ref), `Resume ${ref} through PR publication`);
  assert.equal(plannedBriefContent(ref), [
    `/spec-end-to-end Resume after spec-write for ${ref}.`,
    'Continue through PR publication.',
    '',
    'DEFAULT_OWNER: meta/muse-spark-1.3-contributor:xhigh from openrouter',
    'STRONG_OWNER: gpt-6.1-sol:medium from openai-codex',
    'EDITOR_AGENT: deepseek-flash:max from deepseek',
    'REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex',
    'SCOUT_AGENT: gpt-6-luna:low from openai-codex',
    'FINAL_REVIEWER: gpt-6.1-sol:xhigh from openai-codex',
    `PACKAGE: ${ref}`,
  ].join('\n'));
});

test('legacy planned surface keeps canonical target alias protection', () => {
  const alias = plannedTargetChoices([{ id: 'alias', primary: '/workspace/repos/real' }, { id: 'invalid', primary: '' }]);
  assert.deepEqual(alias, [{ key: 'alias\n/workspace/repos/real', id: 'alias', path: '/workspace/repos/real' }]);
  assert.equal(plannedTargetLabel(alias[0]), 'alias · /workspace/repos/real');
});
