(function (root) {
  const STATUS_COLORS = [
    { value: "slate", label: "Slate", var: "--ds-status-slate" },
    { value: "blue", label: "Blue", var: "--ds-status-blue" },
    { value: "violet", label: "Violet", var: "--ds-status-violet" },
    { value: "green", label: "Green", var: "--ds-status-green" },
    { value: "amber", label: "Amber", var: "--ds-status-amber" },
    { value: "red", label: "Red", var: "--ds-status-red" }
  ];
  const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const DEFAULT_STATUS_COLOR = "slate";
  const statusColorVar = (value) => (STATUS_COLORS.find((c) => c.value === value) || STATUS_COLORS[0]).var;
  const common = ["Draft", "In review", "Final"].map((label, i) => ({ id: slugify(label), label, color: ["slate", "amber", "green"][i] }));
  const planLabels = ["Backlog", "Current", "In Progress", "In Review", "Done"];
  const DOCUMENT_TYPE_STATUSES = {
    document: common, deck: common,
    plan: planLabels.map((label, i) => ({ id: slugify(label), label, color: ["slate", "blue", "amber", "violet", "green"][i] })),
    sequence: ["Draft", "Scheduled", "Published"].map((label, i) => ({ id: slugify(label), label, color: ["slate", "blue", "green"][i] })),
    brainstorm: ["Open", "Promising", "Parked"].map((label, i) => ({ id: slugify(label), label, color: ["slate", "violet", "amber"][i] }))
  };
  ["feature", "prototype", "design-system", "refactor", "documentation", "thread"].forEach((type) => { DOCUMENT_TYPE_STATUSES[type] = common; });
  function matchStatusOption(type, status) { const slug = slugify(status); return (DOCUMENT_TYPE_STATUSES[type] || []).find((o) => o.id === slug) || null; }
  root.DSHelpers = Object.assign(root.DSHelpers || {}, { STATUS_COLORS, DEFAULT_STATUS_COLOR, statusColorVar, DOCUMENT_TYPE_STATUSES, matchStatusOption });
})(globalThis);
