import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';

const sdkRoot = process.env.SPEC_PI_SDK, subagents = process.env.SPEC_PI_SUBAGENTS;
const skip = sdkRoot && subagents ? false : 'Set SPEC_PI_SDK and SPEC_PI_SUBAGENTS for native background-child checks';
const profiles = ['spec-step-fixer', 'spec-stage-reviewer', 'spec-final-reviewer', 'spec-final-editor', 'spec-sentinel-diagnostician'];

// Run alone: node --test pi/extensions/context-budget/background.test.mjs
// Exercise the installed runner's launch builder and real child-session factory,
// not a hand-built resource loader. No paid provider or real repository work.
test('background profiles load the policy with and without ambient extension discovery', { skip, timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'context-background-'));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  const { resolveHostPeerAliases } = await import(pathToFileURL(join(subagents, 'src/runs/background/runner-aliases.js')));
  const { aliases, missing } = resolveHostPeerAliases(sdkRoot);
  assert.deepEqual(missing, []);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return aliases[specifier] ? { url: pathToFileURL(aliases[specifier]).href, shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')));
  const { discoverAgents } = await import(pathToFileURL(join(subagents, 'src/agents/agents.js')));
  const { buildRunnerChildLaunch } = await import(pathToFileURL(join(subagents, 'src/runs/background/runner-child-launch.js')));
  const { createDefaultChildSessionFactory } = await import(pathToFileURL(join(subagents, 'src/runs/shared/child-session.js')));
  mkdirSync(join(dir, '.pi/agents'), { recursive: true });
  const profileDir = join(dirname(fileURLToPath(import.meta.url)), '../../agents');
  for (const name of profiles) copyFileSync(join(profileDir, `${name}.md`), join(dir, '.pi/agents', `${name}.md`));
  const discovered = discoverAgents(dir, 'project');
  const requests = [];
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'large', choices: [{ index: 0, delta: { content: 'Fixture completed; no source changes.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const provider = { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture',
    models: [{ id: 'large', name: 'Fixture', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
  t.after(() => factory.dispose());
  for (const name of profiles) {
    const agent = discovered.agents.find(a => a.name === name);
    assert.ok(agent, `discovered ${name}`);
    assert.equal(agent.filePath, join(dir, '.pi/agents', `${name}.md`), 'use the checked-out profile, not a user override');
    const launch = buildRunnerChildLaunch({ ...agent, agent: name, cwd: dir }, { cwd: dir, id: `fixture-${name}`, flatIndex: 0 },
      { model: 'budget-fixture/large', sessionEnabled: true, sessionDir: join(dir, 'sessions') }).session;
    assert.equal(launch.ambientExtensions, true, 'additive profile does not disable provider discovery');
    assert.ok(launch.extensionPaths.some(p => p.endsWith('/context-budget/index.ts')));
    if (name === 'spec-final-editor') assert.ok(launch.extensionPaths.some(p => p.includes('pi-openai-codex-compat')), 'existing provider adapter retained');
    if (!['spec-step-fixer', 'spec-stage-reviewer'].includes(name)) continue;
    // Test both runner-host discovery and the no-ambient host condition. Use only
    // fixture providers; do not load the operator's external provider extensions.
    for (const ambientExtensions of [true, false]) {
      const child = await factory.create({ ...launch, ambientExtensions, noContextFiles: true,
        hooks: [...launch.hooks, { name: 'fixture-provider', factory: pi => pi.registerProvider('budget-fixture', provider) }] });
      try {
        assert.equal(child.contextWindow, 88000);
        await child.prompt('Return the fixture completion without tools.');
        const entries = readFileSync(child.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(entries.filter(e => e.customType === 'context-budget' && e.data.event === 'request').length, 1);
        const usage = entries.find(e => e.customType === 'context-budget' && e.data.event === 'usage');
        assert.equal(usage.data.provider, 'budget-fixture');
        assert.equal(usage.data.model, 'large');
      } finally { await child.dispose(); }
    }
  }
  assert.equal(requests.length, 4);
});
