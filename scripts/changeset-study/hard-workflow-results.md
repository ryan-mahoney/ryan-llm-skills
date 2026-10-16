# Sol and Nemotron workflow comparison

12/12 trials complete across six historical tasks. One trial per workflow and task. This exploratory comparison measures a complete workflow, not an isolated architectural effect.

| Workflow | External checks passed | Complete delivery | Median wall seconds | Model calls | Equivalent USD | Nemotron requests |
|---|---:|---:|---:|---:|---:|---:|
| Sol native | 4/6 | 4/6 | 201.04 | 64 | 0.33861 | 0 |
| Sol + Nemotron changeset | 1/6 | 0/6 | 173.17 | 61 | 0.42749 | 10 |

Failure-adjusted geometric speed ratio: 0.25 (95% task bootstrap interval 0.12–0.53); 6 complete pairs. Ratios above 1 favor the combined workflow. Unsuccessful trials receive the 1500-second cap.

Among 1 pairs where both workflows passed, the conditional geometric speed ratio is 0.12. It does not measure reliability or include failed attempts. Medians above include failed trials and must not be interpreted as time to a correct answer.

As a stricter descriptive measure, requiring both external acceptance and workflow completion gives a failure-adjusted speed ratio of 0.18. This additional view preserves the original external-check scores.

| Task | Native accepted | Combined accepted | Wall seconds, native / combined | Nemotron requests |
|---|---:|---:|---:|---:|
| hard-dependency-handoff | yes | no | 245.25 / 280.73 | 2 |
| hard-context-calibration | yes | yes | 23.03 / 188.94 | 3 |
| hard-lifecycle-extract | yes | no | 206.68 / 116.60 | 0 |
| hard-wave-recovery | no | no | 195.40 / 128.61 | 0 |
| hard-fallback-setup | yes | no | 148.51 / 574.78 | 4 |
| hard-admission-overlap | no | no | 253.98 / 157.40 | 1 |

Native Sol uses standard Pi coding tools. The combined workflow uses Sol for discovery, planning, involved editor operations, review and batch repair planning; only simple editor operations use Nemotron. Plans can also apply deterministic operations. A trial with no Nemotron requests provides no evidence of Nemotron editor capability.

Both workflows receive the same task and initial source, visible feedback, impact review and one batch repair opportunity. Terminal hidden tests run after the candidate freezes and never inform repairs. External acceptance comes from these tests, independently of reviewer opinion. Complete delivery requires external acceptance plus successful execution, visible checks and reviewer acceptance without an uncaught error. External checks can pass despite missing requested test additions or an incomplete workflow; the two counts are deliberately separate. Timing includes initialization, implementation, review, checks, repair and terminal grading.

The original 72-trial campaign was narrowed by the operator for elapsed time after three results were observed and a fourth trial was in progress. All six tasks remain. Eligible repetition-zero native results were reused regardless of outcome; no worker, prompt or grader tuning followed those outcomes. Earlier observations appear below. The reused result contributes once to comparison totals and is not an additional charge.

One repetition on six purposively selected historical cases is a screening result. Provider load, caching, scheduling order and model routing can affect timing. Task-bootstrap intervals describe this small sample, not population reliability. The source is an acceptance-test import closure, not a whole production checkout. Grader exclusions and deadlines are recorded in [PROTOCOL.md](PROTOCOL.md).

An offline audit of the exact pinned Sol adapter confirmed that instructions and low reasoning are forwarded, but the requested 32,000-token output limit is not. Sol therefore has no demonstrated provider-enforced limit at that value; its five-minute call deadline still applies. Nemotron receipts show length stops at 32,000 output tokens, including reasoning. The workflows do not have identical provider-enforced output budgets. The audit and module hash are included in the companion JSON.

Equivalent costs price Sol tokens at DeepSeek rates under the subscription assumption. Unknown provider usage remains unknown; the companion JSON retains known usage and conservative budget exposure. Neither equivalent cost nor catalog estimates are invoices. The $50 reservation ledger includes previous campaigns and remains the spending guard.

## Retained observations outside the reduced schedule

| Model | Task | Arm | Accepted | Wall seconds | Treatment |
|---|---|---|---:|---:|---|
| deepseek/deepseek-flash:off | hard-lifecycle-extract | changeset | no | 542.32 | additional observation |
| deepseek/deepseek-flash:off | hard-lifecycle-extract | agent | yes | 335.61 | additional observation |
| openai-codex/gpt-6.1-sol:low | hard-dependency-handoff | agent | yes | 245.25 | reused in comparison |
| openai-codex/gpt-6.1-sol:low | hard-dependency-handoff | changeset | no | 713.55 (estimated) | additional observation |

The Sol-only changeset trial finished uninterrupted while its original scheduler was stopped. Its process duration was reconstructed from process start and result completion; its worker duration remains recorded. It is outside the reduced comparison.
