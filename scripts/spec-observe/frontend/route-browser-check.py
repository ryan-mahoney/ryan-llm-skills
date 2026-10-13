# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused route/reader regressions using real dashboard routes and isolated storage.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script \
  scripts/spec-observe/frontend/route-browser-check.py [--case rail|files|specs|context|catalog|member|search|filters|specs-list|specs-overview|specs-variants|specs-activity|specs-relaunch]
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
args.add_argument('--case', choices=['rail', 'files', 'specs', 'context', 'catalog', 'member', 'search', 'filters', 'specs-list', 'specs-overview', 'specs-variants', 'specs-activity', 'specs-relaunch'])
case = args.parse_args().case
root = Path(__file__).resolve().parent
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-route-evidence'))
evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
report = {'status': 'failed', 'scenarios': [], 'pageErrors': []}
fixture_env = dict(os.environ)
if case == 'context':
    fixture_env['SENTINEL_NONCANONICAL_CONTEXT'] = '1'
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
            # Available. Its Files link must use the reader's canonical relative path.
            table = page.locator('section').filter(has=page.get_by_role('heading', name='Registered context', exact=True))
            expect(table).to_contain_text('Available')
            table.get_by_role('button').click()
            viewer('context/project-context.md', 'Browser context note.')
            assert params()['source'] == ['workspace']
            page.reload()
            viewer('context/project-context.md', 'Browser context note.')
            report['scenarios'].append('Available noncanonical absolute context -> canonical workspace Files route, readable document and reload')

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
            planned_tab = filters.get_by_role('button', name='Planned', exact=True)
            expect(planned_tab).to_have_attribute('aria-pressed', 'true')
            rows = page.locator('.records button.record[data-key]')
            expect(rows).to_have_count(1)
            expect(rows.nth(0).locator('.run-title')).to_have_text('browser')
            caption = page.locator('.list-caption')
            expect(caption).to_contain_text('Planned')
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
            filters.get_by_role('button', name='Planned', exact=True).click()
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('browser')
            expect(caption).to_contain_text('Planned')
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
            expect(page.locator('article.detail h2')).to_have_text('browser')
            expect(page.get_by_role('button', name='Open files', exact=True)).to_be_enabled()
            selected_url = page.url
            assert params()['filter'] == ['planned'], selected_url
            page.screenshot(path=str(evidence / 'sentinel-planned-filter-desktop.png'), full_page=True)
            page.reload()
            expect(filters.get_by_role('button', name='Planned', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('article.detail h2')).to_have_text('browser')
            assert params()['filter'] == ['planned'] and params().get('id'), page.url
            page.get_by_role('button', name='Open files', exact=True).click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params()['source'] == ['package'] and params()['id'] == [package] and params()['ws'] == ['fixture'], page.url
            page.get_by_role('button', name='spec.md', exact=True).click()
            viewer('spec.md', 'Browser specification')
            page.go_back()
            expect(page.locator('.file-viewer')).to_have_count(0)
            page.go_back()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(filters.get_by_role('button', name='Planned', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert params()['filter'] == ['planned'] and params().get('id'), page.url
            report['scenarios'].append('Planned row deep link hands off to the real package Files destination; Back restores the selected Planned tab')

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
            assert params()['filter'] == ['planned'], page.url
            expect(filters.get_by_role('button', name='Planned', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(rows).to_have_count(1)
            expect(rows.first).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('article.detail h2')).to_have_text('browser')
            report['scenarios'].append('Epic member navigation selects Planned inventory over an inactive historical run')

            open_route('specs', ws='fixture', filter='planned')
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('browser')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.screenshot(path=str(evidence / 'sentinel-planned-filter-mobile.png'), full_page=True)
            expect(filters.get_by_role('button', name='Planned', exact=True)).to_have_attribute('aria-pressed', 'true')

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
                       'spec_progress': {'total_steps': 5}, 'epic': {'epic': 'variants-roadmap', 'workspace': 'fixture'},
                       'targets': [{'id': 'main', 'primary': receipt['checkout']}]}
            state['value'] = variant_envelope(planned=[planned], epics=[epic])
            open_route('specs', ws='fixture', filter='planned', id=planned_key)
            expect(page.locator('.object-head h2')).to_have_text('browser')
            expect(page.locator('.progress-head strong')).to_have_text('5 prepared steps')
            expect(page.locator('.progress-head .muted')).to_have_text('No run recorded')
            expect(page.locator('.progress-track .progress-value')).to_have_count(0)
            expect(page.locator('.detail-body .facts')).to_have_count(0)
            expect(page.locator('.detail-body')).not_to_contain_text('Elapsed')
            expect(page.locator('.detail-body')).not_to_contain_text('Time since spec start')
            expect(page.locator('.detail-body')).not_to_contain_text('Needs attention')
            expect(page.locator('.obligation')).to_contain_text('Prepare the specs variants overview')
            expect(page.locator('.detail-body .table-wrap')).to_contain_text('Variants roadmap')
            expect(page.locator('.detail-body .table-wrap')).to_contain_text('0 of 1 landed')
            expect(page.locator('#planned-assignment')).to_be_visible()
            expect(page.locator('#planned-assignment-preview')).to_be_visible()
            open_files = page.locator('.detail-actions').get_by_role('button', name='Open files', exact=True)
            expect(open_files).to_be_enabled()
            assert 'ds-btn--primary' not in (open_files.get_attribute('class') or ''), open_files.get_attribute('class')
            report['scenarios'].append('Planned Overview shows the prepared total without a progress fill, No run recorded, the related epic row and the retained launch form with files as a secondary action')
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
            filters.get_by_role('button', name='Planned', exact=True).click()
            expect(rows.first.locator('.run-title')).to_have_text('planned-d')
            expect(page.locator('.list-caption')).to_have_text('Planned · 1 observed specs')

            for key, label, slug in [('attention', 'Blocked', 'blocked-z'), ('completed', 'Done', 'done-c'), ('planned', 'Planned', 'planned-d')]:
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
    filename = 'carried-loadcatalog-browser.json' if case == 'catalog' else 'step-003-fix-browser.json' if case == 'context' else 'final-review-member-browser.json' if case == 'member' else 'final-review-search-browser.json' if case == 'search' else 'sentinel-planned-filter-browser.json' if case == 'filters' else 'specs-list.json' if case == 'specs-list' else 'specs-variants.json' if case == 'specs-variants' else 'specs-overview.json' if case == 'specs-overview' else 'specs-activity.json' if case == 'specs-activity' else 'specs-relaunch.json' if case == 'specs-relaunch' else 'step-002-fix-browser.json'
    target = evidence / filename
    temporary = target.with_name(target.name + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    os.replace(temporary, target)
    print(json.dumps(report, indent=2))
