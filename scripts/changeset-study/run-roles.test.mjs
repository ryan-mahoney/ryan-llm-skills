import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRoles } from './run-roles.mjs';

test('fresh same-selector owner-query-writer roles retain the selected implementation owner', () => {
  assert.deepEqual(buildRunRoles({ strategy: 'owner-query-writer', selector: 'sol/query', editorSelector: 'sol/query' }), {
    implementation_owner: 'sol/query', query_planner: 'sol/query', writer: 'sol/query',
  });
});

test('inherited roles preserve the donor implementation owner while current query and writer selectors remain explicit', () => {
  assert.deepEqual(buildRunRoles({
    strategy: 'owner-query-writer', selector: 'sol/new-query', editorSelector: 'deepseek/current-writer',
    donorManifest: { selector: 'sol/old-query', editor_selector: 'deepseek/old-writer', roles: {
      implementation_owner: 'deepseek/original-owner', query_planner: 'sol/old-query', writer: 'deepseek/old-writer',
    } },
  }), {
    implementation_owner: 'deepseek/original-owner', query_planner: 'sol/new-query', writer: 'deepseek/current-writer',
  });
  assert.deepEqual(buildRunRoles({
    strategy: 'owner-query-writer', selector: 'sol/query', editorSelector: 'deepseek/writer',
    donorManifest: { editor_selector: 'deepseek/legacy-owner' },
  }), {
    implementation_owner: 'deepseek/legacy-owner', query_planner: 'sol/query', writer: 'deepseek/writer',
  });
});

test('missing or unusable inherited owner metadata fails closed', () => {
  assert.throws(() => buildRunRoles({ strategy: 'owner-query-writer', selector: 'sol/query', editorSelector: 'deepseek/writer', donorManifest: {} }), /inherited implementation owner/);
  assert.throws(() => buildRunRoles({ strategy: 'owner-query-writer', selector: 'sol/query', editorSelector: 'deepseek/writer', donorManifest: { editor_selector: 'deepseek/legacy', roles: { implementation_owner: 'invalid' } } }), /inherited implementation owner/);
});
