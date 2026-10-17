// Run from any directory: node scripts/changeset-study/visual/build.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'changeset-visual-'));
try {
  execFileSync('uv', ['run', '--with', 'matplotlib==3.11.2', 'python', join(here, 'figures.py')], { stdio: 'inherit' });
  execFileSync('npx', ['--yes', '--package', 'tailwindcss@3.4.17', 'tailwindcss',
    '-i', join(here, 'styles.css'), '--content', join(here, 'template.html'),
    '-o', join(temp, 'styles.css'), '--minify'], { cwd: here, stdio: 'inherit' });
  let html = readFileSync(join(here, 'template.html'), 'utf8')
    .replace('/* INLINE_STYLES */', readFileSync(join(temp, 'styles.css'), 'utf8'));
  for (const name of ['time', 'calls', 'tokens', 'cost', 'acceptance']) {
    const data = readFileSync(join(here, `${name}.svg`)).toString('base64');
    html = html.replace(`FIGURE_${name}`, `data:image/svg+xml;base64,${data}`);
  }
  if (/FIGURE_|INLINE_STYLES/.test(html)) throw new Error('Unresolved visual asset');
  writeFileSync(join(here, '..', 'visual.html'), html);
  console.log('Built scripts/changeset-study/visual.html with embedded Tailwind CSS and figures.');
} finally { rmSync(temp, { recursive: true, force: true }); }
