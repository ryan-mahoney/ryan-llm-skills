# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused route/reader regressions using real dashboard routes and isolated storage.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script \
  scripts/spec-observe/frontend/route-browser-check.py [--case rail|files|specs|context|catalog|member|search|filters|specs-list|specs-overview|specs-variants|specs-activity|specs-relaunch|files-workspace|files-sources|files-continuity|files-recovery|files-read-refresh]
Only the fixture substitutes workers; App, adapters and file APIs are real.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import select
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright
from reference_screens import reference_screens

args = argparse.ArgumentParser()
args.add_argument('--case', choices=['rail', 'files', 'specs', 'context', 'catalog', 'member', 'search', 'filters', 'specs-list', 'specs-workspace', 'specs-overview', 'specs-variants', 'specs-activity', 'specs-relaunch', 'files-workspace', 'files-sources', 'files-continuity', 'files-recovery', 'files-read-refresh'])
case = args.parse_args().case
root = Path(__file__).resolve().parent
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-route-evidence'))
evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
report = {'status': 'failed', 'scenarios': [], 'pageErrors': []}
# Deterministic EV-8 QA tour text: fixed setup, entrypoints, expected outcomes
# and owned gate/capture links; no timings, host paths or live state.
QA_FILES_TOUR = """# Files QA tour

Deterministic output of `scripts/spec-observe/frontend/route-browser-check.py --case context`
(EV-8). Only the owned port-0 browser fixture and its temporary storage are controlled;
the App, route/scope/registry, files-model and the server file APIs are real.

## Setup

- Build the served bundle first: `npm run build --prefix scripts/spec-observe/frontend`
  checks TypeScript and writes `scripts/spec-observe/dashboard.html`.
- The gate starts `browser-fixture.mjs` with temporary storage, registers the gated
  noncanonical absolute context reference, seeds one available `fixture-repo` repository
  artifact (`fixture-repo-plan.md` in the checkout), then drives headless Chrome.
- No `.env`, operator storage or live service is read; the fixture closes its own
  server, browser and temporary root.

## Files source entrypoints

- Workspace: `#/files?ws=fixture`
- Context: `#/files?ws=fixture&source=context&path=context/project-context.md`
- Repository: `#/files?ws=fixture&source=repository&id=fixture-repo&path=fixture-repo-plan.md`
- Package: `#/files?ws=fixture&source=package&id=<package path>&path=spec.md`

## Expected scenario outcomes

1. The registered noncanonical absolute context reference shows Available and opens
   Files `source=context` with the normalized relative path `context/project-context.md`;
   real workspace-file bytes render and stay readable on reload.
2. An available repository artifact opens Files `source=repository` with the kit
   repository id `fixture-repo` and checkout-relative path `fixture-repo-plan.md`;
   real Git checkout bytes render and stay readable on reload.
3. Briefs and Notes collections and their file rows keep Files `source=workspace`
   with `briefs/` and `notes/` paths through selection and reload.
4. The context/artifact journey records zero page errors and captures representative
   1280 and 1600 states.

## Owned gate and capture links

- EV-4 workspace reader: report `files-workspace.json`; captures `files-6-*`, `files-18-*`, `files-19-*`.
- EV-5 four-source journeys: report `files-sources.json`; captures `files-15-*`, `files-16-*`, `files-17-*`.
- EV-6 selection/revalidation continuity: report `files-continuity.json`; captures `files-62-*`, `files-66-*`, `files-67-*`.
- EV-7 regional recovery and coverage: report `files-recovery.json`; captures `files-61-*` through `files-68-*`.
- EV-8 context/artifact links and this QA tour: report `files-context.json`; captures `files-15-*`, `files-16-*`.
- EV-9 host deployment read is a pending operator-authorized execution-host restart/read; merge verification does not restart a live host.
"""
fixture_env = dict(os.environ)
if case == 'context':
    fixture_env['SENTINEL_NONCANONICAL_CONTEXT'] = '1'
if case in ('files-workspace', 'files-sources', 'files-continuity', 'files-recovery', 'files-read-refresh'):
    fixture_env['SENTINEL_REPOSITORY_FILES'] = '1'
fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=fixture_env)
try:
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture readiness exceeded 10 seconds')
    receipt = json.loads(fixture.stdout.readline())
    report['fixture'] = receipt
    report['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip())
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222') if case == 'catalog' else p.chromium.launch(executable_path=shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1280, 'height': 860})
        page = context.new_page()
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))

        def control(action, value=None):
            query = urlencode({'action': action, **({'value': value} if value is not None else {})})
            response = context.request.get(receipt['url'] + '/__fixture/control?' + query)
            assert response.ok, response.text()
            return response.json()

        def params():
            return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

        def open_route(dest, **values):
            page.goto(receipt['url'] + '/#/' + dest + '?' + urlencode(values), wait_until='domcontentloaded')
            expect(page.locator('h1')).to_have_text(dest.capitalize())

        def viewer(name, text):
            expect(page.locator('.file-viewer h4')).to_have_text(name)
            expect(page.locator('.file-viewer')).to_contain_text(text)
            expect(page.get_by_role('button', name=name, exact=True)).to_have_attribute('aria-pressed', 'true')
            assert params()['path'] == [name], page.url

        def files_params():
            return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

        def files_row(name):
            return page.locator('.files-destination button.file-record').filter(has=page.get_by_text(name, exact=True)).first

        def files_viewer(name, text):
            expect(page.locator('.files-destination .reader-head h2')).to_have_text(name)
            expect(page.locator('.files-destination .reader')).to_contain_text(text)
            expect(page.locator('.files-destination button.file-record[aria-pressed="true"]')).to_contain_text(name)
            assert files_params().get('path') == [name], page.url

        def files_contrast(selector):
            return page.eval_on_selector(selector, """(el) => {
                const nums = c => (c.match(/[0-9.]+/g) || []).map(Number);
                const lum = c => { const [r, g, b] = nums(c); const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
                let node = el, background = 'rgb(11, 12, 14)';
                while (node) { const candidate = getComputedStyle(node).backgroundColor; if (candidate && candidate !== 'transparent' && candidate !== 'rgba(0, 0, 0, 0)') { background = candidate; break; } node = node.parentElement; }
                const a = lum(getComputedStyle(el).color), b = lum(background);
                return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            }""")

        def files_layout(label):
            metrics = page.evaluate("""() => {
                const rect = selector => { const el = document.querySelector(selector); const box = el.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }; };
                return { list: rect('.files-destination .list-pane'), detail: rect('.files-destination .detail-pane'), records: rect('.files-destination .records'), reader: rect('.files-destination .reader') };
            }""")
            assert metrics['list']['x'] + metrics['list']['width'] <= metrics['detail']['x'] + 1, (label, metrics)
            assert abs(metrics['list']['y'] - metrics['detail']['y']) < 1, (label, metrics)
            assert metrics['records']['scrollHeight'] > metrics['records']['clientHeight'], (label, metrics)
            assert metrics['reader']['scrollHeight'] > metrics['reader']['clientHeight'], (label, metrics)
            # Files continuity memory may have restored a reader position; the
            # list-only scroll must leave that observed position untouched
            # instead of assuming a specific zero.
            initial_reader_position = metrics['reader']['scrollTop']
            page.eval_on_selector('.files-destination .records', 'el => { el.scrollTop = el.scrollHeight; }')
            records_position = page.eval_on_selector('.files-destination .records', 'el => el.scrollTop')
            assert records_position > 0, (label, metrics)
            assert page.eval_on_selector('.files-destination .reader', 'el => el.scrollTop') == initial_reader_position, (label, metrics)
            page.eval_on_selector('.files-destination .reader', 'el => { el.scrollTop = el.scrollHeight; }')
            assert page.eval_on_selector('.files-destination .reader', 'el => el.scrollTop') > 0, (label, metrics)
            assert page.eval_on_selector('.files-destination .records', 'el => el.scrollTop') == records_position, (label, metrics)
            assert page.locator('.files-destination .file-viewer').count() == 0, label

        def files_accessibility(label):
            for target, selector in [('Source select', '#file-source'), ('Find input', '#find-record'), ('File row', '.files-destination .records button.file-record'), ('Refresh files', '.files-destination .detail-foot .ds-btn')]:
                size = page.eval_on_selector(selector, 'el => { const box = el.getBoundingClientRect(); return { width: box.width, height: box.height }; }')
                assert size['height'] >= 44, (label, target, size)
            for selector in ['.files-destination .reader-head h2', '.files-destination .reader-head p', '.files-destination .list-caption', '.files-destination .records button.file-record small']:
                ratio = files_contrast(selector)
                assert ratio >= 4.5, (label, selector, ratio)
            page.locator('#find-record').focus()
            page.keyboard.press('Tab')
            focused = page.evaluate("""() => ({ tag: document.activeElement.tagName, cls: String(document.activeElement.className), outline: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth })""")
            assert focused['tag'] == 'BUTTON' and 'file-record' in focused['cls'], (label, focused)
            assert focused['outline'] != 'none' and focused['width'] not in ('0px', ''), (label, focused)
            focused_name = page.evaluate("() => document.activeElement.querySelector('strong') ? document.activeElement.querySelector('strong').textContent : ''")
            page.keyboard.press('Enter')
            expect(page.locator('.files-destination .reader-head h2')).to_have_text(focused_name)
            assert files_params().get('path') == [focused_name], page.url

        if case == 'catalog':
            # Real App and dashboard composition; only the final catalog HTTP
            # response is controlled. State and initial detail use the real APIs.
            healthy = context.request.get(receipt['url'] + '/api/workspaces').json()
            response_value = healthy
            page.route('**/api/workspaces', lambda route: route.fulfill(json=response_value))
            open_route('workspaces', ws='fixture', q='Browser')
            expect(page.get_by_role('heading', name='Workspace kit', exact=True)).to_be_visible()
            original_url = page.url
            diagnostic = {'path': healthy['storage']['root'] + '/projects', 'message': 'permission denied (EACCES)'}

            def retained():
                expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
                for heading in ['Repositories', 'Registered context', 'Workspace material', 'Workspace kit']:
                    expect(page.get_by_role('heading', name=heading, exact=True)).to_be_visible()
                expect(page.locator('main')).to_contain_text('fixture-repo')
                expect(page.locator('main')).to_contain_text('context/project-context.md')
                expect(page.locator('main')).to_contain_text('browser.md')
                expect(page.locator('#find-record')).to_have_value('Browser')
                assert page.url == original_url
                expect(page.locator('main')).not_to_contain_text('Selected workspace is no longer in the catalog.')

            for status in ['unreadable', 'invalid_projects', 'ok']:
                response_value = {'storage': {**healthy['storage'], 'status': status, 'errors': [] if status == 'ok' else [diagnostic]},
                                  'valid': [], 'invalid': [], 'errors': [diagnostic]}
                with page.expect_response('**/api/workspaces') as observed:
                    page.get_by_role('button', name='Refresh workspaces', exact=True).click()
                assert observed.value.status == 200
                expect(page.get_by_text('Workspaces could not be read', exact=True)).to_be_visible()
                expect(page.get_by_role('button', name='Retry workspace', exact=True)).to_be_visible()
                expect(page.locator('main')).to_contain_text(diagnostic['message'])
                retained()
                assert context.request.get(receipt['url'] + '/api/state').ok
                response_value = healthy
                page.get_by_role('button', name='Retry workspace', exact=True).click()
                expect(page.get_by_text('Workspaces could not be read', exact=True)).to_have_count(0)
                retained()
                report['scenarios'].append(f'HTTP 200 {status} with listing diagnostics retains directory/composition/search/scope and recovers via retry')

            response_value = {**healthy, 'valid': [entry for entry in healthy['valid'] if entry['id'] != 'fixture']}
            page.get_by_role('button', name='Refresh workspaces', exact=True).click()
            expect(page.locator('[data-workspace="fixture"]')).to_have_count(0)
            expect(page.get_by_role('heading', name='Workspace kit', exact=True)).to_have_count(0)
            expect(page.get_by_text('Workspace could not be read', exact=True)).to_be_visible()
            assert page.url == original_url
            report['scenarios'].append('Complete error-free ok listing removes selected composition without clearing route')
            response_value = {**healthy, 'valid': [], 'invalid': [], 'errors': []}
            page.get_by_role('button', name='Refresh workspaces', exact=True).click()
            expect(page.get_by_role('heading', name='Workspace storage needs setup', exact=True)).to_be_visible()
            report['scenarios'].append('Complete error-free empty catalog remains the setup empty state')

        if case == 'context':
            open_route('workspaces', ws='fixture')
            # The real contextRecord reports this absolute ./, ../ and // reference
            # Available. Its Files link must carry the Files context source and the
            # reader's canonical relative path, not a workspace-source route.
            table = page.locator('section').filter(has=page.get_by_role('heading', name='Registered context', exact=True))
            expect(table).to_contain_text('Available')
            table.get_by_role('button').click()
            files_viewer('context/project-context.md', 'Browser context note.')
            assert params()['source'] == ['context'], page.url
            assert params()['ws'] == ['fixture'], page.url
            assert params()['path'] == ['context/project-context.md'], page.url
            context_bytes = context.request.get(receipt['url'] + '/api/workspace-file?' + urlencode({'id': 'fixture', 'file': 'context/project-context.md'}))
            assert context_bytes.ok and context_bytes.text() == '# Project context\nBrowser context note.\n', context_bytes.text()
            page.screenshot(path=str(evidence / 'files-15-1280.png'))
            page.reload()
            files_viewer('context/project-context.md', 'Browser context note.')
            assert params()['source'] == ['context'], page.url
            report['scenarios'].append('Available noncanonical absolute context opens Files source=context with the normalized relative path, real bytes and reload readability')

            # An available repository artifact carries the kit repository identity
            # and its checkout-relative path into the Files repository source; the
            # gated fixture record resolves to ok bytes through the real store.
            open_route('workspaces', ws='fixture')
            artifact = page.locator('section').filter(has=page.get_by_role('heading', name='Artifacts', exact=True))
            expect(artifact).to_contain_text('Browser repository plan')
            artifact.get_by_role('button', name='fixture-repo · fixture-repo-plan.md', exact=True).click()
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            assert params()['source'] == ['repository'], page.url
            assert params()['id'] == ['fixture-repo'], page.url
            assert params()['path'] == ['fixture-repo-plan.md'], page.url
            repository_bytes = context.request.get(receipt['url'] + '/api/repository-file?' + urlencode({'id': 'fixture', 'repository': 'fixture-repo', 'file': 'fixture-repo-plan.md'}))
            assert repository_bytes.ok and repository_bytes.text() == '# Fixture repository plan\nCheckout-scoped suggestion target.\n', repository_bytes.text()
            page.screenshot(path=str(evidence / 'files-16-1280.png'))
            page.reload()
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            assert params()['source'] == ['repository'], page.url
            report['scenarios'].append('Available Workspaces repository artifact opens Files source=repository with kit repository id and relative path, real checkout bytes and reload readability')

            # Briefs and Notes keep the workspace source through collection and row.
            open_route('workspaces', ws='fixture')
            material = page.locator('section').filter(has=page.get_by_role('heading', name='Workspace material', exact=True))
            material.get_by_role('button', name='Briefs', exact=True).click()
            assert params()['source'] == ['workspace'] and params()['path'] == ['briefs/'], page.url
            files_row('briefs/browser.md').click()
            files_viewer('briefs/browser.md', 'A recorded brief.')
            assert params()['source'] == ['workspace'], page.url
            page.reload()
            files_viewer('briefs/browser.md', 'A recorded brief.')
            open_route('workspaces', ws='fixture')
            material.get_by_role('button', name='Notes', exact=True).click()
            assert params()['source'] == ['workspace'] and params()['path'] == ['notes/'], page.url
            files_row('notes/browser.md').click()
            files_viewer('notes/browser.md', 'A recorded note.')
            assert params()['source'] == ['workspace'], page.url
            report['scenarios'].append('Briefs and Notes collections and file rows keep the workspace Files source through selection and reload')

            # Representative context/artifact captures at both supported widths.
            page.set_viewport_size({'width': 1600, 'height': 900})
            open_route('files', ws='fixture', source='context', path='context/project-context.md')
            files_viewer('context/project-context.md', 'Browser context note.')
            page.screenshot(path=str(evidence / 'files-15-1600.png'))
            open_route('files', ws='fixture', source='repository', id='fixture-repo', path='fixture-repo-plan.md')
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            page.screenshot(path=str(evidence / 'files-16-1600.png'))

        if case in (None, 'rail'):
            open_route('specs', ws='fixture', tab='overview', filter='active')
            page.locator('#find-record').fill('Keep editors stable')
            expect(page.locator('main')).to_contain_text('Keep editors stable')
            previous = page.url
            page.locator('[data-area="epics"]').click()
            expect(page.locator('h1')).to_have_text('Epics')
            expect(page.locator('main')).to_contain_text('Demo epic')
            assert params()['ws'] == ['fixture']
            assert not {'q', 'filter', 'tab'} & params().keys(), page.url
            assert params().get('id'), 'Populated epic selection lost'
            page.go_back()
            expect(page.locator('#find-record')).to_have_value('Keep editors stable')
            assert page.url == previous
            page.go_forward()
            expect(page.locator('main')).to_contain_text('Demo epic')
            report['scenarios'].append('searched Specs -> populated Epics; scope retained; query/filter/tab cleared; Back/Forward restores')

        if case in (None, 'files'):
            open_route('files', ws='fixture', path='context/project-context.md')
            files_viewer('context/project-context.md', 'Browser context note.')
            files_row('notes/browser.md').click()
            files_viewer('notes/browser.md', 'A recorded note.')
            page.reload()
            files_viewer('notes/browser.md', 'A recorded note.')
            page.go_back()
            files_viewer('context/project-context.md', 'Browser context note.')
            page.go_forward()
            files_viewer('notes/browser.md', 'A recorded note.')
            # Native hash navigation is also an authoritative route input.
            page.evaluate("location.hash = '#/files?ws=fixture'")
            expect(page.locator('.files-destination .reader-head h2')).to_have_text('Files')
            expect(page.locator('.files-destination .reader')).to_contain_text('Select a file')
            page.go_back()
            files_viewer('notes/browser.md', 'A recorded note.')
            # Step-3 collection prefix remains a listing, not a file selection.
            open_route('files', ws='fixture', path='notes/')
            expect(page.locator('.files-destination .reader')).to_contain_text('Directory listing')
            expect(page.locator('.files-destination button.file-record').filter(has=page.get_by_text('context/project-context.md', exact=True))).to_have_count(0)
            files_row('notes/browser.md').click()
            files_viewer('notes/browser.md', 'A recorded note.')
            page.go_back()
            expect(page.locator('.files-destination .reader')).to_contain_text('Directory listing')
            assert params()['path'] == ['notes/']
            report['scenarios'].append('workspace Files selection agrees with URL; reload, Back/Forward, path clearing and collection restoration')
            open_route('files', source='package', id=receipt['package'], path='spec.md')
            files_viewer('spec.md', 'Browser specification')
            files_row('linked.md').click()
            files_viewer('linked.md', 'Linked evidence')
            page.reload()
            files_viewer('linked.md', 'Linked evidence')
            page.go_back()
            files_viewer('spec.md', 'Browser specification')
            page.go_forward()
            files_viewer('linked.md', 'Linked evidence')
            report['scenarios'].append('package Files selection/reload/history uses the same retained reader')

        if case == 'files-workspace':
            # Real built Files destination through the workspace/package file
            # APIs; only the gated fixture bytes and browser are test-owned.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            expect(page.locator('.files-destination .paper')).to_be_visible()
            expect(page.locator('.files-destination .paper script')).to_have_count(0)
            expect(page.locator('.files-destination .paper')).to_contain_text('<script>window.__fixtureUnsafe=true</script>')
            assert page.evaluate('window.__fixtureUnsafe === undefined')
            files_layout('files 1280')
            page.screenshot(path=str(evidence / 'files-6-1280.png'))
            files_accessibility('files 1280')
            report['scenarios'].append('Workspace Markdown renders through the safe renderer with scripts inert at 1280x860')

            open_route('files', ws='fixture', path='files/valid.json')
            files_viewer('files/valid.json', '"schema_version": 1')
            expect(page.locator('.files-destination .paper pre')).to_contain_text('"schema_version": 1')
            open_route('files', ws='fixture', path='files/invalid.json')
            files_viewer('files/invalid.json', '{"broken": [1, 2,')
            open_route('files', ws='fixture', path='files/indented.py')
            files_viewer('files/indented.py', 'def fixture(value):')
            code_text = page.locator('.files-destination .paper pre').inner_text()
            assert '\n    if value:' in code_text and '\n        return {' in code_text, code_text
            assert page.eval_on_selector('.files-destination .paper pre', 'el => getComputedStyle(el).whiteSpace') == 'pre'
            report['scenarios'].append('Valid JSON formats, invalid JSON stays text, and code indentation is preserved')

            open_route('files', ws='fixture', path='files/pixel.png')
            expect(page.locator('.files-destination img.image-preview')).to_be_visible()
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            image = page.eval_on_selector('.files-destination img.image-preview', 'el => ({ width: el.naturalWidth, src: el.getAttribute("src") })')
            assert 'file=files%2Fpixel.png' in image['src'], image
            report['scenarios'].append('Workspace image renders real PNG bytes from the workspace file API')

            open_route('files', ws='fixture', path='files/sandbox.html')
            expect(page.locator('.files-destination iframe.html-frame')).to_be_visible()
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            sandbox = page.get_attribute('.files-destination iframe.html-frame', 'sandbox')
            frame_src = page.get_attribute('.files-destination iframe.html-frame', 'srcdoc')
            assert sandbox == 'allow-scripts' and 'allow-same-origin' not in sandbox, sandbox
            assert '/api/workspace-file' in frame_src, frame_src
            html_response = context.request.get(receipt['url'] + '/api/workspace-file?' + urlencode({'id': 'fixture', 'file': 'files/sandbox.html'}))
            assert html_response.ok
            assert html_response.headers.get('x-package-file-kind') == 'html'
            assert 'sandbox allow-scripts' in (html_response.headers.get('content-security-policy') or '')
            assert 'allow-same-origin' not in (html_response.headers.get('content-security-policy') or '')
            page.screenshot(path=str(evidence / 'files-18-1280.png'))
            report['scenarios'].append('Workspace HTML renders in a sandboxed frame without allow-same-origin and keeps the server CSP')

            open_route('files', ws='fixture', path='files/capture-bundle.zip')
            expect(page.locator('.files-destination .reader .empty')).to_be_visible()
            expect(page.locator('.files-destination .reader .empty')).to_contain_text('2 KiB')
            expect(page.locator('.files-destination .reader .empty')).to_contain_text('zip')
            assert page.get_by_role('link', name='Download file', exact=True).count() == 1
            assert page.locator('.files-destination .reader-head a[download]').count() == 0
            page.screenshot(path=str(evidence / 'files-19-1280.png'))
            report['scenarios'].append('Binary shows actual size/type with a single Download file action')

            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            files_row('files/valid.json').click()
            files_viewer('files/valid.json', '"schema_version": 1')
            page.reload()
            files_viewer('files/valid.json', '"schema_version": 1')
            page.go_back()
            files_viewer('files/overview.md', 'Fixture overview')
            page.go_forward()
            files_viewer('files/valid.json', '"schema_version": 1')
            report['scenarios'].append('Reload and Back/Forward preserve the explicit workspace path')

            open_route('files', ws='fixture', path='files/')
            expect(page.locator('.files-destination .reader .paper')).to_have_count(0)
            assert files_params()['path'] == ['files/'], page.url
            names = page.eval_on_selector_all('.files-destination .records button.file-record strong', 'els => els.map(el => el.textContent)')
            assert names and all(name.startswith('files/') for name in names), names
            assert page.locator('.files-destination button.file-record', has_text='notes/browser.md').count() == 0
            page.screenshot(path=str(evidence / 'files-6-prefix-1280.png'))
            files_row('files/indented.py').click()
            files_viewer('files/indented.py', 'def fixture(value):')
            page.go_back()
            assert files_params()['path'] == ['files/'], page.url
            expect(page.locator('.files-destination .reader .paper')).to_have_count(0)
            report['scenarios'].append('Directory prefix lists only matching loaded rows and restores through Back')

            package = receipt['package']
            open_route('files', ws='fixture', source='package', id=package, path='spec.md')
            expect(page.locator('#file-source')).to_have_value('package')
            expect(page.locator('.files-destination .reader-head h2')).to_have_text('spec.md')
            expect(page.locator('.files-destination .reader')).to_contain_text('Browser specification')
            linked_href = page.get_attribute('.files-destination .paper a', 'href')
            assert linked_href.startswith('/package-view/') and linked_href.endswith('/linked.md'), linked_href
            assert page.evaluate('window.__fixtureUnsafe === undefined')
            files_row('linked.md').click()
            files_viewer('linked.md', 'Linked evidence')
            page.reload()
            files_viewer('linked.md', 'Linked evidence')
            page.go_back()
            files_viewer('spec.md', 'Browser specification')
            page.go_forward()
            files_viewer('linked.md', 'Linked evidence')
            report['scenarios'].append('Package links read actual file APIs through packageViewUrl; reload and Back/Forward preserve the package path')

            open_route('files', ws='fixture', source='package', id=package, path='assets/linked-assets.md')
            expect(page.locator('.files-destination .paper')).to_contain_text('Package assets')
            page.wait_for_function("() => document.querySelector('.files-destination .paper img')?.naturalWidth === 1")
            asset_src = page.get_attribute('.files-destination .paper img', 'src')
            hrefs = page.eval_on_selector_all('.files-destination .paper a', 'els => els.map(el => el.getAttribute("href"))')
            assert asset_src.startswith('/package-view/') and asset_src.endswith('/assets/pixel.png'), asset_src
            assert any(href and href.startswith('/package-view/') and href.endswith('/spec.md') for href in hrefs), hrefs
            report['scenarios'].append('Package Markdown relative resources resolve through packageViewUrl with real bytes')

            open_route('files', ws='fixture', source='package', id=package, path='assets/sandbox.html')
            expect(page.locator('.files-destination iframe.html-frame')).to_be_visible()
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Package sandbox')
            sandbox = page.get_attribute('.files-destination iframe.html-frame', 'sandbox')
            frame_src = page.frame_locator('.files-destination iframe.html-frame').locator('base').get_attribute('href')
            assert sandbox == 'allow-scripts' and 'allow-same-origin' not in sandbox, sandbox
            assert '/package-view/' in frame_src and frame_src.endswith('/assets/sandbox.html'), frame_src
            view_response = context.request.get(frame_src)
            view_csp = view_response.headers.get('content-security-policy') or ''
            assert view_response.ok and 'sandbox allow-scripts' in view_csp and 'allow-same-origin' not in view_csp, view_csp
            report['scenarios'].append('Package HTML uses packageViewUrl in a sandboxed frame without allow-same-origin and keeps the server CSP')

            # Fresh document loaded the package sandbox; no workspace memory
            # survives the earlier reload/goto, so the chooser remains
            # unselected and the workspace source opens without a path.
            page.locator('#file-source').select_option('workspace')
            expect(page.locator('#file-source')).to_have_value('workspace')
            expect(page.locator('.files-destination .reader-head h2')).to_have_text('Files')
            assert files_params().get('source') is None, page.url
            assert files_params().get('path') is None, page.url
            expect(page.locator('.files-destination button.file-record', has_text='briefs/browser.md')).to_have_count(1)
            page.locator('#file-source').select_option('package')
            expect(page.locator('#file-source')).to_have_value('package')
            page.locator('#file-owner').select_option(package)
            expect(page.locator('#file-owner')).to_have_value(package)
            assert files_params()['source'] == ['package'] and files_params()['id'] == [package], page.url
            expect(page.locator('.files-destination button.file-record', has_text='spec.md')).to_have_count(1)
            assert page.locator('.files-destination button.file-record', has_text='notes/browser.md').count() == 0
            report['scenarios'].append('Source-qualified selection reloads workspace and package listings through their own file APIs')

            page.set_viewport_size({'width': 1600, 'height': 900})
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            files_layout('files 1600')
            page.screenshot(path=str(evidence / 'files-6-1600.png'))
            open_route('files', ws='fixture', path='files/sandbox.html')
            expect(page.locator('.files-destination iframe.html-frame')).to_be_visible()
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            page.screenshot(path=str(evidence / 'files-18-1600.png'))
            open_route('files', ws='fixture', path='files/capture-bundle.zip')
            expect(page.locator('.files-destination .reader .empty')).to_be_visible()
            page.screenshot(path=str(evidence / 'files-19-1600.png'))
            files_accessibility('files 1600')
            report['scenarios'].append('Files retains adjacent layout, containment and accessibility contract at 1600x900')

        if case == 'files-sources':
            # Real built Files destination over Context/Repository/package HTTP.
            # Only the gated fixture bytes and the owned fixture controls are
            # test-owned; every source read crosses the real server APIs.
            context_bytes = context.request.get(receipt['url'] + '/api/workspace-file?' + urlencode({'id': 'fixture', 'file': 'context/project-context.md'}))
            assert context_bytes.ok and 'Browser context note.' in context_bytes.text()
            open_route('files', ws='fixture')
            open_route('files', ws='fixture', source='context', path='context/project-context.md')
            expect(page.locator('#file-source')).to_have_value('context')
            files_viewer('context/project-context.md', 'Browser context note.')
            expect(page.locator('.files-destination button.file-record')).to_have_count(1)
            expect(page.locator('.files-destination button.file-record')).to_contain_text('context/project-context.md')
            assert page.locator('.files-destination button.file-record', has_text='notes/browser.md').count() == 0
            page.screenshot(path=str(evidence / 'files-15-1280.png'))
            page.reload()
            files_viewer('context/project-context.md', 'Browser context note.')
            page.go_back()
            expect(page.locator('#file-source')).to_have_value('workspace')
            assert files_params().get('source') is None, page.url
            page.go_forward()
            files_viewer('context/project-context.md', 'Browser context note.')
            assert files_params()['source'] == ['context'], page.url
            report['scenarios'].append('Context cold route lists only registered entries, reads workspace-file bytes, and reload/Back/Forward keep row/reader/URL agreement')

            repository_listing = context.request.get(receipt['url'] + '/api/repository-files?' + urlencode({'id': 'fixture', 'repository': 'fixture-repo'})).json()
            assert repository_listing['checkout']['repository'] == 'fixture-repo', repository_listing['checkout']
            repository_branch = repository_listing['checkout']['branch']
            assert isinstance(repository_branch, str) and repository_branch, repository_listing['checkout']
            repository_bytes = context.request.get(receipt['url'] + '/api/repository-file?' + urlencode({'id': 'fixture', 'repository': 'fixture-repo', 'file': 'fixture-repo-plan.md'}))
            assert repository_bytes.ok and 'Checkout-scoped suggestion target.' in repository_bytes.text()
            open_route('files', ws='fixture')
            open_route('files', ws='fixture', source='repository', id='fixture-repo', path='fixture-repo-plan.md')
            expect(page.locator('#file-source')).to_have_value('repository')
            expect(page.locator('#file-owner')).to_have_value('fixture-repo')
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            expect(page.locator('.files-destination .reader-head p')).to_contain_text('fixture-repo')
            expect(page.locator('.files-destination .reader-head p')).to_contain_text(repository_branch)
            expect(page.locator('.files-destination .list-caption')).to_contain_text('fixture-repo')
            expect(page.locator('.files-destination .list-caption')).to_contain_text(repository_branch)
            page.screenshot(path=str(evidence / 'files-16-1280.png'))
            page.reload()
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            page.go_back()
            assert files_params().get('source') is None, page.url
            page.go_forward()
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            assert files_params()['id'] == ['fixture-repo'], page.url
            report['scenarios'].append('Repository cold route reads checkout bytes and shows the live repository/branch identity through reload and Back/Forward')

            owner_options = page.eval_on_selector_all('#file-owner option', 'els => els.map(el => el.value)')
            assert {'fixture-repo', 'fixture-docs'} <= set(owner_options), owner_options
            page.locator('#file-owner').select_option('fixture-docs')
            expect(page.locator('#file-owner')).to_have_value('fixture-docs')
            assert files_params()['id'] == ['fixture-docs'], page.url
            expect(page.locator('.files-destination button.file-record', has_text='fixture-docs-guide.md')).to_have_count(1)
            report['scenarios'].append('Multiple repositories show the explicit owner chooser and switching owners changes the listing identity and URL')

            open_route('files', ws='fixture', source='repository', id='unknown-owner')
            expect(page.get_by_text('Files could not be listed', exact=True)).to_be_visible()
            expect(page.locator('#file-owner')).to_have_value('unknown-owner')
            assert files_params()['id'] == ['unknown-owner'], page.url
            report['scenarios'].append('An explicit unknown repository owner stays unavailable without being retargeted')

            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            open_route('files', ws='fixture', source='repository', id='fixture-repo', path='files/overview.md')
            expect(page.get_by_text('File could not be read', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Fixture overview')
            assert files_params()['source'] == ['repository'] and files_params()['path'] == ['files/overview.md'], page.url
            report['scenarios'].append('The same relative filename in workspace and repository sources reads distinct bytes without aliasing')

            package = receipt['package']
            open_route('files', ws='fixture')
            open_route('files', ws='fixture', source='package', id=package, path='spec.md')
            expect(page.locator('#file-source')).to_have_value('package')
            expect(page.locator('#file-owner')).to_have_value(package)
            files_viewer('spec.md', 'Browser specification')
            page.screenshot(path=str(evidence / 'files-17-1280.png'))
            page.get_by_role('button', name='Open spec', exact=True).click()
            expect(page.locator('h1')).to_have_text('Specs')
            assert params()['ws'] == ['fixture'], page.url
            spec_id = params().get('id')
            assert spec_id, page.url
            page.go_back()
            files_viewer('spec.md', 'Browser specification')
            page.reload()
            files_viewer('spec.md', 'Browser specification')
            page.go_forward()
            expect(page.locator('h1')).to_have_text('Specs')
            assert params()['ws'] == ['fixture'] and params().get('id') == spec_id, page.url
            report['scenarios'].append('Package cold route reads observed files, and Open spec returns by record.key with reload and history agreement')

            open_route('files', source='package', id=package, path='spec.md')
            expect(page.locator('.files-destination')).to_be_visible()
            expect(page.locator('.workspace-picker')).to_have_count(0)
            expect(page.locator('.files-destination .reader-head h2')).to_have_text('spec.md')
            expect(page.locator('.files-destination .reader')).to_contain_text('Browser specification')
            page.locator('#file-source').select_option('workspace')
            expect(page.locator('.workspace-picker')).to_be_visible()
            expect(page.locator('.files-destination')).to_have_count(0)
            report['scenarios'].append('Package-with-id stays reachable without ws, and switching to a workspace source opens the existing picker')

            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'catalog-mode', 'value': 'partial'}))
            # The owned partial kit registers two context entries, one of them
            # outside the workspace root. Poll the live API until the detail
            # read reflects the just-applied control instead of the healthy kit.
            partial_context_count = 2
            partial_deadline = time.monotonic() + 5
            while True:
                workspace_detail = context.request.get(receipt['url'] + '/api/workspace?' + urlencode({'id': 'fixture'})).json()
                unavailable_context = [entry for entry in workspace_detail['context'] if entry['status'] != 'ok']
                if len(workspace_detail['context']) == partial_context_count and unavailable_context:
                    break
                assert time.monotonic() < partial_deadline, workspace_detail['context']
                time.sleep(0.1)
            open_route('files', ws='fixture', source='context')
            expect(page.locator('#file-source')).to_have_value('context')
            expect(page.locator('.files-destination button.file-record')).to_have_count(len(workspace_detail['context']))
            disabled_rows = page.locator('.files-destination button.file-record:disabled')
            expect(disabled_rows).to_have_count(len(unavailable_context))
            for entry in unavailable_context:
                expect(disabled_rows.filter(has_text=entry['status'])).to_have_count(1)
            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'workspace-reset'}))
            # The App may retain the partial workspace detail; poll the live API
            # until the healthy kit is visible, then remount the App so its own
            # workspace-detail fetch is fresh before asserting the reset state.
            reset_deadline = time.monotonic() + 5
            while True:
                reset_context = context.request.get(receipt['url'] + '/api/workspace?' + urlencode({'id': 'fixture'})).json()['context']
                if len(reset_context) == 1 and reset_context[0]['status'] == 'ok' and reset_context[0]['path'] == 'context/project-context.md':
                    break
                assert time.monotonic() < reset_deadline, reset_context
                time.sleep(0.1)
            open_route('files', ws='fixture', source='context', path='context/project-context.md')
            page.reload()
            expect(page.locator('.files-destination button.file-record:disabled')).to_have_count(0)
            expect(page.locator('.files-destination button.file-record')).to_have_count(1)
            files_viewer('context/project-context.md', 'Browser context note.')
            report['scenarios'].append('Partial kit context rows show their real missing/outside status disabled, and workspace-reset restores the registered entry')

            page.set_viewport_size({'width': 1600, 'height': 900})
            open_route('files', ws='fixture', source='context', path='context/project-context.md')
            files_viewer('context/project-context.md', 'Browser context note.')
            page.screenshot(path=str(evidence / 'files-15-1600.png'))
            open_route('files', ws='fixture', source='repository', id='fixture-repo', path='fixture-repo-plan.md')
            expect(page.locator('#file-source')).to_have_value('repository')
            expect(page.locator('#file-owner')).to_have_value('fixture-repo')
            expect(page.locator('#file-owner option:checked')).to_have_text('fixture-repo')
            assert files_params()['source'] == ['repository'] and files_params()['id'] == ['fixture-repo'] and files_params()['path'] == ['fixture-repo-plan.md'], page.url
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            page.screenshot(path=str(evidence / 'files-16-1600.png'))
            open_route('files', ws='fixture', source='package', id=package, path='spec.md')
            expect(page.locator('#file-source')).to_have_value('package')
            expect(page.locator('#file-owner')).to_have_value(package)
            expect(page.locator('#file-owner option:checked')).to_have_text(package)
            assert files_params()['source'] == ['package'] and files_params()['id'] == [package] and files_params()['path'] == ['spec.md'], page.url
            expect(page.locator('.files-destination .reader-head p')).to_contain_text(package)
            files_viewer('spec.md', 'Browser specification')
            page.screenshot(path=str(evidence / 'files-17-1600.png'))
            report['scenarios'].append('Context, Repository and package sources keep row/reader agreement at 1600x900')

        if case == 'files-continuity':
            # Real built Files destination. Every request crosses the real
            # server and APIs; only the final HTTP response is held, failed,
            # corrupted or transformed at the browser boundary. Captures reuse
            # the same held journey states at both widths.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')

            gate = {
                'reads': {'hold': set(), 'fail': set(), 'corrupt': set(), 'transform': {}, 'held': [], 'counts': {}},
                'listings': {'hold': set(), 'held': [], 'append': False},
            }

            def held_http(route):
                split = urlsplit(route.request.url)
                parsed = parse_qs(split.query)
                if split.path == '/api/workspace-file':
                    file = (parsed.get('file') or [''])[0]
                    gate['reads']['counts'][file] = gate['reads']['counts'].get(file, 0) + 1
                    if file in gate['reads']['corrupt']:
                        route.fulfill(status=200, content_type='image/png', headers={'X-Package-File-Kind': 'image'}, body='not an image')
                        return
                    if file in gate['reads']['fail']:
                        route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-file-failure"}')
                        return
                    if file in gate['reads']['transform']:
                        response = route.fetch()
                        payload = response.json()
                        payload.update(gate['reads']['transform'][file])
                        route.fulfill(response=response, json=payload)
                        return
                    if file in gate['reads']['hold']:
                        response = route.fetch()
                        gate['reads']['held'].append((file, route, response))
                        return
                    route.continue_()
                    return
                if split.path in ('/api/workspace-files', '/api/repository-files', '/api/package-files'):
                    name = split.path.rsplit('/', 1)[-1]
                    if gate['listings']['append'] and split.path == '/api/workspace-files':
                        if (parsed.get('cursor') or [''])[0]:
                            route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-append-failure"}')
                            return
                        response = route.fetch()
                        payload = response.json()
                        payload['next_cursor'] = 'fixture-page-2'
                        route.fulfill(response=response, json=payload)
                        return
                    if name in gate['listings']['hold']:
                        response = route.fetch()
                        gate['listings']['held'].append((name, route, response))
                        return
                    route.continue_()
                    return
                route.continue_()

            page.route('**/api/**', held_http)

            def wait_held(container, label):
                deadline = time.monotonic() + 5
                while not container and time.monotonic() < deadline:
                    page.wait_for_timeout(20)
                assert container, label

            def release_reads(*files):
                remaining = []
                for held_file, route, response in gate['reads']['held']:
                    if not files or held_file in files:
                        try:
                            route.fulfill(response=response)
                        except Exception:
                            pass
                    else:
                        remaining.append((held_file, route, response))
                gate['reads']['held'] = remaining

            def fail_reads(*files):
                remaining = []
                for held_file, route, response in gate['reads']['held']:
                    if not files or held_file in files:
                        try:
                            route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-file-failure"}')
                        except Exception:
                            pass
                    else:
                        remaining.append((held_file, route, response))
                gate['reads']['held'] = remaining

            def release_listings(*names):
                remaining = []
                for held_name, route, response in gate['listings']['held']:
                    if not names or held_name in names:
                        try:
                            route.fulfill(response=response)
                        except Exception:
                            pass
                    else:
                        remaining.append((held_name, route, response))
                gate['listings']['held'] = remaining

            def focused_row_name():
                return page.evaluate("""() => {
                    const el = document.activeElement;
                    if (!el || !el.classList || !el.classList.contains('file-record')) return null;
                    const strong = el.querySelector('strong');
                    return strong ? strong.textContent : null;
                }""")

            def refresh_file():
                page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Refresh file$')).first.click()

            def assert_memory_scroll(records_target, reader_target, label):
                deadline = time.monotonic() + 3
                state = {}
                while time.monotonic() < deadline:
                    state = page.evaluate("""() => {
                        const records = document.querySelector('.files-destination .records');
                        const reader = document.querySelector('.files-destination .reader');
                        const selected = document.querySelector('.files-destination button.file-record[aria-pressed="true"] strong');
                        const params = new URLSearchParams(location.hash.split('?')[1] || '');
                        return {
                            records: records ? {scrollTop: records.scrollTop, clientHeight: records.clientHeight, scrollHeight: records.scrollHeight} : null,
                            reader: reader ? {scrollTop: reader.scrollTop, clientHeight: reader.clientHeight, scrollHeight: reader.scrollHeight} : null,
                            selected: selected ? selected.textContent : null,
                            path: params.get('path'),
                        };
                    }""")
                    if (state['records'] or {}).get('scrollTop') == records_target and (state['reader'] or {}).get('scrollTop') == reader_target:
                        return
                    page.wait_for_timeout(50)
                page.screenshot(path=str(evidence / 'files-continuity-memory-failure.png'))
                assert False, (label, state)

            # (1) Slow first read with a controlled clock for the exact 300 ms
            # threshold, capture 62, completion and same-file revalidation.
            gate['reads']['hold'].add('files/data.json')
            # The clock is installed and paused only around the threshold; the
            # held final HTTP response cannot complete on its own.
            page.clock.install()
            page.clock.pause_at(datetime.datetime.now() + datetime.timedelta(seconds=1))
            row = files_row('files/data.json')
            expect(row).to_have_count(1)
            row.focus()
            page.keyboard.press('Enter')
            expect(page.locator('.files-destination .reader').get_by_text('Reading files/data.json').first).to_be_visible(timeout=250)
            files_viewer('files/data.json', 'Reading files/data.json')
            assert focused_row_name() == 'files/data.json', 'selection moved focus out of the file list'
            polite = page.evaluate("""() => {
                const reader = document.querySelector('.files-destination .reader');
                if (!reader || !(reader.textContent || '').includes('Reading files/data.json')) return null;
                const local = reader.getAttribute('aria-live') || (reader.getAttribute('role') === 'status' ? 'polite' : null);
                if (local) return local;
                const announcing = [...reader.querySelectorAll('[role="status"], [aria-live]')].find(node => (node.textContent || '').includes('Reading files/data.json'));
                return announcing ? (announcing.getAttribute('aria-live') || (announcing.getAttribute('role') === 'status' ? 'polite' : null)) : null;
            }""")
            assert polite == 'polite', polite
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            report['scenarios'].append('Keyboard selection keeps the focused row and politely announces Reading files/data.json with Download disabled')

            assert page.locator('.files-destination .reader .skeletons').count() == 0, 'reader skeleton rendered before the 300 ms threshold'
            page.clock.run_for(299)
            assert page.locator('.files-destination .reader .skeletons').count() == 0, 'reader skeleton rendered before 300 ms'
            page.clock.run_for(1)
            expect(page.locator('.files-destination .reader .skeletons')).to_be_visible(timeout=1000)
            assert page.locator('.files-destination .reader .skeletons').count() == 1
            assert page.locator('.files-destination .records .skeletons').count() == 0
            page.clock.resume()
            report['scenarios'].append('A controlled clock shows no skeleton through 299 ms and the reader-only skeleton at 300 ms')
            page.screenshot(path=str(evidence / 'files-62-1280.png'))
            page.set_viewport_size({'width': 1600, 'height': 900})
            page.screenshot(path=str(evidence / 'files-62-1600.png'))
            page.set_viewport_size({'width': 1280, 'height': 860})
            report['scenarios'].append('The slow first read shows a reader-only skeleton after the 300 ms threshold and captures 62 at 1280/1600')

            wait_held(gate['reads']['held'], 'initial read')
            assert gate['reads']['counts'].get('files/data.json') == 1, gate['reads']['counts']
            release_reads('files/data.json')
            files_viewer('files/data.json', '"kind": "continuity"')
            expect(page.locator('.files-destination .reader [role="status"]').filter(has_text='Read files/data.json')).to_have_count(1)
            expect(page.locator('.files-destination .reader .skeletons')).to_have_count(0)
            download_link = page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first
            expect(download_link).to_be_visible()
            assert 'file=files%2Fdata.json' in (download_link.get_attribute('href') or ''), download_link.get_attribute('href')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Reading files/data.json')
            stamp = page.locator('.files-destination').get_by_text(re.compile(r'last (received|checked)', re.I)).first
            expect(stamp).to_be_visible()
            stamp_token = re.search(r'\d{1,2}:\d{2}(?::\d{2})?', stamp.inner_text())
            assert stamp_token, stamp.inner_text()
            page.eval_on_selector('.files-destination .paper pre', "el => { el.dataset.continuityMark = 'retained'; }")
            assert focused_row_name() == 'files/data.json', 'read completion moved the list focus'
            report['scenarios'].append('Releasing the real response renders JSON, enables Download and reports completion without moving the focused row')

            expect(page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Refresh file$')).first).to_be_visible()
            refresh_file()
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            expect(page.locator('.files-destination .paper pre')).to_contain_text('"kind": "continuity"')
            assert page.eval_on_selector('.files-destination .paper pre', 'el => el.dataset.continuityMark') == 'retained', 'recheck remounted the readable node'
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True)).to_have_count(0)
            wait_held(gate['reads']['held'], 'recheck')
            fail_reads('files/data.json')
            expect(page.locator('.files-destination .paper pre')).to_contain_text('"kind": "continuity"')
            assert page.eval_on_selector('.files-destination .paper pre', 'el => el.dataset.continuityMark') == 'retained', 'failed recheck dropped the retained node'
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            expect(page.locator('.files-destination')).to_contain_text(stamp_token.group(0))
            expect(page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Retry file$')).first).to_be_visible()
            report['scenarios'].append('A failed recheck keeps the retained bytes, the unchanged last-received time and Retry file')

            gate['reads']['hold'].discard('files/data.json')
            # The retry crosses the real server and transforms only the final
            # response body, so recovery is proven by fresh content.
            gate['reads']['transform']['files/data.json'] = {'kind': 'refreshed', 'items': [9, 9, 9]}
            page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Retry file$')).first.click()
            files_viewer('files/data.json', '"kind": "refreshed"')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('"kind": "continuity"')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Retry file')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            assert gate['reads']['counts'].get('files/data.json') == 3, gate['reads']['counts']
            gate['reads']['transform'].pop('files/data.json', None)
            report['scenarios'].append('Retry file re-reads fresh transformed real bytes and restores the readable JSON with an enabled Download')

            # (2) Rapid path race: select overview first so the held data.json
            # click actually changes the selection before the newer read.
            files_row('files/overview.md').click()
            files_viewer('files/overview.md', 'Fixture overview')
            gate['reads']['hold'].add('files/data.json')
            files_row('files/data.json').click()
            wait_held(gate['reads']['held'], 'race read')
            files_row('files/overview.md').click()
            files_viewer('files/overview.md', 'Fixture overview')
            release_reads('files/data.json')
            page.wait_for_timeout(150)
            files_viewer('files/overview.md', 'Fixture overview')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('"kind": "continuity"')
            gate['reads']['hold'].discard('files/data.json')
            report['scenarios'].append('Releasing a stale read for a previous path never replaces the newer overview name or bytes')

            # (3) Source transition with a stale held workspace listing and read.
            gate['listings']['hold'].add('workspace-files')
            gate['reads']['hold'].add('files/overview.md')
            page.get_by_role('button', name='Refresh files', exact=True).click()
            # Refresh files revalidates both lifetimes; the head Refresh file
            # is disabled while pending, so wait on the two held responses.
            wait_held(gate['listings']['held'], 'stale listing')
            wait_held(gate['reads']['held'], 'stale read')
            page.evaluate("location.hash = '#/files?ws=fixture&source=repository&id=fixture-repo&path=fixture-repo-plan.md'")
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            expect(page.locator('.files-destination .list-caption')).to_contain_text('fixture-repo')
            release_listings('workspace-files')
            release_reads('files/overview.md')
            page.wait_for_timeout(150)
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Fixture overview')
            assert page.locator('.files-destination button.file-record', has_text='notes/browser.md').count() == 0
            gate['listings']['hold'].discard('workspace-files')
            gate['reads']['hold'].discard('files/overview.md')
            report['scenarios'].append('Stale workspace listing and read released after a source transition never replace repository rows, name or bytes')

            # (3b) A route-addressed repository owner is remembered for the
            # source chooser, so switching away and back needs no manual owner
            # selection and restores the source-qualified path and bytes.
            page.locator('#file-source').select_option('workspace')
            expect(page.locator('#file-source')).to_have_value('workspace')
            files_viewer('files/overview.md', 'Fixture overview')
            page.locator('#file-source').select_option('repository')
            expect(page.locator('#file-source')).to_have_value('repository')
            expect(page.locator('#file-owner')).to_have_value('fixture-repo')
            assert files_params()['id'] == ['fixture-repo'], page.url
            assert files_params().get('path') == ['fixture-repo-plan.md'], page.url
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            report['scenarios'].append('A route-addressed repository owner is remembered so the source chooser restores its path and bytes without a manual owner selection')

            # (4) Independent lifetimes: the current-path read publishes before
            # its held listing, and the later listing publish keeps the read.
            gate['listings']['hold'].add('repository-files')
            page.evaluate("location.hash = '#/files?ws=fixture'")
            expect(page.locator('.files-destination .reader')).to_contain_text('Select a file')
            page.evaluate("location.hash = '#/files?ws=fixture&source=repository&id=fixture-docs&path=fixture-docs-guide.md'")
            wait_held(gate['listings']['held'], 'held listing')
            # The listing is intentionally held, so assert the read identity
            # directly instead of the row-dependent files_viewer helper.
            expect(page.locator('.files-destination .reader-head h2')).to_have_text('fixture-docs-guide.md')
            expect(page.locator('.files-destination .reader')).to_contain_text('Second-repository suggestion target.')
            assert files_params().get('path') == ['fixture-docs-guide.md'], page.url
            assert page.locator('.files-destination button.file-record', has_text='fixture-docs-guide.md').count() == 0
            release_listings('repository-files')
            expect(page.locator('.files-destination button.file-record', has_text='fixture-docs-guide.md').first).to_be_visible()
            files_viewer('fixture-docs-guide.md', 'Second-repository suggestion target.')
            gate['listings']['hold'].discard('repository-files')
            report['scenarios'].append('A current-path read publishes before its held listing, and the later listing publish does not cancel the read')

            # (5) Offline retained text with capture 66 and Retry connection.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'true'}))
            page.get_by_role('button', name='Refresh state', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('Reading a retained copy')
            expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry connection', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .paper')).to_contain_text('Fixture overview')
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            page.screenshot(path=str(evidence / 'files-66-1280.png'))
            page.set_viewport_size({'width': 1600, 'height': 900})
            page.screenshot(path=str(evidence / 'files-66-1600.png'))
            page.set_viewport_size({'width': 1280, 'height': 860})
            report['scenarios'].append('A failed /api/state keeps the loaded overview readable and disables Download behind Retry connection and captures 66 at 1280/1600')

            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'false'}))
            page.locator('.files-destination .reader').get_by_role('button', name='Retry connection', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Reading a retained copy')
            expect(page.locator('.files-destination .paper')).to_contain_text('Fixture overview')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            report['scenarios'].append('Retry connection clears the offline warning and re-enables Download over the retained overview')

            # (6) Rechecking overview with capture 67.
            gate['reads']['hold'].add('files/overview.md')
            refresh_file()
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            expect(page.locator('.files-destination .paper')).to_contain_text('Fixture overview')
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            page.screenshot(path=str(evidence / 'files-67-1280.png'))
            page.set_viewport_size({'width': 1600, 'height': 900})
            page.screenshot(path=str(evidence / 'files-67-1600.png'))
            page.set_viewport_size({'width': 1280, 'height': 860})
            wait_held(gate['reads']['held'], 'overview recheck')
            release_reads('files/overview.md')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            gate['reads']['hold'].discard('files/overview.md')
            report['scenarios'].append('Rechecking overview retains readable content with Download disabled and captures 67 at 1280/1600')

            # (7) Sandboxed HTML node identity through offline + failed recheck.
            open_route('files', ws='fixture', path='files/sandbox.html')
            expect(page.locator('.files-destination iframe.html-frame')).to_be_visible()
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            expect(page.locator('.files-destination .section-note')).to_contain_text('Only document load is observed; sandbox subresources are not verified.')
            frame_src = page.evaluate("""() => {
                const el = document.querySelector('.files-destination iframe.html-frame');
                window.__continuityFrame = el;
                return el.getAttribute('srcdoc');
            }""")
            assert frame_src and '/api/workspace-file' in frame_src, frame_src
            # A manual Refresh state increments refreshKey before the state
            # result, so it supersedes the held read. Switch the path to fail
            # so every newly issued recheck returns 503, then drain the prior
            # held request; a canceled older hold can otherwise leave the
            # newer recheck pending and the reader stuck on Rechecking.
            gate['reads']['hold'].add('files/sandbox.html')
            refresh_file()
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            wait_held(gate['reads']['held'], 'held sandbox recheck')
            gate['reads']['hold'].discard('files/sandbox.html')
            gate['reads']['fail'].add('files/sandbox.html')
            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'true'}))
            page.get_by_role('button', name='Refresh state', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('Reading a retained copy')
            fail_reads('files/sandbox.html')
            expect(page.locator('.files-destination .reader')).to_contain_text('File could not be rechecked')
            assert page.evaluate("() => window.__continuityFrame === document.querySelector('.files-destination iframe.html-frame')") is True, 'offline recheck replaced the iframe node'
            assert page.evaluate("() => document.querySelector('.files-destination iframe.html-frame').getAttribute('srcdoc')") == frame_src, 'offline recheck changed the iframe document'
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            report['scenarios'].append('Offline and failed sandbox recheck keep the exact mounted iframe node and src with readable content')

            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'false'}))
            page.locator('.files-destination .reader').get_by_role('button', name='Retry connection', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Reading a retained copy')
            gate['reads']['fail'].discard('files/sandbox.html')
            page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Retry file$')).first.click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Retry file')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            assert page.evaluate("() => window.__continuityFrame === document.querySelector('.files-destination iframe.html-frame')") is True, 'successful recheck replaced the iframe node'
            assert page.evaluate("() => document.querySelector('.files-destination iframe.html-frame').getAttribute('srcdoc')") == frame_src, 'successful recheck changed the iframe document'
            report['scenarios'].append('Successful sandbox recheck enables Download without replacing the mounted iframe node or src')

            # (8) Corrupt image bytes surface the regional display error and
            # Retry file reloads the real bytes into a decoded image.
            gate['reads']['corrupt'].add('files/pixel.png')
            open_route('files', ws='fixture', path='files/pixel.png')
            expect(page.locator('.files-destination .reader')).to_contain_text('File could not be displayed')
            report['scenarios'].append('A corrupt image response surfaces a readable regional display error')
            page.get_by_role('button', name='Refresh files', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            expect(page.locator('.files-destination .reader')).to_contain_text('File could not be displayed')
            page.get_by_role('button', name='Refresh state', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            expect(page.locator('.files-destination .reader')).to_contain_text('File could not be displayed')
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            expect(page.locator('.files-destination').get_by_role('button', name='Retry file', exact=True).first).to_be_visible()
            report['scenarios'].append('Refresh files and App refreshKey preserve the corrupt-image error and Retry file with Download disabled')
            gate['reads']['corrupt'].discard('files/pixel.png')
            page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Retry file$')).first.click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('File could not be displayed')
            expect(page.locator('.files-destination img.image-preview')).to_be_visible()
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth > 0")
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            report['scenarios'].append('Retry file after a corrupt image decodes real bytes and enables Download')

            # A successful preliminary package-file read cannot certify the
            # distinct package-view main document. HTTP error bytes must not
            # reach the frame or enable Download.
            def failed_document(route):
                route.fulfill(status=503, content_type='text/html', body='<h1>Failed main document</h1>')

            page.route('**/package-view/**', failed_document)
            with page.expect_response(lambda response: '/api/package-file?' in response.url) as preliminary:
                open_route('files', ws='fixture', source='package', id=receipt['package'], path='assets/sandbox.html')
            assert preliminary.value.ok, 'preliminary package-file read must succeed'
            expect(page.locator('.files-destination .reader')).to_contain_text('File could not be read')
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            expect(page.locator('.files-destination').get_by_role('button', name='Retry file', exact=True).first).to_be_visible()
            expect(page.locator('.files-destination iframe')).to_have_count(0)
            page.unroute('**/package-view/**', failed_document)
            page.get_by_role('button', name='Retry file', exact=True).first.click()
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Package sandbox')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            expect(page.locator('.files-destination iframe')).to_have_attribute('sandbox', 'allow-scripts')
            policy = page.frame_locator('.files-destination iframe').locator('meta[http-equiv="Content-Security-Policy"]').get_attribute('content')
            assert "connect-src 'none'" in policy and "form-action 'none'" in policy and 'allow-same-origin' not in policy, policy
            isolation = page.frame_locator('.files-destination iframe').locator('h1').evaluate("""async () => {
                let parentBlocked = false, networkBlocked = false;
                try { void parent.document.body; } catch { parentBlocked = true; }
                try { await fetch(new URL('/api/state', document.baseURI)); } catch { networkBlocked = true; }
                return { parentBlocked, networkBlocked };
            }""")
            assert isolation == {'parentBlocked': True, 'networkBlocked': True}, isolation
            report['scenarios'].append('Successful preliminary read followed by failed main-document GET keeps Download disabled and offers localized Retry; recovery displays validated package HTML under the unchanged sandbox/CSP')

            # Scale only the browser's native deadline at the final boundary,
            # recording the production 30s budget rather than waiting 30s.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            gate['listings']['hold'].add('workspace-files')
            page.evaluate("""() => {
                window.__nativeFileTimeout = AbortSignal.timeout;
                window.__fileTimeoutBudgets = [];
                AbortSignal.timeout = milliseconds => {
                    window.__fileTimeoutBudgets.push(milliseconds);
                    return window.__nativeFileTimeout.call(AbortSignal, 100);
                };
            }""")
            try:
                page.get_by_role('button', name='Refresh files', exact=True).click()
                wait_held(gate['listings']['held'], 'stalled listing')
                expect(page.locator('.files-destination .list-pane')).to_contain_text('Workspace files unavailable. Refresh to retry.')
                expect(page.get_by_role('button', name='Refresh files', exact=True).last).to_be_enabled()
                expect(page.locator('.files-destination .paper')).to_contain_text('Fixture overview')
                assert 30000 in page.evaluate('() => window.__fileTimeoutBudgets'), 'listing lost its bounded deadline'
            finally:
                page.evaluate('() => { AbortSignal.timeout = window.__nativeFileTimeout; }')
                gate['listings']['hold'].discard('workspace-files')
                for _, route, response in gate['listings']['held']:
                    try:
                        route.fulfill(response=response)
                    except Exception:
                        pass
                gate['listings']['held'] = []
            page.get_by_role('button', name='Refresh files', exact=True).last.click()
            expect(page.locator('.files-destination .list-pane')).not_to_contain_text('Workspace files unavailable')
            expect(files_row('files/overview.md')).to_be_visible()
            report['scenarios'].append('A stalled listing uses the 30000ms deadline (native timeout scaled to 100ms), reaches localized recovery, retains rows/reader, and Refresh files successfully retries')

            # (9) Image node identity through offline + failed recheck.
            open_route('files', ws='fixture', path='files/overview.md')
            open_route('files', ws='fixture', path='files/pixel.png')
            expect(page.locator('.files-destination img.image-preview')).to_be_visible()
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            image_src = page.evaluate("""() => {
                const el = document.querySelector('.files-destination img.image-preview');
                window.__continuityImage = el;
                return el.getAttribute('src');
            }""")
            assert image_src and 'file=files%2Fpixel.png' in image_src, image_src
            # Same manual-refresh generation switch as the sandbox case: fail
            # every newly issued recheck, then drain the prior held request.
            gate['reads']['hold'].add('files/pixel.png')
            refresh_file()
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            wait_held(gate['reads']['held'], 'held image recheck')
            gate['reads']['hold'].discard('files/pixel.png')
            gate['reads']['fail'].add('files/pixel.png')
            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'true'}))
            page.get_by_role('button', name='Refresh state', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('Reading a retained copy')
            fail_reads('files/pixel.png')
            expect(page.locator('.files-destination .reader')).to_contain_text('File could not be rechecked')
            assert page.evaluate("() => window.__continuityImage === document.querySelector('.files-destination img.image-preview')") is True, 'offline recheck replaced the image node'
            assert page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')") == image_src, 'offline recheck changed the image src'
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            expect(page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first).to_be_disabled()
            report['scenarios'].append('Offline and failed image recheck keep the exact mounted image node and src with readable bytes')

            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'false'}))
            page.locator('.files-destination .reader').get_by_role('button', name='Retry connection', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Reading a retained copy')
            gate['reads']['fail'].discard('files/pixel.png')
            page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Retry file$')).first.click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Retry file')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            assert page.evaluate("() => window.__continuityImage === document.querySelector('.files-destination img.image-preview')") is True, 'successful recheck replaced the image node'
            assert page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')") == image_src, 'successful recheck changed the image src'
            report['scenarios'].append('Successful image recheck enables Download without replacing the mounted image node or src')

            # (10) Source switch and history restore path and exact scroll.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            files_row('files/overview.md').click()
            files_viewer('files/overview.md', 'Fixture overview')
            page.eval_on_selector('.files-destination .records', "el => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')); }")
            page.eval_on_selector('.files-destination .reader', "el => { el.scrollTop = 180; el.dispatchEvent(new Event('scroll')); }")
            assert page.eval_on_selector('.files-destination .records', 'el => el.scrollTop') == 120
            assert page.eval_on_selector('.files-destination .reader', 'el => el.scrollTop') == 180
            page.locator('#file-source').select_option('repository')
            expect(page.locator('#file-source')).to_have_value('repository')
            page.locator('#file-owner').select_option('fixture-repo')
            expect(page.locator('#file-owner')).to_have_value('fixture-repo')
            files_viewer('fixture-repo-plan.md', 'Checkout-scoped suggestion target.')
            page.locator('#file-source').select_option('workspace')
            files_viewer('files/overview.md', 'Fixture overview')
            assert_memory_scroll(120, 180, 'source-chooser return')
            report['scenarios'].append('Switching sources back to workspace restores the remembered overview path with exact list and reader scroll')

            page.locator('[data-area="specs"]').click()
            expect(page.locator('h1')).to_have_text('Specs')
            page.go_back()
            files_viewer('files/overview.md', 'Fixture overview')
            assert_memory_scroll(120, 180, 'history return')
            report['scenarios'].append('Rail departure and history Back to the path-bearing Files route restore the overview and exact scroll')

            open_route('files', ws='fixture', path='files/overview.md')
            open_route('files', ws='fixture', path='files/valid.json')
            files_viewer('files/valid.json', '"schema_version": 1')
            page.go_back()
            files_viewer('files/overview.md', 'Fixture overview')
            page.go_forward()
            files_viewer('files/valid.json', '"schema_version": 1')
            report['scenarios'].append('History Back/Forward selects the supplied route path instead of the newest remembered path')

            open_route('files', ws='fixture')
            expect(page.locator('.files-destination .reader-head h2')).to_have_text('Files')
            expect(page.locator('.files-destination .reader')).to_contain_text('Select a file')
            assert files_params().get('path') is None, page.url
            report['scenarios'].append('An explicit route with no path clears selection instead of restoring remembered state')

            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            observed = []

            def observe_file_request(request):
                if '/api/workspace-file' in request.url or '/api/workspace-files' in request.url:
                    observed.append(request.url)

            page.on('request', observe_file_request)
            page.locator('#find-record').fill('OVERVIEW')
            expect(page.locator('.files-destination button.file-record').filter(has_text='files/overview.md')).to_have_count(1)
            page.locator('#find-record').fill('no-match')
            expect(page.locator('.files-destination button.file-record')).to_have_count(0)
            page.locator('#find-record').fill('')
            page.wait_for_timeout(150)
            page.remove_listener('request', observe_file_request)
            assert observed == [], observed
            files_viewer('files/overview.md', 'Fixture overview')
            report['scenarios'].append('Filter edits never refetch the listing or read and retain the selected path')

            # (11) Failed cursor append keeps prior rows and reader.
            gate['listings']['append'] = True
            page.get_by_role('button', name='Refresh files', exact=True).click()
            expect(page.get_by_role('button', name='Load more files', exact=True)).to_be_visible()
            rows_before = page.locator('.files-destination button.file-record').count()
            assert rows_before > 0, rows_before
            page.get_by_role('button', name='Load more files', exact=True).click()
            expect(page.get_by_text('Files could not be listed', exact=True)).to_be_visible()
            assert page.locator('.files-destination button.file-record').count() == rows_before
            files_viewer('files/overview.md', 'Fixture overview')
            gate['listings']['append'] = False
            report['scenarios'].append('A failed cursor append keeps the prior listing rows and the loaded reader with only the regional list error')

            # (12) Bound reference screens: verify card sha256 before render.
            design_root = reference_screens('app-ui')
            assert design_root is not None, 'Bound app-ui design screens were not found'
            references = {}
            reference_page = context.new_page()
            try:
                for screen, filename, digest in [
                    ('62', '62-files-loading.html', 'dc62acfc3d8ff825d59c3a579619f291b8c806774bd4827c8225a4ea11df3119'),
                    ('66', '66-files-offline.html', 'a7849160af81783ca0b9f00b62e2283e852170eded9294d58356f6add42124a5'),
                    ('67', '67-files-stale.html', '1b50989bdaf92f838cd22821d4f4654d5f8a8b1594324cdd85d18ee6524e6a01'),
                ]:
                    asset = design_root / filename
                    assert asset.is_file(), asset
                    actual = hashlib.sha256(asset.read_bytes()).hexdigest()
                    references[screen] = {'file': str(asset), 'sha256': actual, 'bound': digest}
                    assert actual == digest, (screen, actual, digest)
                    for width, height in [(1280, 860), (1600, 900)]:
                        reference_page.set_viewport_size({'width': width, 'height': height})
                        reference_page.goto(asset.as_uri(), wait_until='load')
                        reference_page.wait_for_timeout(150)
                        reference_page.screenshot(path=str(evidence / f'reference-{screen}-{width}.png'))
            finally:
                reference_page.close()
            report['references'] = references
            report['scenarios'].append('Bound reference screens 62/66/67 match their card sha256 digests and render at 1280/1600')

        if case == 'files-recovery':
            # Real built Files destination and real file APIs; only final HTTP
            # responses are controlled at the browser boundary, plus the exact
            # workspace detail needed for the zero-owner/context labels and the
            # real Shell snapshot import for the no-live transition. Recovery
            # state and page.route register before the first Files navigation so
            # the first workspace listing already crosses the controlled seam.
            healthy_detail = context.request.get(receipt['url'] + '/api/workspace?' + urlencode({'id': 'fixture'})).json()

            recovery = {
                'listing': {'mode': '', 'append': False, 'first_page': []},
                'detail': None,
                'reads': {'fail': set(), 'hold': set(), 'held': [], 'counts': {}, 'corrupt': set()},
                'requests': [],
            }
            file_endpoints = (
                '/api/workspace-files', '/api/workspace-file',
                '/api/package-files', '/api/package-file',
                '/api/repository-files', '/api/repository-file',
            )

            def recovery_http(route):
                split = urlsplit(route.request.url)
                parsed = parse_qs(split.query)
                path = split.path
                if path in file_endpoints:
                    recovery['requests'].append(path)
                if path == '/api/workspace':
                    if recovery['detail'] is not None:
                        route.fulfill(json=recovery['detail'])
                        return
                    route.continue_()
                    return
                if path == '/api/workspace-files':
                    cursor = (parsed.get('cursor') or [''])[0]
                    if cursor and recovery['listing']['append']:
                        duplicate = (recovery['listing']['first_page'] or [{'name': 'files/overview.md', 'available': True, 'size': 12}])[0]
                        route.fulfill(json={'files': [duplicate, {'name': 'files/recovery-appended.md', 'available': True, 'size': 24}], 'next_cursor': None, 'truncated': False, 'errors': []})
                        return
                    mode = recovery['listing']['mode']
                    if mode == 'fail':
                        route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-recovery-listing-failure"}')
                        return
                    if mode in ('empty', 'partial', 'unavailable', 'hold', 'omit-valid', 'refuse-overview', 'refuse-media'):
                        response = route.fetch()
                        if mode == 'hold':
                            recovery['reads']['held'].append(('listing', route, response))
                            return
                        payload = response.json()
                        if mode == 'omit-valid':
                            payload['files'] = [entry for entry in payload.get('files', []) if entry.get('name') != 'files/valid.json']
                            payload['truncated'] = False
                            payload['errors'] = []
                            payload['next_cursor'] = None
                        elif mode == 'refuse-overview':
                            refused = []
                            for entry in payload.get('files', []):
                                if entry.get('name') == 'files/overview.md':
                                    refused.append({**entry, 'available': False, 'reason': 'Exceeds 8 MiB'})
                                else:
                                    refused.append(entry)
                            payload['files'] = refused
                            payload['truncated'] = False
                            payload['errors'] = []
                            payload['next_cursor'] = None
                        elif mode == 'refuse-media':
                            refused = []
                            for entry in payload.get('files', []):
                                if entry.get('name') in ('files/pixel.png', 'files/sandbox.html'):
                                    refused.append({**entry, 'available': False, 'reason': 'Exceeds 8 MiB'})
                                else:
                                    refused.append(entry)
                            payload['files'] = refused
                            payload['truncated'] = False
                            payload['errors'] = []
                            payload['next_cursor'] = None
                        elif mode == 'empty':
                            payload['files'] = []
                            payload['truncated'] = False
                            payload['errors'] = []
                            payload['next_cursor'] = None
                        elif mode == 'partial':
                            payload['files'] = payload['files'][:2]
                            recovery['listing']['first_page'] = payload['files']
                            payload['truncated'] = True
                            payload['errors'] = [{'name': 'docs', 'message': 'Unreadable directory'}]
                            payload['next_cursor'] = 2
                        else:
                            payload['files'] = payload['files'] + [{'name': 'files/refused.bin', 'available': False, 'reason': 'Exceeds 8 MiB'}]
                        route.fulfill(response=response, json=payload)
                        return
                    route.continue_()
                    return
                if path == '/api/workspace-file':
                    file = (parsed.get('file') or [''])[0]
                    recovery['reads']['counts'][file] = recovery['reads']['counts'].get(file, 0) + 1
                    if file in recovery['reads']['corrupt']:
                        route.fulfill(status=200, content_type='image/png', headers={'X-Package-File-Kind': 'image'}, body='not an image')
                        return
                    if file in recovery['reads']['fail']:
                        route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-recovery-read-failure"}')
                        return
                    if file in recovery['reads']['hold']:
                        response = route.fetch()
                        recovery['reads']['held'].append((file, route, response))
                        return
                    route.continue_()
                    return
                route.continue_()

            page.route('**/api/**', recovery_http)

            def release_recovery():
                for _, route, response in recovery['reads']['held']:
                    try:
                        route.fulfill(response=response)
                    except Exception:
                        pass
                recovery['reads']['held'] = []

            def wait_recovery_held(count):
                deadline = time.monotonic() + 5
                while len(recovery['reads']['held']) < count and time.monotonic() < deadline:
                    page.wait_for_timeout(20)
                assert len(recovery['reads']['held']) >= count, 'recovery held requests did not arrive'

            def recovery_capture(screen):
                page.set_viewport_size({'width': 1280, 'height': 860})
                page.screenshot(path=str(evidence / f'files-{screen}-1280.png'))
                page.set_viewport_size({'width': 1600, 'height': 900})
                page.screenshot(path=str(evidence / f'files-{screen}-1600.png'))
                page.set_viewport_size({'width': 1280, 'height': 860})

            # (1) Complete empty source, precise chooser labels and release.
            recovery['listing']['mode'] = 'empty'
            open_route('files', ws='fixture')
            empty_records = page.locator('.files-destination .records .empty')
            expect(empty_records.get_by_role('heading', name='No files in this source', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .list-caption')).to_contain_text('0 loaded filenames')
            recovery_capture('61')
            empty_records.get_by_role('button', name='Choose source', exact=True).click()
            focused_id = page.evaluate("() => document.activeElement ? document.activeElement.id : ''")
            assert focused_id == 'file-source', focused_id
            report['scenarios'].append('A complete empty source shows No files in this source/Choose source and focuses #file-source at 1280/1600')

            # The App workspace-detail effect is keyed by workspace id, so a
            # source-only route change retains the earlier detail; reload after
            # each override to force the controlled detail through a fresh
            # App mount.
            recovery['detail'] = {**healthy_detail, 'context': []}
            open_route('files', ws='fixture', source='context')
            page.reload()
            expect(page.locator('.files-destination .records .empty').get_by_role('heading', name='No registered context', exact=True)).to_be_visible()
            recovery['detail'] = {**healthy_detail, 'repositories': []}
            open_route('files', ws='fixture', source='repository')
            page.reload()
            expect(page.locator('.files-destination .records .empty').get_by_role('heading', name='No repositories registered', exact=True)).to_be_visible()
            recovery['detail'] = None
            report['scenarios'].append('Zero registered context and zero repositories keep their precise regional labels')

            recovery['listing']['mode'] = ''
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            expect(page.locator('.files-destination button.file-record', has_text='files/overview.md')).to_have_count(1)
            expect(page.locator('.files-destination .records .empty')).to_have_count(0)
            report['scenarios'].append('Releasing the controlled listing restores the real healthy workspace listing and selected bytes')

            # (2) List failure stays local; read failure stays local; an
            # anonymous 503 is an error and a complete unavailable entry is a
            # known refusal.
            open_route('files', ws='fixture', q='overview', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            assert page.locator('.files-destination button.file-record').count() == 1
            recovery['listing']['mode'] = 'fail'
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            list_error = page.locator('.files-destination .records .ds-callout.error')
            expect(list_error).to_contain_text('Files could not be listed')
            refresh_listing = list_error.get_by_role('button', name='Refresh files', exact=True)
            expect(refresh_listing).to_be_visible()
            assert page.locator('.files-destination button.file-record').count() == 1
            files_viewer('files/overview.md', 'Fixture overview')
            assert files_params()['q'] == ['overview'] and files_params()['path'] == ['files/overview.md'], page.url
            recovery['listing']['mode'] = ''
            refresh_listing.click()
            expect(page.locator('.files-destination .records .ds-callout.error')).to_have_count(0)
            files_viewer('files/overview.md', 'Fixture overview')
            report['scenarios'].append('A failed workspace listing keeps published rows and path/q locally, then recovers through Refresh files')

            recovery['reads']['fail'].add('files/valid.json')
            open_route('files', ws='fixture', q='valid', path='files/valid.json')
            read_error = page.locator('.files-destination .reader .ds-callout.error')
            expect(read_error).to_contain_text('File could not be read')
            retry_file = read_error.get_by_role('button', name='Retry file', exact=True)
            expect(retry_file).to_be_visible()
            expect(page.locator('.files-destination .reader .empty')).to_have_count(0)
            assert files_params()['q'] == ['valid'] and files_params()['path'] == ['files/valid.json'], page.url
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            assert page.locator('.files-destination .reader-head a[download]').count() == 0
            recovery_capture('63')
            recovery['reads']['fail'].discard('files/valid.json')
            retry_file.click()
            files_viewer('files/valid.json', '"schema_version": 1')
            expect(page.locator('.files-destination .reader .ds-callout.error')).to_have_count(0)
            report['scenarios'].append('An anonymous 503 read is a local Retry file error that keeps path/q, disables Download and recovers over real bytes')

            recovery['listing']['mode'] = 'unavailable'
            open_route('files', ws='fixture')
            # The route is already in the workspace scope, so clearing q/path
            # does not refetch the listing; force the controlled mode through
            # the existing Refresh files control before asserting the entry.
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(page.locator('.files-destination button.file-record', has_text='files/refused.bin')).to_have_count(1)
            refused_before = recovery['reads']['counts'].get('files/refused.bin', 0)
            page.evaluate("location.hash = '#/files?" + urlencode({'ws': 'fixture', 'path': 'files/refused.bin'}) + "'")
            unavailable_empty = page.locator('.files-destination .reader .empty')
            expect(unavailable_empty.get_by_role('heading', name='File unavailable', exact=True)).to_be_visible()
            expect(unavailable_empty).to_contain_text('files/refused.bin')
            expect(unavailable_empty).to_contain_text('8 MiB')
            choose_file = unavailable_empty.get_by_role('button', name='Choose file', exact=True)
            expect(choose_file).to_be_visible()
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            assert recovery['reads']['counts'].get('files/refused.bin', 0) == refused_before, recovery['reads']['counts']
            recovery_capture('65')
            choose_file.click()
            focused_row = page.evaluate("""() => ({ cls: String(document.activeElement.className), name: document.activeElement.querySelector('strong') ? document.activeElement.querySelector('strong').textContent : '' })""")
            assert 'file-record' in focused_row['cls'], focused_row
            report['scenarios'].append('A complete listing entry marked unavailable shows name/8 MiB/Choose file without a read request, disables Download and focuses the list at 1280/1600')
            recovery['listing']['mode'] = ''
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')

            # (3) Partial coverage, distinct append and incomplete-missing path.
            recovery['listing']['mode'] = 'partial'
            recovery['listing']['append'] = True
            open_route('files', ws='fixture')
            # Same-scope route change retains the previous listing; refresh so
            # the partial coverage payload is actually fetched.
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            partial_notice = page.locator('.files-destination .records .ds-callout.warning')
            expect(partial_notice).to_contain_text('Listing incomplete')
            expect(partial_notice).to_contain_text('2 entries loaded')
            expect(page.locator('.files-destination .records')).to_contain_text('docs: Unreadable directory')
            expect(page.locator('.files-destination .list-caption')).to_contain_text('more available')
            rows = page.locator('.files-destination button.file-record')
            expect(rows).to_have_count(2)
            first_name = rows.first.locator('strong').inner_text()
            rows.first.click()
            expect(page.locator('.files-destination .reader-head h2')).to_have_text(first_name)
            recovery_capture('64')
            page.get_by_role('button', name='Load more files', exact=True).click()
            expect(rows).to_have_count(3)
            expect(page.locator('.files-destination button.file-record', has_text='files/recovery-appended.md')).to_have_count(1)
            assert page.locator('.files-destination button.file-record').filter(has=page.get_by_text(first_name, exact=True)).count() == 1
            expect(page.locator('.files-destination .reader-head h2')).to_have_text(first_name)
            expect(rows.filter(has_text=first_name)).to_have_attribute('aria-pressed', 'true')
            # Coverage stays honestly incomplete after the append: the first
            # page's truncation/errors survive the merge, so the notice and
            # errors list persist beside the selected reader.
            retained_warning = page.locator('.files-destination .records .ds-callout.warning')
            expect(retained_warning).to_have_count(1)
            expect(retained_warning).to_contain_text('Listing incomplete')
            expect(page.locator('.files-destination .records')).to_contain_text('docs: Unreadable directory')
            report['scenarios'].append('A partial listing discloses loaded-only coverage; Load more appends distinct names and keeps the selected reader at 1280/1600')

            page.evaluate("location.hash = '#/files?" + urlencode({'ws': 'fixture', 'path': 'files/missing-recovery.md'}) + "'")
            missing_error = page.locator('.files-destination .reader .ds-callout.error')
            expect(missing_error).to_contain_text('File could not be read')
            expect(missing_error.get_by_role('button', name='Retry file', exact=True)).to_be_visible()
            # Scope the known-refusal guard to the EmptyState instead of the
            # whole reader: the generic retry copy legitimately contains the
            # substring 'File unavailable', so only empty-state headings prove
            # the path did not become a known-missing refusal.
            reader_empty = page.locator('.files-destination .reader .empty')
            expect(reader_empty).to_have_count(0)
            expect(reader_empty.get_by_role('heading', name='Not found', exact=True)).to_have_count(0)
            expect(reader_empty.get_by_role('heading', name='File unavailable', exact=True)).to_have_count(0)
            report['scenarios'].append('A missing path under an incomplete listing stays a Retry file error instead of a known-missing refusal')

            recovery['listing']['mode'] = ''
            recovery['listing']['append'] = False
            open_route('files', ws='fixture', path='files/overview.md')
            # Releasing the partial mode is the same-scope switch again; refresh
            # so the real full listing (including the selected overview) returns
            # before the no-match scenarios.
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            files_viewer('files/overview.md', 'Fixture overview')

            # (4) Filename/prefix no-match keeps route memory and hides the
            # filtered document behind the recovery prompt.
            open_route('files', ws='fixture', q='nothing-found', path='files/overview.md')
            no_match = page.locator('.files-destination .records .empty')
            expect(no_match.get_by_role('heading', name='No matching filenames', exact=True)).to_be_visible()
            clear_filters = no_match.get_by_role('button', name='Clear filters', exact=True)
            assert files_params()['q'] == ['nothing-found'] and files_params()['path'] == ['files/overview.md'], page.url
            reader_empty = page.locator('.files-destination .reader .empty')
            expect(reader_empty).to_be_visible()
            expect(page.locator('.files-destination .reader .paper')).to_have_count(0)
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Fixture overview')
            prompt = reader_empty.inner_text()
            assert re.search(r'choose a file|select a file|clear filters', prompt, re.I), prompt
            recovery_capture('68')
            clear_filters.click()
            expect(page.locator('#find-record')).to_have_value('')
            assert 'q' not in files_params() and files_params()['path'] == ['files/overview.md'], page.url
            files_viewer('files/overview.md', 'Fixture overview')
            report['scenarios'].append('A filtered-out explicit file is hidden behind the no-match prompt; Clear filters restores it while keeping the route path')

            open_route('files', ws='fixture', path='no-such-directory/')
            prefix_no_match = page.locator('.files-destination .records .empty')
            expect(prefix_no_match.get_by_role('heading', name='No matching filenames', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .reader .empty')).to_be_visible()
            expect(page.locator('.files-destination .reader .paper')).to_have_count(0)
            assert files_params()['path'] == ['no-such-directory/'], page.url
            prefix_no_match.get_by_role('button', name='Clear filters', exact=True).click()
            assert 'path' not in files_params() and 'q' not in files_params(), page.url
            expect(page.locator('.files-destination .reader')).to_contain_text('Select a file')
            report['scenarios'].append('A trailing-slash prefix no-match clears q and prefix while the reader returns to the chooser')

            # F1: a failed refresh over a retained complete listing must not
            # prove absence for a newly readable path missing from it.
            recovery['listing']['mode'] = 'omit-valid'
            open_route('files', ws='fixture', path='files/overview.md')
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(files_row('files/overview.md')).to_be_visible()
            expect(page.locator('.files-destination button.file-record', has_text='files/valid.json')).to_have_count(0)
            files_viewer('files/overview.md', 'Fixture overview')
            valid_before = recovery['reads']['counts'].get('files/valid.json', 0)
            recovery['listing']['mode'] = 'fail'
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(page.locator('.files-destination .records')).to_contain_text('Files could not be listed')
            files_viewer('files/overview.md', 'Fixture overview')
            page.evaluate("location.hash = '#/files?" + urlencode({'ws': 'fixture', 'path': 'files/valid.json'}) + "'")
            expect(page.locator('.files-destination .reader-head h2')).to_have_text('files/valid.json')
            expect(page.locator('.files-destination .reader')).to_contain_text('"schema_version": 1')
            assert files_params().get('path') == ['files/valid.json'], page.url
            assert recovery['reads']['counts'].get('files/valid.json', 0) > valid_before, recovery['reads']['counts']
            expect(page.locator('.files-destination .reader').get_by_role('heading', name='Not found', exact=True)).to_have_count(0)
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Refresh file', exact=True)).to_be_enabled()
            report['scenarios'].append('A failed refresh over a retained complete listing leaves a newly readable unseen path eligible for a direct read')
            recovery['listing']['mode'] = ''
            open_route('files', ws='fixture', path='files/overview.md')
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            files_viewer('files/overview.md', 'Fixture overview')

            # F2: a nonempty filter excluding the selection hides its reader
            # while keeping route/cache; clearing restores it.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            page.locator('#find-record').fill('valid')
            expect(page.locator('.files-destination button.file-record', has_text='files/valid.json')).to_have_count(1)
            expect(files_row('files/overview.md')).to_have_count(0)
            expect(page.locator('.files-destination .reader .paper')).to_have_count(0)
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Fixture overview')
            expect(page.locator('.files-destination .reader .empty')).to_be_visible()
            assert files_params().get('path') == ['files/overview.md'], page.url
            page.locator('#find-record').fill('')
            files_viewer('files/overview.md', 'Fixture overview')
            report['scenarios'].append('A nonempty filter excluding the selection hides its reader while keeping route/cache; clearing restores it')

            # F3: a refresh that newly marks a readable file unavailable must
            # preserve its retained bytes/timestamp with a localized refusal.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            retained_stamp = page.locator('.files-destination').get_by_text(re.compile(r'last (received|checked)', re.I)).first.inner_text()
            retained_token = re.search(r'\d{1,2}:\d{2}(?::\d{2})?', retained_stamp)
            assert retained_token, retained_stamp
            recovery['listing']['mode'] = 'refuse-overview'
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(page.locator('.files-destination button.file-record', has_text='files/overview.md')).to_be_visible()
            page.locator('.files-destination .reader-head').get_by_role('button', name='Refresh file', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('Fixture overview')
            expect(page.locator('.files-destination .reader')).to_contain_text('no longer available')
            expect(page.locator('.files-destination .reader .paper')).to_have_count(1)
            expect(page.locator('.files-destination .reader .empty')).to_have_count(0)
            expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            assert retained_token.group(0) in page.locator('.files-destination').inner_text(), 'retained timestamp lost'
            page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('Fixture overview')
            expect(page.locator('.files-destination .reader .paper')).to_have_count(1)
            expect(page.locator('.files-destination .reader .empty')).to_have_count(0)
            assert retained_token.group(0) in page.locator('.files-destination').inner_text(), 'retry lost retained timestamp'
            report['scenarios'].append('A refresh that newly marks a readable file unavailable preserves its bytes/timestamp with a localized refusal and disabled Download across retry')
            recovery['listing']['mode'] = ''
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(files_row('files/overview.md')).to_be_visible()
            # The listing is healthy again but the retained refusal still
            # blocks Download; a localized retry re-reads and clears it.
            page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True).click()
            files_viewer('files/overview.md', 'Fixture overview')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('no longer available')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()

            # F1 (resource): an image available-to-unavailable-to-available
            # journey retains the mounted node/src through the refusal and
            # recovers visible content with an enabled Download.
            open_route('files', ws='fixture', path='files/pixel.png')
            expect(page.locator('.files-destination img.image-preview')).to_be_visible()
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            recovery_image_src = page.evaluate("""() => {
                const el = document.querySelector('.files-destination img.image-preview');
                window.__recoveryImage = el;
                return el.getAttribute('src');
            }""")
            assert recovery_image_src and 'file=files%2Fpixel.png' in recovery_image_src, recovery_image_src
            recovery['listing']['mode'] = 'refuse-media'
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(page.locator('.files-destination button.file-record', has_text='files/pixel.png')).to_be_visible()
            page.locator('.files-destination .reader-head').get_by_role('button', name='Refresh file', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('no longer available')
            assert page.evaluate("() => window.__recoveryImage === document.querySelector('.files-destination img.image-preview')") is True, 'refusal replaced the image node'
            assert page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')") == recovery_image_src, 'refusal changed the image src'
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            recovery['listing']['mode'] = ''
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('no longer available')
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            assert page.evaluate("() => window.__recoveryImage === document.querySelector('.files-destination img.image-preview')") is True, 'successful recovery replaced the image node'
            assert page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')") == recovery_image_src, 'successful recovery changed the image src'
            report['scenarios'].append('An image available-to-unavailable-to-available journey retains the mounted node/src through refusal and recovers visible content with enabled Download')

            # F1 (resource): a frame available-to-unavailable-to-available
            # journey retains the mounted document through the refusal and
            # recovers with an enabled Download.
            open_route('files', ws='fixture', path='files/sandbox.html')
            expect(page.locator('.files-destination iframe.html-frame')).to_be_visible()
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            recovery_frame_src = page.evaluate("""() => {
                const el = document.querySelector('.files-destination iframe.html-frame');
                window.__recoveryFrame = el;
                return el.getAttribute('srcdoc');
            }""")
            assert recovery_frame_src and '/api/workspace-file' in recovery_frame_src, recovery_frame_src
            recovery['listing']['mode'] = 'refuse-media'
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(page.locator('.files-destination button.file-record', has_text='files/sandbox.html')).to_be_visible()
            page.locator('.files-destination .reader-head').get_by_role('button', name='Refresh file', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('no longer available')
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            assert page.evaluate("() => window.__recoveryFrame === document.querySelector('.files-destination iframe.html-frame')") is True, 'refusal replaced the frame node'
            assert page.evaluate("() => document.querySelector('.files-destination iframe.html-frame').getAttribute('srcdoc')") == recovery_frame_src, 'refusal changed the frame document'
            expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            recovery['listing']['mode'] = ''
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('no longer available')
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            assert page.evaluate("() => window.__recoveryFrame === document.querySelector('.files-destination iframe.html-frame')") is True, 'successful recovery replaced the frame node'
            assert page.evaluate("() => document.querySelector('.files-destination iframe.html-frame').getAttribute('srcdoc')") == recovery_frame_src, 'successful recovery changed the frame document'
            report['scenarios'].append('A frame available-to-unavailable-to-available journey retains the mounted document through refusal and recovers with enabled Download')

            # F1 (resource): a failed image keeps its display error through
            # the refusal; the recovery retry mints an observable retry
            # nonce, decodes the real bytes and re-enables Download.
            recovery['reads']['corrupt'].add('files/pixel.png')
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            open_route('files', ws='fixture', path='files/pixel.png')
            expect(page.locator('.files-destination .reader')).to_contain_text('File could not be displayed')
            expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            failed_image_src = page.evaluate("""() => {
                const el = document.querySelector('.files-destination img.image-preview');
                window.__recoveryFailedImage = el;
                return el.getAttribute('src');
            }""")
            assert failed_image_src and 'file=files%2Fpixel.png' in failed_image_src, failed_image_src
            recovery['listing']['mode'] = 'refuse-media'
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(page.locator('.files-destination button.file-record', has_text='files/pixel.png')).to_be_visible()
            page.locator('.files-destination .reader-head').get_by_role('button', name='Refresh file', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('no longer available')
            assert page.evaluate("() => window.__recoveryFailedImage === document.querySelector('.files-destination img.image-preview')") is True, 'refusal replaced the failed image node'
            refused_failed_src = page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')")
            assert refused_failed_src and 'resource_retry=' in refused_failed_src, refused_failed_src
            expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True)).to_be_visible()
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            recovery['listing']['mode'] = ''
            recovery['reads']['corrupt'].discard('files/pixel.png')
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('no longer available')
            expect(page.locator('.files-destination .reader')).not_to_contain_text('File could not be displayed')
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            expect(page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first).to_be_visible()
            recovered_image_src = page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')")
            assert recovered_image_src and 'resource_retry=' in recovered_image_src, recovered_image_src
            report['scenarios'].append('A failed image keeps its display error through refusal; the recovery retry mints an observable retry nonce, decodes real bytes and re-enables Download')

            # (5) Offline disables Download; a real snapshot import is the
            # no-live transition and must abandon held work without new calls.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'true'}))
            page.get_by_role('button', name='Refresh state', exact=True).click()
            expect(page.locator('.files-destination .reader')).to_contain_text('Reading a retained copy')
            expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Download file', exact=True)).to_be_disabled()
            context.request.get(receipt['url'] + '/__fixture/control?' + urlencode({'action': 'state-fail', 'value': 'false'}))
            page.locator('.files-destination .reader').get_by_role('button', name='Retry connection', exact=True).click()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Reading a retained copy')
            expect(page.locator('.files-destination .reader-head').get_by_role('link', name='Download file', exact=True)).to_be_visible()
            report['scenarios'].append('A failed /api/state keeps the retained reader but disables Download until Retry connection')

            recovery['listing']['mode'] = 'hold'
            recovery['reads']['hold'].add('files/overview.md')
            page.locator('.files-destination .list-pane .detail-foot .ds-btn').click()
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            wait_recovery_held(2)
            expect(page.locator('.files-destination .list-pane .detail-foot .ds-btn')).to_be_disabled()

            snapshot_path = None
            try:
                state_payload = context.request.get(receipt['url'] + '/api/state').json()
                handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
                handle.write(json.dumps(state_payload))
                handle.close()
                snapshot_path = handle.name
                recovery['requests'].clear()
                page.set_input_files('#import-file', snapshot_path)
                expect(page.locator('h1')).to_have_text('Specs')
                page.evaluate("location.hash = '#/files?" + urlencode({'ws': 'fixture', 'path': 'files/overview.md'}) + "'")
                expect(page.locator('h1')).to_have_text('Files')
                expect(page.locator('.files-destination .records')).to_contain_text('A live dashboard is required')
                expect(page.locator('.files-destination .reader')).to_contain_text('Files require a live dashboard server')
                expect(page.locator('.files-destination .list-pane .detail-foot .ds-btn')).to_be_disabled()
                expect(page.locator('.files-destination .reader .paper')).to_have_count(0)
                release_recovery()
                page.wait_for_timeout(200)
                expect(page.locator('.files-destination .records')).to_contain_text('A live dashboard is required')
                expect(page.locator('.files-destination .reader')).to_contain_text('Files require a live dashboard server')
                assert recovery['requests'] == [], recovery['requests']
                report['scenarios'].append('A real snapshot import abandons held list/read work, shows the no-live regional UI and sends no new file/list request')
            finally:
                if snapshot_path:
                    Path(snapshot_path).unlink(missing_ok=True)
                release_recovery()
                recovery['listing']['mode'] = ''

            # (6) Bound reference screens: verify card sha256 before render.
            design_root = reference_screens('app-ui')
            assert design_root is not None, 'Bound app-ui design screens were not found'
            references = {}
            reference_page = context.new_page()
            try:
                for screen, filename, digest in [
                    ('61', '61-files-empty.html', 'c2e475e72239743a415eb314bead2754264d82b6227ecce205c9fb66c404058a'),
                    ('63', '63-files-error.html', 'dcc8d99d1269ba1a21d564099b175158c7fc3fe859dd8fde9acbf41aca48f7a2'),
                    ('64', '64-files-partial.html', 'a459c2a23a352950f6000b9015f42b741029d83f08b6d4b2ca8fcb746d8c9664'),
                    ('65', '65-files-unavailable.html', 'c419e7b85e76bb9965b5519995ea55d94c3f09546d6980b86fbe18a46d0b1b32'),
                    ('68', '68-files-no-matches.html', '67200f0ee3582ab1fee76c23bab1c731677a5249e0610aad385ab4d94de89b8a'),
                ]:
                    asset = design_root / filename
                    assert asset.is_file(), asset
                    actual = hashlib.sha256(asset.read_bytes()).hexdigest()
                    references[screen] = {'file': str(asset), 'sha256': actual, 'bound': digest}
                    assert actual == digest, (screen, actual, digest)
                    for width, height in [(1280, 860), (1600, 900)]:
                        reference_page.set_viewport_size({'width': width, 'height': height})
                        reference_page.goto(asset.as_uri(), wait_until='load')
                        reference_page.wait_for_timeout(150)
                        reference_page.screenshot(path=str(evidence / f'reference-{screen}-{width}.png'))
            finally:
                reference_page.close()
            report['references'] = references
            report['scenarios'].append('Bound reference screens 61/63/64/65/68 match their card sha256 digests and render at 1280/1600')

        if case == 'files-read-refresh':
            # Real built Files destination over the real file APIs; only the
            # final read responses are held, failed or replaced at the browser
            # boundary. A 2x1 PNG is decoded from a page-canvas data URL before
            # any interception so changed bytes have real pixel dimensions and
            # no dependency is added.
            png_data = page.evaluate("""() => {
                const canvas = document.createElement('canvas');
                canvas.width = 2;
                canvas.height = 1;
                const context = canvas.getContext('2d');
                context.fillStyle = '#d02020';
                context.fillRect(0, 0, 2, 1);
                return canvas.toDataURL('image/png');
            }""")
            changed_png = base64.b64decode(png_data.split(',', 1)[1])

            gate = {'reads': {'hold': {}, 'replace': {}, 'held': [], 'counts': {}}}

            def refresh_http(route):
                split = urlsplit(route.request.url)
                if split.path != '/api/workspace-file':
                    route.continue_()
                    return
                query = parse_qs(split.query)
                file = (query.get('file') or [''])[0]
                gate['reads']['counts'][file] = gate['reads']['counts'].get(file, 0) + 1
                # Metadata reads carry the read response; resource reads are the
                # browser-owned image loads. Both are held when armed so pending
                # state and byte provenance are asserted before release.
                resource = 'resource_retry' in query
                armed = gate['reads']['replace'] if resource else gate['reads']['hold']
                if file in armed:
                    response = route.fetch()
                    gate['reads']['held'].append({'file': file, 'resource': resource, 'route': route, 'response': response, 'replacement': armed[file]})
                    return
                route.continue_()

            page.route('**/api/workspace-file**', refresh_http)

            def matching_refresh_reads(file=None, resource=None):
                return [entry for entry in gate['reads']['held']
                        if (file is None or entry['file'] == file)
                        and (resource is None or entry['resource'] == resource)]

            def wait_refresh_held(file=None, resource=None, count=1):
                deadline = time.monotonic() + 5
                while len(matching_refresh_reads(file, resource)) < count and time.monotonic() < deadline:
                    page.wait_for_timeout(20)
                assert len(matching_refresh_reads(file, resource)) >= count, f'read was not held at the browser boundary: {file} resource={resource}'

            def release_refresh_reads(file=None, resource=None):
                remaining = []
                for entry in gate['reads']['held']:
                    if (file is None or entry['file'] == file) and (resource is None or entry['resource'] == resource):
                        try:
                            if entry['replacement'] is None:
                                entry['route'].fulfill(response=entry['response'])
                            else:
                                entry['route'].fulfill(response=entry['response'], body=entry['replacement'])
                        except Exception:
                            pass
                    else:
                        remaining.append(entry)
                gate['reads']['held'] = remaining

            def refresh_file():
                page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Refresh file$')).first.click()

            def retry_file():
                page.locator('.files-destination .ds-btn').filter(has_text=re.compile(r'^Retry file$')).first.click()

            def enabled_download():
                return page.locator('.files-destination').get_by_role('link', name='Download file', exact=True).first

            def disabled_download():
                return page.locator('.files-destination').get_by_role('button', name='Download file', exact=True).first

            def retained_receipt():
                footer = page.locator('.files-destination footer.detail-foot').first
                expect(footer).to_contain_text('last received')
                return footer.inner_text()

            # (1) Unchanged HTML then changed HTML bytes on the same mounted
            # iframe. Each read is held until pending state is asserted, so the
            # original node/srcdoc witness survives the unchanged release and
            # the changed release updates that same node.
            open_route('files', ws='fixture', path='files/sandbox.html')
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            expect(enabled_download()).to_be_visible()
            frame_document = page.evaluate("""() => {
                const el = document.querySelector('.files-destination iframe.html-frame');
                window.__readRefreshFrame = el;
                return el.getAttribute('srcdoc');
            }""")
            assert frame_document and '/api/workspace-file' in frame_document, frame_document
            gate['reads']['hold']['files/sandbox.html'] = None
            refresh_file()
            wait_refresh_held('files/sandbox.html', resource=False)
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            expect(disabled_download()).to_be_disabled()
            release_refresh_reads('files/sandbox.html', resource=False)
            gate['reads']['hold'].pop('files/sandbox.html', None)
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            assert page.evaluate("() => window.__readRefreshFrame === document.querySelector('.files-destination iframe.html-frame')") is True, 'unchanged HTML recheck replaced the iframe node'
            assert page.evaluate("() => document.querySelector('.files-destination iframe.html-frame').getAttribute('srcdoc')") == frame_document, 'unchanged HTML recheck changed the frame document'
            expect(enabled_download()).to_be_visible()
            report['scenarios'].append('An unchanged HTML recheck retains the exact mounted iframe node, srcdoc and enabled Download')

            changed_html = '<!doctype html><html><body><h1>Updated sandbox</h1></body></html>'
            gate['reads']['hold']['files/sandbox.html'] = changed_html
            refresh_file()
            wait_refresh_held('files/sandbox.html', resource=False)
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            expect(disabled_download()).to_be_disabled()
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Sandbox fixture')
            release_refresh_reads('files/sandbox.html', resource=False)
            gate['reads']['hold'].pop('files/sandbox.html', None)
            expect(page.frame_locator('.files-destination iframe.html-frame').locator('h1')).to_have_text('Updated sandbox')
            expect(enabled_download()).to_be_visible()
            assert page.evaluate("() => window.__readRefreshFrame === document.querySelector('.files-destination iframe.html-frame')") is True, 'changed HTML bytes replaced the iframe node'
            updated_document = page.evaluate("() => document.querySelector('.files-destination iframe.html-frame').getAttribute('srcdoc')")
            assert 'Updated sandbox' in updated_document and updated_document != frame_document, updated_document
            report['scenarios'].append('Changed HTML bytes update the same iframe srcdoc and enable Download only after the new document loads')

            # (2) Unchanged then changed PNG bytes on the same mounted img. The
            # changed metadata read and the browser-owned resource_retry read
            # are both held and both released with the 2x1 bytes, so the real
            # decode proves the changed bytes reached every request.
            open_route('files', ws='fixture', path='files/pixel.png')
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            expect(enabled_download()).to_be_visible()
            image_source = page.evaluate("""() => {
                const el = document.querySelector('.files-destination img.image-preview');
                window.__readRefreshImage = el;
                return el.getAttribute('src');
            }""")
            assert image_source and 'file=files%2Fpixel.png' in image_source, image_source
            gate['reads']['hold']['files/pixel.png'] = None
            refresh_file()
            wait_refresh_held('files/pixel.png', resource=False)
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            expect(disabled_download()).to_be_disabled()
            release_refresh_reads('files/pixel.png', resource=False)
            gate['reads']['hold'].pop('files/pixel.png', None)
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            assert page.evaluate("() => window.__readRefreshImage === document.querySelector('.files-destination img.image-preview')") is True, 'unchanged image recheck replaced the image node'
            assert page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')") == image_source, 'unchanged image recheck changed the image src'
            expect(enabled_download()).to_be_visible()
            report['scenarios'].append('An unchanged image recheck retains the exact img node/src and enabled Download')

            gate['reads']['hold']['files/pixel.png'] = changed_png
            gate['reads']['replace']['files/pixel.png'] = changed_png
            refresh_file()
            wait_refresh_held('files/pixel.png', resource=False)
            expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
            expect(disabled_download()).to_be_disabled()
            page.wait_for_function("() => document.querySelector('.files-destination img.image-preview')?.naturalWidth === 1")
            release_refresh_reads('files/pixel.png', resource=False)
            gate['reads']['hold'].pop('files/pixel.png', None)
            wait_refresh_held('files/pixel.png', resource=True)
            assert page.evaluate("() => window.__readRefreshImage === document.querySelector('.files-destination img.image-preview')") is True, 'changed image bytes replaced the mounted image node'
            changed_source = page.evaluate("() => document.querySelector('.files-destination img.image-preview').getAttribute('src')")
            assert 'resource_retry=' in changed_source and changed_source != image_source, changed_source
            expect(disabled_download()).to_be_disabled()
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            release_refresh_reads('files/pixel.png', resource=True)
            gate['reads']['replace'].pop('files/pixel.png', None)
            page.wait_for_function("() => { const el = document.querySelector('.files-destination img.image-preview'); return Boolean(el && el.naturalWidth === 2 && el.naturalHeight === 1); }")
            expect(page.locator('.files-destination .reader')).not_to_contain_text('Rechecking')
            expect(enabled_download()).to_be_visible()
            report['scenarios'].append('Changed PNG bytes refresh the same img node to real 2x1 decoded dimensions and enable Download after load')

            # (3) A failed body can never certify a download: the first read
            # stays error-only, and a retained recheck keeps its bytes, receipt
            # and disabled Download until a complete retry. Only the final
            # browser response body is replaced: the real /api/workspace-file
            # request still runs, so its successful status and headers stay
            # genuine, while an independent ReadableStream error distinguishes
            # a header-only publication from a completed-byte publication
            # (response.ok is never faked). The fixed Date makes the receipt
            # oracle exact: it advances past the retained second before the
            # failure, so a republished timestamp must differ.
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            page.evaluate("""() => {
                window.__nativeReadFetch = window.fetch.bind(window);
                window.__failBinaryReadBody = false;
                window.fetch = (input, init) => {
                    const href = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
                    const target = new URL(href, location.origin);
                    if (target.pathname !== '/api/workspace-file' || target.searchParams.get('file') !== 'files/capture-bundle.zip' || !window.__failBinaryReadBody) {
                        return window.__nativeReadFetch(input, init);
                    }
                    // Delegate first so the real request produces the real
                    // successful status and headers, then replace only the
                    // final browser response body with a stream that errors
                    // after its initial byte: consuming the body must reject,
                    // so HTTP success alone can never certify the bytes.
                    return window.__nativeReadFetch(input, init).then(response => {
                        let started = false;
                        const body = new ReadableStream({
                            pull(controller) {
                                if (!started) {
                                    started = true;
                                    controller.enqueue(new Uint8Array([0x1f]));
                                    return;
                                }
                                controller.error(new Error('fixture binary body failed after its initial byte'));
                            },
                        });
                        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
                    });
                };
            }""")
            try:
                page.evaluate('() => { window.__failBinaryReadBody = true; }')
                # Hash navigation keeps the SPA mounted, so the wrapper and its
                # fail flag survive this first read instead of being reloaded.
                page.evaluate("location.hash = '#/files?" + urlencode({'ws': 'fixture', 'path': 'files/capture-bundle.zip'}) + "'")
                expect(page.locator('.files-destination .reader')).to_contain_text('File could not be read')
                expect(disabled_download()).to_be_disabled()
                assert page.locator('.files-destination a[download]').count() == 0
                page.evaluate('() => { window.__failBinaryReadBody = false; }')
                receipt_time = datetime.datetime.now()
                page.clock.set_fixed_time(receipt_time)
                retry_file()
                expect(page.locator('.files-destination .reader .empty')).to_contain_text('2 KiB')
                expect(enabled_download()).to_be_visible()
                retained_stamp = retained_receipt()
                page.clock.set_fixed_time(receipt_time + datetime.timedelta(seconds=5))
                page.evaluate('() => { window.__failBinaryReadBody = true; }')
                refresh_file()
                expect(page.locator('.files-destination .reader')).to_contain_text('File could not be rechecked')
                expect(page.locator('.files-destination .reader .empty')).to_contain_text('2 KiB')
                expect(disabled_download()).to_be_disabled()
                assert page.locator('.files-destination a[download]').count() == 0
                assert retained_receipt() == retained_stamp, 'failed body advanced the retained receipt'
                page.evaluate('() => { window.__failBinaryReadBody = false; }')
                retry_file()
                expect(page.locator('.files-destination')).not_to_contain_text('File could not be rechecked')
                expect(enabled_download()).to_be_visible()
            finally:
                page.evaluate("""() => {
                    if (window.__nativeReadFetch) window.fetch = window.__nativeReadFetch;
                    delete window.__nativeReadFetch;
                    delete window.__failBinaryReadBody;
                }""")
            report['scenarios'].append('A failed binary body cannot certify Download; a retained recheck keeps its bytes, receipt and disabled Download until a complete retry')

            # (4) The request budget bounds a stalled first read and a retained
            # recheck: only the 30000ms read budget is scaled, so other App
            # deadlines stay native while the production budget is asserted.
            receipt_time = datetime.datetime.now()
            page.clock.set_fixed_time(receipt_time)
            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            retained_stamp = retained_receipt()
            page.clock.set_fixed_time(receipt_time + datetime.timedelta(seconds=5))
            gate['reads']['hold']['files/overview.md'] = None
            page.evaluate("""() => {
                window.__nativeReadTimeout = AbortSignal.timeout;
                window.__readTimeoutBudgets = [];
                AbortSignal.timeout = milliseconds => {
                    window.__readTimeoutBudgets.push(milliseconds);
                    return window.__nativeReadTimeout.call(AbortSignal, milliseconds === 30000 ? 100 : milliseconds);
                };
            }""")
            try:
                budget_start = page.evaluate('() => window.__readTimeoutBudgets.length')
                refresh_file()
                wait_refresh_held('files/overview.md', resource=False)
                expect(page.locator('.files-destination .reader')).to_contain_text('Rechecking')
                expect(disabled_download()).to_be_disabled()
                expect(page.locator('.files-destination .reader')).to_contain_text('File could not be rechecked')
                expect(page.locator('.files-destination .paper')).to_contain_text('Fixture overview')
                assert retained_receipt() == retained_stamp, 'timed-out recheck advanced the retained receipt'
                expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True)).to_be_visible()
                expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Refresh file', exact=True)).to_be_enabled()
                read_budgets = page.evaluate('(start) => window.__readTimeoutBudgets.slice(start)', budget_start)
                assert 30000 in read_budgets, read_budgets
                gate['reads']['hold']['files/valid.json'] = None
                page.evaluate("location.hash = '#/files?" + urlencode({'ws': 'fixture', 'path': 'files/valid.json'}) + "'")
                wait_refresh_held('files/valid.json', resource=False)
                expect(page.locator('.files-destination .reader')).to_contain_text('File could not be read')
                expect(page.locator('.files-destination .reader').get_by_role('button', name='Retry file', exact=True)).to_be_visible()
                expect(page.locator('.files-destination .reader-head').get_by_role('button', name='Refresh file', exact=True)).to_be_enabled()
                expect(disabled_download()).to_be_disabled()
                assert page.locator('.files-destination a[download]').count() == 0
            finally:
                page.evaluate('() => { AbortSignal.timeout = window.__nativeReadTimeout; }')
                gate['reads']['hold'].pop('files/overview.md', None)
                gate['reads']['hold'].pop('files/valid.json', None)
                release_refresh_reads()
                gate['reads']['held'] = []
            report['scenarios'].append('A stalled first read and a retained recheck use the production 30000ms budget (native deadline scaled to 100ms), keep the original bytes/receipt, and offer Retry file plus Refresh file')

            open_route('files', ws='fixture', path='files/overview.md')
            files_viewer('files/overview.md', 'Fixture overview')
            report['scenarios'].append('Files reader bodies are fully consumed before publication and Refresh file observes changed HTML/PNG bytes')

        if case in (None, 'specs'):
            open_route('specs', ws='fixture')
            tabs = page.get_by_role('navigation', name='Spec sections')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            tabs.get_by_role('button', name='Activity', exact=True).click()
            assert params()['tab'] == ['activity'], page.url
            tabs.get_by_role('button', name='Files', exact=True).click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params()['source'] == ['package'] and params()['id'] == [receipt['package']] and params()['ws'] == ['fixture'], page.url
            page.get_by_role('button', name='spec.md', exact=True).click()
            viewer('spec.md', 'Browser specification')
            page.get_by_role('button', name='linked.md', exact=True).click()
            viewer('linked.md', 'Linked evidence')
            page.reload()
            viewer('linked.md', 'Linked evidence')
            page.go_back()
            viewer('spec.md', 'Browser specification')
            page.go_back()
            expect(page.locator('.file-viewer')).to_have_count(0)
            page.go_forward()
            viewer('spec.md', 'Browser specification')
            page.go_back()
            page.go_back()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(tabs.get_by_role('button', name='Activity', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert params()['tab'] == ['activity'] and params().get('id') and params()['ws'] == ['fixture'], page.url
            report['scenarios'].append('Specs Files tab hands off to the shared Files destination with real package files; Back restores the selected Activity tab')

        if case == 'member':
            # A searched epic's member must open a fresh Specs route that selects
            # the current record and leaves no epic q/filter/tab behind.
            open_route('epics', ws='fixture', q='Demo epic')
            expect(page.locator('#find-record')).to_have_value('Demo epic')
            # Epic-side selectors only: the rewritten Epics detail keeps its
            # heading in article.detail-pane and the remembered-member marker
            # lives on the eligible member table button.
            expect(page.locator('article.detail-pane .object-head h2')).to_have_text('Demo epic')
            page.locator('table.epic-members button', has_text='browser').click()
            expect(page.locator('h1')).to_have_text('Specs')
            assert params()['ws'] == ['fixture'], page.url
            assert params().get('id'), page.url
            assert not {'q', 'filter', 'tab', 'path', 'source'} & params().keys(), page.url
            assert 'recent-completion' not in params()['id'][0], 'epic member navigation selected completion history'
            expect(page.locator('#find-record')).to_have_value('')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            page.go_back()
            expect(page.locator('h1')).to_have_text('Epics')
            expect(page.locator('#find-record')).to_have_value('Demo epic')
            expect(page.locator('article.detail-pane .object-head h2')).to_have_text('Demo epic')
            assert params()['q'] == ['Demo epic'], page.url
            page.go_forward()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            assert params().get('id'), page.url
            assert not {'q', 'filter', 'tab', 'path', 'source'} & params().keys(), page.url
            report['scenarios'].append('searched epic member opens a fresh Specs route selecting the current record; Back/Forward keeps the epic search and spec detail synchronized')

        if case == 'search':
            # workflow_state is a rendered search field; selecting the matching row
            # must retain its detail, and a native hash with an unsupported
            # parameter must canonicalize without losing that selection.
            open_route('specs', ws='fixture')
            page.locator('#find-record').fill('waiting-worker')
            row = page.locator('.records button.record[data-key]')
            expect(row).to_have_count(1)
            row.click()
            assert params()['q'] == ['waiting-worker'], page.url
            selected_id = params().get('id')
            assert selected_id, page.url
            expect(row).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            expect(page.locator('.obligation')).to_contain_text('Keep editors stable')
            page.evaluate("location.hash = location.hash + '&unknown=ignored'")
            page.wait_for_function("() => !location.hash.includes('unknown')")
            assert 'unknown' not in params(), page.url
            assert params().get('id') == selected_id, page.url
            expect(row).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            report['scenarios'].append('workflow_state search row keeps its selected Spec detail, and a native hash with an unsupported parameter canonicalizes without losing selection')

        if case == 'filters':
            # Keep the server and package-file APIs real while controlling only
            # the observer projection. The planned row points at the real
            # fixture package so its selected detail and reader cross the seam.
            now = '2026-10-12T12:00:00.000Z'
            workspace = 'fixture'
            package = receipt['package']
            active_package = '/fixture/specs/active-browser'
            blocked_package = '/fixture/specs/blocked-browser'
            done_package = '/fixture/specs/done-browser'
            active = {
                'workspace': workspace, 'package': active_package, 'package_ref': 'fixture/active-browser',
                'assignment_id': 'active-current', 'execution': 'running', 'workflow_state': 'working',
                'is_current_assignment': True, 'activity': 'Active browser work', 'obligation': 'Keep active visible',
                'observed_at': now, 'coverage': {'state': 'complete', 'reasons': []},
            }
            blocked = {
                'workspace': workspace, 'package': blocked_package, 'package_ref': 'fixture/blocked-browser',
                'assignment_id': 'blocked-current', 'execution': 'running', 'workflow_state': 'blocked',
                'is_current_assignment': True, 'activity': 'Blocked browser work', 'obligation': 'Needs attention',
                'observed_at': now, 'coverage': {'state': 'complete', 'reasons': []},
            }
            active_history = {
                **active, 'assignment_id': 'active-history', 'execution': 'completed',
                'workflow_state': 'complete', 'is_current_assignment': False,
                'activity': 'Historical sibling of active browser work',
            }
            done = {
                'workspace': workspace, 'package': done_package, 'package_ref': 'fixture/done-browser',
                'assignment_id': 'done-record', 'execution': 'completed', 'workflow_state': 'complete',
                'is_current_assignment': False, 'completion_basis': 'manual', 'completed_at': now,
                'activity': 'Done browser work', 'obligation': 'Recently completed',
                'observed_at': now, 'coverage': {'state': 'complete', 'reasons': []},
            }
            planned = {
                'workspace': workspace, 'package': package, 'package_ref': 'fixture/browser',
                'source_paths': ['spec.md', 'linked.md'],
            }
            planned_history = {
                **planned, 'assignment_id': 'planned-history', 'execution': 'cancelled',
                'is_current_assignment': False,
            }
            foreign_planned = {
                'workspace': 'other', 'package': '/other/specs/other-planned',
                'package_ref': 'other/other-planned', 'source_paths': ['spec.md'],
            }
            controlled_state = {
                'schema_version': 1, 'generated_at': now,
                'observers': [{
                    'observer_id': 'filter-fixture', 'state': 'observing', 'published_at': now,
                    'snapshot': {
                        'workspace': workspace,
                        'coverage': {'state': 'complete', 'observed_at': now, 'reasons': []},
                        'runs': [active, blocked, active_history, planned_history],
                        'recently_completed': [done],
                        'planned_packages': [planned, foreign_planned],
                        'assignments': [], 'assignment_coverage': {'state': 'complete', 'reasons': []},
                        'epics': [{
                            'workspace': workspace, 'epic': 'planned-roadmap', 'title': 'Planned roadmap',
                            'members': [{'name': 'browser', 'package': 'browser', 'workspace': workspace, 'status': 'ready'}],
                        }],
                    },
                }],
            }

            page.route('**/api/state**', lambda route: route.fulfill(json=controlled_state))
            open_route('specs', ws='fixture', filter='planned')
            filters = page.get_by_role('navigation', name='Package filters')
            expect(filters.get_by_role('button', name='Active', exact=True)).to_have_attribute('aria-pressed', 'false')
            ready_tab = filters.get_by_role('button', name='Ready', exact=True)
            expect(ready_tab).to_have_attribute('aria-pressed', 'true')
            rows = page.locator('.records button.record[data-key]')
            expect(rows).to_have_count(1)
            expect(rows.nth(0).locator('.run-title')).to_have_text('browser')
            caption = page.locator('.list-caption')
            expect(caption).to_contain_text('Prepared, not started')
            expect(caption).to_contain_text('1')
            expect(page.locator('main')).not_to_contain_text('active-browser')
            expect(page.locator('main')).not_to_contain_text('other-planned')
            report['scenarios'].append('Planned shows the package inventory row only, excluding active and cross-workspace package rows')

            filters.get_by_role('button', name='Active', exact=True).click()
            expect(rows).to_have_count(2)
            expect(rows.first.locator('.run-title')).to_have_text('blocked-browser')
            expect(rows.nth(1).locator('.run-title')).to_have_text('active-browser')
            expect(caption).to_contain_text('Active')
            expect(caption).to_contain_text('2')
            filters.get_by_role('button', name='Blocked', exact=True).click()
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('blocked-browser')
            expect(caption).to_contain_text('Blocked')
            expect(caption).to_contain_text('1')
            filters.get_by_role('button', name='Done', exact=True).click()
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('done-browser')
            expect(caption).to_contain_text('Done')
            expect(caption).to_contain_text('1')
            filters.get_by_role('button', name='Ready', exact=True).click()
            assert params()['filter'] == ['ready'], page.url
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('browser')
            expect(caption).to_contain_text('Prepared, not started')
            expect(caption).to_contain_text('1')
            report['scenarios'].append('Filter clicks show matching rows and counts; Active orders blocked before healthy, while Blocked narrows to attention')

            page.locator('#find-record').fill('browser')
            expect(rows).to_have_count(1)
            page.locator('#find-record').fill('no planned match')
            expect(rows).to_have_count(0)
            expect(caption).to_contain_text('0')
            expect(page.get_by_role('heading', name='No matching specs', exact=True)).to_be_visible()
            page.locator('#find-record').fill('')
            expect(rows).to_have_count(1)

            rows.first.click()
            expect(page.locator('.object-head h2')).to_have_text('browser')
            expect(page.get_by_role('button', name='Open spec files', exact=True)).to_be_enabled()
            selected_url = page.url
            assert params()['filter'] == ['ready'], selected_url
            page.screenshot(path=str(evidence / 'sentinel-planned-filter-desktop.png'), full_page=True)
            page.reload()
            expect(filters.get_by_role('button', name='Ready', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            assert params()['filter'] == ['ready'] and params().get('id'), page.url
            page.get_by_role('button', name='Open spec files', exact=True).click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params()['source'] == ['package'] and params()['id'] == [package] and params()['ws'] == ['fixture'], page.url
            files_row('spec.md').click()
            files_viewer('spec.md', 'Browser specification')
            page.go_back()
            assert 'path' not in files_params(), page.url
            page.go_back()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(filters.get_by_role('button', name='Ready', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert params()['filter'] == ['ready'] and params().get('id'), page.url
            report['scenarios'].append('Planned row deep link hands off to the real package Files destination and opens the fixture package file reader; Back restores the selected Ready tab')

            # Legacy query keys continue to select the renamed tabs and their
            # existing predicates, so saved links keep working.
            open_route('specs', ws='fixture', filter='attention')
            expect(filters.get_by_role('button', name='Blocked', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.records button.record[data-key] .run-title')).to_have_text('blocked-browser')
            expect(page.locator('.list-caption')).to_contain_text('1')
            open_route('specs', ws='fixture', filter='completed')
            expect(filters.get_by_role('button', name='Done', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.records button.record[data-key] .run-title')).to_have_text('done-browser')
            expect(page.locator('.list-caption')).to_contain_text('1')
            report['scenarios'].append('Legacy attention and completed deep links select Blocked and Done with one matching row each')

            open_route('epics', ws='fixture')
            page.get_by_role('button', name='browser', exact=True).click()
            expect(page.locator('h1')).to_have_text('Specs')
            assert params()['filter'] == ['ready'], page.url
            expect(filters.get_by_role('button', name='Ready', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(rows).to_have_count(1)
            expect(rows.first).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            report['scenarios'].append('Epic member navigation selects the Ready inventory over an inactive historical run')

            open_route('specs', ws='fixture', filter='planned')
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('browser')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.screenshot(path=str(evidence / 'sentinel-planned-filter-mobile.png'), full_page=True)
            expect(filters.get_by_role('button', name='Ready', exact=True)).to_have_attribute('aria-pressed', 'true')

        if case == 'specs-overview':
            (evidence / 'screens').mkdir(parents=True, exist_ok=True)
            (evidence / 'reference').mkdir(parents=True, exist_ok=True)
            now = '2026-10-12T12:00:00.000Z'
            stale_coverage = '2026-10-12T10:00:00.000Z'
            package = receipt['package']
            record_key = json.dumps(['fixture', package, 'run-1'], separators=(',', ':'))
            assignment_key = json.dumps(['fixture', 'run-1'], separators=(',', ':'))

            def capture(name, width):
                page.set_viewport_size({'width': width, 'height': 800})
                path = evidence / 'screens' / f'specs-overview-{name}-{width}.png'
                page.screenshot(path=str(path), full_page=True)
                report.setdefault('captures', []).append(str(path))

            def capture_both(name):
                capture(name, 1280)
                capture(name, 1600)

            design_screens = Path(os.environ['SENTINEL_DESIGN_SCREENS']) if os.environ.get('SENTINEL_DESIGN_SCREENS') else evidence.resolve().parent.parent.parent / 'designs' / 'app-ui' / 'screens'
            for screen in ('01-specs', '31-specs-partial', '32-specs-offline', '33-specs-stale'):
                source = design_screens / f'{screen}.html'
                if not source.exists():
                    report.setdefault('referenceMissing', []).append(screen)
                    continue
                for width in (1280, 1600):
                    reference = context.new_page()
                    reference.set_viewport_size({'width': width, 'height': 800})
                    reference.goto(source.as_uri(), wait_until='domcontentloaded')
                    reference.wait_for_timeout(200)
                    path = evidence / 'reference' / f'{screen}-{width}.png'
                    reference.screenshot(path=str(path), full_page=True)
                    reference.close()
                    report.setdefault('referenceCaptures', []).append(str(path))

            state = {'value': None}

            def on_state(route):
                route.fulfill(json=state['value'])

            page.route('**/api/state**', on_state)

            def envelope(runs, assignments=(), epics=(), coverage_at=now):
                return {'schema_version': 1, 'generated_at': now,
                        'observers': [{'observer_id': 'overview-fixture', 'state': 'observing', 'published_at': now,
                                       'snapshot': {'workspace': 'fixture',
                                                    'coverage': {'state': 'complete', 'observed_at': coverage_at, 'reasons': []},
                                                    'runs': list(runs), 'recently_completed': [], 'planned_packages': [],
                                                    'assignments': list(assignments),
                                                    'assignment_coverage': {'state': 'complete', 'reasons': []},
                                                    'epics': list(epics)}}]}

            missing_run = {
                'workspace': 'fixture', 'package': package, 'package_ref': 'fixture/browser',
                'execution': 'running', 'workflow_state': 'working', 'is_current_assignment': True,
                'activity': 'Building the dashboard', 'observed_at': '2026-10-12T09:58:00.000Z',
                'coverage': {'state': 'complete', 'reasons': []},
                'timing': {'started_at': '2026-10-12T08:00:00.000Z', 'attempts': []},
            }
            state['value'] = envelope([missing_run], coverage_at=stale_coverage)
            open_route('specs', ws='fixture')
            expect(page.locator('.progress-head strong')).to_have_text('Spec size unknown')
            expect(page.locator('.progress-track .progress-value')).to_have_count(0)
            expect(page.locator('.obligation')).to_contain_text('No obligation summary was observed.')
            facts = page.locator('.facts .fact')
            expect(facts).to_have_count(3)
            expect(facts.nth(0).locator('label')).to_have_text('Elapsed at observation')
            expect(facts.nth(0).locator('strong')).to_have_text('2h 0m 0s')
            expect(facts.nth(1).locator('label')).to_have_text('Last activity')
            expect(facts.nth(1).locator('strong')).to_have_text('2m 0s before observation')
            related = page.locator('.table-wrap tbody tr')
            expect(related).to_have_count(3)
            expect(related.nth(0)).to_contain_text('Assignment')
            expect(related.nth(0)).to_contain_text('Not recorded')
            expect(related.nth(1)).to_contain_text('Epic')
            expect(related.nth(1)).to_contain_text('Not recorded')
            expect(related.nth(2)).to_contain_text('Accepted steps not observed')
            expect(page.locator('.detail-actions').get_by_role('button', name='Open agent', exact=True)).to_have_count(0)
            capture_both('missing')
            retained = [facts.nth(index).locator('strong').inner_text() for index in range(3)]
            page.wait_for_timeout(1200)
            assert [facts.nth(index).locator('strong').inner_text() for index in range(3)] == retained, 'retained Overview facts advanced with the clock'
            capture_both('retained')
            report['scenarios'].append('Missing obligation/progress/assignment/epic facts show specified absence without invented status; stale elapsed and activity stay fixed')

            linked_run = {
                'workspace': 'fixture', 'package': package, 'package_ref': 'fixture/browser',
                'assignment_id': 'run-1', 'workflow_id': 'workflow-1', 'execution': 'running',
                'workflow_state': 'working', 'is_current_assignment': True,
                'activity': 'Building the dashboard', 'obligation': 'Keep editors stable',
                'observed_at': now, 'coverage': {'state': 'complete', 'reasons': []},
                'spec_progress': {'current_position': 2, 'total_steps': 5, 'current_name': 'Resolve worker identity'},
                'timing': {'started_at': now, 'attempts': []},
                'evidence': {'state': 'recorded', 'verdict': 'ready', 'commit': 'abc123', 'source': 'work-tour.html'},
                'epic': {'epic': 'demo', 'workspace': 'fixture'},
            }
            linked_assignments = [{'assignment_id': 'run-1', 'workspace_id': 'fixture', 'spec_package': 'fixture/browser',
                                   'workflow_id': 'workflow-1', 'display': 'live', 'state': 'live',
                                   'coverage': {'state': 'complete', 'reasons': []},
                                   'task_activity': {'state': 'idle', 'reason': 'Waiting for the next instruction.'},
                                   'nextAction': 'Attach to the terminal'}]
            linked_epics = [{'workspace': 'fixture', 'epic': 'demo', 'title': 'Demo epic', 'state': 'active',
                             'members': [{'name': 'browser', 'package': package, 'workspace': 'fixture', 'status': 'in-progress', 'waiting_on': [], 'attention': False}],
                             'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0}, 'next': 'browser',
                             'coverage': {'state': 'complete', 'reasons': []}}]
            state['value'] = envelope([linked_run], assignments=linked_assignments, epics=linked_epics)
            page.reload()
            open_route('specs', ws='fixture', id=record_key, filter='active', q='Building')
            tabs = page.get_by_role('navigation', name='Spec sections')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            expect(page.locator('.progress-head strong')).to_have_text('Step 2 of 5 · Resolve worker identity')
            expect(page.locator('.table-wrap tbody tr').nth(1)).to_contain_text('Demo epic \u00b7 member 1 of 1')
            report['scenarios'].append('Related work names the selected package as member 1 of 1 from the canonical epic package path')
            expect(tabs.get_by_role('button', name='Overview', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert params()['ws'] == ['fixture'] and params()['filter'] == ['active'] and params()['q'] == ['Building'] and params()['id'] == [record_key], page.url

            # Full-page screenshots do not expose overflow inside the detail pane.
            # Capture the populated Overview at both pane positions and retain
            # the actual scroll geometry beside the image paths.
            for width in (1280, 1600):
                page.set_viewport_size({'width': width, 'height': 800})
                pane = page.locator('.detail-body')
                for position in ('populated', 'populated-lower'):
                    pane.evaluate('(el, lower) => { el.scrollTop = lower ? el.scrollHeight : 0; }', position.endswith('lower'))
                    if position.endswith('lower'):
                        expect(pane.get_by_role('heading', name='Related work', exact=True)).to_be_in_viewport()
                        expect(pane.get_by_role('link', name='Demo epic \u00b7 member 1 of 1', exact=True)).to_be_in_viewport()
                    capture(position, width)
                    report.setdefault('captureMetadata', []).append({
                        'path': report['captures'][-1], 'state': position,
                        'viewport': {'width': width, 'height': 800},
                        'scrollContainer': '.detail-body',
                        **pane.evaluate('(el) => ({scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight})'),
                    })
                pane.evaluate('(el) => { el.scrollTop = 0; }')
            report['scenarios'].append('Populated Overview and its lower Related work region are captured at 1280 and 1600 with detail-pane scroll metadata')

            open_route('specs', ws='fixture', id=record_key, tab='activity')
            expect(tabs.get_by_role('button', name='Activity', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.object-head h2')).to_have_text('browser')
            expect(page.locator('.detail-body')).to_contain_text('Step attempts')
            capture_both('activity')
            open_route('specs', ws='fixture', id=record_key, tab='unrecognized')
            expect(tabs.get_by_role('button', name='Overview', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.progress-head')).to_be_visible()
            report['scenarios'].append('Cold Activity link renders the Activity body and an unknown tab renders Overview')

            open_route('specs', ws='fixture', id=record_key, filter='active', q='Building')
            page.locator('.detail-actions').get_by_role('button', name='Open spec', exact=True).click()
            assert params()['tab'] == ['activity'] and params()['filter'] == ['active'] and params()['q'] == ['Building'] and params()['id'] == [record_key], page.url
            page.locator('.detail-actions').get_by_role('button', name='Open agent', exact=True).click()
            expect(page.locator('h1')).to_have_text('Agents')
            assert params()['id'] == [assignment_key] and params()['ws'] == ['fixture'], page.url
            capture_both('agent')
            page.go_back()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(tabs.get_by_role('button', name='Activity', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert params()['tab'] == ['activity'] and params()['filter'] == ['active'] and params()['q'] == ['Building'] and params()['id'] == [record_key] and params()['ws'] == ['fixture'], page.url
            page.go_back()
            expect(tabs.get_by_role('button', name='Overview', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.progress-head')).to_be_visible()
            assert 'tab' not in params() and params()['filter'] == ['active'] and params()['q'] == ['Building'] and params()['id'] == [record_key] and params()['ws'] == ['fixture'], page.url
            report['scenarios'].append('Overview -> Activity -> linked Agent -> Back twice restores Activity then Overview with ws/filter/q/id preserved')

            tabs.get_by_role('button', name='Activity', exact=True).click()
            assert params()['tab'] == ['activity'], page.url
            tabs.get_by_role('button', name='Files', exact=True).click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params()['source'] == ['package'] and params()['id'] == [package] and params()['ws'] == ['fixture'], page.url
            expect(page.get_by_role('button', name='spec.md', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='work-tour.html', exact=True)).to_be_visible()
            capture_both('files')
            page.get_by_role('button', name='spec.md', exact=True).click()
            viewer('spec.md', 'Browser specification')
            page.get_by_role('button', name='work-tour.html', exact=True).click()
            expect(page.locator('.file-viewer h4')).to_have_text('work-tour.html')
            expect(page.locator('.file-viewer iframe')).to_have_attribute('title', 'work-tour.html')
            capture_both('files-tour')
            page.go_back()
            viewer('spec.md', 'Browser specification')
            page.go_back()
            expect(page.locator('.file-viewer')).to_have_count(0)
            page.go_back()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(tabs.get_by_role('button', name='Activity', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert params()['tab'] == ['activity'] and params()['filter'] == ['active'] and params()['q'] == ['Building'] and params()['id'] == [record_key] and params()['ws'] == ['fixture'], page.url
            report['scenarios'].append('Files tab, spec.md and work-tour.html use the real package Files destination; Back restores the selected Activity tab')

            imported = envelope([linked_run], assignments=linked_assignments, epics=linked_epics)
            page.locator('#import-file').set_input_files({'name': 'specs-overview-import.json', 'mimeType': 'application/json', 'buffer': json.dumps(imported).encode()})
            expect(page.locator('.records button.record[data-key]')).to_have_count(1)
            open_route('files', source='package', id=package)
            expect(page.locator('h1')).to_have_text('Files')
            expect(page.locator('main')).to_contain_text('Package files require a live published package on the local dashboard server.')
            expect(page.locator('.files-list')).to_have_count(0)
            capture_both('files-offline')
            report['scenarios'].append('Imported/offline Files reports the existing unavailable boundary')

        if case == 'specs-variants':
            (evidence / 'screens').mkdir(parents=True, exist_ok=True)
            (evidence / 'reference').mkdir(parents=True, exist_ok=True)
            now = '2026-10-12T12:00:00.000Z'
            earlier = '2026-10-12T10:30:00.000Z'
            package = receipt['package']
            done_key = json.dumps(['fixture', package, 'recent-completion'], separators=(',', ':'))
            planned_key = json.dumps(['fixture', package, 'planned-package', None], separators=(',', ':'))
            state = {'value': None}

            def on_state(route):
                route.fulfill(json=state['value'])

            page.route('**/api/state**', on_state)

            def variant_envelope(runs=(), recently=(), planned=(), epics=()):
                return {'schema_version': 1, 'generated_at': now,
                        'thread_action_token': 'fixture-thread-token', 'action_token': 'fixture-action-token',
                        'observers': [{'observer_id': 'variants-fixture', 'state': 'observing', 'published_at': now,
                                       'snapshot': {'workspace': 'fixture',
                                                    'coverage': {'state': 'complete', 'observed_at': now, 'reasons': []},
                                                    'runs': list(runs), 'recently_completed': list(recently),
                                                    'planned_packages': list(planned),
                                                    'assignments': [], 'assignment_coverage': {'state': 'complete', 'reasons': []},
                                                    'epics': list(epics)}}]}

            def done_record(basis, **extra):
                value = {'workspace': 'fixture', 'package': package, 'package_ref': 'fixture/browser',
                         'assignment_id': f'variant-{basis}', 'execution': 'completed', 'workflow_state': 'complete',
                         'is_current_assignment': False, 'completion_basis': basis, 'completed_at': earlier,
                         'activity': f'{basis} completion recorded', 'obligation': f'Final obligation for the {basis} basis',
                         'observed_at': now, 'coverage': {'state': 'complete', 'reasons': []}}
                value.update(extra)
                return value

            def capture(name, width):
                page.set_viewport_size({'width': width, 'height': 800})
                path = evidence / 'screens' / f'specs-variants-{name}-{width}.png'
                page.screenshot(path=str(path), full_page=True)
                report.setdefault('captures', []).append(str(path))

            def capture_both(name):
                capture(name, 1280)
                capture(name, 1600)

            publication = page.locator('.detail-body .table-wrap tbody tr')
            done_callout = page.locator('.detail-body .ds-callout.success')
            tour = page.locator('.detail-actions').get_by_role('button', name='Open work tour', exact=True)
            package_files = page.locator('.detail-actions').get_by_role('button', name='Open package files', exact=True)

            def open_done():
                open_route('specs', ws='fixture', filter='completed', id=done_key)
                expect(page.locator('.object-head h2')).to_have_text('browser')

            # Manual basis: no merge facts and no evidence disable only the tour.
            state['value'] = variant_envelope(recently=[done_record('manual')])
            open_done()
            expect(page.locator('.progress-track')).to_have_count(0)
            expect(page.locator('.detail-body .facts')).to_have_count(0)
            expect(page.locator('.detail-body')).not_to_contain_text('Elapsed at observation')
            expect(page.locator('.detail-body')).not_to_contain_text('Needs attention')
            expect(page.locator('.detail-body')).to_contain_text('Marked complete')
            expect(done_callout).to_have_count(0)
            expect(publication).to_have_count(4)
            expect(publication.nth(0)).to_contain_text('Pull request')
            expect(publication.nth(0)).to_contain_text('Not recorded')
            expect(publication.nth(1)).to_contain_text('Not recorded')
            expect(publication.nth(2)).to_contain_text('Completion time')
            expect(publication.nth(2)).not_to_contain_text('Not recorded')
            expect(publication.nth(3)).to_contain_text('Merge basis')
            expect(publication.nth(3)).to_contain_text('Not recorded')
            expect(tour).to_be_disabled()
            expect(page.locator('#work-tour-reason')).to_contain_text('no recorded evidence')
            expect(package_files).to_be_enabled()
            report['scenarios'].append('Manual Done basis reads Marked complete with Not recorded publication facts, no progress/facts grid, and only the tour action disabled')

            # Workflow basis.
            state['value'] = variant_envelope(recently=[done_record('workflow-checkpoint')])
            page.reload()
            expect(page.locator('.detail-body')).to_contain_text('Workflow marked complete')
            expect(done_callout).to_have_count(0)
            report['scenarios'].append('Workflow Done basis reads Workflow marked complete')

            # Ready PR: URL recorded, head/branch missing.
            state['value'] = variant_envelope(recently=[done_record('ready-pr', merge={'url': 'https://forge.example/pr/210', 'state': 'open'})])
            page.reload()
            expect(page.locator('.detail-body')).to_contain_text('Ready PR published')
            expect(publication.nth(0).locator('a')).to_have_attribute('href', 'https://forge.example/pr/210')
            expect(publication.nth(1)).to_contain_text('Not recorded')
            expect(publication.nth(3)).to_contain_text('open')
            expect(done_callout).to_have_count(0)
            report['scenarios'].append('Ready PR Done basis reads Ready PR published, links only the recorded URL and reads Not recorded for a missing head')

            # Merged PR: recorded publication facts and the recorded work tour.
            # Production sentinel.mjs readTourEvidence publishes source work-tour.json;
            # the action still opens the rendered work-tour.html tour, not the manifest.
            merged = {'url': 'https://forge.example/pr/211', 'head': 'f' * 12, 'branch': 'spec/fixture-browser',
                      'state': 'merged', 'reason': 'local-pr-merge', 'evidence_source': 'local-git', 'merged_at': earlier}
            state['value'] = variant_envelope(recently=[done_record('merged-pr', merge=merged,
                                                                   evidence={'state': 'recorded', 'verdict': 'ready', 'source': 'work-tour.json', 'commit': 'abc123'})])
            page.reload()
            expect(page.locator('.detail-body')).to_contain_text('PR merged')
            expect(done_callout).to_have_count(1)
            expect(done_callout).to_contain_text('Merge confirmed')
            expect(publication.nth(0).locator('a')).to_have_attribute('href', 'https://forge.example/pr/211')
            expect(publication.nth(1)).to_contain_text('spec/fixture-browser')
            expect(publication.nth(3)).to_contain_text('local-pr-merge')
            expect(tour).to_be_enabled()
            assert 'ds-btn--primary' in (tour.get_attribute('class') or ''), tour.get_attribute('class')
            report['scenarios'].append('Merged PR Done basis shows the Merge confirmed callout, recorded publication link/head/basis and an enabled primary work tour')
            capture_both('done-merged')
            tour.click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params()['source'] == ['package'] and params()['id'] == [package] and params()['path'] == ['work-tour.html'], page.url
            expect(page.locator('.file-viewer h4')).to_have_text('work-tour.html')
            report['scenarios'].append('Done Open work tour opens the rendered package tour through the shared Files route from production work-tour.json evidence, not the JSON manifest')
            page.go_back()
            expect(page.locator('.object-head h2')).to_have_text('browser')

            # Planned: prepared total without a run, no elapsed/completion/attention assertions.
            epic = {'workspace': 'fixture', 'epic': 'variants-roadmap', 'title': 'Variants roadmap', 'state': 'active',
                    'members': [{'name': 'browser', 'package': 'browser', 'workspace': 'fixture', 'status': 'ready'}],
                    'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0}, 'next': 'browser',
                    'coverage': {'state': 'complete', 'reasons': []}}
            planned = {'workspace': 'fixture', 'package': package, 'package_ref': 'fixture/browser',
                       'source_paths': ['spec.md', 'work-tour.html'], 'obligation': 'Prepare the specs variants overview',
                       'step_count': 5, 'prepared': False, 'preparation': {'outcome': 'missing'},
                       'epic': {'epic': 'variants-roadmap', 'workspace': 'fixture'},
                       'targets': [{'id': 'main', 'primary': receipt['checkout']}]}
            state['value'] = variant_envelope(planned=[planned], epics=[epic])
            open_route('specs', ws='fixture', filter='planned', id=planned_key)
            expect(page.locator('.object-head h2')).to_have_text('browser')
            expect(page.locator('#spec-readiness')).to_have_attribute('data-state', 'incomplete')
            expect(page.locator('#spec-readiness [data-fact=prepared-steps]')).to_contain_text('5')
            expect(page.locator('#spec-readiness [data-fact=preparation-report]')).to_contain_text('Missing')
            expect(page.locator('#spec-readiness [data-fact=preparation-report]')).to_contain_text('No preparation report was observed')
            expect(page.locator('#spec-readiness .ds-callout.warning')).to_contain_text('Implementation is unavailable until preparation completes')
            expect(page.locator('#spec-readiness .ds-callout.warning')).to_contain_text('The preparation report is missing or not confirmed')
            expect(page.locator('#spec-readiness .table-wrap')).to_contain_text('Variants roadmap')
            expect(page.locator('#spec-readiness .table-wrap')).to_contain_text('member 1 of 1')
            expect(page.locator('#planned-assignment')).to_have_count(0)
            expect(page.locator('#spec-readiness-actions .ds-btn--primary')).to_have_count(1)
            expect(page.get_by_role('button', name='Resume planning', exact=True)).to_be_enabled()
            open_files = page.locator('.detail-actions').get_by_role('button', name='Open spec files', exact=True)
            expect(open_files).to_be_enabled()
            assert 'ds-btn--primary' not in (open_files.get_attribute('class') or ''), open_files.get_attribute('class')
            report['scenarios'].append('Ready Overview shows the observed readiness facts, the related epic row and one Resume planning primary with files as a secondary action')
            capture_both('planned')
            page.get_by_role('navigation', name='Spec sections').get_by_role('button', name='Activity', exact=True).click()
            expect(page.locator('.detail-body')).to_contain_text('No run recorded')
            expect(page.locator('.detail-body')).not_to_contain_text('Elapsed')
            expect(page.locator('.detail-body .facts')).to_have_count(0)
            report['scenarios'].append('Planned Activity states that no run is recorded without run facts')

            design_screens = Path(os.environ['SENTINEL_DESIGN_SCREENS']) if os.environ.get('SENTINEL_DESIGN_SCREENS') else evidence.resolve().parent.parent.parent / 'designs' / 'app-ui' / 'screens'
            source = design_screens / '13-spec-completed.html'
            if not source.exists():
                report.setdefault('referenceMissing', []).append('13-spec-completed')
            else:
                for width in (1280, 1600):
                    reference = context.new_page()
                    reference.set_viewport_size({'width': width, 'height': 800})
                    reference.goto(source.as_uri(), wait_until='domcontentloaded')
                    reference.wait_for_timeout(200)
                    path = evidence / 'reference' / f'13-spec-completed-{width}.png'
                    reference.screenshot(path=str(path), full_page=True)
                    reference.close()
                    report.setdefault('referenceCaptures', []).append(str(path))

        if case == 'specs-activity':
            (evidence / 'screens').mkdir(parents=True, exist_ok=True)
            (evidence / 'reference').mkdir(parents=True, exist_ok=True)
            now = '2026-10-12T12:00:00.000Z'
            observed = '2026-10-12T11:59:00.000Z'
            package = receipt['package']
            record_key = json.dumps(['fixture', package, 'run-1'], separators=(',', ':'))
            state = {'value': None, 'active': False, 'fail': False}

            def on_state(route):
                if state['fail']:
                    route.fulfill(status=503, json={'error': 'fixture-state-failure'})
                elif state['active']:
                    route.fulfill(json=state['value'])
                else:
                    route.continue_()

            page.route('**/api/state**', on_state)

            def capture(name, width):
                page.set_viewport_size({'width': width, 'height': 800})
                path = evidence / 'screens' / f'specs-activity-{name}-{width}.png'
                page.screenshot(path=str(path), full_page=True)
                report.setdefault('captures', []).append(str(path))

            def capture_both(name):
                capture(name, 1280)
                capture(name, 1600)

            def envelope(runs, coverage_at=observed, published_at=now, coverage_state='complete', coverage_reasons=None,
                         omitted=None, completion_history=None):
                coverage = {'state': coverage_state, 'observed_at': coverage_at, 'reasons': coverage_reasons or []}
                if omitted is not None:
                    coverage['omitted'] = omitted
                snapshot = {'workspace': 'fixture', 'coverage': coverage, 'runs': list(runs),
                            'recently_completed': [], 'planned_packages': [],
                            'assignments': [], 'assignment_coverage': {'state': 'complete', 'reasons': []}, 'epics': []}
                if completion_history is not None:
                    snapshot['completion_history'] = completion_history
                return {'schema_version': 1, 'generated_at': now,
                        'observers': [{'observer_id': 'activity-fixture', 'state': 'observing',
                                       'published_at': published_at, 'snapshot': snapshot}]}

            def activity_run(**extra):
                value = {
                    'workspace': 'fixture', 'package': package, 'package_ref': 'fixture/browser',
                    'assignment_id': 'run-1', 'workflow_id': 'workflow-1', 'execution': 'running',
                    'workflow_state': 'working', 'is_current_assignment': True,
                    'activity': 'Building the dashboard', 'obligation': 'Keep editors stable',
                    'observed_at': observed, 'coverage': {'state': 'complete', 'reasons': []},
                    'spec_progress': {'current_position': 2, 'total_steps': 5, 'current_name': 'Resolve worker identity'},
                    'timing': {'started_at': '2026-10-12T11:00:00.000Z', 'attempts': [
                        {'step': 2, 'name': 'Resolve worker identity', 'state': 'failed', 'attempt_kind': 'implementation',
                         'started_at': '2026-10-12T11:30:00.000Z'},
                        {'step': 2, 'name': 'Resolve worker identity', 'state': 'running', 'attempt_kind': 'launch-retry',
                         'started_at': '2026-10-12T11:58:00.000Z'},
                        {'step': 1, 'name': 'Bound catalog reads', 'state': 'completed', 'attempt_kind': 'implementation',
                         'started_at': '2026-10-12T11:00:00.000Z', 'finished_at': '2026-10-12T11:02:00.000Z'},
                    ]},
                    'workflow_workers': [{'kind': 'Owner', 'id': 'a71d0c82', 'state': 'running'}],
                    'workflow_observed_at': observed,
                    'evidence': {'state': 'recorded', 'verdict': 'ready', 'commit': 'abc123', 'source': 'work-tour.html'},
                    'conditions': [{'kind': 'worker-lease', 'state': 'open', 'severity': 'attention', 'summary': 'Worker lease unavailable'}],
                    'incidents': [{'kind': 'focused-verification', 'state': 'open', 'summary': 'Focused verification retained'}],
                    'actions': [{'action': 'inspect-assignment', 'summary': 'Inspect the exact assignment identity before dispatch'}],
                    'source_paths': [package + '/spec.md', '/other/source.md'],
                }
                value.update(extra)
                return value

            attempt_rows = lambda: page.locator('section').filter(has=page.get_by_role('heading', name='Step attempts', exact=True)).locator('tbody tr')
            worker_section = lambda: page.locator('section').filter(has=page.get_by_role('heading', name='Unfinished worker', exact=True))

            # Cold Activity: the delayed shared read shows the table skeleton, not a worker failure.
            control('state-delay-ms', 1200)
            cold_started = time.monotonic()
            open_route('specs', ws='fixture', id=record_key, tab='activity')
            page.wait_for_timeout(150)
            assert page.locator('.detail-body .skeletons').count() == 0, 'Activity skeleton rendered before 300ms'
            expect(page.locator('.object-head h2')).to_have_text('browser')
            page.locator('.detail-body .skeletons').first.wait_for(timeout=5000)
            cold_elapsed = time.monotonic() - cold_started
            assert cold_elapsed >= 0.3, f'Activity skeleton appeared after {cold_elapsed:.2f}s'
            capture_both('loading')
            control('state-delay-ms', 0)
            expect(page.locator('.detail-body')).to_contain_text('Evidence')
            report['scenarios'].append('Cold Activity link shows the delayed table skeleton and the shared-snapshot Activity body')

            # Primary recorded activity from the controlled snapshot.
            primary = envelope([activity_run()], coverage_at=now, published_at=now)
            state['value'] = primary
            state['active'] = True
            page.reload()
            rows = attempt_rows()
            expect(rows).to_have_count(3)
            expect(rows.nth(0)).to_contain_text('Attempt 1 · implementation')
            expect(rows.nth(0)).to_contain_text('Unknown')
            expect(rows.nth(1)).to_contain_text('Attempt 2 · launch-retry')
            expect(rows.nth(1)).to_contain_text('2m 0s elapsed')
            expect(rows.nth(2)).to_contain_text('Step 1 · Bound catalog reads')
            expect(rows.nth(2)).to_contain_text('2m 0s')
            expect(worker_section()).to_contain_text('Owner')
            expect(worker_section()).to_contain_text('a71d0c82')
            expect(worker_section()).to_contain_text('Checkpoint')
            detail = page.locator('.detail-body')
            expect(detail).to_contain_text('Declared ready at commit abc123')
            expect(detail).to_contain_text('Acceptance not established')
            expect(detail).to_contain_text('Accepted-step completion was not observed.')
            expect(detail).to_contain_text('Worker lease unavailable')
            expect(detail).to_contain_text('Focused verification retained')
            expect(detail).to_contain_text('inspect-assignment')
            expect(page.locator('.detail-actions').get_by_role('button', name='Open work tour', exact=True)).to_be_enabled()
            report['scenarios'].append('Recorded attempts show per-step reasons, numeric durations, terminal-missing Unknown, worker checkpoint and declared evidence with the acceptance caveat')
            capture_both('primary')
            worker_section().first.evaluate('(el) => el.scrollIntoView({ block: "start" })')
            capture_both('primary-middle')
            page.locator('.detail-body').evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
            capture_both('primary-lower')

            # Stale observation with a fresh heartbeat: retained durations stay fixed.
            state['value'] = envelope([activity_run()], coverage_at=observed, published_at=now)
            page.reload()
            expect(rows.nth(1)).to_contain_text('1m 0s elapsed')
            stale_duration = rows.nth(1).locator('td.numeric').inner_text()
            assert stale_duration == '1m 0s elapsed', stale_duration
            page.locator('.detail-body').evaluate('(el) => { el.scrollTop = 0; }')
            capture_both('stale')
            page.wait_for_timeout(1100)
            assert rows.nth(1).locator('td.numeric').inner_text() == stale_duration, 'retained Activity duration advanced with the clock'
            report['scenarios'].append('Stale observation with a fresh heartbeat keeps ongoing attempt durations fixed as the clock advances')

            state['value'] = envelope([activity_run()], coverage_at='2026-10-12T12:00:30.000Z', published_at='2026-10-12T12:00:30.000Z')
            page.reload()
            resumed = rows.nth(1).locator('td.numeric').inner_text()
            assert resumed != stale_duration and 'elapsed' in resumed, resumed
            expect(rows.nth(1).locator('td.numeric')).not_to_have_text(resumed, timeout=3000)
            report['scenarios'].append('A fresh subsequent observation resumes and ticks the ongoing attempt duration')

            # In-package source path opens the real Files reader; external path stays text.
            state['value'] = primary
            page.reload()
            coverage = page.locator('#spec-coverage')
            expect(coverage).to_have_js_property('open', True)
            expect(coverage).to_contain_text('Run coverage')
            expect(coverage).to_contain_text('omitted unknown')
            packaged = coverage.get_by_role('button').filter(has_text=package + '/spec.md')
            expect(packaged).to_have_count(1)
            expect(coverage.get_by_role('button').filter(has_text='/other/source.md')).to_have_count(0)
            expect(coverage).to_contain_text('/other/source.md')
            packaged.click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params()['source'] == ['package'] and params()['id'] == [package] and params()['path'] == ['spec.md'], page.url
            viewer('spec.md', 'Browser specification')
            page.go_back()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(page.get_by_role('navigation', name='Spec sections').get_by_role('button', name='Activity', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('#spec-coverage')).to_have_js_property('open', True)
            report['scenarios'].append('In-package source path opens the real package Files reader and Back restores open Activity coverage; an external path stays plain text')

            # Retained offline failure keeps attempts and durations and recovers through Retry connection.
            state['fail'] = True
            page.locator('button:has-text("Refresh state")').first.click()
            expect(page.locator('.detail-body').get_by_text('Connection unavailable')).to_be_visible()
            expect(rows).to_have_count(3)
            offline_duration = rows.nth(1).locator('td.numeric').inner_text()
            assert offline_duration == '2m 0s elapsed', offline_duration
            page.wait_for_timeout(1100)
            assert rows.nth(1).locator('td.numeric').inner_text() == offline_duration, 'offline duration advanced with the clock'
            expect(rows.nth(2)).to_contain_text('2m 0s')
            expect(page.locator('.detail-actions').get_by_role('button', name='Retry connection', exact=True)).to_be_visible()
            capture_both('offline')
            state['fail'] = False
            page.locator('.detail-actions').get_by_role('button', name='Retry connection', exact=True).click()
            expect(page.locator('.detail-body').get_by_text('Connection unavailable')).to_have_count(0)
            report['scenarios'].append('Retained offline failure keeps attempts and durations visible and recovers through Retry connection')

            # Empty receipt keeps the obligation and the canonical spec action without acceptance.
            empty_run = {'workspace': 'fixture', 'package': package, 'package_ref': 'fixture/browser',
                         'assignment_id': 'run-1', 'execution': 'running', 'workflow_state': 'working',
                         'is_current_assignment': True, 'activity': 'Building the dashboard',
                         'obligation': 'Keep editors stable', 'observed_at': observed,
                         'coverage': {'state': 'complete', 'reasons': []},
                         'timing': {'started_at': '2026-10-12T11:00:00.000Z', 'attempts': []}}
            state['value'] = envelope([empty_run], coverage_at=now, published_at=now)
            open_route('specs', ws='fixture', id=record_key, tab='activity')
            detail = page.locator('.detail-body')
            expect(detail.get_by_role('heading', name='No attempts recorded', exact=True)).to_be_visible()
            expect(detail).to_contain_text('Keep editors stable')
            expect(detail).not_to_contain_text('Acceptance not established')
            spec_action = detail.get_by_role('button', name='Open spec file', exact=True)
            expect(spec_action).to_be_visible()
            capture_both('empty')
            page.locator('.detail-body').evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
            capture_both('empty-lower')
            spec_action.click()
            expect(page.locator('h1')).to_have_text('Files')
            viewer('spec.md', 'Browser specification')
            page.go_back()
            expect(page.get_by_role('navigation', name='Spec sections').get_by_role('button', name='Activity', exact=True)).to_have_attribute('aria-pressed', 'true')
            report['scenarios'].append('Empty activity retains the obligation and opens the canonical spec file without asserting acceptance')

            # Partial run and scope coverage: Inspect coverage from Overview switches and focuses.
            partial_run = activity_run(coverage={'state': 'partial', 'reasons': ['checkout unavailable']})
            state['value'] = envelope([partial_run], coverage_at=now, coverage_state='partial', coverage_reasons=['scan limit'],
                                      omitted=3, completion_history={'omitted': 2, 'reasons': ['history cap']})
            open_route('specs', ws='fixture', id=record_key)
            inspect = page.locator('.detail-actions').get_by_role('button', name='Inspect coverage', exact=True)
            expect(inspect).to_be_visible()
            assert 'ds-btn--primary' in (inspect.get_attribute('class') or ''), inspect.get_attribute('class')
            inspect.click()
            assert params()['tab'] == ['activity'], page.url
            page.wait_for_function("() => document.activeElement && document.activeElement.id === 'spec-coverage'")
            coverage = page.locator('#spec-coverage')
            expect(coverage).to_have_js_property('open', True)
            detail = page.locator('.detail-body')
            expect(detail).to_contain_text('Evidence coverage incomplete')
            expect(detail).to_contain_text('scan limit')
            expect(detail).to_contain_text('checkout unavailable')
            expect(coverage).to_contain_text('omitted 3')
            expect(coverage).to_contain_text('omitted 2')
            expect(coverage).to_contain_text('history cap')
            capture_both('partial')
            page.locator('.detail-body').evaluate('(el) => { el.scrollTop = 0; }')
            capture_both('partial-top')
            report['scenarios'].append('Partial run and scope reasons plus omission counts stay visible; Inspect coverage switches to Activity and focuses the open disclosure')

            # Cold read failure names the read, not a worker failure, and retries the shared read.
            state['fail'] = True
            page.reload()
            detail = page.locator('.detail-body')
            expect(detail.get_by_role('heading', name='Activity could not be read', exact=True)).to_be_visible()
            expect(detail).to_contain_text('does not establish that the worker failed')
            capture_both('error')
            state['fail'] = False
            detail.get_by_role('button', name='Retry activity', exact=True).click()
            expect(detail.get_by_role('heading', name='Activity could not be read', exact=True)).to_have_count(0)
            report['scenarios'].append('Cold Activity read failure never claims worker failure and retries from the shared read')

            # Imported snapshot: retained attempt durations stay fixed.
            imported = envelope([activity_run()], coverage_at=observed, published_at=now)
            page.locator('#import-file').set_input_files({'name': 'specs-activity-import.json', 'mimeType': 'application/json', 'buffer': json.dumps(imported).encode()})
            imported_row = page.locator('.records button.record[data-key]').first
            expect(imported_row).to_have_attribute('aria-pressed', 'true')
            page.get_by_role('navigation', name='Spec sections').get_by_role('button', name='Activity', exact=True).click()
            imported_rows = attempt_rows()
            expect(imported_rows).to_have_count(3)
            imported_duration = imported_rows.nth(1).locator('td.numeric').inner_text()
            assert '1m 0s' in imported_duration, imported_duration
            page.wait_for_timeout(1100)
            assert imported_rows.nth(1).locator('td.numeric').inner_text() == imported_duration, 'imported duration advanced with the clock'
            capture_both('imported')
            report['scenarios'].append('Imported snapshot waits for the selected row, opens Activity and keeps attempt durations fixed')

            design_screens = Path(os.environ['SENTINEL_DESIGN_SCREENS']) if os.environ.get('SENTINEL_DESIGN_SCREENS') else evidence.resolve().parent.parent.parent / 'designs' / 'app-ui' / 'screens'
            for screen in ('02-spec-activity', '34-spec-activity-empty', '35-spec-activity-loading', '36-spec-activity-error',
                           '37-spec-activity-partial', '38-spec-activity-offline', '39-spec-activity-stale'):
                source = design_screens / f'{screen}.html'
                if not source.exists():
                    report.setdefault('referenceMissing', []).append(screen)
                    continue
                for width in (1280, 1600):
                    reference = context.new_page()
                    reference.set_viewport_size({'width': width, 'height': 800})
                    reference.goto(source.as_uri(), wait_until='domcontentloaded')
                    reference.evaluate('document.fonts.ready')
                    path = evidence / 'reference' / f'{screen}-{width}.png'
                    reference.screenshot(path=str(path), full_page=True)
                    reference.close()
                    report.setdefault('referenceCaptures', []).append(str(path))

        if case == 'specs-list':
            (evidence / 'screens').mkdir(parents=True, exist_ok=True)
            now = '2026-10-12T12:00:00.000Z'
            state = {'value': None, 'active': False, 'fail': False}

            def on_state(route):
                if state['fail']:
                    route.fulfill(status=503, json={'error': 'fixture-state-failure'})
                elif state['active']:
                    route.fulfill(json=state['value'])
                else:
                    route.continue_()

            page.route('**/api/state**', on_state)
            rows = page.locator('.records button.record[data-key]')

            def capture(name, width):
                page.set_viewport_size({'width': width, 'height': 800})
                path = evidence / 'screens' / f'specs-{name}-{width}.png'
                page.screenshot(path=str(path), full_page=True)
                report.setdefault('captures', []).append(str(path))

            def capture_both(name):
                capture(name, 1280)
                capture(name, 1600)

            def record(workspace, slug, **extra):
                value = {'workspace': workspace, 'package': f'/fixture/specs/{slug}', 'package_ref': f'{workspace}/{slug}',
                         'assignment_id': f'{slug}-assignment', 'execution': 'running', 'workflow_state': 'working',
                         'is_current_assignment': True, 'activity': f'{slug} activity', 'obligation': f'{slug} obligation',
                         'observed_at': now, 'coverage': {'state': 'complete', 'reasons': []},
                         'spec_progress': {'current_position': 1, 'total_steps': 2, 'current_name': 'List step'}}
                value.update(extra)
                return value

            def observer(observer_id, workspace, runs, coverage_state='complete', observed_at=now, reasons=None):
                return {'observer_id': observer_id, 'state': 'observing', 'published_at': now,
                        'snapshot': {'workspace': workspace,
                                     'coverage': {'state': coverage_state, 'observed_at': observed_at, 'reasons': reasons or []},
                                     'runs': runs, 'recently_completed': [], 'planned_packages': [],
                                     'assignments': [], 'assignment_coverage': {'state': 'complete', 'reasons': []}, 'epics': []}}

            def fixture_snapshot(runs, recently=None, planned=None, coverage_state='complete', observed_at=now, reasons=None, extra_observers=()):
                primary = observer('list-fixture', 'fixture', runs, coverage_state, observed_at, reasons)
                primary['snapshot']['recently_completed'] = recently or []
                primary['snapshot']['planned_packages'] = planned or []
                return {'schema_version': 1, 'generated_at': now, 'observers': [primary, *extra_observers]}

            active_healthy = record('fixture', 'healthy-a')
            blocked_z = record('fixture', 'blocked-z', workflow_state='blocked', activity='Blocked z activity')
            done_c = record('fixture', 'done-c', is_current_assignment=False, execution='completed', workflow_state='complete', completion_basis='manual', completed_at=now)
            planned_d = {'workspace': 'fixture', 'package': '/fixture/specs/planned-d', 'package_ref': 'fixture/planned-d', 'source_paths': ['spec.md']}
            unmapped_e = record('unmapped-repo', 'unmapped-e')

            # Loading: the fixture delays /api/state so the skeleton must wait for 300ms.
            control('state-delay-ms', 1200)
            started = time.monotonic()
            open_route('specs', ws='fixture')
            page.wait_for_timeout(150)
            assert page.locator('.records .skeletons').count() == 0, 'skeleton rendered before 300ms'
            expect(page.locator('.list-caption')).to_have_text('Reading specs…')
            page.locator('.records .skeletons').first.wait_for(timeout=5000)
            elapsed = time.monotonic() - started
            assert elapsed >= 0.3, f'skeleton appeared after {elapsed:.2f}s'
            capture_both('loading')
            expect(rows).to_have_count(1)
            control('state-delay-ms', 0)
            report['scenarios'].append('Delayed state read shows Reading specs, skeleton after 300ms, then rows')

            # Filter, search, caption and App fallback share one attention-first result.
            state['active'] = True
            state['value'] = fixture_snapshot([active_healthy, blocked_z], recently=[done_c], planned=[planned_d],
                                              extra_observers=[observer('unmapped-observer', 'unmapped-repo', [unmapped_e])])
            page.reload()
            expect(rows).to_have_count(2)
            expect(rows.first.locator('.run-title')).to_have_text('blocked-z')
            expect(rows.nth(1).locator('.run-title')).to_have_text('healthy-a')
            expect(page.locator('.list-caption')).to_have_text('Active · 2 observed specs')
            expect(page.locator('.object-head h2')).to_have_text('blocked-z')
            capture_both('list')
            report['scenarios'].append('Active rows, caption and App selection fallback share the attention-first order')

            page.locator('#find-record').fill('healthy')
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('healthy-a')
            expect(page.locator('.list-caption')).to_have_text('Active · 1 observed specs')
            expect(page.locator('.object-head h2')).to_have_text('healthy-a')
            assert params()['q'] == ['healthy'], page.url
            page.locator('#find-record').fill('')

            filters = page.get_by_role('navigation', name='Package filters')
            filters.get_by_role('button', name='Blocked', exact=True).click()
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('blocked-z')
            expect(page.locator('.list-caption')).to_have_text('Blocked · 1 observed specs')
            filters.get_by_role('button', name='Done', exact=True).click()
            expect(rows.first.locator('.run-title')).to_have_text('done-c')
            expect(page.locator('.list-caption')).to_have_text('Done · 1 observed specs')
            filters.get_by_role('button', name='Ready', exact=True).click()
            expect(rows.first.locator('.run-title')).to_have_text('planned-d')
            expect(page.locator('.list-caption')).to_have_text('Prepared, not started · 1 specs')

            for key, label, slug in [('attention', 'Blocked', 'blocked-z'), ('completed', 'Done', 'done-c'), ('planned', 'Ready', 'planned-d')]:
                open_route('specs', ws='fixture', filter=key)
                expect(filters.get_by_role('button', name=label, exact=True)).to_have_attribute('aria-pressed', 'true')
                expect(rows.first.locator('.run-title')).to_have_text(slug)
            report['scenarios'].append('Legacy attention, completed and planned links select their renamed filters and rows')

            open_route('specs')
            expect(rows).to_have_count(3)
            expect(page.locator('main')).to_contain_text('unmapped-repo')
            open_route('specs', ws='fixture')
            expect(page.locator('main')).not_to_contain_text('unmapped-e')
            report['scenarios'].append('All workspaces keeps the unmapped repository row; a concrete scope hides it')

            open_route('specs', ws='fixture', filter='planned')
            page.locator('#find-record').fill('no-such-spec')
            expect(rows).to_have_count(0)
            expect(page.locator('.list-caption')).to_have_text('0 matching specs')
            expect(page.get_by_role('heading', name='No matching specs', exact=True)).to_be_visible()
            capture_both('no-match')
            page.get_by_role('button', name='Clear filters', exact=True).click()
            expect(rows).to_have_count(2)
            assert 'q' not in params() and 'filter' not in params(), page.url
            report['scenarios'].append('Clear filters removes query and filter in one navigation')

            state['value'] = fixture_snapshot([])
            page.reload()
            expect(rows).to_have_count(0)
            expect(page.locator('.list-caption')).to_have_text('No specs recorded')
            expect(page.get_by_role('heading', name='No observed specs', exact=True)).to_be_visible()
            expect(page.locator('.records').get_by_role('button', name='Refresh state', exact=True)).to_be_visible()
            capture_both('empty')
            report['scenarios'].append('Healthy empty scope renders the named empty state, not a failure')

            state['value'] = fixture_snapshot([], coverage_state='unavailable', reasons=['checkout unavailable'])
            page.reload()
            expect(page.get_by_role('heading', name='No observed specs', exact=True)).to_be_visible()
            incomplete = page.locator('.records .ds-callout').filter(has_text='Observation incomplete')
            expect(incomplete).to_be_visible()
            expect(incomplete).to_contain_text('checkout unavailable')
            capture_both('partial-empty')
            report['scenarios'].append('Unavailable scope coverage with zero rows still discloses Observation incomplete')

            state['value'] = fixture_snapshot([active_healthy], coverage_state='partial', reasons=['scan limit'])
            page.reload()
            expect(rows).to_have_count(1)
            expect(page.locator('.records .ds-callout').filter(has_text='Observation incomplete')).to_be_visible()
            capture_both('partial-rows')

            stale_coverage = '2026-10-12T10:00:00.000Z'
            stale_activity = '2026-10-12T09:58:00.000Z'
            state['value'] = fixture_snapshot([record('fixture', 'stale-b', observed_at=stale_activity)], observed_at=stale_coverage)
            page.reload()
            expect(rows).to_have_count(1)
            expect(page.locator('.records .ds-callout').filter(has_text='Observation needs refreshing')).to_be_visible()
            age_text = rows.first.locator('small').inner_text()
            assert '2m 0s before observation' in age_text, age_text
            page.wait_for_timeout(1500)
            assert rows.first.locator('small').inner_text() == age_text, 'retained age advanced with the clock'
            capture_both('stale')
            report['scenarios'].append('Old coverage with a fresh heartbeat is stale and its row age stays fixed as the clock advances')

            # Complete coverage does not imply fresh (or available) observation times.
            open_route('specs')
            for label, observation_time, reason in [
                ('mixed-stale', stale_coverage, 'observation stale'),
                ('mixed-missing', None, 'observation unavailable'),
                ('mixed-invalid', 'invalid-time', 'observation unavailable'),
            ]:
                for has_rows in (True, False):
                    state['value'] = fixture_snapshot(
                        [active_healthy] if has_rows else [],
                        extra_observers=[observer('old-observer', 'old-scope',
                                                  [record('old-scope', 'old-b')] if has_rows else [],
                                                  observed_at=observation_time)])
                    page.reload()
                    expect(rows).to_have_count(2 if has_rows else 0)
                    diagnostics = page.locator('.records .ds-callout').filter(has_text='Observation diagnostics')
                    expect(diagnostics).to_be_visible()
                    expect(diagnostics).to_contain_text(f'old-scope {reason}')
                    expect(page.locator('.records .ds-callout').filter(has_text='Observation incomplete')).to_have_count(0)
                    expect(diagnostics.get_by_role('button', name='Refresh state', exact=True)).to_be_visible()
                    if not has_rows:
                        expect(page.get_by_role('heading', name='No observed specs', exact=True)).to_be_visible()
                    capture_both(f'{label}-{"rows" if has_rows else "empty"}')

            state['value'] = fixture_snapshot([], observed_at=None)
            page.reload()
            diagnostics = page.locator('.records .ds-callout').filter(has_text='Observation diagnostics')
            expect(diagnostics).to_contain_text('fixture observation unavailable')
            expect(rows).to_have_count(0)
            expect(page.locator('.records .ds-callout').filter(has_text='Observation incomplete')).to_have_count(0)
            capture_both('missing-time-empty')
            state['value'] = fixture_snapshot([active_healthy])
            diagnostics.get_by_role('button', name='Refresh state', exact=True).click()
            expect(rows).to_have_count(1)
            expect(diagnostics).to_have_count(0)
            report['scenarios'].append('Complete mixed fresh/stale and missing/invalid observation times expose scope-labelled reasons with rows or zero rows; no valid timestamp still shows diagnostics and Refresh state recovers without claiming incomplete coverage')
            open_route('specs', ws='fixture')

            state['value'] = fixture_snapshot([record('fixture', 'offline-f', observed_at='2026-10-12T11:58:00.000Z')])
            page.reload()
            expect(rows).to_have_count(1)
            state['fail'] = True
            page.locator('button:has-text("Refresh state")').first.click()
            expect(page.locator('.records .ds-callout').filter(has_text='Connection lost')).to_be_visible()
            expect(rows).to_have_count(1)
            expect(page.locator('.detail-actions').get_by_role('button', name='Mark complete', exact=True)).to_be_disabled()
            expect(page.locator('#completion-help')).to_contain_text('Reconnect to the live dashboard')
            offline_age = rows.first.locator('small').inner_text()
            assert '2m 0s before observation' in offline_age, offline_age
            page.wait_for_timeout(1500)
            assert rows.first.locator('small').inner_text() == offline_age, 'offline age advanced'
            capture_both('offline')
            state['fail'] = False
            page.locator('.records .ds-callout').filter(has_text='Connection lost').get_by_role('button', name='Retry connection', exact=True).click()
            expect(page.locator('.records .ds-callout').filter(has_text='Connection lost')).to_have_count(0)
            report['scenarios'].append('Offline retains rows and fixed ages and disables completion while failure is visible')

            state['fail'] = True
            state['value'] = fixture_snapshot([active_healthy])
            open_route('specs', ws='fixture')
            page.reload()
            expect(page.locator('.records .ds-callout').filter(has_text='Specs unavailable')).to_be_visible()
            expect(page.locator('.list-caption')).to_have_text('Last known catalog: Observations unavailable')
            capture_both('error')
            state['fail'] = False
            page.locator('.records').get_by_role('button', name='Retry state', exact=True).click()
            expect(rows).to_have_count(1)
            report['scenarios'].append('Initial read failure shows Specs unavailable and retry renders rows')

            imported = fixture_snapshot([record('fixture', 'imported-g', observed_at='2026-10-12T09:20:00.000Z')], observed_at='2026-10-12T09:30:00.000Z')
            imported['generated_at'] = '2026-10-12T09:30:00.000Z'
            page.locator('#import-file').set_input_files({'name': 'specs-list-import.json', 'mimeType': 'application/json', 'buffer': json.dumps(imported).encode()})
            expect(rows).to_have_count(1)
            imported_age = rows.first.locator('small').inner_text()
            assert '10m 0s before observation' in imported_age, imported_age
            page.wait_for_timeout(1500)
            assert rows.first.locator('small').inner_text() == imported_age, 'imported age advanced'
            expect(page.locator('.detail-actions').get_by_role('button', name='Mark complete', exact=True)).to_be_disabled()
            expect(page.locator('#completion-help')).to_contain_text('Completion is available on the live dashboard')
            capture_both('imported')
            report['scenarios'].append('Imported rows render fixed before-observation ages and keep mutation controls unavailable')

        if case == 'specs-workspace':
            # Real fixture catalog and detail endpoints stay in place; only the
            # observer payload is crafted. The fixture seeds two workspaces
            # whose kit id differs from their directory basename, so a run's
            # workspace value resolves through its mapped catalog entry rather
            # than being loaded as an id.
            now = '2026-10-12T12:00:00.000Z'
            state = {'value': None, 'active': False}

            def on_state(route):
                if state['active']:
                    route.fulfill(json=state['value'])
                else:
                    route.continue_()

            page.route('**/api/state**', on_state)
            rows = page.locator('.records button.record[data-key]')
            detail_requests = []

            def observe_request(request):
                if '/api/workspace?' in request.url:
                    detail_requests.append(request.url)

            page.on('request', observe_request)
            errors_before = len(report['pageErrors'])

            def record(workspace, slug, **extra):
                value = {'workspace': workspace, 'package': f'/fixture/specs/{slug}', 'package_ref': f'{workspace}/{slug}',
                         'assignment_id': f'{slug}-assignment', 'execution': 'running', 'workflow_state': 'working',
                         'is_current_assignment': True, 'activity': f'{slug} activity', 'obligation': f'{slug} obligation',
                         'observed_at': now, 'coverage': {'state': 'complete', 'reasons': []},
                         'spec_progress': {'current_position': 1, 'total_steps': 2, 'current_name': 'Workspace step'}}
                value.update(extra)
                return value

            def observer(observer_id, workspace, runs, coverage_state='complete', observed_at=now, reasons=None):
                return {'observer_id': observer_id, 'state': 'observing', 'published_at': now,
                        'snapshot': {'workspace': workspace,
                                     'coverage': {'state': coverage_state, 'observed_at': observed_at, 'reasons': reasons or []},
                                     'runs': runs, 'recently_completed': [], 'planned_packages': [],
                                     'assignments': [], 'assignment_coverage': {'state': 'complete', 'reasons': []}, 'epics': []}}

            def fixture_snapshot(runs, coverage_state='complete', observed_at=now, reasons=None):
                return {'schema_version': 1, 'generated_at': now,
                        'observers': [observer('workspace-fixture', 'fixture', runs, coverage_state, observed_at, reasons)]}

            # The fixture maps directory basename physical -> kit id alpha and
            # directory basename alpha -> kit id physical.
            physical_dir_run = record('physical', 'alpha-run')
            alpha_dir_run = record('alpha', 'physical-run')
            unmapped_run = record('unmapped-repo', 'unmapped-run')
            state['active'] = True
            state['value'] = fixture_snapshot([physical_dir_run, alpha_dir_run, unmapped_run])
            open_route('specs')
            expect(rows).to_have_count(3)
            # Real HTTP inventory proves each route-scope id names a real kit.
            alpha_inventory = context.request.get(receipt['url'] + '/api/workspace?id=alpha').json()
            assert alpha_inventory['id'] == 'alpha', alpha_inventory
            assert alpha_inventory['directory'].rstrip('/').rsplit('/', 1)[-1] == 'physical', alpha_inventory
            physical_inventory = context.request.get(receipt['url'] + '/api/workspace?id=physical').json()
            assert physical_inventory['id'] == 'physical', physical_inventory
            assert physical_inventory['directory'].rstrip('/').rsplit('/', 1)[-1] == 'alpha', physical_inventory
            report['scenarios'].append('Real inventory confirms basename physical is kit id alpha and basename alpha is kit id physical')

            # Cold scoped Specs, distinct from selection: scope the route to a
            # valid catalog id whose directory basename matches no observed run.
            # A full document reload picks up a snapshot with zero rows in scope,
            # so no row can be auto-selected; only the route catalog id can
            # drive the workspace request, proving the cold route-catalog path.
            detail_requests.clear()
            open_route('specs', ws='alpha')
            state['value'] = fixture_snapshot([alpha_dir_run, unmapped_run])
            page.reload(wait_until='domcontentloaded')
            expect(rows).to_have_count(0)
            page.wait_for_timeout(500)
            assert 'ws' in params(), params()
            assert 'id' not in params(), params()
            assert any('id=alpha' in url for url in detail_requests), detail_requests
            report['scenarios'].append('Cold scoped Specs entry with no matching record loads the route catalog id')

            # Scoped Specs with an observed run in scope: the run's own
            # directory basename maps to the same route catalog entry, so the
            # request id matches the route id.
            detail_requests.clear()
            open_route('specs', ws='alpha')
            state['value'] = fixture_snapshot([physical_dir_run, alpha_dir_run, unmapped_run])
            page.reload(wait_until='domcontentloaded')
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('alpha-run')
            page.wait_for_timeout(500)
            assert any('id=alpha' in url for url in detail_requests), detail_requests
            rows.first.click()
            expect(page.locator('.object-head h2')).to_have_text('alpha-run')
            report['scenarios'].append('A scoped Spec with a differing directory basename loads the route catalog id from its mapped entry')

            # All-workspaces: no route ws; the record's own directory basename
            # resolves the sole matching catalog entry.
            detail_requests.clear()
            open_route('specs')
            expect(rows).to_have_count(3)
            rows.filter(has_text='alpha-run').first.click()
            page.wait_for_timeout(500)
            assert any('id=alpha' in url for url in detail_requests), detail_requests
            assert 'ws' not in params(), params()
            report['scenarios'].append('All-workspaces selection resolves the mapped catalog id without seeding route ws')

            # Unmapped: no catalog entry matches the record workspace, so no
            # workspace request is issued and the Spec detail stays readable.
            detail_requests.clear()
            rows.filter(has_text='unmapped-run').first.click()
            page.wait_for_timeout(500)
            expect(page.locator('.object-head h2')).to_have_text('unmapped-run')
            assert not detail_requests, detail_requests
            report['scenarios'].append('An unmapped record issues no workspace request and keeps the Spec detail readable')

            # Delayed A -> B: hold A's response, switch scope, select B, then
            # prove B's loaded workspace survives A's late arrival.
            detail_requests.clear()
            control('detail-delay-ms', 1500)
            control('detail-delay-id', 'alpha')
            open_route('specs', ws='alpha')
            expect(rows).to_have_count(1)
            page.wait_for_timeout(500)
            alpha_requests_before = sum(1 for url in detail_requests if 'id=alpha' in url)
            assert alpha_requests_before >= 1, detail_requests
            # Switch to B while A's response is held. B's directory basename is
            # alpha (its kit id is physical), so the resolved id stays physical.
            open_route('specs', ws='physical')
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('physical-run')
            page.wait_for_timeout(500)
            assert any('id=physical' in url for url in detail_requests), detail_requests
            # A's held response arrives now; B must remain the loaded record.
            page.wait_for_timeout(1600)
            open_route('workspaces', ws='physical')
            page.wait_for_timeout(500)
            expect(page.locator('.object-head p')).to_contain_text('alpha')
            assert sum(1 for url in detail_requests if 'id=alpha' in url) == alpha_requests_before, detail_requests
            control('detail-delay-ms', 0)
            control('detail-delay-id', '')
            assert len(report['pageErrors']) == errors_before, report['pageErrors'][errors_before:]
            report['scenarios'].append("A delayed stale workspace response never replaces B's loaded record, and B's Workspaces inventory stays readable")

            # Imported/offline reuses the App snapshot import path: the
            # retained unmapped record stays readable and asks the host for no
            # workspace detail.
            imported = fixture_snapshot([unmapped_run])
            page.locator('#import-file').set_input_files({'name': 'specs-workspace-import.json', 'mimeType': 'application/json', 'buffer': json.dumps(imported).encode()})
            open_route('specs')
            expect(rows).to_have_count(1)
            detail_requests.clear()
            rows.first.click()
            page.wait_for_timeout(400)
            expect(page.locator('.object-head h2')).to_have_text('unmapped-run')
            assert not detail_requests, detail_requests
            report['scenarios'].append('Imported offline snapshot keeps the unmapped Spec detail readable without workspace requests')

        if case == 'specs-relaunch':
            # Real fixture, App and polling stay in place; only /api/state is
            # annotated with the relaunch identity and the two relaunch endpoints
            # are fulfilled, so no agent, worktree or worker launches for real.
            (evidence / 'screens').mkdir(parents=True, exist_ok=True)
            package = receipt['package']
            record_key = json.dumps(['fixture', package, 'run-1'], separators=(',', ':'))
            run1_created = '2026-10-12T12:00:00.000Z'
            run2_created = '2026-10-12T13:00:00.000Z'
            preview_digest = 'specs-relaunch-digest'
            annotation = {'display': 'ended', 'second': False}
            held = {'hold': False, 'preview': None}
            previews, launches = [], []

            def annotate_state(route):
                value = route.fetch().json()
                for observer in value.get('observers', []):
                    snapshot = observer.get('snapshot') or {}
                    if not isinstance(snapshot.get('assignments'), list):
                        continue
                    rows = []
                    for assignment in snapshot['assignments']:
                        if assignment.get('assignment_id') != 'run-1':
                            rows.append(assignment)
                            continue
                        rows.append({**assignment, 'skill': 'spec-end-to-end', 'display': annotation['display'],
                                     'state': annotation['display'], 'created_at': run1_created})
                        if annotation['second']:
                            rows.append({**assignment, 'assignment_id': 'run-2', 'skill': 'spec-end-to-end',
                                         'display': 'ended', 'state': 'ended', 'created_at': run2_created})
                    snapshot['assignments'] = rows
                route.fulfill(json=value)

            def preview(route):
                previews.append(route.request.post_data_json)
                if held['hold']:
                    held['preview'] = route
                    return
                route.fulfill(json={'contractDigest': preview_digest,
                                    'record': {'execution_dir': '/fixture/relaunch-worktree', 'execution_branch': 'spec/browser-relaunch'}})

            def launch(route):
                launches.append(route.request.post_data_json)
                route.fulfill(json={'assignment': {'assignment_id': 'run-1', 'state': 'live'}})

            page.route('**/api/state**', annotate_state)
            page.route('**/api/assignment-session/relaunch-preview', preview)
            page.route('**/api/assignment-session/relaunch', launch)

            def refresh_state():
                with page.expect_response('**/api/state**'):
                    page.get_by_role('button', name='Refresh state', exact=True).first.click()

            def held_preview():
                for _ in range(40):
                    if held['preview'] is not None:
                        return held['preview']
                    page.wait_for_timeout(25)
                raise AssertionError('preview POST was not intercepted')

            def capture(name, width):
                page.set_viewport_size({'width': width, 'height': 800})
                path = evidence / 'screens' / f'specs-relaunch-{name}-{width}.png'
                page.screenshot(path=str(path), full_page=True)
                report.setdefault('captures', []).append(str(path))

            def capture_both(name):
                capture(name, 1280)
                capture(name, 1600)

            open_route('specs', ws='fixture', id=record_key)
            region = page.get_by_role('region', name='Relaunch spec')
            preview_button = region.get_by_role('button', name='Preview relaunch', exact=True)
            start_button = region.get_by_role('button', name='Start agent', exact=True)
            expect(preview_button).to_be_enabled()

            preview_button.click()
            expect(start_button).to_be_enabled()
            expect(region).to_contain_text('/fixture/relaunch-worktree')
            assert previews[-1]['assignment_id'] == 'run-1', previews
            retry_id = previews[-1]['retry_id']

            refresh_state()
            expect(start_button).to_be_enabled()
            expect(region).to_contain_text('/fixture/relaunch-worktree')
            assert len(previews) == 1, previews
            page.locator('.detail-body').evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
            capture_both('reviewed')
            report['scenarios'].append('Reviewed worktree and Start agent survive a refreshed snapshot object for the same assignment identity')

            annotation['display'] = 'live'
            refresh_state()
            expect(start_button).to_be_disabled()
            expect(region).to_contain_text('The agent is still running')
            annotation['display'] = 'ended'
            refresh_state()
            expect(start_button).to_be_enabled()
            expect(region).to_contain_text('/fixture/relaunch-worktree')
            report['scenarios'].append('A same-identity live display disables Start agent and an ended display re-enables it from reactive props with review retained')

            start_button.click()
            expect(region).to_contain_text('Agent started')
            assert launches[-1]['assignment_id'] == 'run-1', launches
            assert launches[-1]['retry_id'] == retry_id, launches
            assert launches[-1]['expectedDigest'] == preview_digest, launches
            report['scenarios'].append('Explicit launch reuses the preview retry_id and expectedDigest without worker activity')

            annotation['second'] = True
            refresh_state()
            expect(preview_button).to_be_enabled()
            expect(region).not_to_contain_text('/fixture/relaunch-worktree')
            expect(start_button).to_have_count(0)
            report['scenarios'].append('A newer assignment identity clears the previous review and remounts the relaunch control')

            # A pending preview outlives a same-identity refresh and settles.
            annotation['second'] = False
            page.reload()
            page.evaluate('sessionStorage.clear()')
            expect(preview_button).to_be_enabled()
            held['hold'] = True
            preview_button.click()
            expect(region.get_by_role('button', name='Preparing preview…', exact=True)).to_be_visible()
            pending = held_preview()
            refresh_state()
            expect(region.get_by_role('button', name='Preparing preview…', exact=True)).to_be_visible()
            held['hold'] = False
            pending.fulfill(json={'contractDigest': preview_digest,
                                  'record': {'execution_dir': '/fixture/relaunch-worktree', 'execution_branch': 'spec/browser-relaunch'}})
            held['preview'] = None
            expect(start_button).to_be_enabled()
            expect(region).to_contain_text('/fixture/relaunch-worktree')
            report['scenarios'].append('A pending preview survives a same-identity refresh and settles to Start agent')

            # A delayed preview reply for the replaced identity cannot retarget it.
            page.reload()
            page.evaluate('sessionStorage.clear()')
            expect(preview_button).to_be_enabled()
            held['hold'] = True
            preview_button.click()
            expect(region.get_by_role('button', name='Preparing preview…', exact=True)).to_be_visible()
            stale = held_preview()
            annotation['second'] = True
            refresh_state()
            expect(preview_button).to_be_enabled()
            held['hold'] = False
            held['preview'] = None
            with page.expect_response('**/api/assignment-session/relaunch-preview'):
                stale.fulfill(json={'contractDigest': 'specs-relaunch-stale-digest',
                                    'record': {'execution_dir': '/fixture/stale-worktree', 'execution_branch': 'spec/stale'}})
            # Bound the wait for the disposed instance's reply continuation before
            # asserting that the remounted control was not retargeted.
            page.wait_for_timeout(250)
            expect(preview_button).to_be_enabled()
            expect(region).not_to_contain_text('/fixture/stale-worktree')
            expect(start_button).to_have_count(0)
            report['scenarios'].append('A delayed preview reply for the replaced assignment identity cannot retarget the new control')

        assert not report['pageErrors'], report['pageErrors']
        context.close()
        browser.close()
        report['status'] = 'passed'
except BaseException:
    report['error'] = traceback.format_exc()
    raise
finally:
    fixture.terminate()
    try:
        fixture.wait(timeout=10)
    except subprocess.TimeoutExpired:
        fixture.kill()
        fixture.wait()
    report['elapsedSeconds'] = round(time.monotonic() - started, 3)
    filename = 'carried-loadcatalog-browser.json' if case == 'catalog' else 'files-context.json' if case == 'context' else 'final-review-member-browser.json' if case == 'member' else 'final-review-search-browser.json' if case == 'search' else 'sentinel-planned-filter-browser.json' if case == 'filters' else 'specs-list.json' if case == 'specs-list' else 'specs-workspace.json' if case == 'specs-workspace' else 'specs-variants.json' if case == 'specs-variants' else 'specs-overview.json' if case == 'specs-overview' else 'specs-activity.json' if case == 'specs-activity' else 'specs-relaunch.json' if case == 'specs-relaunch' else 'files-workspace.json' if case == 'files-workspace' else 'files-sources.json' if case == 'files-sources' else 'files-continuity.json' if case == 'files-continuity' else 'files-recovery.json' if case == 'files-recovery' else 'files-read-refresh.json' if case == 'files-read-refresh' else 'step-002-fix-browser.json'
    target = evidence / filename
    temporary = target.with_name(target.name + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    os.replace(temporary, target)
    if case == 'context':
        qa_target = evidence / 'qa-files.md'
        qa_temporary = qa_target.with_name(qa_target.name + '.tmp')
        qa_temporary.write_text(QA_FILES_TOUR)
        os.replace(qa_temporary, qa_target)
    print(json.dumps(report, indent=2))
