# Design system reference

This directory is an offline, native HTML reference for the `rearrange-writer` design system. It was imported from source revision `a8ed68577d7d559013b351e62faac3f89d3b28f1` on 2026-10-11. The original source paths and file digests remain recorded in [provenance.json](provenance.json); [conversion.json](conversion.json) maps those sources to the converted pages and records their section coverage.

Open [index.html](index.html) directly. The catalog contains 44 standalone HTML references built with semantic HTML, Tailwind utilities, the original design-system classes, and local JavaScript. It works from `file://` without a build, server, or network connection. The page-level appearance and text-size controls support dark/light themes and normal/large text.

## Files

| Path | Purpose |
|---|---|
| [index.html](index.html) | Searchable entry point for pages, component examples, and shell references. |
| [pages/](pages/) | Product and foundation references, including forms, navigation, overlays, assistant, graph, preview, search, and collaboration. |
| [components/](components/) | Standalone component and assembled-product specimens. |
| [shell/](shell/) | Reference examples for the application shell, layout, page building blocks, theme controls, and brand mark. |
| [helpers/](helpers/) | Eight JavaScript ports of source helpers plus four local demo modules used by interactive specimens. Source-helper APIs are exposed on `globalThis.DSHelpers`. |
| [design-system.css](design-system.css) | Original stylesheet, unchanged: theme tokens, reusable component classes, and product-surface styles. |
| [catalog.css](catalog.css) and [catalog.js](catalog.js) | Shared catalog shell, appearance persistence, URL overrides, and index search. |
| [vendor/tailwind.js](vendor/tailwind.js) | Pinned Tailwind CSS 3.4.17 browser runtime, vendored for offline use. |
| [conversion.json](conversion.json) | Source-to-output mapping, ownership, exported names, and documented section/specimen coverage. |
| [provenance.json](provenance.json) | Original source repository, revision, import date, and SHA-256 digests. |
| [reference/docs/ux/](reference/docs/ux/) | Imported UX guidance documents used while translating the reference. |

The standalone pages do not load React, Ark UI, React Flow, MDXEditor, or other application dependencies. Their examples use browser-native controls and inline SVG where appropriate. The eight source-helper ports preserve the original `theme.ts`, `portalThemeProps.ts`, route, status, document-type, plan-board, search-index, and sequence-calendar behavior as plain JavaScript. The `plan-demo.js`, `search-demo.js`, `sequence-demo.js`, and `skills-demo.js` modules provide local interactions for their larger specimens.

Interactive examples update only the current page. They do not call application services, save to a workspace, change access, synchronize collaboration state, or send assistant requests. Where a specialized editor or service is not available, the reference labels the local behavior and its limit. HTML and Markdown preview downloads are generated in the browser; other export formats are examples only.

## Visual language

- Dense, calm functional surfaces. Spacing follows a 4px grid; borders mark boundaries. Small radii distinguish controls without turning every region into a card.
- Green identifies the current place and selected create or next-step actions. Indigo identifies interactive work, links, primary actions, and focus. Mirror the relevant component example rather than treating every action as green.
- Theme-dependent surfaces and text use `--ds-*` variables. The editor's paper surface stays white with dark text in both themes.
- UI and prose use the Inter font stack. Identifiers use the JetBrains Mono stack. This snapshot includes no font binaries: the offline reference uses the declared system fallbacks when those fonts are not installed.
- Page titles use 30px/700, sections 18px/700, subsections 15px/600, body 14px/400, and secondary body 13px/400. `--ds-fs` is 1 normally and 1.18 for large text.
- Controls retain the upstream dimensions: action buttons 38px, small buttons 34px, and inputs 40px. When a prototype needs larger hit targets, preserve accessibility and record the departure in its design index.
- State is communicated through text and semantics as well as color. Interactive controls need visible focus and keyboard access.

## Use with design-plan and design-run

The workspace kit resolves this system through repository ID `agents`:

```yaml
design_system:
  repository: agents
  paths:
    - design-system/README.md
    - design-system/index.html
    - design-system/design-system.css
```

`design-plan` should use this README, the searchable catalog, the token stylesheet, and only the page/component references relevant to the requested screens. The conversion and provenance manifests preserve the relationship to the source revision without requiring the removed TypeScript source tree. In `design.json`, set `design_system.path` to this README's absolute path and `design_system.tokens` to the stylesheet's absolute path. An explicit `--design-system` can point to this README as well.

`design-run` produces one self-contained HTML file per screen and state with its pinned Tailwind runtime. Translate utilities to the runtime supported by the design package. Copy the needed palette, variables, and component CSS into each screen; do not link the completed prototype to this repository. Keep the theme wrapper:

```html
<body class="restory-ds" data-theme="dark" data-text-scale="normal">
  <button type="button" class="ds-btn ds-btn--primary ds-focusable">
    Save changes
  </button>
</body>
```

These catalog pages intentionally include multiple states and specimens. Product prototypes follow `rules/prototype-design.md`: one rendered state, domain content, and design rationale outside the screen.

## Refreshing the snapshot

Validate the catalog from the repository root with `node scripts/design-system/verify.mjs`.
The check covers source-to-output coverage, original section titles, local resources,
JavaScript syntax, pinned Tailwind and provenance digests, and removal of TypeScript files.
The conversion's focused browser and helper checks are recorded in [verification.json](verification.json).

When updating the reference, record the source repository revision and refresh the source digests and source-to-output coverage in `provenance.json` and `conversion.json`. Keep local design-system CSS and catalog behavior separate from imported source artifacts. There is no automatic synchronization with `rearrange-writer`.
