// EV-13 wave-native harness (D-10 packet 5b): the detached coordinator driver.
//
// The test process calls `startCoordinator` to spawn a detached Node child.
// That child imports the installed Pi SDK, loads the real spec-runtime index.ts
// and runs one coordinator session against the test's loopback provider. The
// two processes only exchange newline-delimited JSON on stdout, so the real
// runtime policy, SDK composition and extension tools are exercised by a real
// process rather than a stubbed helper.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROVIDER = 'wave-loopback';
const MODEL = 'scripted';
const READY_TIMEOUT_MS = 30000;
const SHUTDOWN_TIMEOUT_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Installed SDK root, mirroring the managed-launcher resolution in the test:
// SPEC_PI_SDK wins; otherwise a normal package layout three directories above
// the launcher, falling back to the managed release named by current-version.
function resolveSdkRoot(env) {
  const fromEnv = env?.SPEC_PI_SDK;
  if (fromEnv && existsSync(join(fromEnv, 'dist', 'index.js'))) return fromEnv;
  const bin = execFileSync('which', ['pi'], { encoding: 'utf8', env }).trim();
  const realBin = realpathSync(bin);
  const normal = dirname(dirname(dirname(realBin)));
  if (existsSync(join(normal, 'dist', 'index.js'))) return normal;
  const agentRoot = dirname(dirname(realBin));
  const version = readFileSync(join(agentRoot, 'install', 'current-version'), 'utf8').trim();
  if (!/^(?!\.\.?$)[^/\\]+$/.test(version)) throw new Error(`wave-native-driver: invalid current-version ${JSON.stringify(version)}`);
  return join(agentRoot, 'install', 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
}

// Start the detached coordinator child and return the synchronous control
// surface the test owns. `ready` fails with a bounded 30s wait and the child's
// own stdout/stderr, so a driver that dies during startup is never reported as
// ready.
export function startCoordinator({ sandbox, env, script, tag } = {}) {
  if (!sandbox?.dir) throw new Error('startCoordinator requires a wave fixture sandbox');
  if (!sandbox.processRegistry?.register) throw new Error('startCoordinator requires sandbox.processRegistry.register');
  if (!tag) throw new Error('startCoordinator requires a tag');
  const sdkRoot = resolveSdkRoot(env);
  const config = {
    mode: 'coordinator',
    tag,
    dir: sandbox.dir,
    integrationCheckout: sandbox.integrationCheckout,
    packagePath: sandbox.packagePath,
    indexPath: join(here, 'index.ts'),
    sdkRoot,
    script,
  };
  const configPath = join(sandbox.dir, `coordinator-${tag}-config.json`);
  writeFileSync(configPath, JSON.stringify(config));

  // The coordinator carries the sandbox environment but no managed-child
  // identity: the owner's SPEC_RUNTIME/PI_INTERCOM markers must never leak in.
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (/^SPEC_RUNTIME_|^PI_INTERCOM_/.test(key)) delete childEnv[key];
  }
  childEnv.SPEC_PI_SDK = sdkRoot;

  const child = spawn(process.execPath, [join(here, 'wave-native-driver.mjs'), 'coordinator', configPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: sandbox.dir,
    env: childEnv,
  });
  // Register immediately so even a crash during startup is a process the fixture
  // owns and must positively drain before another driver starts.
  sandbox.processRegistry.register(child);

  const events = [];
  let stdout = '';
  let stderr = '';
  let stdoutBuffer = '';
  let readySettled = false;
  let exited = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exitedPromise = new Promise(resolve => {
    child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  const readyTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error(`wave coordinator ${tag} did not become ready within ${READY_TIMEOUT_MS}ms; stderr=${stderr.trim()}; stdout=${stdout.trim()}`));
  }, READY_TIMEOUT_MS);
  const failReady = message => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    rejectReady(new Error(`wave coordinator ${tag}: ${message}`));
  };

  const persist = readyFlag => {
    writeFileSync(join(sandbox.dir, `coordinator-${tag}.json`), JSON.stringify({ pid: child.pid, ready: readyFlag }));
    writeFileSync(join(sandbox.dir, 'coordinator.pid'), String(child.pid));
  };
  persist(false);

  child.stdout.on('data', chunk => {
    stdout += chunk;
    stdoutBuffer += chunk;
    let index;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.kind === 'event' && message.event) events.push(message.event);
      else if (message?.kind === 'ready') {
        if (!readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          persist(true);
          resolveReady({ pid: child.pid });
        }
      } else if (message?.kind === 'error') {
        failReady(`driver error: ${message.message ?? 'unknown error'}`);
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => failReady(`spawn error: ${error.message}`));
  child.once('close', (code, signal) => {
    if (!readySettled) failReady(`exited before ready (code=${code}, signal=${signal}); stderr=${stderr.trim()}`);
  });

  // SIGKILL the real child and positively confirm it left the process group.
  async function kill() {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await exitedPromise;
    await sandbox.processRegistry.drainGroup(child.pid);
  }

  // SIGTERM first so the child runs the real session_shutdown lifecycle, then
  // SIGKILL after 10s and drain the owned group before returning.
  async function shutdown() {
    if (!exited) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const graceful = await Promise.race([exitedPromise.then(() => true), sleep(SHUTDOWN_TIMEOUT_MS).then(() => false)]);
      if (!graceful) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await exitedPromise;
      }
    }
    await sandbox.processRegistry.drainGroup(child.pid);
  }

  return {
    pid: child.pid,
    ready,
    events,
    exited: exitedPromise,
    shutdown,
    kill,
    drainGroup: () => sandbox.processRegistry.drainGroup(child.pid),
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function out(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitEvent(event) {
  out({ kind: 'event', event });
  // Bounded diagnostic: surface the first unproven coordinator tool-result
  // boundary on stderr as concise JSON (full result for bounded tools).
  if (event && event.type === 'tool_execution_end') {
    let diagnostic;
    try {
      diagnostic = JSON.stringify({
        kind: 'tool_execution_end',
        toolName: event.toolName ?? event.name ?? null,
        isError: event.isError ?? event.error != null ?? null,
        result: event.result,
        error: event.error ?? null,
        content: event.content ?? null,
      });
    } catch (stringifyError) {
      diagnostic = JSON.stringify({
        kind: 'tool_execution_end',
        toolName: event.toolName ?? event.name ?? null,
        stringifyError: String(stringifyError?.message ?? stringifyError),
      });
    }
    process.stderr.write(`${diagnostic}\n`);
  }
}

// The child entry point: import the installed SDK, load the real index.ts and
// drive one coordinator session until SIGTERM.
async function runCoordinator(config) {
  const sdkRoot = process.env.SPEC_PI_SDK || config.sdkRoot;
  const sdk = await import(pathToFileURL(join(sdkRoot, 'dist', 'index.js')).href);
  const { DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession, ModelRuntime } = sdk;

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const provider = {
    api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${config.script.port}/v1/coordinator/-/${process.pid}`,
    apiKey: 'local-fixture',
    models: [{ id: MODEL, name: 'Wave loopback scripted', reasoning: false, input: ['text'], contextWindow: 1048576, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
  // Register the loopback both on the runtime (so getModel resolves it) and via
  // an extension factory (the same path real Pi uses for provider extensions).
  modelRuntime.registerProvider(PROVIDER, provider);

  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: config.integrationCheckout,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Wave coordinator driver fixture.',
    // The real index.ts must load: never set noExtensions here.
    additionalExtensionPaths: [config.indexPath],
    extensionFactories: [pi => pi.registerProvider(PROVIDER, provider)],
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors ?? [];
  if (loadErrors.length) throw new Error(`wave-native-driver: extension load errors: ${JSON.stringify(loadErrors)}`);

  const sessionDir = join(config.dir, `coordinator-${config.tag}-session`);
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.inMemory(sessionDir);
  const { session } = await createAgentSession({
    cwd: config.integrationCheckout,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
    tools: ['spec_dispatch', 'spec_sentinel_checkpoint', 'spec_workflow'],
  });

  await session.bindExtensions({
    mode: 'rpc',
    onError: error => out({ kind: 'error', message: `extension error: ${error?.message ?? String(error)}` }),
  });
  await session.setModel(modelRuntime.getModel(PROVIDER, MODEL));
  session.subscribe(event => emitEvent(event));
  const expectedToolNames = ['spec_dispatch', 'spec_sentinel_checkpoint', 'spec_workflow'];
  session.setActiveToolsByName(expectedToolNames);
  const actualToolNames = session.getActiveToolNames();
  const sortNames = names => [...names].sort();
  const expectedSorted = sortNames(expectedToolNames);
  const actualSorted = sortNames(actualToolNames);
  if (
    expectedSorted.length !== actualSorted.length ||
    expectedSorted.some((name, index) => name !== actualSorted[index])
  ) {
    throw new Error(
      `wave-native-driver: active tool mismatch: expected ${JSON.stringify(expectedSorted)}, actual ${JSON.stringify(actualSorted)}`,
    );
  }

  out({ kind: 'ready', pid: process.pid });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      // Real extension lifecycle: native disposal alone does not emit shutdown.
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } catch (error) {
      out({ kind: 'error', message: `session_shutdown failed: ${error?.message ?? String(error)}` });
    } finally {
      session.dispose();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });

  try {
    await session.prompt('Start the fixture coordinator workflow now.');
  } catch (error) {
    out({ kind: 'error', message: `coordinator prompt failed: ${error?.message ?? String(error)}` });
    process.stderr.write(`${JSON.stringify({ kind: 'coordinator_prompt_error', message: error?.message ?? String(error), stack: error?.stack ?? null })}\n`);
  }
  // Stay alive to receive extension attention turns until SIGTERM.
  setInterval(() => {}, 1 << 30);
}

async function main() {
  const [mode, configPath] = process.argv.slice(2);
  if (mode !== 'coordinator') throw new Error(`wave-native-driver: unknown mode ${JSON.stringify(mode)}`);
  if (!configPath) throw new Error('wave-native-driver: missing config path');
  await runCoordinator(JSON.parse(readFileSync(configPath, 'utf8')));
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`wave-native-driver: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
