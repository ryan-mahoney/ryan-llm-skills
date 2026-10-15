// Planning brief stages are skill ids; the brief pairs each with its human label.
const planningStageLabels={'spec-architect-initial':'Architecture','spec-architect-critics':'Critique','spec-write':'Specification and preparation'};
const stageSequence=(stages)=>stages.map((skill,index)=>`${index+1} ${planningStageLabels[skill]??skill} (${skill})`).join(' -> ');
const stopLabel=(stop)=>stop==='proposal'?'Proposal':'Prepared';

// Select the planning run for a package from its planning facts: a fresh package
// starts with architecture (stopping at the proposal when a critique is
// recommended); an intact proposal resumes without re-architecture.
export const packagePlanningPlan=({proposal=false,critiqueRecommended=false,critique=false}={})=>{
  if(!proposal){
    return critiqueRecommended
      ? {skill:'spec-architect-initial',stages:['spec-architect-initial'],stop:'proposal'}
      : {skill:'spec-architect-initial',stages:['spec-architect-initial','spec-write'],stop:'prepared'};
  }
  if(critiqueRecommended&&!critique)return {skill:'spec-architect-critics',stages:['spec-architect-critics','spec-write'],stop:'prepared'};
  return {skill:'spec-write',stages:['spec-write'],stop:'prepared'};
};

export const planningBriefTitle=(packageRef,plan)=>
  `Plan ${packageRef} through ${plan?.stop==='proposal'?'proposal':'preparation'}`.slice(0,200);

// Human-facing stage and stop explanation shared by the epic entry and brief.
export const planningPlanDescription=(plan)=>{
  const stages=(plan?.stages??[]).map(skill=>planningStageLabels[skill]??skill).join(', then ');
  const fresh=plan?.skill==='spec-architect-initial'&&(plan?.stages??[]).includes('spec-write')&&plan?.stop!=='proposal';
  return fresh
    ? 'Planning starts with Architecture. After architecture, inspect the resulting proposal: if critique is recommended, stop at the proposal and wait for a later launch; otherwise continue through spec-write to Prepared.'
    : `Planning runs ${stages} and stops at ${stopLabel(plan?.stop)}.`;
};

export const planningBriefContent=(packageRef,plan)=>{
  const stopsAtProposal=plan?.stop==='proposal';
  return `/${plan?.skill??'spec-architect-initial'} Plan ${packageRef}.\n` +
    `Stages: ${stageSequence(plan?.stages??[])}.\n` +
    `Stop at ${stopLabel(plan?.stop)}. Planning only: do not implement, commit, push or open a pull request.\n` +
    `Publication authority: none. The launch service may prepare a package branch or worktree; that preparation is not implementation.\n` +
    (stopsAtProposal?`This launch ends at the proposal; critique and specification wait for a later launch.\n`:'') +
    `${planningPlanDescription(plan)}\n` +
    `Discuss any known unresolved decision before the next launch.\n\n` +
    `PACKAGE: ${packageRef}`;
};

export const implementationBriefTitle=(packageRef)=>
  `Implement ${packageRef} through draft PR`.slice(0,200);

// The one spec-end-to-end launch brief, shared by first launch and relaunch. The
// model lines are this host's standing assignments; the brief stays editable
// before it is saved, so a run-specific selector is changed there.
export const implementationBriefContent=(packageRef)=>
  `/spec-end-to-end Implement ${packageRef} from its prepared specs.\n` +
  `Create a new branch/worktree and continue through PR publication.\n\n` +
  `Use the configured step-owner difficulty routing and retained owner/editor\n` +
  `pairs through the installed Pi spec runtime. Use bounded editor assignments\n` +
  `and separate commit assignments. Use REVIEW_AGENT for independent reviews.\n\n` +
  `DEFAULT_OWNER: deepseek-flash:max from deepseek\n` +
  `STRONG_OWNER: gpt-6.1-sol:medium from openai-codex\n` +
  `EDITOR_AGENT: deepseek-flash:max from deepseek\n` +
  `REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex\n` +
  `SCOUT_AGENT: gpt-6-luna:low from openai-codex\n` +
  `PACKAGE: ${packageRef}`;
