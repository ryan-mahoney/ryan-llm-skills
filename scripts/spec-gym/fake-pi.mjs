import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const logPath = process.env.SPEC_GYM_FAKE_PI_LOG;
if (logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd(), envNames: Object.keys(process.env).sort() }));
}

const script = process.env.SPEC_GYM_FAKE_PI_SCRIPT || 'success';
const timestamp = new Date().toISOString();

if (script === 'hang') {
  process.stdout.write(`${JSON.stringify({ type: 'message_start', role: 'assistant', timestamp })}\n`);
  setInterval(() => {}, 1000);
} else if (script === 'exit-2') {
  process.exit(2);
} else {
  const sessionIndex = argv.indexOf('--session');
  const sessionPath = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
  const costTotal = script === 'success' ? 0.25 : 0;
  const stopReason = script === 'error' ? 'error' : 'stop';
  const errorMessage = script === 'error' ? 'unknown model leaf-model' : undefined;
  const text = script === 'error' ? errorMessage : 'Completed the leaf task.';
  const message = {
    role: 'assistant',
    provider: 'test',
    model: 'leaf-model',
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    content: [{ type: 'text', text }],
    usage: { input: 100, output: 20, cacheRead: 0, cost: { total: costTotal } },
    timestamp,
  };
  if (sessionPath) {
    mkdirSync(dirname(sessionPath), { recursive: true });
    const rows = [
      { type: 'session', id: randomUUID(), timestamp, cwd: process.cwd() },
      { type: 'message', id: randomUUID(), timestamp, message },
    ];
    writeFileSync(sessionPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: 'message_end', message })}\n`);
}
