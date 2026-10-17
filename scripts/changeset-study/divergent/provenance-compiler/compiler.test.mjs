import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProvenancePlan } from './compiler.mjs';
import { hash } from '../../../changeset/workspace.mjs';

const brief = `Owner's settled implementation brief\n\n\`\`\`js\nexport function answer() { return 42; }\n\`\`\`\n`;
const literal = 'export function answer() { return 42; }';
const source = '// generated from the brief\n';

function recipeFor(target = 'generated.mjs') {
  const start = brief.indexOf(literal);
  return {
    version: 1,
    action: 'assemble',
    target,
    brief_sha256: hash(brief),
    sources: [{ path: 'source.mjs', sha256: hash(source) }],
    parts: [
      { kind: 'source', path: 'source.mjs', start: 0, end: source.length },
      { kind: 'brief', start, end: start + literal.length },
    ],
    deleted_ranges: [],
  };
}

function plan(recipe = recipeFor()) {
  return {
    schema_version: 1,
    operations: [{
      id: 'make-output', executor: 'involved', instruction: 'Write the requested output.',
      reads: ['source.mjs'], writes: ['generated.mjs'], depends_on: [],
      mechanical_recipe: recipe,
    }],
  };
}

test('hybrid activates an exact-source and fenced-brief recipe without changing graph identity', () => {
  const result = compileProvenancePlan(plan(), { mode: 'hybrid', files: { 'source.mjs': source, 'generated.mjs': null }, brief });
  assert.deepEqual(result.decisions, [{ id: 'make-output', status: 'activated', reason: 'hash-bound-verbatim-recipe' }]);
  assert.equal(result.files['generated.mjs'], source + literal);
  assert.equal(result.plan.operations[0].executor, 'deterministic');
  assert.equal(result.plan.operations[0].id, 'make-output');
  assert.deepEqual(result.plan.operations[0].depends_on, []);
  assert.equal('mechanical_recipe' in result.plan.operations[0], false);
});

test('forced delegation ignores recipes and stale source provenance fails closed without changing files', () => {
  const original = { 'source.mjs': source, 'generated.mjs': null };
  const delegated = compileProvenancePlan(plan(), { mode: 'forced-delegation', files: original, brief });
  assert.deepEqual(delegated.files, original);
  assert.equal(delegated.plan.operations[0].executor, 'involved');
  assert.deepEqual(delegated.decisions, [{ id: 'make-output', status: 'ignored', reason: 'forced-delegation-default' }]);

  const stale = compileProvenancePlan(plan(), { mode: 'hybrid', files: { ...original, 'source.mjs': `${source}// changed\n` }, brief });
  assert.equal(stale.files['generated.mjs'], null);
  assert.equal(stale.plan.operations[0].executor, 'involved');
  assert.match(stale.decisions[0].reason, /^source-hash-mismatch:/);

  const prebuiltDeterministic = plan();
  prebuiltDeterministic.operations[0].executor = 'deterministic';
  prebuiltDeterministic.operations[0].edits = [{ kind: 'create', path: 'generated.mjs', text: 'untrusted' }];
  assert.throws(() => compileProvenancePlan(prebuiltDeterministic, { mode: 'hybrid', files: original, brief }), /Expected model-writer assignment/);

  const injectedEdits = plan();
  injectedEdits.operations[0].edits = [{ kind: 'create', path: 'generated.mjs', text: 'untrusted' }];
  assert.throws(() => compileProvenancePlan(injectedEdits, { mode: 'forced-delegation', files: original, brief }), /Input edits are not accepted/);

  const deceptiveBrief = `Settled brief\n\n\`\`\`js\nconst inside = true;\n\`\`\`not-a-closing-fence\n\`\`\`\nprose outside the code block\n`;
  const prose = 'prose outside the code block';
  const deceptiveRecipe = recipeFor();
  const proseStart = deceptiveBrief.indexOf(prose);
  deceptiveRecipe.brief_sha256 = hash(deceptiveBrief);
  deceptiveRecipe.parts[1] = { kind: 'brief', start: proseStart, end: proseStart + prose.length };
  const deceptive = compileProvenancePlan(plan(deceptiveRecipe), { mode: 'hybrid', files: original, brief: deceptiveBrief });
  assert.equal(deceptive.plan.operations[0].executor, 'involved');
  assert.equal(deceptive.decisions[0].reason, 'brief-part-not-verbatim-code');

  const invalidBacktickOpener = `Settled brief\n\n\`\`\`js\`broken\nconst inside = true;\n\`\`\`\nprose after malformed fence\n`;
  const insideCode = 'const inside = true;';
  const malformedRecipe = recipeFor();
  const codeStart = invalidBacktickOpener.indexOf(insideCode);
  malformedRecipe.brief_sha256 = hash(invalidBacktickOpener);
  malformedRecipe.parts[1] = { kind: 'brief', start: codeStart, end: codeStart + insideCode.length };
  const malformed = compileProvenancePlan(plan(malformedRecipe), { mode: 'hybrid', files: original, brief: invalidBacktickOpener });
  assert.equal(malformed.plan.operations[0].executor, 'involved');
  assert.equal(malformed.decisions[0].reason, 'brief-part-not-verbatim-code');

  const crlfBrief = `Settled brief\r\n\r\n\`\`\`js\r\n${literal}\r\n\`\`\`\r\n`;
  const crlfRecipe = recipeFor();
  const crlfStart = crlfBrief.indexOf(literal);
  crlfRecipe.brief_sha256 = hash(crlfBrief);
  crlfRecipe.parts[1] = { kind: 'brief', start: crlfStart, end: crlfStart + literal.length };
  const crlf = compileProvenancePlan(plan(crlfRecipe), { mode: 'hybrid', files: original, brief: crlfBrief });
  assert.equal(crlf.decisions[0].status, 'activated');
  assert.equal(crlf.files['generated.mjs'], source + literal);
});

test('existing target bytes must be copied or explicitly deleted before replacement', () => {
  const target = 'const old = true;\n';
  const recipe = recipeFor('generated.mjs');
  recipe.sources.push({ path: 'generated.mjs', sha256: hash(target) });
  const result = compileProvenancePlan(plan(recipe), { mode: 'hybrid', files: { 'source.mjs': source, 'generated.mjs': target }, brief });
  assert.equal(result.files['generated.mjs'], target);
  assert.equal(result.plan.operations[0].executor, 'involved');
  assert.equal(result.decisions[0].reason, 'unaccounted-target-bytes');
});
