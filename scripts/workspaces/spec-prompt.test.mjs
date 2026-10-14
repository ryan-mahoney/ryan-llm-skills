import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  CRITIQUE_ONLY_PLAN,
  implementationBriefContent,
  implementationBriefTitle,
  packagePlanningPlan,
  planningBriefContent,
  planningBriefTitle,
  planningPlanDescription,
} from "./spec-prompt.mjs";

const REF = "agent-tooling/newui-09-plan-implement-handoffs";

test("planning entry description preserves resume stages and conditional architecture stop", () => {
  assert.equal(planningPlanDescription(packagePlanningPlan({ proposal: true })),
    "Planning runs Specification and preparation and stops at Prepared.");
  assert.equal(planningPlanDescription(packagePlanningPlan({ proposal: true, critiqueRecommended: true })),
    "Planning runs Critique, then Specification and preparation and stops at Prepared.");
  assert.equal(planningPlanDescription(packagePlanningPlan({ critiqueRecommended: true })),
    "Planning runs Architecture and stops at Proposal.");
  assert.match(planningPlanDescription(packagePlanningPlan()), /if critique is recommended, stop at the proposal/);
});

test("fresh package selects initial architecture and stops at proposal when critique is recommended", () => {
  const plan = packagePlanningPlan({ proposal: false, critiqueRecommended: true, critique: false });
  assert.deepEqual(plan, { skill: "spec-architect-initial", stages: ["spec-architect-initial"], stop: "proposal" });
  const title = planningBriefTitle(REF, plan);
  assert.ok(title.includes(REF));
  assert.match(title, /^Plan .* through proposal$/);
  const content = planningBriefContent(REF, plan);
  assert.ok(content.startsWith("/spec-architect-initial"));
  assert.ok(content.includes(REF));
  assert.match(content, /Stages: 1 Architecture \(spec-architect-initial\)/);
  assert.match(content, /Stop at Proposal/);
  assert.match(content, /later launch/);
});

test("fresh package without a recommendation runs architecture then spec-write to prepared", () => {
  const plan = packagePlanningPlan({ proposal: false, critiqueRecommended: false, critique: false });
  assert.deepEqual(plan,
    { skill: "spec-architect-initial", stages: ["spec-architect-initial", "spec-write"], stop: "prepared" });
  const content = planningBriefContent(REF, plan);
  assert.match(content, /Stop at Prepared/);
  assert.match(content, /inspect the resulting proposal/);
  assert.match(content, /if critique is recommended, stop at the proposal/);
  assert.match(content, /otherwise continue through spec-write to Prepared/);
});

test("a recommended proposal without a critique selects critics then spec-write", () => {
  const plan = packagePlanningPlan({ proposal: true, critiqueRecommended: true, critique: false });
  assert.deepEqual(plan, { skill: "spec-architect-critics", stages: ["spec-architect-critics", "spec-write"], stop: "prepared" });
  const content = planningBriefContent(REF, plan);
  assert.ok(content.startsWith("/spec-architect-critics"));
  assert.match(content, /Critique \(spec-architect-critics\) -> 2 Specification and preparation \(spec-write\)/);
  assert.match(content, /Stop at Prepared/);
  assert.match(content, /Publication authority: none/);
  assert.match(content, /do not implement, commit, push or open a pull request/);
  assert.match(content, /launch service may prepare a package branch or worktree/);
  assert.match(content, /Discuss any known unresolved decision before the next launch/);
});

test("critique-only plan runs one critics stage and stops at the critique", () => {
  assert.deepEqual(CRITIQUE_ONLY_PLAN, {
    skill: "spec-architect-critics",
    stages: ["spec-architect-critics"],
    stop: "critique",
  });
  assert.equal(Object.isFrozen(CRITIQUE_ONLY_PLAN), true);
  assert.equal(Object.isFrozen(CRITIQUE_ONLY_PLAN.stages), true);
  const title = planningBriefTitle(REF, CRITIQUE_ONLY_PLAN);
  assert.ok(title.endsWith("through critique"));
  const content = planningBriefContent(REF, CRITIQUE_ONLY_PLAN);
  assert.ok(content.startsWith("/spec-architect-critics"));
  assert.match(content, /Stages: 1 Critique \(spec-architect-critics\)\./);
  assert.match(content, /Stop at Critique\./);
  assert.match(content, /This launch ends at the critique; specification waits for a later launch\./);
  assert.match(content, /Publication authority: none\./);
  assert.match(content, /Planning runs Critique and stops at Critique\./);
  assert.equal(content.includes("spec-write"), false);
});

test("an intact proposal with critique selects spec-write and never loops initial architecture", () => {
  const withCritique = packagePlanningPlan({ proposal: true, critiqueRecommended: true, critique: true });
  assert.deepEqual(withCritique, { skill: "spec-write", stages: ["spec-write"], stop: "prepared" });
  assert.equal(withCritique.stages.includes("spec-architect-initial"), false);
  const noRecommendation = packagePlanningPlan({ proposal: true, critiqueRecommended: false, critique: false });
  assert.deepEqual(noRecommendation, { skill: "spec-write", stages: ["spec-write"], stop: "prepared" });
  assert.equal(planningBriefContent(REF, noRecommendation).includes("spec-architect-initial"), false);
});

test("implementation brief invokes spec-end-to-end with the standing model assignments", async () => {
  assert.equal(implementationBriefTitle(REF), `Implement ${REF} through draft PR`);
  assert.equal(implementationBriefContent(REF),
    `/spec-end-to-end Implement ${REF} from its prepared specs.\n` +
    `Create a new branch/worktree and continue through PR publication.\n\n` +
    `Use the configured step-owner difficulty routing and retained owner/editor\n` +
    `pairs through the installed Pi spec runtime. Use bounded editor assignments\n` +
    `and separate commit assignments. Use REVIEW_AGENT for independent reviews.\n\n` +
    `DEFAULT_OWNER: deepseek-flash:max from deepseek\n` +
    `STRONG_OWNER: gpt-6.1-sol:medium from openai-codex\n` +
    `EDITOR_AGENT: deepseek-flash:max from deepseek\n` +
    `REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex\n` +
    `SCOUT_AGENT: gpt-6-luna:low from openai-codex\n` +
    `PACKAGE: ${REF}`);
  const relaunch = await readFile(new URL("./relaunch.mjs", import.meta.url), "utf8");
  assert.match(relaunch, /implementationBriefContent\(old\.package_ref\)/);
  assert.match(relaunch, /implementationBriefTitle\(old\.package_ref\)/);
});
