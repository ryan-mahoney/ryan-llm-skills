"""Render the combined-workflow report with failed trials visibly distinguished."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

source, prefix = sys.argv[1:]
report = json.loads(Path(source).read_text())
arms = ["agent", "changeset-mixed"]
labels = ["Sol native", "Sol + Nemotron"]
colors = ["#4056a1", "#159a91"]
tasks = [p["task"] for p in report["pairs"]]
task_labels = {
    "hard-dependency-handoff": "Dependency handoff",
    "hard-admission-overlap": "Admission overlap",
    "hard-wave-recovery": "Wave recovery",
    "hard-fallback-setup": "Fallback setup",
    "hard-lifecycle-extract": "Lifecycle extraction",
    "hard-context-calibration": "Context calibration",
}
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "none"})
fig, (left, right) = plt.subplots(1, 2, figsize=(12.5, 5.5), gridspec_kw={"width_ratios": [1, 2.6]})
fig.suptitle("Hard workloads: Sol native vs Sol + Nemotron", x=.04, ha="left", fontsize=17, weight="bold")
for i, summary in enumerate(report["summaries"]):
    left.bar(i, summary["n"], width=.58, color="#e5e7eb")
    left.bar(i, summary["accepted"], width=.58, color=colors[i])
    left.text(i, summary["n"] + .15,
              f'{summary["accepted"]}/{summary["n"]} checks\n{summary["delivered"]}/{summary["n"]} delivered',
              ha="center", fontsize=10, weight="bold")
left.set_xticks([0, 1], labels)
left.set_ylim(0, len(tasks) + 1)
left.set_yticks(range(len(tasks) + 1))
left.set_ylabel("Tasks passing external checks")
left.set_title("Behavior checks and delivery", loc="left", pad=16)

for i, arm in enumerate(arms):
    for j, task in enumerate(tasks):
        row = next((c for c in report["cells"] if c["arm"] == arm and c["task"] == task), None)
        y = j + (i - .5) * .35
        if row is None:
            right.text(.2, y, "unrun", va="center", color="#6b7280", fontsize=8)
            continue
        minutes = row["capped_time_to_success_ms"] / 60000
        right.barh(y, minutes, height=.30, color=colors[i], alpha=1 if row["accepted"] else .5,
                   hatch=None if row["accepted"] else "///", edgecolor=colors[i])
        right.text(minutes + .25, y, f'{row["process_elapsed_ms"]/60000:.1f}m' + (" failed" if not row["accepted"] else ""), va="center", fontsize=8)
right.set_yticks(range(len(tasks)), [task_labels.get(t, t) for t in tasks])
right.set_ylim(len(tasks) - .4, -.6)
right.set_xlim(0, 31)
right.set_xlabel("Failure-adjusted minutes (failed trial = 25 min)")
right.set_title("Same six tasks, one trial per workflow", loc="left", pad=16)
fig.legend(handles=[Patch(color=c, label=l) for c, l in zip(colors, labels)] +
             [Patch(facecolor="#e5e7eb", hatch="///", label="Failed; label shows actual time")],
             loc="upper left", bbox_to_anchor=(.41, .91), ncol=3, fontsize=8)
for ax in (left, right):
    ax.spines[["top", "right"]].set_visible(False)
    ax.set_axisbelow(True)
right.grid(axis="x", alpha=.15)
left.grid(axis="y", alpha=.15)
mixed = next(s for s in report["summaries"] if s["arm"] == "changeset-mixed")
caption = (f'{len(report["cells"])}/12 trials complete. Nemotron: {mixed["nemotron_requests"]} editor requests across '
           f'{mixed["trials_using_nemotron"]}/{mixed["n"]} combined trials. '
           'Exploratory workflow comparison; no general performance claim.\n'
           'Times include planning, execution, checks, review, repair and grading. Scope reduced during execution; prior observations retained.\n'
           'Bars score external checks. Complete delivery also requires successful execution, visible checks and reviewer acceptance.')
fig.text(.04, .025, caption, fontsize=9, color="#4b5563", va="bottom")
fig.tight_layout(rect=[.02, .12, .99, .93], w_pad=3)
for suffix in ("svg", "png"):
    fig.savefig(f"{prefix}.{suffix}", dpi=170, facecolor="white", metadata={"Creator": "changeset-study"})
svg = Path(f"{prefix}.svg")
svg.write_text("\n".join(line.rstrip() for line in svg.read_text().splitlines()) + "\n")
print(json.dumps({"figures": [f"{prefix}.svg", f"{prefix}.png"]}))
