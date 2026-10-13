# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused Agents selection/retention regressions against the real dashboard.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/agents-browser-check.py --case selection

Only the final /api/state observer response is replaced. The built dashboard,
catalog, route, normalizeEnvelope, scope and Agents adapter stay real.
browser-fixture.mjs supplies the disposable loopback catalog/dashboard and is
owned and removed by this command. No POST creation is issued.
"""
import argparse
import json
import os
import select
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['selection', 'list'], required=True)
case = parser.parse_args().case

if case == 'list':
    root = Path(__file__).resolve().parent
    evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-agents-evidence'))
    evidence.mkdir(parents=True, exist_ok=True)
    shots = evidence / 'agents' / 'list'
    shots.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = {'status': 'failed', 'case': case, 'scenarios': [], 'pageErrors': [], 'urls': {}, 'snapshots': [], 'requests': {}}
    fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        if not select.select([fixture.stdout], [], [], 10)[0]:
            raise RuntimeError('Fixture readiness exceeded 10 seconds')
        receipt = json.loads(fixture.stdout.readline())
        report['fixture'] = receipt
        report['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
        report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip())

        generated_at = '2026-10-12T12:00:00.000Z'
        old_at = '2026-10-12T11:00:00.000Z'

        def record_key(assignment_id, workspace='fixture'):
            return json.dumps([workspace, assignment_id], separators=(',', ':'))

        def assignment(assignment_id, display='live', workspace_id='fixture', **extra):
            value = {
                'assignment_id': assignment_id,
                'workspace_id': workspace_id,
                'spec_package': 'fixture/' + assignment_id,
                'workflow_id': 'workflow-1',
                'display': display,
                'state': display,
                'execution': 'running' if display == 'live' else 'completed',
                'task_activity': {'state': 'idle', 'reason': 'Fixture assignment is waiting for input.'},
                'nextAction': 'Attach to ' + assignment_id,
                'coverage': {'state': 'complete', 'reasons': []},
                'executionDir': '/fixture/checkout',
            }
            value.update(extra)
            return value

        def observer(assignments, coverage='complete', observed_at=generated_at, workspace='fixture', observer_id='fixture', published_at=generated_at):
            return {
                'observer_id': observer_id,
                'state': 'observing',
                'published_at': published_at,
                'snapshot': {
                    'workspace': workspace,
                    'coverage': {'state': 'complete', 'observed_at': observed_at, 'reasons': []},
                    'runs': [],
                    'recently_completed': [],
                    'planned_packages': [],
                    'epics': [],
                    'assignments': assignments,
                    'assignment_coverage': {
                        'state': coverage,
                        'observed_at': observed_at,
                        'reasons': [] if coverage == 'complete' else ['assignment-read-' + coverage],
                    },
                },
            }

        def envelope(observers, generated=generated_at):
            return {'schema_version': 1, 'generated_at': generated, 'observers': observers}

        def healthy():
            return envelope([observer([
                assignment('active-one', nextAction='Attach to active-one'),
                assignment('active-two', nextAction='Attach to active-two'),
                assignment('ended-one', display='ended', nextAction='History'),
            ])])

        key_a = record_key('active-one')
        key_e = record_key('ended-one')
        key_b = record_key('b-row')

        request_log = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
            for width in (1280, 1600):
                context = browser.new_context(viewport={'width': width, 'height': 860})
                scenario_name = {'value': ''}

                def note(name, value, width=width):
                    report['snapshots'].append({
                        'name': f'{name}@{width}',
                        'assignment_coverage': [o['snapshot']['assignment_coverage']['state'] for o in value['observers']] if isinstance(value, dict) else ['request-failed'],
                        'assignment_ids': [row['assignment_id'] for o in value['observers'] for row in o['snapshot']['assignments']] if isinstance(value, dict) else [],
                        'observers': [o['snapshot']['workspace'] for o in value['observers']] if isinstance(value, dict) else [],
                    })

                def serve(route, state):
                    if state['fail']:
                        route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'fixture-state-failure'}))
                        return
                    if state.get('hold'):
                        state['pending'] = route
                        return
                    route.fulfill(json=state['value'])

                def open_page(state):
                    page = context.new_page()
                    page.set_default_timeout(10000)
                    page.set_default_navigation_timeout(10000)
                    page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
                    page.on('request', lambda request: request_log.append({'method': request.method, 'url': request.url, 'scenario': scenario_name['value']}))
                    page.route('**/api/state**', lambda route, _request=None, _state=state: serve(route, _state))
                    return page

                def open_list(page, state, **route_params):
                    page.goto(receipt['url'] + '/#/agents?' + urlencode({'ws': 'fixture', **route_params}), wait_until='domcontentloaded')
                    expect(page.locator('h1')).to_have_text('Agents')

                def params(page):
                    return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

                def row(page, key_value):
                    return page.locator("[data-assignment-key='" + key_value + "']")

                def capture(page, state_name, width=width):
                    page.screenshot(path=str(shots / f'{state_name}@{width}.png'))
                    report['urls'][f'{state_name}@{width}'] = urlsplit(page.url).fragment

                # ideal: Active/Ended tabs write the explicit filter and keep q/ws.
                live_state = {'value': healthy(), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'ideal'
                note('ideal', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state)
                expect(row(page, key_a)).to_have_count(1)
                expect(row(page, key_e)).to_have_count(0)
                expect(page.locator('.list-caption')).to_contain_text('Active · 2 observed agents')
                capture(page, 'ideal')
                page.locator('#find-record').fill('one')
                expect(row(page, key_a)).to_have_count(1)
                page.get_by_role('button', name='Ended', exact=True).click()
                expect(row(page, key_e)).to_have_count(1)
                expect(row(page, key_a)).to_have_count(0)
                assert params(page)['q'] == ['one'] and params(page)['filter'] == ['ended'] and params(page)['ws'] == ['fixture'], page.url
                page.get_by_role('button', name='Active', exact=True).click()
                expect(row(page, key_a)).to_have_count(1)
                assert params(page)['q'] == ['one'] and params(page)['ws'] == ['fixture'], page.url
                report['scenarios'].append(f'ideal@{width}: Active/Ended tabs write the explicit filter while q and ws survive; rows follow the tab')
                page.close()

                # empty: a complete zero-total read owns the only empty copy.
                live_state = {'value': envelope([observer([])]), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'empty'
                note('empty', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state)
                expect(page.get_by_role('heading', name='No agents observed', exact=True)).to_be_visible()
                expect(page.locator('.list-pane').get_by_role('button', name='Refresh state', exact=True)).to_be_visible()
                expect(page.locator('[data-assignment-key]')).to_have_count(0)
                capture(page, 'empty')
                report['scenarios'].append(f'empty@{width}: a complete empty read shows No agents observed with one Refresh state action')
                page.close()

                # no-matches: Clear filters removes q, restores rows and keeps ws.
                live_state = {'value': healthy(), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'no-matches'
                note('no-matches', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state, q='zzz-no-match')
                expect(page.get_by_role('heading', name='No matching agents', exact=True)).to_be_visible()
                expect(page.locator('[data-assignment-key]')).to_have_count(0)
                capture(page, 'no-matches')
                page.get_by_role('button', name='Clear filters', exact=True).click()
                expect(row(page, key_a)).to_have_count(1)
                expect(page.get_by_role('heading', name='No matching agents', exact=True)).to_have_count(0)
                assert 'q' not in params(page) and params(page)['ws'] == ['fixture'], page.url
                report['scenarios'].append(f'no-matches@{width}: Clear filters removes q, keeps ws and restores available rows')
                page.close()

                # loading: skeleton only after the 300ms delay; refresh keeps content+query.
                # The first /api/state response is held (never blocking the loop)
                # so the delayed skeleton is observable, then released in-flow.
                live_state = {'value': healthy(), 'fail': False, 'hold': True}
                scenario_name['value'] = 'loading'
                note('loading', live_state['value'])
                page = open_page(live_state)
                began = time.monotonic()
                open_list(page, live_state)
                expect(page.locator('.records .skeleton')).to_have_count(0)
                expect(page.locator('.detail-pane .skeleton')).to_have_count(0)
                page.wait_for_selector('.records .skeleton', state='visible', timeout=5000)
                page.wait_for_selector('.detail-pane .skeleton', state='visible', timeout=5000)
                elapsed = time.monotonic() - began
                assert elapsed >= 0.25, elapsed
                capture(page, 'loading')
                live_state['pending'].fulfill(json=live_state['value'])
                live_state['pending'] = None
                expect(row(page, key_a)).to_have_count(1)
                page.locator('#find-record').fill('one')
                page.locator('#refresh-button').click()
                expect(row(page, key_a)).to_have_count(1)
                expect(page.locator('#find-record')).to_have_value('one')
                assert params(page)['q'] == ['one'] and params(page)['ws'] == ['fixture'], page.url
                page.wait_for_timeout(1800)
                expect(row(page, key_a)).to_have_count(1)
                expect(page.locator('#find-record')).to_have_value('one')
                if live_state.get('pending'):
                    live_state['pending'].fulfill(json=live_state['value'])
                    live_state['pending'] = None
                report['scenarios'].append(f'loading@{width}: skeleton appears only after the 300ms delay; an ordinary refresh keeps content and query')
                page.close()

                # error: one retry primary and no empty copy before recovery.
                live_state = {'value': healthy(), 'fail': True, 'delay': 0.0}
                scenario_name['value'] = 'error'
                note('error', 'fail')
                page = open_page(live_state)
                open_list(page, live_state)
                expect(page.locator('.records .ds-callout')).to_contain_text('Agents could not be read')
                expect(page.locator('.workspace .ds-btn--primary')).to_have_count(1)
                expect(page.locator('.detail-pane .ds-btn--primary')).to_have_count(0)
                expect(page.locator('.list-caption')).not_to_contain_text('0 observed')
                expect(page.locator('main')).not_to_contain_text('No agents observed')
                expect(page.locator('[data-assignment-key]')).to_have_count(0)
                capture(page, 'error')
                live_state['fail'] = False
                page.locator('.records .ds-callout .ds-btn--primary').click()
                expect(row(page, key_a)).to_have_count(1)
                report['scenarios'].append(f'error@{width}: an initial failed read shows one Retry state action and no empty copy; retry resolves the rows')
                page.close()

                # partial: rows stay and the observer coverage reason is readable.
                live_state = {'value': envelope([observer([assignment('active-one'), assignment('ended-one', display='ended')], coverage='partial')]), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'partial'
                note('partial', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state)
                expect(row(page, key_a)).to_have_count(1)
                expect(page.locator('.records .ds-callout')).to_contain_text('Assignment coverage incomplete')
                expect(page.locator('.records .ds-callout')).to_contain_text('assignment-read-partial')
                expect(page.locator('.list-caption')).to_contain_text('(partial)')
                capture(page, 'partial')
                report['scenarios'].append(f'partial@{width}: rows stay and the observer assignment-coverage reason is readable')
                page.close()

                # offline: a failed refresh keeps the known rows and qualifies the time.
                live_state = {'value': healthy(), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'offline'
                note('offline', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state)
                expect(row(page, key_a)).to_have_count(1)
                live_state['fail'] = True
                page.locator('#refresh-button').click()
                expect(page.locator('.records .ds-callout')).to_contain_text('Connection unavailable')
                expect(row(page, key_a)).to_have_count(1)
                expect(page.locator('.list-caption')).to_contain_text('(last-known)')
                expect(page.locator('main')).not_to_contain_text('No agents observed')
                capture(page, 'offline')
                report['scenarios'].append(f'offline@{width}: a failed refresh keeps the known rows and qualifies the last received time')
                page.close()

                # stale: a connected old observation keeps rows and qualifies the time.
                live_state = {'value': envelope([observer([assignment('active-one')], observed_at=old_at, published_at=old_at)]), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'stale'
                note('stale', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state)
                stale_callout = page.locator('.records .ds-callout')
                expect(stale_callout).to_contain_text('Last checked at')
                expect(stale_callout).to_contain_text(page.evaluate('new Date(' + json.dumps(old_at) + ').toLocaleString()'))
                expect(row(page, key_a)).to_have_count(1)
                expect(page.locator('.list-caption')).to_contain_text('(last-known)')
                capture(page, 'stale')
                report['scenarios'].append(f'stale@{width}: a connected old observation keeps rows and shows the qualified time')
                page.close()

                # partial-stale: an old partial snapshot keeps both the freshness warning and the coverage reasons.
                live_state = {'value': envelope([observer([assignment('active-one')], coverage='partial', observed_at=old_at, published_at=old_at)]), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'partial-stale'
                note('partial-stale', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state)
                stale_partial_callout = page.locator('.records .ds-callout')
                expect(stale_partial_callout).to_contain_text('Last checked at')
                expect(stale_partial_callout).to_contain_text('assignment-read-partial')
                expect(page.locator('.list-caption')).to_contain_text('(partial, last-known)')
                expect(row(page, key_a)).to_have_count(1)
                capture(page, 'partial-stale')
                report['scenarios'].append(f'partial-stale@{width}: an old partial snapshot keeps the freshness warning with readable coverage reasons')
                page.close()

                # unavailable: retained rows and selected identity survive with no empty copy or zero counts.
                live_state = {'value': healthy(), 'fail': False, 'delay': 0.0}
                scenario_name['value'] = 'unavailable'
                note('unavailable-live', live_state['value'])
                page = open_page(live_state)
                open_list(page, live_state, id=key_a)
                expect(page.locator('article.detail .detail-title h2')).to_have_text('active-one')
                retained_label = page.evaluate('new Date(' + json.dumps(generated_at) + ').toLocaleString()')
                omitted_label = page.evaluate('new Date(' + json.dumps(old_at) + ').toLocaleString()')
                assert retained_label != omitted_label
                unavailable = envelope([observer([assignment('b-row', nextAction='Attach to b-row unavailable-read')], coverage='unavailable', observed_at=old_at, published_at=old_at)])
                live_state['value'] = unavailable
                note('unavailable', unavailable)
                page.locator('#refresh-button').click()
                expect(page.locator('.records .ds-callout')).to_contain_text('Source unavailable')
                expect(page.locator('.list-caption')).not_to_contain_text('0 observed')
                expect(page.locator('main')).not_to_contain_text('No agents observed')
                expect(row(page, key_b)).to_contain_text('unavailable-read')
                expect(page.locator('article.detail .detail-title h2')).to_have_text('active-one')
                expect(page.locator('article.detail .footer')).to_contain_text(retained_label)
                expect(page.locator('article.detail .footer')).not_to_contain_text(omitted_label)
                assert params(page)['id'] == [key_a], page.url
                capture(page, 'unavailable')
                report['scenarios'].append(f'unavailable@{width}: retained rows and selected identity survive, with no empty copy or zero counts')
                page.close()
                context.close()
            browser.close()

        assert not report['pageErrors'], report['pageErrors']
        posts = [entry for entry in request_log if entry['method'] == 'POST']
        assert not posts, posts
        report['requests'] = {
            'total': len(request_log),
            'stateGets': sum(1 for entry in request_log if '/api/state' in entry['url']),
            'posts': posts,
            'byScenario': {name: sum(1 for entry in request_log if entry['scenario'] == name) for name in sorted({entry['scenario'] for entry in request_log})},
        }
        report['scenarios'].append('Viewing, refresh, search and filter interactions issued no POST and no page error')
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
        (evidence / 'agents-list.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    raise SystemExit(0)

root = Path(__file__).resolve().parent
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-agents-evidence'))
evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
report = {'status': 'failed', 'case': case, 'scenarios': [], 'pageErrors': [], 'urls': {}, 'snapshots': []}
fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
temp_paths = []
try:
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture readiness exceeded 10 seconds')
    receipt = json.loads(fixture.stdout.readline())
    report['fixture'] = receipt
    report['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip())

    generated_at = '2026-10-12T12:00:00.000Z'
    fresh_at = generated_at
    old_at = '2026-10-12T11:00:00.000Z'

    def record_key(assignment_id, workspace='fixture'):
        return json.dumps([workspace, assignment_id], separators=(',', ':'))

    def assignment(assignment_id, display='live', workspace_id='fixture', **extra):
        value = {
            'assignment_id': assignment_id,
            'workspace_id': workspace_id,
            'spec_package': 'fixture/' + assignment_id,
            'workflow_id': 'workflow-1',
            'display': display,
            'state': display,
            'execution': 'running' if display == 'live' else 'completed',
            'task_activity': {'state': 'idle', 'reason': 'Fixture assignment is waiting for input.'},
            'nextAction': 'Attach to ' + assignment_id,
            'coverage': {'state': 'complete', 'reasons': []},
            'executionDir': '/fixture/checkout',
        }
        value.update(extra)
        return value

    def observer(assignments, coverage='complete', observed_at=fresh_at, workspace='fixture', observer_id='fixture', published_at=fresh_at):
        return {
            'observer_id': observer_id,
            'state': 'observing',
            'published_at': published_at,
            'snapshot': {
                'workspace': workspace,
                'coverage': {'state': 'complete', 'observed_at': observed_at, 'reasons': []},
                'runs': [],
                'recently_completed': [],
                'planned_packages': [],
                'epics': [],
                'assignments': assignments,
                'assignment_coverage': {
                    'state': coverage,
                    'observed_at': observed_at,
                    'reasons': [] if coverage == 'complete' else ['assignment-read-' + coverage],
                },
            },
        }

    def envelope(observers, generated=fresh_at):
        return {'schema_version': 1, 'generated_at': generated, 'observers': observers}

    key_a = record_key('selected-a')
    key_b = record_key('b-row')
    key_e = record_key('shared-ended')
    key_l = record_key('shared-live')

    live_observers = [observer([
        assignment('shared-live'),
        assignment('shared-ended', display='ended'),
        assignment('selected-a'),
        assignment('b-row'),
        assignment('cross-ws', workspace_id='other'),
    ])]

    state = {'value': 'fail'}

    def note_state(name, value):
        if value == 'fail':
            report['snapshots'].append({'name': name, 'assignment_coverage': ['request-failed'], 'assignment_ids': [], 'observers': []})
            return
        report['snapshots'].append({
            'name': name,
            'assignment_coverage': [o['snapshot']['assignment_coverage']['state'] for o in value['observers']],
            'assignment_ids': [row['assignment_id'] for o in value['observers'] for row in o['snapshot']['assignments']],
            'observers': [o['snapshot']['workspace'] for o in value['observers']],
        })

    request_log = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1280, 'height': 860})
        page = context.new_page()
        page.set_default_timeout(10000)
        page.set_default_navigation_timeout(10000)
        expect.set_options(timeout=10000)
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
        page.on('request', lambda request: request_log.append({'method': request.method, 'url': request.url}))

        def serve_state(route):
            if state['value'] == 'fail':
                route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'fixture-state-failure'}))
            else:
                route.fulfill(json=state['value'])

        page.route('**/api/state**', serve_state)

        def params():
            return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

        def open_route(dest, **values):
            page.goto(receipt['url'] + '/#/' + dest + '?' + urlencode(values), wait_until='domcontentloaded')
            expect(page.locator('h1')).to_have_text(dest.capitalize())

        def native_hash(fragment):
            page.evaluate('location.hash = ' + json.dumps(fragment))

        def row(key_value):
            return page.locator("[data-assignment-key='" + key_value + "']")

        def locale_label(moment):
            return page.evaluate('new Date(' + json.dumps(moment) + ').toLocaleString()')

        # 1. Initial no-payload failure keeps the requested identity; retry
        #    recovers the exact row without selecting a sibling.
        note_state('initial-failure', 'fail')
        open_route('agents', ws='fixture', id=key_a)
        expect(page.locator('#notice')).to_contain_text('Could not refresh workspace state')
        assert params()['id'] == [key_a], page.url
        assert params()['ws'] == ['fixture'], page.url
        expect(row(key_b)).to_have_count(0)
        report['urls']['initial-failure'] = urlsplit(page.url).fragment
        note_state('retry-healthy', envelope(live_observers))
        state['value'] = envelope(live_observers)
        page.locator('#refresh-button').click()
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        assert params()['id'] == [key_a] and params()['ws'] == ['fixture'], page.url
        report['scenarios'].append('HTTP 503 initial state keeps the requested id/ws and retry resolves the same row, never B')

        # 2. Ended-key deep link under inferred Ended, then reload and native
        #    hash/Back/Forward preserve id/ws/filter.
        open_route('agents', ws='fixture', id=key_e)
        expect(row(key_e)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        expect(row(key_l)).to_have_count(0)
        expect(page.get_by_text('Recently ended', exact=True)).to_be_visible()
        assert params()['id'] == [key_e] and params()['ws'] == ['fixture'], page.url
        report['urls']['ended-deep-link'] = urlsplit(page.url).fragment
        page.reload(wait_until='domcontentloaded')
        expect(row(key_e)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        assert params()['id'] == [key_e] and params()['ws'] == ['fixture'], page.url
        native_hash('#/agents?' + urlencode({'ws': 'fixture', 'id': key_e, 'filter': 'ended'}))
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        assert params()['filter'] == ['ended'], page.url
        page.go_back()
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        assert params()['id'] == [key_e] and 'filter' not in params(), page.url
        page.go_forward()
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        assert params()['filter'] == ['ended'], page.url
        report['scenarios'].append('Ended deep link selects its exact ended row under inferred Ended; reload and native hash/Back/Forward preserve id/ws/filter')

        # 3. Ended-only query infers Ended; explicit Active wins over the same
        #    query; clearing the query preserves ws.
        open_route('agents', ws='fixture', q='shared')
        expect(row(key_l)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-live')
        expect(row(key_e)).to_have_count(0)
        assert params()['ws'] == ['fixture'], page.url
        open_route('agents', ws='fixture', q='shared-ended')
        expect(row(key_e)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        expect(row(key_l)).to_have_count(0)
        assert params()['ws'] == ['fixture'], page.url
        report['urls']['ended-only-query'] = urlsplit(page.url).fragment
        page.locator('#find-record').fill('')
        assert params()['ws'] == ['fixture'], page.url
        assert 'q' not in params(), page.url
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        expect(row(key_e)).to_have_attribute('aria-pressed', 'true')
        open_route('agents', ws='fixture', filter='active', q='shared-ended')
        assert params()['filter'] == ['active'] and params()['ws'] == ['fixture'], page.url
        expect(row(key_e)).to_have_count(0)
        expect(page.locator('[data-assignment-key]')).to_have_count(0)
        report['scenarios'].append('Ended-only query infers Ended; deliberate Active keeps Active and the ended row hidden; clearing the query preserves ws')

        # 3b. Typing an ended-only query from a selected active row reselects
        #     in one transaction instead of hiding every row behind the stale id.
        open_route('agents', ws='fixture', id=key_a)
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        page.locator('#find-record').fill('shared-ended')
        expect(row(key_e)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        expect(row(key_a)).to_have_count(0)
        expect(page.get_by_text('No matching agents', exact=True)).to_have_count(0)
        assert params()['q'] == ['shared-ended'] and params()['ws'] == ['fixture'], page.url
        assert params()['id'] == [key_e], page.url
        report['urls']['typed-ended-query'] = urlsplit(page.url).fragment
        report['scenarios'].append('Typing an ended-only query from selected active A reselects the ended row in one transaction')

        # 3c. The transitional list renders the shared settled rows: an
        #     execution_dir-only match stays visible and uncertain rows sort
        #     first, exactly as the shared owner orders them.
        key_plain = record_key('f3-plain')
        key_dir = record_key('f3-dir')
        key_uncertain = record_key('f3-uncertain')
        shared_owner_state = envelope([observer([
            assignment('f3-plain', execution_dir='/other/dir'),
            assignment('f3-dir', execution_dir='/repo/worktrees/Alpha'),
            assignment('f3-uncertain', 'unknown', execution_dir='/other/dir'),
        ])])
        note_state('shared-owner', shared_owner_state)
        state['value'] = shared_owner_state
        open_route('agents', ws='fixture')
        page.locator('#refresh-button').click()
        expect(row(key_uncertain)).to_have_count(1)
        order = page.evaluate("Array.from(document.querySelectorAll('[data-assignment-key]')).map(el => el.getAttribute('data-assignment-key'))")
        assert order == [key_uncertain, key_dir, key_plain], order
        open_route('agents', ws='fixture', q='worktrees/alpha')
        page.locator('#refresh-button').click()
        expect(row(key_dir)).to_have_count(1)
        expect(row(key_plain)).to_have_count(0)
        expect(row(key_uncertain)).to_have_count(0)
        expect(page.get_by_text('No matching agents', exact=True)).to_have_count(0)
        expect(row(key_dir)).to_have_attribute('aria-pressed', 'true')
        report['urls']['shared-owner'] = urlsplit(page.url).fragment
        report['scenarios'].append('Execution_dir-only matches stay visible and uncertain rows sort first under the shared visible-list owner')
        note_state('retry-healthy', envelope(live_observers))
        state['value'] = envelope(live_observers)

        # 4. Unavailable/partial omission retains the exact id and its
        #    qualified source timestamp; complete absence withholds facts and
        #    never falls through to B.
        open_route('agents', ws='fixture', id=key_a)
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        retained_label = locale_label(fresh_at)
        omitted_label = locale_label(old_at)
        assert retained_label != omitted_label
        expect(page.locator('article.detail .footer')).to_contain_text(retained_label)

        omitted_unavailable = envelope([observer(
            [assignment('b-row', nextAction='Attach to b-row unavailable-read')],
            coverage='unavailable', observed_at=old_at, published_at=old_at,
        )])
        note_state('omitted-unavailable', omitted_unavailable)
        state['value'] = omitted_unavailable
        page.locator('#refresh-button').click()
        expect(row(key_b)).to_contain_text('unavailable-read')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        assert params()['id'] == [key_a], page.url
        expect(page.locator('article.detail .footer')).to_contain_text(retained_label)
        expect(page.locator('article.detail .footer')).not_to_contain_text(omitted_label)
        expect(row(key_b)).to_have_attribute('aria-pressed', 'false')

        omitted_partial = envelope([observer(
            [assignment('b-row', nextAction='Attach to b-row partial-read')],
            coverage='partial', observed_at=old_at, published_at=old_at,
        )])
        note_state('omitted-partial', omitted_partial)
        state['value'] = omitted_partial
        page.locator('#refresh-button').click()
        expect(row(key_b)).to_contain_text('partial-read')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        assert params()['id'] == [key_a], page.url
        expect(page.locator('article.detail .footer')).to_contain_text(retained_label)

        complete_absence = envelope([observer(
            [assignment('b-row', nextAction='Attach to b-row complete-read')],
            observed_at=old_at, published_at=old_at,
        )])
        note_state('complete-absence', complete_absence)
        state['value'] = complete_absence
        page.locator('#refresh-button').click()
        expect(row(key_b)).to_contain_text('complete-read')
        expect(page.get_by_role('heading', name='Select an observed agent', exact=True)).to_be_visible()
        expect(page.locator('article.detail')).to_have_count(0)
        assert params()['id'] == [key_a], page.url
        expect(row(key_b)).to_have_attribute('aria-pressed', 'false')
        expect(page.locator('main')).not_to_contain_text('selected-a')
        report['scenarios'].append('HTTP 200 unavailable/partial omission retains A with its qualified timestamp; complete absence withholds facts, keeps the URL id and never picks B')

        # 4b. Complete absence invalidates the pin: a later partial read
        #     omitting A must not resurrect its facts.
        partial_after_complete = envelope([observer(
            [assignment('b-row', nextAction='Attach to b-row partial-after-complete')],
            coverage='partial', observed_at=old_at, published_at=old_at,
        )])
        note_state('partial-after-complete', partial_after_complete)
        state['value'] = partial_after_complete
        page.locator('#refresh-button').click()
        expect(row(key_b)).to_contain_text('partial-after-complete')
        expect(page.get_by_role('heading', name='Select an observed agent', exact=True)).to_be_visible()
        expect(page.locator('article.detail')).to_have_count(0)
        assert params()['id'] == [key_a], page.url
        expect(page.locator('main')).not_to_contain_text('selected-a')

        # 4c. Moving to an absent id drops the old pin; returning to A under
        #     the same partial read cannot revive it.
        absent_c = record_key('absent-c')
        open_route('agents', ws='fixture', id=absent_c)
        expect(page.get_by_role('heading', name='Select an observed agent', exact=True)).to_be_visible()
        expect(page.locator('main')).not_to_contain_text('selected-a')
        native_hash('#/agents?' + urlencode({'ws': 'fixture', 'id': key_a}))
        expect(page.get_by_role('heading', name='Select an observed agent', exact=True)).to_be_visible()
        expect(page.locator('main')).not_to_contain_text('selected-a')
        assert params()['id'] == [key_a], page.url
        report['scenarios'].append('Complete absence invalidates the retained pin and id changes drop it; later partial reads never resurrect A')

        # 5. Selected stale A is never qualified by fresh healthy B; another
        #    scope cannot show A, and returning re-resolves it.
        stale_alpha = observer([assignment('selected-a')], observed_at=old_at, published_at=old_at)
        fresh_beta = observer([assignment('b-row')], observed_at=fresh_at, published_at=fresh_at, workspace='beta', observer_id='beta')
        noted = envelope([stale_alpha, fresh_beta], generated=fresh_at)
        note_state('stale-a-fresh-b', noted)
        state['value'] = noted
        open_route('agents', ws='fixture', id=key_a)
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        stale_label = locale_label(old_at)
        fresh_label = locale_label(fresh_at)
        expect(page.locator('article.detail .footer')).to_contain_text(stale_label)
        expect(page.locator('article.detail .footer')).not_to_contain_text(fresh_label)
        expect(page.locator('#connection-status')).to_contain_text('Monitor connected')
        report['urls']['stale-a'] = urlsplit(page.url).fragment
        native_hash('#/agents?' + urlencode({'ws': 'other', 'id': key_a}))
        expect(page.get_by_role('heading', name='Select an observed agent', exact=True)).to_be_visible()
        expect(page.locator('main')).not_to_contain_text('selected-a')
        assert params()['ws'] == ['other'], page.url
        native_hash('#/agents?' + urlencode({'ws': 'fixture', 'id': key_a}))
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        report['scenarios'].append('Stale A keeps its own old source despite fresh B; another scope shows no A; returning re-resolves A from the current source')

        # 6. An imported unavailable snapshot cannot inherit the retained live
        #    row for the same explicit id.
        state['value'] = envelope([observer(
            [assignment('b-row', nextAction='Attach to b-row unavailable-read')],
            coverage='unavailable', observed_at=old_at, published_at=old_at,
        )])
        page.locator('#refresh-button').click()
        expect(row(key_b)).to_contain_text('unavailable-read')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        imported_snapshot = envelope([observer(
            [assignment('b-row', nextAction='Attach to imported b-row')],
            coverage='unavailable', observed_at=old_at, published_at=old_at,
        )])
        handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
        json.dump(imported_snapshot, handle)
        handle.close()
        temp_paths.append(handle.name)
        page.set_input_files('#import-file', handle.name)
        expect(page.locator('h1')).to_have_text('Specs')
        native_hash('#/agents?' + urlencode({'id': key_a}))
        expect(page.locator('h1')).to_have_text('Agents')
        expect(page.get_by_role('heading', name='Select an observed agent', exact=True)).to_be_visible()
        expect(page.locator('main')).not_to_contain_text('selected-a')
        report['urls']['post-import'] = urlsplit(page.url).fragment
        report['scenarios'].append('Importing an unavailable snapshot drops the retained live row instead of inheriting A')

        assert not report['pageErrors'], report['pageErrors']
        posts = [entry for entry in request_log if entry['method'] == 'POST']
        assert not posts, posts
        report['requests'] = {
            'total': len(request_log),
            'stateGets': sum(1 for entry in request_log if '/api/state' in entry['url']),
            'posts': posts,
        }
        report['scenarios'].append('Viewing, polling, refresh, search and filter interactions issued no POST')
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
    for path in temp_paths:
        Path(path).unlink(missing_ok=True)
    report['elapsedSeconds'] = round(time.monotonic() - started, 3)
    (evidence / 'agents-selection.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
