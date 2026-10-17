import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { installReservationGuard } from './guard.mjs';
const [output, jobPath] = process.argv.slice(2), manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
process.env.CHANGESET_STUDY_SDK_ROOT = join(output, manifest.sdk_root);
process.env.CHANGESET_MODEL_RUNTIME = join(output, manifest.sdk_root, 'pi-coding-agent/dist/core/model-runtime.js');
process.env.JEV_TYPESAFE_MODULE = join(output, manifest.jev_entry);
const scripts = join(output, 'frozen/scripts');
const { Budget, modelRuntime } = await import(pathToFileURL(join(scripts, 'changeset/models.mjs')));
const { same } = await import(pathToFileURL(join(scripts, 'changeset-study/divergent/writer-control/support.mjs')));
const runtime = await modelRuntime();
if (!same(runtime.getModel('deepseek', 'deepseek-flash'), manifest.writer_model)) throw new Error('Effective frozen SDK writer metadata differs from pin');
if (!runtime.hasConfiguredAuth('deepseek')) throw new Error('DeepSeek credentials unavailable');
const job = JSON.parse(readFileSync(jobPath, 'utf8')), orphaned = [];
const restore = installReservationGuard({ Budget, ledger: manifest.ledger, registry: join(output, 'reservations.json'),
  limit: manifest.additional_exposure_usd, maxReservations: manifest.max_reservations, onPersistenceFailure: entry => {
    orphaned.push(entry); console.error(JSON.stringify({ orphaned_reservation: entry }));
    writeFileSync(join(job.directory, 'orphaned-reservations.json'), JSON.stringify(orphaned, null, 2) + '\n');
  } });
const began = performance.now();
try {
  const { runCell } = await import(pathToFileURL(join(scripts, 'changeset-study/cell.mjs')));
  const result = await runCell(job);
  result.process_elapsed_ms = performance.now() - began;
  writeFileSync(join(job.directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
} finally { restore(); }
