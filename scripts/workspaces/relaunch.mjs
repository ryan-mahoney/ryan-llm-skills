// Relaunch a re-entrant spec with the standard package prompt. The browser supplies
// identities and approval only; execution settings remain owned by the record.
import {addMaterial} from './store.mjs';
import {plannedBriefContent,plannedBriefTitle} from './spec-prompt.mjs';
import {findAssignment,listAssignments,resolveAssignment,launchAssignment} from './assignments.mjs';
import {assertNoAssignmentWorkers} from './worker-guard.mjs';
import {observeAssignment} from './reconcile.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createAssignmentRelaunch({storageRoot,adapters={},resolveOptions={}}={}) {
  async function resolve(input){
    if(!input||Object.keys(input).some(key=>!['assignment_id','retry_id','expectedDigest'].includes(key))
      ||!uuid.test(input.assignment_id??'')||!uuid.test(input.retry_id??'')||input.assignment_id===input.retry_id)throw new Error('Choose a valid assignment and a distinct relaunch attempt.');
    const old=await findAssignment(storageRoot,input.assignment_id);
    if(old.skill!=='spec-end-to-end'||!old.spec_package)throw new Error('Relaunch is available for spec-end-to-end assignments.');
    const material=await addMaterial(storageRoot,old.workspace_id,{kind:'brief',
      request_id:input.retry_id,title:plannedBriefTitle(old.package_ref),content:plannedBriefContent(old.package_ref)});
    const trusted={assignment_id:input.retry_id,workspace_id:old.workspace_id,storageRoot,
      brief:material.path,instructions:'Perform the attached assignment brief.',skill:'spec-end-to-end',
      target:old.repository_id,specPackage:old.spec_package,provider:old.provider,model:old.model,thinking:old.thinking,
      pi_path:old.pi_path,project_trust:old.project_trust,harness:old.harness,publication_authority:old.publication_authority,
      workflow_id:old.workflow_id,attempt_kind:'launch-retry',supersedes:old.assignment_id};
    const resolved=await resolveAssignment(trusted,resolveOptions);
    if(resolved.record.execution_dir!==old.execution_dir)throw new Error('The workspace target moved. Restore its saved execution target before relaunching.');
    return {old,trusted,resolved};
  }
  async function preview(input){
    const {old,resolved}=await resolve(input);
    const records=await listAssignments(storageRoot);
    const successor=records.find(record=>record.supersedes===old.assignment_id&&record.assignment_id!==input.retry_id);
    if(successor)throw new Error(`This assignment was already relaunched. Open assignment ${successor.assignment_id}.`);
    await assertNoAssignmentWorkers(old);
    const observed=await observeAssignment(old,adapters.observationProbes);
    if(!observed.gone)throw new Error('The previous agent has not been confirmed stopped. Check its status before relaunching.');
    return {record:resolved.record,contractDigest:resolved.contractDigest};
  }
  async function launch(input){
    if(!/^[a-f0-9]{64}$/.test(input?.expectedDigest??''))throw new Error('Review the saved assignment before relaunching.');
    const {trusted,resolved}=await resolve(input);
    const assignment=await launchAssignment(trusted,{resolved,expectedDigest:input.expectedDigest,adapters});
    return {assignment,observation:await observeAssignment(assignment,adapters.observationProbes)};
  }
  return {previewRelaunch:preview,relaunch:launch};
}
