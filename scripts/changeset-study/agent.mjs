import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { sdkImport } from './client.mjs';
import { confinedPath, sandbox } from './sandbox.mjs';

export async function nativeAgent({ root, client, transcript, signal, readOnly = false, extraPrompt = '', stage = 'agent' }) {
  const [{ Agent }, { createCodingTools }, { buildSystemPrompt }] = await Promise.all([
    sdkImport('pi-agent-core/dist/agent.js'), sdkImport('pi-coding-agent/dist/core/tools/index.js'),
    sdkImport('pi-coding-agent/dist/core/system-prompt.js'),
  ]);
  const path = virtual => confinedPath(root, virtual);
  const readOps = { readFile: virtual => readFile(path(virtual)), access: virtual => access(path(virtual)), detectImageMimeType: async () => null };
  const writeOps = { writeFile: (virtual, text) => writeFile(path(virtual), text), mkdir: virtual => mkdir(path(virtual), { recursive: true }) };
  const tools = createCodingTools('/work', {
    read: { operations: readOps }, edit: { operations: { ...readOps, ...writeOps } }, write: { operations: writeOps },
    bash: { exposeSessionEnvironment: false, operations: { exec: async (command, _cwd, options) => sandbox(root, command, {
      readOnly, signal: options.signal, timeoutMs: Math.min((options.timeout ?? 30) * 1000, 30000), onData: options.onData,
    }) } },
  }).filter(tool => !readOnly || ['read', 'bash'].includes(tool.name));
  const prompt = buildSystemPrompt({ cwd: '/work', selectedTools: tools.map(t => t.name),
    appendSystemPrompt: 'This is a dependency-free isolated repository. Network access is unavailable. Files are under /work. Use the provided visible tests and preserve them. You may batch file changes and commands.\n' + extraPrompt,
    contextFiles: [], skills: [] });
  const agent = new Agent({ initialState: { systemPrompt: prompt, model: client.model,
    thinkingLevel: client.reasoning ?? 'off', tools, messages: [] }, streamFn: client.stream(stage) });
  const counts = {};
  agent.subscribe(event => {
    if (event.type === 'tool_execution_start') counts[event.toolName] = (counts[event.toolName] ?? 0) + 1;
    if (['message_end', 'tool_execution_end', 'tool_execution_start'].includes(event.type)) appendFileSync(transcript, JSON.stringify(event) + '\n');
  });
  const abort = () => agent.abort(); signal?.addEventListener('abort', abort, { once: true });
  return {
    counts,
    async prompt(text) {
      if (signal?.aborted) throw new Error('Cell deadline exceeded');
      await agent.prompt(text);
      const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
      if (!last || last.stopReason !== 'stop') throw new Error(`Agent stopped: ${last?.stopReason ?? agent.state.errorMessage ?? 'no response'} ${last?.errorMessage ?? ''}`);
      return last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    },
    dispose() { signal?.removeEventListener('abort', abort); },
  };
}
