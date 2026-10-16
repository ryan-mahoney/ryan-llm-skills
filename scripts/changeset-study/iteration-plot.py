"""Stage timing of every development attempt, with unsuccessful delivery marked."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

source, prefix = sys.argv[1:]
report = json.loads(Path(source).read_text())
groups = ["Planning / native agent", "Apply / editors", "Visible + candidate checks", "Impact review", "Terminal grading", "Other"]
colors = ["#5365a9", "#3b9a97", "#d9a441", "#9b78b4", "#91a4b8", "#d8dce3"]
category = {"planning": 0, "repair-planning": 0, "discovery-planning": 0, "implementation": 0, "repair": 0,
            "execution": 1, "visible-check": 2, "impact-review": 3, "terminal-grading": 4}
titles = {"hard-context-calibration": "Context calibration", "hard-dependency-handoff": "Dependency handoff",
          "hard-lifecycle-extract": "Lifecycle extraction"}
plt.rcParams.update({"font.family": "DejaVu Sans", "svg.fonttype": "none", "font.size": 10})
fig, axes = plt.subplots(3, 1, figsize=(12, 10.5))
fig.suptitle("Sol-only changesets: where each iteration spends time", x=.025, ha="left", fontsize=17, weight="bold")
for ax, reference in zip(axes, report["references"]):
    task = reference["task"]
    rows = [("Native reference", reference, True)] + [(r["run"], next((c for c in r["cells"] if c["task"] == task), None), False) for r in report["iterations"]]
    maximum = max([r[1]["process_elapsed_ms"] / 1000 for r in rows if r[1]] + [1])
    for y, (label, cell, native) in enumerate(rows):
        if cell is None:
            ax.text(1, y, "pending", va="center", fontsize=9)
            continue
        stages = [0.] * len(groups)
        for stage in cell["stages"]:
            stages[category.get(stage["name"], 5)] += stage["elapsed_ms"] / 1000
        seconds = cell["process_elapsed_ms"] / 1000
        stages[5] += max(0, seconds - sum(stages))
        delivered = native or cell["delivered"]
        left = 0
        for duration, color in zip(stages, colors):
            ax.barh(y, duration, left=left, height=.62, color=color,
                    hatch=None if delivered else "///", edgecolor="white", linewidth=.35)
            left += duration
        ax.text(seconds + maximum * .015, y, f'{seconds:.1f}s · {"delivered" if delivered else "incomplete"}', va="center", fontsize=9)
    ax.axvline(reference["process_elapsed_ms"] / 1000, color="#374151", linestyle=":", alpha=.6)
    ax.set_yticks(range(len(rows)), [r[0] for r in rows])
    ax.set_ylim(len(rows) - .4, -.6)
    ax.set_xlim(0, maximum * 1.36)
    ax.set_title(titles[task], loc="left", weight="bold")
    ax.set_xlabel("Elapsed seconds (actual attempts, including failures)")
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="x", alpha=.15)
    ax.set_axisbelow(True)
fig.legend([Patch(color=c) for c in colors], groups, loc="upper left", bbox_to_anchor=(.02, .955), ncol=3, fontsize=9)
fig.text(.025, .015, "Hatched bars did not fully deliver. Dotted lines mark the historical native reference.\n"
         "Adaptive development on three exposed tasks; no population speedup claim. Native-agent time includes its own tools and checks.",
         color="#4b5563", fontsize=9)
fig.tight_layout(rect=[.01, .065, .99, .9], h_pad=1.7)
for suffix in ("svg", "png"):
    fig.savefig(f"{prefix}.{suffix}", dpi=170, facecolor="white", metadata={"Creator": "changeset-study"})
svg = Path(f"{prefix}.svg")
svg.write_text("\n".join(line.rstrip() for line in svg.read_text().splitlines()) + "\n")
print(json.dumps({"figures": [f"{prefix}.svg", f"{prefix}.png"]}))
