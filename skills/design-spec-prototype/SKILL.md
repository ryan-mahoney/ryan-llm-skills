---
name: design-spec-prototype
description: This skill should be used when the user asks to "prototype this", "mock this up", "build a quick prototype", "show me a design", or "make a clickable mockup". Builds a fast, viewable design prototype from a proposal (or the conversation) and serves it on localhost so the user can open it and comment. Defaults to a single static HTML file using the Tailwind CDN.
disable-model-invocation: true
argument-hint: "[feature-slug, proposal path, or a stack override like 'in React']"
---

# Design Spec Prototype

Build a fast, throwaway-OK prototype the user can open in a browser and react to, and serve it on localhost. The prototype is a **façade** — it shows the design, not a working system. An approved prototype becomes the visual source of truth that `design-spec-writer` later translates into a real spec.

## Default Build: Static HTML + Tailwind CDN

Unless the invocation says otherwise, build a **single self-contained `index.html`** that pulls Tailwind from the CDN:

```html
<script src="https://cdn.tailwindcss.com"></script>
```

This needs no toolchain, no install, and serves instantly. Put custom tokens in an inline `tailwind.config` block or a `:root` CSS variable block so the prototype mirrors the repo's design system.

**Override at invocation only.** If the user asks for React, Vue, vanilla CSS, or a specific stack ("prototype this in React/Tailwind", "no CDN"), build that instead (see Stack Overrides). Do not silently switch stacks.

## Resolve the Input

1. If `$ARGUMENTS` names a `.specs/<slug>/` folder or a `proposal.md` path, read that proposal.
2. Otherwise use the most recently modified `.specs/*/proposal.md` that matches the feature under discussion.
3. If there is no proposal, build from the design direction described in the conversation. If there is neither, stop and ask what to prototype.

From the proposal, carry forward: the **Context Verdict** (posture + governing rules), the **Design Direction**, the **States** to render, and the **Design System Usage** (tokens/components to mirror).

## Honor the Proposal's Posture

- Read the governing rule the proposal named — `~/.agents/rules/functionalist-design.md` for functional surfaces, `~/.agents/rules/expressive-design.md` for expressive ones — and build to it. A functional prototype is restrained and dense; an expressive one commits to the named direction.
- Mirror the repo's design tokens (colors, spacing, type scale, fonts) into the prototype's config/variables so it reads as part of the system, not a stranger.
- **Render every state the proposal listed**, not just the ideal one. Show empty, loading, error, and partial states per `~/.agents/rules/ux-states.md` — inline, side by side, or toggled. A prototype that only shows the happy path hides the hard design decisions.
- Apply the non-negotiables: AA contrast, visible focus, semantic HTML, keyboard-reachable controls, and a layout that holds at 320px.

## Where to Write

Write prototype files to `.specs/<feature-slug>/prototype/`:

- Default: `index.html` (plus any local assets).
- To compare directions, produce `index.html`, `variant-b.html`, etc., and a small index page linking them with one-line labels. Offer this only when the direction is genuinely contested — one strong prototype beats three timid ones.

## Serve It

Start a local static server in the background and report the URL:

- Static build: serve `.specs/<feature-slug>/prototype/` with `python3 -m http.server <port> --bind 127.0.0.1` (run in the background). Pick an uncommon port (e.g. 4321) and bump it on collision.
- Report `http://localhost:<port>/` (and `/variant-b.html` etc. when present).
- Bind to loopback only.

Tell the user the URL, what to look at, and which states are visible. For static builds, edits to the file appear on refresh — no restart needed.

## Iterate

The prototype is a conversation. After the user comments:

- Make the requested changes directly in the prototype files.
- Tell the user to refresh; restart the server only if you changed the served path or port.
- Keep iterating until the user is satisfied with the direction.

## Stack Overrides

When the invocation requests a different stack, match it instead of the default:

- **React + Tailwind** — scaffold a minimal Vite app in `prototype/`, serve with the Vite dev server, report its URL. Use this when the user wants component structure closer to production, or the eventual real target is React and they want reusable prototype code.
- **Vanilla HTML/CSS (no CDN)** — a single `index.html` with an inline or adjacent stylesheet; serve the same way as the default.
- **Repo's own stack** — when asked to prototype "in our stack", match the framework and import the real tokens/components where practical.

Keep overrides as light as the request allows. A prototype is a façade; do not wire real data, real backends, auth, or routing beyond what makes the design legible.

## Output

Report:

1. The prototype files written, with paths.
2. The served URL(s) and which states/variants each shows.
3. The posture and rule the prototype follows, and which design tokens it mirrors.
4. What to look at and how to give feedback.
5. A reminder that an approved prototype is the visual source of truth for `design-spec-writer`.

Do not commit the prototype unless asked. Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
