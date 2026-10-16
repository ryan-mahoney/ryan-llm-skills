import { createHash } from 'node:crypto';
import { safePath } from '../changeset/workspace.mjs';

const javascript = /\.(?:mjs|cjs|js|jsx)$/i;
const tailCharacters = 8000;
const tailBoundaryLineLimit = 256;
const candidateLimit = 16;
const callable = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

export class SourceRequestError extends Error {
  constructor(message, details = {}) {
    super(`needs discovery: ${message}`);
    this.name = 'SourceRequestError';
    Object.assign(this, details);
  }
}
const fail = (message, details) => { throw new SourceRequestError(message, details); };
const keyName = node => node?.type === 'PrivateIdentifier' ? `#${node.name}` : node?.name ??
  (node?.type === 'Literal' && ['string', 'number'].includes(typeof node.value) ? String(node.value) : null);
function patternNames(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'RestElement') return patternNames(node.argument);
  if (node.type === 'AssignmentPattern') return patternNames(node.left);
  if (node.type === 'ArrayPattern') return node.elements.flatMap(patternNames);
  if (node.type === 'ObjectPattern') return node.properties.flatMap(item => patternNames(item.type === 'RestElement' ? item.argument : item.value));
  return [];
}
function findUniqueAnchor(source, offset) {
  const length = Math.min(160, source.length - offset);
  if (length < 1) return null;
  const text = source.slice(offset, offset + length);
  return source.indexOf(text) === offset && source.lastIndexOf(text) === offset ? text : null;
}
function uniqueAnchor(source, offset) {
  return findUniqueAnchor(source, offset) ?? fail(`source boundary at offset ${offset} has no unique anchor within 160 characters`);
}
function parsedSource(path, source, parse) {
  if (typeof parse !== 'function') fail(`parser unavailable for ${path}`);
  const comments = [];
  let tree;
  try { tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, onComment: comments }); }
  catch (error) { fail(`cannot parse source ${path}: ${error.message}`); }
  const leading = offset => {
    for (const comment of [...comments].reverse()) {
      if (comment.end > offset) continue;
      if (/\S/.test(source.slice(comment.end, offset))) break;
      const line = source.lastIndexOf('\n', comment.start - 1) + 1;
      if (/\S/.test(source.slice(line, comment.start))) break;
      offset = comment.start;
    }
    return offset;
  };
  const symbols = [], parents = new WeakMap();
  const visit = (node, parent = null, owner = null) => {
    if (!node || typeof node !== 'object') return;
    parents.set(node, parent);
    const outer = ['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(parent?.type) ? parent : node;
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      owner = node.id?.name ?? (parent?.type === 'VariableDeclarator' ? parent.id?.name : null);
      if (node.type === 'ClassDeclaration' && node.id?.name) symbols.push({ name: node.id.name, node: outer });
    }
    if (node.type === 'ObjectExpression') owner = parent?.type === 'VariableDeclarator' ? parent.id?.name ?? null : null;
    if (['FunctionDeclaration', 'FunctionExpression'].includes(node.type) && node.id?.name) symbols.push({ name: node.id.name, node: outer });
    if (node.type === 'VariableDeclarator') {
      let statement = parent?.type === 'VariableDeclaration' ? parent : node;
      const container = parents.get(statement);
      if (['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(container?.type)) statement = container;
      for (const name of patternNames(node.id)) symbols.push({ name, node: statement });
    }
    if (node.type === 'MethodDefinition' || (node.type === 'Property' && (node.method || callable.has(node.value?.type)))) {
      const name = node.computed && node.key?.type !== 'Literal' ? null : keyName(node.key);
      if (name) symbols.push({ name, qualified: owner ? `${owner}.${name}` : null, node });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node, owner));
      else if (value && typeof value === 'object') visit(value, node, owner);
    }
  };
  visit(tree);
  // A literal inside a nested prompt wrapper still selects its complete outer test
  // or module-level helper. Methods avoid pulling an entire enclosing class.
  const enclosing = (start, end) => {
    const statement = tree.body.find(node => leading(node.start) <= start && end <= node.end);
    if (!statement) fail(`literal has no enclosing source statement in ${path}`);
    const declaration = statement.declaration ?? statement;
    if (['ClassDeclaration', 'ClassExpression'].includes(declaration.type)) {
      const method = declaration.body.body.find(node => node.type === 'MethodDefinition' && leading(node.start) <= start && end <= node.end);
      if (method) return method;
    }
    return statement;
  };
  return { symbols, leading, enclosing };
}

/** Read one bounded batch from the supplied frozen source map; never performs I/O. */
export function resolveSourceRequests(files, requests, { parse, maxCharacters = 64000, maxRequests = 8 } = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail('a frozen source map is required');
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || !Number.isInteger(maxRequests) || maxRequests < 1)
    fail('source limits must be positive integers');
  if (!Array.isArray(requests) || !requests.length || requests.length > maxRequests)
    fail(`expected 1..${maxRequests} source requests`);
  const parsed = new Map(), snippets = [];
  let sourceCharacters = 0;
  for (const [request_index, request] of requests.entries()) {
    const errorDetails = { request_index };
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('invalid source request', errorDetails);
    const modes = ['symbol', 'search', 'tail', 'whole'].filter(key => Object.hasOwn(request, key));
    if (modes.length !== 1 || Object.keys(request).some(key => !['path', modes[0], ...(modes[0] === 'search' ? ['occurrence'] : [])].includes(key)))
      fail('source request needs a path and exactly one selector', errorDetails);
    const mode = modes[0], path = request.path;
    try { safePath(path); } catch { fail(`invalid checkout source path: ${String(path)}`, errorDetails); }
    if (!Object.hasOwn(files, path) || typeof files[path] !== 'string') fail(`unknown frozen source path: ${path}`, errorDetails);
    const source = files[path];
    if (!source.length) fail(`source file is empty: ${path}`, errorDetails);
    let begin = 0, end = source.length;
    const ast = () => {
      if (!javascript.test(path)) fail(`AST selectors require JavaScript source: ${path}`, errorDetails);
      if (!parsed.has(path)) parsed.set(path, parsedSource(path, source, parse));
      return parsed.get(path);
    };
    if (mode === 'symbol') {
      if (typeof request.symbol !== 'string' || !request.symbol.trim()) fail('symbol must be a nonempty exact name', errorDetails);
      const data = ast(), matches = data.symbols.filter(item => item.name === request.symbol || item.qualified === request.symbol);
      if (!matches.length) fail(`symbol not found: ${path} ${request.symbol}`, errorDetails);
      if (matches.length > 1) fail(`ambiguous symbol: ${path} ${request.symbol}`, { ...errorDetails,
        matches: matches.length, candidates: matches.slice(0, candidateLimit).map(item => ({ offset: item.node.start,
          header: source.slice(item.node.start, Math.min(item.node.end, item.node.start + 160)) })) });
      begin = data.leading(matches[0].node.start); end = matches[0].node.end;
    } else if (mode === 'search') {
      if (typeof request.search !== 'string' || !request.search.length) fail('search must be a nonempty literal string', errorDetails);
      if (Object.hasOwn(request, 'occurrence') && (!Number.isInteger(request.occurrence) || request.occurrence < 0))
        fail('search occurrence must be a zero-based nonnegative integer', errorDetails);
      let count = 0, selected = null;
      const candidates = [];
      for (let offset = source.indexOf(request.search); offset >= 0; offset = source.indexOf(request.search, offset + 1)) {
        if (count === (request.occurrence ?? 0)) selected = offset;
        if (candidates.length < candidateLimit) {
          const line = source.lastIndexOf('\n', offset - 1) + 1;
          candidates.push({ offset, header: source.slice(line, Math.min(source.length, line + 160)) });
        }
        count++;
      }
      if (!count) fail(`literal not found in ${path}`, errorDetails);
      if (count > 1 && !Object.hasOwn(request, 'occurrence')) fail(`ambiguous literal in ${path}; specify zero-based occurrence`, { ...errorDetails, matches: count, candidates });
      if (selected === null) fail(`literal occurrence out of range in ${path}; found ${count} matches`, { ...errorDetails, matches: count, candidates });
      if (javascript.test(path)) {
        const data = ast(), node = data.enclosing(selected, selected + request.search.length);
        begin = data.leading(node.start); end = node.end;
      } else {
        begin = source.lastIndexOf('\n', selected - 1) + 1;
        const newline = source.indexOf('\n', selected + request.search.length);
        end = newline < 0 ? source.length : newline + 1;
      }
    } else if (mode === 'tail') {
      if (request.tail !== true) fail('tail selector must be true', errorDetails);
      begin = Math.max(0, source.length - Math.min(tailCharacters, maxCharacters));
      // Avoid a partial leading line when a complete trailing line fits.
      if (begin > 0 && source[begin - 1] !== '\n') {
        const newline = source.indexOf('\n', begin);
        if (newline >= begin && newline + 1 < end) begin = newline + 1;
      }
      // Repeated fixture lines may have no unique anchor. A tail is an explicitly
      // bounded suffix; choose its first uniquely bound complete line within that
      // suffix, never extend the request or fabricate an anchor.
      let boundaryLines = 0;
      while (begin > 0) {
        if (boundaryLines++ >= tailBoundaryLineLimit)
          fail(`tail has no unique source boundary within ${tailBoundaryLineLimit} lines in ${path}`, errorDetails);
        if (findUniqueAnchor(source, begin)) break;
        const newline = source.indexOf('\n', begin);
        if (newline < 0 || newline + 1 >= end) fail(`tail has no unique source boundary in ${path}`, errorDetails);
        begin = newline + 1;
      }
    } else if (request.whole !== true) fail('whole selector must be true', errorDetails);
    // Keep trailing whitespace up to the next token (or EOF). A final declaration
    // should bind EOF rather than require a unique anchor made only of newlines.
    if (mode === 'symbol' || (mode === 'search' && javascript.test(path))) {
      while (end < source.length && /\s/.test(source[end])) end++;
    }
    const length = end - begin;
    if (sourceCharacters + length > maxCharacters)
      fail(`requested source exceeds ${maxCharacters} characters at ${path}`, { ...errorDetails, source_characters: sourceCharacters + length });
    let startAnchor, endAnchor;
    try { startAnchor = begin === 0 ? null : uniqueAnchor(source, begin); endAnchor = end === source.length ? null : uniqueAnchor(source, end); }
    catch (error) { Object.assign(error, errorDetails, { path }); throw error; }
    snippets.push({ request_index, path, request: { ...request }, source_hash: createHash('sha256').update(source).digest('hex'),
      source_start: begin, source_end: end, start: startAnchor, end: endAnchor, text: source.slice(begin, end) });
    sourceCharacters += length;
  }
  return { schema_version: 1, offset_units: 'utf16-code-units', source_characters: sourceCharacters, snippets };
}
