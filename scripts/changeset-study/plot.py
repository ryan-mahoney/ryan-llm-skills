"""Render a standalone figure: uv run --with matplotlib==3.11.2 plot.py REPORT_JSON OUTPUT_PREFIX."""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
matplotlib.rcParams["svg.hashsalt"] = "changeset-study-v1"
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

report = json.load(open(sys.argv[1], encoding="utf-8"))
models = report["manifest"]["models"]
audited = {row["cell"]: row["supplemental_accepted"] for row in (report.get("supplemental") or {}).get("rows", [])}
labels = {"deepseek/deepseek-flash:off": "DeepSeek V4.1 Flash",
          "openai-codex/gpt-6.1-sol:low": "Sol 6.1",
          "openrouter/inception/mercury-2.5:low": "Mercury 2.5"}
fig, axes = plt.subplots(1, len(models), figsize=(12, 4.9), sharex=True, sharey=True)
for ax, model in zip(axes, models):
    rows = [c for c in report["cells"] if c["selector"] == model]
    both_failed = 0
    for agent in [c for c in rows if c["arm"] == "agent"]:
        changeset = next(c for c in rows if c["arm"] == "changeset" and
                         c["task"] == agent["task"] and c["repetition"] == agent["repetition"])
        agent_ok = audited.get(agent["evidence_directory"], agent["accepted"])
        changeset_ok = audited.get(changeset["evidence_directory"], changeset["accepted"])
        passed = agent_ok and changeset_ok
        both_failed += not agent_ok and not changeset_ok
        ax.scatter(agent["process_elapsed_ms"] / 1000 if agent_ok else 300,
                   changeset["process_elapsed_ms"] / 1000 if changeset_ok else 300,
                   marker="o" if passed else "x", color="#176b87" if passed else "#b34c22",
                   s=45, alpha=0.85, linewidths=1.5)
    ax.plot([1, 360], [1, 360], color="#777777", linestyle="--", linewidth=1)
    ax.set(xscale="log", yscale="log", xlim=(2, 360), ylim=(2, 360),
           title=labels[model], xlabel="Conventional agent (seconds)")
    ax.set_xticks([3, 10, 30, 100, 300], labels=["3", "10", "30", "100", "300"])
    ax.set_yticks([3, 10, 30, 100, 300], labels=["3", "10", "30", "100", "300"])
    ax.grid(True, which="major", alpha=0.2)
    ax.text(0.04, 0.94, "Below line: changeset faster", transform=ax.transAxes,
            fontsize=8, va="top", color="#444444")
    if both_failed > 1:
        ax.annotate(f"{both_failed} overlapping pairs", (300, 300), xytext=(-7, -17),
                    textcoords="offset points", ha="right", fontsize=8, color="#b34c22")
axes[0].set_ylabel("Changeset (seconds)")
fig.suptitle("Matched trials after supplemental contract checks (post-hoc)" if audited else
             "Matched end-to-end trials with original frozen grading", fontsize=13)
fig.legend(handles=[Line2D([], [], marker="o", linestyle="", color="#176b87", label="Both accepted"),
                    Line2D([], [], marker="x", linestyle="", color="#b34c22", label="One or both failed")],
           loc="lower center", bbox_to_anchor=(0.5, 0.06), ncol=2, frameon=False)
fig.text(0.5, 0.015, "Each point is one matched repetition. Eight workload families, two repetitions each. Log scales.\n"
         "Failure positions show the preregistered cap, not observed runtime. This small corpus does not establish general superiority.",
         ha="center", fontsize=8, color="#444444")
fig.tight_layout(rect=(0, 0.17, 1, 0.94))
fig.savefig(sys.argv[2] + ".svg", metadata={"Date": None})
svg = Path(sys.argv[2] + ".svg")
svg.write_text("\n".join(line.rstrip() for line in svg.read_text().splitlines()) + "\n")
fig.savefig(sys.argv[2] + ".png", dpi=160)
