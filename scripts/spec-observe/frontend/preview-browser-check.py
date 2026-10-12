# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused preview lifecycle contract. Run: uv run --script scripts/spec-observe/frontend/preview-browser-check.py.
Uses the existing isolated fixture and uishot browser; never starts real services.
"""
import json, select, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent
fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
started = time.monotonic()
try:
    assert select.select([fixture.stdout], [], [], 10)[0], 'Fixture startup timed out'
    line = fixture.stdout.readline()
    assert line, fixture.stderr.read()
    receipt = json.loads(line)
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        context = browser.new_context(viewport={'width': 1440, 'height': 1100})
        page = context.new_page()
        configured, state, fail = False, 'stopped', False
        actions = []
        hold, pending = False, []
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        def preview(route):
            global state
            request = route.request
            if hold and request.method == 'GET':
                pending.append(route)
                return
            if request.method == 'POST':
                assert request.headers.get('x-sentinel-token'), 'Missing action token'
                data = request.post_data_json
                assert data['package'] == receipt['package'], 'Package must use authorized absolute path'
                actions.append(data['action'])
                state = 'starting' if data['action'] == 'start' else 'stopped'
            body = {'configured': configured, 'state': state, 'can_start': state in ['stopped', 'error'], 'can_stop': state == 'running', 'url': 'https://fixture.tail.example/' if state == 'running' else None, 'error': 'Compose could not start. Retry start.' if state == 'error' else None}
            route.fulfill(status=503 if fail else 202 if request.method == 'POST' else 200, json={'error': 'Temporary status failure. Retry.'} if fail else body)
        page.route('**/api/package-preview?*', preview)
        page.route('**/api/package-preview', preview)
        page.goto(receipt['url'])
        page.locator('[data-key]').first.click()
        expect(page.locator('main')).to_contain_text('Keep editors stable')
        expect(page.locator('#package-preview')).to_have_count(0)
        configured = True
        start = page.get_by_role('button', name='Start dev server', exact=True)
        expect(start).to_be_visible(timeout=5000)
        start.click()
        expect(page.get_by_role('button', name='Starting dev server…')).to_be_disabled()
        assert actions == ['start']
        state = 'running'
        link = page.get_by_role('link', name='Open dev server', exact=True)
        expect(link).to_have_attribute('href', 'https://fixture.tail.example/', timeout=5000)
        # Leave a browser-owned capture for reproducible visual inspection.
        capture = Path('/tmp/package-preview-running.png')
        page.screenshot(path=str(capture))
        import re
        Path('/tmp/package-preview-rendered.html').write_text(re.sub(r'<script\b[^>]*>.*?</script>', '', page.content(), flags=re.S))
        # An old poll must not overwrite a completed action.
        hold = True
        page.wait_for_timeout(2100)
        assert pending, 'No preview poll observed'
        page.get_by_role('button', name='Stop dev server', exact=True).click(timeout=5000)
        expect(start).to_be_visible()
        hold = False
        for old in pending:
            old.fulfill(json={'configured': True, 'state': 'running', 'can_start': False, 'can_stop': True, 'url': 'https://stale.tail.example/'})
        page.wait_for_timeout(100)
        expect(start).to_be_visible()
        expect(link).to_have_count(0)
        assert actions == ['start', 'stop']
        state = 'error'
        expect(page.locator('#package-preview')).to_contain_text('Compose could not start', timeout=5000)
        expect(start).to_be_enabled()
        fail = True
        expect(page.locator('#package-preview')).to_contain_text('Status unavailable', timeout=5000)
        fail = False
        page.get_by_role('button', name='Retry status').click()
        expect(page.locator('#package-preview')).to_contain_text('Needs attention')
        # Imported snapshots must not retain live controls or poll preview state.
        response = context.request.get(receipt['url'] + '/api/state')
        snapshot = Path('/tmp/package-preview-snapshot.json')
        snapshot.write_text(json.dumps(response.json()))
        page.locator('#import-file').set_input_files(str(snapshot))
        page.locator('[data-key]').first.click()
        expect(page.locator('#package-preview')).to_have_count(0)
        assert not errors, errors
        context.close()
        print(json.dumps({'result': 'passed', 'elapsed_seconds': round(time.monotonic() - started, 2), 'capture': str(capture), 'scope': 'hidden configuration, lifecycle, token/package contract, errors, imported snapshot'}))
finally:
    fixture.terminate()
    fixture.wait(timeout=10)
