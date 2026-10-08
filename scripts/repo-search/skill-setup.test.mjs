import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const skillScript = resolve('skills/repo-search-setup/scripts/setup.mjs');
const modelId = 'jinaai/jina-embeddings-v2-base-code';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
}

test('setup copies verified assets outside Git, builds once, and opts in when requested', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'repo-search-skill-'));
  try {
    const checkout = join(fixture, 'checkout');
    const helper = join(fixture, 'helper');
    const source = join(checkout, 'source-models');
    const destination = join(fixture, 'external-models');
    const state = join(fixture, 'external-state');
    await mkdir(join(source, modelId, 'onnx'), { recursive: true });
    await mkdir(join(helper, 'core'), { recursive: true });
    assert.equal(run('git', ['init', '-q', checkout]).status, 0);
    const assets = [
      { path: 'config.json', bytes: 'fixture config\n' },
      { path: 'onnx/model_quantized.onnx', bytes: 'fixture weights\n' },
    ];
    for (const asset of assets) {
      await writeFile(join(source, modelId, asset.path), asset.bytes);
    }
    await writeFile(join(checkout, 'src.ts'), 'export const value = 1;\n');
    await writeFile(join(helper, 'identity.mjs'), `export async function resolveCheckout(root) { return { root }; }\n`);
    const specs = assets.map((asset) => ({
      path: asset.path,
      sha256: createHash('sha256').update(asset.bytes).digest('hex'),
    }));
    await writeFile(join(helper, 'core', 'codeModelAssets.ts'), `
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export const PINNED_CODE_MODEL_ASSETS = ${JSON.stringify(specs)};
export async function verifyModel(root) {
  for (const asset of PINNED_CODE_MODEL_ASSETS) {
    const bytes = await readFile(join(root, '${modelId}', asset.path));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('digest mismatch');
  }
  return { modelsRoot: root };
}
`);
    await writeFile(join(helper, 'cli.mjs'), `
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [command, ...args] = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const state = value('--state');
mkdirSync(state, { recursive: true });
const log = join(state, 'calls.json');
const calls = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : [];
calls.push(command);
writeFileSync(log, JSON.stringify(calls));
const receipt = command === 'status' ? {
  enrolled: calls.includes('build'), availability: calls.includes('build') ? 'ready' : 'missing',
  currentGenerationId: calls.includes('build') ? 'fixture-generation' : null,
  specUse: calls.includes('configure')
} : {};
process.stdout.write(JSON.stringify({ status: 'ok', receipt }) + '\\n');
`);

    const args = [skillScript, '--root', checkout, '--models-from', source,
      '--models-to', destination, '--state', state, '--spec-use', 'on'];
    const env = { ...process.env, REPO_SEARCH_HELPER: helper };
    const first = run('bun', ['--no-install', ...args], { env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).specUse, true);
    for (const asset of assets) {
      assert.equal(await readFile(join(destination, modelId, asset.path), 'utf8'), asset.bytes);
    }
    assert.equal(existsSync(join(checkout, '.local')), false);
    assert.deepEqual(JSON.parse(await readFile(join(state, 'calls.json'), 'utf8')),
      ['install', 'status', 'build', 'configure', 'status']);

    const second = run('bun', ['--no-install', ...args], { env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse((await readFile(join(state, 'calls.json'), 'utf8'))).filter((name) => name === 'build').length, 1);

    const inside = join(checkout, 'bad-model-destination');
    const rejected = run('bun', ['--no-install', skillScript, '--root', checkout,
      '--models-from', source, '--models-to', inside, '--state', state], { env });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /outside Git repositories/);
    assert.equal(existsSync(inside), false);
    const insideGitDir = join(checkout, '.git', 'bad-model-destination');
    const rejectedGitDir = run('bun', ['--no-install', skillScript, '--root', checkout,
      '--models-from', source, '--models-to', insideGitDir, '--state', state], { env });
    assert.equal(rejectedGitDir.status, 1);
    assert.match(rejectedGitDir.stderr, /outside Git repositories/);
    assert.equal(existsSync(insideGitDir), false);
    const insideState = join(checkout, 'bad-index-state');
    const rejectedState = run('bun', ['--no-install', skillScript, '--root', checkout,
      '--models-from', source, '--models-to', destination, '--state', insideState], { env });
    assert.equal(rejectedState.status, 1);
    assert.match(rejectedState.stderr, /Index state must be outside Git repositories/);
    assert.equal(existsSync(insideState), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
