const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parse the candidate's own test declarations, never hidden acceptance code.
// Unresolved names or helper-only edits fall back to the complete changed file.
export function changedTestCommands(before, after, parse) {
  function declarations(source) {
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    const aliases = new Set();
    for (const node of tree.body) if (node.type === 'ImportDeclaration' && ['node:test', 'test'].includes(node.source.value)) {
      for (const spec of node.specifiers) if (spec.type === 'ImportDefaultSpecifier' || ['test', 'it', 'describe', 'suite'].includes(spec.imported?.name)) aliases.add(spec.local.name);
    }
    const calls = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const matched = callee?.type === 'Identifier' && aliases.has(callee.name) ||
          callee?.type === 'MemberExpression' && !callee.computed && callee.object?.type === 'Identifier' &&
          aliases.has(callee.object.name) && ['skip', 'only', 'todo'].includes(callee.property?.name);
        if (matched) {
          const arg = node.arguments[0];
          const name = arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value :
            arg?.type === 'TemplateLiteral' && arg.expressions.length === 0 ? arg.quasis[0].value.cooked : null;
          calls.push({ name, source: source.slice(node.start, node.end) });
          return; // Selecting a parent includes its dynamic/nested subtests.
        }
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    }
    visit(tree); return calls;
  }
  return Object.keys(after).filter(path => /\.(?:test|spec)\.[cm]?js$/.test(path) && before[path] !== after[path]).sort().map(path => {
    let names = null;
    try {
      const old = declarations(before[path] ?? ''), current = declarations(after[path]);
      const changed = current.filter(call => !old.some(previous => previous.name === call.name && previous.source === call.source));
      if (changed.length && changed.every(call => call.name !== null)) names = [...new Set(changed.map(call => call.name))];
    } catch {} // Parse/selection uncertainty means more checking, never skipped checking.
    return { path, names, command: `node --test${names ? ` --test-name-pattern=${quote(names.map(escapeRegex).join('|'))}` : ''} ${quote(path)}` };
  });
}
