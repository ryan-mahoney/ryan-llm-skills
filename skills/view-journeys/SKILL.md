---
name: view-journeys
description: Open, view, browse, or serve the rendered journey maps that visualize-journey produces — the operator maps, the journey canvas, or the portfolio index. Use when the user says "open the journey maps", "show me the journey canvas", "view the operator maps", "browse the journeys", "serve the journey visuals", or asks to see where a journey's visual instrument lives. Not for creating, rendering, or visualizing a journey — that is visualize-journey. This skill only serves an existing collection.
metadata:
  version: "1"
---

# View Journeys

Serve an existing `visualize-journey` collection locally and hand back its URL. This skill views a collection that already exists; it never builds or renders one — run `visualize-journey` for that.

## Step 1 — Find the collection

Default: `docs/journeys/visuals` under the repository's docs directory. If it is not there, search:

```bash
find . -name canvas.html -path '*/journeys/visuals/*'
```

If none is found, tell the user and suggest running `visualize-journey`. If more than one is found, ask which repository's collection they mean.

## Step 2 — Regenerate if stale

`canvas.html` is generated; it can be older than the manifests it should reflect.

```bash
find <collection-dir> -name manifest.json -newer <collection-dir>/canvas.html
```

If `canvas.html` is missing, or that command prints any path, regenerate before serving — this is the collection render command from `visualize-journey`'s SKILL.md:

```bash
node ~/.agents/skills/visualize-journey/scripts/render-journey-map.mjs \
  --collection <collection-dir> --output <collection-dir>/index.html
```

## Step 3 — Serve it

Start the server as a background process (it keeps running until stopped):

```bash
node ~/.agents/skills/visualize-journey/scripts/serve-journeys.mjs <collection-dir>
```

It prints the served root and the canvas and list URLs, default `http://127.0.0.1:4173`. If that port is taken, add `--port <n>`.

## Step 4 — Hand back the URL

Give the user the canvas URL from the server's startup output. Only run `open <url>` (macOS) if the user asked to open it themselves; otherwise just report the URL.

Never open or hand out a `file://` path to these pages. Say why in one sentence: evidence links span repositories and source files only render when served.

## Stopping it

Ctrl-C the process, or `kill` the PID it started with. Mention the `--port <n>` escape hatch if the default port is already in use.
