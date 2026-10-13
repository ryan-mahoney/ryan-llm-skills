// Canonical spec worktrees shared by coordinator preparation and step dispatch.
// Never switch, reset or clean an existing checkout.
import {execFileSync} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {setWorktree,stamp} from './index.mjs';
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
const failure=message=>Object.assign(new Error(message),{code:'spec-worktree-unavailable'});

export function specWorktreePath(locations,target){
  const primary=realpathSync(target.primary);
  return target.worktree ?? resolve(join(dirname(primary),`${basename(primary)}-${basename(locations.package_dir)}`));
}

export function inspectSpecWorktree(locations,target){
  try {
    if(!target.worktree)throw failure('Prepare the spec worktree before previewing: node scripts/workspaces/cli.mjs prepare-spec-target <workspace> --target <repository> --spec-package <package-ref>.');
    const primary=realpathSync(target.primary), common=realpathSync(target.common);
    const actual=realpathSync(target.worktree);
    if(actual===primary)throw failure('A spec assignment requires a separate worktree.');
    if(realpathSync(git(primary,'rev-parse','--path-format=absolute','--git-common-dir'))!==common
      ||realpathSync(git(actual,'rev-parse','--show-toplevel'))!==actual
      ||realpathSync(git(actual,'rev-parse','--path-format=absolute','--git-common-dir'))!==common)
      throw failure('Spec worktree is not a top-level checkout of the recorded repository.');
    if(git(actual,'branch','--show-current')!==target.branch)throw failure('Spec worktree is not on the recorded branch.');
    return {primary,worktree:actual,branch:target.branch,target_id:target.id};
  }catch(error){throw error.code==='spec-worktree-unavailable'?error:failure('The recorded spec worktree cannot be verified.');}
}

export async function prepareSpecWorktree(locations,target,{base='HEAD',repairStamp=false,...location}={}){
  const worktree=specWorktreePath(locations,target);
  try {
    if(realpathSync(git(target.primary,'rev-parse','--path-format=absolute','--git-common-dir'))!==realpathSync(target.common))
      throw failure('The primary checkout no longer matches the recorded repository.');
    if(!existsSync(worktree)){
      let existing=false;
      try{git(target.primary,'show-ref','--verify',`refs/heads/${target.branch}`);existing=true;}catch{}
      try{git(target.primary,'worktree','add',...(existing?[worktree,target.branch]:['-b',target.branch,worktree,base]));}
      catch(error){if(!existsSync(worktree))throw error; /* A concurrent preparation may have finished; verify it below. */}
    }
    const result=inspectSpecWorktree(locations,{...target,worktree});
    if(target.worktree!==result.worktree){
      const recorded=await setWorktree(locations.package_ref,target.id,result.worktree,location);
      if(!recorded.ok)throw failure(recorded.message);
    }
    // Explicit preparation can repair an interrupted stamp. Step dispatch keeps
    // its original behavior: stamp only when first recording the worktree.
    if(target.worktree!==result.worktree||repairStamp){
      const stamped=await stamp(locations.package_ref,location);
      if(!stamped.ok)throw failure(stamped.message);
    }
    return result;
  }catch(error){throw error.code==='spec-worktree-unavailable'?error:failure('The spec worktree could not be prepared. Inspect its recorded branch and checkout.');}
}
