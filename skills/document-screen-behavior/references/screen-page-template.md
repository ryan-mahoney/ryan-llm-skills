# Screen page template

The section order below preserves the common 11-section screen standard as a subsequence. Sections 1, 5, 7–15 are the standard ones in their original order. Sections 2, 3, 4, 6, and 16 are the additions this skill requires. A repository standard that defines its own order wins; insert the additions into it rather than reordering it.

Every heading carries a stable anchor. Every empty section reads `None.` with a reason — never a blank body, never a deleted heading. An agent reads a missing heading as missing research and `None.` as a fact.

---

## Front matter

```yaml
---
id: SCRN-001
title: Logged-in hiring homepage
type: screen
status: draft
owner: hiring-team
last_reviewed: 2026-08-02
review_interval_days: 90
verified_against: <version or commit the page was read against>
authentication: required          # required | optional | none
predicate: AUD-02                 # audience predicate from the permission model
inventory: INV-001                # the inventory that owns this screen
roles: [ROLE-02, ROLE-04]         # groups that can reach this screen
derived_from:                     # upstream files read, pinned to their versions
  - docs/permissions/permission-model.md@<version>
  - docs/inventories/<slug>-screens.md@<version>
journeys: [JRNY-006]              # journeys this screen participates in
jobs: [JOB-0031, JOB-0032]        # job stories this screen serves
features: [FEAT-014]              # features hosted here
objects: [OBJ-007]
rules: [BR-0142]
routes: ["/dashboard"]
screenshots: ["docs/screenshots/SCRN-001/"]
tests:
  - <test path>
---
```

An empty list is valid. A missing key is not. Keep the lists in agreement with the body — a reader and a tool both check.

Add `authentication`, `roles`, `journeys`, `jobs`, and `screenshots` even when the repository standard does not list them. If its validator rejects unknown keys, drop them from the front matter, keep the content in the body, and propose the schema change.

---

<a id="1-purpose"></a>
## 1. Purpose

One to three sentences. What the surface is for, and the decision or task it exists to support.

Write the user's reason, not a contents list. "Shows the summary, priorities, and interviews" describes the render. "Lets a hiring user find the single most urgent piece of hiring work and start it" describes the purpose.

<a id="2-access-and-audience"></a>
## 2. Access and audience

**Authentication.** State whether sign-in is required, and what an unauthenticated request receives — a redirect, a sign-in prompt, or a public render. Name the destination.

**Predicate.** The `AUD-##` that admits a user to this screen, with its expression written out so this page is readable alone:

> **AUD-02** — Signed in, tenant account type is `hiring`, holds any of ROLE-01…ROLE-04.

**Who reaches it.** One row per group, referencing the role registry rather than restating it.

| Group | Reaches the screen | Data scope | Gated by |
|---|---|---|---|
| ROLE-02 | yes / no / conditional | What subset of data this group sees, in plain terms | CAP-## |

Define every scope. "Membership scope" is meaningless to a reader who has not read the resolver; "only roles this user is assigned to" is not.

Where no permission model exists, write the role names and the checks directly, and open a question recommending one.

**What differs by group.** One row per region or feature that varies. This table is the point of the section — a page that says only "some users see less" has recorded nothing.

| Region or feature | Group | Visible | Enabled | Difference |
|---|---|---|---|---|

**Who is refused.** Every branch that keeps a signed-in user off this screen, and where each one lands: wrong account type, missing permission, wrong entitlement tier, unmet precondition.

<a id="3-job-stories-and-user-intent"></a>
## 3. Job stories and user intent

### 3.1 Job stories

One to five stories in this exact form:

```
JOB-####  When <situation>, I want to <motivation>, so I can <expected outcome>.
Evidence: <what supports this>
Confidence: sourced | inferred
```

Rules:

- The situation carries a time, place, state, or event, and a test can set it up. "When I am a manager" is not a situation.
- The motivation names no control and no screen. It must survive a redesign.
- The outcome is an end state, not a next click.
- No invented persona. When the role is a real constraint, put it in the situation: "When I am an interviewer and my first interview starts in an hour…".
- Every `inferred` story gets a matching entry in `Open questions`.

When a feature or journey page already owns a job story, reference its `JOB-####` and do not restate it. Carry stories on the screen page only while no such page exists, and mark them provisional so they migrate later.

### 3.2 Intent by group

The job stories say what the work is. This table says how it differs by who arrives.

| Group | What they come to do | Serves | Confidence |
|---|---|---|---|
| Role name | The intent in one sentence, in the user's terms | JOB-#### | sourced / inferred |

Use the role names the product uses. This is a mapping of real groups onto real jobs, not an invented cast.

<a id="4-journeys"></a>
## 4. Journeys

| Journey | Stage | Arrives with | Departs to | Returns here |
|---|---|---|---|---|
| JRNY-### or proposed name | The stage this screen occupies | State or context the user brings | The next screen | yes / no — and what changed |

Use the repository's stage frame. The default is `define → locate → prepare → confirm → execute → monitor → modify → conclude`.

**Return loop.** For every control that leaves the screen, state whether the user comes back and what has changed when they do. A workbench whose completed work still appears on return is a defect this section is meant to expose.

**First visit versus repeat visit.** State how the screen differs between them and what triggers each. Record the expected visit cadence when the screen ranks or refreshes anything.

Mark proposed journey names provisional when no journey registry exists, and open a question to register them.

<a id="5-features-hosted"></a>
## 5. Features hosted

One subsection per feature — not a bullet list. A bullet list is how this section fails.

```markdown
### FEAT-### or provisional name

**Outcome.** The verb phrase the user completes.
**Appears when.** The condition, permission, entitlement, or data state that shows it.
**Decides what appears.** The ordering rule, threshold, and limit — with values. Reference BR- IDs where they exist.
**Groups.** Who gets it, and how it differs.
**Exits to.** Destinations, and whether the user returns.
**Evidence.** Source files and tests.
```

If a capability appears in `Actions` but not here, this section is incomplete.

<a id="6-behavior-rules"></a>
## 6. Behavior rules

Every value the screen uses to rank, filter, gate, or truncate. A reader must be able to predict what the screen shows without opening the code.

| Rule | Value | Effect | Source |
|---|---|---|---|
| Ordering | The full precedence, in order | Which item wins the top slot | Constant or module |
| Eligibility | Threshold and unit | What qualifies to appear at all | Constant or module |
| Limit | Count | What truncates, and the message shown | Constant or module |
| Scope | The rule | Whose records appear | Resolver |

Where a business-rule registry exists, move these to `BR-` entries and reference the IDs — the values belong in one place. Where it does not, keep them here and open a question about migrating them.

Write `None.` if the screen ranks, filters, and truncates nothing.

<a id="7-objects-shown"></a>
## 7. Objects shown

| Object | Attributes shown | Conditions |
|---|---|---|

State what the screen changes, and what it does not. Name the surface that owns each change it delegates.

<a id="8-layout-regions"></a>
## 8. Layout regions

| Region | Content | Shown to |
|---|---|---|

List regions in visual order. Note which are absent for which groups. Expect to rewrite this section after a redesign — write it after the durable sections.

<a id="9-states"></a>
## 9. States

Cover all of these. Write `None.` and the reason where a state cannot occur.

`default` · `empty` · `first-run` · `loading` · `updating` · `partial` · `error` · `permission-denied` · `offline` · `read-only`

Give each state its own subsection so a screenshot can sit inside it:

```markdown
### Default

**Trigger.** What produces this state.
**Result.** What the user sees.
**Recovery.** The action that leaves the state, where one applies.

![SCRN-001 default state](../screenshots/SCRN-001/default.png)
```

Distinguish first-use empty from filtered or searched empty. Distinguish a whole-page failure from one failed region beside working ones.

<a id="10-actions"></a>
## 10. Actions

| Region | Control | Condition | Effect | Destination | Rule |
|---|---|---|---|---|---|

Every control, including retries and dialog launchers. Record the exact label. Where a group cannot use a control, say whether it is hidden or disabled — they are different products.

<a id="11-validation-and-messages"></a>
## 11. Validation and messages

Every visible string in these classes, word for word: empty, failure, truncation, confirmation, and validation. Group by class. Quote exactly, including punctuation.

<a id="12-navigation"></a>
## 12. Navigation

**Arrives from.** Every entry: navigation, deep link, redirect, post-action return, external link.
**Leaves to.** Every exit, cross-referenced to `Actions`.
**Does not appear for.** Every branch that routes elsewhere, and the destination.

<a id="13-responsive-behavior"></a>
## 13. Responsive behavior

What changes at each breakpoint: column count, region order, table-to-card collapse, control placement, truncation. Link the mobile captures from `Visual evidence`.

<a id="14-accessibility"></a>
## 14. Accessibility

Landmarks and heading hierarchy; focus order and focus destination after submit, error, dialog close, and route change; announcements for loading, updating, error, and empty; keyboard paths; target sizes; and what remains untested. Record the untested parts — a silent gap reads as a pass.

<a id="15-content-inventory"></a>
## 15. Content inventory

| Region | Static content | Dynamic content | Source |
|---|---|---|---|

Every visible string, with the file it comes from. The localization and content pipelines read this section.

<a id="16-visual-evidence"></a>
## 16. Visual evidence

| State | File | Viewport | Data set | Captured | Version |
|---|---|---|---|---|---|

One row per capture, including uncaptured states with the reason in place of the path. Re-capture when `verified_against` changes. See `screenshots.md` for the protocol.

<a id="open-questions"></a>
## Open questions

`OQ-###` — the question, the owner, the date opened. One entry for every inferred job story, provisional journey, unregistered rule, and unresolved gap.

<a id="changelog"></a>
## Changelog

| Date | Version | Change | Author |
|---|---|---|---|
