/* Catalog route metadata, adapted from the source route registry. */
(() => {
  const designSystemRoutes = [
  {
    "slug": "index",
    "path": "pages/introduction.html",
    "title": "Design System",
    "section": "overview"
  },
  {
    "slug": "colors",
    "path": "pages/colors.html",
    "title": "Color",
    "section": "foundations"
  },
  {
    "slug": "typography",
    "path": "pages/typography.html",
    "title": "Typography",
    "section": "foundations"
  },
  {
    "slug": "layout",
    "path": "pages/layout.html",
    "title": "Layout & Surfaces",
    "section": "foundations"
  },
  {
    "slug": "buttons",
    "path": "pages/buttons.html",
    "title": "Buttons",
    "section": "components"
  },
  {
    "slug": "forms",
    "path": "pages/forms.html",
    "title": "Forms & Inputs",
    "section": "components"
  },
  {
    "slug": "navigation",
    "path": "pages/navigation.html",
    "title": "Navigation",
    "section": "components"
  },
  {
    "slug": "application-tabs",
    "path": "pages/application-tabs.html",
    "title": "Application tabs",
    "section": "components"
  },
  {
    "slug": "data",
    "path": "pages/data.html",
    "title": "Data Display",
    "section": "components"
  },
  {
    "slug": "document-picker",
    "path": "pages/document-picker.html",
    "title": "Document picker",
    "section": "components"
  },
  {
    "slug": "feedback",
    "path": "pages/feedback.html",
    "title": "Notices & Feedback",
    "section": "components"
  },
  {
    "slug": "overlays",
    "path": "pages/overlays.html",
    "title": "Drawers & Overlays",
    "section": "components"
  },
  {
    "slug": "file-upload",
    "path": "pages/file-upload.html",
    "title": "File upload",
    "section": "components"
  },
  {
    "slug": "collaboration",
    "path": "pages/collaboration.html",
    "title": "Collaboration",
    "section": "components"
  },
  {
    "slug": "document-actions",
    "path": "pages/document-actions.html",
    "title": "Document actions",
    "section": "components"
  },
  {
    "slug": "assistant",
    "path": "pages/assistant.html",
    "title": "Assistant",
    "section": "app-surfaces"
  },
  {
    "slug": "skills",
    "path": "pages/skills.html",
    "title": "Skills",
    "section": "app-surfaces"
  },
  {
    "slug": "graph",
    "path": "pages/graph.html",
    "title": "Graph canvas",
    "section": "app-surfaces"
  },
  {
    "slug": "git-status",
    "path": "pages/git-status.html",
    "title": "Git status",
    "section": "app-surfaces"
  },
  {
    "slug": "sequence",
    "path": "pages/sequence.html",
    "title": "Sequence (calendar)",
    "section": "app-surfaces"
  },
  {
    "slug": "plan",
    "path": "pages/plan.html",
    "title": "Plan (kanban)",
    "section": "app-surfaces"
  },
  {
    "slug": "preview",
    "path": "pages/preview.html",
    "title": "Markdown preview",
    "section": "app-surfaces"
  },
  {
    "slug": "library",
    "path": "pages/library.html",
    "title": "Library",
    "section": "app-surfaces"
  },
  {
    "slug": "search",
    "path": "pages/search.html",
    "title": "Search",
    "section": "app-surfaces"
  },
  {
    "slug": "home",
    "path": "pages/home.html",
    "title": "Home",
    "section": "app-surfaces"
  }
];
  const bySlug = new Map(designSystemRoutes.map(route => [route.slug, route]));
  function getDesignSystemRoute(rawSlug) {
    const slug = rawSlug ?? '';
    if (slug === '') return designSystemRoutes[0];
    const route = bySlug.get(slug);
    if (!route) throw new Error(`Unknown design-system page: ${slug}`);
    return route;
  }
  function getDesignSystemPath(slug) { return getDesignSystemRoute(slug).path; }
  globalThis.DSHelpers = Object.assign(globalThis.DSHelpers || {}, { designSystemRoutes, getDesignSystemRoute, getDesignSystemPath });
})();
