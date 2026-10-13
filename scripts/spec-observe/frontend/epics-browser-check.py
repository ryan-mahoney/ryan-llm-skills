# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused Epics list and cold-region acceptance on the real dashboard fixture.

Run after `npm run build --prefix scripts/spec-observe/frontend`:

  SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script \
    scripts/spec-observe/frontend/epics-browser-check.py --case list

`--case list` runs the complete list/cold suite (list, loading, cold, file and
a11y/captures); `--case detail` runs the EV-6 facts/table/conflict gate with
bound app-ui reference captures; the other choices run one group for debugging.
Only the final /api/state HTTP response is substituted through page.route; the
fixture's real dashboard, catalog, files, the built App/registry and
browser-fixture.mjs stay untouched. No live Sentinel is contacted.
"""
import argparse
import hashlib
import json
import os
import re
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
parser.add_argument('--case', choices=['list', 'loading', 'cold', 'file', 'a11y', 'detail'], default='list')
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
    'deadlineSeconds': 110,
    'proofLimits': [
        'Independent hand-derived snapshot envelopes substituted only at the final /api/state HTTP response; does not prove authoring record correctness or start authority.',
        'Bound app-ui reference frames are digest-checked and captured for inspection; correspondence is not pixel-asserted, and no live Sentinel or production state is read.',
    ],
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
    porcelain = subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()
    report['dirty'] = bool(porcelain)
    report['workingTree'] = {'dirty': bool(porcelain), 'statusPorcelain': porcelain, 'digest': hashlib.sha256(porcelain.encode('utf-8')).hexdigest()}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=chrome, headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1280, 'height': 800})
        real_state = context.request.get(receipt['url'] + '/api/state').json()
        assert isinstance(real_state, dict) and isinstance(real_state.get('observers'), list), 'Fixture /api/state did not return an observer envelope'

        def is_fixture_observer(observer):
            if not isinstance(observer, dict):
                return False
            if observer.get('observer_id') == 'fixture':
                return True
            snapshot = observer.get('snapshot')
            if not isinstance(snapshot, dict) or snapshot.get('workspace') != 'fixture':
                return False
            runs = snapshot.get('runs')
            return isinstance(runs, list) and any(
                isinstance(run, dict)
                and isinstance(run.get('package'), str)
                and run['package'].rstrip('/').endswith('specs/browser')
                for run in runs
            )

        real_observer = next((observer for observer in real_state['observers'] if is_fixture_observer(observer)), None)
        assert isinstance(real_observer, dict) and isinstance(real_observer.get('snapshot'), dict) and isinstance(real_observer['snapshot'].get('epics'), list), 'Fixture observer snapshot has no epic list'

        def new_page():
            page = context.new_page()
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            return page

        def params_on(page):
            return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

        def rows_on(page):
            return page.locator('.records .record')

        def open_epics(page, **values):
            query = ('?' + urlencode(values)) if values else ''
            page.goto(receipt['url'] + '/#/epics' + query, wait_until='domcontentloaded')
            expect(page.locator('h1')).to_have_text('Epics')

        # Hand-derived detail fixtures for the EV-6 gate. Only the final
        # /api/state response is substituted; package paths reuse the fixture's
        # real storage workspace so the published absolute-path shape stays
        # honest, while every status/requirement expectation below is
        # independent of the app's projection helpers.
        run_package = Path(real_observer['snapshot']['runs'][0]['package'])
        assert run_package.name == 'browser', f'unexpected fixture package path: {run_package}'
        workspace_dir = str(run_package.parents[1])

        def detail_member(slug, status, declared=True, **extra):
            member = {
                'name': slug,
                'package': str(Path(workspace_dir) / 'specs' / slug),
                'workspace': 'fixture',
                'status': status,
                'waiting_on': [],
            }
            if declared:
                member['requires'] = []
            member.update(extra)
            return member

        def detail_run(slug, assignment):
            stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            return {
                'workspace': 'fixture',
                'package': str(Path(workspace_dir) / 'specs' / slug),
                'package_ref': f'fixture/{slug}',
                'assignment_id': assignment,
                'workflow_id': f'{assignment}-workflow',
                'execution': 'running',
                'workflow_state': 'waiting-worker',
                'is_current_assignment': False,
                'observed_at': stamp,
                'coverage': {'state': 'complete', 'reasons': []},
            }

        def detail_envelope(epic, runs=()):
            stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            observer = {
                'schema_version': 1,
                'observer_id': 'epics-detail-fixture',
                'state': 'observing',
                'published_at': stamp,
                'snapshot': {
                    'workspace': 'fixture',
                    'coverage': {'state': 'complete', 'observed_at': stamp, 'reasons': []},
                    'runs': list(runs),
                    'recently_completed': [],
                    'assignments': [],
                    'assignment_coverage': {'state': 'complete', 'reasons': []},
                    'epics': [epic],
                    'planned_packages': [],
                },
            }
            return {**real_state, 'observers': [observer]}

        def resolve_designs_dir():
            for base in (evidence.parent, Path.cwd(), root):
                current = base.resolve()
                seen = set()
                while current not in seen:
                    seen.add(current)
                    candidate = current / 'locations.json'
                    if candidate.is_file():
                        try:
                            data = json.loads(candidate.read_text())
                        except (OSError, ValueError):
                            data = {}
                        for design in data.get('designs', []):
                            if design.get('ref') == 'agent-tooling/app-ui' and design.get('dir'):
                                return Path(design['dir'])
                    if current.parent == current:
                        break
                    current = current.parent
            raise RuntimeError('locations.json with the agent-tooling/app-ui designs entry was not found; run with SENTINEL_EVIDENCE_DIR=<package>/evidence')

        def verify_reference(design_dir, relative, expected):
            path = Path(design_dir) / relative
            if not path.is_file():
                raise RuntimeError(f'Bound design reference is missing: {path}')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != expected:
                raise RuntimeError(f'Bound design reference digest mismatch for {path}: {digest}')
            return path, digest

        def detail_uri(path):
            return path.resolve().as_uri()

        def group_list(page):
            open_epics(page, ws='fixture')
            expect(rows_on(page)).to_have_count(1)
            row = rows_on(page).first
            expect(row).to_contain_text('Demo epic')
            assert row.evaluate('el => el.tagName') == 'A', 'epic row is not a real route link'
            expect(row).to_have_attribute('aria-current', 'page')
            href = row.get_attribute('href')
            assert href and href.startswith('#/epics') and 'id=' in href, f'epic row href is not a selectable route link: {href}'
            assert params_on(page)['ws'] == ['fixture'] and params_on(page).get('id'), page.url
            expect(page.locator('article.detail-pane .object-head h2')).to_have_text('Demo epic')
            report['scenarios'].append('real /#/epics entry selects the existing demo epic through a real route link and shows its detail')

            page.locator('#find-record').fill('browser')
            expect(rows_on(page)).to_have_count(1)
            expect(rows_on(page).first).to_have_attribute('aria-current', 'page')
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
            expect(rows_on(page).first).to_have_attribute('aria-current', 'page')
            expect(page.locator('article.detail-pane .object-head h2')).to_have_text('Demo epic')
            report['scenarios'].append('Clear filters preserves ws and restores the available rows and detail')

            def list_member(slug, status, attention=False):
                return {'name': slug, 'package': slug, 'workspace': 'fixture', 'status': status, 'waiting_on': [], 'attention': attention}

            def list_epic(slug, title, state, members, summary, next_name):
                return {'workspace': 'fixture', 'epic': slug, 'title': title, 'state': state, 'members': members, 'summary': summary, 'next': next_name, 'coverage': {'state': 'complete', 'reasons': []}}

            multi = [
                list_epic('alpha', 'Alpha epic', 'active',
                           [list_member('alpha-one', 'merged'), list_member('alpha-two', 'merged')],
                           {'total': 2, 'merged': 2, 'complete': 0, 'attention': 0}, ''),
                list_epic('beta', 'Beta epic', 'active',
                           [list_member('beta-one', 'in-progress', attention=True), list_member('beta-two', 'unknown')],
                           {'total': 2, 'merged': 0, 'complete': 0, 'attention': 1}, 'beta-two'),
                list_epic('gamma', 'Gamma epic', 'complete',
                           [list_member('gamma-one', 'merged')],
                           {'total': 1, 'merged': 1, 'complete': 0, 'attention': 0}, ''),
            ]
            list_mode = {'value': {**real_state, 'observers': [{**real_observer, 'snapshot': {**real_observer['snapshot'], 'epics': multi}}]}}

            def list_handler(route):
                route.fulfill(json=list_mode['value'])

            page.route('**/api/state**', list_handler)
            page.goto('about:blank')
            open_epics(page, ws='fixture')
            expect(rows_on(page)).to_have_count(3)
            expect(page.locator('.list-caption')).to_have_text('3 epic records · dependency order')
            beta = page.locator('.records .record', has_text='Beta epic')
            expect(beta).to_contain_text('0 of 2 landed · next: beta-two · 1 need attention · evidence incomplete')
            assert beta.get_attribute('aria-current') is None, 'unselected row claims current selection'
            expect(page.locator('.records .record', has_text='Alpha epic')).to_have_attribute('aria-current', 'page')
            report['scenarios'].append('multi-epic list renders attention and evidence-incomplete cues on the affected row')

            page.locator('#find-record').fill('beta')
            expect(rows_on(page)).to_have_count(1)
            expect(page.locator('.list-caption')).to_have_text('1 shown of 3 epics')
            report['scenarios'].append('partial search reports the visible count against the scoped total')

            page.locator('#find-record').fill('')
            expect(rows_on(page)).to_have_count(3)
            expect(page.locator('.list-caption')).to_have_text('3 epic records · dependency order')
            report['scenarios'].append('clearing a partial search restores every scoped row and the unfiltered caption')

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
            expect(page.locator('.detail-pane .facts .skeletons')).to_have_count(3)
            expect(page.locator('.detail-pane .skeletons-table')).to_have_count(1)
            expect(page.locator('.detail-pane .skeletons').first).to_be_visible()
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
            selected_slug = json.loads(selected_id)[1]
            expect(page.locator('.object-head h2')).to_have_text(selected_slug)
            expect(page.locator('.object-head .status')).to_contain_text('Not confirmed')
            expect(page.get_by_role('heading', name='Epic could not be read', exact=True)).to_be_visible()
            report['scenarios'].append(f'cold HTTP 503 with a selected tuple retains its slug ({selected_slug}) and Not confirmed state with Retry connection')

            mode['value'] = True
            page.get_by_role('button', name='Retry connection', exact=True).first.click()
            expect(rows_on(page)).to_have_count(1)
            expect(page.locator('article.detail-pane .object-head h2')).to_have_text('Demo epic')
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

            mode['value'] = 'fail'
            page.goto('about:blank')
            page.goto(receipt['url'] + '/#/epics?' + urlencode({'ws': 'fixture', 'id': 'not-a-tuple'}), wait_until='domcontentloaded')
            expect(page.get_by_text('Epics could not be read', exact=True)).to_be_visible()
            expect(page.locator('.object-head h2')).to_have_text('Epic details')
            expect(page.get_by_text('No selected epic in this route.', exact=True)).to_be_visible()
            report['scenarios'].append('cold HTTP 503 with an invalid tuple falls back to the Epic details heading with no retained selection')

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
            selected_slug = json.loads(selected_id)[1]
            design_dir = resolve_designs_dir()
            bound = {}
            for relative, expected in (
                ('screens/03-epics.html', 'fe1742c3d469dd9efa7b860d2c30828ff68ee1aae7b1302c8536f6bb3f443d28'),
                ('screens/40-epics-empty.html', 'e8aeb9f71b4113796084a68e859924b072c59f26e1f8198c394fcb19b328530b'),
                ('screens/41-epics-no-matches.html', '8f6b99d0aefcd608e4e2060ad9265b08dd5b4ed1f869a2924b02f5142bbadb93'),
                ('screens/42-epics-loading.html', 'aee86f28023c4784bfccfc23621ed006beac1a8de0202a8301ec664205ad461d'),
                ('screens/43-epics-error.html', '7868a59d6ab479e907da28717efb0539ebc47c661a2f62b52c2fcedb329db248'),
            ):
                ref_path, digest = verify_reference(design_dir, relative, expected)
                bound[relative] = {'path': str(ref_path), 'sha256': digest}
            report['references'] = {'designsDir': str(design_dir), 'files': bound}
            for screen, relative in (('40', 'screens/40-epics-empty.html'), ('41', 'screens/41-epics-no-matches.html'), ('42', 'screens/42-epics-loading.html'), ('43', 'screens/43-epics-error.html')):
                check_deadline()
                page.set_viewport_size({'width': 1280, 'height': 800})
                page.goto(detail_uri(Path(bound[relative]['path'])), wait_until='domcontentloaded')
                ref_shot = browser_evidence / f'epics-ref-{screen}-1280.png'
                page.screenshot(path=str(ref_shot))
                report['screenshots'].append(str(ref_shot))
            report['scenarios'].append('bound app-ui references digest-checked and captured for inspection at 1280')
            open_epics(page, ws='fixture')
            expect(rows_on(page)).to_have_count(1)
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
            expect(page.locator('article.detail-pane .object-head h2')).to_have_text('Epic details')
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
            destination = page.locator('.epics-destination')
            expect(destination.get_by_role('button', name='Refresh state', exact=True)).to_have_count(1)
            measure(destination.get_by_role('button', name='Refresh state', exact=True), 'Refresh state')
            expect(page.locator('article.detail-pane .object-head h2')).to_have_text('Epic details')
            expect(page.get_by_role('heading', name='Choose an epic', exact=True)).to_be_visible()
            shoot('epics-40-1280.png', 1280)
            shoot('epics-40-1600.png', 1600)
            report['scenarios'].append('captured epics-40 at both widths: regional Refresh primary with the Epic details header')

            mode['value'] = 'fail'
            page.goto('about:blank')
            page.goto(receipt['url'] + '/#/epics?' + urlencode({'ws': 'fixture', 'id': selected_id}), wait_until='domcontentloaded')
            expect(page.get_by_role('heading', name='Epic could not be read', exact=True)).to_be_visible()
            page.wait_for_function("() => location.hash.includes('id=')")
            assert params_on(page).get('id') == [selected_id], page.url
            expect(page.locator('.object-head h2')).to_have_text(selected_slug)
            expect(page.locator('.object-head .status')).to_contain_text('Not confirmed')
            shoot('epics-43-1280.png', 1280)
            shoot('epics-43-1600.png', 1600)
            report['scenarios'].append(f'captured epics-43 at both widths with the selected tuple retained as its slug ({selected_slug})')

            mode['value'] = 'hold'
            page.goto('about:blank')
            page.goto(receipt['url'] + '/#/epics?' + urlencode({'ws': 'fixture'}), wait_until='domcontentloaded')
            page.wait_for_selector('.records .skeletons', state='visible', timeout=5000)
            expect(page.locator('.detail-pane .object-head h2')).to_have_text('Epic details')
            expect(page.locator('.detail-pane .facts .skeletons')).to_have_count(3)
            expect(page.locator('.detail-pane .skeletons-table')).to_have_count(1)
            expect(page.locator('.detail-pane .section-heading h3', has_text='Dependency order')).to_be_visible()
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

        def group_detail(page):
            detail_mode = {'value': None}

            def handler(route):
                if detail_mode['value'] is None:
                    route.continue_()
                else:
                    route.fulfill(json=detail_mode['value'])

            page.route('**/api/state**', handler)

            def open_detail(payload):
                detail_mode['value'] = payload
                page.goto('about:blank')
                page.goto(receipt['url'] + '/#/epics?ws=fixture', wait_until='domcontentloaded')
                expect(page.locator('h1')).to_have_text('Epics')
                expect(rows_on(page)).to_have_count(1)
                page.wait_for_function("() => location.hash.includes('id=')")
                expect(page.locator('article.detail-pane .object-head h2')).to_have_text(payload['observers'][0]['snapshot']['epics'][0]['title'])

            def assert_no_document_overflow():
                width = page.viewport_size['width']
                assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), f'document overflow at {width}'

            def tab_until(predicate, limit=120):
                for _ in range(limit):
                    page.keyboard.press('Tab')
                    if page.evaluate(predicate):
                        return True
                return False

            def focus_visible():
                assert page.evaluate('document.activeElement && document.activeElement.matches(":focus-visible")'), 'focused element has no :focus-visible ring'
                assert page.evaluate('getComputedStyle(document.activeElement).outlineStyle !== "none"'), 'focused element has no outline'

            def measure(locator, label):
                box = locator.bounding_box()
                assert box, f'{label} has no bounding box'
                assert box['width'] >= 44 and box['height'] >= 44, f'{label} is {box["width"]}x{box["height"]}, below 44x44'
                report.setdefault('hitBoxes', {})[label] = {'width': round(box['width'], 1), 'height': round(box['height'], 1)}

            def capture(locator, name):
                path = browser_evidence / name
                locator.screenshot(path=str(path))
                report['screenshots'].append(str(path))
                return str(path)

            pane = page.locator('article.detail-pane')
            facts = page.locator('.facts .fact')
            table = page.locator('table.epic-members')

            # Card (a): recorded Complete with 0/3 landed. PR-published and
            # Prepared members must not count as landed, the conflict is
            # explained without rewriting records, notes stay plain text and no
            # dropped status/filter/action appears.
            conflict_epic = {
                'workspace': 'fixture', 'epic': 'conflict-epic', 'title': 'Conflict epic', 'state': 'complete',
                'members': [
                    detail_member('published-member', 'published'),
                    detail_member('prepared-member', 'prepared', note='Not undertaken. Its prepared status remains recorded; it has no dropped status.'),
                    detail_member('progress-member', 'in-progress', requires=['prepared-member']),
                ],
                'summary': {'total': 3, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': 'progress-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            conflict_payload = detail_envelope(conflict_epic, runs=[
                detail_run('published-member', 'detail-published'),
                detail_run('prepared-member', 'detail-prepared'),
                detail_run('progress-member', 'detail-progress'),
            ])
            open_detail(conflict_payload)
            status = page.locator('.object-head .status')
            expect(status).to_contain_text('Recorded complete')
            assert 'warning' in (status.get_attribute('class') or ''), 'conflict status is not warning tone'
            callout = page.locator('.detail-body .ds-callout.warning')
            expect(callout).to_contain_text('Recorded state conflicts with member evidence')
            expect(callout).to_contain_text('The records have not been rewritten')
            expect(callout).to_contain_text('conflicting evidence is preserved')
            expect(facts).to_have_count(3)
            expect(facts.nth(0)).to_contain_text('Recorded epic state')
            expect(facts.nth(0)).to_contain_text('Complete')
            expect(facts.nth(1)).to_contain_text('0 of 3')
            expect(table.get_by_text('PR published')).to_be_visible()
            expect(table.get_by_text('Prepared', exact=True)).to_be_visible()
            assert table.locator('.status', has_text='Merged').count() == 0, 'published/prepared member counted as landed'
            note = page.get_by_text('prepared-member: Not undertaken. Its prepared status remains recorded; it has no dropped status.', exact=True)
            expect(note).to_be_visible()
            assert note.evaluate('el => el.tagName') == 'P', 'member note rendered as a control'
            assert page.locator('.status', has_text='Not undertaken').count() == 0, 'note leaked into member status'
            controls = pane.locator('button, a, select')
            assert controls.filter(has_text=re.compile('drop|hide|remove|filter', re.I)).count() == 0, 'dropped-status filter/action appeared'
            report['scenarios'].append('detail conflict: Recorded complete/warning, no-rewrite explanation, 0 of 3 landed, notes stay text with no dropped control')

            # Card (b): declared requires win over waiting_on, and an older
            # snapshot omitting requires shows unmet names with exactly one
            # unmet-only table note.
            declared_epic = {
                'workspace': 'fixture', 'epic': 'declared-epic', 'title': 'Declared dependencies', 'state': 'active',
                'members': [
                    detail_member('merged-a', 'merged'),
                    detail_member('member-b', 'in-progress', requires=['merged-a']),
                ],
                'summary': {'total': 2, 'merged': 1, 'complete': 0, 'attention': 0},
                'next': 'member-b',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(declared_epic))
            rows = table.locator('tbody tr')
            expect(rows).to_have_count(2)
            expect(rows.nth(1).locator('td').first).to_have_text('merged-a')
            assert table.get_by_text(re.compile('waiting', re.I)).count() == 0, 'declared requires rendered a waiting marker'
            assert page.get_by_text('This observer reports only unmet requirements.', exact=True).count() == 0, 'unmet-only note appeared for declared requires'
            report['scenarios'].append('detail declared requires: member b shows merged a with no waiting marker and no unmet-only note')

            legacy_epic = {
                'workspace': 'fixture', 'epic': 'legacy-epic', 'title': 'Legacy snapshot', 'state': 'active',
                'members': [
                    detail_member('legacy-a', 'merged', declared=False),
                    detail_member('legacy-b', 'in-progress', declared=False, waiting_on=['legacy-a']),
                    detail_member('legacy-c', 'prepared', declared=False, waiting_on=['legacy-b']),
                ],
                'summary': {'total': 3, 'merged': 1, 'complete': 0, 'attention': 0},
                'next': 'legacy-b',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            open_detail(detail_envelope(legacy_epic))
            expect(rows).to_have_count(3)
            expect(rows.nth(1).locator('td').first).to_have_text('legacy-a \u00b7 waiting')
            expect(rows.nth(2).locator('td').first).to_have_text('legacy-b \u00b7 waiting')
            expect(page.get_by_text('This observer reports only unmet requirements.', exact=True)).to_have_count(1)
            expect(facts.nth(2)).to_contain_text('legacy-b')
            expect(facts.nth(2)).to_contain_text('Only unmet requirements reported')
            report['scenarios'].append('detail older snapshot: unmet names carry waiting markers with exactly one unmet-only table note and fact')

            # Card (c): order/scopes/caption, literal unknown status, unmatched
            # text-only member, distinct next candidate vs attention inspection,
            # and keyboard focus with 44px hit boxes.
            table_epic = {
                'workspace': 'fixture', 'epic': 'table-epic', 'title': 'Table epic', 'state': 'active',
                'members': [
                    detail_member('ready-slug', 'ready'),
                    detail_member('short-slug', 'in-progress', attention=True),
                    detail_member('omega-member', 'merged', requires=['short-slug']),
                ],
                'summary': {'total': 3, 'merged': 1, 'complete': 0, 'attention': 1},
                'next': 'omega-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(table_epic, runs=[detail_run('short-slug', 'detail-short')]))
            expect(table.locator('caption')).to_have_count(1)
            expect(table.locator('caption')).to_have_text('Members of Table epic in dependency order')
            expect(table.locator('thead th[scope=col]')).to_have_count(3)
            expect(table.locator('tbody th[scope=row]')).to_have_count(3)
            cells = table.locator('tbody th[scope=row]')
            expect(cells.nth(0)).to_contain_text('ready-slug')
            expect(cells.nth(1)).to_contain_text('short-slug')
            expect(cells.nth(2)).to_contain_text('omega-member')
            expect(rows.nth(0).locator('.status')).to_have_text('ready')
            expect(rows.nth(0).locator('button')).to_have_count(0)
            expect(rows.nth(0)).to_contain_text('No observed package matches this member in scope.')
            short_button = rows.nth(1).locator('button')
            expect(short_button).to_have_text('short-slug')
            expect(facts.nth(2)).to_contain_text('Next candidate')
            expect(facts.nth(2)).to_contain_text('omega-member')
            expect(facts.nth(2)).to_contain_text('Requires short-slug')
            expect(page.get_by_role('heading', name='Next member', exact=True)).to_be_visible()
            expect(page.locator('.obligation')).to_contain_text('Inspect short-slug: its recorded observation needs attention.')
            page.locator('#find-record').focus()
            assert tab_until('document.activeElement && document.activeElement.textContent.trim() === "short-slug"'), 'Tab never reached the short-slug member'
            focus_visible()
            measure(short_button, 'short-slug member')
            assert tab_until('document.activeElement && document.activeElement.textContent.trim() === "Open spec"'), 'Tab never reached Open spec'
            focus_visible()
            measure(pane.locator('.detail-actions .ds-btn--primary'), 'Open spec')
            report['scenarios'].append('detail table: order/scopes/caption, literal ready, unmatched text-only, next candidate vs attention inspection distinct, keyboard focus and 44px hit boxes')

            # Step-004 fix counterexamples: mixed landed/unmet declared
            # dependencies keep the landed name bare and mark only the unmet one.
            mixed_epic = {
                'workspace': 'fixture', 'epic': 'mixed-epic', 'title': 'Mixed dependencies', 'state': 'active',
                'members': [
                    detail_member('landed-dep', 'merged'),
                    detail_member('unmet-dep', 'prepared'),
                    detail_member('mixed-member', 'in-progress', requires=['landed-dep', 'unmet-dep'], waiting_on=['unmet-dep']),
                ],
                'summary': {'total': 3, 'merged': 1, 'complete': 0, 'attention': 0},
                'next': 'mixed-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(mixed_epic))
            expect(rows).to_have_count(3)
            expect(rows.nth(2).locator('td').first).to_have_text('landed-dep, unmet-dep \u00b7 waiting')
            expect(facts.nth(2)).to_contain_text('mixed-member')
            expect(facts.nth(2)).to_contain_text('Requires landed-dep, unmet-dep')
            report['scenarios'].append('detail mixed requires: landed name bare with only the unmet name marked waiting')

            # Step-004 F1: snapshot next stays eligible under evidence-first focus,
            # and null next renders None eligible instead of an inspection target.
            evidence_epic = {
                'workspace': 'fixture', 'epic': 'evidence-epic', 'title': 'Evidence first epic', 'state': 'active',
                'members': [
                    detail_member('unknown-member', 'unknown'),
                    detail_member('eligible', 'prepared'),
                ],
                'summary': {'total': 2, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': 'eligible',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(evidence_epic))
            expect(facts.nth(2).locator('strong')).to_have_text('eligible')
            expect(facts.nth(2)).to_contain_text('No requirements')
            expect(facts.nth(2)).not_to_contain_text('Inspect')
            expect(page.locator('.obligation')).to_contain_text('Inspect unknown-member')
            report['scenarios'].append('detail next fact: snapshot eligible stays the candidate under evidence-first focus with inspection kept in Next member')

            nullnext_epic = {
                'workspace': 'fixture', 'epic': 'nullnext-epic', 'title': 'Null next epic', 'state': 'active',
                'members': [
                    detail_member('dep', 'prepared'),
                    detail_member('active', 'in-progress', requires=['dep'], waiting_on=['dep']),
                ],
                'summary': {'total': 2, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': None,
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(nullnext_epic))
            expect(facts.nth(2).locator('strong')).to_have_text('None eligible')
            expect(facts.nth(2)).to_contain_text('wait on unlanded requirements')
            report['scenarios'].append('detail next fact: null next renders None eligible instead of the blocked in-progress member')

            # Step-004 F3: one-character slug keeps a 44x44 target.
            tiny_epic = {
                'workspace': 'fixture', 'epic': 'tiny-epic', 'title': 'Tiny slug epic', 'state': 'active',
                'members': [
                    detail_member('a', 'in-progress'),
                ],
                'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': 'a',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(tiny_epic, runs=[detail_run('a', 'detail-a')]))
            tiny_button = table.locator('tbody tr').first.locator('button')
            expect(tiny_button).to_have_text('a')
            measure(tiny_button, 'single-char member')
            report['scenarios'].append('detail hit box: one-character member slug keeps a 44x44 target')

            # Step-004 F4: evidence-first member without a record explains the
            # missing spec, not missing landing evidence; with a record the
            # action is available.
            unknown_epic = {
                'workspace': 'fixture', 'epic': 'unknown-epic', 'title': 'Unknown member epic', 'state': 'active',
                'members': [
                    detail_member('unknown-member', 'unknown'),
                ],
                'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': 'unknown-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(unknown_epic, runs=[]))
            absent_action = pane.locator('.detail-actions .ds-btn--primary')
            expect(absent_action).to_be_disabled()
            expect(absent_action).to_have_attribute('aria-describedby', 'epic-open-spec-help')
            expect(page.locator('#epic-open-spec-help')).to_have_text('unknown-member has no observed spec in this snapshot.')
            expect(page.locator('#epic-open-spec-help')).not_to_contain_text('Landing evidence')
            report['scenarios'].append('detail open reason: evidence-first member without a record names the missing observed spec')
            check_deadline()
            open_detail(detail_envelope(unknown_epic, runs=[detail_run('unknown-member', 'detail-unknown')]))
            expect(pane.locator('.detail-actions .ds-btn--primary')).to_be_enabled()
            expect(page.locator('#epic-open-spec-help')).to_have_count(0)
            report['scenarios'].append('detail open reason: evidence-first member with a record keeps Open spec available')

            # Card (d): bound reference digests, reference-vs-production region
            # captures at both widths, and the 26 long-slug table at 1280.
            check_deadline()
            design_dir = resolve_designs_dir()
            ref3 = verify_reference(design_dir, 'screens/03-epics.html', 'fe1742c3d469dd9efa7b860d2c30828ff68ee1aae7b1302c8536f6bb3f443d28')
            ref44 = verify_reference(design_dir, 'screens/44-epics-partial.html', '1c73b1466711c2d98d68a550144095f5587a6fe67070767187a953cfdbb9ad5b')
            report['references'] = {
                'designsDir': str(design_dir),
                'files': [{'path': str(path), 'sha256': digest} for path, digest in (ref3, ref44)],
            }

            ideal_epic = {
                'workspace': 'fixture', 'epic': 'ideal-epic', 'title': 'Detail epic', 'state': 'active',
                'members': [
                    detail_member('landed-member', 'merged'),
                    detail_member('active-member', 'in-progress', requires=['landed-member']),
                    detail_member('prepared-member', 'prepared', requires=['active-member']),
                ],
                'summary': {'total': 3, 'merged': 1, 'complete': 0, 'attention': 0},
                'next': 'active-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            ideal_payload = detail_envelope(ideal_epic, runs=[detail_run('active-member', 'detail-active')])
            for name, ref_path, payload in (('3', ref3[0], ideal_payload), ('44', ref44[0], conflict_payload)):
                for width in (1280, 1600):
                    check_deadline()
                    page.set_viewport_size({'width': width, 'height': 800})
                    page.goto(detail_uri(ref_path), wait_until='domcontentloaded')
                    reference_pane = page.locator('article.detail-pane')
                    expect(reference_pane).to_be_visible()
                    capture(reference_pane, f'epics-ref-{name}-{width}.png')
                    open_detail(payload)
                    capture(pane, f'epics-{name}-{width}.png')
                    assert_no_document_overflow()
                    report['scenarios'].append(f'detail reference and production regions captured for screen {name} at {width}x800')

            long_members = []
            long_runs = []
            for index in range(26):
                slug = f'long-member-{index:02d}-with-an-extended-dependency-slug-and-more-words'
                requires = [long_members[-1]['name']] if long_members else []
                status = 'in-progress' if index == 25 else 'merged'
                long_members.append(detail_member(slug, status, requires=requires))
                long_runs.append(detail_run(slug, f'detail-long-{index:02d}'))
            long_epic = {
                'workspace': 'fixture', 'epic': 'long-epic', 'title': 'Long slug epic', 'state': 'active',
                'members': long_members,
                'summary': {'total': 26, 'merged': 25, 'complete': 0, 'attention': 0},
                'next': long_members[-1]['name'],
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            page.set_viewport_size({'width': 1280, 'height': 800})
            open_detail(detail_envelope(long_epic, runs=long_runs))
            expect(table.locator('tbody th[scope=row]')).to_have_count(26)
            assert_no_document_overflow()
            assert pane.locator('.detail-body').evaluate('el => el.scrollWidth <= el.clientWidth'), 'detail region scrolled horizontally'
            assert pane.locator('.table-wrap').evaluate('el => el.scrollWidth <= el.clientWidth'), 'member table scrolled horizontally'
            long_button = table.locator('tbody tr').first.locator('button')
            expect(long_button).to_be_visible()
            measure(long_button, 'long wrapped member')
            open_action = pane.locator('.detail-actions .ds-btn--primary')
            expect(open_action).to_be_visible()
            action_box = open_action.bounding_box()
            assert action_box and action_box['y'] >= 0 and action_box['y'] + action_box['height'] <= 800, f'detail action not reachable: {action_box}'
            capture(pane, 'epics-long-table-1280.png')
            report['captures'] = {
                'production': ['epics-3-1280.png', 'epics-3-1600.png', 'epics-44-1280.png', 'epics-44-1600.png', 'epics-long-table-1280.png'],
                'reference': ['epics-ref-3-1280.png', 'epics-ref-3-1600.png', 'epics-ref-44-1280.png', 'epics-ref-44-1600.png'],
            }
            report['scenarios'].append('detail long table: 26 long slugs wrap without document horizontal scroll and detail actions stay reachable')

        groups = {'list': group_list, 'loading': group_loading, 'cold': group_cold, 'file': group_file, 'a11y': group_a11y}
        handlers = {**groups, 'detail': group_detail}
        selected = list(groups) if case == 'list' else [case]
        for name in selected:
            check_deadline()
            page = new_page()
            try:
                handlers[name](page)
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
    report_file = evidence / ('epics-detail.json' if case == 'detail' else 'epics-list.json')
    report['reportPath'] = str(report_file)
    report_file.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
