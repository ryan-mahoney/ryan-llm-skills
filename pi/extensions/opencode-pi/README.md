# opencode-pi (vendored)

A vendored, Pi 1.2-compatible copy of [`opencode-pi`][npm], an extension that
registers an `opencode-cli` provider in Pi and delegates every model call to the
local `opencode` binary. This is what makes OpenCode's **free-tier** models
(`ling-3.1-flash-free`, `space-bunny-free`, `muse-spark-1.3-contributor-free`,
`cat-jam-free`, …) usable from Pi: the free tier is locked to the OpenCode client,
and running the real CLI as a subprocess is the only sanctioned way through it.

It is vendored rather than installed from npm because the published release
targets Pi `^0.75.4` and is broken on Pi 1.x in ways that upstream has not yet
released fixes for. See [Local patches](#local-patches).

## Provenance

| | |
|---|---|
| Upstream project | <https://github.com/luongnv89/pi-extensions> (`extensions/opencode-pi`) |
| Upstream package | `opencode-pi` on npm, **version 1.4.0** (published 2026-09-28) |
| Vendored file | `src/index.ts` (the only runtime file the package ships) |
| Upstream docs | [`README.upstream.md`](README.upstream.md), unmodified |
| License | MIT — see [`LICENSE`](LICENSE) |
| Vendored | 2026-10-14 |

The upstream package manifest for reference:

```json
"peerDependencies": {
  "@earendil-works/pi-coding-agent": "^0.75.4",
  "@earendil-works/pi-ai": "^0.75.4"
}
```

This copy keeps `version: 1.4.0` so it stays trivially diffable against the
published tarball, and declares the host-provided packages as `"*"` peers per
Pi's package guidance.

## Local patches

Three changes against upstream 1.4.0. Together they are 11 hunks, ~197 lines.

### 1. Crash on Pi's `system` role

Pi 1.2 added `SystemMessage`, so `Context["messages"]` can contain a message
whose `content` — and whose parts — are not an assistant-style array.
`serializeMessage` assumed every non-`user`/non-`toolResult` message was an
assistant message and called `message.content.map`, throwing
`TypeError: message.content.map is not a function` on the first turn of every
request.

Now: non-assistant roles serialize as labelled context text (`SYSTEM:`, `CUSTOM:`,
`BASHEXECUTION:`, …), assistant messages tolerate string or absent content, and
`contentToText` guards a non-array argument. Overlaps upstream PRs #119, #129,
#130, #132 (all unmerged).

### 2. Free-tier rejection from the custom agent

Upstream writes a locked-down `.opencode/agents/pi-model.md` (`permission: "*": deny`
and friends) and passes `--agent pi-model`, so OpenCode cannot use its own tools.
OpenCode's free tier rejects that agent: the request returns
`403 FreeTierError: OpenCode's free tier can only be used from within OpenCode.`

Verified by bisection against the live gateway: a custom agent with **no**
permission block works; a custom agent with **any** tool denial — the `"*"` deny
or an explicit named list — is rejected. Since the free tier is the whole point,
`--agent` is no longer passed. This matches upstream PR #121.

**Trade-off accepted:** OpenCode's own tools are no longer denied at the OpenCode
level. `--dir <temp session dir>` is still passed, the bridge prompt still forbids
OpenCode tools, and the extension still fails the turn if OpenCode emits a native
tool call — but this is a weaker sandbox than upstream's README describes.

The `pi-model` agent file is still created by `createTempAgentDir` and is now
unused. It is deliberately left in place so that restoring `--agent` is a two-line
revert and so this copy stays diffable against upstream.

### 3. Blind bridge: lost system prompt and tool declarations

Pi 1.2 moved the prompt and tool declarations out of `Context.systemPrompt` and
`Context.tools` and into system messages: each carries `content`, a `sections`
map, and the tool deltas `toolsAdded` / `toolsRemoved`. Upstream read the old
fields, so on Pi 1.x the bridge saw **no tools and no system prompt** — the model
was told "No Pi tools are available for this turn" and tool calling was impossible.

Added `resolvePiContext()`, which replays system messages to recover the current
prompt (all `sections` except the human-readable `tools` summary), the tool
declarations (from `toolsAdded` minus `toolsRemoved`), and a transcript with the
system messages removed. `streamOpenCode` now uses this resolved context
throughout.

## Not vendored

- `src/index.test.ts` — upstream's suite imports `./index.js` and therefore
  requires a `tsc` build plus a resolvable dependency tree; it cannot run from a
  vendored copy as-is. Run it from a checkout of upstream if needed.

## Wiring

`sync.sh` symlinks every directory under `pi/extensions/` into
`~/.pi/agent/extensions/`, so this loads on any machine that has run `sync.sh`.
No dependencies to install: the extension imports only `node:` builtins and the
host-provided `@earendil-works/pi-ai` / `pi-coding-agent`.

**Do not also install the npm package.** Two copies would both register the
`opencode-cli` provider and the same API id. If migrating an existing install:

```bash
pi remove npm:opencode-pi
```

Then restart Pi or `/reload`.

## Usage

```bash
pi --provider opencode-cli --model opencode/ling-3.1-flash-free
```

Discovery registers the free models OpenCode reports at zero cost, keyed off
`opencode models opencode --verbose`. A cold first run can briefly show the
bundled 8-model fallback list before discovery completes. `OPENCODE_PI_MODELS`
forces specific IDs and `OPENCODE_PI_BIN` overrides the CLI path; both are
upstream features and are documented in [`README.upstream.md`](README.upstream.md).

## Verification

No build or lint is configured for `pi/extensions/`, and `tsc` is not installed
in this repo, so the checks below are manual recipes rather than wired-in gates.

**Runtime (the check that matters).** These exercise the whole path — provider
discovery, free-tier access, prompt bridging, tool-marker round trip:

```bash
pi -p --provider opencode-cli --model opencode/ling-3.1-flash-free \
  --no-session "Reply with exactly: ok"

printf 'the magic word is platypus\n' > /tmp/octest.txt
pi -p --provider opencode-cli --model opencode/space-bunny-free \
  --no-session -t read "Read /tmp/octest.txt and tell me the magic word."
```

Expected: `ok`, then `The magic word is **platypus**.`

**Syntax.** Node strips TypeScript types, so a parse check is free:

```bash
node --check src/index.ts
```

**Typecheck.** Requires a scratch project because `tsc` and the host packages
must both be resolvable. Install first, then symlink — `npm install` removes
hand-made symlinks:

```bash
D=$(mktemp -d)
mkdir -p "$D/node_modules/@earendil-works"
cp src/index.ts "$D/index.ts"
printf '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true,"skipLibCheck":true,"types":["node"]},"files":["index.ts"]}\n' > "$D/tsconfig.json"
(cd "$D" && npm i --no-save typescript @types/node)
PI=$(npm root -g)/@earendil-works/pi-coding-agent
ln -sfn "$PI" "$D/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$PI/node_modules/@earendil-works/pi-ai" "$D/node_modules/@earendil-works/pi-ai"
(cd "$D" && ./node_modules/.bin/tsc -p tsconfig.json --noEmit)
```

**Result at vendoring time** (strict mode, versus upstream 1.4.0 under the same
config): upstream reports 6 errors, this copy reports 5. The one that disappears
is `Property 'map' does not exist on type 'string | TextContent[] | …'` at the
`serializeMessage` crash site — patch 1, confirmed by the typechecker. No new
errors were introduced. The 5 that remain are type-surface differences inherited
from upstream:

- `registerApiProvider` is exported from `@earendil-works/pi-ai/compat`, not the
  package's main entry. It still resolves at runtime because Pi maps
  `@earendil-works/pi-ai` to a compat-aware module for extensions.
- `Record<string, unknown>` vs `JsonObject` in the model-debugger registration.
- Three implicit-`any` parameters on the provider registration call.

These are unverified under upstream's own (less strict) `tsconfig.json`, which is
not shipped in the tarball.

## Refreshing from upstream

```bash
npm pack opencode-pi@latest --pack-destination /tmp
tar xzf /tmp/opencode-pi-*.tgz -C /tmp
diff -u /tmp/package/src/index.ts pi/extensions/opencode-pi/src/index.ts
```

If upstream has meanwhile fixed the three issues above (check PRs #121, #130,
#132), prefer dropping this copy in favour of `pi install npm:opencode-pi`.

## Caveats

- Free models on OpenCode's free tier **may retain prompts** to improve the
  models. Do not send confidential content through them.
- The bridge is a subprocess round trip per turn, so it is slower than a native
  HTTP provider.
- Tool calling is prompt-bridged through `<pi_tool_call>` markers, which is less
  reliable than a native tool-call API.
