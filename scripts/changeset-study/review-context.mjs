// Supply unchanged local helper definitions called by changed syntactic units.
// A diff alone can hide contracts such as output trimming or default coercion.
export function reviewContext(before, after, parse, limit = 24000) {
  const helpers = [], omitted = [], unavailable = [];
  let used = 0;
  const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, visit));
      else if (value && typeof value === 'object') walk(value, visit);
    }
  };
  function units(source) {
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    const rows = [], definitions = new Map();
    for (const top of tree.body) {
      const node = top.declaration ?? top;
      if (node.type === 'FunctionDeclaration') {
        const row = { key: node.id.name, node, text: source.slice(node.start, node.end) };
        rows.push(row); definitions.set(row.key, row);
      } else if (node.type === 'VariableDeclaration') {
        for (const declaration of node.declarations) if (declaration.id.type === 'Identifier') {
          const row = { key: declaration.id.name, node: declaration, text: source.slice(node.start, node.end) };
          rows.push(row); definitions.set(row.key, row);
        }
      } else if (node.type === 'ClassDeclaration') {
        for (const method of node.body.body) rows.push({ key: `${node.id?.name}.${method.key?.name ?? method.key?.value}`,
          node: method, text: source.slice(method.start, method.end) });
      }
    }
    return { rows, definitions };
  }
  for (const path of Object.keys(after).sort()) {
    if (!/\.[cm]?js$/.test(path) || before[path] === after[path]) continue;
    try {
      const old = units(before[path] ?? ''), current = units(after[path]);
      const oldByKey = new Map(old.rows.map(row => [row.key, row.text]));
      const wanted = new Set();
      for (const row of current.rows) if (oldByKey.get(row.key) !== row.text) walk(row.node, node => {
        if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee?.type === 'Identifier') wanted.add(node.callee.name);
      });
      for (const name of [...wanted].sort()) {
        const row = current.definitions.get(name);
        if (!row || oldByKey.get(name) !== row.text) continue; // Changed definitions already appear in the diff.
        if (used + row.text.length > limit) { omitted.push({ path, name }); continue; }
        helpers.push({ path, name, source: row.text }); used += row.text.length;
      }
    } catch { unavailable.push(path); }
  }
  return { scope: 'Unchanged same-file helpers directly called by changed functions, methods or declarations; not a complete call graph.', helpers, omitted, unavailable };
}
