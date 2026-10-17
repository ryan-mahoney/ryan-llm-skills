// EV-13 native wave case helpers (D-29 packet 2b).
//
// The wave record's durable member entry carries the provisioned workspace
// (step-workspaces.mjs) rather than a flat checkout path, so the native cases
// read the canonical `workspace.worktree` and corroborate it against the
// implementing run recorded by the runtime (runtime.mjs runFileOf).
//
// Both helpers deliberately refuse to filter or invent fields: a missing
// workspace member or a mis-specified backend is a fixture/production defect
// the cases must surface, not something to skip over.
import assert from 'node:assert/strict';

function durableMembers(record) {
  assert.ok(record && typeof record === 'object', 'wave record is an object');
  return Object.values(record.members ?? {});
}

// Assert the member's workspace is a worktree-backed, non-empty workspace whose
// path is the same directory the implementing run recorded as its checkout, and
// return that canonical path.
export function memberWorkspace(member, run) {
  assert.ok(member && typeof member === 'object', `member step ${member?.step} is an object`);
  const label = `member step ${member.step}`;
  const workspace = member.workspace;
  assert.ok(workspace && typeof workspace === 'object', `${label} has a workspace record`);
  assert.equal(workspace.backend, 'worktree', `${label} workspace backend is worktree`);
  assert.equal(typeof workspace.worktree, 'string', `${label} workspace.worktree is a string`);
  assert.ok(workspace.worktree.length > 0, `${label} workspace.worktree is non-empty`);
  assert.ok(run && typeof run === 'object', `${label} has an implementing run record`);
  assert.equal(run.checkout, workspace.worktree, `${label} run checkout matches workspace.worktree`);
  const phase = run.wave_bindings?.phase;
  assert.equal(phase, 'implementing', `${label} run phase is implementing`);
  return workspace.worktree;
}

// Every durable member must expose a non-empty workspace.worktree.
export function memberCheckouts(record) {
  return durableMembers(record).map(member => {
    const workspace = member?.workspace;
    assert.ok(workspace && typeof workspace === 'object', `member step ${member?.step} has a workspace record`);
    assert.equal(typeof workspace.worktree, 'string', `member step ${member.step} workspace.worktree is a string`);
    assert.ok(workspace.worktree.length > 0, `member step ${member.step} workspace.worktree is non-empty`);
    return workspace.worktree;
  });
}
