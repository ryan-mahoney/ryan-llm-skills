// Detached process-group leader stays alive while Docker/Compose runs. Its own
// timeout survives loss of the dashboard or operation worker. Termination kills
// the entire group, including Compose's plugin process, before the leader dies.
import { spawn } from 'node:child_process';
const [limit, command, ...args] = process.argv.slice(2);
let terminating = false;
function terminate() {
  if (terminating) return;
  terminating = true;
  process.kill(-process.pid, 'SIGTERM');
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 300);
}
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
const timer = setTimeout(terminate, Number(limit));
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', error => { process.stderr.write(`${error.message}\n`); terminate(); });
child.once('exit', code => {
  if (terminating) return;
  if (code !== 0) { terminate(); return; }
  clearTimeout(timer);
  process.exitCode = 0;
});
