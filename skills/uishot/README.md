# uishot

A single-file screenshot CLI for driving an agent's visual feedback loop while
it builds UI. Point it at your dev server, get a PNG that reflects what the page
actually looks like once it has finished rendering.

## Install

The skill includes a launcher that runs the Python CLI with Playwright in an
isolated `uv` environment:

```bash
UISHOT=/absolute/path/to/uishot/scripts/uishot
"$UISHOT" setup
```

This installs Chromium once for the current user. It does not add Playwright to
the coding project's dependencies. Run screenshot commands from the project
root so the default `.uishot/` output stays with that project.

Install the full `uishot` directory in the agent's skills directory. The skill
instructions tell the agent to invoke the bundled launcher by absolute path, so
a global `uishot` command is not required.

## Usage

```bash
"$UISHOT" http://localhost:3000                       # viewport
"$UISHOT" http://localhost:3000 --full-page           # whole page
"$UISHOT" http://localhost:3000 --selector "#cart"    # one component
"$UISHOT" http://localhost:3000 --viewport 390x844    # phone width
"$UISHOT" http://localhost:3000 --wait-for ".results" # pin the capture
```

Output:

```
ok: screenshot-saved
file: /work/.uishot/localhost-3000-142233.png
mode: viewport
size: 1280x800@2x
url: http://localhost:3000/
http_status: 200
browser: reused on port 9222
readiness: load,network-idle,fonts-ready,dom-quiet-500ms
settle_ms: 460
elapsed_ms: 1435
console_errors: 0
```

Several of the stability details here — the Chromium rendering flags, treating
`load` as unreliable, and pinning media at document start — follow
[Alex Turner's write-up on flaky Playwright screenshots](https://turntrout.com/playwright-tips),
which is worth reading if you go further into visual regression testing.

## Design notes

**Warm browser.** The first call launches headless Chromium with a remote
debugging port and leaves it running; subsequent calls attach over CDP. Cold
start is ~4s, warm captures ~1.5s. The script is idempotent — it probes the port
and launches only if nothing answers, so the agent never has to manage state.

**Output shape.** One `key: value` block, absolute paths, no decoration, no
spinners. Failures print a machine-readable code, a `next_action:` line, and a
distinct exit code, so a weaker model can recover without guessing.

**Console errors are surfaced on success.** When a UI looks wrong the reason is
frequently a 404 on a stylesheet or a thrown render error. Reporting those in
the same output saves an entire diagnostic round trip.

**Determinism.** Each capture gets an isolated browser context with a pinned
viewport and device scale factor, and CSS animations and transitions are frozen
by default, so two captures of unchanged code produce comparable images.

## How it decides the page is ready

Naive screenshots catch skeleton loaders. The gate is layered:

1. `load` fires.
2. In-flight network requests drain. This is tracked directly rather than via
   Playwright's `networkidle`, which costs a flat 500ms and never settles on dev
   servers holding an HMR socket open. Requests older than 2s are aged out so
   streaming endpoints cannot stall the capture.
3. `document.fonts.ready`, so text is not captured mid-reflow.
4. All images finish loading or error out. Ones that failed are reported as
   `broken_images`.
5. Pending short-horizon `setTimeout` callbacks drain. `setTimeout` is patched
   at document start to track them.
6. The DOM stops mutating for `--quiet-ms` (default 500), watched with a
   `MutationObserver` installed before any page script runs.
7. Video and audio are pinned: autoplay is stripped and elements are paused and
   seeked at document start, then polled until the browser confirms they came to
   rest. Otherwise frames advance and buffer bars fill differently on every run.
8. A two-frame paint check catches purely visual settling.

Step 5 is the one that matters most and is easy to miss. A skeleton that swaps
for real content on a 1.2s timer leaves the DOM genuinely quiet and the network
genuinely idle in the meantime — every load-and-network-based heuristic fires
early and photographs the skeleton. This was verified in testing: without timer
instrumentation the capture returned the loader; with it, the real content.

**The honest limit.** No heuristic can know that work is scheduled beyond its
horizon. For anything slower than the quiet window — long polls, delayed
websocket pushes — pass `--wait-for SELECTOR` or `--wait-text`. The tool prints
a note whenever it captured without an explicit wait condition, so the agent
knows the result rested on a heuristic.

## Navigation and the load event

Navigation waits for `domcontentloaded`, then allows a short grace period
(`--load-grace`, default 1500ms) for `load` to fire. Waiting on `load` outright
is a trap: a page holding an autoplaying video or any streaming subresource may
never fire it, and the capture fails even though the content was ready in
milliseconds. This was reproduced in testing — a page whose markup was complete
immediately failed after 13.8s under a `load` gate, with an error that wrongly
blamed the dev server.

Worse, Playwright's own `screenshot()` blocks on a pending main-frame
navigation, so such pages cannot be captured through the normal API at all. When
`document.readyState` is not `complete`, the capture is routed through raw CDP
(`Page.captureScreenshot`), which has no such wait. Same pixels, no hang; the
output reports `capture: cdp-direct` when this happens.

## Tuning

Roughly 0.85s of each warm capture is fixed overhead (Playwright's Node driver
starting, context creation, PNG encoding) and the rest is the quiet window.
`--quiet-ms 200` meaningfully tightens the loop on simple pages.
`--image-timeout` and `--load-grace` cap the two other waits. If you need
sub-second captures you would have to drop Playwright and speak CDP directly,
which costs you locators and element screenshots — not worth it for a dev loop.
