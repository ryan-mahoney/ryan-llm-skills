---
name: design-run
description: "Produce a planned design package with one self-contained HTML/Tailwind screen and matching Markdown interaction guide per step; capture, inspect and review the screens through the brief's lenses. Use when the user says 'build the screens', 'produce the design', 'run the design', 'rebuild screen 3', or after design-plan has written design.json. Resumes missing screens and guides."
argument-hint: "<workspace-id> <design-slug> [--step N | --from N] [--review-only]"
disable-model-invocation: true
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Design Run — One Screen Per Step

Produce the screens an existing `design.json` names, in step order, each as one
self-contained HTML file that uses the design system through a vendored Tailwind runtime
and a same-basename Markdown guide to the user's interactions and journey.
Lint, capture and inspect every screen at every declared width, correct what the captures
show, then review the whole set through the lenses in `brief.md`. One model does all of it.

Contract: [Design packages](../../docs/design-packages.md). Content rule for every screen:
[prototype-design.md](../../rules/prototype-design.md). Run non-interactively; make
grounded decisions from the brief, the design system and the context, and list them in the
output.

## Arguments

- `workspace-id`, `design-slug` — resolve `<workspace-dir>/designs/<slug>/` as `design-plan`
  does. Stop with `outcome: blocked`, `reason: missing-design` when there is no `design.json`.
- `--step N` — rebuild exactly one screen and its guide, even when already produced.
- `--from N` — produce step N and every later screen, replacing HTML and guides from N on.
- `--review-only` — skip production; review the produced screens and guides. Report missing
  or outdated guides; refresh guides for any screens changed by the review.
- Default: produce missing HTML in step order, fill missing guides for existing HTML without
  rebuilding those screens, then review.

## Step 0 — Preflight

1. Read `design.json`, `brief.md`, the design-system documents and token source it names (absolute paths from
   `node ~/.agents/scripts/design/cli.mjs system <design-dir>`),
   the posture rule the brief chose, [prototype-design.md](../../rules/prototype-design.md),
   [ux-states.md](../../rules/ux-states.md), and the wording rules that apply
   ([cta-design.md](../../rules/cta-design.md), [form-design.md](../../rules/form-design.md),
   [table-row-design.md](../../rules/table-row-design.md)).
2. Vendor the runtime: `node ~/.agents/scripts/design/cli.mjs vendor <design-dir>`. It
   copies the pinned Tailwind play runtime to `vendor/tailwind.js` and refuses a digest
   mismatch. Screens reference it as `../vendor/tailwind.js`.
3. Derive status: `node ~/.agents/scripts/design/cli.mjs status <design-dir>`. Decide the
   work list from the arguments. Separately check for `screens/NN-<id>.md`; CLI status
   accounts for HTML and captures, not guides. Missing guides need a documentation pass.
4. When producing or visually reviewing HTML, establish eyes with the sibling `see` skill
   once: `host-vision`, `codex-relay`, or `source-only`. In `source-only` mode every visual check below is recorded as not
   performed; say so in the output instead of implying inspection.
5. When producing or visually reviewing HTML, serve the design directory on loopback
   in the background:
   `python3 -m http.server <port> --directory <design-dir> --bind 127.0.0.1`. Pick an
   uncommon port and bump it on collision. Screens open at
   `http://127.0.0.1:<port>/screens/NN-<id>.html`.

## Step 1 — Produce one screen

Repeat for each screen in the work list, in step order. Finish one screen before starting
the next.

1. **Start from the shell.** When `shell_from` names a step, copy that produced file to
   this screen's path and edit it. Keep its chrome, tokens and layout; change only what
   this screen and state require. Never regenerate shared chrome from scratch; drift
   between screens is a defect. When `shell_from` is null, write the file new.
2. **Build the screen.** `<!doctype html>`, a `<title>` equal to the screen title,
   `<script src="../vendor/tailwind.js"></script>`, and an inline
   `<script>tailwind.config = { theme: { extend: { ... } } }</script>` carrying the design
   system's colors, fonts, spacing and radii. Fonts: system stacks, or a `.woff2` copied
   into `vendor/` and declared with `@font-face` by relative path. No other resource
   outside the design folder.
3. **Content.** Apply [prototype-design.md](../../rules/prototype-design.md) literally. The
   person named in the index must be able to make the decision or take the action the job
   names. Realistic domain content from the context, consistent with the other screens
   (same route names, same counts, same dates). The primary action is a `<button>` or
   `<a>` labelled verb + object. The state is simply rendered: an empty screen is empty
   with one way forward, an error screen says what failed and how to recover, a loading
   screen shows the skeleton of the ideal layout. No labels, switchers, notes or
   explanations about the screen itself anywhere in the markup.
4. **Floor.** Semantic landmarks and headings, AA contrast, visible focus styles, every
   control reachable by keyboard, and the layout intact at every declared width.
5. **Lint.** `node ~/.agents/scripts/design/cli.mjs lint <design-dir>`. Fix every `fail`
   before capturing. Read every `warn`: a flagged phrase is either rewritten or kept with
   a reason in the screen's `notes`.
6. **Capture and look.** With the sibling `uishot` skill, capture the served URL at each
   declared width: `"$UISHOT" <url> --viewport <width>x900 --out <design-dir>/captures/NN-<id>@<width>.png`.
   Check `console_errors:` first. Then inspect each capture with the established eyes for:
   styles applied at all (a failed runtime load reads as raw HTML); layout intact, nothing
   clipped, overlapping or off-canvas; the state actually visible; text legible at the
   rendered size; the primary action where the decision lands. Correct, recapture, and
   look again. Stop when a pass finds nothing new; two or three rounds is normal.
7. **Record outside the file.** Update `design.json` atomically: set `notes` for this
   screen (what the state shows, why the hierarchy is what it is, warnings kept with
   reasons) and add any `deviations` with token, before, after and reason. Never change a
   screen's `step`, `id`, `person`, `job`, `kind` or `state` here; a different inventory is
   a planning change and goes back to `design-plan`.
8. **Write the interaction guide.** Write `screens/NN-<id>.md` beside the HTML, following
   the [interaction guide contract](../../docs/design-packages.md#screen-interaction-guides).
   Read the final screen, the brief and related screens before writing. Explain the person's
   goal, what informs their decision, each meaningful action and its outcome, and how they
   enter and leave this part of the process. Use exact visible control labels and relative
   links to related screens and guides. Cover this state's feedback, recovery and retained
   context. Distinguish intended product behavior from what the prototype demonstrates;
   record unresolved outcomes rather than inventing them. Keep implementation details out.

For an existing screen missing only its guide, perform step 8 from the existing HTML and
brief. Do not rebuild or recapture unchanged HTML merely to add documentation.

## Step 2 — Lens review

After the last screen in the work list (or immediately with `--review-only`):

1. Reread every produced screen, in the captures, through each lens in `brief.md`: for
   every subject-matter expert and designer, what would they say is wrong or missing on
   each screen for the job it names? Argue from the principle each lens advocates and why
   it applies here, not from "X would not like it".
2. Write `review.md`: a table of findings with screen, lens, finding, consequence for the
   person's job, and the change made or the reason it was declined. State what is strong
   only when a lens genuinely has nothing to add.
3. Apply the changes to the affected screens. Each changed screen goes back through
   lint, capture and inspection. Refresh its guide and any related guides whose journey
   descriptions changed. Update `notes` where the reasoning changed.
4. Read each guide against its screen and brief: controls, outcomes, state, links and
   continuity must agree. Related state variants are alternatives, not consecutive steps.

## Step 3 — Final checks

- `node ~/.agents/scripts/design/cli.mjs lint <design-dir>` is `pass` or `warn` with every
  warning explained in `notes`.
- `node ~/.agents/scripts/design/cli.mjs status <design-dir>` shows every screen in the
  work list produced and captured at every width.
- Every HTML screen in scope has a nonempty same-basename `.md` guide. Check relative
  links and descriptions against the final screens; report missing or unresolved content.
- Stop the loopback server you started.

## Output

Report this compact summary before any commentary:

- `outcome`: `produced`, `partial` (with steps missing screens or guides and why) or
  `blocked` (with `reason`).
- Design directory, screens and guides produced or refreshed this run, captures per screen.
- Vision mode used and what inspection corrected; or that it was not performed, and why.
- Lint result and any warnings kept, with reasons.
- Review: findings count, changes applied, changes declined.
- Deviations recorded.
- Reference lines for the produced screens:
  `node ~/.agents/scripts/design/cli.mjs ref <design-dir> <step>` for each, so a spec can
  cite them.
- Next: open the design in Sentinel's workspace view, or cite screens from a spec.

Never write into a repository, a spec package or anywhere outside the design directory.
Do not add Co-Authored-By trailers, "Generated with" footers, or model attribution to any
artifact.
