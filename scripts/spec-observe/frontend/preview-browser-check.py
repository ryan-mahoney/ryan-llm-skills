# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused preview lifecycle contract. Run: uv run --script scripts/spec-observe/frontend/preview-browser-check.py.
Uses the existing isolated fixture and browser; never starts real services. Captures and the
gate report go to SENTINEL_EVIDENCE_DIR (fallback: ./evidence) instead of fixed /tmp paths.
"""
import json, os, re, select, subprocess, time, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR') or 'evidence')
shots = evidence / 'screens'
shots.mkdir(parents=True, exist_ok=True)
report = {'status': 'failed', 'cases': [], 'pageErrors': [], 'captures': [], 'boundary': '1280x800 and 1600x800 desktop; isolated fixture; external preview API only', 'scope': 'Overview ActionBar placement, hidden configuration, lifecycle, stale poll, token/package contract, errors, retry, imported snapshot'}
def passed(name): report['cases'].append(name)
def shot(page, name):
    path = shots / f'{name}.png'
    page.screenshot(path=str(path))
    report['captures'].append(str(path))

fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
started = time.monotonic()
try:
    assert select.select([fixture.stdout], [], [], 10)[0], 'Fixture startup timed out'
    line = fixture.stdout.readline()
    assert line, fixture.stderr.read()
    receipt = json.loads(line)
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        def environment(**overrides):
            env = {'configured': False, 'state': 'stopped', 'fail': False, 'hold': False, 'pending': [], 'actions': []}
            env.update(overrides)
            return env
        def intercept(page, env):
            def preview(route):
                request = route.request
                if env['hold'] and request.method == 'GET':
                    env['pending'].append(route)
                    return
                if request.method == 'POST':
                    assert request.headers.get('x-sentinel-token'), 'Missing action token'
                    data = request.post_data_json
                    assert data['package'] == receipt['package'], 'Package must use authorized absolute path'
                    env['actions'].append(data['action'])
                    env['state'] = 'starting' if data['action'] == 'start' else 'stopped'
                state = env['state']
                body = {'configured': env['configured'], 'state': state, 'can_start': state in ['stopped', 'error'], 'can_stop': state == 'running', 'url': 'https://fixture.tail.example/' if state == 'running' else None, 'error': 'Compose could not start. Retry start.' if state == 'error' else None}
                route.fulfill(status=503 if env['fail'] else 202 if request.method == 'POST' else 200, json={'error': 'Temporary status failure. Retry.'} if env['fail'] else body)
            page.route('**/api/package-preview?*', preview)
            page.route('**/api/package-preview', preview)

        # 1280x800: full lifecycle, delayed poll, errors, token and imported snapshot.
        env = environment()
        context = browser.new_context(viewport={'width': 1280, 'height': 800})
        page = context.new_page()
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
        intercept(page, env)
        page.goto(receipt['url'])
        page.locator('[data-key]').filter(has_text='Building the dashboard').first.click()
        expect(page.locator('main')).to_contain_text('Keep editors stable')
        expect(page.locator('#package-preview')).to_have_count(0)
        env['configured'] = True
        start = page.get_by_role('button', name='Start dev server', exact=True)
        expect(start).to_be_visible(timeout=5000)
        expect(page.locator('.detail-actions #package-preview')).to_have_count(1)
        expect(page.locator('article.detail #package-preview')).to_have_count(0)
        passed('Configured preview mounts in the Overview ActionBar (.detail-actions #package-preview), not the legacy detail stack')
        start.click()
        expect(page.get_by_role('button', name='Starting dev server…')).to_be_disabled()
        assert env['actions'] == ['start']
        passed('Start posts one token-bearing action for the authorized package')
        env['state'] = 'running'
        link = page.get_by_role('link', name='Open dev server', exact=True)
        expect(link).to_have_attribute('href', 'https://fixture.tail.example/', timeout=5000)
        shot(page, 'preview-running-1280')
        rendered = shots / 'preview-running-1280.html'
        rendered.write_text(re.sub(r'<script\b[^>]*>.*?</script>', '', page.content(), flags=re.S))
        report['captures'].append(str(rendered))
        # An old poll must not overwrite a completed action.
        env['hold'] = True
        page.wait_for_timeout(2100)
        assert env['pending'], 'No preview poll observed'
        page.get_by_role('button', name='Stop dev server', exact=True).click(timeout=5000)
        expect(start).to_be_visible()
        env['hold'] = False
        for old in env['pending']:
            old.fulfill(json={'configured': True, 'state': 'running', 'can_start': False, 'can_stop': True, 'url': 'https://stale.tail.example/'})
        env['pending'].clear()
        page.wait_for_timeout(100)
        expect(start).to_be_visible()
        expect(link).to_have_count(0)
        assert env['actions'] == ['start', 'stop']
        passed('Delayed GET cannot overwrite a completed Stop')
        shot(page, 'preview-stopped-1280')
        env['state'] = 'error'
        expect(page.locator('#package-preview')).to_contain_text('Compose could not start', timeout=5000)
        expect(start).to_be_enabled()
        shot(page, 'preview-error-1280')
        passed('Recorded error keeps Start enabled and names its reason')
        env['fail'] = True
        expect(page.locator('#package-preview')).to_contain_text('Status unavailable', timeout=5000)
        passed('Read failure names Status unavailable instead of a stale state')
        env['fail'] = False
        page.get_by_role('button', name='Retry status').click()
        expect(page.locator('#package-preview')).to_contain_text('Needs attention')
        passed('Retry status recovers the group after a read failure')
        # Imported snapshots must not retain the preview group or poll preview state.
        response = context.request.get(receipt['url'] + '/api/state')
        snapshot = evidence / 'preview-snapshot.json'
        snapshot.write_text(json.dumps(response.json()))
        page.locator('#import-file').set_input_files(str(snapshot))
        page.locator('[data-key]').filter(has_text='Building the dashboard').first.click()
        expect(page.locator('#package-preview')).to_have_count(0)
        passed('Imported snapshots keep the preview group hidden')
        context.close()

        # 1600x800: the same configured states at the wider bound, plus the
        # Overview-only mount contract (Activity removes the group in place).
        env2 = environment(configured=True, state='running')
        context2 = browser.new_context(viewport={'width': 1600, 'height': 800})
        page2 = context2.new_page()
        page2.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
        intercept(page2, env2)
        page2.goto(receipt['url'])
        page2.locator('[data-key]').filter(has_text='Building the dashboard').first.click()
        expect(page2.locator('.detail-actions #package-preview')).to_have_count(1)
        link2 = page2.get_by_role('link', name='Open dev server', exact=True)
        expect(link2).to_have_attribute('href', 'https://fixture.tail.example/', timeout=5000)
        shot(page2, 'preview-running-1600')
        env2['state'] = 'error'
        expect(page2.locator('#package-preview')).to_contain_text('Compose could not start', timeout=5000)
        shot(page2, 'preview-error-1600')
        env2['state'] = 'stopped'
        page2.get_by_role('navigation', name='Spec sections').get_by_role('button', name='Activity', exact=True).click()
        expect(page2.locator('.detail-actions #package-preview')).to_have_count(0)
        passed('Activity tab removes the preview group; Overview keeps exactly one mount')
        page2.get_by_role('navigation', name='Spec sections').get_by_role('button', name='Overview', exact=True).click()
        start2 = page2.get_by_role('button', name='Start dev server', exact=True)
        expect(start2).to_be_visible(timeout=5000)
        shot(page2, 'preview-stopped-1600')
        passed('Configured running, stopped and error states render at 1280x800 and 1600x800')
        context2.close()
        assert not report['pageErrors'], report['pageErrors']
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
    target = evidence / 'preview-browser.json'
    temporary = target.with_name(target.name + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    os.replace(temporary, target)
    print(json.dumps(report, indent=2))
