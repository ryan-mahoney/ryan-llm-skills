// Bounded `kit.yaml` reader for Adjacent workspace storage.
//
// Node-standard-library only. `parseKit` tokenizes the supported YAML subset
// with source offsets, parses it with duplicate-key detection at every
// mapping, and then runs `validateKit`. `validateKit` mirrors
// `Adjacent.Projects.Kit` (`kit.ex`) validation paths and error order for the
// known fields, with `role` as optional string metadata that Adjacent ignores.
//
// Result shape: { ok, kit, raw, errors }.
// - `kit` normalized `{version, id, name, repositories:[{id, path, remote,
//   role}], context}` or null.
// - `raw` exact source plus line/span offsets for writers; see below.
// - `errors` syntax errors (`line N: ...`) are reported before any schema
//   validation; schema messages reuse Adjacent field paths and order
//   (`version`, `id`, `name`, `repositories[i].id/path/remote/role`,
//   `context[i]`).
//
// Raw shape (offsets are JavaScript string indices into `raw.text`, so slicing
// and concatenating can replace selected spans without reserializing unaffected
// bytes; BOM and CRLF bytes are retained):
// - raw.text     exact input string.
// - raw.bom      true when `text` starts with U+FEFF.
// - raw.newline  first line break seen (`"\r\n"`, `"\n"`), defaulting `"\n"`.
// - raw.lines    [{ number, start, end, break, contentStart, indent, blank }];
//                `start`/`end` delimit line content excluding `break`.
// - raw.root     AST node, or null after a syntax error:
//                scalar  { kind, line, start, end, value, quote, raw }
//                mapping { kind, line, start, end, value, entries:[{ key,
//                          keySpan, span, value }] } — `value` is a
//                          null-prototype object; `span` covers the key
//                          through the value end.
//                list    { kind, line, start, end, value, items:[{ span,
//                          value }] } — `span` covers the dash through value.
// - raw.spans    flat convenience map with a null prototype (a "__proto__"
//                source key is an ordinary own key): path -> { kind, line,
//                start, end, keySpan, entry }. Paths use Adjacent field-path
//                shape ("", "repositories[0].remote"); a key containing "."
//                or "[" makes the flat path ambiguous, so the AST is
//                authoritative.
//
// Supported subset: BOM; LF/CRLF; one leading `---` at column 0; blank lines;
// full-line and trailing `#` comments after plain scalars; block mappings and
// block lists (indented or indentless) nested arbitrarily; `[]`; plain scalars
// typed by the YAML 1.2 core schema (`null`/`~`/empty -> null, true/false ->
// boolean, `0|[-+]?[1-9][0-9]*` -> number, otherwise string); single-quoted
// scalars with `''`; double-quoted scalars with only `\"` and `\\` escapes.
// Rejected with a line number: tabs, anchors, aliases, tags, block scalars,
// multiline quoted scalars, flow collections other than `[]`, extra documents,
// duplicate keys, numeric-looking implicit forms outside the known integer
// syntax (decimal, exponent, hex/octal/binary, inf/nan) and non-printable
// source characters (C0/C1 controls, DEL and lone CR, while tab keeps its
// parse-time rules and U+0085 is permitted). Recursive descent is bounded to
// MAX_PARSE_DEPTH (64) nesting levels; deeper input fails with a line-numbered
// error instead of overflowing the stack.

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const INTEGER_PATTERN = /^(?:0|[-+]?[1-9][0-9]*)$/;
const NUMERIC_LOOKING_PATTERN =
  /^(?:[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)|[-+]?(?:inf|Inf|INF|nan|NaN|NAN)|[-+]?0[xX][0-9a-fA-F_]+|[-+]?0[oO][0-7_]+|[-+]?0[bB][01_]+|[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9_]+)?|[-+]?\.[0-9][0-9_]*(?:[eE][-+]?[0-9_]+)?)$/;

const PARSE_FAILURE = Symbol("kit parse failure");
const MISSING = Symbol("missing key");
// Bounds recursive descent so adversarial nesting fails with a line-numbered
// error instead of overflowing the stack.
const MAX_PARSE_DEPTH = 64;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function mappingValue(entries) {
  const value = Object.create(null);
  for (const entry of entries) value[entry.key] = entry.value.value;
  return value;
}

// Flat convenience index over an AST; the AST remains authoritative because
// dotted paths cannot express keys containing "." or "[".
function collectSpans(node, path, spans, context) {
  spans[path] = {
    kind: node.kind,
    line: node.line,
    start: node.start,
    end: node.end,
    keySpan: context ? context.keySpan : null,
    entry: context ? context.entry : null,
  };
  if (node.kind === "mapping") {
    for (const entry of node.entries) {
      const childPath = path === "" ? entry.key : `${path}.${entry.key}`;
      collectSpans(entry.value, childPath, spans, {
        keySpan: entry.keySpan,
        entry: entry.span,
      });
    }
  } else if (node.kind === "list") {
    for (let index = 0; index < node.items.length; index += 1) {
      const item = node.items[index];
      collectSpans(item.value, `${path}[${index}]`, spans, {
        keySpan: null,
        entry: item.span,
      });
    }
  }
}

function formatCodePoint(code) {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

// YAML source may not contain C0/C1 controls, DEL or lone CR bytes. Tabs keep
// their existing parse-time rules and U+0085 is a permitted YAML character, so
// both are skipped here. LF never reaches line content because lines split on it.
function firstNonPrintable(text, start, end) {
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x09 || code === 0x85) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return code;
  }
  return null;
}

// Split into records that keep original offsets and the exact newline bytes so
// writers can reproduce every unaffected byte.
function tokenize(text) {
  const bom = text.charCodeAt(0) === 0xfeff;
  const lines = [];
  const errors = [];
  let start = 0;
  let number = 1;
  let newline = "";
  for (;;) {
    const lf = text.indexOf("\n", start);
    let end;
    let lineBreak;
    if (lf === -1) {
      end = text.length;
      lineBreak = "";
    } else if (lf > start && text[lf - 1] === "\r") {
      end = lf - 1;
      lineBreak = "\r\n";
    } else {
      end = lf;
      lineBreak = "\n";
    }
    if (newline === "" && lineBreak !== "") newline = lineBreak;
    const forbidden = firstNonPrintable(text, start, end);
    if (forbidden !== null) {
      errors.push(
        `line ${number}: non-printable character ${formatCodePoint(forbidden)} is not permitted`,
      );
    }
    const contentBase = start + (number === 1 && bom ? 1 : 0);
    let cursor = contentBase;
    while (cursor < end && text[cursor] === " ") cursor += 1;
    const tabIndex = text.indexOf("\t", start);
    if (tabIndex !== -1 && tabIndex < end) {
      const message =
        tabIndex === cursor ? "tab indentation is not supported" : "tab characters are not supported";
      errors.push(`line ${number}: ${message}`);
    }
    lines.push({
      number,
      li: lines.length,
      start,
      end,
      break: lineBreak,
      contentStart: cursor,
      indent: cursor - contentBase,
      blank: cursor >= end || text[cursor] === "#",
    });
    if (lineBreak === "") break;
    start = lf + 1;
    number += 1;
  }
  return { bom, newline: newline || "\n", lines, errors };
}

class KitParser {
  constructor(text, lines) {
    this.text = text;
    this.lines = lines;
    this.index = 0;
    this.depth = 0;
    this.errors = [];
  }

  fail(lineNumber, message) {
    this.errors.push(`line ${lineNumber}: ${message}`);
    throw PARSE_FAILURE;
  }

  current() {
    for (let i = this.index; i < this.lines.length; i += 1) {
      if (!this.lines[i].blank) return this.lines[i];
    }
    return null;
  }

  nullNode(lineNumber, offset) {
    return {
      kind: "scalar",
      line: lineNumber,
      start: offset,
      end: offset,
      value: null,
      quote: null,
      raw: "",
    };
  }

  isDash(line, offset) {
    return (
      this.text[offset] === "-" &&
      (offset + 1 >= line.end || this.text[offset + 1] === " ")
    );
  }

  isDashLine(line) {
    return this.isDash(line, line.contentStart);
  }

  isDocumentMarker(line, marker) {
    if (line.indent !== 0) return false;
    if (!this.text.startsWith(marker, line.contentStart)) return false;
    const after = line.contentStart + marker.length;
    return after >= line.end || this.text[after] === " ";
  }

  skipSpaces(offset, limit, lineNumber) {
    let cursor = offset;
    while (cursor < limit) {
      const ch = this.text[cursor];
      if (ch === " ") cursor += 1;
      else if (ch === "\t") this.fail(lineNumber, "tab characters are not supported");
      else break;
    }
    return cursor;
  }

  ensureCommentOrEnd(line, offset) {
    const rest = this.skipSpaces(offset, line.end, line.number);
    if (rest >= line.end) return;
    if (this.text[rest] === "#") {
      if (rest > offset) return;
      this.fail(line.number, "comment must be preceded by whitespace");
    }
    this.fail(line.number, "unexpected content after scalar");
  }

  rejectUnsupportedStart(line, offset, inKey) {
    const first = this.text[offset];
    if (first === "&") this.fail(line.number, "anchors are not supported");
    if (first === "*") this.fail(line.number, "aliases are not supported");
    if (first === "!") this.fail(line.number, "tags are not supported");
    if (first === "|" || first === ">") {
      this.fail(line.number, "block scalars are not supported");
    }
    if (first === "{") this.fail(line.number, "flow mappings are not supported");
    if (first === "?") this.fail(line.number, "explicit mapping keys are not supported");
    if (first === "@") this.fail(line.number, 'reserved indicator "@" is not supported');
    if (first === "`") this.fail(line.number, 'reserved indicator "`" is not supported');
    if (first === "%") this.fail(line.number, "directives are not supported");
    if (first === "," || first === "]" || first === "}") {
      this.fail(line.number, "flow indicators are not supported");
    }
    if (first === "-" && (offset + 1 >= line.end || this.text[offset + 1] === " ")) {
      this.fail(line.number, "block sequence entries are not allowed in this context");
    }
    if (inKey && first === "[") {
      this.fail(line.number, "complex mapping keys are not supported");
    }
  }

  findPlainKeyColon(line, offset) {
    for (let i = offset; i < line.end; i += 1) {
      const ch = this.text[i];
      if (ch === "#" && (i === offset || this.text[i - 1] === " ")) return -1;
      if (ch === "\t") this.fail(line.number, "tab characters are not supported");
      if (ch === ":" && (i + 1 >= line.end || this.text[i + 1] === " ")) return i;
    }
    return -1;
  }

  mappingSeparator(line, offset) {
    const first = this.text[offset];
    if (first === '"' || first === "'") {
      const quoted = this.parseQuoted(line, offset);
      const colon = this.skipSpaces(quoted.end, line.end, line.number);
      return colon < line.end && this.text[colon] === ":" ? colon : -1;
    }
    this.rejectUnsupportedStart(line, offset, false);
    return this.findPlainKeyColon(line, offset);
  }

  parseQuoted(line, start) {
    const quote = this.text[start];
    let index = start + 1;
    let value = "";
    while (index < line.end) {
      const ch = this.text[index];
      if (ch === "\t") this.fail(line.number, "tab characters are not supported");
      if (quote === "'") {
        if (ch === "'") {
          if (this.text[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          return { value, end: index + 1 };
        }
        value += ch;
        index += 1;
        continue;
      }
      if (ch === '"') return { value, end: index + 1 };
      if (ch === "\\") {
        const escape = this.text[index + 1];
        if (escape === undefined) {
          this.fail(line.number, "unterminated double-quoted scalar");
        }
        if (escape === '"') {
          value += '"';
          index += 2;
          continue;
        }
        if (escape === "\\") {
          value += "\\";
          index += 2;
          continue;
        }
        this.fail(line.number, `unsupported escape sequence \\${escape}`);
      }
      value += ch;
      index += 1;
    }
    this.fail(
      line.number,
      quote === '"' ? "unterminated double-quoted scalar" : "unterminated single-quoted scalar",
    );
  }

  classifyPlain(token, line) {
    if (token === "~" || token === "null" || token === "Null" || token === "NULL") return null;
    if (token === "true" || token === "True" || token === "TRUE") return true;
    if (token === "false" || token === "False" || token === "FALSE") return false;
    if (INTEGER_PATTERN.test(token)) return Number(token);
    if (NUMERIC_LOOKING_PATTERN.test(token)) {
      this.fail(line.number, `unsupported numeric value ${JSON.stringify(token)}`);
    }
    return token;
  }

  parseScalarNode(line, start, limit) {
    const first = this.text[start];
    if (first === '"' || first === "'") {
      const quoted = this.parseQuoted(line, start);
      this.ensureCommentOrEnd(line, quoted.end);
      return {
        kind: "scalar",
        line: line.number,
        start,
        end: quoted.end,
        value: quoted.value,
        quote: first,
        raw: this.text.slice(start, quoted.end),
      };
    }
    if (first === "[") {
      const close = this.skipSpaces(start + 1, limit, line.number);
      if (close < limit && this.text[close] === "]") {
        const end = close + 1;
        this.ensureCommentOrEnd(line, end);
        return { kind: "list", line: line.number, start, end, value: [], items: [] };
      }
      this.fail(line.number, "flow collections are not supported");
    }
    this.rejectUnsupportedStart(line, start, false);
    let end = limit;
    for (let i = start; i < limit; i += 1) {
      const ch = this.text[i];
      if (ch === "\t") this.fail(line.number, "tab characters are not supported");
      if (ch === "#" && i > start && this.text[i - 1] === " ") {
        end = i;
        break;
      }
      if (ch === ":" && (i + 1 >= limit || this.text[i + 1] === " ")) {
        this.fail(line.number, "unexpected mapping entry inside a scalar value");
      }
    }
    const token = this.text.slice(start, end).trimEnd();
    if (token === "") this.fail(line.number, "empty scalar value");
    return {
      kind: "scalar",
      line: line.number,
      start,
      end: start + token.length,
      value: this.classifyPlain(token, line),
      quote: null,
      raw: token,
    };
  }

  parseNode(line, offset, indent) {
    if (this.depth >= MAX_PARSE_DEPTH) {
      this.fail(line.number, `nesting deeper than ${MAX_PARSE_DEPTH} levels is not supported`);
    }
    this.depth += 1;
    try {
      if (offset >= line.end || this.text[offset] === "#") {
        this.fail(line.number, "expected a node");
      }
      if (this.isDash(line, offset)) return this.parseList(line, offset, indent);
      if (this.mappingSeparator(line, offset) >= 0) return this.parseMapping(line, offset, indent);
      const scalar = this.parseScalarNode(line, offset, line.end);
      this.index = line.li + 1;
      return scalar;
    } finally {
      this.depth -= 1;
    }
  }

  parseMapping(startLine, startOffset, indent) {
    const entries = [];
    const keys = new Set();
    let line = startLine;
    let offset = startOffset;
    while (line) {
      this.index = line.li + 1;
      if (offset >= line.end || this.text[offset] === "#") {
        this.fail(line.number, "expected a mapping key");
      }
      const entry = this.parseMappingEntry(line, offset, indent);
      if (keys.has(entry.key)) {
        this.fail(line.number, `duplicate mapping key ${JSON.stringify(entry.key)}`);
      }
      keys.add(entry.key);
      entries.push(entry);
      const next = this.current();
      if (!next) break;
      if (next.indent < indent) break;
      if (next.indent > indent) this.fail(next.number, "unexpected indentation");
      if (this.isDashLine(next)) {
        this.fail(next.number, "expected a mapping key, got a list item");
      }
      line = next;
      offset = next.contentStart;
    }
    const start = entries.length > 0 ? entries[0].keySpan.start : startOffset;
    const end = entries.length > 0 ? entries[entries.length - 1].span.end : startOffset;
    return {
      kind: "mapping",
      line: startLine.number,
      start,
      end,
      value: mappingValue(entries),
      entries,
    };
  }

  parseMappingEntry(line, offset, indent) {
    const first = this.text[offset];
    let key;
    let keySpan;
    let afterColon;
    if (first === '"' || first === "'") {
      const quoted = this.parseQuoted(line, offset);
      const colon = this.skipSpaces(quoted.end, line.end, line.number);
      if (colon >= line.end || this.text[colon] !== ":") {
        this.fail(line.number, "expected ':' after mapping key");
      }
      if (colon + 1 < line.end && this.text[colon + 1] !== " ") {
        this.fail(line.number, "expected whitespace after ':' in mapping entry");
      }
      key = quoted.value;
      keySpan = { start: offset, end: quoted.end };
      afterColon = colon + 1;
    } else {
      this.rejectUnsupportedStart(line, offset, true);
      const colon = this.findPlainKeyColon(line, offset);
      if (colon < 0) this.fail(line.number, "expected ':' after mapping key");
      const rawKey = this.text.slice(offset, colon).trimEnd();
      if (rawKey === "") this.fail(line.number, "mapping key must not be empty");
      key = rawKey;
      keySpan = { start: offset, end: colon };
      afterColon = colon + 1;
    }
    const valueStart = this.skipSpaces(afterColon, line.end, line.number);
    let value;
    if (valueStart >= line.end || this.text[valueStart] === "#") {
      const next = this.current();
      if (next && next.indent > indent) {
        value = this.parseNode(next, next.contentStart, next.indent);
      } else if (next && next.indent === indent && this.isDashLine(next)) {
        value = this.parseList(next, next.contentStart, next.indent);
      } else {
        value = this.nullNode(line.number, afterColon);
      }
    } else {
      value = this.parseScalarNode(line, valueStart, line.end);
    }
    return { key, keySpan, span: { start: keySpan.start, end: value.end }, value };
  }

  parseList(startLine, startOffset, indent) {
    const items = [];
    let line = startLine;
    let offset = startOffset;
    while (line) {
      this.index = line.li + 1;
      if (!this.isDash(line, offset)) this.fail(line.number, "expected a list item");
      const itemStart = this.skipSpaces(offset + 1, line.end, line.number);
      let value;
      if (itemStart >= line.end || this.text[itemStart] === "#") {
        const next = this.current();
        if (next && next.indent > indent) {
          value = this.parseNode(next, next.contentStart, next.indent);
        } else {
          value = this.nullNode(line.number, offset + 1);
        }
      } else {
        value = this.parseNode(line, itemStart, itemStart - line.start);
      }
      items.push({ span: { start: offset, end: value.end }, value });
      const next = this.current();
      if (!next) break;
      if (next.indent < indent) break;
      if (next.indent > indent) this.fail(next.number, "unexpected indentation");
      if (!this.isDashLine(next)) break;
      line = next;
      offset = next.contentStart;
    }
    const start = items.length > 0 ? items[0].span.start : startOffset;
    const end = items.length > 0 ? items[items.length - 1].span.end : startOffset;
    return {
      kind: "list",
      line: startLine.number,
      start,
      end,
      value: items.map((item) => item.value.value),
      items,
    };
  }

  parseDocument() {
    try {
      let markerLine = null;
      let first = this.current();
      if (first && this.isDocumentMarker(first, "---")) {
        const rest = this.skipSpaces(first.contentStart + 3, first.end, first.number);
        if (rest < first.end && this.text[rest] !== "#") {
          this.fail(first.number, "unsupported content after document marker");
        }
        markerLine = first;
        this.index = first.li + 1;
        first = this.current();
      }
      for (const line of this.lines) {
        if (line.blank || (markerLine && line.li === markerLine.li)) continue;
        if (this.isDocumentMarker(line, "---")) {
          this.fail(line.number, "extra documents are not supported");
        }
        if (this.isDocumentMarker(line, "...")) {
          this.fail(line.number, "document end markers are not supported");
        }
      }
      if (!first) return this.nullNode(1, 0);
      const node = this.parseNode(first, first.contentStart, first.indent);
      const rest = this.current();
      if (rest) this.fail(rest.number, "unexpected content at this indentation");
      return node;
    } catch (error) {
      if (error !== PARSE_FAILURE) throw error;
      return null;
    }
  }
}

/**
 * Parse bounded kit text, then schema-validate the parsed mapping.
 * @param {string} text
 * @returns {{ok: boolean, kit: Object|null, raw: Object, errors: string[]}}
 */
export function parseKit(text) {
  if (typeof text !== "string") throw new TypeError("parseKit expects a string");
  const tokenized = tokenize(text);
  const raw = {
    text,
    bom: tokenized.bom,
    newline: tokenized.newline,
    lines: tokenized.lines,
    root: null,
    // Null prototype so a "__proto__" source key cannot collide with the
    // convenience index.
    spans: Object.create(null),
  };
  if (tokenized.errors.length > 0) {
    return { ok: false, kit: null, raw, errors: tokenized.errors };
  }
  const parser = new KitParser(text, tokenized.lines);
  const root = parser.parseDocument();
  if (!root) {
    return { ok: false, kit: null, raw, errors: parser.errors };
  }
  raw.root = root;
  collectSpans(root, "", raw.spans, null);
  const validation = validateKit(root.value);
  return { ok: validation.ok, kit: validation.kit, raw, errors: validation.errors };
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectValue(value) {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(inspectValue).join(", ")}]`;
  if (isMapping(value)) {
    const body = Object.keys(value)
      .map((key) => `${JSON.stringify(key)} => ${inspectValue(value[key])}`)
      .join(", ");
    return `%{${body}}`;
  }
  return String(value);
}

function requiredString(mapping, key, field, errors) {
  const value = hasOwn(mapping, key) ? mapping[key] : null;
  if (value === null || value === undefined) {
    errors.push(`${field}: required`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${field}: expected a string, got ${inspectValue(value)}`);
    return null;
  }
  if (value === "") {
    errors.push(`${field}: must not be empty`);
    return null;
  }
  return value;
}

function optionalString(mapping, key, field, errors) {
  const value = hasOwn(mapping, key) ? mapping[key] : null;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    errors.push(`${field}: expected a string, got ${inspectValue(value)}`);
    return null;
  }
  return value;
}

/**
 * Schema-validate a parsed kit document. Mirrors `Adjacent.Projects.Kit`
 * validation paths and order, then adds `role` as optional string metadata
 * after `remote`. Mappings may be null-prototype objects.
 * @param {Object|null} document
 * @returns {{ok: boolean, kit: Object|null, errors: string[]}}
 */
export function validateKit(document) {
  if (!isMapping(document)) {
    return {
      ok: false,
      kit: null,
      errors: ["kit.yaml: expected a mapping at the top level"],
    };
  }
  const errors = [];
  const kit = { version: null, id: null, name: null, repositories: [], context: [] };

  if (!hasOwn(document, "version")) errors.push("version: required");
  else if (document.version === 1) kit.version = 1;
  else errors.push(`version: unsupported value ${inspectValue(document.version)}`);

  if (!hasOwn(document, "id")) errors.push("id: required");
  else if (typeof document.id === "string") {
    kit.id = document.id;
    if (!ID_PATTERN.test(document.id)) errors.push("id: must match [a-z0-9][a-z0-9-]*");
  } else {
    errors.push(`id: expected a string, got ${inspectValue(document.id)}`);
  }

  if (!hasOwn(document, "name")) errors.push("name: required");
  else if (typeof document.name === "string") {
    if (document.name === "") errors.push("name: must not be empty");
    else kit.name = document.name;
  } else {
    errors.push(`name: expected a string, got ${inspectValue(document.name)}`);
  }

  const repositories = hasOwn(document, "repositories") ? document.repositories : MISSING;
  if (repositories === MISSING) {
    errors.push("repositories: required");
  } else if (!Array.isArray(repositories)) {
    errors.push(`repositories: expected a list, got ${inspectValue(repositories)}`);
  } else {
    const seen = new Set();
    for (let index = 0; index < repositories.length; index += 1) {
      const rawRepository = repositories[index];
      if (!isMapping(rawRepository)) {
        errors.push(`repositories[${index}]: expected a mapping`);
        continue;
      }
      const field = (name) => `repositories[${index}].${name}`;
      const repository = {
        id: requiredString(rawRepository, "id", field("id"), errors),
        path: requiredString(rawRepository, "path", field("path"), errors),
        remote: optionalString(rawRepository, "remote", field("remote"), errors),
        role: optionalString(rawRepository, "role", field("role"), errors),
      };
      kit.repositories.push(repository);
      if (repository.id !== null) {
        if (seen.has(repository.id)) {
          errors.push(`${field("id")}: duplicate repository id ${JSON.stringify(repository.id)}`);
        } else {
          seen.add(repository.id);
        }
      }
    }
  }

  if (hasOwn(document, "context") && document.context !== null && document.context !== undefined) {
    if (!Array.isArray(document.context)) {
      errors.push(`context: expected a list, got ${inspectValue(document.context)}`);
    } else {
      for (let index = 0; index < document.context.length; index += 1) {
        const entry = document.context[index];
        if (typeof entry === "string") kit.context.push(entry);
        else errors.push(`context[${index}]: expected a string, got ${inspectValue(entry)}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, kit: null, errors };
  return { ok: true, kit, errors: [] };
}
