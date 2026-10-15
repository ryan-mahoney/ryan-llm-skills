---
name: design-prototype-explode
description: "Split a compound HTML prototype with screen or state switchers into a workspace design package: one offline HTML file and granular Markdown interaction/context guide per reachable screen-state. Use when the user says 'explode this prototype', 'split this prototype into screens', or 'extract the states'. Preserves the source design rather than redesigning it."
license: MIT
metadata:
  version: "1"
---

# Design Prototype Explode

Extract the distinct screens and states from an existing interactive prototype. Produce
one independently openable HTML file and a matching Markdown interaction guide for each,
using the [design package contract](../../docs/design-packages.md). Preserve the original
content, shared chrome, styling and meaningful product interactions. Remove demonstration
controls that exist only to select a screen or simulate a state.

## Inputs and destination

Accept a workspace ID, design slug and one or more compound HTML prototype paths. Accept
optional context files or folders, such as a brief, interaction notes or requirements.
The conversation can supply these inputs; do not require a separate context file.

Example invocation:

```text
design-prototype-explode agent-tooling dispatch-extracted /path/compound.html --context /path/notes.md
```

Resolve the workspace with `node ~/.agents/scripts/workspaces/cli.mjs show <id> --json`.
Write the package inside its `designs/<slug>/` directory. Any sibling packages needed
for the inventory limit also stay inside that workspace's `designs/` directory.
If the workspace cannot be resolved,
report the workspace CLI's remedy. Leave all source prototypes and context files intact.
Use a new design directory by default. Do not overwrite an existing package unless the
user explicitly requested replacement; otherwise choose a distinct slug and report it.

Read [prototype-design.md](../../rules/prototype-design.md) and
[ux-states.md](../../rules/ux-states.md) to distinguish rendered product states from
demonstration controls. This is an extraction task: do not invent missing UX states,
choose new expert lenses, rewrite product wording, or redesign the original surface.
Record discovered gaps for later design work.

## 1. Discover the screen and state inventory

Read every supplied prototype and context source. Identify how the prototype switches:
hidden panels, tabs, selectors, URL/hash parameters, JavaScript templates, state objects,
or interactions that reveal dialogs, overlays and alternate outcomes.

Establish image viewing with the sibling `see` skill before making visual claims. Serve
the source on loopback and use browser automation to activate each reachable combination.
Inspect event handlers and templates as well as the rendered document; capturing only the
initial view misses runtime-created states. Use a clean browser context or reset the
fixture between paths so a prior selection or saved draft cannot contaminate another state.

Inventory distinct user-visible screen × state combinations, including meaningful dialogs
and flow steps. Different navigation destinations remain distinct even when they share a
state label. Do not create an unrestricted Cartesian product of controls: include reachable
combinations that change the user's decision, action or feedback. Record aliases and
combinations omitted because they produce the same experience.

For each entry, record:

- The source prototype, switch values or interaction sequence that reaches it, and an
  identifying heading or content cue.
- A stable ID, title, person, job, kind and state from the package schema. Derive these
  from supplied context and observed content; label inferred goals as assumptions.
- Its shared shell, primary action, incoming/outgoing relationships and relevant source
  context sections.

Keep the source's task/flow order where meaningful. Put the primary shell before screens
that reuse it. A variant such as validation-error uses schema state `error` and keeps its
specific meaning in the ID/title and guide. Do not merge distinct errors or selections
merely because the schema gives them the same state. Preserve all supplied content even
when a person or outcome is unresolved; record the uncertainty rather than inventing it.

Choose viewport posture and widths from the source or supplied context. If unspecified,
infer them from the layout and declare the assumption in `brief.md`. Respect package
limits; when more than 100 distinct entries are needed, create linked packages rather
than dropping states. If a runtime-only state cannot be reached with available tooling,
record the unresolved entry and report partial extraction, not complete coverage.

## 2. Extract independent HTML screens

Choose the extraction method that fits the source: isolate an existing panel, materialize
a runtime template, or serialize the activated document and normalize it. Do not use a
generic text replacement to guess arbitrary JavaScript switching behavior.

Write `screens/NN-<id>.html` for every extracted entry:

- Preserve the document shell, relevant styles, wrapper attributes, theme, assets and
  representative content. Set the document title to the inventory title.
- Keep only this screen/state's content and required background context. A dialog keeps
  its underlying page; inactive variants and the demonstration switcher are removed.
- Materialize runtime state that serialization omits: input values, checked/selected
  controls, textarea content, open disclosures and necessary rendered graphics. Preserve
  semantic markup; do not replace the whole interface with a screenshot.
- Remove switching/bootstrap logic that resets the file to the initial view. A fresh
  load must render the named state without a preceding click, stored preference or query
  parameter. Loading, error and pending examples must remain in their named state.
- Preserve real product navigation, tabs and local interactions. Rewrite represented
  cross-screen transitions to relative extracted-file links, carrying necessary context
  without depending on the original compound file. Do not leave state-selection controls
  disguised as product navigation. Document unsupported transitions without inventing a
  successful destination.
- Localize required resources inside the design directory and rewrite their paths. If
  the source uses Tailwind's play runtime, vendor the pinned runtime with
  `node ~/.agents/scripts/design/cli.mjs vendor <design-dir>`. Inline-CSS sources do not
  need conversion to Tailwind. No network requests or real form submissions remain.

Copy shared chrome from the first extracted shell when editing later files. Preserve
existing accessibility semantics and focus treatment. Record source defects or necessary
conversion changes rather than silently redesigning them.

## 3. Split or create granular context

Write `screens/NN-<id>.md` for every HTML file, following the
[interaction guide contract](../../docs/design-packages.md#screen-interaction-guides).
This companion is the screen's granular context document, not implementation notes.

When context sources exist, map their requirements to the extracted entries. Split by
meaning, not heading boundaries alone: a paragraph about a multi-step flow can apply to
several screens. Include each applicable requirement, constraint, decision and uncertainty
in the relevant guide. Shared requirements stay in `brief.md`; repeat a shared constraint
in a guide when the reader needs it to understand that screen independently. Preserve
useful citations and distinguish original requirements from inferred behavior.

When no context exists for an entry, create its guide from the original interactions,
content and supplied conversation. Explain who arrives, their goal, the information that
supports their decision, exact control labels and outcomes, feedback/recovery, and the
context retained when moving to related screens. Identify missing outcomes as unresolved.
Link actual related HTML files and guides relatively. Alternative states are not
necessarily consecutive journey steps.

Record which supplied context sections went to which guide in `extraction.md`. Put
package-wide material in the brief and identify unrelated sections left out, with reasons.
Do not lose a relevant requirement because it is absent from the visible HTML. If context
and prototype conflict, preserve that discrepancy explicitly; extraction does not choose
a new product policy. Avoid copying the entire source context into every companion.

## 4. Assemble and verify the package

Write `brief.md` and `design.json` under the existing schema. The brief records the people
and jobs, source design, viewport posture, shared context, assumptions, gaps and inventory.
Preserve supplied lenses if any; do not claim a new expert review. Record a design system
only when its identity is established from the source or workspace kit. A source with no
named system retains its own styles; note that limitation before later redesign work.
The index's optional `context` lists the actual referenced source paths, not invented
files. Write index updates atomically.

Write `extraction.md` with source identities/digests, the activation-to-output mapping,
context coverage, aliases, excluded duplicates, unresolved entries and conversion changes.
Keep these technical extraction details outside the per-screen interaction guides.

Verify each output independently:

1. Run `node ~/.agents/scripts/design/cli.mjs lint <design-dir>`. Fix failures and explain
   retained warnings in the screen's `notes`.
2. Use the sibling `uishot` skill to capture each extracted screen at every declared width
   into `captures/NN-<id>@<width>.png`. Compare it with the activated source at the same
   width, allowing for removal of demonstration controls. Check console errors, preserved
   content/chrome and the named state on a fresh load. Record unperformed visual checks
   explicitly in `source-only` mode.
3. Exercise representative real transitions, including a dialog/recovery path where one
   exists. Check relative assets and links without relying on the compound source file.
4. Check every HTML has a nonempty matching guide and that context coverage and guide
   descriptions agree with the source. Reconcile the discovered inventory with extracted
   outputs so an unbuilt runtime state cannot disappear from the completion claim.

Correct extraction drift and refresh affected guides. Stop any loopback servers started
for this task. Do not add a `review.md` claiming a lens review unless one actually ran.

## Output

Report the outcome (`extracted`, `partial` or `blocked`), design directory, source files,
discovered/extracted counts, matching-guide count, captures and vision mode. State lint
and link-check results, unresolved states, context conflicts and conversion changes.
Include a few representative HTML/guide links and the package's `extraction.md` path.
The result is ready to inspect in the design viewer or reference from a spec; extraction
does not imply backend implementation or authorize publication.
