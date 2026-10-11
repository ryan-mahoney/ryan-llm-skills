# CTA & Button Wording Guide (v1.2)

**Core rule:** A button label is a promise.

## 1. Default Pattern
Verb + Noun
Drop articles. Use sentence case.

Examples:
- Send invite
- Create section
- Save file
- Delete workspace
- Discard changes
- Open preview

## 2. Verb Selection
- Create -> new entity (Create section, Create file)
- Add -> attach existing (Add job, Append text)
- Save -> persist edits (Save file, Save changes)
- Send -> transmit (Send invite, Send message)
- Submit / Apply -> commit a proposal (Apply replacement)
- Open -> reveal surface (Open workspace, Open preview)
- Close -> hide surface (Close preview)
- Delete -> permanent removal (Delete workspace, Delete file)
- Remove -> detach without destroying (Remove section, Clear chat)
- Discard -> drop user effort (Discard changes)
- Cancel / Stop -> end an in-flight action (Stop response, Keep editing)
- Try again -> retry after failure

Avoid: OK, Yes/No, Click here, Done, Continue, Confirm.

## 3. Length & Tone
- 1-3 words preferred
- 4 max
- No punctuation, emojis, fluff, or politeness

## 4. Hierarchy
- One primary action per view. When two actions both look primary, demote the read action to outline (e.g. WorkspaceView keeps `Create section` primary; `Open preview` drops to outline).
- Variants step down: Primary -> Secondary -> Outline -> Soft -> Ghost -> Link.
- Primary is scarce: reserve it for the commit action (save, send, apply, open the next major workflow).
- Secondary is brand-affirmative; use it only when primary already belongs to the main commit.
- Destructive actions repeat verb + object (`Delete workspace`, not `Delete`).

## 5. Variants
- **Primary** - the one commit action
- **Secondary** - affirmative companion action
- **Neutral** - dark non-brand action
- **Outline** - safe secondary, non-committal
- **Soft** - low-emphasis primary tint
- **Ghost** - inline action, no chrome
- **Link** - in-text navigation or low-stakes alt action
- **Destructive (solid)** - irreversible removal
- **Destructive (outline)** - destructive but recoverable (`Discard changes`, `Remove section`)

## 6. Sizes
- Extra small / Small - dense toolbars and table rows
- Default (`min-h-11`, ~44px) - forms and most surfaces
- Large - page-level CTAs only

Buttons never go below the 44x44px touch target except in dense toolbars where small (`min-h-9`) is the explicit affordance.

## 7. Icons
- Text buttons may carry a leading or trailing icon (`Plus` + Create section, Log in + `ArrowRight`).
- Icon-only buttons require: 44x44 target, accessible `aria-label`, decorative SVG marked `aria-hidden`, and a tooltip that repeats the action.
- Reserve icon-only for repeated row actions and universally recognized controls (close, edit, delete, settings, open).

## 8. Destructive Actions
- Red is functional - reserve it for removing data, stopping work, or discarding effort.
- Solid red for permanent removal (`Delete workspace`).
- Destructive outline for recoverable destructive actions (`Discard changes`, `Remove section`).
- Pair every destructive action with a non-destructive escape (`Keep editing`, `Cancel`).
- Never use bare labels (`Delete`, `Confirm`, `Discard`).

## 9. Focus & Disabled
- Every interactive button keeps a 2px primary focus ring. Hover and active states never replace keyboard focus.
- Disable only when the user genuinely cannot act yet. Keep the label specific so the disabled state still explains the unavailable promise (`Save changes`, not `Submit`).

## 10. Accessibility
- `<button>` for actions, `<a>` for navigation and downloads (`Download HTML` is a primary-styled anchor).
- Min target 44x44px
- `aria-label` when the label is ambiguous or icon-only

## 11. Quick Check
1. Starts with a verb?
2. Outcome predictable?
3. Only one primary?
4. Destructive action names the object?
5. Focus ring visible?
