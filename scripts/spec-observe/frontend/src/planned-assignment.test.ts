// Run with: node --import tsx --test src/planned-assignment.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
// The legacy PlannedAssignment surface is retired; the brief bytes and canonical
// target helpers now live with spec-prompt and launch-handoff owners.
import { implementationBriefContent, implementationBriefTitle } from '../../../workspaces/spec-prompt.mjs';
import { plannedTargetChoices, plannedTargetLabel } from './launch-handoff';

test('prefills the package reference into the spec-end-to-end invocation and its model assignments', () => {
  const ref = '/workspace/specs/feature';
  assert.equal(implementationBriefTitle(ref), `Implement ${ref} through draft PR`);
  const content = implementationBriefContent(ref);
  assert.ok(content.startsWith(`/spec-end-to-end Implement ${ref} from its prepared specs.\n`));
  assert.ok(content.endsWith(`\nPACKAGE: ${ref}`));
  assert.match(content, /^EDITOR_AGENT: mimo-v2\.6-pro-ultraspeed:off from xiaomi$/m);
});

test('legacy planned surface keeps canonical target alias protection', () => {
  const alias = plannedTargetChoices([{ id: 'alias', primary: '/workspace/repos/real' }, { id: 'invalid', primary: '' }]);
  assert.deepEqual(alias, [{ key: 'alias\n/workspace/repos/real', id: 'alias', path: '/workspace/repos/real' }]);
  assert.equal(plannedTargetLabel(alias[0]), 'alias · /workspace/repos/real');
});
