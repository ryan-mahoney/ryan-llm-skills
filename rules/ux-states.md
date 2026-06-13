# UX States & Feedback Guide (v1.0)

**Core rule:** Every view has more than one state. Design all of them.

## 1. Required States
Every data-driven view defines:
- Empty (first use)
- Loading
- Error
- Partial/degraded
- Permission denied or unavailable, when access can vary
- Offline or reconnecting, when network state matters
- Stale/revalidating, when existing data can remain visible while refreshing
- Ideal

## 2. Empty States
- Say what belongs here
- One CTA to create or import the first item
- Never an unexplained blank region
- Distinguish first-use empty from filtered/search empty

## 3. Loading
- Avoid flashing loaders for sub-300ms waits; use skeleton or spinner after
- Skeletons mirror the final layout
- Never blank out content already on screen
- Show loading at the smallest meaningful region; avoid noisy repeated indicators
- Existing content may stay visible with a subtle refreshing state

## 4. Errors
- Say what failed and how to recover
- Preserve user input
- Inline for field errors, banner for view errors
- No raw error codes or stack traces as primary copy
- Support/debug IDs may appear as secondary detail
- Move focus or announce the error when assistive tech needs the update

## 5. Feedback on Action
- Acknowledge interaction within 100ms
- Optimistic UI for safe operations; confirmed state for destructive ones
- During submit: prevent duplicate submission and show progress ("Saving…")
- Toasts for background outcomes, never for validation errors
- Long-running actions need cancel, retry, or navigation-safe behavior when possible

## 6. Destructive Actions
- Confirm with the consequence stated, naming the object
- Prefer undo over confirmation when reversible
- Repeat verb + object on the confirm button (per CTA guide)
- Require explicit confirmation for irreversible destructive actions

## 7. Accessibility & Focus
- Loading, success, error, and empty changes are announced when they are not visually obvious
- Focus lands on the most useful next place after submit, error, modal close, or route change
- Disabled controls still explain why the action is unavailable

## 8. Final Test
1. Did I see every state actually rendered?
2. Can the user always tell what is happening?
3. Is there always a next action?
4. Does keyboard and screen-reader feedback match the visual state?
