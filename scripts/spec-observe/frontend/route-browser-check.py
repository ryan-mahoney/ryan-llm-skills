# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused route/reader regressions using real dashboard routes and isolated storage.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script \
  scripts/spec-observe/frontend/route-browser-check.py [--case rail|files|specs]
Only the fixture substitutes workers; App, adapters and file APIs are real.
"""
import argparse
import json
import os
import select
import shutil
import subprocess
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright

args = argparse.ArgumentParser()
args.add_argument('--case', choices=['rail', 'files', 'specs'])
case = args.parse_args().case
root = Path(__file__).resolve().parent
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-route-evidence'))
evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
report = {'status': 'failed', 'scenarios': [], 'pageErrors': []}
fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture readiness exceeded 10 seconds')
    receipt = json.loads(fixture.stdout.readline())
    report['fixture'] = receipt
    report['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1280, 'height': 860})
        page = context.new_page()
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))

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
            viewer('context/project-context.md', 'Browser context note.')
            page.get_by_role('button', name='notes/browser.md', exact=True).click()
            viewer('notes/browser.md', 'A recorded note.')
            page.reload()
            viewer('notes/browser.md', 'A recorded note.')
            page.go_back()
            viewer('context/project-context.md', 'Browser context note.')
            page.go_forward()
            viewer('notes/browser.md', 'A recorded note.')
            # Native hash navigation is also an authoritative route input.
            page.evaluate("location.hash = '#/files?ws=fixture'")
            expect(page.locator('.file-viewer')).to_have_count(0)
            page.go_back()
            viewer('notes/browser.md', 'A recorded note.')
            # Step-3 collection prefix remains a listing, not a file selection.
            open_route('files', ws='fixture', path='notes/')
            expect(page.locator('.file-viewer')).to_have_count(0)
            expect(page.get_by_role('button', name='context/project-context.md', exact=True)).to_have_count(0)
            page.get_by_role('button', name='notes/browser.md', exact=True).click()
            viewer('notes/browser.md', 'A recorded note.')
            page.go_back()
            expect(page.locator('.file-viewer')).to_have_count(0)
            assert params()['path'] == ['notes/']
            report['scenarios'].append('workspace Files selection agrees with URL; reload, Back/Forward, path clearing and collection restoration')
            open_route('files', source='package', id=receipt['package'], path='spec.md')
            viewer('spec.md', 'Browser specification')
            page.get_by_role('button', name='linked.md', exact=True).click()
            viewer('linked.md', 'Linked evidence')
            page.reload()
            viewer('linked.md', 'Linked evidence')
            page.go_back()
            viewer('spec.md', 'Browser specification')
            page.go_forward()
            viewer('linked.md', 'Linked evidence')
            report['scenarios'].append('package Files selection/reload/history uses the same retained reader')

        if case in (None, 'specs'):
            open_route('specs', ws='fixture')
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
            report['scenarios'].append('embedded Specs reader selection/reload/history, including absent path')

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
    (evidence / 'step-002-fix-browser.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
