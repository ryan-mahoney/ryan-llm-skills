// Run with: node --import tsx --test src/planned-assignment.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedBriefContent, plannedBriefTitle, plannedTargetChoices } from './planned-assignment';

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

test('keeps canonical package target paths when their aliases differ from repository ids', () => {
  const choices = plannedTargetChoices([
    { id: 'main', primary: '/home/operator/Documents/app', worktree: '/home/operator/worktrees/app-feature' },
    { id: 'alternate', primary: '/home/operator/Documents/docs' },
    { id: 'invalid', primary: '' },
    { id: 'main', primary: '/home/operator/Documents/app', worktree: '/home/operator/worktrees/app-feature' },
  ]);

  assert.deepEqual(choices, [
    { key: 'alternate\n/home/operator/Documents/docs', id: 'alternate', path: '/home/operator/Documents/docs' },
    { key: 'main\n/home/operator/Documents/app', id: 'main', path: '/home/operator/Documents/app' },
  ]);
});
