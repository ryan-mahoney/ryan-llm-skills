"""Export figures from committed study data; invoked by build.mjs."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent
report = json.loads((ROOT.parent / 'results.json').read_text())
sol = next(c for c in report['comparisons'] if 'gpt-6.1-sol' in c['selector'])
plt.rcParams.update({'svg.hashsalt': 'changeset-visual-v1', 'font.family': 'DejaVu Sans',
                     'font.size': 11, 'text.color': '#21332e', 'axes.labelcolor': '#21332e',
                     'xtick.color': '#52615b', 'ytick.color': '#21332e'})
COLORS = ['#52615b', '#087760']

def save(fig, name):
    path = ROOT / f'{name}.svg'
    fig.savefig(path, facecolor='#ffffff', metadata={'Date': None}, bbox_inches='tight')
    path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines()) + '\n')
    plt.close(fig)

metrics = [
    ('time', 'Mean seconds per trial', lambda a: a['total_wall_ms'] / a['n'] / 1000, lambda v: f'{v:.2f} s'),
    ('calls', 'Model calls across 16 trials', lambda a: a['model_calls'], lambda v: f'{v:,}'),
    ('tokens', 'Reported tokens across 16 trials', lambda a: a['tokens']['totalTokens'], lambda v: f'{v:,}'),
    ('cost', 'Equivalent USD across 16 trials', lambda a: a['total_equivalent_usd'], lambda v: f'${v:.5f}')]
for name, label, value, display in metrics:
    values = [value(sol['arms'][arm]) for arm in ['agent', 'changeset']]
    fig, ax = plt.subplots(figsize=(3.6, 2.3))
    ax.barh([1, 0], values, height=.32, color=COLORS)
    ax.set_yticks([])
    ax.set_xlim(0, max(values) * 1.04)
    ax.set_ylim(-.65, 1.65)
    ax.set_xlabel(label, fontsize=11, labelpad=10)
    ax.set_xticks([0, max(values)], ['0', display(max(values))])
    ax.tick_params(length=0, pad=8)
    for y, v, arm in zip([1, 0], values, ['Native agent', 'Changeset']):
        ax.text(0, y+.26, arm, va='bottom', fontsize=12)
        ax.text(max(values)*1.04, y+.26, display(v), ha='right', va='bottom', fontsize=12, weight='bold')
    for spine in ax.spines.values(): spine.set_visible(False)
    save(fig, name)

fig, ax = plt.subplots(figsize=(3.8, 4.6))
models = ['gpt-6.1-sol', 'deepseek-flash', 'mercury-2.5']
labels = ['Sol 6.1', 'DeepSeek V4.1 Flash', 'Mercury 2.5']
for i, key in enumerate(models):
    row = next(c for c in report['comparisons'] if key in c['selector'])
    for arm, offset, color in zip(['agent', 'changeset'], [.19, -.19], COLORS):
        value = row['posthoc_acceptance'][arm]
        y = (2-i)*1.5+offset
        ax.barh(y, value, height=.30, color=color, label=('Native agent' if arm=='agent' else 'Changeset') if i == 0 else None)
        ax.text(value+.3, y, f'{value}/16', va='center', fontsize=12)
    ax.text(0, (2-i)*1.5+.52, labels[i], fontsize=12, weight='bold', va='bottom')
ax.set_yticks([])
ax.set_xlim(0, 20)
ax.set_ylim(-.65, 4.0)
ax.set_xticks([0, 4, 8, 12, 16])
ax.set_xlabel('Accepted trials after supplemental\nchecks (post-hoc)', fontsize=11, labelpad=12)
ax.tick_params(length=0, pad=8)
ax.legend(loc='upper center', bbox_to_anchor=(.5, 1.14), ncol=2, frameon=False, fontsize=11, handlelength=1.2)
for spine in ax.spines.values(): spine.set_visible(False)
save(fig, 'acceptance')
