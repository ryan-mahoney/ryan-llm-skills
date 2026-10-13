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
bound app-ui reference captures; `--case observations` runs the EV-7 retained
transport/import gate with bound app-ui reference captures; `--case member`
runs the EV-4 real absolute-path member, return focus/scroll and precedence
gate; `--case documents` runs the EV-8 Supporting documents link/selection
gate through the real files and designs APIs; the other choices run one group
for debugging.
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
parser.add_argument('--case', choices=['list', 'loading', 'cold', 'file', 'a11y', 'detail', 'observations', 'member', 'documents'], default='list')
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
if case == 'documents':
    report['proofLimits'].append('Read/link selection only; no new file access authorization, iframe fidelity redesign or unavailable external producer mock.')
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

            # Real-producer null next with no waiting and nothing landed must
            # not claim completion: one in-progress member, no dependencies.
            lone_progress_epic = {
                'workspace': 'fixture', 'epic': 'lone-progress-epic', 'title': 'Lone progress epic', 'state': 'active',
                'members': [detail_member('solo', 'in-progress')],
                'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': None,
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(lone_progress_epic))
            expect(facts.nth(2).locator('strong')).to_have_text('None eligible')
            expect(facts.nth(2)).to_contain_text('No eligible candidate in this observation')
            expect(facts.nth(2)).not_to_contain_text('All members landed')
            expect(facts.nth(1)).to_contain_text('0 of 1')
            lone_published_epic = {
                'workspace': 'fixture', 'epic': 'lone-published-epic', 'title': 'Lone published epic', 'state': 'active',
                'members': [detail_member('solo', 'published')],
                'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': None,
                'coverage': {'state': 'complete', 'reasons': []},
            }
            check_deadline()
            open_detail(detail_envelope(lone_published_epic))
            expect(facts.nth(2).locator('strong')).to_have_text('None eligible')
            expect(facts.nth(2)).not_to_contain_text('All members landed')
            report['scenarios'].append('detail next fact: real-producer null next with in-progress/published and 0 of 1 landed never claims All members landed')

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

        def group_observations(page):
            # EV-7: retained transport/import behavior at the final HTTP boundary.
            fresh = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            old = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 600))
            control = {'value': 'pass'}
            held = []
            external = []

            def track(request):
                if request.url.startswith('http') and not request.url.startswith(receipt['url']):
                    external.append(request.url)

            page.on('request', track)

            def handler(route):
                value = control['value']
                if value == 'pass':
                    route.continue_()
                elif value == 'hold':
                    held.append(route)
                elif value == 'fail':
                    route.fulfill(status=503, content_type='application/json', body='{"error":"fixture-epics-observations"}')
                else:
                    route.fulfill(json=value)

            page.route('**/api/state**', handler)

            def observation_envelope(epic, mode, runs=()):
                payload = detail_envelope(epic, runs=runs)
                payload['generated_at'] = fresh
                coverage = payload['observers'][0]['snapshot']['coverage']
                if mode == 'missing':
                    coverage.pop('observed_at', None)
                else:
                    coverage['observed_at'] = fresh if mode == 'fresh' else old
                return payload

            def measure(locator, label):
                box = locator.bounding_box()
                assert box, f'{label} has no bounding box'
                assert box['width'] >= 44 and box['height'] >= 44, f'{label} is {box["width"]}x{box["height"]}, below 44x44'
                report.setdefault('hitBoxes', {})[label] = {'width': round(box['width'], 1), 'height': round(box['height'], 1)}

            def open_selected(payload):
                control['value'] = payload
                page.goto('about:blank')
                open_epics(page, ws='fixture')
                page.wait_for_function("() => location.hash.includes('id=')")
                expect(page.locator('article.detail-pane .object-head h2')).to_be_visible()

            observations_epic = {
                'workspace': 'fixture', 'epic': 'observations-epic', 'title': 'Observations epic', 'state': 'active',
                'members': [
                    detail_member('landed-member', 'merged'),
                    detail_member('active-member', 'in-progress', requires=['landed-member']),
                ],
                'summary': {'total': 2, 'merged': 1, 'complete': 0, 'attention': 0},
                'next': 'active-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            observations_runs = [detail_run('active-member', 'obs-active')]
            conflict_epic = {
                'workspace': 'fixture', 'epic': 'conflict-epic', 'title': 'Conflict epic', 'state': 'complete',
                'members': [
                    detail_member('published-member', 'published'),
                    detail_member('prepared-member', 'prepared'),
                    detail_member('progress-member', 'in-progress', requires=['prepared-member']),
                ],
                'summary': {'total': 3, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': 'progress-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            conflict_runs = [
                detail_run('published-member', 'obs-published'),
                detail_run('prepared-member', 'obs-prepared'),
                detail_run('progress-member', 'obs-progress'),
            ]
            pane = page.locator('article.detail-pane')
            facts = pane.locator('.facts .fact')
            table = pane.locator('table.epic-members')
            transport_callouts = pane.locator('.detail-body .ds-callout').filter(has_text=re.compile('Connection unavailable|Last checked at|Observation time unavailable'))
            conflict_callout = pane.locator('.detail-body .ds-callout').filter(has_text='Recorded state conflicts with member evidence')
            regional_callouts = pane.locator('.detail-body .ds-callout')
            generic_callout = pane.locator('.detail-body .ds-callout').filter(has_text='Member evidence incomplete')

            # (1) A usable payload first, then a real header refresh failure,
            # keeps the retained list/facts/table with one regional notice.
            open_selected(observation_envelope(observations_epic, 'fresh', runs=observations_runs))
            expect(rows_on(page)).to_have_count(1)
            expect(facts).to_have_count(3)
            expect(table.locator('tbody tr')).to_have_count(2)
            control['value'] = 'fail'
            page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
            expect(transport_callouts).to_have_count(1)
            offline_notice = transport_callouts.first
            expect(offline_notice).to_contain_text('Connection unavailable')
            expect(offline_notice).to_contain_text('Last received at')
            retry = offline_notice.get_by_role('button', name='Retry connection', exact=True)
            expect(retry).to_have_count(1)
            assert 'ds-btn--primary' in (retry.get_attribute('class') or ''), 'Retry connection is not the regional primary'
            expect(rows_on(page)).to_have_count(1)
            expect(facts).to_have_count(3)
            expect(table.locator('tbody tr')).to_have_count(2)
            assert page.locator('#notice').count() == 0, 'global #notice duplicated the Epics transport failure'
            report['scenarios'].append('offline: 503 after a usable payload keeps list/facts/table with one regional Connection unavailable and no global #notice')
            control['value'] = observation_envelope(observations_epic, 'fresh', runs=observations_runs)
            retry.click()
            expect(transport_callouts).to_have_count(0)
            expect(rows_on(page)).to_have_count(1)
            expect(facts).to_have_count(3)
            expect(table.locator('tbody tr')).to_have_count(2)
            report['scenarios'].append('offline recovery: Retry connection restores the notice-free retained read')

            # Offline receipt uses retained payload.generated_at, not the
            # observation clock: deliberately different and missing observed_at.
            expected_received = page.evaluate('iso => new Date(iso).toLocaleString()', fresh)
            open_selected(observation_envelope(observations_epic, 'old', runs=observations_runs))
            control['value'] = 'fail'
            page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text(f'Last received at {expected_received}')
            report['scenarios'].append(f'offline receipt: old observed_at still reports Last received at {expected_received} from generated_at')
            open_selected(observation_envelope(observations_epic, 'missing', runs=observations_runs))
            control['value'] = 'fail'
            page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text(f'Last received at {expected_received}')
            report['scenarios'].append(f'offline receipt: missing observed_at still reports Last received at {expected_received} from generated_at')

            # (2) Stale real-time wording, the missing-time fallback, and a held
            # refresh that clears only on a recent observation.
            stale_payload = observation_envelope(observations_epic, 'old', runs=observations_runs)
            open_selected(stale_payload)
            expect(transport_callouts).to_have_count(1)
            stale_notice = transport_callouts.first
            expected_time = page.evaluate('iso => new Date(iso).toLocaleString()', old)
            expect(stale_notice.locator('strong')).to_have_text(f'Last checked at {expected_time}')
            expect(stale_notice).to_contain_text('Existing content is kept while the host revalidates it.')
            refresh = stale_notice.get_by_role('button', name='Refresh state', exact=True)
            expect(refresh).to_have_count(1)
            assert 'ds-btn--primary' in (refresh.get_attribute('class') or ''), 'Refresh state is not the regional primary'
            expect(facts).to_have_count(3)
            expect(table.locator('tbody tr')).to_have_count(2)
            report['scenarios'].append(f'stale: old observed_at shows real-time Last checked at {expected_time} with Refresh state')

            open_selected(observation_envelope(observations_epic, 'missing', runs=observations_runs))
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text('Observation time unavailable')
            expect(transport_callouts.first).to_contain_text('Existing content is kept while the host revalidates it.')
            report['scenarios'].append('stale: missing observed_at falls back to Observation time unavailable')

            recent_payload = observation_envelope(observations_epic, 'fresh', runs=observations_runs)
            control['value'] = 'hold'
            transport_callouts.first.get_by_role('button', name='Refresh state', exact=True).click()
            page.wait_for_timeout(300)
            expect(transport_callouts).to_have_count(1)
            expect(rows_on(page)).to_have_count(1)
            expect(facts).to_have_count(3)
            expect(table.locator('tbody tr')).to_have_count(2)
            control['value'] = recent_payload
            for pending in held:
                try:
                    pending.fulfill(json=recent_payload)
                except Exception:
                    pass
            held.clear()
            expect(transport_callouts).to_have_count(0)
            expect(facts).to_have_count(3)
            expect(table.locator('tbody tr')).to_have_count(2)
            report['scenarios'].append('refresh held: readable contents stay while waiting and a recent observation clears the stale notice')

            # (3) Conflict facts stay beside exactly one regional notice: transport
            # wins as the single live callout with the no-rewrite explanation as
            # compact non-live text, never a second live region.
            conflict_fresh = observation_envelope(conflict_epic, 'fresh', runs=conflict_runs)
            conflict_stale = observation_envelope(conflict_epic, 'old', runs=conflict_runs)
            status = page.locator('article.detail-pane .object-head .status')
            open_selected(conflict_fresh)
            expect(status).to_contain_text('Recorded complete')
            expect(facts.nth(1)).to_contain_text('0 of 3')
            expect(conflict_callout).to_have_count(1)
            expect(transport_callouts).to_have_count(0)
            expect(regional_callouts).to_have_count(1)
            report['scenarios'].append('partial conflict: Recorded complete shows one regional conflict notice with 0 of 3 landed and no transport')
            control['value'] = 'fail'
            page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text('Connection unavailable')
            expect(regional_callouts).to_have_count(1)
            expect(conflict_callout).to_have_count(0)
            compact = pane.locator('.detail-body .section-note', has_text='The records have not been rewritten')
            expect(compact).to_have_count(1)
            expect(compact.first).to_contain_text('conflicting evidence is preserved')
            assert compact.first.evaluate('el => el.closest(".ds-callout") === null'), 'conflict compact rendered as a live callout'
            expect(status).to_contain_text('Recorded complete')
            expect(facts.nth(1)).to_contain_text('0 of 3')
            report['scenarios'].append('offline conflict: Recorded complete and the no-rewrite explanation stay beside 0 of 3 landed with exactly one transport callout')
            open_selected(conflict_stale)
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text('Last checked at')
            expect(regional_callouts).to_have_count(1)
            expect(conflict_callout).to_have_count(0)
            expect(pane.locator('.detail-body .section-note', has_text='The records have not been rewritten')).to_have_count(1)
            expect(status).to_contain_text('Recorded complete')
            expect(facts.nth(1)).to_contain_text('0 of 3')
            report['scenarios'].append('stale conflict: the stale transport notice does not hide the Recorded complete conflict explanation')
            # Generic partial without a completion conflict owns one live notice.
            generic_partial_epic = {
                'workspace': 'fixture', 'epic': 'generic-partial-epic', 'title': 'Generic partial epic', 'state': 'active',
                'members': [detail_member('unknown-member', 'unknown')],
                'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': None,
                'coverage': {'state': 'partial', 'reasons': ['member-incomplete:unknown-member']},
            }
            open_selected(observation_envelope(generic_partial_epic, 'fresh', runs=()))
            expect(generic_callout).to_have_count(1)
            expect(generic_callout.first).to_contain_text('Some member evidence is unavailable')
            expect(transport_callouts).to_have_count(0)
            expect(conflict_callout).to_have_count(0)
            expect(regional_callouts).to_have_count(1)
            report['scenarios'].append('generic partial: Member evidence incomplete owns the single regional notice with no transport or conflict callout')

            # (4) Repeated identical payloads add no callout mutation, and each
            # offline -> stale -> partial transition announces once.
            check_deadline()
            stale_one = observation_envelope(observations_epic, 'old', runs=observations_runs)
            open_selected(stale_one)
            expect(transport_callouts).to_have_count(1)
            page.evaluate("""() => {
              window.__epicsAnnouncements = [];
              window.__epicsTextMutations = 0;
              const region = document.querySelector('article.detail-pane .detail-body');
              window.__epicsObserver = new MutationObserver(records => {
                for (const record of records) {
                  if (record.type === 'characterData') {
                    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                    if (target && target.closest('.ds-callout')) window.__epicsTextMutations += 1;
                    continue;
                  }
                  for (const node of record.addedNodes) {
                    const el = node.nodeType === 1 ? node : null;
                    if (el && el.classList && el.classList.contains('ds-callout')) {
                      window.__epicsAnnouncements.push(el.textContent.trim().slice(0, 80));
                    }
                  }
                }
              });
              window.__epicsObserver.observe(region, {childList: true, subtree: true, characterData: true});
            }""")

            def settled_refresh():
                with page.expect_response(lambda response: '/api/state' in response.url):
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                page.wait_for_function("() => { const b = document.querySelector('.head-actions button[aria-busy]'); return !b || b.getAttribute('aria-busy') !== 'true'; }")

            for _ in range(3):
                settled_refresh()
            assert page.evaluate('() => window.__epicsAnnouncements.length') == 0, f'identical payload announced a new callout: {page.evaluate("() => window.__epicsAnnouncements")}'
            assert page.evaluate('() => window.__epicsTextMutations') == 0, 'identical payload changed callout text'

            # Timestamp-only stale (same selection/state/reasons, advancing
            # observation timestamp) must not insert another live region.
            older = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 700))
            stale_two = observation_envelope(observations_epic, 'old', runs=observations_runs)
            stale_two['observers'][0]['snapshot']['coverage']['observed_at'] = older
            control['value'] = stale_two
            settled_refresh()
            page.wait_for_timeout(200)
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text('Last checked at')
            assert page.evaluate('() => window.__epicsAnnouncements.length') == 0, f'timestamp-only stale announced a new callout: {page.evaluate("() => window.__epicsAnnouncements")}'

            control['value'] = 'fail'
            settled_refresh()
            expect(transport_callouts.first).to_contain_text('Connection unavailable')
            page.wait_for_function('() => window.__epicsAnnouncements.length === 1')
            settled_refresh()
            page.wait_for_timeout(200)
            assert page.evaluate('() => window.__epicsAnnouncements.length') == 1, 'offline signature announced more than once'

            control['value'] = stale_one
            settled_refresh()
            expect(transport_callouts.first).to_contain_text('Last checked at')
            page.wait_for_function('() => window.__epicsAnnouncements.length === 2')

            control['value'] = conflict_fresh
            settled_refresh()
            expect(conflict_callout).to_have_count(1)
            expect(conflict_callout).to_contain_text('Recorded state conflicts with member evidence')
            expect(transport_callouts).to_have_count(0)
            expect(regional_callouts).to_have_count(1)
            # Cross-epic refresh remounts the detail pane, so the stranded
            # observer cannot see it: rebind a fresh observer on the new body
            # to prove same-epic partial repeats and reason changes.
            page.evaluate("""() => {
              window.__epicsAnnouncements = [];
              window.__epicsTextMutations = 0;
              const region = document.querySelector('article.detail-pane .detail-body');
              window.__epicsObserver.disconnect();
              window.__epicsObserver = new MutationObserver(records => {
                for (const record of records) {
                  if (record.type === 'characterData') {
                    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                    if (target && target.closest('.ds-callout')) window.__epicsTextMutations += 1;
                    continue;
                  }
                  for (const node of record.addedNodes) {
                    const el = node.nodeType === 1 ? node : null;
                    if (el && el.classList && el.classList.contains('ds-callout')) {
                      window.__epicsAnnouncements.push(el.textContent.trim().slice(0, 80));
                    }
                  }
                }
              });
              window.__epicsObserver.observe(region, {childList: true, subtree: true, characterData: true});
            }""")
            partial_text = page.evaluate('() => window.__epicsTextMutations')
            settled_refresh()
            page.wait_for_timeout(200)
            assert page.evaluate('() => window.__epicsAnnouncements.length') == 0, f'partial repeat announced again: {page.evaluate("() => window.__epicsAnnouncements")}'
            assert page.evaluate('() => window.__epicsTextMutations') == partial_text, 'identical conflict payload changed callout text'
            expect(conflict_callout).to_have_count(1)
            # Changed semantic reasons announce again: same conflict epic with
            # an added coverage reason is a new regional signature.
            reasoned_conflict = {**conflict_epic, 'coverage': {'state': 'complete', 'reasons': ['member-incomplete:progress-member']}}
            reasoned_envelope = observation_envelope(reasoned_conflict, 'fresh', runs=conflict_runs)
            control['value'] = reasoned_envelope
            settled_refresh()
            expect(conflict_callout).to_have_count(1)
            expect(regional_callouts).to_have_count(1)
            page.wait_for_function('() => window.__epicsAnnouncements.length === 1')
            # Generic partial reason change also announces: same generic epic
            # with an added reason is a new signature.
            generic_reason_epic = {**generic_partial_epic, 'coverage': {'state': 'partial', 'reasons': ['member-incomplete:unknown-member', 'member-unobserved:other']}}
            control['value'] = observation_envelope(generic_reason_epic, 'fresh', runs=())
            open_selected(control['value'])
            expect(generic_callout).to_have_count(1)
            expect(regional_callouts).to_have_count(1)
            announcements = page.evaluate('() => window.__epicsAnnouncements')
            report['scenarios'].append('signature: identical and timestamp-only payloads add no callout; offline and stale announce once each; same-epic partial repeat adds none while changed coverage reasons announce again')

            # (5) A real #import-file snapshot offers no live recovery and keeps
            # only the truncation/envelope diagnostics.
            check_deadline()
            control['value'] = 'pass'
            imported_envelope = {
                **real_state,
                'generated_at': fresh,
                'truncated': True,
                'errors': [{'source': 'fixture-observation', 'message': 'Observation envelope diagnostic retained'}],
                'observers': [{**real_observer, 'state': 'observing', 'published_at': old, 'snapshot': {**real_observer['snapshot'], 'epics': [observations_epic]}}],
            }
            import_file = evidence / 'epics-observations-import.json'
            import_file.write_text(json.dumps(imported_envelope))
            try:
                page.goto('about:blank')
                page.goto(receipt['url'] + '/#/specs', wait_until='domcontentloaded')
                page.locator('#import-file').set_input_files(str(import_file))
                expect(page.get_by_text('Imported snapshot', exact=True)).to_be_visible()
                page.evaluate("() => { location.hash = '#/epics'; }")
                expect(page.locator('h1')).to_have_text('Epics')
                page.wait_for_function("() => location.hash.includes('id=')")
                expect(rows_on(page)).to_have_count(1)
                expect(facts).to_have_count(3)
                expect(table.locator('tbody tr')).to_have_count(2)
                expect(transport_callouts).to_have_count(0)
                expect(pane.locator('.detail-body').get_by_role('button', name=re.compile('Retry connection|Refresh state'))).to_have_count(0)
                notice = page.locator('#notice')
                expect(notice).to_contain_text('Snapshot read budget reached')
                expect(notice).to_contain_text('fixture-observation: Observation envelope diagnostic retained')
                expect(notice).not_to_contain_text('Observer heartbeat is stale')
                expect(notice).not_to_contain_text('Could not refresh workspace state')
                report['scenarios'].append('import: real #import-file snapshot keeps facts without regional retry/refresh and retains truncation/envelope diagnostics only')
            finally:
                import_file.unlink(missing_ok=True)

            # (6) Bound 45/46 references and retained-state captures.
            check_deadline()
            design_dir = resolve_designs_dir()
            ref45 = verify_reference(design_dir, 'screens/45-epics-offline.html', 'f9bb2eb9a6955afa8bcf781d3656163db47a342ec6ba5c0acf98803d51fa9df6')
            ref46 = verify_reference(design_dir, 'screens/46-epics-stale.html', '55065def2592a03d2246bf551c48ab31d730170e077ddb369bd70ef821c4b811')
            ref44 = verify_reference(design_dir, 'screens/44-epics-partial.html', '1c73b1466711c2d98d68a550144095f5587a6fe67070767187a953cfdbb9ad5b')
            report['references'] = {'designsDir': str(design_dir), 'files': [{'path': str(path), 'sha256': digest} for path, digest in (ref45, ref46, ref44)]}
            for name, ref in (('45', ref45), ('46', ref46)):
                for width in (1280, 1600):
                    check_deadline()
                    page.set_viewport_size({'width': width, 'height': 800})
                    page.goto(detail_uri(ref[0]), wait_until='domcontentloaded')
                    reference_pane = page.locator('article.detail-pane')
                    expect(reference_pane).to_be_visible()
                    ref_path = browser_evidence / f'epics-ref-{name}-{width}.png'
                    reference_pane.screenshot(path=str(ref_path))
                    report['screenshots'].append(str(ref_path))
            control['value'] = observation_envelope(observations_epic, 'fresh', runs=observations_runs)
            page.goto('about:blank')
            open_epics(page, ws='fixture')
            page.wait_for_function("() => location.hash.includes('id=')")
            control['value'] = 'fail'
            page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text('Connection unavailable')
            for width in (1280, 1600):
                page.set_viewport_size({'width': width, 'height': 800})
                path = browser_evidence / f'epics-45-{width}.png'
                pane.screenshot(path=str(path))
                report['screenshots'].append(str(path))
                assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), f'document overflow at {width}'
            measure(transport_callouts.first.get_by_role('button', name='Retry connection', exact=True), 'observations Retry connection')
            open_action = pane.locator('.detail-actions .ds-btn')
            assert 'ds-btn--primary' not in (open_action.get_attribute('class') or ''), 'Open spec stayed primary beside the transport notice'
            assert pane.locator('.detail-actions .ds-btn--primary').count() == 0, 'transport lost its sole primary'
            measure(open_action, 'observations Open spec')
            control['value'] = observation_envelope(observations_epic, 'old', runs=observations_runs)
            page.goto('about:blank')
            open_epics(page, ws='fixture')
            page.wait_for_function("() => location.hash.includes('id=')")
            expect(transport_callouts).to_have_count(1)
            expect(transport_callouts.first).to_contain_text('Last checked at')
            for width in (1280, 1600):
                page.set_viewport_size({'width': width, 'height': 800})
                path = browser_evidence / f'epics-46-{width}.png'
                pane.screenshot(path=str(path))
                report['screenshots'].append(str(path))
                assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), f'document overflow at {width}'
            measure(transport_callouts.first.get_by_role('button', name='Refresh state', exact=True), 'observations Refresh state')
            assert not external, f'observations made a non-fixture request: {external}'
            report['scenarios'].append('captures: bound 45/46/44 digests recorded; reference and production panes captured at 1280 and 1600 with single-primary hierarchy, 44px targets and no overflow')

        def group_member(page):
            # EV-4: real absolute-path member records plus in-session return.
            # buildEpics publishes member.package as the absolute canonical
            # package directory, so a member control that forwards the path
            # instead of the slug cannot resolve. Expectations are hand-derived
            # from docs/spec-epics.md R-3 and the published return contract.
            run_package = Path(real_observer['snapshot']['runs'][0]['package'])
            assert run_package.name == 'browser', f'unexpected fixture package path: {run_package}'
            fixture_dir = run_package.parents[1]
            projects_dir = run_package.parents[2]
            fixture_package = str(run_package)
            foreign_package = str(projects_dir / 'other' / 'specs' / 'browser')

            def stamp():
                return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

            def member(name, status='in-progress'):
                return {
                    'name': name,
                    'package': str(fixture_dir / 'specs' / name),
                    'workspace': 'fixture',
                    'status': status,
                    'waiting_on': [],
                    'requires': [],
                }

            def member_run(assignment, package, workspace='fixture', **extra):
                record = {
                    'workspace': workspace,
                    'package': package,
                    'package_ref': f'{workspace}/{Path(package).name}',
                    'assignment_id': assignment,
                    'workflow_id': f'{assignment}-workflow',
                    'execution': 'running',
                    'workflow_state': 'waiting-worker',
                    'is_current_assignment': False,
                    'observed_at': stamp(),
                    'coverage': {'state': 'complete', 'reasons': []},
                }
                record.update(extra)
                return record

            def member_envelope(epics, runs=(), completed=(), planned=()):
                published = stamp()
                observer = {
                    'schema_version': 1,
                    'observer_id': 'epics-member-fixture',
                    'state': 'observing',
                    'published_at': published,
                    'snapshot': {
                        'workspace': 'fixture',
                        'coverage': {'state': 'complete', 'observed_at': published, 'reasons': []},
                        'runs': list(runs),
                        'recently_completed': list(completed),
                        'assignments': [],
                        'assignment_coverage': {'state': 'complete', 'reasons': []},
                        'epics': list(epics),
                        'planned_packages': list(planned),
                    },
                }
                return {**real_state, 'observers': [observer]}

            def member_epic(slug, title, members):
                return {
                    'workspace': 'fixture',
                    'epic': slug,
                    'title': title,
                    'state': 'active',
                    'members': members,
                    'next': members[-1]['name'] if members else '',
                    'coverage': {'state': 'complete', 'reasons': []},
                }

            continuity_members = [member(f'member-{index:02d}', status='merged') for index in range(18)]
            continuity_members.append(member('browser'))
            continuity_members.extend(member(f'member-{index:02d}', status='prepared') for index in range(19, 40))
            filler_epics = [
                member_epic(f'filler-{index:02d}', f'Continuity filler {index:02d}', [member(f'filler-{index:02d}-member', status='prepared')])
                for index in range(1, 29)
            ]

            def continuity_payload(members=None, runs=None):
                target = member_epic('continuity', 'Continuity epic', members or continuity_members)
                trailing = member_epic('continuity-b', 'Continuity zebra', [member('beta-member', status='prepared')])
                records = [real_observer['snapshot']['runs'][0]] if runs is None else runs
                return member_envelope([target, trailing, *filler_epics], runs=records)

            mode = {'value': None}

            def member_handler(route):
                if mode['value'] is None:
                    route.continue_()
                else:
                    route.fulfill(json=mode['value'])

            page.route('**/api/state**', member_handler)

            def open_continuity():
                mode['value'] = continuity_payload()
                page.goto('about:blank')
                open_epics(page, ws='fixture', q='continuity')
                expect(rows_on(page)).to_have_count(30)
                page.wait_for_function("() => location.hash.includes('id=')")
                assert params_on(page).get('id'), page.url

            def list_scroller():
                return page.locator('.list-pane .records')

            def detail_scroller():
                return page.locator('.detail-pane .detail-body')

            def scroll_and_click_member():
                list_scroller().evaluate('el => { el.scrollTop = el.scrollHeight; }')
                page.wait_for_timeout(50)
                list_scroll = list_scroller().evaluate('el => el.scrollTop')
                assert list_scroll > 0, 'epic list pane did not scroll'
                button = page.locator('table.epic-members button', has_text='browser')
                expect(button).to_have_count(1)
                button.scroll_into_view_if_needed()
                detail_scroll = detail_scroller().evaluate('el => el.scrollTop')
                assert detail_scroll > 0, 'epic detail pane did not scroll'
                button.click()
                return list_scroll, detail_scroll

            def wait_restored_member(list_scroll, detail_scroll):
                page.wait_for_function("""() => {
                  const active = document.activeElement;
                  return Boolean(active && active.closest('table.epic-members')
                    && active.textContent.trim() === 'browser');
                }""")
                page.wait_for_function("""expected => {
                  const list = document.querySelector('.list-pane .records');
                  const detail = document.querySelector('.detail-pane .detail-body');
                  return Boolean(list && detail
                    && Math.abs(list.scrollTop - expected[0]) <= 2
                    && Math.abs(detail.scrollTop - expected[1]) <= 2);
                }""", arg=[list_scroll, detail_scroll])

            def refresh_state():
                with page.expect_response(lambda response: '/api/state' in response.url):
                    page.evaluate("""() => {
                      const button = [...document.querySelectorAll('.head-actions button')]
                        .find(el => el.textContent.trim() === 'Refresh state');
                      if (button) button.click();
                    }""")
                page.wait_for_timeout(300)

            def wait_epic_id(expected):
                page.wait_for_function(
                    "expected => new URLSearchParams(location.hash.split('?')[1] || '').get('id') === expected",
                    arg=expected,
                )

            def no_member_focus():
                return page.evaluate("""() => {
                  const active = document.activeElement;
                  return Boolean(!active || !active.closest || !active.closest('table.epic-members'));
                }""")

            def panes_at_top():
                return page.evaluate("""() => {
                  const list = document.querySelector('.list-pane .records');
                  const detail = document.querySelector('.detail-pane .detail-body');
                  return Boolean(list && detail && Math.abs(list.scrollTop) <= 2 && Math.abs(detail.scrollTop) <= 2);
                }""")

            # (a) an ordinary absolute-path member opens its real Specs record;
            # Back restores epic id/q/ws, member focus and both pane scrolls,
            # and Forward selects the same spec.
            check_deadline()
            open_continuity()
            epic_id = params_on(page)['id'][0]
            list_scroll, detail_scroll = scroll_and_click_member()
            expect(page.locator('h1')).to_have_text('Specs')
            spec_id = params_on(page).get('id', [None])[0]
            assert spec_id and 'recent-completion' not in spec_id, page.url
            assert params_on(page)['ws'] == ['fixture'], page.url
            assert not {'q', 'filter', 'tab', 'path', 'source'} & params_on(page).keys(), page.url
            expect(page.locator('#find-record')).to_have_value('')
            expect(page.locator('article.detail h2')).to_have_text('browser')
            expect(page.locator('article.detail')).to_contain_text('Building the dashboard')
            report['scenarios'].append('member: a real absolute-path member opens its same-workspace Specs record with no epic q/filter/tab left behind')

            page.go_back()
            expect(page.locator('h1')).to_have_text('Epics')
            assert params_on(page)['id'] == [epic_id], page.url
            assert params_on(page)['q'] == ['continuity'] and params_on(page)['ws'] == ['fixture'], page.url
            wait_restored_member(list_scroll, detail_scroll)
            report['scenarios'].append('member: Back restores epic id/query/workspace plus member focus and list/detail scroll')

            page.go_forward()
            expect(page.locator('h1')).to_have_text('Specs')
            assert params_on(page).get('id') == [spec_id], page.url
            expect(page.locator('article.detail h2')).to_have_text('browser')
            report['scenarios'].append('member: Forward selects the same Specs record')

            # (b) same-workspace active > planned > non-recent precedence, a
            # same-slug other-workspace record cannot win, and a member without
            # a record has no active control.
            active_run = member_run('member-active', fixture_package, is_current_assignment=True, activity='Active member record')
            historical_run = member_run('member-history', str(projects_dir / 'fixture' / 'archive' / 'browser'), execution='cancelled', workflow_state='cancelled', activity='Historical member record')
            completed_run = member_run('member-done', str(projects_dir / 'fixture' / 'done' / 'browser'), execution='completed', workflow_state='complete', completion_basis='merged-pr', completed_at=stamp(), activity='Recently completed member record')
            foreign_run = member_run('member-foreign', foreign_package, workspace='other', is_current_assignment=True, activity='Foreign workspace record')
            planned_record = {'workspace': 'fixture', 'package': str(projects_dir / 'fixture' / 'planned' / 'browser'), 'package_ref': 'fixture/planned-browser', 'source_paths': ['spec.md']}
            precedence_epic = member_epic('precedence', 'Precedence epic', [member('browser'), member('ghost-member', status='prepared')])

            def open_precedence(runs, completed=(), planned=()):
                mode['value'] = member_envelope([precedence_epic], runs=runs, completed=completed, planned=planned)
                page.goto('about:blank')
                open_epics(page, ws='fixture', q='precedence')
                page.wait_for_function("() => location.hash.includes('id=')")
                expect(rows_on(page)).to_have_count(1)

            def click_browser():
                button = page.locator('table.epic-members button', has_text='browser')
                expect(button).to_have_count(1)
                button.click()

            def assert_spec_record(activity=None, filter_value=None, ref=None, completion=False):
                expect(page.locator('h1')).to_have_text('Specs')
                selected = params_on(page).get('id', [None])[0]
                assert selected, page.url
                if completion:
                    assert 'recent-completion' in selected, page.url
                else:
                    assert 'recent-completion' not in selected, page.url
                if filter_value is None:
                    assert 'filter' not in params_on(page), page.url
                else:
                    assert params_on(page)['filter'] == [filter_value], page.url
                detail = page.locator('article.detail')
                expect(detail).to_have_count(1)
                if activity:
                    expect(detail).to_contain_text(activity)
                if ref:
                    expect(detail).to_contain_text(ref)

            check_deadline()
            open_precedence(runs=[active_run, historical_run, foreign_run], completed=[completed_run], planned=[planned_record])
            ghost = page.locator('table.epic-members tbody tr', has_text='ghost-member')
            expect(ghost.locator('button')).to_have_count(0)
            expect(ghost).to_contain_text('No observed package matches this member in scope.')
            report['scenarios'].append('member: a member without a matching record stays text with no active control')
            click_browser()
            assert_spec_record(activity='Active member record')
            report['scenarios'].append('member precedence: an active same-workspace record wins over planned, historical and recent records')

            check_deadline()
            open_precedence(runs=[historical_run, foreign_run], completed=[completed_run], planned=[planned_record])
            click_browser()
            assert_spec_record(filter_value='planned', ref='fixture/planned-browser')
            report['scenarios'].append('member precedence: without an active record the planned package record wins')

            check_deadline()
            open_precedence(runs=[historical_run, foreign_run], completed=[completed_run])
            click_browser()
            assert_spec_record(activity='Historical member record')
            report['scenarios'].append('member precedence: without active or planned records the non-recent run wins')

            check_deadline()
            open_precedence(runs=[foreign_run], completed=[completed_run])
            click_browser()
            assert_spec_record(filter_value='completed', activity='Recently completed member record', completion=True)
            report['scenarios'].append('member precedence: a recently completed record is chosen only last')

            check_deadline()
            open_precedence(runs=[foreign_run, historical_run])
            click_browser()
            assert_spec_record(activity='Historical member record')
            expect(page.locator('article.detail')).not_to_contain_text('Foreign workspace record')
            report['scenarios'].append('member precedence: a same-slug active record in another workspace cannot win')

            # (c1) a consumed token is one-use: an unchanged same-epic poll does
            # not steal focus or scroll back to the remembered member.
            check_deadline()
            open_continuity()
            list_scroll, detail_scroll = scroll_and_click_member()
            expect(page.locator('h1')).to_have_text('Specs')
            page.go_back()
            expect(page.locator('h1')).to_have_text('Epics')
            wait_restored_member(list_scroll, detail_scroll)
            page.locator('#find-record').focus()
            page.evaluate("""() => {
              const list = document.querySelector('.list-pane .records');
              const detail = document.querySelector('.detail-pane .detail-body');
              list.scrollTop = 0;
              detail.scrollTop = 0;
            }""")
            refresh_state()
            assert page.evaluate("() => document.activeElement && document.activeElement.id === 'find-record'"), 'unchanged poll moved focus away from the user selection'
            assert panes_at_top(), 'unchanged poll restored a consumed scroll token'
            report['scenarios'].append('member return: an unchanged same-epic poll does not reapply the consumed focus/scroll token')

            # (c2) a deliberate different epic or scope drops the token.
            check_deadline()
            open_continuity()
            scroll_and_click_member()
            expect(page.locator('h1')).to_have_text('Specs')
            epic_a = json.dumps(['fixture', 'continuity'], separators=(',', ':'))
            epic_b = json.dumps(['fixture', 'continuity-b'], separators=(',', ':'))
            page.evaluate("hash => { location.hash = hash; }", '#/epics?' + urlencode({'ws': 'fixture', 'q': 'continuity', 'id': epic_b}))
            expect(page.locator('h1')).to_have_text('Epics')
            wait_epic_id(epic_b)
            page.evaluate("hash => { location.hash = hash; }", '#/epics?' + urlencode({'ws': 'fixture', 'q': 'continuity', 'id': epic_a}))
            wait_epic_id(epic_a)
            page.wait_for_timeout(300)
            assert no_member_focus(), 'a stale token focused the member after a deliberate epic change'
            assert panes_at_top(), 'a stale token restored scroll after a deliberate epic change'
            report['scenarios'].append('member return: a deliberate different epic drops the token instead of restoring stale focus/scroll')

            page.locator('table.epic-members button', has_text='browser').click()
            expect(page.locator('h1')).to_have_text('Specs')
            page.evaluate("hash => { location.hash = hash; }", '#/epics?' + urlencode({'ws': 'other'}))
            expect(page.locator('h1')).to_have_text('Epics')
            page.wait_for_function("() => new URLSearchParams(location.hash.split('?')[1] || '').get('ws') === 'other'")
            expect(page.get_by_role('heading', name='No epics recorded', exact=True)).to_be_visible()
            page.evaluate("hash => { location.hash = hash; }", '#/epics?' + urlencode({'ws': 'fixture', 'q': 'continuity', 'id': epic_a}))
            wait_epic_id(epic_a)
            page.wait_for_timeout(300)
            assert no_member_focus(), 'a stale token focused the member after a deliberate scope change'
            assert panes_at_top(), 'a stale token restored scroll after a deliberate scope change'
            report['scenarios'].append('member return: a deliberate scope change drops the token instead of restoring stale focus/scroll')

            # (c3) an unavailable remembered member must not focus an
            # unrelated member row.
            check_deadline()
            open_continuity()
            scroll_and_click_member()
            expect(page.locator('h1')).to_have_text('Specs')
            alternate_run = member_run('member-alternate', str(fixture_dir / 'specs' / 'browser-two'), is_current_assignment=True, activity='Alternate member record')
            mode['value'] = continuity_payload([member('browser-two', status='prepared')], runs=[real_observer['snapshot']['runs'][0], alternate_run])
            refresh_state()
            expect(page.locator('h1')).to_have_text('Specs')
            page.go_back()
            expect(page.locator('h1')).to_have_text('Epics')
            expect(page.locator('table.epic-members button', has_text='browser-two')).to_have_count(1)
            page.wait_for_timeout(400)
            assert no_member_focus(), 'a missing remembered member focused an unrelated row'
            report['scenarios'].append('member return: an unavailable remembered member does not focus an unrelated member row')

        def group_documents(page):
            # EV-8: Supporting documents links through the real files and
            # designs routes. Only the final /api/state response is substituted;
            # the catalog, workspace-file and workspace-designs routes stay
            # real, and the plan fixture lives inside fixture-owned storage that
            # browser-fixture.mjs removes with its temporary root on close.
            catalog_payload = context.request.get(receipt['url'] + '/api/workspaces').json()
            catalog_entries = catalog_payload.get('valid') or []
            fixture_entry = next((entry for entry in catalog_entries if entry.get('id') == 'fixture'), None)
            if fixture_entry is None:
                fixture_entry = next((entry for entry in catalog_entries if Path(str(entry.get('directory', ''))).name == 'fixture'), None)
            assert fixture_entry is not None, f'fixture workspace entry missing from the real catalog: {catalog_entries}'
            workspace_id = str(fixture_entry['id'])
            documents_dir = str(fixture_entry.get('directory') or run_package.parents[1])
            fixture_basename = Path(documents_dir).name
            assert fixture_basename == 'fixture', f'catalog fixture directory is not the fixture workspace: {documents_dir}'

            marker = f'Documents marker {os.getpid()} independently written plan sentence for the real Files reader.'
            plan_relative = f'plans/documents-plan-{os.getpid()}.md'
            plan_name = Path(plan_relative).name
            plan_file = Path(documents_dir) / plan_relative
            plan_file.parent.mkdir(parents=True, exist_ok=True)
            plan_file.write_text(f'# Supporting plan fixture\n\n{marker}\n')
            plan_absolute = str(plan_file)

            served_plan = context.request.get(receipt['url'] + '/api/workspace-file?' + urlencode({'id': workspace_id, 'file': plan_relative}))
            assert served_plan.ok and marker in served_plan.text(), 'real /api/workspace-file did not serve the independently written plan'
            served_designs = context.request.get(receipt['url'] + '/api/workspace-designs?' + urlencode({'id': workspace_id})).json()
            assert any(design.get('slug') == 'demo' for design in served_designs.get('designs', [])), 'real /api/workspace-designs does not expose the fixture demo design'

            linked_epic = {
                'workspace': fixture_basename, 'epic': 'documents-linked', 'title': 'Documents linked epic', 'state': 'active',
                'plan': plan_absolute,
                'designs': [{'workspace': workspace_id, 'design': 'demo', 'path': f'{documents_dir}/designs/demo'}],
                'members': [detail_member('linked-member', 'merged')],
                'summary': {'total': 1, 'merged': 1, 'complete': 0, 'attention': 0},
                'next': '',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            fallback_epic = {
                'workspace': fixture_basename, 'epic': 'documents-unresolved', 'title': 'Documents unresolved epic', 'state': 'active',
                'plan': '/outside-of-workspace/documents-plan.md',
                'designs': [{'workspace': 'no-such-kit', 'design': 'outside-design', 'path': '/outside-of-workspace/designs/outside'}],
                'members': [detail_member('fallback-member', 'prepared')],
                'summary': {'total': 1, 'merged': 0, 'complete': 0, 'attention': 0},
                'next': 'fallback-member',
                'coverage': {'state': 'complete', 'reasons': []},
            }
            mode = {'value': detail_envelope(linked_epic, runs=[])}
            mode['value']['observers'][0]['snapshot']['epics'] = [linked_epic, fallback_epic]

            def handler(route):
                if mode['value'] is None:
                    route.continue_()
                else:
                    route.fulfill(json=mode['value'])

            page.route('**/api/state**', handler)

            def href_params(href):
                return parse_qs(urlsplit(href or '').fragment.partition('?')[2])

            def assert_no_document_overflow():
                width = page.viewport_size['width']
                assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), f'document overflow at {width}'

            def measure(locator, label):
                box = locator.bounding_box()
                assert box, f'{label} has no bounding box'
                assert box['width'] >= 44 and box['height'] >= 44, f'{label} is {box["width"]}x{box["height"]}, below 44x44'
                report.setdefault('hitBoxes', {})[label] = {'width': round(box['width'], 1), 'height': round(box['height'], 1)}

            def tab_until(predicate, limit=120):
                for _ in range(limit):
                    page.keyboard.press('Tab')
                    if page.evaluate(predicate):
                        return True
                return False

            def focus_visible():
                assert page.evaluate('document.activeElement && document.activeElement.matches(":focus-visible")'), 'focused element has no :focus-visible ring'
                assert page.evaluate('getComputedStyle(document.activeElement).outlineStyle !== "none"'), 'focused element has no outline'

            def capture(locator, name):
                path = browser_evidence / name
                locator.screenshot(path=str(path))
                report['screenshots'].append(str(path))
                return str(path)

            pane = page.locator('article.detail-pane')
            open_epics(page, ws=workspace_id)
            expect(rows_on(page)).to_have_count(2)
            page.locator('.records .record', has_text='Documents linked epic').click()
            expect(pane.locator('.object-head h2')).to_have_text('Documents linked epic')
            linked_id = params_on(page).get('id', [None])[0]
            assert linked_id, page.url

            documents = pane.locator('section.epic-documents')
            table = documents.locator('table.epic-documents')
            expect(documents).to_have_count(1)
            expect(documents.get_by_role('heading', name='Supporting documents', exact=True)).to_be_visible()
            expect(table.locator('caption')).to_have_text('Supporting documents of Documents linked epic')
            headers = table.locator('thead th[scope=col]')
            expect(headers.nth(0)).to_have_text('Document')
            expect(headers.nth(1)).to_have_text('Source')
            rows = table.locator('tbody tr')
            expect(rows).to_have_count(2)
            plan_link = rows.nth(0).locator('a.text-link.mono')
            expect(plan_link).to_have_text(plan_name)
            plan_params = href_params(plan_link.get_attribute('href'))
            assert plan_params.get('ws') == [workspace_id], plan_link.get_attribute('href')
            assert plan_params.get('source') == ['workspace'], plan_link.get_attribute('href')
            assert plan_params.get('path') == [plan_relative], plan_link.get_attribute('href')
            expect(rows.nth(0).locator('td')).to_contain_text(plan_absolute)
            design_link = rows.nth(1).locator('a.text-link.mono')
            expect(design_link).to_have_text('demo')
            design_params = href_params(design_link.get_attribute('href'))
            assert design_params.get('ws') == [workspace_id] and design_params.get('id') == ['demo'], design_link.get_attribute('href')
            expect(rows.nth(1).locator('td')).to_contain_text(f'{documents_dir}/designs/demo')
            report['scenarios'].append('documents: real catalog resolves the plan to #/files ws/source/path and the design to #/designs ws/id with caption, headers and source text')

            page.locator('#find-record').focus()
            assert tab_until(f"document.activeElement && document.activeElement.textContent.trim() === '{plan_name}'"), 'Tab never reached the plan document link'
            focus_visible()
            measure(plan_link, 'plan document link')
            page.keyboard.press('Tab')
            assert page.evaluate("document.activeElement && document.activeElement.textContent.trim() === 'demo'"), 'Tab after the plan did not reach the design link'
            focus_visible()
            measure(design_link, 'design document link')
            report['scenarios'].append('documents keyboard: plan and design links expose visible focus and 44x44 hit boxes')

            plan_link.click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params_on(page).get('ws') == [workspace_id] and params_on(page).get('source') == ['workspace'] and params_on(page).get('path') == [plan_relative], page.url
            viewer = page.locator('section.file-viewer')
            expect(viewer.locator('h4')).to_have_text(plan_relative)
            expect(viewer.locator('#file-content')).to_contain_text(marker)
            report['scenarios'].append('documents: clicking the plan link opens the real Files source=workspace reader and displays the independently written plan text, not only the URL')

            page.go_back()
            expect(page.locator('h1')).to_have_text('Epics')
            page.locator('.records .record', has_text='Documents unresolved epic').click()
            expect(pane.locator('.object-head h2')).to_have_text('Documents unresolved epic')
            fallback_documents = pane.locator('section.epic-documents')
            expect(fallback_documents).to_have_count(1)
            expect(fallback_documents.locator('a')).to_have_count(0)
            expect(fallback_documents).to_contain_text('documents-plan.md')
            expect(fallback_documents).to_contain_text('/outside-of-workspace/documents-plan.md')
            expect(fallback_documents).to_contain_text('outside-design')
            expect(page.get_by_text('No plan or designs recorded', exact=False)).to_have_count(0)
            report['scenarios'].append('documents: an unresolved plan/design outside the catalog renders source and name as plain text with no fabricated destination')

            page.locator('.records .record', has_text='Documents linked epic').click()
            expect(pane.locator('.object-head h2')).to_have_text('Documents linked epic')
            page.locator('table.epic-documents tbody tr').nth(1).locator('a.text-link.mono').click()
            expect(page.locator('h1')).to_have_text('Designs')
            assert params_on(page).get('ws') == [workspace_id] and params_on(page).get('id') == ['demo'], page.url
            expect(page.locator('section.design-viewer h4')).to_contain_text('Design fixture')
            report['scenarios'].append('documents: clicking the design link routes ws=<kit id>&id=demo and the real /api/workspace-designs listing selects the demo design')

            check_deadline()
            page.goto('about:blank')
            page.goto(receipt['url'] + '/#/designs?' + urlencode({'ws': workspace_id, 'id': 'demo'}), wait_until='domcontentloaded')
            expect(page.locator('section.design-viewer h4')).to_contain_text('Design fixture · Screen 1')
            report['scenarios'].append('documents designs: a cold addressed #/designs ws/id route selects demo on load')

            controls = page.locator('section.design-viewer .design-controls')
            controls.get_by_role('button', name='Next', exact=True).click()
            expect(page.locator('section.design-viewer h4')).to_contain_text('Screen 2')
            controls.get_by_role('button', name='390px', exact=True).click()
            expect(controls.locator('button[aria-pressed="true"]', has_text='390px')).to_have_count(1)
            with page.expect_response(lambda response: '/api/workspace-designs' in response.url):
                page.get_by_role('button', name='Refresh designs', exact=True).click()
            page.wait_for_timeout(200)
            expect(page.locator('section.design-viewer h4')).to_contain_text('Screen 2')
            expect(page.locator('section.design-viewer .mono')).to_have_text('step 2 of 2')
            expect(controls.locator('button[aria-pressed="true"]', has_text='390px')).to_have_count(1)
            report['scenarios'].append('documents designs: an unchanged Refresh designs keeps the manually chosen step and width')

            page.evaluate("hash => { location.hash = hash; }", '#/designs?' + urlencode({'ws': workspace_id, 'id': 'unknown-design'}))
            page.wait_for_function("() => new URLSearchParams(location.hash.split('?')[1] || '').get('id') === 'unknown-design'")
            page.wait_for_timeout(300)
            expect(page.locator('section.design-viewer h4')).to_contain_text('Design fixture')
            assert page.locator('section.design-viewer h4').count() == 1 and page.locator('button[aria-pressed="true"]', has_text='Design fixture').count() == 1, 'an unknown id selected a different design'
            page.evaluate("hash => { location.hash = hash; }", '#/designs?' + urlencode({'ws': workspace_id, 'id': 'demo'}))
            page.wait_for_function("() => new URLSearchParams(location.hash.split('?')[1] || '').get('id') === 'demo'")
            expect(page.locator('section.design-viewer h4')).to_contain_text('Screen 1')
            expect(page.locator('section.design-viewer .mono')).to_have_text('step 1 of 2')
            report['scenarios'].append('documents designs: same-workspace demo->unknown->demo re-applies the addressed demo and an unknown id never selects a different design')

            page.evaluate("hash => { location.hash = hash; }", '#/designs?' + urlencode({'ws': 'other', 'id': 'demo'}))
            page.wait_for_function("() => !document.querySelector('section.design-viewer')")
            expect(page.locator('section.design-viewer')).to_have_count(0)
            expect(page.locator('button', has_text='Design fixture')).to_have_count(0)
            report['scenarios'].append('documents designs: changing ws clears the old selection before the new listing with no stale demo title')
            page.evaluate("hash => { location.hash = hash; }", '#/designs?' + urlencode({'ws': workspace_id, 'id': 'demo'}))
            expect(page.locator('section.design-viewer h4')).to_contain_text('Design fixture')
            report['scenarios'].append('documents designs: returning to the fixture workspace reselects demo from the new listing and ignores the prior request result')

            check_deadline()
            design_dir = resolve_designs_dir()
            ref_path, digest = verify_reference(design_dir, 'screens/03-epics.html', 'fe1742c3d469dd9efa7b860d2c30828ff68ee1aae7b1302c8536f6bb3f443d28')
            report['references'] = {'designsDir': str(design_dir), 'files': [{'path': str(ref_path), 'sha256': digest}]}
            for width in (1280, 1600):
                check_deadline()
                page.set_viewport_size({'width': width, 'height': 800})
                page.goto(detail_uri(ref_path), wait_until='domcontentloaded')
                reference_pane = page.locator('article.detail-pane')
                expect(reference_pane).to_be_visible()
                capture(reference_pane, f'epics-ref-03-{width}.png')
                page.goto(receipt['url'] + '/#/epics?' + urlencode({'ws': workspace_id, 'id': linked_id}), wait_until='domcontentloaded')
                expect(pane.locator('.object-head h2')).to_have_text('Documents linked epic')
                documents_section = pane.locator('section.epic-documents')
                expect(documents_section).to_be_visible()
                documents_section.scroll_into_view_if_needed()
                capture(pane, f'epics-documents-03-{width}.png')
                assert_no_document_overflow()
                assert pane.locator('.detail-body').evaluate('el => el.scrollWidth <= el.clientWidth'), 'detail region scrolled horizontally'
                assert documents_section.evaluate('el => el.scrollWidth <= el.clientWidth'), 'documents section scrolled horizontally'
                report['scenarios'].append(f'documents capture: reference and production lower regions captured at {width}x800 with no document or detail overflow')
            report['captures'] = {'production': ['epics-documents-03-1280.png', 'epics-documents-03-1600.png'], 'reference': ['epics-ref-03-1280.png', 'epics-ref-03-1600.png']}

        groups = {'list': group_list, 'loading': group_loading, 'cold': group_cold, 'file': group_file, 'a11y': group_a11y}
        handlers = {**groups, 'detail': group_detail, 'observations': group_observations, 'member': group_member, 'documents': group_documents}
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
    report_file = evidence / {'detail': 'epics-detail.json', 'observations': 'epics-observations.json', 'member': 'epics-member.json', 'documents': 'epics-documents.json'}.get(case, 'epics-list.json')
    report['reportPath'] = str(report_file)
    report_file.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
