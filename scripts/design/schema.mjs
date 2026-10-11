// Design package index contract (see docs/design-packages.md).
//
// A design package is a folder of one self-contained HTML file per screen-state
// plus this index. The index names screens; it never stores whether a screen was
// produced or captured. That status is derived from file presence by screenStatus.

export const DESIGN_LIMITS = Object.freeze({ screens: 100, widths: 4, recordBytes: 65536, screenBytes: 200 * 1024, designs: 50 });
export const DESIGN_SLUG = /^[a-z][a-z0-9-]{0,47}$/;
export const SCREEN_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const POSTURES = ['desktop-only', 'responsive'];
export const KINDS = ['decision', 'action', 'flow-step'];
export const STATES = ['ideal', 'empty', 'loading', 'error', 'partial', 'denied', 'offline', 'stale'];

const optionalString = value => value === undefined || typeof value === 'string';
const nonEmpty = value => typeof value === 'string' && value.trim() !== '';
const isRepoRelative = value => nonEmpty(value) && !value.startsWith('/') && !value.split('/').includes('..');
export const screenFile = (step, id) => `screens/${String(step).padStart(2, '0')}-${id}.html`;
export const captureFile = (step, id, width) => `captures/${String(step).padStart(2, '0')}-${id}@${width}.png`;

const designSystem = ds => !ds ? null : ds.repository !== undefined ? { repository: ds.repository, paths: [...ds.paths] } : { path: ds.path, tokens: ds.tokens ?? null };

// Validates one index against its directory slug. Returns { design } with the
// allowlisted fields or { error } naming the first violation.
export function parseDesign(record, { slug } = {}) {
  const fail = error => ({ error });
  if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('record is not an object');
  if (record.schema_version !== 1) return fail('unsupported schema_version');
  if (typeof record.design !== 'string' || !DESIGN_SLUG.test(record.design)) return fail('design is not a valid slug');
  if (slug !== undefined && record.design !== slug) return fail('design does not match directory name');
  if (!nonEmpty(record.title)) return fail('title is missing');
  if (![record.brief, record.created_at, record.note].every(optionalString)) return fail('brief, created_at and note must be strings');
  if (record.design_system !== undefined) {
    const ds = record.design_system;
    if (!ds || typeof ds !== 'object') return fail('design_system must be an object');
    // New form {repository, paths} matches the kit; legacy {path, tokens} holds absolute paths.
    if (ds.repository !== undefined) {
      if (!nonEmpty(ds.repository) || !Array.isArray(ds.paths) || !ds.paths.length || !ds.paths.every(isRepoRelative)) return fail('design_system needs a repository id and a non-empty list of repository-relative paths');
    } else if (!nonEmpty(ds.path) || !optionalString(ds.tokens)) return fail('design_system needs a repository and paths');
  }
  const viewport = record.viewport;
  if (!viewport || typeof viewport !== 'object' || !POSTURES.includes(viewport.posture)) return fail('viewport.posture is not desktop-only or responsive');
  if (!Array.isArray(viewport.widths) || !viewport.widths.length || viewport.widths.length > DESIGN_LIMITS.widths
    || viewport.widths.some(width => !Number.isInteger(width) || width < 320 || width > 3840)
    || new Set(viewport.widths).size !== viewport.widths.length) return fail('viewport.widths must be 1 to 4 distinct integers between 320 and 3840');
  if (viewport.posture === 'responsive' && viewport.widths.length < 2) return fail('responsive posture needs at least two widths');
  if (record.context !== undefined && (!Array.isArray(record.context) || !record.context.every(nonEmpty))) return fail('context must be a list of paths');
  if (!Array.isArray(record.screens) || !record.screens.length) return fail('screens is empty or not an array');
  if (record.screens.length > DESIGN_LIMITS.screens) return fail(`more than ${DESIGN_LIMITS.screens} screens`);
  const ids = new Set();
  const screens = [];
  for (let index = 0; index < record.screens.length; index++) {
    const item = record.screens[index];
    const step = index + 1;
    const where = `screen ${step}`;
    if (!item || typeof item !== 'object') return fail(`${where} is not an object`);
    if (item.step !== step) return fail(`${where} has step ${item.step}; steps must run 1..N in order`);
    if (typeof item.id !== 'string' || !SCREEN_ID.test(item.id)) return fail(`${where} id is not a valid slug`);
    if (ids.has(item.id)) return fail(`duplicate screen id ${item.id}`);
    ids.add(item.id);
    if (!nonEmpty(item.title)) return fail(`${where} title is missing`);
    if (!nonEmpty(item.person)) return fail(`${where} person is missing`);
    if (!nonEmpty(item.job)) return fail(`${where} job is missing: every screen serves a decision or an action`);
    if (!KINDS.includes(item.kind)) return fail(`${where} kind is not decision, action or flow-step`);
    if (!STATES.includes(item.state)) return fail(`${where} state is not one of ${STATES.join(', ')}`);
    const expected = screenFile(step, item.id);
    if (item.file !== undefined && item.file !== expected) return fail(`${where} file must be ${expected}`);
    if (item.shell_from !== undefined && item.shell_from !== null
      && (!Number.isInteger(item.shell_from) || item.shell_from < 1 || item.shell_from >= step)) return fail(`${where} shell_from must name an earlier step`);
    if (![item.primary_action, item.notes].every(optionalString)) return fail(`${where} primary_action and notes must be strings`);
    screens.push({ step, id: item.id, title: item.title, person: item.person, job: item.job, kind: item.kind, state: item.state,
      file: expected, shell_from: item.shell_from ?? null, primary_action: item.primary_action ?? null, notes: item.notes ?? null });
  }
  const deviations = [];
  if (record.deviations !== undefined) {
    if (!Array.isArray(record.deviations)) return fail('deviations is not an array');
    for (const item of record.deviations) {
      if (!item || typeof item !== 'object' || !Number.isInteger(item.screen) || item.screen < 1 || item.screen > screens.length) return fail('deviation screen must name an existing step');
      if (![item.token, item.from, item.to, item.reason].every(nonEmpty)) return fail(`deviation on screen ${item.screen} needs token, from, to and reason`);
      deviations.push({ screen: item.screen, token: item.token, from: item.from, to: item.to, reason: item.reason });
    }
  }
  return { design: { design: record.design, title: record.title, brief: record.brief ?? null, created_at: record.created_at ?? null,
    note: record.note ?? null, design_system: designSystem(record.design_system),
    viewport: { posture: viewport.posture, widths: [...viewport.widths] }, context: record.context ?? [], screens, deviations } };
}

// Derived, never stored: `produced` is the screen file's presence, `captured`
// maps each declared width to its capture's presence. `exists(relativePath)`
// resolves against the design directory and must not follow symlinks.
export async function screenStatus(design, exists) {
  const screens = [];
  for (const screen of design.screens) {
    const captured = {};
    for (const width of design.viewport.widths) captured[width] = await exists(captureFile(screen.step, screen.id, width));
    screens.push({ ...screen, produced: await exists(screen.file), captured });
  }
  return { screens, summary: { total: screens.length, produced: screens.filter(s => s.produced).length,
    captured: screens.filter(s => Object.values(s.captured).every(Boolean)).length } };
}

// Mechanical screen checks. The model owns everything these cannot decide.
export const SELF_REFERENCE = ['empty state', 'loading state', 'error state', 'prototype', 'mockup', 'switch state', 'toggle state', 'this page shows', 'this screen shows', 'variant', 'placeholder'];
export const MARKETING = ['seamless', 'seamlessly', 'powerful', 'effortless', 'effortlessly', 'intuitive', 'at a glance', 'all in one place', 'supercharge', 'streamline', 'streamlined', 'robust', 'cutting-edge', 'next-generation', 'easy to use', 'beautiful'];

export function lintScreen(html, { bytes = Buffer.byteLength(html) } = {}) {
  const findings = [];
  const fail = (rule, detail) => findings.push({ level: 'fail', rule, detail });
  const warn = (rule, detail) => findings.push({ level: 'warn', rule, detail });
  if (bytes > DESIGN_LIMITS.screenBytes) fail('size', `${bytes} bytes exceeds ${DESIGN_LIMITS.screenBytes}`);
  if (/cdn\.tailwindcss\.com/i.test(html)) fail('external-tailwind', 'uses the Tailwind CDN; reference vendor/tailwind.js instead');
  for (const match of html.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*\b(?:src|href)\s*=\s*["']?(https?:)?\/\/[^"'\s>]+/gi)) fail('external-resource', `<${match[1].toLowerCase()}> loads ${match[0].match(/(https?:)?\/\/[^"'\s>]+/)[0]}`);
  for (const match of html.matchAll(/@import\s+(?:url\()?["']?(https?:)?\/\//gi)) fail('external-resource', `@import loads ${match[0]}`);
  for (const match of html.matchAll(/url\(\s*["']?(https?:)?\/\/[^)]+\)/gi)) fail('external-resource', `url() loads ${match[0]}`);
  if (/<form\b[^>]*\baction\s*=/i.test(html)) fail('form-action', 'a form posts somewhere; prototypes do not submit');
  if (/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket/.test(html)) fail('network', 'script performs network requests');
  if (!/<style\b/i.test(html) && !/tailwind/i.test(html)) warn('unstyled', 'no <style> block and no Tailwind runtime reference found');
  const text = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  for (const phrase of SELF_REFERENCE) if (text.includes(phrase)) warn('self-reference', `visible text contains "${phrase}"`);
  for (const phrase of MARKETING) if (new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(text)) warn('marketing', `visible text contains "${phrase}"`);
  if (/<(nav|div|ul)\b[^>]*\b(data-state|data-variant|data-screen)\b/i.test(html)) warn('switcher', 'markup carries state/variant switch attributes; one file holds one state');
  return findings;
}
