---
name: uishot
description: Take a screenshot of a running web app and look at it. Use this whenever you write, change, or debug UI code and want to verify how it actually renders — after adding a component, adjusting layout or spacing, fixing responsive behaviour, or when the user says something "looks wrong". Do not guess at visual output; capture it and inspect the image. Also use it to check a page at a specific viewport width, to capture one component in isolation, or to see console errors on a page.
metadata:
  version: "1"
---

# uishot

Screenshots a page from a running dev server, waits until it has actually
finished rendering, writes a PNG, and prints the absolute path so you can read
the image back and inspect it.

## Resolve the launcher

Before running a command, resolve `UISHOT` to the absolute path of
`scripts/uishot` in this skill directory. Always invoke that path; do not assume
that a global `uishot` command is installed and do not copy `uishot.py` into the
coding project.

The launcher uses `uv` to provide Playwright in an isolated, cached environment.
Run setup once per user account or machine to install Chromium:

```bash
"$UISHOT" setup
```

Do not add Playwright to the coding project's dependencies. Screenshots are
written relative to the current working directory, so run commands from the
project root. Add `.uishot/` to the project's `.gitignore` when appropriate.

## Core loop

Build a small piece of UI, capture it, look at it, correct it, repeat. Do not
write a whole interface and inspect it once at the end.

```bash
"$UISHOT" http://localhost:3000/checkout
```

Then use the local image-viewing tool to inspect the PNG at the printed `file:`
path. Check `console_errors:` before changing CSS or layout.

## Commands

```bash
"$UISHOT" setup                                  # once per machine, installs chromium
"$UISHOT" <url>                                  # capture the viewport
"$UISHOT" <url> --full-page                      # capture the whole scrollable page
"$UISHOT" <url> --selector "#cart"               # capture one component
"$UISHOT" <url> --viewport 390x844               # check a phone width
"$UISHOT" <url> --wait-for ".results"            # capture once this appears
"$UISHOT" status                                 # is the warm browser up
"$UISHOT" stop                                   # shut the warm browser down
```

A bare URL implies `shot`, so `"$UISHOT" shot <url>` and
`"$UISHOT" <url>` are the same.

## Reading the output

Output is `key: value` lines. The two that matter most:

- `file:` — absolute path of the PNG. Read this image.
- `console_errors:` — if non-zero, the individual messages follow on
  `console_error:` lines. A broken-looking UI is very often explained here, so
  check these before theorising about CSS.

`readiness:` lists what was waited on. Two values are worth reacting to:

- `dom-NEVER-QUIET` — the page never stopped changing, so the image may be
  mid-render. Re-run with `--wait-for`.
- `load-STALLED` — a subresource never finished (streaming media is the usual
  cause). The capture is still valid; the page just never fully loaded.

`capture: cdp-direct` or `cdp-fallback` means the screenshot was taken through a
lower-level path because the page never completed loading. The image is fine.

## When to pass an explicit wait condition

The tool waits for load, in-flight requests, web fonts, images, pending
`setTimeout` work, and then 500ms of DOM silence. That covers most apps.

It cannot know about work scheduled further out than that — a poll on a long
interval, a slow websocket push, an animation that starts late. If the captured
image looks empty, skeletal, or stale, do not just retry: pin the capture.

```bash
"$UISHOT" http://localhost:3000/orders --wait-for "[data-testid=order-row]"
"$UISHOT" http://localhost:3000/orders --wait-text "Total"
```

`--selector` also acts as a wait condition, so capturing a component implicitly
waits for it.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | captured | read the PNG |
| 2 | bad arguments | check the flag it names |
| 3 | selector not found / zero size | fix the selector or raise `--timeout` |
| 4 | navigation failed or 4xx/5xx | is the dev server running on that URL |
| 5 | browser would not start | read the `log:` path it prints |
| 6 | timed out | raise `--timeout` |
| 7 | chromium/playwright missing | run `"$UISHOT" setup` |

Every failure prints a `next_action:` line. Follow it rather than retrying the
same command.

## Useful flags

- `--out PATH` — exact output path. Otherwise auto-named under `.uishot/`.
- `--quiet-ms N` — DOM silence required before capture (default 500). Lower it
  to ~200 for a faster loop on simple pages.
- `--min-wait N` — always wait at least this long; blunt but effective on apps
  known to render late.
- `--scale N` — device pixel ratio, default 2. Use `--scale 1` for smaller files.
- `--no-freeze` — keep CSS animations running. They are frozen by default so
  repeat captures are comparable.
- `--reuse-session` — use the warm browser's cookies for pages behind a login.
  Forces 1x scale.
- `--headed` — watch the browser, for debugging the tool itself.
- `--wait-until load` — stricter navigation gate. Rarely needed, and it hangs on
  pages with autoplaying or streaming media.

## Notes

The first capture launches Chromium (~4s) and leaves it running; later captures
reuse it (~1.5s). Do not call `"$UISHOT" stop` between captures — that throws
away the speedup. Screenshots default to `.uishot/` in the working directory,
which is worth adding to `.gitignore`.
