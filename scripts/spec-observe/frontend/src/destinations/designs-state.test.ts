import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designBriefRoute, selectDesign } from './designs-state';
import type { Design, Screen } from './designs-state';
import { fileViewUrl, packageViewUrl } from '../observation-format';

const screen = (over: Partial<Screen> = {}): Screen => ({
  step: 1, file: 'screens/01-shell.html', title: 'Shell', person: 'Operator', job: 'Choose the workspace',
  produced: false, captured: { 1280: false }, kind: 'decision', state: 'ideal', ...over,
});

const design = (over: Partial<Design> = {}): Design => ({
  slug: 'alpha', path: 'designs/alpha', title: 'Alpha', brief: 'brief.md',
  viewport: { posture: 'responsive', widths: [1280, 1600] },
  summary: { total: 2, produced: 1, captured: 0 },
  screens: [screen(), screen({ step: 2, file: 'screens/02-live.html', title: 'Live', produced: true })],
  ...over,
});

// Run: node --import tsx --test src/destinations/designs-state.test.ts
test('missing or empty id selects the first listed design with its first produced screen and first declared width', () => {
  const first = design();
  const second = design({ slug: 'beta', path: 'designs/beta', title: 'Beta' });
  for (const route of [{ dest: 'designs' as const, ws: 'kit' }, { dest: 'designs' as const, ws: 'kit', id: '' }]) {
    const selection = selectDesign(route, [first, second]);
    assert.equal(selection.design, first, JSON.stringify(route));
    assert.equal(selection.screen, first.screens[1]);
    assert.equal(selection.width, 1280);
    assert.equal(selection.unavailable, false);
    assert.deepEqual(selection.normalized, { dest: 'designs', ws: 'kit', q: undefined, id: 'alpha', path: 'screens/02-live.html', tab: '1280' });
  }
});

test('invalid path and tab fall back to the first produced screen and first declared width', () => {
  const selection = selectDesign({ dest: 'designs', ws: 'kit', id: 'alpha', path: 'screens/99-missing.html', tab: '1440' }, [design()]);
  assert.equal(selection.screen?.step, 2);
  assert.equal(selection.width, 1280);
  assert.deepEqual(selection.normalized, { dest: 'designs', ws: 'kit', q: undefined, id: 'alpha', path: 'screens/02-live.html', tab: '1280' });
  const exact = selectDesign({ dest: 'designs', ws: 'kit', id: 'alpha', path: 'screens/02-live.html', tab: '1600' }, [design()]);
  assert.equal(exact.width, 1600);
  assert.equal(exact.normalized, null);
  // "01280" is not the exact decimal string of the declared 1280 width.
  const padded = selectDesign({ dest: 'designs', ws: 'kit', id: 'alpha', path: 'screens/02-live.html', tab: '01280' }, [design()]);
  assert.equal(padded.width, 1280);
  assert.deepEqual(padded.normalized, { dest: 'designs', ws: 'kit', q: undefined, id: 'alpha', path: 'screens/02-live.html', tab: '1280' });
});

test('designs without a produced screen select the first planned screen', () => {
  const planned = design({
    screens: [screen(), screen({ step: 2, file: 'screens/02-live.html', title: 'Live' })],
    summary: { total: 2, produced: 0, captured: 0 },
  });
  const selection = selectDesign({ dest: 'designs', id: 'alpha' }, [planned]);
  assert.equal(selection.screen, planned.screens[0]);
  assert.equal(selection.screen?.step, 1);
  assert.equal(selection.width, 1280);
});

test('an explicit unknown id is unavailable and never selects a neighbor', () => {
  const selection = selectDesign({ dest: 'designs', id: 'gamma', path: 'screens/02-live.html' }, [design()]);
  assert.deepEqual(selection, { design: null, screen: null, width: null, unavailable: true, normalized: null });
});

test('a design hidden by q stays selected and normalization keeps ws and q', () => {
  const beta = design({
    slug: 'beta', path: 'designs/beta', title: 'Beta',
    viewport: { posture: 'responsive', widths: [1000, 1600] },
    screens: [screen({ file: 'screens/01-b.html', title: 'B' })],
  });
  const hidden = selectDesign({ dest: 'designs', ws: 'kit', q: 'alpha-only', id: 'beta' }, [design(), beta]);
  assert.equal(hidden.design, beta);
  assert.equal(hidden.screen, beta.screens[0]);
  assert.equal(hidden.width, 1000);
  assert.deepEqual(hidden.normalized, { dest: 'designs', ws: 'kit', q: 'alpha-only', id: 'beta', path: 'screens/01-b.html', tab: '1000' });
  const canonical = selectDesign({ dest: 'designs', ws: 'kit', q: 'alpha-only', id: 'beta', path: 'screens/01-b.html', tab: '1000' }, [design(), beta]);
  assert.equal(canonical.design, beta);
  assert.equal(canonical.normalized, null);
});

test('zero-design and all-invalid inputs expose no phantom selection', () => {
  assert.deepEqual(selectDesign({ dest: 'designs', ws: 'kit' }, []),
    { design: null, screen: null, width: null, unavailable: true, normalized: null });
  const empty = design({
    slug: 'empty', path: 'designs/empty', title: 'Empty',
    screens: [], viewport: { posture: 'desktop-only', widths: [] }, summary: { total: 0, produced: 0, captured: 0 },
  });
  const selection = selectDesign({ dest: 'designs', ws: 'kit', id: 'empty', path: 'screens/01-none.html', tab: '1440' }, [empty]);
  assert.equal(selection.unavailable, false);
  assert.equal(selection.design, empty);
  assert.equal(selection.screen, null);
  assert.equal(selection.width, null);
  assert.deepEqual(selection.normalized, { dest: 'designs', ws: 'kit', q: undefined, id: 'empty', path: undefined, tab: undefined });
});

test('safe nested brief paths link to the workspace Files route with no carried selection', () => {
  assert.deepEqual(designBriefRoute('kit', design({ brief: 'docs/brief.md' })),
    { dest: 'files', ws: 'kit', source: 'workspace', path: 'designs/alpha/docs/brief.md' });
  assert.deepEqual(designBriefRoute('kit', design({ brief: 'brief.md' })),
    { dest: 'files', ws: 'kit', source: 'workspace', path: 'designs/alpha/brief.md' });
});

test('unsafe brief paths and empty workspaces yield no link', () => {
  for (const brief of ['../brief.md', 'docs/../brief.md', '/etc/passwd', '', 'docs\\brief.md',
    './brief.md', 'docs/./brief.md', 'docs//brief.md', 'docs/', 'a/../../b', 'nul\0brief.md']) {
    assert.equal(designBriefRoute('kit', design({ brief })), null, JSON.stringify(brief));
  }
  assert.equal(designBriefRoute('', design({ brief: 'brief.md' })), null);
  assert.equal(designBriefRoute('kit', design({ brief: null })), null);
  assert.equal(designBriefRoute('kit', design({ brief: undefined })), null);
});

test('fileViewUrl encodes Unicode owners as UTF-8 base64url and each path segment', () => {
  assert.equal(fileViewUrl('workspace', 'kité', 'designs/alpha/screens/01 empty state.html'),
    '/workspace-view/a2l0w6k/designs/alpha/screens/01%20empty%20state.html');
  assert.equal(fileViewUrl('workspace', 'kité', 'screens/é.html'), '/workspace-view/a2l0w6k/screens/%C3%A9.html');
  assert.equal(fileViewUrl('package', 'agent-tooling/newui-07-designs', 'work-tour.html'),
    '/package-view/YWdlbnQtdG9vbGluZy9uZXd1aS0wNy1kZXNpZ25z/work-tour.html');
  // Existing Observations work-tour caller keeps identical package output.
  assert.equal(packageViewUrl('agent-tooling/newui-07-designs', 'work-tour.html'),
    '/package-view/YWdlbnQtdG9vbGluZy9uZXd1aS0wNy1kZXNpZ25z/work-tour.html');
  assert.equal(packageViewUrl('kité', 'work-tour.html'), fileViewUrl('package', 'kité', 'work-tour.html'));
});
