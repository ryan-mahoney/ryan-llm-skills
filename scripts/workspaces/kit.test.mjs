// Step 1 focused tests: the bounded kit parser subset.
//
// Run: node --test --test-name-pattern='parser subset' scripts/workspaces/kit.test.mjs
//
// Expected values are hand-derived from the Adjacent kit schema; accepted
// fixtures also run through the actual Adjacent consumer oracle in EV-1.

import test from "node:test";
import assert from "node:assert/strict";
import { formatScalar, parseKit, planKitEdit, validateKit } from "./kit.mjs";

test("parser subset: parses hand-derived empty repositories", () => {
  const text = "version: 1\nid: demo\nname: Demo\nrepositories: []\n";
  const result = parseKit(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.kit, {
    version: 1,
    id: "demo",
    name: "Demo",
    repositories: [],
    context: [],
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.raw.text, text);
  assert.equal(result.raw.root.kind, "mapping");
});

test("parser subset: retains trailing U+00A0 in a plain repository path", () => {
  const text = "version: 1\nid: demo\nname: Demo\nrepositories:\n  - id: demo\n    path: /srv/demo\u00A0   # separation spaces\n";
  const result = parseKit(text);
  assert.equal(result.ok, true);
  assert.equal(result.kit.repositories[0].path, "/srv/demo\u00A0");
  const span = result.raw.spans["repositories[0].path"];
  assert.equal(text.slice(span.start, span.end), "/srv/demo\u00A0");
});

test("parser subset: retains trailing U+00A0 in a plain mapping key as unknown", () => {
  const result = parseKit("version: 1\nid\u00A0  : demo\nname: Demo\nrepositories: []\n");
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["id: required"]);
  assert.equal(result.raw.root.value["id\u00A0"], "demo");
  assert.equal(Object.hasOwn(result.raw.root.value, "id"), false);
});

test("parser subset: reads BOM, CRLF, marker, comments, quoted hashes and escaped quotes", () => {
  const text =
    "\uFEFF---\r\n" +
    "version: 1\r\n" +
    "# full-line comment\r\n" +
    "id: demo\r\n" +
    'name: "A \\"quoted\\" #hash"\r\n' +
    "repositories:\r\n" +
    "  - id: transitops-co\r\n" +
    "    path: /srv/transitops-co # trailing comment\r\n" +
    "    remote: git@example.com:transitops/co.git\r\n" +
    "context:\r\n" +
    "  - 'two''s'\r\n";
  const result = parseKit(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.kit, {
    version: 1,
    id: "demo",
    name: 'A "quoted" #hash',
    repositories: [
      {
        id: "transitops-co",
        path: "/srv/transitops-co",
        remote: "git@example.com:transitops/co.git",
        role: null,
      },
    ],
    context: ["two's"],
  });
  assert.equal(result.raw.text, text);
  assert.equal(result.raw.bom, true);
  assert.equal(result.raw.lines[0].number, 1);
  assert.equal(result.raw.lines[0].start, 0);
  assert.equal(result.raw.lines[0].contentStart, 1);
  assert.equal(result.raw.lines[0].break, "\r\n");
  assert.equal(
    result.raw.lines.map((line) => text.slice(line.start, line.end) + line.break).join(""),
    text,
  );
});

test("parser subset: preserves unknown transitops-shaped mappings and lists", () => {
  const text = [
    "version: 1",
    "id: transitops",
    "name: TransitOps",
    "# retained comment",
    "repositories:",
    "  - id: transitops-co",
    "    path: /srv/transitops-co",
    "    remote: git@example.com:transitops/co.git",
    "    # unknown repository metadata",
    "    labels:",
    "      - web",
    "      - api",
    "design_system:",
    "  layout:",
    "    columns: 12",
    "    breakpoints:",
    "      - sm",
    "      - md",
    "  tokens:",
    "    radius: 4",
    "context:",
    "  - docs",
    "  - design",
    "",
  ].join("\n");
  const result = parseKit(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.kit.repositories, [
    {
      id: "transitops-co",
      path: "/srv/transitops-co",
      remote: "git@example.com:transitops/co.git",
      role: null,
    },
  ]);
  assert.deepEqual(result.kit.context, ["docs", "design"]);
  const document = result.raw.root.value;
  assert.deepEqual(document.repositories[0].labels, ["web", "api"]);
  assert.equal(document.design_system.layout.columns, 12);
  assert.deepEqual(document.design_system.layout.breakpoints, ["sm", "md"]);
  assert.equal(document.design_system.tokens.radius, 4);

  const spans = result.raw.spans;
  const radius = spans["design_system.tokens.radius"];
  assert.equal(text.slice(radius.start, radius.end), "4");
  const breakpoint = spans["design_system.layout.breakpoints[1]"];
  assert.equal(text.slice(breakpoint.start, breakpoint.end), "md");
  const entry = spans["repositories[0]"].entry;
  assert.equal(text.slice(entry.start, entry.start + 1), "-");
  const labels = spans["repositories[0].labels[1]"];
  assert.equal(text.slice(labels.start, labels.end), "api");
});

test("parser subset: types null, bool, integer, keyword and quoted scalars", () => {
  const text = [
    "version: 1",
    "id: demo",
    "name: Demo",
    "repositories: []",
    "meta:",
    "  nil_tilde: ~",
    "  nil_word: null",
    "  nil_empty:",
    "  truthy: true",
    "  falsy: False",
    "  zero: 0",
    "  negative: -12",
    "  positive: +34",
    "  yes_value: yes",
    "  no_value: no",
    "  on_value: on",
    "  off_value: off",
    "  y_value: y",
    "  n_value: n",
    "  hash_mid: a#b",
    '  quoted_number: "5"',
    "  quoted_float: '1.5'",
    "  quoted_keyword: 'off'",
    "",
  ].join("\n");
  const result = parseKit(text);
  assert.equal(result.ok, true);
  const meta = result.raw.root.value.meta;
  assert.equal(meta.nil_tilde, null);
  assert.equal(meta.nil_word, null);
  assert.equal(meta.nil_empty, null);
  assert.equal(meta.truthy, true);
  assert.equal(meta.falsy, false);
  assert.equal(meta.zero, 0);
  assert.equal(meta.negative, -12);
  assert.equal(meta.positive, 34);
  assert.equal(meta.yes_value, "yes");
  assert.equal(meta.no_value, "no");
  assert.equal(meta.on_value, "on");
  assert.equal(meta.off_value, "off");
  assert.equal(meta.y_value, "y");
  assert.equal(meta.n_value, "n");
  assert.equal(meta.hash_mid, "a#b");
  assert.equal(meta.quoted_number, "5");
  assert.equal(meta.quoted_float, "1.5");
  assert.equal(meta.quoted_keyword, "off");
});

test("parser subset: rejects duplicate mapping keys and duplicate repository ids", () => {
  const duplicateKey = [
    "version: 1",
    "id: demo",
    "name: Demo",
    "repositories: []",
    "meta:",
    "  a: 1",
    "  a: 2",
    "",
  ].join("\n");
  const keyResult = parseKit(duplicateKey);
  assert.equal(keyResult.ok, false);
  assert.equal(keyResult.kit, null);
  assert.deepEqual(keyResult.errors, ['line 7: duplicate mapping key "a"']);

  const duplicateRepository = [
    "version: 1",
    "id: demo",
    "name: Demo",
    "repositories:",
    "  - id: a",
    "    path: /a",
    "  - id: a",
    "    path: /b",
    "",
  ].join("\n");
  const repositoryResult = parseKit(duplicateRepository);
  assert.equal(repositoryResult.ok, false);
  assert.deepEqual(repositoryResult.errors, ['repositories[1].id: duplicate repository id "a"']);
});

test("parser subset: rejects float, exponent, hex and other unsupported numerics", () => {
  const tokens = ["1.5", "1.", ".5", "1e3", "1E3", "0x1f", "0o17", "0b101", "017", "-0", ".inf", ".nan"];
  for (const token of tokens) {
    const text = `version: 1\nid: demo\nname: Demo\nrepositories: []\nmeta:\n  value: ${token}\n`;
    const result = parseKit(text);
    assert.equal(result.ok, false, token);
    assert.equal(result.errors.length, 1, token);
    assert.match(result.errors[0], /^line 6: unsupported numeric value /, token);
  }
  const version = parseKit("version: 1.5\n");
  assert.equal(version.ok, false);
  assert.match(version.errors[0], /^line 1: unsupported numeric value "1\.5"$/);
});

test("parser subset: rejects malformed unknown subtrees and unterminated quotes", () => {
  const malformed = [
    "version: 1",
    "id: demo",
    "name: Demo",
    "repositories: []",
    "meta:",
    "  child:",
    "    - one",
    "   - two",
    "",
  ].join("\n");
  const indentation = parseKit(malformed);
  assert.equal(indentation.ok, false);
  assert.deepEqual(indentation.errors, ["line 8: unexpected indentation"]);

  const doubleQuote = parseKit('version: 1\nid: demo\nname: "Demo\nrepositories: []\n');
  assert.equal(doubleQuote.ok, false);
  assert.deepEqual(doubleQuote.errors, ["line 3: unterminated double-quoted scalar"]);

  const singleQuote = parseKit("version: 1\nid: demo\nname: Demo\nrepositories:\n  - 'one\n");
  assert.equal(singleQuote.ok, false);
  assert.deepEqual(singleQuote.errors, ["line 5: unterminated single-quoted scalar"]);

  const flowMapping = parseKit("version: 1\nid: demo\nname: Demo\nrepositories: []\nmeta: {a: 1}\n");
  assert.equal(flowMapping.ok, false);
  assert.deepEqual(flowMapping.errors, ["line 5: flow mappings are not supported"]);

  const syntaxBeforeSchema = parseKit('version: 2\nid: demo\nname: "Demo\n');
  assert.equal(syntaxBeforeSchema.ok, false);
  assert.deepEqual(syntaxBeforeSchema.errors, ["line 3: unterminated double-quoted scalar"]);
});

test("parser subset: rejects tabs, anchors, tags, aliases, block scalars, flow collections and extra documents", () => {
  const cases = [
    ["name: &anchor Demo\n", /^line 1: anchors are not supported$/],
    ["name: *anchor\n", /^line 1: aliases are not supported$/],
    ["name: !tag Demo\n", /^line 1: tags are not supported$/],
    ["name: |\n  text\n", /^line 1: block scalars are not supported$/],
    ["name: >\n  text\n", /^line 1: block scalars are not supported$/],
    ["name: [a]\n", /^line 1: flow collections are not supported$/],
    ["name: {a: 1}\n", /^line 1: flow mappings are not supported$/],
    ["? key\n: value\n", /^line 1: explicit mapping keys are not supported$/],
    ['name: "Demo" extra\n', /^line 1: unexpected content after scalar$/],
    ["version: 1\n---\nid: demo\n", /^line 2: extra documents are not supported$/],
    ["version: 1\n...\nid: demo\n", /^line 2: document end markers are not supported$/],
    ["version: 1\nid: demo\nname: Demo\nrepositories:\n\t- id: a\n", /^line 5: tab indentation is not supported$/],
    ["name: De\tmo\n", /^line 1: tab characters are not supported$/],
    ["# comment\tbad\n", /^line 1: tab characters are not supported$/],
    ["name: Demo # comment\tbad\n", /^line 1: tab characters are not supported$/],
  ];
  for (const [text, pattern] of cases) {
    const result = parseKit(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.errors.length, 1, text);
    assert.match(result.errors[0], pattern, text);
  }
});

test("parser subset: orders schema errors like Adjacent with role after remote", () => {
  const text = [
    "name: ''",
    "id: Bad",
    "version: 2",
    "repositories:",
    "  - id: ''",
    "    path: /a",
    "    remote: 5",
    "    role: 6",
    "  - path: /b",
    "context: [ ]",
    "",
  ].join("\n");
  const result = parseKit(text);
  assert.equal(result.ok, false);
  assert.equal(result.kit, null);
  assert.deepEqual(result.errors, [
    "version: unsupported value 2",
    "id: must match [a-z0-9][a-z0-9-]*",
    "name: must not be empty",
    "repositories[0].id: must not be empty",
    "repositories[0].remote: expected a string, got 5",
    "repositories[0].role: expected a string, got 6",
    "repositories[1].id: required",
  ]);
  assert.notEqual(result.raw.root, null);

  const bare = parseKit("version: 1\nid: demo\nname: Demo\nrepositories:\n");
  assert.deepEqual(bare.errors, ["repositories: expected a list, got nil"]);

  const missing = parseKit("repositories: []\n");
  assert.deepEqual(missing.errors, ["version: required", "id: required", "name: required"]);

  const withRole = [
    "version: 1",
    "id: demo",
    "name: Demo",
    "repositories:",
    "  - id: a",
    "    path: /a",
    "    role: design-system",
    "context:",
    "  - docs",
    "",
  ].join("\n");
  const valid = parseKit(withRole);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.kit.repositories, [
    { id: "a", path: "/a", remote: null, role: "design-system" },
  ]);
  assert.deepEqual(valid.kit.context, ["docs"]);
});

test("parser subset: reconstructs source bytes from raw spans", () => {
  const text =
    "version: 1\r\n" +
    "id: demo\r\n" +
    "name: Demo\r\n" +
    "repositories:\r\n" +
    "  - id: a\r\n" +
    "    path: /srv/a # keep\r\n" +
    "    remote: git@example.com:a/b.git\r\n";
  const first = parseKit(text);
  assert.equal(first.ok, true);
  assert.equal(first.raw.bom, false);
  assert.equal(first.raw.newline, "\r\n");
  assert.equal(
    first.raw.lines.map((line) => text.slice(line.start, line.end) + line.break).join(""),
    text,
  );

  const path = first.raw.spans["repositories[0].path"];
  const remote = first.raw.spans["repositories[0].remote"];
  assert.equal(text.slice(path.start, path.end), "/srv/a");
  assert.equal(text.slice(remote.start, remote.end), "git@example.com:a/b.git");

  const next = text.slice(0, path.start) + "/srv/b" + text.slice(path.end);
  assert.equal(next.slice(0, path.start), text.slice(0, path.start));
  assert.equal(next.slice(path.start + "/srv/b".length), text.slice(path.end));
  assert.equal(next.includes("# keep"), true);
  const reparsed = parseKit(next);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.kit.repositories[0].path, "/srv/b");
  assert.equal(reparsed.kit.repositories[0].remote, "git@example.com:a/b.git");

  const bomText = "\uFEFFversion: 1\nid: demo\nname: Demo\nrepositories: []\n";
  const bom = parseKit(bomText);
  assert.equal(bom.ok, true);
  assert.equal(bom.raw.bom, true);
  assert.equal(bom.raw.lines[0].start, 0);
  assert.equal(bom.raw.lines[0].contentStart, 1);
  assert.equal(
    bomText.slice(bom.raw.lines[0].start, bom.raw.lines[0].end),
    "\uFEFFversion: 1",
  );
});

test("parser subset: validateKit validates mappings with null prototypes", () => {
  const document = Object.create(null);
  document.version = 1;
  document.id = "demo";
  document.name = "Demo";
  document.repositories = [];
  const result = validateKit(document);
  assert.equal(result.ok, true);
  assert.deepEqual(result.kit, {
    version: 1,
    id: "demo",
    name: "Demo",
    repositories: [],
    context: [],
  });
  assert.deepEqual(validateKit(null), {
    ok: false,
    kit: null,
    errors: ["kit.yaml: expected a mapping at the top level"],
  });
});

test("parser subset: makes progress through nested mappings and lists", () => {
  const text = [
    "version: 1",
    "id: progress",
    "name: Progress",
    "repositories:",
    "  - id: a",
    "    path: /srv/a",
    "    meta:",
    "      tags:",
    "        - one",
    "        - two",
    "      note: alpha",
    "  - id: b",
    "    path: /srv/b",
    "    labels:",
    "    - x",
    "    - y",
    "context:",
    "  - docs",
    "  - design",
    "",
  ].join("\n");
  const result = parseKit(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.kit.repositories, [
    { id: "a", path: "/srv/a", remote: null, role: null },
    { id: "b", path: "/srv/b", remote: null, role: null },
  ]);
  assert.deepEqual(result.kit.context, ["docs", "design"]);
  const document = result.raw.root.value;
  assert.deepEqual(document.repositories[0].meta.tags, ["one", "two"]);
  assert.equal(document.repositories[0].meta.note, "alpha");
  assert.deepEqual(document.repositories[1].labels, ["x", "y"]);
});

test("parser subset: validates a root scalar or list as a non-mapping document", () => {
  const scalar = parseKit("hello\n");
  assert.equal(scalar.ok, false);
  assert.deepEqual(scalar.errors, ["kit.yaml: expected a mapping at the top level"]);
  assert.equal(scalar.raw.root.kind, "scalar");

  const list = parseKit("- a\n- b\n");
  assert.equal(list.ok, false);
  assert.deepEqual(list.errors, ["kit.yaml: expected a mapping at the top level"]);
  assert.equal(list.raw.root.kind, "list");

  const trailing = parseKit("hello\nworld\n");
  assert.equal(trailing.ok, false);
  assert.deepEqual(trailing.errors, ["line 2: unexpected content at this indentation"]);
});

test("parser subset: rejects reserved plain scalar starts", () => {
  const cases = [
    ["name: @value\n", /reserved indicator/],
    ["name: `value\n", /reserved indicator/],
    ["name: %value\n", /directives are not supported/],
    ["name: ,value\n", /flow indicators are not supported/],
    ["name: ]value\n", /flow indicators are not supported/],
    ["name: }value\n", /flow indicators are not supported/],
    ["name: - value\n", /block sequence entries are not allowed in this context/],
  ];
  for (const [text, pattern] of cases) {
    const result = parseKit(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.errors.length, 1, text);
    assert.match(result.errors[0], /^line 1: /, text);
    assert.match(result.errors[0], pattern, text);
  }
});

test("parser subset: requires spacing around quoted keys and scalar comments", () => {
  const gluedKey = parseKit('"version":1\n"id": demo\n');
  assert.equal(gluedKey.ok, false);
  assert.deepEqual(gluedKey.errors, ["line 1: expected whitespace after ':' in mapping entry"]);

  const spacedKey = parseKit('"version": 1\n"id": demo\n"name": Demo\n"repositories": []\n');
  assert.equal(spacedKey.ok, true);
  assert.equal(spacedKey.kit.id, "demo");

  const gluedQuoteComment = parseKit('version: 1\nid: demo\nname: "Demo"#bad\nrepositories: []\n');
  assert.equal(gluedQuoteComment.ok, false);
  assert.deepEqual(gluedQuoteComment.errors, [
    "line 3: comment must be preceded by whitespace",
  ]);

  const gluedFlowComment = parseKit("version: 1\nid: demo\nname: Demo\nrepositories: []#bad\n");
  assert.equal(gluedFlowComment.ok, false);
  assert.deepEqual(gluedFlowComment.errors, [
    "line 4: comment must be preceded by whitespace",
  ]);

  const spacedComment = parseKit('version: 1\nid: demo\nname: "Demo" # ok\nrepositories: [] # ok\n');
  assert.equal(spacedComment.ok, true);
  assert.equal(spacedComment.kit.name, "Demo");
});

test("parser subset: bounds recursive nesting with a line-numbered error", () => {
  const lines = ["version: 1", "id: depth", "name: Depth", "repositories: []", "meta:"];
  let indent = 2;
  for (let level = 0; level < 80; level += 1) {
    lines.push(" ".repeat(indent) + `l${level}:`);
    indent += 2;
  }
  const result = parseKit(`${lines.join("\n")}\n`);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /^line \d+: nesting deeper than 64 levels is not supported$/,
  );
});

test("parser subset: rejects non-printable YAML source characters", () => {
  const nulInQuote = parseKit('version: 1\nid: demo\nname: "De\u0000mo"\nrepositories: []\n');
  assert.equal(nulInQuote.ok, false);
  assert.deepEqual(nulInQuote.errors, [
    "line 3: non-printable character U+0000 is not permitted",
  ]);

  const loneCarriageReturn = parseKit("version: 1\nid: demo\nname: Demo\nrepositories: []\r");
  assert.equal(loneCarriageReturn.ok, false);
  assert.deepEqual(loneCarriageReturn.errors, [
    "line 4: non-printable character U+000D is not permitted",
  ]);

  const controlInUnknown = parseKit(
    "version: 1\nid: demo\nname: Demo\nrepositories: []\nmeta:\n  value: a\u0007b\n",
  );
  assert.equal(controlInUnknown.ok, false);
  assert.deepEqual(controlInUnknown.errors, [
    "line 6: non-printable character U+0007 is not permitted",
  ]);

  const del = parseKit("version: 1\nid: demo\nname: Demo\u007f\nrepositories: []\n");
  assert.equal(del.ok, false);
  assert.deepEqual(del.errors, ["line 3: non-printable character U+007F is not permitted"]);

  const c1 = parseKit("version: 1\nid: demo\nname: Demo\u0086\nrepositories: []\n");
  assert.equal(c1.ok, false);
  assert.deepEqual(c1.errors, ["line 3: non-printable character U+0086 is not permitted"]);

  const nel = parseKit("version: 1\nid: demo\nname: Demo\u0085\nrepositories: []\n");
  assert.equal(nel.ok, true);
  assert.equal(nel.kit.name, "Demo\u0085");

  const unicode = parseKit(
    'version: 1\nid: demo\nname: "caf\u00e9 \u2014 \u0394\u03bf\u03ba\u03b9\u03bc\u03ae \ud83d\ude80"\nrepositories: []\ncontext:\n  - na\u00efve\n',
  );
  assert.equal(unicode.ok, true);
  assert.equal(unicode.kit.name, "caf\u00e9 \u2014 \u0394\u03bf\u03ba\u03b9\u03bc\u03ae \ud83d\ude80");
  assert.deepEqual(unicode.kit.context, ["na\u00efve"]);
});

test("parser subset: preserves __proto__ keys without prototype pollution", () => {
  const text = [
    "version: 1",
    "id: proto",
    "name: Proto",
    "repositories: []",
    "__proto__:",
    "  polluted: false",
    "unknown:",
    "  __proto__:",
    "    nested: true",
    "  child: value",
    "",
  ].join("\n");
  const result = parseKit(text);
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.raw.spans), null);
  assert.equal(result.raw.spans["__proto__"].kind, "mapping");
  assert.equal(result.raw.spans["unknown.__proto__"].kind, "mapping");
  assert.equal(result.raw.root.value["__proto__"].polluted, false);
  assert.equal(result.raw.root.value.unknown["__proto__"].nested, true);
  assert.equal(Object.getPrototypeOf(result.raw.root.value), null);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test("kit edit planner: replaces an existing role and keeps every other byte", () => {
  const text = [
    "version: 1",
    "id: planner",
    "name: Planner",
    "# retained comment",
    "repositories:",
    "  - id: a",
    "    path: /srv/a",
    "    role: design-system # keep comment",
    "    meta:",
    "      nested: value",
    "  - id: b",
    "    path: /srv/b",
    "design_system:",
    "  tokens:",
    "    radius: 4",
    "",
  ].join("\n");
  const plan = planKitEdit(text, { kind: "set-role", repository_id: "a", role: "platform" });
  assert.equal(plan.before, text);
  assert.equal(
    plan.after,
    [
      "version: 1",
      "id: planner",
      "name: Planner",
      "# retained comment",
      "repositories:",
      "  - id: a",
      "    path: /srv/a",
      '    role: "platform" # keep comment',
      "    meta:",
      "      nested: value",
      "  - id: b",
      "    path: /srv/b",
      "design_system:",
      "  tokens:",
      "    radius: 4",
      "",
    ].join("\n"),
  );
  assert.deepEqual(plan.expected, {
    version: 1,
    id: "planner",
    name: "Planner",
    repositories: [
      { id: "a", path: "/srv/a", remote: null, role: "platform" },
      { id: "b", path: "/srv/b", remote: null, role: null },
    ],
    context: [],
  });
  assert.deepEqual(plan.hunk, {
    start_line: 8,
    before_lines: ["    role: design-system # keep comment\n"],
    after_lines: ['    role: "platform" # keep comment\n'],
  });
});

test("kit edit planner: replaces bare and explicit null roles", () => {
  const bare = planKitEdit(
    "version: 1\nid: bare\nname: Bare\nrepositories:\n  - id: a\n    path: /a\n    role:\n",
    { kind: "set-role", repository_id: "a", role: "observer" },
  );
  assert.equal(
    bare.after,
    'version: 1\nid: bare\nname: Bare\nrepositories:\n  - id: a\n    path: /a\n    role: "observer"\n',
  );

  const comment = planKitEdit(
    "version: 1\nid: bare\nname: Bare\nrepositories:\n  - id: a\n    path: /a\n    role: # note\n",
    { kind: "set-role", repository_id: "a", role: "observer" },
  );
  assert.equal(
    comment.after,
    'version: 1\nid: bare\nname: Bare\nrepositories:\n  - id: a\n    path: /a\n    role: "observer" # note\n',
  );

  const explicit = planKitEdit(
    "version: 1\nid: bare\nname: Bare\nrepositories:\n  - id: a\n    path: /a\n    role: null\n",
    { kind: "set-role", repository_id: "a", role: "observer" },
  );
  assert.equal(
    explicit.after,
    'version: 1\nid: bare\nname: Bare\nrepositories:\n  - id: a\n    path: /a\n    role: "observer"\n',
  );
  assert.equal(explicit.expected.repositories[0].role, "observer");
});

test("kit edit planner: inserts an absent role after the final occupied line", () => {
  const text = [
    "version: 1",
    "id: planner",
    "name: Planner",
    "repositories:",
    "  - id: first",
    "    path: /first",
    "  - id: middle",
    "    path: /middle",
    "    meta:",
    "      nested: value",
    "  - id: last",
    "    path: /last",
    "",
  ].join("\n");
  const plan = planKitEdit(text, { kind: "set-role", repository_id: "middle", role: "reviewer" });
  assert.equal(
    plan.after,
    [
      "version: 1",
      "id: planner",
      "name: Planner",
      "repositories:",
      "  - id: first",
      "    path: /first",
      "  - id: middle",
      "    path: /middle",
      "    meta:",
      "      nested: value",
      '    role: "reviewer"',
      "  - id: last",
      "    path: /last",
      "",
    ].join("\n"),
  );
  assert.deepEqual(plan.hunk, {
    start_line: 10,
    before_lines: ["      nested: value\n"],
    after_lines: ["      nested: value\n", '    role: "reviewer"\n'],
  });
  assert.equal(plan.expected.repositories[1].role, "reviewer");
});

test("kit edit planner: appends a repository after the final occupied item", () => {
  const text = [
    "version: 1",
    "id: planner",
    "name: Planner",
    "# retained comment",
    "repositories:",
    "  - id: a",
    "    path: /srv/a # keep",
    "design_system:",
    "  tokens:",
    "    radius: 4",
    "",
  ].join("\n");
  const plan = planKitEdit(text, {
    kind: "add-repository",
    repository: { id: "b", path: "/srv/b", remote: "git@example.com:b.git", role: "worker" },
  });
  assert.equal(
    plan.after,
    [
      "version: 1",
      "id: planner",
      "name: Planner",
      "# retained comment",
      "repositories:",
      "  - id: a",
      "    path: /srv/a # keep",
      '  - id: "b"',
      '    path: "/srv/b"',
      '    remote: "git@example.com:b.git"',
      '    role: "worker"',
      "design_system:",
      "  tokens:",
      "    radius: 4",
      "",
    ].join("\n"),
  );
  assert.deepEqual(plan.expected.repositories[1], {
    id: "b",
    path: "/srv/b",
    remote: "git@example.com:b.git",
    role: "worker",
  });
  assert.deepEqual(plan.hunk, {
    start_line: 7,
    before_lines: ["    path: /srv/a # keep\n"],
    after_lines: [
      "    path: /srv/a # keep\n",
      '  - id: "b"\n',
      '    path: "/srv/b"\n',
      '    remote: "git@example.com:b.git"\n',
      '    role: "worker"\n',
    ],
  });
});

test("kit edit planner: converts an empty flow list at the key line", () => {
  const commented = planKitEdit(
    "version: 1\nid: empty\nname: Empty\nrepositories: [] # none yet\n",
    { kind: "add-repository", repository: { id: "a", path: "/a" } },
  );
  assert.equal(
    commented.after,
    'version: 1\nid: empty\nname: Empty\nrepositories:  # none yet\n  - id: "a"\n    path: "/a"\n',
  );
  assert.deepEqual(commented.hunk, {
    start_line: 4,
    before_lines: ["repositories: [] # none yet\n"],
    after_lines: ["repositories:  # none yet\n", '  - id: "a"\n', '    path: "/a"\n'],
  });

  const bare = planKitEdit("version: 1\nid: empty\nname: Empty\nrepositories: []", {
    kind: "add-repository",
    repository: { id: "a", path: "/a" },
  });
  assert.equal(
    bare.after,
    'version: 1\nid: empty\nname: Empty\nrepositories: \n  - id: "a"\n    path: "/a"',
  );
});

test("kit edit planner: appends into an indentless repository list", () => {
  const text =
    "version: 1\nid: indentless\nname: Indentless\nrepositories:\n- id: a\n  path: /a\ncontext:\n- docs\n";
  const plan = planKitEdit(text, {
    kind: "add-repository",
    repository: { id: "b", path: "/b" },
  });
  assert.equal(
    plan.after,
    'version: 1\nid: indentless\nname: Indentless\nrepositories:\n- id: a\n  path: /a\n- id: "b"\n  path: "/b"\ncontext:\n- docs\n',
  );
});

test("kit edit planner: preserves BOM, CRLF and the no-final-newline convention", () => {
  const crlf = planKitEdit(
    "\uFEFFversion: 1\r\nid: crlf\r\nname: Crlf\r\nrepositories: []\r\n",
    { kind: "add-repository", repository: { id: "a", path: "/a" } },
  );
  assert.equal(
    crlf.after,
    '\uFEFFversion: 1\r\nid: crlf\r\nname: Crlf\r\nrepositories: \r\n  - id: "a"\r\n    path: "/a"\r\n',
  );
  assert.equal(crlf.hunk.before_lines[0], "repositories: []\r\n");

  const noFinal = planKitEdit(
    "version: 1\nid: eof\nname: Eof\nrepositories:\n  - id: a\n    path: /a",
    { kind: "set-role", repository_id: "a", role: "observer" },
  );
  assert.equal(
    noFinal.after,
    'version: 1\nid: eof\nname: Eof\nrepositories:\n  - id: a\n    path: /a\n    role: "observer"',
  );
});

test("kit edit planner: keeps numeric, keyword, hash, quote and backslash values as strings", () => {
  const text = "version: 1\nid: tricky\nname: Tricky\nrepositories:\n  - id: a\n    path: /a\n";
  const plan = planKitEdit(text, {
    kind: "add-repository",
    repository: {
      id: "b",
      path: "/srv/a # not a comment",
      remote: "yes",
      role: 'quote " and \\ slash',
    },
  });
  assert.equal(
    plan.after,
    [
      "version: 1",
      "id: tricky",
      "name: Tricky",
      "repositories:",
      "  - id: a",
      "    path: /a",
      '  - id: "b"',
      '    path: "/srv/a # not a comment"',
      '    remote: "yes"',
      '    role: "quote \\" and \\\\ slash"',
      "",
    ].join("\n"),
  );
  const reparsed = parseKit(plan.after);
  assert.equal(reparsed.ok, true);
  assert.deepEqual(reparsed.kit, plan.expected);
  assert.equal(reparsed.kit.repositories[1].path, "/srv/a # not a comment");
  assert.equal(reparsed.kit.repositories[1].remote, "yes");
  assert.equal(reparsed.kit.repositories[1].role, 'quote " and \\ slash');

  const numeric = planKitEdit(text, { kind: "set-role", repository_id: "a", role: "1.5" });
  assert.equal(parseKit(numeric.after).kit.repositories[0].role, "1.5");
  assert.equal(numeric.after.includes('role: "1.5"'), true);
});

test("kit edit planner: refuses invalid text, operations and values", () => {
  const text =
    "version: 1\nid: valid\nname: Valid\nrepositories:\n  - id: a\n    path: /a\n";
  assert.throws(
    () => planKitEdit("id: broken\n", { kind: "set-role", repository_id: "x", role: "r" }),
    /kit text is not valid/,
  );
  assert.throws(() => planKitEdit(text, null), /expects an operation object/);
  assert.throws(() => planKitEdit(text, { kind: "unknown" }), /unknown operation kind/);
  assert.throws(
    () => planKitEdit(text, { kind: "add-repository", repository: { id: "a", path: "/b" } }),
    /already exists/,
  );
  assert.throws(
    () => planKitEdit(text, { kind: "set-role", repository_id: "missing", role: "r" }),
    /no repository with id/,
  );
  assert.throws(
    () => planKitEdit(text, { kind: "add-repository", repository: { id: "", path: "/b" } }),
    /non-empty repository id/,
  );
  assert.throws(
    () => planKitEdit(text, { kind: "add-repository", repository: { id: "b", path: "" } }),
    /non-empty repository path/,
  );
  assert.throws(
    () =>
      planKitEdit(text, {
        kind: "add-repository",
        repository: { id: "b", path: "/b", remote: 5 },
      }),
    /remote must be a string or null/,
  );
  assert.throws(
    () =>
      planKitEdit(text, {
        kind: "add-repository",
        repository: { id: "b", path: "/b", role: 5 },
      }),
    /role must be a string or null/,
  );
  assert.throws(
    () => planKitEdit(text, { kind: "set-role", repository_id: "a", role: 5 }),
    /requires a string role/,
  );
  assert.throws(
    () => planKitEdit(text, { kind: "set-role", repository_id: "", role: "r" }),
    /non-empty repository_id/,
  );
});

test("kit edit planner: quotes arbitrary repository ids that Adjacent accepts", () => {
  const text = "version: 1\nid: ids\nname: Ids\nrepositories:\n  - id: a\n    path: /a\n";
  for (const id of ["Repo.A", "1.5", "yes", "null", "Repo A # id"]) {
    const plan = planKitEdit(text, { kind: "add-repository", repository: { id, path: "/b" } });
    assert.equal(plan.expected.repositories[1].id, id, id);
    assert.equal(parseKit(plan.after).kit.repositories[1].id, id, id);
    assert.equal(plan.after.includes(`- id: ${formatScalar(id)}`), true, id);
  }
  assert.throws(
    () =>
      planKitEdit(text, {
        kind: "add-repository",
        repository: { id: "bad\nid", path: "/b" },
      }),
    /control character/,
  );
});

test("kit edit planner: formatScalar quotes strings and refuses unsafe characters", () => {
  assert.equal(formatScalar("plain"), '"plain"');
  assert.equal(formatScalar("1.5"), '"1.5"');
  assert.equal(formatScalar("yes"), '"yes"');
  assert.equal(formatScalar("a # b"), '"a # b"');
  assert.equal(formatScalar(""), '""');
  assert.equal(formatScalar('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(formatScalar("caf\u00e9 \ud83d\ude80"), '"caf\u00e9 \ud83d\ude80"');
  assert.throws(() => formatScalar(5), /expects a string/);
  assert.throws(() => formatScalar("\n"), /control character U\+000A/);
  assert.throws(() => formatScalar("\u0000"), /control character U\+0000/);
  assert.throws(() => formatScalar("\u007f"), /control character U\+007F/);
  assert.throws(() => formatScalar("\u0085"), /control character U\+0085/);
  assert.throws(() => formatScalar("\ud800"), /lone surrogate U\+D800/);
  assert.throws(() => formatScalar("\udc00"), /lone surrogate U\+DC00/);
  assert.throws(() => formatScalar("\u2028"), /line separator U\+2028/);
  assert.throws(() => formatScalar("\u2029"), /line separator U\+2029/);
});
