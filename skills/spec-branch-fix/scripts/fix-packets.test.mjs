// Run alone: node --test skills/spec-branch-fix/scripts/fix-packets.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewFindings, planFixes, renderPacket } from "./fix-packets.mjs";

const review = (findings) => `# Step 003 review

\`\`\`yaml
review:
  kind: step
  step: "003"
  commit: af7fbfa
  verdict: needs-fix
  findings:${findings}
  fix_verdicts: []
\`\`\`
`;

const f = (id, severity, file, line, symbol, actionable = true) => `
    - id: ${id}
      severity: ${severity}
      category: correctness
      actionable: ${actionable}
      file: ${file}
      line: ${line}
      symbol: ${symbol}
      signature: correctness:${file}:${symbol}:gist ${id}
      explanation: >-
        Failure ${id} spans
        two lines.
      correction: Fix ${id}.`;

test("parses folded explanations and scalar fields from the review record", () => {
  const parsed = parseReviewFindings(review(f("F1", "HIGH", "a.mjs", 120, "claim")));
  assert.equal(parsed.verdict, "needs-fix");
  assert.equal(parsed.step, "003");
  assert.deepEqual(parsed.findings[0], { id: "F1", severity: "HIGH", category: "correctness", actionable: true,
    file: "a.mjs", line: 120, symbol: "claim", signature: "correctness:a.mjs:claim:gist F1",
    explanation: "Failure F1 spans two lines.", correction: "Fix F1." });
  assert.deepEqual(parseReviewFindings(review(" []")).findings, []);
});

test("a few non-HIGH findings in one file stay a single fixer run", () => {
  const plan = planFixes(parseReviewFindings(review(f("F1", "MED", "a.mjs", 10, "x") + f("F2", "LOW", "a.mjs", 300, "y"))));
  assert.equal(plan.mode, "single");
  assert.deepEqual(plan.packets.map(p => p.ids), [["F1", "F2"]]);
  assert.deepEqual(plan.packets[0].ranges, [{ file: "a.mjs", from: 1, to: 50 }, { file: "a.mjs", from: 260, to: 340 }]);
});

test("HIGH or multi-file findings split by file and symbol, most severe first, with pending ids", () => {
  const plan = planFixes(parseReviewFindings(review(
    f("F3", "MED", "b.mjs", 40, "probe") + f("F1", "HIGH", "a.mjs", 100, "claim") + f("F2", "HIGH", "a.mjs", 130, "claim")
    + f("F4", "MED", "b.mjs", 70, "probe") + f("F5", "LOW", "a.mjs", 400, "other", false))), { exclude: ["F4"] });
  assert.equal(plan.mode, "split");
  assert.deepEqual(plan.packets.map(p => p.ids), [["F1", "F2"], ["F3"]]);
  assert.deepEqual(plan.packets[0].ranges, [{ file: "a.mjs", from: 60, to: 170 }], "overlapping ranges merge");
  assert.deepEqual(plan.packets.map(p => p.pending_after), [["F3"], []]);
  assert.equal(planFixes(parseReviewFindings(review(f("F1", "MED", "a.mjs", 1, "x"))), { exclude: ["F1"] }).mode, "none");
});

test("a rendered packet names its ranges, guards and the pending list for the fix file", () => {
  const plan = planFixes(parseReviewFindings(review(f("F1", "HIGH", "a.mjs", 100, "claim") + f("F2", "MED", "b.mjs", 5, "probe"))));
  const text = renderPacket(plan.packets[0], { review: "step-003-review.md", total: plan.packets.length });
  assert.match(text, /packet 1 of 2 .*: F1\./);
  assert.match(text, /- a\.mjs:60-140/);
  assert.match(text, /within your first three tool calls/);
  assert.match(text, /git restore/);
  assert.match(text, /Update reviews\/step-003-fix\.md: .*pending: \[F2\]/);
});
