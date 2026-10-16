import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinedPath, sandbox, grade } from './sandbox.mjs';

test('study tools cannot read outside their candidate or follow a shell-created symlink', async () => {
  const root = mkdtempSync(join(tmpdir(),'study-boundary-'));
  try {
    writeFileSync(join(root,'visible.txt'),'available');symlinkSync('/etc/passwd',join(root,'escape'));
    assert.throws(()=>confinedPath(root,'/etc/passwd'),/outside/);
    assert.throws(()=>confinedPath(root,'../oracle.mjs'),/outside/);
    assert.throws(()=>confinedPath(root,'escape'),/Symlink/);
    const result=await sandbox(root,'cat visible.txt; test ! -e /etc/passwd; test ! -e /oracle.mjs; test -z "$OPENAI_API_KEY"');
    assert.equal(result.ok,true,result.output);assert.match(result.output,/available/);
    const denied=await sandbox(root,'echo changed > visible.txt',{readOnly:true});assert.equal(denied.ok,false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('an early successful process exit cannot bypass the hidden assertions', async () => {
  const root=mkdtempSync(join(tmpdir(),'study-exit-'));
  try {
    const oracle=join(root,'oracle-host.mjs');
    const early=await grade(root,'process.exit(0); throw new Error("never checked");',{oracle});
    assert.equal(early.exitCode,0);assert.equal(early.ok,false);assert.equal(early.completed,false);
    const checked=await grade(root,'if (1+1 !== 2) throw new Error("wrong");',{oracle});assert.equal(checked.ok,true);
  } finally {rmSync(root,{recursive:true,force:true});}
});
