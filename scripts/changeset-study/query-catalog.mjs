import { basename, dirname, join, normalize } from 'node:path';

const javascriptExtensions = /\.(?:mjs|cjs|js|jsx)$/i;
const referencePattern = /(?:\.\.\/|\.\/)*(?:[\w@.-]+\/)*[\w@.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|md|mdx|txt|json|ya?ml|toml|sh)\b/gi;
const identifierBoundary = name => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
const unique = values => [...new Set(values)];

function normalizeRef(value) {
  const parts = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function references(brief) {
  return [...brief.matchAll(referencePattern)].map(match => ({ raw: match[0], at: match.index,
    normalized: normalizeRef(match[0]), explicit: match[0].includes('/') }));
}

function resolvePaths(files, brief) {
  const keys = Object.keys(files).map(path => path.replaceAll('\\', '/'));
  const allRefs = references(brief), resolved = new Map(), absentPaths = [], explicitTargets = new Map();
  const unresolvedRefs = allRefs.filter(ref => ref.normalized === null).map(ref => ({
    reference: ref.raw, reason: 'relative path escapes the checkout; its location is unresolved',
  }));
  const refs = allRefs.filter(ref => ref.normalized !== null);
  const matchRef = ref => {
    const exact = keys.filter(path => path === ref.normalized);
    if (exact.length) return exact;
    const suffix = keys.filter(path => path.endsWith('/' + ref.normalized));
    return suffix;
  };

  for (const ref of refs.filter(item => item.explicit && (item.normalized.includes('/') || item.raw.split('/').includes('..')))) {
    const candidates = matchRef(ref);
    if (candidates.length > 1) throw new Error(`needs-discovery: ambiguous path ${ref.raw}`);
    const path = candidates[0] ?? ref.normalized;
    const targetSet = explicitTargets.get(basename(path)) ?? new Set();
    targetSet.add(path);
    explicitTargets.set(basename(path), targetSet);
    if (candidates.length === 1) resolved.set(ref, candidates[0]);
    else absentPaths.push(ref);
  }

  const explicitDirectories = unique([...resolved.values()].map(path => dirname(path)));
  for (const ref of refs.filter(item => !resolved.has(item) && !absentPaths.includes(item))) {
    let candidates = [];
    const statedTargets = explicitTargets.get(basename(ref.normalized));
    if (statedTargets?.size === 1) candidates = [...statedTargets];
    else if (statedTargets?.size > 1) throw new Error(`needs-discovery: ambiguous basename ${ref.normalized}`);
    if (ref.raw.startsWith('./')) {
      if (!candidates.length) {
        candidates = explicitDirectories.map(dir => normalize(join(dir, ref.normalized))).filter(path => keys.includes(path));
        candidates = unique(candidates);
      }
    }
    if (!candidates.length) {
      const explicitlyResolved = [...resolved.values()].filter(path => basename(path) === ref.normalized);
      if (explicitlyResolved.length) candidates = unique(explicitlyResolved);
      else candidates = keys.filter(path => basename(path) === ref.normalized);
    }
    if (candidates.length > 1) throw new Error(`needs-discovery: ambiguous basename ${ref.normalized}`);
    if (candidates.length === 1) resolved.set(ref, candidates[0]);
    else {
      unresolvedRefs.push({ reference: ref.raw,
        reason: 'no matching path in the supplied source map and no full path identifies its location' });
    }
  }

  const selected = new Map();
  for (const [ref, path] of resolved) selected.set(path, { path, exists: typeof files[path] === 'string', source: ref.raw });
  for (const ref of absentPaths) {
    const path = ref.normalized;
    if (path && !selected.has(path)) selected.set(path, { path, exists: false, source: ref.raw });
  }
  const uniqueUnresolved = new Map(unresolvedRefs.map(ref => [ref.reference, ref]));
  return { selected: [...selected.values()].sort((a, b) => a.path.localeCompare(b.path)),
    unresolved_refs: [...uniqueUnresolved.values()].sort((a, b) => a.reference.localeCompare(b.reference)) };
}

function uniqueAnchor(source, offset, maxLength = 160) {
  const remaining = source.length - offset;
  if (offset < 0 || offset > source.length || remaining === 0) return null;
  const max = Math.min(maxLength, remaining);
  for (let length = Math.min(8, max); length <= max; length++) {
    const text = source.slice(offset, offset + length);
    if (source.indexOf(text) === offset && source.lastIndexOf(text) === offset) return text;
  }
  return null;
}

function boundaries(source, start, end, detailed) {
  if (!detailed) return {};
  const row = { start_offset: start, end_offset: end };
  const start_anchor = start === source.length ? null : uniqueAnchor(source, start);
  const end_anchor = end === source.length ? null : uniqueAnchor(source, end);
  if ((start !== source.length && start_anchor === null) || (end !== source.length && end_anchor === null)) {
    throw new Error('needs-discovery: an explicitly named source boundary has no unique anchor of at most 160 characters');
  }
  return { ...row, start_anchor, end_anchor };
}

function nameOf(node) {
  return node?.name ?? (node?.type === 'Literal' ? String(node.value) : null);
}

function importInfo(node) {
  return { source: node.source.value, specifiers: node.specifiers.map(specifier => ({
    imported: specifier.imported?.name ?? specifier.imported?.value ?? 'default', local: specifier.local.name,
  })) };
}

function testCallName(statement, aliases) {
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') return null;
  const call = statement.expression, callee = call.callee;
  const direct = callee.type === 'Identifier' && aliases.has(callee.name);
  const modifier = callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' &&
    aliases.has(callee.object.name) && ['skip', 'only', 'todo'].includes(callee.property.name);
  if (!direct && !modifier) return null;
  const arg = call.arguments[0];
  if (arg?.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg?.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  return null;
}

function astCatalog(path, source, brief, parse) {
  let tree;
  const comments = [];
  try { tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, onComment: comments }); }
  catch { throw new Error(`needs-discovery: cannot parse named JavaScript source ${path}`); }
  const body = tree.body ?? [], tests = [], imports = [], symbols = [], classes = [];
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
  const signature = (node, outer = node) => source.slice(outer.start, node.body?.start ?? node.end).trimEnd();
  const declarationNames = new Map();
  const localDefinitions = [];
  const collect = (node, parent = null) => {
    if (!node || typeof node !== 'object') return;
    let name;
    if (node.type === 'FunctionDeclaration') name = node.id?.name;
    if (node.type === 'VariableDeclarator') name = node.id?.name;
    if (name) {
      declarationNames.set(name, (declarationNames.get(name) ?? 0) + 1);
      localDefinitions.push({ node, parent, name });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => collect(child, node));
      else if (value && typeof value === 'object') collect(value, node);
    }
  };
  collect(tree);
  const aliases = new Set();
  for (const node of body) if (node.type === 'ImportDeclaration' && ['node:test', 'test'].includes(node.source.value)) {
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportDefaultSpecifier' || ['test', 'it'].includes(specifier.imported?.name)) aliases.add(specifier.local.name);
    }
  }
  for (let i = 0; i < body.length; i++) {
    const node = body[i], next = body[i + 1] ? leading(body[i + 1].start) : source.length;
    const declaration = ['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(node.type) && node.declaration
      ? node.declaration : node;
    if (node.type === 'ImportDeclaration') {
      const info = importInfo(node), named = brief.includes(info.source) || info.specifiers.some(item => identifierBoundary(item.local).test(brief));
      const detailed = i === 0 || named;
      imports.push({ ...info, ...boundaries(source, leading(node.start), next, detailed), ...(detailed ? { detailed: true } : {}) });
    }
    if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
      const name = declaration.id?.name ?? '(anonymous)';
      const detailed = name !== '(anonymous)' && identifierBoundary(name).test(brief);
      const item = { ...(detailed ? { signature: signature(declaration, node) } : {}), kind: declaration.type === 'ClassDeclaration' ? 'class' : 'function', name,
        ...boundaries(source, leading(node.start), next, detailed), ...(detailed ? { detailed: true } : {}) };
      if (declaration.type !== 'ClassDeclaration') symbols.push(item);
      if (declaration.type === 'ClassDeclaration') {
        const methods = declaration.body.body.filter(member => member.type === 'MethodDefinition').map((member, j, list) => {
          const methodName = nameOf(member.key) ?? '(computed)';
          const explicit = identifierBoundary(`${name}.${methodName}`).test(brief) || identifierBoundary(methodName).test(brief);
          const end = list[j + 1] ? leading(list[j + 1].start) : declaration.body.end - 1;
          return { name: methodName, kind: member.kind, ...(explicit ? { signature: signature(member.value, member) } : {}), ...boundaries(source, leading(member.start), end, explicit), ...(explicit ? { detailed: true } : {}) };
        });
        classes.push({ name, ...boundaries(source, leading(node.start), next, detailed), ...(detailed ? { detailed: true } : {}), methods });
      }
    }
    if (declaration.type === 'VariableDeclaration') for (const variable of declaration.declarations) {
      const init = variable.init;
      const name = variable.id?.name ?? '(anonymous)';
      const detailed = name !== '(anonymous)' && identifierBoundary(name).test(brief);
      symbols.push({ kind: init?.type === 'ClassExpression' ? 'class-expression' : ['FunctionExpression', 'ArrowFunctionExpression'].includes(init?.type) ? 'function-expression' : declaration.kind, name,
        ...(detailed ? { signature: init?.body ? signature(init, node) : source.slice(node.start, init?.start ?? variable.end).trimEnd() } : {}),
        ...boundaries(source, leading(node.start), next, detailed), ...(detailed ? { detailed: true } : {}) });
    }
    const testName = testCallName(node, aliases);
    if (testName !== null) {
      const detailed = i === body.findIndex(item => testCallName(item, aliases) !== null) || brief.includes(testName);
      const nextTest = body.slice(i + 1).find(item => testCallName(item, aliases) !== null);
      const end = nextTest ? leading(nextTest.start) : source.length;
      tests.push({ name: testName, ...boundaries(source, leading(node.start), end, detailed), ...(detailed ? { detailed: true } : {}) });
    }
  }
  const topNames = new Set(symbols.map(item => item.name));
  for (const { node, parent, name } of localDefinitions) {
    if (node.type === 'VariableDeclarator' && !['FunctionExpression', 'ArrowFunctionExpression'].includes(node.init?.type)) continue;
    if (topNames.has(name) || declarationNames.get(name) !== 1 || !identifierBoundary(name).test(brief)) continue;
    const callable = node.type === 'FunctionDeclaration' ? node : node.init;
    const outer = node.type === 'VariableDeclarator' && parent?.type === 'VariableDeclaration' ? parent : node;
    symbols.push({ name, kind: node.type === 'FunctionDeclaration' ? 'local-function' : 'local-variable', detailed: true,
      signature: callable?.body ? signature(callable, outer) : source.slice(outer.start, node.init?.start ?? node.end).trimEnd(),
      ...boundaries(source, leading(outer.start), outer.end, true) });
  }
  const firstTest = tests[0];
  const preambleEnd = firstTest?.start_offset ?? source.length;
  const preamble = boundaries(source, 0, preambleEnd, true);
  const symbol_inventory = symbols.filter(item => !item.detailed).map(({ kind, name }) => [kind, name]);
  const test_inventory = tests.filter(item => !item.detailed).map(item => item.name);
  const compactClasses = classes.map(item => ({ ...item,
    method_inventory: item.methods.filter(method => !method.detailed).map(({ kind, name }) => [kind, name]),
    methods: item.methods.filter(method => method.detailed),
  }));
  return { path, exists: true, kind: 'javascript', source_chars: source.length,
    source_bytes: Buffer.byteLength(source), preamble,
    imports: imports.map(item => ({ ...item, specifiers: item.specifiers.map(({ imported, local }) => [imported, local]) })),
    symbols: symbols.filter(item => item.detailed), symbol_inventory, classes: compactClasses,
    tests: tests.filter(item => item.detailed), test_inventory };
}

function textCatalog(path, source) {
  const headings = [];
  const pattern = /^#{1,6}\s+(.+?)\s*$/gm;
  for (const match of source.matchAll(pattern)) headings.push({ text: match[1], start: match.index,
    end: match.index + match[0].length });
  return { path, exists: true, kind: 'text', source_chars: source.length, source_bytes: Buffer.byteLength(source),
    preamble: boundaries(source, 0, headings[0]?.start ?? source.length, true),
    headings: headings.map((heading, i) => ({ text: heading.text,
      ...boundaries(source, heading.start, headings[i + 1]?.start ?? source.length, true) })) };
}

// Resolve only actual relative imports from named modules or explicit brief import
// statements. A single existing checkout path must match; no guessed absent target.
function importedSources(files, brief, selected, parse) {
  const result = new Map(selected.map(ref => [ref.path, ref]));
  const originalPaths = new Set(result.keys());
  const add = (path, names = null) => {
    if (typeof files[path] !== 'string' || originalPaths.has(path)) return;
    const previous = result.get(path);
    const binding_names = names && previous?.binding_names !== null
      ? unique([...(previous?.binding_names ?? []), ...names]) : null;
    result.set(path, { path, exists: true, binding_names });
  };
  const explicitBindings = new Map();
  for (const match of brief.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"`]([^'"`]+)['"`]/g)) {
    explicitBindings.set(match[2], match[1].split(',').map(item => item.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  }
  const directories = unique(selected.map(ref => dirname(ref.path))), import_refs = [];
  for (const match of brief.matchAll(/\bfrom\s+['"`]([^'"`]+)['"`]/g)) {
    if (!match[1].startsWith('.')) continue;
    const candidates = unique(directories.map(dir => normalizeRef(join(dir, match[1]))).filter(path => path && typeof files[path] === 'string'));
    if (candidates.length === 1) {
      add(candidates[0], explicitBindings.get(match[1]) ?? null);
      import_refs.push({ reference: match[1], path: candidates[0] });
    }
    else if (candidates.length > 1) throw new Error(`needs-discovery: ambiguous import source ${match[1]}`);
  }
  for (const ref of result.values()) {
    if (!ref.exists || !javascriptExtensions.test(ref.path) || typeof parse !== 'function') continue;
    let tree;
    try { tree = parse(files[ref.path], { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
    catch { continue; } // astCatalog supplies the source-specific parse failure.
    for (const node of tree.body) {
      if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('.')) continue;
      if (!node.specifiers.some(item => identifierBoundary(item.local.name).test(brief) ||
          (item.imported?.name && identifierBoundary(item.imported.name).test(brief)))) continue;
      const path = normalizeRef(join(dirname(ref.path), node.source.value));
      if (path) add(path, node.specifiers.filter(item => identifierBoundary(item.local.name).test(brief) ||
        (item.imported?.name && identifierBoundary(item.imported.name).test(brief))).map(item => item.imported?.name ?? item.local.name));
    }
  }
  return { selected: [...result.values()].sort((a, b) => a.path.localeCompare(b.path)),
    import_refs: [...new Map(import_refs.map(ref => [ref.reference, ref])).values()] };
}

export function buildQueryCatalog(files, brief, { parse, maxBytes = 48 * 1024 } = {}) {
  if (!files || typeof files !== 'object' || typeof brief !== 'string' || !brief.trim()) throw new Error('needs-discovery: source files and owner brief are required');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer');
  const resolved = resolvePaths(files, brief);
  const { selected, import_refs } = importedSources(files, brief, resolved.selected, parse);
  const unresolved_refs = resolved.unresolved_refs.filter(ref => !import_refs.some(binding => binding.reference === ref.reference));
  const catalogFiles = selected.map(ref => {
    if (!ref.exists) return { path: ref.path, exists: false, kind: 'absent' };
    const source = files[ref.path];
    return javascriptExtensions.test(ref.path)
      ? (typeof parse === 'function' ? astCatalog(ref.path, source, ref.binding_names ? ref.binding_names.join(' ') : brief, parse) : (() => { throw new Error(`needs-discovery: parser unavailable for ${ref.path}`); })())
      : textCatalog(ref.path, source);
  });
  const catalog = { schema_version: 1, brief_refs: selected.map(({ path, exists }) => ({ path, exists })), import_refs, unresolved_refs, files: catalogFiles };
  const bytes = Buffer.byteLength(JSON.stringify(catalog));
  if (bytes > maxBytes) throw new Error(`needs-discovery: source catalog is ${bytes} bytes; limit is ${maxBytes}`);
  return catalog;
}
