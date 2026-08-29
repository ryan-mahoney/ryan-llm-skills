# Operator map manifest

The renderer accepts JSON with `$schema: "visualize-journey/v1"`.

## Top-level shape

```json
{
  "$schema": "visualize-journey/v1",
  "journey": {},
  "entry": {},
  "terminal": {},
  "behaviorEvidence": {},
  "repositories": [],
  "upstreamSeams": [],
  "steps": [],
  "exitPoints": []
}
```

## Journey

Required:

```json
{
  "id": "JRNY-124",
  "title": "Purchase a standalone JobKit",
  "goal": "Find, buy, and open the relevant JobKit.",
  "actor": "Anonymous prospect hiring for a specific role",
  "owner": "growth",
  "status": "draft",
  "source": "../../JRNY-124-purchase-a-standalone-jobkit.md",
  "verifiedAgainst": [
    "app@<commit>",
    "marketing@<commit>"
  ],
  "seams": ["SEAM-001", "SEAM-002"],
  "e2e": {
    "lanes": ["GP-1"],
    "status": "partial",
    "note": "The lane is fixme and skips marketing acquisition."
  }
}
```

`source` and all other `href` or image paths are relative to the generated journey `index.html`.

## Entry and terminal

```json
{
  "repo": "marketing",
  "route": "/",
  "label": "Marketing homepage",
  "detail": "The visitor selects Find your JobKit."
}
```

`repo` must match a repository ID. `route`, `label`, and `detail` are required.

## Behavioral evidence

Describe whether observed behavior supports the map's risk prioritization:

```json
{
  "status": "missing",
  "note": "No funnel, abandonment, timing, error-rate, support-volume, or research evidence is linked. Priority reflects implementation evidence and expert judgment, not observed user impact.",
  "sources": []
}
```

Allowed `status` values: `observed`, `partial`, `missing`. `note` is required. `sources` contains zero or more `{ "label": "…", "href": "…" }` objects. Use `observed` only when the evidence directly covers this journey and state; use `partial` when evidence covers only some steps, cohorts, or outcomes. Do not turn implementation issue counts into behavioral or business metrics.

## Repositories

List repositories and external systems in visit order:

```json
{
  "id": "marketing",
  "label": "Marketing",
  "host": "firstwho.co",
  "color": "#2f6f5e"
}
```

Use one stable, restrained color per repository. Color provides ownership wayfinding only; the rendered repository label must always remain visible. Reserve risk colors for severity and missing evidence, and do not use repository colors as large decorative fills.

## Upstream seams

Use `upstreamSeams` for registered boundaries that shape the entry state before the user arrives, such as an app-to-marketing content export:

```json
{
  "id": "SEAM-001",
  "type": "content-sync",
  "fromRepo": "app",
  "toRepo": "marketing",
  "title": "Publish JobKit content before acquisition begins",
  "effect": "The marketing build receives public JobKit payloads.",
  "risk": "An older build can show stale catalogue content.",
  "carries": ["public JobKit payload", "stable role slug"]
}
```

Every ID in `journey.seams` must appear in `upstreamSeams` or a step transition. Do not convert a pre-entry system operation into a fake user step.

## Steps

Every step requires this core:

```json
{
  "id": "locate-finder",
  "sequence": 2,
  "stage": "locate",
  "title": "Search for a role",
  "repo": "marketing",
  "host": "firstwho.co",
  "route": "/",
  "screen": null,
  "userSees": "A role search field, sector filters, and matching JobKits.",
  "decision": "Choose the role that matches the current hire.",
  "visual": {},
  "ctas": [],
  "establishes": [],
  "requires": [],
  "transition": {},
  "issues": [],
  "evidence": []
}
```

Allowed `stage` values: `define`, `locate`, `prepare`, `confirm`, `execute`, `monitor`, `modify`, `conclude`.

`screen` is a `SCRN-###` string or `null`. When it is null, add an inventory-gap issue unless the surface is an automatic redirect, email, or third-party page that the screen inventory intentionally excludes.

### Visual

Captured:

```json
{
  "status": "captured",
  "src": "../../../screenshots/SCRN-030/default.png",
  "alt": "JobKit purchase review showing the price and payer email",
  "note": "Desktop default at 1280×800, captured 2026-08-03."
}
```

Missing:

```json
{
  "status": "missing",
  "src": null,
  "alt": "",
  "note": "No versioned marketing homepage capture exists."
}
```

Allowed status values: `captured`, `missing`, `external`, `redirect`. `captured` requires `src` and `alt`. `missing` requires a reason in `note`. Use `external` for an intentionally uncaptured provider or inbox and `redirect` for an owned controller state with no stable UI.

### CTAs

```json
{
  "label": "Buy this kit",
  "kind": "primary",
  "destination": "app /buy/kit/:shortcode?level=:level",
  "effect": "Leaves marketing and opens the authenticated purchase path."
}
```

Allowed `kind`: `primary`, `secondary`, `destructive`, `system`. `destination` or `effect` must explain the result; provide both when useful.

CTA labels are verified by default. When an uncaptured third-party label is genuinely unknown, do not invent copy:

```json
{
  "label": "Payment submission control",
  "labelStatus": "unknown",
  "kind": "primary",
  "destination": "Stripe payment submission",
  "effect": "The exact hosted label is not captured."
}
```

An unknown label requires a coverage issue on the same step.

### Context

`establishes` and `requires` are arrays of ledger keys. Proposed keys use an object:

```json
{
  "key": "selectedLevel",
  "status": "proposed"
}
```

An unmet requirement uses:

```json
{
  "key": "kitName",
  "status": "missing",
  "note": "The review page does not display the JobKit name."
}
```

Strings mean `status: present`.

### Transition

```json
{
  "type": "seam",
  "label": "Marketing hands the buyer to the app",
  "seam": "SEAM-002",
  "toStep": "confirm-register",
  "carries": ["shortcode", "selected level"],
  "loses": ["JobKit name", "finder query", "marketing price"]
}
```

Allowed `type`: `in-place`, `route`, `seam`, `external`, `automatic`, `conditional`, `terminal`. The final step uses `terminal` and omits `toStep`.

Set `provisional: true` when the crossing has no registered seam ID. Use branches when the outcome is not linear:

```json
{
  "type": "conditional",
  "label": "Resolve the paid return",
  "toStep": "monitor-finalizing",
  "carries": ["shortcode", "settlement state"],
  "loses": ["selected level from the browser URL"],
  "branches": [
    {
      "label": "Access exists",
      "condition": "The organization claim is active.",
      "outcome": "Skip finalization and open the kit.",
      "toStep": "conclude-owned-kit"
    },
    {
      "label": "Cancel",
      "condition": "The buyer exits hosted Checkout.",
      "outcome": "Return to purchase review.",
      "toStep": "confirm-review"
    }
  ]
}
```

Branch targets may point backward for retry or cancellation. `toStep` remains the default forward reading path.

### Issues

```json
{
  "id": "CTX-GP-1-start-checkout-missing-object",
  "severity": "high",
  "title": "Stripe omits the JobKit name",
  "consequence": "The buyer cannot verify the selected product at payment commitment.",
  "status": "open",
  "source": "confirmed",
  "href": "../../../journey-context-findings.md#ctx-gp-1-start-checkout-missing-object",
  "next": "Add the JobKit name to Stripe Checkout line-item presentation."
}
```

Allowed severity: `critical`, `high`, `medium`, `low`, `info`. `source` is `confirmed`, `inferred`, or `coverage`. `href` is optional only when no durable source exists; inferred issues should link an open question when possible.

### Evidence

```json
{
  "label": "Purchase card source",
  "href": "../../../../../marketing/app/components/pages/jobkit3/PurchaseCard.js",
  "kind": "source"
}
```

Allowed `kind`: `source`, `screen`, `screenshot`, `test`, `finding`, `document`.

## Exit points

```json
{
  "atStep": "execute-stripe",
  "label": "Cancel Checkout",
  "result": "No paid settlement or active claim.",
  "recovery": "Return to the app review and start again."
}
```

`atStep` must name a step ID. `label`, `result`, and `recovery` are required.

## Validation rules

- Step sequences are contiguous from 1.
- Step IDs are unique and kebab-case.
- Repository IDs are unique and every step, entry, and terminal repo is registered.
- Every declared journey seam appears in an upstream seam or step transition, and no projected seam is undeclared.
- Every nonterminal transition with `toStep` names a later step.
- Every conditional branch names an existing step or an external destination.
- Every `seam` matches `SEAM-###`.
- Every screen matches `SCRN-###`.
- A surface without a screen ID has a coverage issue unless it is redirect-only or external.
- Every issue ID is unique within the manifest.
- Issue sources and evidence kinds use the allowed enums.
- `behaviorEvidence` has an allowed status, a non-empty note, and valid labeled sources.
- `captured` visuals resolve when `--check` is used.
- Evidence links and the canonical journey source resolve when `--check` is used.
- At least one step has a primary CTA unless the journey is fully automatic.
- The terminal step has `transition.type: "terminal"`.
