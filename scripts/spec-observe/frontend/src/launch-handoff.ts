// Bound package entry orchestration for the plan/implement hand-offs. This
// module owns the derived presentation (title, brief bytes, bound skill,
// publication authority, planning stages and stop) plus the canonical package
// target inventory shared with the legacy planned-assignment surface.
// launch-state.ts stays the only identity/approval/submission owner and
// launch-client.ts the only transport mapping: this module seeds and routes
// through the store, never posts, previews or launches on its own, and takes
// the route navigator from the caller so it stays testable without a DOM.
import {
  changeLaunchTarget, contextKey, getLaunchDraft, normalizeLaunchStop, saveLaunchDraft, seedLaunchDraft,
} from './launch-state';
import type { LaunchContext, LaunchDraft, LaunchDraftError } from './launch-state';
import type { WireRecord } from './model';
import { subscribeRoute } from './route';
import type { RouteMode, RouteState } from './route';
import {
  CRITIQUE_ONLY_PLAN, implementationBriefContent, implementationBriefTitle, packagePlanningPlan, planningBriefContent, planningBriefTitle,
} from '../../../workspaces/spec-prompt.mjs';
import type { PlanningFacts } from './readiness';

export type HandoffKind = 'plan' | 'implement';

export type PackagePlanningPlan = {
  skill: 'spec-architect-initial' | 'spec-architect-critics' | 'spec-write';
  stages: string[];
  stop: 'proposal' | 'critique' | 'prepared';
};

export type PlannedTarget = {
  id: string;
  primary: string;
  worktree?: string | null;
};

export type PlannedTargetChoice = {
  key: string;
  id: string;
  path: string;
};

export type HandoffInput = {
  ws: string;
  packageRef: string;
  targets?: PlannedTarget[] | null;
  planningPlan?: PackagePlanningPlan | null;
  // A cold entry may carry an already-chosen canonical target. It is honored
  // only when it matches the package's own target inventory, so a route alias
  // never approves a different repository and several targets keep an
  // explicit choice instead of guessing.
  target?: string | null;
  returnRoute?: RouteState;
};

export type HandoffPresentation = {
  title: string;
  content: string;
  skill: string;
  authority: 'none' | 'draft-pr';
  stages: string[];
  stop?: 'proposal' | 'critique' | 'prepared' | 'draft-pr';
};

export type HandoffStage = 'brief' | 'review' | 'result';
export type HandoffNavigate = (route: RouteState, mode?: RouteMode) => void;

export type HandoffSuccess = {
  ok: true;
  stage: HandoffStage;
  context: LaunchContext;
  draft: LaunchDraft;
  returnRoute: RouteState;
  navigated: boolean;
};

export type HandoffFailure = {
  ok: false;
  reason: string;
  context?: LaunchContext;
  error?: LaunchDraftError;
};

export type HandoffOutcome = HandoffSuccess | HandoffFailure;

// Recognized planning skills claim no publication authority; the implementation
// skill carries draft-pr. Any other skill derives nothing so legacy direct
// requests keep their current body. The value follows the bound skill and is
// never read from route or query text.
const PLANNING_SKILLS: readonly string[] = ['spec-architect-initial', 'spec-architect-critics', 'spec-write'];
const IMPLEMENTATION_SKILL = 'spec-end-to-end';

export function publicationAuthorityForSkill(skill: string | undefined): 'none' | 'draft-pr' | undefined {
  if (skill !== undefined && PLANNING_SKILLS.includes(skill)) return 'none';
  return skill === IMPLEMENTATION_SKILL ? 'draft-pr' : undefined;
}

// Route identity for the launch surface: the one mapping every launch
// consumer uses to read its store entry. The stop is normalized through the
// same skill-aware owner as contextKey, so a seeded draft and its route
// consumer always meet on one identity.
export function launchContextForRoute(route: RouteState, ws: string): LaunchContext {
  const authority = route.package ? publicationAuthorityForSkill(route.skill) : undefined;
  const stop = normalizeLaunchStop(route.stop, route.skill);
  return {
    ws,
    ...(route.thread ? { thread: route.thread } : {}),
    target: route.target ?? null,
    ...(route.package ? { package: route.package } : {}),
    ...(route.skill ? { skill: route.skill } : {}),
    ...(authority ? { authority } : {}),
    ...(stop ? { stop } : {}),
  };
}

// Cold planning-plan selection. The explicit route stops are validated first;
// the derived branch keeps the conservative stage rules (an unknown critique
// recommendation and an unknown recommended-critique outcome refuse instead
// of coercing a spec-write or critics stage). Only the critics-only critique
// stop is identity-bearing, so an explicit spec skip and every ordinary stop
// keep the ordinary context.
export function coldPlanningPlan(
  skill: string | undefined,
  routeStop: string | undefined,
  facts: PlanningFacts | null,
): { ok: true; plan: PackagePlanningPlan } | { ok: false; reason: string } {
  if (!facts || facts.proposal === null) {
    return { ok: false, reason: 'The package proposal presence is not observed; inspect the package files before preparing this planning hand-off.' };
  }
  if (skill === 'spec-architect-critics' && normalizeLaunchStop(routeStop, skill) === 'critique') {
    // Explicit critique-only entry: the route declares the one-stage critics
    // run. A positively observed proposal is required, but the reviewed
    // recommendation only suggests that action and never forbids it.
    if (facts.proposal !== true) {
      return { ok: false, reason: 'A critique-only launch requires a positively observed proposal; inspect the proposal before preparing this hand-off.' };
    }
    if (facts.critique === null) {
      return { ok: false, reason: 'The recommended critique outcome is not observed; inspect the proposal and package files before preparing this planning hand-off.' };
    }
    if (facts.critique === true) {
      return { ok: false, reason: 'A critique is already written for this package; the next planning stage is the specification.' };
    }
    return { ok: true, plan: CRITIQUE_ONLY_PLAN as PackagePlanningPlan };
  }
  if (skill === 'spec-write' && routeStop === 'prepared') {
    // Explicit spec skip: the operator declared the proposal settled, so only
    // proposal presence gates this path (FH-4).
    if (facts.proposal !== true) {
      return { ok: false, reason: 'The requested specification stage does not match the observed package stage; inspect the package before preparing this hand-off.' };
    }
    return { ok: true, plan: packagePlanningPlan({ proposal: true }) as PackagePlanningPlan };
  }
  // The same conservative stage rules as normal entry: an unknown critique
  // recommendation and an unknown recommended-critique outcome refuse instead
  // of coercing a spec-write or critics stage.
  if (facts.proposal === true && facts.critiqueRecommended === null) {
    return { ok: false, reason: 'The proposal does not record whether critique is recommended; inspect the proposal and package files before preparing this planning hand-off.' };
  }
  if (facts.critiqueRecommended === true && facts.critique === null) {
    return { ok: false, reason: 'The recommended critique outcome is not observed; inspect the proposal and package files before preparing this planning hand-off.' };
  }
  const plan = packagePlanningPlan({
    proposal: facts.proposal === true,
    critiqueRecommended: facts.critiqueRecommended === true,
    critique: facts.critique === true,
  }) as PackagePlanningPlan;
  if (plan.skill !== skill) {
    return { ok: false, reason: 'The requested planning skill does not match the observed package stage; inspect the package before preparing this hand-off.' };
  }
  if (routeStop !== undefined && routeStop !== plan.stop) {
    return { ok: false, reason: 'The requested planning stop does not match the observed package stage; inspect the package before preparing this hand-off.' };
  }
  return { ok: true, plan };
}

// The passed planning plan is the observed resolved fact; the default is the
// standard package plan. Stage names and the stop point stay in the shared
// spec-prompt owner so briefs and presentation cannot drift apart.
export function packageLaunchPresentation(kind: HandoffKind, packageRef: string, planningPlan?: PackagePlanningPlan | null): HandoffPresentation {
  if (kind === 'implement') {
    return {
      title: implementationBriefTitle(packageRef),
      content: implementationBriefContent(packageRef),
      skill: IMPLEMENTATION_SKILL,
      authority: 'draft-pr',
      stages: [],
      stop: 'draft-pr',
    };
  }
  const plan = planningPlan ?? (packagePlanningPlan() as PackagePlanningPlan);
  return {
    title: planningBriefTitle(packageRef, plan),
    content: planningBriefContent(packageRef, plan),
    skill: plan.skill,
    authority: publicationAuthorityForSkill(plan.skill) ?? 'none',
    stages: [...plan.stages],
    stop: plan.stop,
  };
}

// Canonical package target inventory. Keep only absolute primary paths from
// the package record: the assignment backend resolves the selected path
// against workspace repositories and refuses missing or ambiguous bindings,
// while target ids may differ from workspace repository aliases.
export function plannedTargetChoices(packageTargets: PlannedTarget[] | null | undefined): PlannedTargetChoice[] {
  if (!Array.isArray(packageTargets)) return [];
  const choices = new Map<string, PlannedTargetChoice>();
  for (const target of packageTargets) {
    if (!target || typeof target.id !== 'string' || !target.id || typeof target.primary !== 'string' || !target.primary.startsWith('/')) continue;
    const path = target.primary;
    const key = `${target.id}\n${path}`;
    choices.set(key, { key, id: target.id, path });
  }
  return [...choices.values()].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
}

export function plannedTargetLabel(target: PlannedTargetChoice): string {
  return `${target.id} · ${target.path}`;
}

// Discussion seeding for an observed decision resolves the package's canonical
// primary to the repository alias the conversation must bind. Package target
// ids are package-local: they may differ from the workspace repository aliases
// or collide with a different checkout, so the id is never trusted. Exactly
// one healthy repository with a nonempty id whose stored canonical_path equals
// the single target primary, in the matching workspace, is accepted. An
// absent or wrong-workspace record, an unhealthy, unmatched or ambiguous
// inventory and a package without a usable target all refuse with a reason so
// the caller can refuse without seeding or navigating; several distinct
// targets keep the accepted no-guess behavior (no repository preselection).
export function discussionRepositoryTarget(
  workspace: WireRecord | null | undefined,
  ws: string,
  packageTargets: PlannedTarget[] | null | undefined,
): { ok: true; target: string | null } | { ok: false; reason: string } {
  const choices = plannedTargetChoices(packageTargets);
  if (choices.length === 0) return { ok: false, reason: 'No usable package target is available.' };
  if (choices.length > 1) return { ok: true, target: null };
  if (!workspace || typeof workspace.id !== 'string' || workspace.id !== ws) {
    return { ok: false, reason: 'The workspace repository inventory is unavailable; connect to the live workspace service before discussing this decision.' };
  }
  const path = choices[0].path;
  const matches = (Array.isArray(workspace.repositories) ? workspace.repositories : [])
    .filter(repository => repository && repository.status === 'ok'
      && typeof repository.id === 'string' && repository.id !== ''
      && repository.canonical_path === path);
  if (matches.length === 0) {
    return { ok: false, reason: `The package target ${path} is not a healthy repository in this workspace.` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `The package target ${path} matches more than one repository in this workspace.` };
  }
  return { ok: true, target: matches[0].id as string };
}

// Return-route memory keyed by the launch context identity, never by route
// text. A fresh explicit entry replaces the remembered route; repeat entries
// for protected retained work fill only an empty slot so the surface that
// started the work stays the return target.
const returnRoutes = new Map<string, RouteState>();

const rememberReturnRoute = (context: LaunchContext, route: RouteState | undefined, overwrite: boolean): void => {
  if (!route) return;
  const key = contextKey(context);
  if (!overwrite && returnRoutes.has(key)) return;
  returnRoutes.set(key, { ...route });
};

export function handoffReturn(kind: HandoffKind, context: LaunchContext): RouteState {
  const remembered = returnRoutes.get(contextKey(context));
  if (remembered) return { ...remembered };
  return kind === 'implement'
    ? { dest: 'specs', ws: context.ws, filter: 'ready' }
    : { dest: 'epics', ws: context.ws };
}

type PreparedBoundSeed = {
  ok: true;
  context: LaunchContext;
  presentation: HandoffPresentation;
  choices: PlannedTargetChoice[];
};

const prepareBoundSeed = (kind: HandoffKind, input: HandoffInput): PreparedBoundSeed | HandoffFailure => {
  const ws = typeof input.ws === 'string' ? input.ws.trim() : '';
  if (!ws) return { ok: false, reason: 'A workspace is required to launch a package.' };
  const packageRef = typeof input.packageRef === 'string' ? input.packageRef.trim() : '';
  if (!packageRef) return { ok: false, reason: 'A spec package is required to launch.' };
  const choices = plannedTargetChoices(input.targets);
  if (choices.length === 0) return { ok: false, reason: 'No usable package target is available.' };
  const presentation = packageLaunchPresentation(kind, packageRef, input.planningPlan);
  const requested = typeof input.target === 'string' && input.target
    ? choices.find(choice => choice.path === input.target || choice.key === input.target)?.path ?? null
    : null;
  const context: LaunchContext = {
    ws,
    target: choices.length === 1 ? choices[0].path : requested,
    package: packageRef,
    skill: presentation.skill,
    authority: presentation.authority,
  };
  // Only the critics-only critique stop is a launch identity; a plain
  // proposal/prepared stop stays a presentation fact and never enters the
  // context, so the cold consumer finds the draft this seed stored.
  const stop = normalizeLaunchStop(presentation.stop, presentation.skill);
  if (kind === 'plan' && stop) context.stop = stop;
  return { ok: true, context, presentation, choices };
};

const launchRouteFor = (context: LaunchContext, stage: HandoffStage, resultId?: string): RouteState => {
  const stop = normalizeLaunchStop(context.stop, context.skill);
  return {
    dest: 'launch',
    ws: context.ws,
    tab: stage,
    ...(stage === 'result' && resultId ? { id: resultId } : {}),
    ...(context.thread ? { thread: context.thread } : {}),
    ...(context.target ? { target: context.target } : {}),
    ...(context.package ? { package: context.package } : {}),
    ...(context.skill ? { skill: context.skill } : {}),
    ...(stop ? { stop } : {}),
  };
};

// A retained draft's own state decides where repeat entry lands: a recorded
// outcome owns the result surface, a saved/reviewed or resolving entry owns
// review, and everything else (save error, unsaved edits) stays on the brief.
const draftStage = (draft: LaunchDraft): HandoffStage => {
  if (draft.result) return 'result';
  if (draft.saved || draft.preview || draft.reviewStatus !== 'idle'
    || draft.pending?.kind === 'preview' || draft.pending?.kind === 'launch') return 'review';
  return 'brief';
};

const saveFailureReason = (stored: LaunchDraftError | undefined, error: unknown): string => {
  if (stored?.message) return stored.message;
  if (stored?.reason) return stored.reason;
  if (stored?.status !== undefined) return `The brief could not be saved (${stored.status}).`;
  if (error instanceof Error && error.message) return error.message;
  return 'The brief could not be saved. Retry the same brief.';
};

export async function startPackageHandoff(
  kind: HandoffKind,
  input: HandoffInput,
  token: string,
  navigate: HandoffNavigate,
): Promise<HandoffOutcome> {
  const prepared = prepareBoundSeed(kind, input);
  if (!prepared.ok) return prepared;
  const { context, presentation, choices } = prepared;

  const retained = getLaunchDraft(context);
  if (retained && retained.result?.kind !== 'launched') {
    // The context tuple drops the editable target, so re-attach the retained
    // one: repeat entry must route the surface the draft owns, not the route's
    // possibly absent or stale value.
    const retainedContext: LaunchContext = { ...context, target: retained.target };
    rememberReturnRoute(retainedContext, input.returnRoute, false);
    // Never await a repeat-entry pending save. The originating guarded
    // operation settles this entry's request identity and owns its own
    // navigation; repeat entry routes immediately from the retained state so
    // a late settle cannot redirect twice.
    const stage = draftStage(retained);
    navigate(launchRouteFor(retainedContext, stage, retained.result?.assignmentId), 'push');
    return { ok: true, stage, context: retainedContext, draft: retained, returnRoute: handoffReturn(kind, retainedContext), navigated: true };
  }

  rememberReturnRoute(context, input.returnRoute, true);
  const seeded = seedLaunchDraft(context, { title: presentation.title, content: presentation.content, stage: 'brief' });

  // Several canonical targets cannot be guessed: seed the brief, show the
  // chooser and leave save/preview to the explicit selection.
  if (choices.length > 1) {
    navigate(launchRouteFor(context, 'brief'), 'push');
    return { ok: true, stage: 'brief', context, draft: seeded, returnRoute: handoffReturn(kind, context), navigated: true };
  }

  // One canonical target saves once through the store, then opens review; no
  // preview or launch is submitted here. Route changes during the save mean
  // the caller left the entry surface, so a late save never steals the route.
  let generation = 0;
  const stopRouteWatch = subscribeRoute(() => { generation += 1; });
  const entryGeneration = generation;
  let failure: unknown;
  try {
    await saveLaunchDraft(context, token);
  } catch (error) {
    failure = error;
  } finally {
    stopRouteWatch();
  }
  const settled = getLaunchDraft(context) ?? seeded;
  if (failure !== undefined || settled.error?.operation === 'save') {
    return { ok: false, reason: saveFailureReason(settled.error, failure), context, error: settled.error };
  }
  if (generation !== entryGeneration) {
    return { ok: true, stage: 'brief', context, draft: settled, returnRoute: handoffReturn(kind, context), navigated: false };
  }
  navigate(launchRouteFor(context, 'review'), 'push');
  return { ok: true, stage: 'review', context, draft: settled, returnRoute: handoffReturn(kind, context), navigated: true };
}

// Cold bound URL: derive the presentation from observed package facts and
// prefill only an absent draft. A validated route target is honored for
// multi-target packages so cold entry keeps the operator's explicit choice.
// No POST, no preview and no launch; the brief stage is the seed outcome. An
// existing draft is returned untouched.
export function seedColdHandoff(kind: HandoffKind, input: HandoffInput): HandoffOutcome {
  const prepared = prepareBoundSeed(kind, input);
  if (!prepared.ok) return prepared;
  const { context, presentation } = prepared;
  rememberReturnRoute(context, input.returnRoute, false);
  const retained = getLaunchDraft(context);
  if (retained) {
    // The context tuple drops the editable target; report the retained one so
    // cold repeat entry agrees with startPackageHandoff without mutating the
    // draft in the store.
    const retainedContext: LaunchContext = { ...context, target: retained.target };
    return { ok: true, stage: 'brief', context: retainedContext, draft: retained, returnRoute: handoffReturn(kind, retainedContext), navigated: false };
  }
  const draft = seedLaunchDraft(context, { title: presentation.title, content: presentation.content, stage: 'brief' });
  return { ok: true, stage: 'brief', context, draft, returnRoute: handoffReturn(kind, context), navigated: false };
}

// Canonical retarget: only a primary path from the package's own target
// inventory is accepted, and the canonical choice path is stored so an alias
// never approves a different repository. A null target is the selector's
// explicit "choose again" state and clears approval exactly like the store.
export function retargetPackageHandoff(
  context: LaunchContext,
  targets: PlannedTarget[] | null | undefined,
  target: string | null,
): { ok: true; draft: LaunchDraft | undefined } | { ok: false; reason: string } {
  if (target === null) return { ok: true, draft: changeLaunchTarget(context, null) };
  const match = plannedTargetChoices(targets).find(choice => choice.path === target || choice.key === target);
  if (!match) return { ok: false, reason: 'The selected target is not available for this package.' };
  return { ok: true, draft: changeLaunchTarget(context, match.path) };
}
