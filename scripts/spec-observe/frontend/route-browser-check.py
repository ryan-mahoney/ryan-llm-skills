# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused route/reader regressions using real dashboard routes and isolated storage.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script \
  scripts/spec-observe/frontend/route-browser-check.py [--case rail|files|specs|context|catalog|member|search|filters|specs-list]
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
args.add_argument('--case', choices=['rail', 'files', 'specs', 'context', 'catalog', 'member', 'search', 'filters', 'specs-list'])
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

        if case == 'member':
            # A searched epic's member must open a fresh Specs route that selects
            # the current record and leaves no epic q/filter/tab behind.
            open_route('epics', ws='fixture', q='Demo epic')
            expect(page.locator('#find-record')).to_have_value('Demo epic')
            expect(page.locator('article.detail h2')).to_have_text('Demo epic')
            page.get_by_role('button', name='browser', exact=True).click()
            expect(page.locator('h1')).to_have_text('Specs')
            assert params()['ws'] == ['fixture'], page.url
            assert params().get('id'), page.url
            assert not {'q', 'filter', 'tab', 'path', 'source'} & params().keys(), page.url
            assert 'recent-completion' not in params()['id'][0], 'epic member navigation selected completion history'
            expect(page.locator('#find-record')).to_have_value('')
            expect(page.locator('article.detail h2')).to_have_text('browser')
            page.go_back()
            expect(page.locator('h1')).to_have_text('Epics')
            expect(page.locator('#find-record')).to_have_value('Demo epic')
            expect(page.locator('article.detail h2')).to_have_text('Demo epic')
            assert params()['q'] == ['Demo epic'], page.url
            page.go_forward()
            expect(page.locator('h1')).to_have_text('Specs')
            expect(page.locator('article.detail h2')).to_have_text('browser')
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
            expect(page.locator('article.detail h2')).to_have_text('browser')
            expect(page.locator('article.detail')).to_contain_text('Building the dashboard')
            page.evaluate("location.hash = location.hash + '&unknown=ignored'")
            page.wait_for_function("() => !location.hash.includes('unknown')")
            assert 'unknown' not in params(), page.url
            assert params().get('id') == selected_id, page.url
            expect(row).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('article.detail h2')).to_have_text('browser')
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
            page.get_by_role('button', name='spec.md', exact=True).click()
            viewer('spec.md', 'Browser specification')
            assert params()['source'] == ['package'] and params()['id'] == [package], page.url
            report['scenarios'].append('Planned row retains its deep link and opens the real fixture package file reader')

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
            expect(page.locator('article.detail h2')).to_have_text('blocked-z')
            capture_both('list')
            report['scenarios'].append('Active rows, caption and App selection fallback share the attention-first order')

            page.locator('#find-record').fill('healthy')
            expect(rows).to_have_count(1)
            expect(rows.first.locator('.run-title')).to_have_text('healthy-a')
            expect(page.locator('.list-caption')).to_have_text('Active · 1 observed specs')
            expect(page.locator('article.detail h2')).to_have_text('healthy-a')
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

            state['value'] = fixture_snapshot([record('fixture', 'offline-f', observed_at='2026-10-12T11:58:00.000Z')])
            page.reload()
            expect(rows).to_have_count(1)
            state['fail'] = True
            page.locator('button:has-text("Refresh state")').first.click()
            expect(page.locator('.records .ds-callout').filter(has_text='Connection lost')).to_be_visible()
            expect(rows).to_have_count(1)
            expect(page.locator('.completion-control').get_by_role('button', name='Mark complete', exact=True)).to_be_disabled()
            offline_age = rows.first.locator('small').inner_text()
            assert '2m 0s before observation' in offline_age, offline_age
            page.wait_for_timeout(1500)
            assert rows.first.locator('small').inner_text() == offline_age, 'offline age advanced'
            capture_both('offline')
            state['fail'] = False
            page.get_by_role('button', name='Retry connection', exact=True).click()
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
            expect(page.locator('.completion-control').get_by_role('button', name='Mark complete', exact=True)).to_be_disabled()
            capture_both('imported')
            report['scenarios'].append('Imported rows render fixed before-observation ages and keep mutation controls unavailable')

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
    filename = 'carried-loadcatalog-browser.json' if case == 'catalog' else 'step-003-fix-browser.json' if case == 'context' else 'final-review-member-browser.json' if case == 'member' else 'final-review-search-browser.json' if case == 'search' else 'sentinel-planned-filter-browser.json' if case == 'filters' else 'specs-list.json' if case == 'specs-list' else 'step-002-fix-browser.json'
    (evidence / filename).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
