import { readFileSync } from 'node:fs';
import { runCell } from './cell.mjs';
await runCell(JSON.parse(readFileSync(process.argv[2], 'utf8')));
