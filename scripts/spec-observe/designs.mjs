// Read-only design packages for a workspace (see docs/design-packages.md).
//
// Lists <workspace>/designs/<slug>/design.json through the bounded workspace
// file reader, validates each index with the shared schema and derives screen
// status from file presence. Nothing here writes or follows symlinks.
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { DESIGN_LIMITS, parseDesign, screenStatus } from '../design/schema.mjs';
import { readPackageFile } from './package-files.mjs';

export async function listWorkspaceDesigns(directory) {
  const root = join(directory, 'designs');
  const designs = [], errors = [];
  try {
    if (!(await lstat(root)).isDirectory()) return { designs, errors: [{ name: 'designs', message: 'Not a directory' }] };
  } catch (error) {
    // An absent designs directory is the ordinary case.
    return { designs, errors: error.code === 'ENOENT' ? [] : [{ name: 'designs', message: error.code ?? error.message }] };
  }
  const names = [];
  let handle;
  try {
    handle = await opendir(root);
    for await (const entry of handle) {
      // A symlinked design directory is skipped: dirents report links as links, not directories.
      if (!entry.isDirectory()) continue;
      if (names.length >= DESIGN_LIMITS.designs) { errors.push({ name: 'designs', message: `More than ${DESIGN_LIMITS.designs} designs; later ones are not listed` }); break; }
      names.push(entry.name);
    }
  } catch (error) { errors.push({ name: 'designs', message: error.code ?? error.message }); }
  names.sort();
  for (const slug of names) {
    const name = `designs/${slug}/design.json`;
    let file;
    try { file = await readPackageFile(directory, name); } catch (error) { errors.push({ name, message: error.message }); continue; }
    if (file.bytes.length > DESIGN_LIMITS.recordBytes) { errors.push({ name, message: 'Record over 64 KiB' }); continue; }
    let record;
    try { record = JSON.parse(file.bytes.toString('utf8')); } catch { errors.push({ name, message: 'Not JSON' }); continue; }
    const parsed = parseDesign(record, { slug });
    if (parsed.error) { errors.push({ name, message: parsed.error }); continue; }
    const base = join(root, slug);
    const exists = async relative => { try { return (await lstat(join(base, relative))).isFile(); } catch { return false; } };
    const status = await screenStatus(parsed.design, exists);
    designs.push({ slug, path: `designs/${slug}`, ...parsed.design, screens: status.screens, summary: status.summary });
  }
  return { designs, errors };
}
