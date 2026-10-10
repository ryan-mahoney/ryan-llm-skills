---
name: spec-sentinel
description: "Global monitoring and optional shadow/recover supervision of spec runs across automatically discovered repositories and live Pi coordinators. Use for 'workspace status', 'sentinel status', 'discover repositories', or 'is any spec run stuck'. Observe is read-only; intervention requires an explicit runtime mode."
argument-hint: "[observe | shadow | recover] [--model provider/model:thinking] [--root PATH] | status | off"
disable-model-invocation: false
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# Global spec sentinel

For a natural-language request to start sentinel observation, show its status, or
stop it, call `sentinel_lifecycle` once and report the returned state and useful
paths:

- Start, monitor, or observe: `{ "action": "observe" }`.
- Status: `{ "action": "status" }`; add `"include_inactive": true` only when the user asks for history.
- Stop or off: `{ "action": "off" }`.
- A requested discovery folder: add `"root": "/absolute/path"` to observe.

Use the tool directly. Do not inspect source, enumerate processes, read transcripts,
create a policy, or start a `nohup`/shell daemon to perform these lifecycle actions.
If the tool is unavailable, report that limitation and provide the matching native
Pi command; do not reconstruct the controller outside Pi.
If dashboard startup is pending or unavailable, report that state. The native
controller reports its URL when ready; do not poll tools or launch another server.

## Installed host is a separate lifetime

An explicitly operator-installed host (launchd/Serve) is a distinct,
authority-free observer: it keeps publishing snapshots and serving the read-only
dashboard independently of any Pi session. Never start, stop or supervise it
from a natural-language request, and do not infer its liveness from an old
snapshot file. Remote dashboard reads remain local-only for completion. The Pi
lifecycle above is unchanged. Operator defaults, ownership and installation
steps: [scripts README](../../scripts/spec-observe/README.md#observe-only-host-operator)
and [runtime README](../../pi/extensions/spec-runtime/README.md#observe-only-host-entry).

## Native commands and authority

```text
/sentinel start
/sentinel observe [--root PATH]
/sentinel shadow [--model provider/model:thinking] [--root PATH]
/sentinel recover [--model provider/model:thinking] [--root PATH]
/sentinel status [--all]
/sentinel inspect ID
/sentinel stop
/sentinel off
```

`/spec-sentinel` remains an alias. Bare invocation and `start` mean observe; `stop`
means off. Shadow and recover must be explicit native commands: the lifecycle tool
cannot arm diagnosis or recovery. Observe uses no model calls. Off revokes global
supervision and closes the observer's owned helper, watchers, timers and dashboard;
it never stops product workers.

A fresh session is dormant. Cold status is a bounded one-shot read with helper
cleanup and no timers or dashboard. Active status preserves the running monitor.
Status after off does not restart it; `--all` does not replace the live export.
Explicit observe startup opens the dashboard in interactive Pi and lasts until off,
replacement or controller shutdown. Defaults: discovery beneath `~/Documents`,
diagnostic model `openrouter/inception/mercury-2.5:high`.

## JSON snapshots for other tools

Active observers publish separate snapshots at
`<agent-dir>/spec-sentinel/<workspace-key>/observers/<observer-id>.json`.
The lifecycle result reports its snapshot path and dashboard URL when available.
Check `published_at`, `snapshot.coverage.observed_at` and state for freshness;
an old `observing` file is not proof that its monitor is alive. Exports and worker
completion do not establish acceptance or grant intervention authority.

For runtime contracts, connectivity limits, retained recovery guards and the
standalone read-only CLI, see
[the runtime reference](../../pi/extensions/spec-runtime/README.md#global-runtime-modes).
