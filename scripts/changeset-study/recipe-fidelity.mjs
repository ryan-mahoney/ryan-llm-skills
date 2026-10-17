// Literal code the planner quotes for insertion must appear in the written file. Two
// forms recur in settled recipes and have each cost deliveries when a cheap writer
// paraphrased them: a backticked statement introduced as exact/insert/register text,
// and a shorthand object `{ a, b, c }` whose members name module-scope bindings that
// the writer rebound to imported functions. Quoted anchors ("from `x` to `y`"),
// removal targets and short locators are not expectations. A miss is a local failure
// with the missing literal, so the writer's existing retry carries the diagnostic.
const collapse = text => text.replace(/\s+/g, ' ').trim();
const identifier = /^[A-Za-z_$][\w$]*$/;

export function recipeLiterals(operation, files = {}) {
  const text = `${operation.instruction}\n${(operation.requirements ?? []).join('\n')}`;
  const source = Object.values(files).filter(value => typeof value === 'string').join('\n');
  const literals = [];
  for (const match of text.matchAll(/`([^`\n]{24,})`/g)) {
    const before = text.slice(Math.max(0, match.index - 60), match.index).toLowerCase(), snippet = match[1];
    if (!/[(){}=;]/.test(snippet)) continue;
    if (/\b(remove|delete|replace only|replace the|replace range|range|from|through|anchor|before|after|at)\b[^`]*$/.test(before) && !/\b(with|exactly|verbatim|insert|add|append|register|emit)\b[^`]*$/.test(before)) continue;
    if (/\b(with|exactly|verbatim|insert|add|append|register|emit|is|returning|return)\b[^`]*$/.test(before)) literals.push({ kind: 'snippet', text: collapse(snippet) });
  }
  // A brace list is a binding shorthand only when the recipe presents it as an object
  // to pass or inject and its names already exist in the declared source. A result
  // shape such as "Build detail {step, decisions, unresolved}" is implemented with
  // explicit values and is not an expectation.
  for (const match of text.matchAll(/\{\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*){2,})\s*,?\s*\}/g)) {
    const names = match[1].split(',').map(name => name.trim()).filter(Boolean);
    const before = text.slice(Math.max(0, match.index - 50), match.index).toLowerCase();
    if (!names.every(name => identifier.test(name)) || !/\b(object|helpers?|inject(?:ed)?|pass(?:ed|ing)?|exact|verbatim|argument)\b[^{]*$/.test(before)) continue;
    const known = names.filter(name => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(source));
    if (known.length >= Math.ceil(names.length / 2)) literals.push({ kind: 'shorthand', names });
  }
  return literals;
}

// A quoted snippet may carry template placeholders such as `${stop_reason ?? 'error'}`
// that name a field, not a binding the writer can reproduce verbatim; any expression
// inside `${...}` satisfies the placeholder while the literal text around it must match.
const snippetPattern = snippet => new RegExp(snippet.split(/(\$\{[^}]*\})/).map((part, index) => index % 2 ? '\\$\\{[^}]*\\}' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''));

export function recipeFidelity(operation, output, files = {}) {
  const text = collapse(String(output ?? '')), missing = [];
  for (const literal of recipeLiterals(operation, files)) {
    if (literal.kind === 'snippet') { if (!text.includes(literal.text) && !snippetPattern(literal.text).test(text)) missing.push(`snippet "${literal.text.slice(0, 120)}"`); continue; }
    // Each member must be present as shorthand (`name,` or `name }`), not `name: other`.
    const rebound = literal.names.filter(name => !new RegExp(`(?:^|[{,]\\s*)${name.replace(/\$/g, '\\$')}\\s*[,}]`).test(text));
    if (rebound.length && rebound.length < literal.names.length) missing.push(`shorthand members ${rebound.slice(0, 6).join(', ')} of { ${literal.names.join(', ')} }`);
    else if (rebound.length === literal.names.length && literal.names.some(name => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*:`).test(text))) missing.push(`shorthand object { ${literal.names.join(', ')} } written with explicit bindings`);
  }
  return missing;
}
