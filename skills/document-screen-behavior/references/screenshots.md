# Capturing screen states

A screen page without images asks the reader to trust prose about pixels. Capture every documented state, commit the files, and link each one where it belongs.

## Before anything: establish your eyes

Capturing is not seeing. Run the sibling `see` skill's probe and carry the result:

- `host-vision` — open the PNG and inspect it yourself.
- `codex-relay` — you cannot see it. Ask `codex-see` about the image and attribute every visual observation to the relay.
- `source-only` — you have no eyes. Still capture and link the files; the reader can see them. Do not write any claim about how the page looks, and say in the handoff that the captures are unverified.

A model that cannot see an image will describe it fluently anyway. This probe is the guard against that.

## Tooling

Use the sibling `uishot` skill. Resolve `UISHOT` to the absolute path of its `scripts/uishot`, and run `"$UISHOT" setup` once per machine.

```bash
"$UISHOT" <url> --out docs/screenshots/SCRN-001/default.png
"$UISHOT" <url> --viewport 390x844 --out docs/screenshots/SCRN-001/default-mobile.png
"$UISHOT" <url> --full-page --out docs/screenshots/SCRN-001/default-full.png
```

Run from the project root. Use `--wait-for` on a selector that only exists in the state you want — this both pins the capture and proves you captured the right state.

## Getting past the sign-in wall

Most screens worth documenting require a session.

1. Start the app with seeded data.
2. Sign in once in the warm browser: `"$UISHOT" <login-url> --headed`, complete the sign-in, and leave the browser running.
3. Capture with `--reuse-session` so later shots carry the cookies.
4. Do not run `"$UISHOT" stop` until the whole set is captured — it discards the session.

To capture a state that belongs to a different group, sign in as that group's seeded user and capture that set before switching back. Note the account in the manifest's data-set column.

## Data rules

**Never capture real customer data.** Use a seed, demo, or fixture organization. If real data reaches a capture, delete the file — do not crop it — and re-capture against seed data. Redaction is a last resort and must be visible as redaction.

**Realistic, not empty.** A default state captured against an empty database is an empty-state screenshot mislabeled. Seed enough records that ranking, truncation, and counts show their real behavior: more rows than the display limit, several distinct statuses, names of realistic length, dates spanning the relevant windows.

**Deterministic.** Prefer fixed seed data over live data so a re-capture is comparable. Note anything time-relative in the manifest — a screenshot of "3 days overdue" ages.

## Which states to capture

Capture in this order and stop only when you run out of reachable states:

| Priority | State | How to reach it |
|---|---|---|
| Required | default | Seeded data, primary group |
| Required | empty | Seed account with no records |
| Required | error | Block or fail the data request |
| Required | first-run, where one exists | New account with no history |
| Required | one narrow-viewport capture | `--viewport 390x844` |
| Strong | per-group variants | Sign in as each group whose screen differs |
| Strong | loading | `--wait-for` the skeleton, or throttle the response |
| Strong | partial | Fail one region's source |
| Useful | read-only, permission-denied, updating, offline | Adjust permissions or connectivity |

Capture the viewport by default. Use `--full-page` when the page is long enough that the viewport misrepresents it.

## Naming and location

```
docs/screenshots/SCRN-###/<state>[-<group>][-<viewport>].png
```

Examples: `default.png`, `default-mobile.png`, `default-interviewer.png`, `error-region.png`.

Lower-case, hyphenated, no dates in the file name — the manifest carries the date, so a re-capture overwrites in place and the diff shows the change. Use `--scale 1` to keep files small unless fine detail matters.

## Linking

Inline, inside the state it documents, immediately after that state's description:

```markdown
### Empty

**Trigger.** The account has no records yet.
**Result.** Each region shows its own empty message.

![SCRN-001 empty state](../screenshots/SCRN-001/empty.png)
```

Alt text names the screen and the state. Paths are repository-relative from the document. Every image also gets a row in `Visual evidence`:

| State | File | Viewport | Data set | Captured | Version |
|---|---|---|---|---|---|
| Default | `docs/screenshots/SCRN-001/default.png` | 1280×800 | seed-org, org-admin | 2026-08-02 | v0ecacd0b767b |

## When you cannot capture

Write the state's row with `Not captured.` and the reason in place of the path:

| First run | Not captured — no seeded account with zero records | — | — | — | — |

Then open a question to get the fixture built. Never describe an uncaptured state as though you saw it, and never leave the row out — a missing row reads as a state that does not exist.

## Keeping captures honest

- Re-capture whenever `verified_against` changes.
- Check `console_errors:` in the tool output before concluding the page is broken.
- If `readiness:` reports `dom-NEVER-QUIET`, the image may be mid-render — re-run with `--wait-for` rather than accepting it.
- Add the app's own scratch output directory (`.uishot/`) to `.gitignore`. Committed captures live under `docs/screenshots/` and are deliberate.
