# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Regression: saved briefs must visibly guide the operator through preview and launch.
Run: uv run --script scripts/spec-observe/frontend/browser-handoff-check.py
Uses isolated fixture storage and fake workers; never launches a real assignment.
About five seconds including browser/fixture startup, two visual captures and the
existing 700ms in-flight save fixture; one journey shares that setup.
"""
import json, select, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent
started = time.monotonic()
fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture startup timed out')
    url = json.loads(fixture.stdout.readline())['url']
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        context = browser.new_context(viewport={'width': 1440, 'height': 1100}, device_scale_factor=1)
        try:
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            def control(action='', value=''):
                response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
                assert response.ok
                return response.json()
            def posts(name):
                return [x for x in control()['posts'] if x['name'] == name]
            page.goto(url, wait_until='domcontentloaded')
            page.locator('[data-mode="workspaces"]').click()
            page.locator('[data-workspace="fixture"]').click()
            title, brief = page.locator('#thread-brief-title'), page.locator('#thread-brief-content')
            status = page.locator('#thread-handoff-status')
            title.fill('Preferred models settings')
            brief.fill('/spec-architect-initial add a settings area for preferred models')
            brief.press('Enter')
            expect(status).to_contain_text('Brief saved. Assignment has not started.')
            expect(page.locator('[data-thread-preview]')).to_be_focused()
            assert len(posts('saveBrief')) == 1
            assert not posts('launchAssignment')
            # Repeated Enter on unchanged content must not create another handoff.
            brief.press('Enter')
            expect(page.locator('[data-thread-preview]')).to_be_focused()
            assert len(posts('saveBrief')) == 1
            page.locator('[data-thread-preview]').click()
            expect(page.locator('[data-thread-launch]')).to_be_focused()
            expect(status).to_contain_text('Review the details below')
            brief.press('Enter')
            expect(page.locator('[data-thread-launch]')).to_be_focused()
            assert len(posts('saveBrief')) == 1
            assert len(posts('previewAssignment')) == 1
            page.locator('[data-thread-launch]').click()
            expect(page.locator('[data-thread-launch]')).to_be_disabled()
            expect(status).to_contain_text('Preview again')
            control('stale-launch', 'false')
            page.locator('[data-thread-preview]').click()
            expect(page.locator('.thread-handoff [role="alert"]')).to_have_count(0)
            brief.fill('Changed request')
            expect(status).to_contain_text('unsaved changes')
            expect(page.locator('[data-thread-launch]')).to_be_disabled()
            expect(page.locator('[data-thread-preview]')).to_be_disabled()
            # An edit made during saving must survive and still require another save.
            control('delay-brief', 'true')
            brief.press('Enter')
            expect(status).to_contain_text('Saving brief')
            brief.fill('Final request edited while saving')
            expect(status).to_contain_text('unsaved changes')
            expect(brief).to_have_value('Final request edited while saving')
            expect(brief).to_be_focused()
            control('delay-brief', 'false')
            brief.press('Enter')
            expect(status).to_contain_text('Brief saved. Assignment has not started.')
            page.locator('.thread-handoff').screenshot(path='/tmp/sentinel-brief-saved.png')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('#thread-handoff-status').scroll_into_view_if_needed()
            page.screenshot(path='/tmp/sentinel-brief-mobile.png')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('[data-thread-preview]').click()
            page.locator('[data-thread-launch]').click()
            expect(status).to_contain_text('Assignment started.')
            expect(page.locator('#thread-result')).to_be_focused()
            assert len(posts('launchAssignment')) == 2  # one stale refusal, one launch
            assert len(posts('saveBrief')) == 3
            assert not errors, errors
            print(json.dumps({'status': 'passed', 'elapsed_seconds': round(time.monotonic() - started, 2), 'scenarios': ['save-only confirmation', 'unchanged Enter preserves handoff', 'preview then explicit launch', 'stale preview recovery', 'dirty and in-flight edits', 'mobile feedback', 'launch confirmation'], 'screenshots': ['/tmp/sentinel-brief-saved.png', '/tmp/sentinel-brief-mobile.png']}))
        finally:
            context.close()
finally:
    fixture.terminate()
    fixture.wait(timeout=10)
