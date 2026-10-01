# Capture root

Every skill that writes captures follows this one convention: captures are
generated artefacts that stay out of commits, and committed documents refer to
them by ID rather than by path.

## Root

The default capture root is `.specs/images/` in the primary checkout. Resolve it
from any worktree with the repository's common git directory:

```bash
root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.specs/images"
```

A repository that already commits its captures — for example under
`docs/screenshots/` — may declare a different root in its instruction file or
its documentation standard. Writers then use the declared root, and the layout
below is unchanged under it. That declaration is the only override; it adds no
config file and no second convention.

## Safety

Before writing any capture, prove the root is ignored:

```bash
git check-ignore -q "$root"
```

If that command fails, stop and ask for the root to be ignored. A committed
capture file is the failure this check exists to prevent.

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
column, never by an embedded image link and never by a `.specs/` path. Say this
sentence in the document:

> Captures are generated locally, are not committed, and resolve by ID under the capture root.

The viewport, data set, date and version stay in the citing document's own
evidence table.

## Validation

When the capture root exists in this checkout, check that every cited ID
resolves to a file under it. When it does not exist here, the document says the
check was not possible in this checkout rather than implying a pass.
