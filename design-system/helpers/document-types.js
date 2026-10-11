(function (root) {
  const DOCUMENT_TYPES = {
    document: { label: "Document", accentVar: "--ds-faint", icon: "▤" },
    sequence: { label: "Sequence", accentVar: "--ds-info", icon: "▦" },
    plan: { label: "Plan", accentVar: "--ds-accent", icon: "▥" },
    deck: { label: "Deck", accentVar: "--ds-ident", icon: "▤" },
    brainstorm: { label: "Brainstorm", accentVar: "--ds-unsaved", icon: "✳" },
    feature: { label: "Feature", accentVar: "--ds-accent", icon: "⑂" },
    prototype: { label: "Prototype", accentVar: "--ds-violet", icon: "⌘" },
    "design-system": { label: "Design System", accentVar: "--ds-ident", icon: "▦" },
    refactor: { label: "Refactor", accentVar: "--ds-amber", icon: "⇄" },
    documentation: { label: "Documentation", accentVar: "--ds-info", icon: "▤" },
    thread: { label: "Thread", accentVar: "--ds-faint", icon: "☷" }
  };
  root.DSHelpers = Object.assign(root.DSHelpers || {}, { DOCUMENT_TYPES });
})(globalThis);
