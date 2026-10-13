# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused Epics list and cold-region acceptance on the real dashboard fixture.

Run after `npm run build --prefix scripts/spec-observe/frontend`:

  SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script \
    scripts/spec-observe/frontend/epics-browser-check.py --case list

`--case list` runs the complete list/cold suite (list, loading, cold, file and
a11y/captures); the other choices run one group for debugging. Only the final
/api/state HTTP response is substituted through page.route; the fixture's real
dashboard, catalog, files, the built App/registry and browser-fixture.mjs stay
untouched. No live Sentinel is contacted.
"""
import argparse
import json
import os
import select
import shutil
import signal
import subprocess
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['list', 'loading', 'cold', 'file', 'a11y'], default='list')
case = parser.parse_args().case
root = Path(__file__).resolve().parent
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-epics-evidence'))
evidence.mkdir(parents=True, exist_ok=True)
browser_evidence = evidence / 'browser'
browser_evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
deadline = started + 110
report = {
    'status': 'failed',
    'outcome': 'failed',
    'case': case,
    'command': f'uv run --script scripts/spec-observe/frontend/epics-browser-check.py --case {case}',
    'scenarios': [],
    'pageErrors': [],
    'screenshots': [],
}
fixture = None


def stop_fixture():
    if fixture is None or fixture.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(fixture.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        fixture.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(fixture.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            fixture.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def check_deadline():
    if time.monotonic() > deadline:
        raise TimeoutError('Epics browser check exceeded its 110 second internal deadline')


def on_sigterm(signum, frame):
    raise TimeoutError('Epics browser check received SIGTERM')


signal.signal(signal.SIGTERM, on_sigterm)

try:
    chrome = shutil.which('google-chrome')
    if not chrome:
        raise RuntimeError('google-chrome is required for epics-browser-check.py but was not found on PATH')
    dashboard = root.parent / 'dashboard.html'
    if not dashboard.exists():
        raise RuntimeError(f'Built dashboard asset is missing: {dashboard}; run npm run build --prefix scripts/spec-observe/frontend')
    fixture = subprocess.Popen(
        ['node', str(root / 'browser-fixture.mjs')],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture readiness exceeded 10 seconds')
    receipt_line = fixture.stdout.readline()
    if not receipt_line:
        raise RuntimeError(f'Fixture produced no receipt: {fixture.stderr.read()}')
    receipt = json.loads(receipt_line)
    report['fixture'] = receipt
    report['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip())

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=chrome, headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1280, 'height': 800})
        real_state = context.request.get(receipt['url'] + '/api/state').json()
        assert isinstance(real_state, dict) and isinstance(real_state.get('observers'), list), 'Fixture /api/state did not return an observer envelope'
        real_observer = real_state['observers'][0]
        assert isinstance(real_observer.get('snapshot'), dict) and isinstance(real_observer['snapshot'].get('epics'), list), 'Fixture observer snapshot has no epic list'

        def new_page():
            page = context.new_page()
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            return page

        def params_on(page):
            return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

        def rows_on(page):
            return page.locator('.records button.record')

        def open_epics(page, **values):
            query = ('?' + urlencode(values)) if values else ''
            page.goto(receipt['url'] + '/#/epics' + query, wait_until='domcontentloaded')
            expect(page.locator('h1')).to_have_text('Epics')

        def group_list(page):
            open_epics(page, ws='fixture')
            expect(rows_on(page)).to_have_count(1)
            row = rows_on(page).first
            expect(row).to_contain_text('Demo epic')
            expect(row).to_have_attribute('aria-current', 'true')
            assert params_on(page)['ws'] == ['fixture'] and params_on(page).get('id'), page.url
            expect(page.locator('article.detail h2')).to_have_text('Demo epic')
            report['scenarios'].append('real /#/epics entry selects the existing demo epic and shows its detail')

            page.locator('#find-record').fill('browser')
            expect(rows_on(page)).to_have_count(1)
            expect(rows_on(page).first).to_have_attribute('aria-current', 'true')
            assert params_on(page)['q'] == ['browser'] and params_on(page)['ws'] == ['fixture'], page.url
            report['scenarios'].append('member-name search matches the epic and keeps it selected')

            page.locator('#find-record').fill('no-such-item')
            expect(rows_on(page)).to_have_count(0)
            expect(page.get_by_role('heading', name='No matching epics', exact=True)).to_be_visible()
            expect(page.get_by_role('heading', name='Choose an epic', exact=True)).to_be_visible()
            page.wait_for_function("() => !location.hash.includes('id=')")
            expect(page.get_by_role('button', name='Clear filters', exact=True)).to_have_count(1)
            report['scenarios'].append('missing search removes rows and detail selection with no-matches guidance')

            page.get_by_role('button', name='Clear filters', exact=True).click()
            expect(rows_on(page)).to_have_count(1)
            page.wait_for_function("() => location.hash.includes('id=')")
            assert params_on(page)['ws'] == ['fixture'] and 'q' not in params_on(page), page.url
            expect(rows_on(page).first).to_have_attribute('aria-current', 'true')
            expect(page.locator('article.detail h2')).to_have_text('Demo epic')
            report['scenarios'].append('Clear filters preserves ws and restores the available rows and detail')

        def group_loading(page):
            held = []
            mode = {'value': 'hold'}

            def handler(route):
                if mode['value'] == 'hold':
                    held.append(route)
                elif mode['value'] == 'pass':
                    route.continue_()
                else:
                    route.fulfill(json=mode['value'])

            page.route('**/api/state**', handler)
            open_epics(page, ws='fixture')
            mark = time.monotonic()
            page.wait_for_timeout(200)
            assert page.locator('.records .skeletons').count() == 0, 'list skeleton appeared before the 300ms delay'
            assert page.locator('.detail-pane .skeletons').count() == 0, 'detail skeleton appeared before the 300ms delay'
            expect(page.locator('.list-caption')).not_to_contain_text('Reading epics')
            page.wait_for_selector('.records .skeletons', state='visible', timeout=5000)
            elapsed = time.monotonic() - mark
            assert elapsed >= 0.25, f'list skeleton appeared after only {elapsed:.3f}s'
            expect(page.locator('.detail-pane .skeletons')).to_be_visible()
            expect(page.locator('.list-caption')).to_contain_text('Reading epics')
            report['timing'] = {'skeletonAfterSeconds': round(elapsed, 3)}
            report['scenarios'].append(f'held /api/state shows no skeleton before 300ms and list+detail skeleton after ({elapsed:.3f}s)')

            mode['value'] = 'pass'
            for pending in held:
                try:
                    pending.fulfill(json=real_state)
                except Exception:
                    pass
            held.clear()
            expect(rows_on(page)).to_have_count(1)
            expect(page.locator('.records .skeletons')).to_have_count(0)
            expect(page.locator('.detail-pane .skeletons')).to_have_count(0)
            expect(page.locator('.list-caption')).not_to_contain_text('Reading epics')
            page.wait_for_timeout(600)
            expect(page.locator('.records .skeletons')).to_have_count(0)
            expect(page.locator('.detail-pane .skeletons')).to_have_count(0)
            assert params_on(page).get('id'), page.url
            report['scenarios'].append('released usable payload replaces list/detail skeletons with no lingering timer feedback')

        def group_cold(page):
            open_epics(page, ws='fixture')
            expect(rows_on(page)).to_have_count(1)
            selected_id = params_on(page).get('id', [None])[0]
            assert selected_id, page.url

            mode = {'value': 'fail'}

            def handler(route):
                value = mode['value']
                if value == 'fail':
                    route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-epics-cold"}')
                elif value is True:
                    route.continue_()
                else:
                    route.fulfill(json=value)

            page.route('**/api/state**', handler)
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('h1')).to_have_text('Epics')
            expect(page.get_by_text('Epics could not be read', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Retry connection', exact=True)).to_have_count(2)
            expect(page.locator('.object-head h2')).to_have_text(selected_id)
            expect(page.locator('.object-head .status')).to_contain_text('Not confirmed')
            expect(page.get_by_role('heading', name='Epic could not be read', exact=True)).to_be_visible()
            report['scenarios'].append('cold HTTP 503 with a selected tuple retains its slug and Not confirmed state with Retry connection')

            mode['value'] = True
            page.get_by_role('button', name='Retry connection', exact=True).first.click()
            expect(rows_on(page)).to_have_count(1)
            expect(page.locator('article.detail h2')).to_have_text('Demo epic')
            assert params_on(page).get('id') == [selected_id], page.url
            expect(page.get_by_text('Epics could not be read', exact=True)).to_have_count(0)
            report['scenarios'].append('Retry connection recovers to real rows while keeping the selected tuple')

            controlled = [
                ({**real_state, 'observers': []}, 'No observer snapshots'),
                ({**real_state, 'observers': [{**real_observer, 'snapshot': {key: value for key, value in real_observer['snapshot'].items() if key != 'epics'}}]}, 'Epic data unavailable'),
                ({**real_state, 'observers': [{**real_observer, 'snapshot': {**real_observer['snapshot'], 'epics': []}}]}, 'No epics recorded'),
            ]
            for payload, heading in controlled:
                mode['value'] = payload
                page.reload(wait_until='domcontentloaded')
                expect(page.get_by_role('heading', name=heading, exact=True)).to_be_visible()
                expect(rows_on(page)).to_have_count(0)
                expect(page.get_by_role('heading', name='Choose an epic', exact=True)).to_be_visible()
                report['scenarios'].append(f'controlled state shows its distinct guidance: {heading}')

        def group_file(page):
            page.goto(dashboard.as_uri() + '#/epics', wait_until='domcontentloaded')
            expect(page.locator('h1')).to_have_text('Epics')
            destination = page.locator('.epics-destination')
            expect(destination.get_by_role('heading', name='A live dashboard is required', exact=True)).to_be_visible()
            expect(destination).to_contain_text('Import a Sentinel snapshot to inspect epics')
            expect(destination.locator('.records .skeletons')).to_have_count(0)
            expect(destination.get_by_text('Epics could not be read', exact=True)).to_have_count(0)
            expect(destination.get_by_role('button', name='Retry connection', exact=True)).to_have_count(0)
            expect(destination.get_by_role('heading', name='Choose an epic', exact=True)).to_be_visible()
            report['scenarios'].append('file:// dashboard without import shows Import-a-Sentinel-snapshot guidance with no Retry or connection control')

        def group_a11y(page):
            def assert_no_overflow():
                width = page.viewport_size['width']
                assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), f'document overflow at {width}'

            def shoot(name, width):
                page.set_viewport_size({'width': width, 'height': 800})
                path = browser_evidence / name
                page.screenshot(path=str(path))
                report['screenshots'].append(str(path))
                assert_no_overflow()

            def measure(locator, label):
                box = locator.bounding_box()
                assert box, f'{label} has no bounding box'
                assert box['width'] >= 44 and box['height'] >= 44, f'{label} is {box["width"]}x{box["height"]}, below 44x44'
                report.setdefault('hitBoxes', {})[label] = {'width': round(box['width'], 1), 'height': round(box['height'], 1)}

            def tab_until(predicate, limit=80):
                for _ in range(limit):
                    page.keyboard.press('Tab')
                    if page.evaluate(predicate):
                        return True
                return False

            def focus_visible():
                assert page.evaluate('document.activeElement && document.activeElement.matches(":focus-visible")'), 'focused element has no :focus-visible ring'
                assert page.evaluate('getComputedStyle(document.activeElement).outlineStyle !== "none"'), 'focused element has no outline'

            open_epics(page, ws='fixture')
            expect(rows_on(page)).to_have_count(1)
            selected_id = params_on(page).get('id', [None])[0]
            assert selected_id, page.url
            shoot('epics-list-03-1280.png', 1280)
            report['scenarios'].append('captured epics-list-03-1280.png for the ideal master region')

            measure(page.locator('#find-record'), 'Find epics search')
            measure(rows_on(page).first, 'epic row')
            assert tab_until('document.activeElement && document.activeElement.id === "find-record"'), 'keyboard Tab never reached the Find epics search'
            focus_visible()
            page.keyboard.press('Tab')
            assert page.evaluate('document.activeElement && document.activeElement.matches(".record")'), 'Tab after search did not reach the selected epic row'
            focus_visible()
            report['scenarios'].append('keyboard Tab exposes visible focus on the search and selected epic row')

            page.locator('#find-record').fill('no-such-item')
            expect(page.get_by_role('heading', name='No matching epics', exact=True)).to_be_visible()
            measure(page.get_by_role('button', name='Clear filters', exact=True), 'Clear filters')
            shoot('epics-41-1280.png', 1280)
            shoot('epics-41-1600.png', 1600)
            page.locator('#find-record').focus()
            page.keyboard.press('Tab')
            assert page.evaluate('document.activeElement && document.activeElement.textContent.trim() === "Clear filters"'), 'Tab did not reach Clear filters'
            focus_visible()
            page.get_by_role('button', name='Clear filters', exact=True).click()
            expect(rows_on(page)).to_have_count(1)
            report['scenarios'].append('keyboard Tab exposes visible focus on the Clear filters recovery and captures 41 at both widths')

            mode = {'value': 'pass'}
            held = []

            def handler(route):
                if mode['value'] == 'pass':
                    route.continue_()
                elif mode['value'] == 'hold':
                    held.append(route)
                elif mode['value'] == 'fail':
                    route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-epics-cold"}')
                else:
                    route.fulfill(json=mode['value'])

            page.route('**/api/state**', handler)
            mode['value'] = {**real_state, 'observers': [{**real_observer, 'snapshot': {**real_observer['snapshot'], 'epics': []}}]}
            page.reload(wait_until='domcontentloaded')
            expect(page.get_by_role('heading', name='No epics recorded', exact=True)).to_be_visible()
            shoot('epics-40-1280.png', 1280)
            shoot('epics-40-1600.png', 1600)
            report['scenarios'].append('captured epics-40 at both widths from the controlled no-epics state')

            mode['value'] = 'fail'
            page.goto(receipt['url'] + '/#/epics?' + urlencode({'ws': 'fixture', 'id': selected_id}), wait_until='domcontentloaded')
            page.reload(wait_until='domcontentloaded')
            expect(page.get_by_role('heading', name='Epic could not be read', exact=True)).to_be_visible()
            shoot('epics-43-1280.png', 1280)
            shoot('epics-43-1600.png', 1600)
            report['scenarios'].append('captured epics-43 at both widths from the cold HTTP 503 state')

            mode['value'] = 'hold'
            page.goto(receipt['url'] + '/#/epics?' + urlencode({'ws': 'fixture'}), wait_until='domcontentloaded')
            page.reload(wait_until='domcontentloaded')
            page.wait_for_selector('.records .skeletons', state='visible', timeout=5000)
            shoot('epics-42-1280.png', 1280)
            shoot('epics-42-1600.png', 1600)
            report['scenarios'].append('captured epics-42 at both widths while the first state read is held')
            mode['value'] = 'pass'
            for pending in held:
                try:
                    pending.fulfill(json=real_state)
                except Exception:
                    pass
            held.clear()
            expect(rows_on(page)).to_have_count(1)
            assert_no_overflow()
            report['scenarios'].append('released held state returns the real rows with no page errors or overflow')

        groups = {'list': group_list, 'loading': group_loading, 'cold': group_cold, 'file': group_file, 'a11y': group_a11y}
        selected = list(groups) if case == 'list' else [case]
        for name in selected:
            check_deadline()
            page = new_page()
            try:
                groups[name](page)
            finally:
                page.close()
            report['scenarios'].append(f'group {name} complete')
        assert not report['pageErrors'], report['pageErrors']
        context.close()
        browser.close()
    report['status'] = 'passed'
    report['outcome'] = 'passed'
except BaseException:
    report['error'] = traceback.format_exc()
    raise
finally:
    stop_fixture()
    report['elapsedSeconds'] = round(time.monotonic() - started, 3)
    (evidence / 'epics-list.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
