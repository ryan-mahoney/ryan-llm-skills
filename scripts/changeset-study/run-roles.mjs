import { parseSelector } from '../changeset/models.mjs';

function checkedSelector(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error(`Missing or invalid ${label} selector`);
  try { parseSelector(value); }
  catch { throw new Error(`Missing or invalid ${label} selector`); }
  return value;
}

export function buildRunRoles({ strategy, selector, editorSelector, ownerSelector = null, donorManifest = null }) {
  if (strategy !== 'owner-query-writer') return null;
  const queryPlanner = checkedSelector(selector, 'query planner');
  const writer = checkedSelector(editorSelector, 'writer');
  const implementationOwner = donorManifest
    ? checkedSelector(donorManifest.roles?.implementation_owner ?? donorManifest.editor_selector, 'inherited implementation owner')
    : ownerSelector ? checkedSelector(ownerSelector, 'implementation owner') : writer;
  return { implementation_owner: implementationOwner, query_planner: queryPlanner, writer };
}
