import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  implementationBriefContent,
  implementationBriefTitle,
  packagePlanningPlan,
  plannedBriefContent,
  plannedBriefTitle,
  planningBriefContent,
  planningBriefTitle,
} from "./spec-prompt.mjs";

const REF = "agent-tooling/newui-09-plan-implement-handoffs";

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
  assert.deepEqual(packagePlanningPlan({ proposal: false, critiqueRecommended: false, critique: false }),
    { skill: "spec-architect-initial", stages: ["spec-architect-initial", "spec-write"], stop: "prepared" });
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

test("an intact proposal with critique selects spec-write and never loops initial architecture", () => {
  const withCritique = packagePlanningPlan({ proposal: true, critiqueRecommended: true, critique: true });
  assert.deepEqual(withCritique, { skill: "spec-write", stages: ["spec-write"], stop: "prepared" });
  assert.equal(withCritique.stages.includes("spec-architect-initial"), false);
  const noRecommendation = packagePlanningPlan({ proposal: true, critiqueRecommended: false, critique: false });
  assert.deepEqual(noRecommendation, { skill: "spec-write", stages: ["spec-write"], stop: "prepared" });
  assert.equal(planningBriefContent(REF, noRecommendation).includes("spec-architect-initial"), false);
});

test("implementation brief binds the package and draft PR stop without fixed model or merge authority", () => {
  const title = implementationBriefTitle(REF);
  assert.ok(title.includes(REF));
  assert.match(title, /draft PR/);
  const content = implementationBriefContent(REF);
  assert.ok(content.includes(REF));
  assert.ok(content.startsWith("/spec-end-to-end"));
  assert.match(content, /Stop at a draft pull request/);
  assert.match(content, /Do not merge or deploy/);
  assert.match(content, /host default model/i);
  assert.doesNotMatch(content, /DEFAULT_OWNER|STRONG_OWNER|EDITOR_AGENT|REVIEW_AGENT|SCOUT_AGENT|FINAL_REVIEWER/);
  assert.doesNotMatch(content, /openrouter|openai-codex|deepseek|muse-spark|gpt-6/);
});

test("legacy relaunch brief text is byte-for-byte unchanged for its current consumer", async () => {
  assert.equal(plannedBriefTitle(REF), `Resume ${REF} through PR publication`);
  assert.equal(plannedBriefContent(REF),
    `/spec-end-to-end Resume after spec-write for ${REF}.\n` +
    `Continue through PR publication.\n\n` +
    `DEFAULT_OWNER: meta/muse-spark-1.3-contributor:xhigh from openrouter\n` +
    `STRONG_OWNER: gpt-6.1-sol:medium from openai-codex\n` +
    `EDITOR_AGENT: deepseek-flash:max from deepseek\n` +
    `REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex\n` +
    `SCOUT_AGENT: gpt-6-luna:low from openai-codex\n` +
    `FINAL_REVIEWER: gpt-6.1-sol:xhigh from openai-codex\n` +
    `PACKAGE: ${REF}`);
  const relaunch = await readFile(new URL("./relaunch.mjs", import.meta.url), "utf8");
  assert.match(relaunch, /plannedBriefContent\(old\.package_ref\)/);
  assert.match(relaunch, /plannedBriefTitle\(old\.package_ref\)/);
});
