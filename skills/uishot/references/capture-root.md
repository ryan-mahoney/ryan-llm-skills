# Capture root

Every skill that writes captures follows this one convention: captures are
generated artefacts that stay out of commits, and committed documents refer to
them by ID rather than by path.

## Root

Captures live in workspace storage, outside every checkout, so they are never
committed. Resolve the root for the application checkout being captured:

```bash
node ~/.agents/scripts/spec-location/cli.mjs resolve --cwd <app checkout>
```

The JSON result has `capturesDir` and `repository`. The capture root is
`<capturesDir>/<repository>/images/`. Any worktree of that repository resolves to
the same root. A package whose `locations.json` is already materialized records
the same directory as `captures_dir`.

If the command refuses (exit 2, or exit 1 for an error), print its `message` and
`remedy` and stop. Do not write captures under the checkout instead.

`uishot shot --capture-root` applies this resolution itself and writes to
`<capturesDir>/<repository>/images/`. It is mutually exclusive with `--out-dir`.
On refusal it prints the remedy and exits 2.

A repository that already commits its captures, for example under
`docs/screenshots/`, may declare a different root in its instruction file or
its documentation standard. Writers then use the declared root, and the layout
below is unchanged under it. That declaration is the only override; it adds no
config file and no second convention.

The scratch folder `.uishot/` in the working directory is separate. It holds
ad-hoc screenshots and is not a capture root.

## Safety

The root is outside every checkout, so no ignore check applies. Write captures
only under the resolved root. A repository that declares its own root inside its
checkout runs its own ignore check there.

## Layout

Screens land under the screen owner, journeys under the journey owner:

```
<root>/screens/SCRN-###/<state>[-<group>][-<viewport>].png
<root>/journeys/JRNY-###/<scenario>-s<NNN>[-<slug>].png
```

File names are lower-case and hyphenated, with no dates, so a re-capture
overwrites in place and the diff shows the change.

## IDs

A capture ID is `<owner>/<name>`, where the owner is `SCRN-###` or `JRNY-###`
and the name is the file name without its extension. The owner prefix picks the
folder, and the file's presence is the whole record: a missing file reads as
"Not captured". There is no manifest; nothing else tracks a capture.

## Citing

Committed documents cite a capture by its backticked ID in a `Capture ID`
column, never by an embedded image link and never by a storage path. Say this
sentence in the document:

> Captures are generated locally, are not committed, and resolve by ID under the capture root.

The viewport, data set, date and version stay in the citing document's own
evidence table.

## Validation

When the capture root exists on this machine, check that every cited ID
resolves to a file under it. When it does not exist here, or `resolve` refused,
the document says the check was not possible on this machine rather than
implying a pass.
