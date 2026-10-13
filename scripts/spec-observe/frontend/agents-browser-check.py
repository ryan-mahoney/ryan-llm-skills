# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused Agents selection/retention/detail regressions against the real dashboard.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/agents-browser-check.py --case selection
  ... --case list | --case detail | --case captures

Only the final /api/state observer response is replaced. The built dashboard,
catalog, route, normalizeEnvelope, scope and Agents adapter stay real.
browser-fixture.mjs supplies the disposable loopback catalog/dashboard and is
owned and removed by this command. No POST creation is issued.

The detail case keeps the real App -> collectAssignments -> Agents adapter ->
AgentDetail -> reader/session composition, stubbing only navigator.clipboard
writeText so the exact copied text, denial fallback, focus and route contracts
are observable. The captures case renders all Agents states at 1280x860 and
1600x860 and records selector-level inspection facts beside each screenshot.
"""
import argparse
import json
import os
import re
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
parser.add_argument('--case', choices=['selection', 'list', 'detail', 'captures'], required=True)
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

if case == 'captures':
    root = Path(__file__).resolve().parent
    evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-agents-evidence'))
    evidence.mkdir(parents=True, exist_ok=True)
    shots = evidence / 'agents'
    shots.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = {'status': 'failed', 'case': case, 'scenarios': [], 'pageErrors': [], 'urls': {}, 'snapshots': [], 'inspections': [], 'requests': {}}
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

        request_log = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
            for width in (1280, 1600):
                context = browser.new_context(viewport={'width': width, 'height': 860})
                scenario_name = {'value': ''}

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

                def row(page, key_value):
                    return page.locator("[data-assignment-key='" + key_value + "']")

                def inspect(page, state_name, width=width):
                    record = {
                        'name': f'{state_name}@{width}',
                        'viewport': {'width': width, 'height': 860},
                        'url': urlsplit(page.url).fragment,
                        'rows': page.locator('[data-assignment-key]').count(),
                        'findRecordVisible': page.locator('#find-record').is_visible() if page.locator('#find-record').count() else False,
                        'objectHead': page.locator('.object-head h2').inner_text() if page.locator('.object-head h2').count() else None,
                        'actionsVisible': page.locator('.detail-actions').is_visible() if page.locator('.detail-actions').count() else False,
                        'actionLabels': page.locator('.detail-actions button').all_text_contents(),
                        'noticeTitles': page.locator('.ds-callout strong').all_text_contents(),
                        'caption': page.locator('.list-caption').inner_text() if page.locator('.list-caption').count() else None,
                        'detailScroll': None,
                        'pathWrapOk': None,
                        'screenshot': f'agents/{state_name}@{width}.png',
                    }
                    body = page.locator('.agent-detail .detail-body')
                    if body.count():
                        record['detailScroll'] = body.evaluate('el => ({scrollHeight: el.scrollHeight, clientHeight: el.clientHeight})')
                    paths = page.locator('.agent-detail .path')
                    if paths.count():
                        record['pathWrapOk'] = all(paths.nth(index).evaluate('el => el.scrollWidth <= el.clientWidth + 1') for index in range(paths.count()))
                    report['inspections'].append(record)
                    return record

                def capture(page, state_name, width=width):
                    page.screenshot(path=str(shots / f'{state_name}@{width}.png'))
                    report['urls'][f'{state_name}@{width}'] = urlsplit(page.url).fragment
                    inspect(page, state_name, width)

                live_state = {'value': healthy(), 'fail': False, 'hold': False}
                scenario_name['value'] = 'ideal'
                page = open_page(live_state)
                open_list(page, live_state)
                expect(row(page, key_a)).to_have_count(1)
                expect(page.locator('.object-head h2')).to_be_visible()
                expect(page.locator('.detail-actions')).to_be_visible()
                capture(page, 'ideal')
                report['scenarios'].append(f'ideal@{width}: list and detail panes render with a selected object head and persistent actions')
                page.close()

                live_state = {'value': envelope([observer([])]), 'fail': False, 'hold': False}
                scenario_name['value'] = 'empty'
                page = open_page(live_state)
                open_list(page, live_state)
                expect(page.get_by_role('heading', name='No agents observed', exact=True)).to_be_visible()
                capture(page, 'empty')
                report['scenarios'].append(f'empty@{width}: a complete empty read shows No agents observed')
                page.close()

                live_state = {'value': healthy(), 'fail': False, 'hold': False}
                scenario_name['value'] = 'no-matches'
                page = open_page(live_state)
                open_list(page, live_state, q='zzz-no-match')
                expect(page.get_by_role('heading', name='No matching agents', exact=True)).to_be_visible()
                capture(page, 'no-matches')
                report['scenarios'].append(f'no-matches@{width}: a query with no rows shows No matching agents')
                page.close()

                live_state = {'value': healthy(), 'fail': False, 'hold': True}
                scenario_name['value'] = 'loading'
                page = open_page(live_state)
                open_list(page, live_state)
                page.wait_for_selector('.records .skeleton', state='visible', timeout=5000)
                page.wait_for_selector('.detail-pane .skeleton', state='visible', timeout=5000)
                capture(page, 'loading')
                live_state['hold'] = False
                if live_state.get('pending'):
                    live_state['pending'].fulfill(json=live_state['value'])
                    live_state['pending'] = None
                report['scenarios'].append(f'loading@{width}: delayed skeletons render in both panes before the first read')
                page.close()

                live_state = {'value': healthy(), 'fail': True, 'hold': False}
                scenario_name['value'] = 'error'
                page = open_page(live_state)
                open_list(page, live_state)
                expect(page.locator('.records .ds-callout')).to_contain_text('Agents could not be read')
                capture(page, 'error')
                report['scenarios'].append(f'error@{width}: a failed initial read shows the records callout and the detail empty state')
                page.close()

                live_state = {'value': envelope([observer([assignment('active-one'), assignment('ended-one', display='ended')], coverage='partial')]), 'fail': False, 'hold': False}
                scenario_name['value'] = 'partial'
                page = open_page(live_state)
                open_list(page, live_state)
                expect(page.locator('.records .ds-callout')).to_contain_text('Assignment coverage incomplete')
                expect(page.locator('.object-head h2')).to_be_visible()
                capture(page, 'partial')
                report['scenarios'].append(f'partial@{width}: retained rows keep partial coverage reasons beside the selected detail')
                page.close()

                live_state = {'value': healthy(), 'fail': False, 'hold': False}
                scenario_name['value'] = 'offline'
                page = open_page(live_state)
                open_list(page, live_state)
                expect(row(page, key_a)).to_have_count(1)
                live_state['fail'] = True
                page.locator('#refresh-button').click()
                expect(page.locator('.records .ds-callout')).to_contain_text('Connection unavailable')
                expect(page.locator('.detail-pane .ds-callout')).to_contain_text('Connection unavailable')
                capture(page, 'offline')
                report['scenarios'].append(f'offline@{width}: a failed refresh keeps rows and the qualified detail with one recovery primary')
                page.close()

                live_state = {'value': envelope([observer([assignment('active-one')], observed_at=old_at, published_at=old_at)]), 'fail': False, 'hold': False}
                scenario_name['value'] = 'stale'
                page = open_page(live_state)
                open_list(page, live_state)
                expect(page.locator('.records .ds-callout')).to_contain_text('Last checked at')
                capture(page, 'stale')
                report['scenarios'].append(f'stale@{width}: an old observation keeps rows and qualifies the freshness in both panes')
                page.close()

                live_state = {'value': envelope([observer([assignment('active-one')], coverage='partial', observed_at=old_at, published_at=old_at)]), 'fail': False, 'hold': False}
                scenario_name['value'] = 'partial-stale'
                page = open_page(live_state)
                open_list(page, live_state)
                expect(page.locator('.records .ds-callout')).to_contain_text('assignment-read-partial')
                capture(page, 'partial-stale')
                report['scenarios'].append(f'partial-stale@{width}: freshness and coverage reasons stay readable together')
                page.close()

                live_state = {'value': healthy(), 'fail': False, 'hold': False}
                scenario_name['value'] = 'unavailable'
                page = open_page(live_state)
                open_list(page, live_state, id=key_a)
                expect(page.locator('.object-head h2')).to_have_text('active-one')
                live_state['value'] = envelope([observer([assignment('b-row', nextAction='Attach to b-row unavailable-read')], coverage='unavailable', observed_at=old_at, published_at=old_at)])
                page.locator('#refresh-button').click()
                expect(page.locator('.records .ds-callout')).to_contain_text('Source unavailable')
                expect(page.locator('.object-head h2')).to_have_text('active-one')
                expect(page.locator('.detail-pane .ds-callout')).to_contain_text('Source unavailable')
                capture(page, 'unavailable')
                report['scenarios'].append(f'unavailable@{width}: retained rows and identity keep qualified facts with no empty copy')
                page.close()

                context.close()
            browser.close()

        lines = [
            '# Agents capture inspection',
            '',
            '- Command: `SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script scripts/spec-observe/frontend/agents-browser-check.py --case captures`',
            f"- Observed commit: `{report['observedCommit']}` (dirty: {report['dirty']})",
            f"- Disposable fixture: `{receipt['url']}`",
            '- Only the final `/api/state` response was replaced; the built dashboard, route, scope, AgentDetail and Files reader stayed real.',
            '',
        ]
        for item in report['inspections']:
            lines.append(f"## {item['name']}")
            lines.append('')
            lines.append(f"- Screenshot: `evidence/{item['screenshot']}`")
            lines.append(f"- Viewport {item['viewport']['width']}x{item['viewport']['height']}; fragment `{item['url']}`")
            lines.append(f"- Rows {item['rows']}; find control visible: {item['findRecordVisible']}; caption: {item['caption']}")
            lines.append(f"- Object head: {item['objectHead']}; actions visible: {item['actionsVisible']}; actions: {item['actionLabels']}")
            if item['detailScroll']:
                lines.append(f"- Detail scrollHeight {item['detailScroll']['scrollHeight']} / clientHeight {item['detailScroll']['clientHeight']}; path wrap ok: {item['pathWrapOk']}")
            lines.append(f"- Notices: {item['noticeTitles']}")
            lines.append('')
        lines.append('Every capture is a real dashboard render at the declared viewport; see agents-captures.json for the full selector-level inspection.')
        (evidence / 'agents-visual.md').write_text('\n'.join(lines) + '\n')

        assert not report['pageErrors'], report['pageErrors']
        posts = [entry for entry in request_log if entry['method'] == 'POST']
        assert not posts, posts
        report['requests'] = {
            'total': len(request_log),
            'stateGets': sum(1 for entry in request_log if '/api/state' in entry['url']),
            'posts': posts,
            'byScenario': {name: sum(1 for entry in request_log if entry['scenario'] == name) for name in sorted({entry['scenario'] for entry in request_log})},
        }
        report['scenarios'].append('All capture interactions issued no POST and no page error')
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
        (evidence / 'agents-captures.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    raise SystemExit(0)

if case == 'detail':
    root = Path(__file__).resolve().parent
    evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-agents-evidence'))
    evidence.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = {'status': 'failed', 'case': case, 'scenarios': [], 'pageErrors': [], 'urls': {}, 'snapshots': [], 'requests': {}, 'stateReads': []}
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
        ws = 'fixture'
        pkg = receipt['package']
        uuid_a = 'a71d0c82-804d-4c46-9024-5f302490532a'
        uuid_b = 'b42f1903-9508-46c1-a4aa-a0842dbce617'
        uuid_u = 'c9016ab4-7122-4c46-9024-5f302490532a'
        uuid_w = 'd2f3a905-0c5e-4c46-9024-5f302490532a'

        def record_key(assignment_id, workspace=ws):
            return json.dumps([workspace, assignment_id], separators=(',', ':'))

        def locate_command(assignment_id):
            return 'node ~/.agents/scripts/workspaces/cli.mjs locate ' + assignment_id

        def assignment(assignment_id, display='live', **extra):
            value = {
                'assignment_id': assignment_id,
                'workspace_id': ws,
                'spec_package': pkg,
                'workflow_id': 'workflow-1',
                'display': display,
                'state': display,
                'execution': 'running',
                'task_activity': {'state': 'idle', 'reason': 'Fixture assignment is waiting for input.'},
                'nextAction': 'Attach to ' + assignment_id,
                'coverage': 'complete',
                'recordedState': 'live',
                'observedState': 'live',
                'unrecorded': False,
                'quiet': False,
                'attachedCount': 0,
                'execution_dir': '/fixture/checkout',
                'repository_id': 'fixture-repo',
                'locate_command': locate_command(assignment_id),
            }
            value.update(extra)
            return value

        def run_record(assignment_id=uuid_a, **extra):
            value = {
                'workspace': ws,
                'package': pkg,
                'package_ref': 'fixture/browser',
                'assignment_id': assignment_id,
                'workflow_id': 'workflow-1',
                'execution': 'running',
                'workflow_state': 'waiting-worker',
                'is_current_assignment': True,
                'activity': 'Building the dashboard',
                'obligation': 'Keep editors stable',
                'observed_at': generated_at,
                'coverage': {'state': 'complete', 'reasons': []},
                'spec_progress': {'current_position': 1, 'total_steps': 3, 'current_name': 'Step'},
                'timing': {'started_at': generated_at, 'attempts': []},
                'evidence': {'state': 'recorded', 'verdict': 'ready', 'scope': 'declared-artifact', 'source': 'work-tour.html', 'commit': 'abc123', 'observed_at': generated_at},
            }
            value.update(extra)
            return value

        def observer(assignments, coverage='complete', observed_at=generated_at, workspace=ws, observer_id=ws, published_at=generated_at, runs='default', recently_completed=None, planned_packages=None):
            run_rows = [run_record()] if runs == 'default' else (runs or [])
            return {
                'observer_id': observer_id,
                'state': 'observing',
                'published_at': published_at,
                'snapshot': {
                    'workspace': workspace,
                    'coverage': {'state': 'complete', 'observed_at': observed_at, 'reasons': []},
                    'runs': run_rows,
                    'recently_completed': recently_completed or [],
                    'planned_packages': planned_packages or [],
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

        request_log = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1280, 'height': 860})
            context.add_init_script(
                "window.__copiedText = null;"
                "Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: (text) => { window.__copiedText = text; return Promise.resolve(); }}});"
            )
            page = context.new_page()
            page.set_default_timeout(10000)
            page.set_default_navigation_timeout(10000)
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('request', lambda request: request_log.append({'method': request.method, 'url': request.url}))

            state = {'value': envelope([observer([assignment(uuid_a)])]), 'fail': False}

            def digest_rows(records):
                return [
                    {
                        'key': r.get('key'),
                        'assignment_id': r.get('assignment_id'),
                        'package': r.get('package') or r.get('spec_package'),
                        'evidence': (r.get('evidence') or {}).get('commit'),
                    }
                    for r in (records or [])[:8]
                ]

            def state_read_digest(value):
                if value is None:
                    return {'outcome': 'fixture-state-failure'}
                return {
                    'outcome': 'served',
                    'observers': [
                        {
                            'observer_id': o.get('observer_id'),
                            'runs': digest_rows((o.get('snapshot') or {}).get('runs')),
                            'recently_completed': digest_rows((o.get('snapshot') or {}).get('recently_completed')),
                            'planned_packages': [
                                {
                                    'key': r.get('key'),
                                    'package': r.get('package') or r.get('package_ref'),
                                    'planned_at': r.get('planned_at'),
                                }
                                for r in ((o.get('snapshot') or {}).get('planned_packages') or [])[:8]
                            ],
                        }
                        for o in (value.get('observers') or [])
                    ],
                }

            def note_state_read(route):
                reads = report['stateReads']
                if len(reads) >= 200:
                    report['stateReadsSuppressed'] = report.get('stateReadsSuppressed', 0) + 1
                    return
                reads.append({'url': route.request.url, **state_read_digest(None if state['fail'] else state['value'])})

            def serve(route):
                note_state_read(route)
                if state['fail']:
                    route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'fixture-state-failure'}))
                    return
                route.fulfill(json=state['value'])

            page.route('**/api/state**', serve)

            def params():
                return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

            def open_route(**route_params):
                page.goto(receipt['url'] + '/#/agents?' + urlencode({'ws': ws, **route_params}), wait_until='domcontentloaded')
                expect(page.locator('h1')).to_have_text('Agents')

            def selected_row():
                return page.locator('article.detail .object-head h2')

            def row(key_value):
                return page.locator("[data-assignment-key='" + key_value + "']")

            # Bounded barrier for adapter work scheduled as a task: two nested
            # frames let a queued route restore land before the proof reads or
            # writes the same scroller.
            def settle_frames():
                page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')

            # 1. The selected detail keeps recorded/observed state, execution
            #    directory and repository identity separate, and renders
            #    missing fields explicitly.
            state['value'] = envelope([observer([
                assignment(uuid_a, recordedState='live', observedState='unknown', execution_dir='/fixture/worktrees/alpha', repository_id='fixture-repo', attachedCount=2, quiet=True),
                assignment('null-fields', recordedState=None, observedState=None, execution_dir=None, repository_id=None, attachedCount=None, task_activity=None, quiet=None, locate_command=None, unrecorded=None, workersUnconfirmed=None),
            ], runs=[])])
            open_route(id=record_key(uuid_a))
            expect(row(record_key(uuid_a))).to_have_attribute('aria-pressed', 'true')
            expect(selected_row()).to_have_text(uuid_a)
            recorded_fact = page.locator('.facts .fact').filter(has_text='Recorded state')
            expect(recorded_fact).to_contain_text('Live')
            expect(recorded_fact).to_contain_text('Saved assignment record')
            observed_fact = page.locator('.facts .fact').filter(has_text='Observed state')
            expect(observed_fact).to_contain_text('Unknown')
            execution_row = page.locator('.agent-detail table tr').filter(has_text='Execution directory')
            expect(execution_row).to_contain_text('/fixture/worktrees/alpha')
            expect(execution_row).not_to_contain_text('fixture-repo')
            repository_row = page.locator('.agent-detail table tr').filter(has_text='Repository')
            expect(repository_row).to_contain_text('fixture-repo')
            expect(repository_row).not_to_contain_text('/fixture/worktrees/alpha')
            expect(page.locator('.agent-detail .obligation')).to_contain_text('Attach to ' + uuid_a)
            page.locator("[data-assignment-key='" + record_key('null-fields') + "']").click()
            expect(selected_row()).to_have_text('null-fields')
            null_facts = page.locator('.facts .fact')
            assert sum('Not included in this observation' in null_facts.nth(index).inner_text() for index in range(null_facts.count())) >= 3
            expect(page.locator('.agent-detail table')).to_contain_text('Not included in this observation')
            expect(page.locator('.agent-detail .detail-body')).to_contain_text('Coverage complete')
            report['scenarios'].append('detail separation: recorded/observed, execution_dir and repository_id stay separate; null fields render Not included in this observation')

            # 2. Copy locate writes the exact literal full-UUID command through
            #    the native helper; nothing is executed and no POST is issued.
            page.locator("[data-assignment-key='" + record_key(uuid_a) + "']").click()
            expect(selected_row()).to_have_text(uuid_a)
            command_text = locate_command(uuid_a)
            textarea = page.locator('.agent-detail textarea.locate-command')
            expect(textarea).to_have_value(command_text)
            expect(textarea).to_have_attribute('readonly', '')
            assert uuid_a in textarea.input_value()
            copy_status = page.locator('.agent-detail section').filter(has_text='Explicit operator command').locator('p[role="status"]')
            posts_before = sum(1 for entry in request_log if entry['method'] == 'POST')
            page.get_by_role('button', name='Copy locate command', exact=True).click()
            expect(copy_status).to_contain_text('Locate command copied.')
            assert page.evaluate('window.__copiedText') == command_text
            assert page.evaluate('window.__copiedText') == textarea.input_value()
            assert sum(1 for entry in request_log if entry['method'] == 'POST') == posts_before
            report['scenarios'].append('copy locate writes the exact literal full-UUID command; no POST or command execution')

            # 3. Denied clipboard selects the readonly textarea and announces
            #    the manual copy instead of failing the surface.
            page.evaluate('window.__copiedText = null')
            page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: () => Promise.reject(new Error('denied'))}})")
            page.get_by_role('button', name='Copy locate command', exact=True).click()
            expect(textarea).to_be_focused()
            assert textarea.evaluate('el => el.selectionStart === 0 && el.selectionEnd === el.value.length') is True
            expect(copy_status).to_contain_text('Select and copy the command')
            assert page.evaluate('window.__copiedText') is None
            page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: (text) => { window.__copiedText = text; return Promise.resolve(); }}})")
            report['scenarios'].append('denied clipboard selects and focuses the readonly textarea and announces manual copy without writing')

            # 4. Unknown/terminal-lost keeps the caution and the copy-locate
            #    primary action. Select the uuid_u row first: the state read
            #    below omits the current id, and a complete read clears the
            #    retained pin instead of falling through to a sibling.
            state['value'] = envelope([observer([assignment(uuid_u, display='unknown', observedState='unknown')], runs=[])])
            open_route(id=record_key(uuid_u))
            expect(selected_row()).to_have_text(uuid_u)
            for display in ('unknown', 'terminal-lost'):
                state['value'] = envelope([observer([assignment(uuid_u, display=display, observedState='unknown')], runs=[])])
                page.locator('#refresh-button').click()
                expect(selected_row()).to_have_text(uuid_u)
                expect(page.locator('.agent-detail .obligation')).to_contain_text('Do not start another writer')
                primaries = page.locator('.detail-pane .ds-btn--primary')
                expect(primaries).to_have_count(1)
                expect(primaries).to_contain_text('Copy locate command')
            report['scenarios'].append('unknown/terminal-lost keeps the caution and copy-locate primary')

            # 5. Unrecorded and workers-unconfirmed keep their cautious notices.
            state['value'] = envelope([observer([assignment(uuid_u, unrecorded=True)], runs=[])])
            page.locator('#refresh-button').click()
            expect(page.locator('.detail-pane .ds-callout')).to_contain_text('Identity and record disagree')
            state['value'] = envelope([observer([assignment(uuid_u, workersUnconfirmed=True)], runs=[])])
            page.locator('#refresh-button').click()
            expect(page.locator('.detail-pane .ds-callout')).to_contain_text('Workers unconfirmed')
            report['scenarios'].append('unrecorded and workers-unconfirmed keep their cautious notices')

            # 6. Error/offline/stale elevate exactly one recovery primary.
            state['value'] = envelope([observer([assignment(uuid_a)])])
            open_route(id=record_key(uuid_a))
            expect(selected_row()).to_have_text(uuid_a)
            state['fail'] = True
            page.locator('#refresh-button').click()
            expect(page.locator('.detail-pane .ds-callout')).to_contain_text('Connection unavailable')
            primaries = page.locator('.detail-pane .ds-btn--primary')
            expect(primaries).to_have_count(1)
            expect(primaries).to_contain_text('Retry connection')
            state['fail'] = False
            state['value'] = envelope([observer([assignment('b-row')], coverage='unavailable', observed_at=old_at, published_at=old_at)])
            page.locator('#refresh-button').click()
            expect(page.locator('.detail-pane .ds-callout')).to_contain_text('Source unavailable')
            primaries = page.locator('.detail-pane .ds-btn--primary')
            expect(primaries).to_have_count(1)
            expect(primaries).to_contain_text('Retry state')
            expect(page.locator('.agent-detail .object-head .status')).to_have_text('Not confirmed')
            expect(page.locator('.agent-detail .facts')).to_have_count(0)
            expect(page.locator('.agent-detail section').filter(has_text='Last-known execution identity')).to_have_count(1)
            state['value'] = envelope([observer([assignment(uuid_a)], observed_at=old_at, published_at=old_at)])
            page.locator('#refresh-button').click()
            expect(page.locator('.detail-pane .ds-callout')).to_contain_text('Last checked at')
            primaries = page.locator('.detail-pane .ds-btn--primary')
            expect(primaries).to_have_count(1)
            expect(primaries).to_contain_text('Refresh state')
            report['scenarios'].append('error/offline/stale elevate exactly one recovery primary (Retry state/Retry connection/Refresh state)')

            # 7. No dispatch/relaunch/attach/takeover/resume browser action.
            forbidden = page.locator('.detail-pane').get_by_role('button', name=re.compile(r'^(attach|relaunch|takeover|resume|dispatch)\b', re.I))
            assert forbidden.count() == 0, forbidden.all_text_contents()
            assert page.locator('.detail-pane a[target="_blank"]').count() == 0
            report['scenarios'].append('detail exposes no dispatch/relaunch/attach/takeover/resume action and no new-tab link')

            # 7b. Restored conservative disclosures: the last response text and
            #     finished disclaimer render after the session panel, the
            #     recover-mode automatic continuation warning shows until the
            #     linked run is user-held, and the Execution table carries the
            #     linked run's workflow state.
            recover_activity = {
                'state': 'idle',
                'reason': 'Fixture assignment is waiting for input.',
                'finished_at': generated_at,
                'last_reply': 'Fixture last reply: implementation notes remain unverified.',
            }
            recovered = envelope([observer([assignment(uuid_a, attachedCount=2, task_activity=recover_activity)])])
            recovered['observers'][0]['mode'] = 'recover'
            state['value'] = recovered
            open_route(id=record_key(uuid_a))
            expect(selected_row()).to_have_text(uuid_a)
            expect(page.get_by_text('Last response', exact=True)).to_be_visible()
            page.get_by_text('Last response', exact=True).click()
            expect(page.get_by_text('Fixture last reply: implementation notes remain unverified.', exact=True)).to_be_visible()
            expect(page.locator('.agent-detail')).to_contain_text('A finished response does not certify the proposed work was implemented or accepted.')
            expect(page.locator('.agent-detail')).to_contain_text('Automatic continuation can still act. Use takeover to hold it.')
            held = envelope([observer([assignment(uuid_a, attachedCount=2, task_activity=recover_activity)], runs=[run_record(workflow_state='user-held')])])
            held['observers'][0]['mode'] = 'recover'
            state['value'] = held
            page.locator('#refresh-button').click()
            linked_workflow = page.locator('.agent-detail table tr').filter(has_text='Linked run workflow')
            expect(linked_workflow).to_contain_text('user-held')
            expect(page.locator('.agent-detail')).not_to_contain_text('Automatic continuation can still act. Use takeover to hold it.')
            report['scenarios'].append('response/linked-run disclosures: last response, finished disclaimer and recover-mode warning show, and a user-held linked run clears the warning')

            # 8. Open spec uses the compatible workflow record.key and the
            #    planned/completed filter while preserving ws; Back/Forward
            #    restores id/filter/q/ws and the in-memory list scroll offset.
            #    Refresh is async and the heading does not change, so wait for
            #    the refreshed record's declared evidence to be consumed before
            #    Open spec; otherwise the click can still read the old record.
            state['value'] = envelope([observer([assignment(uuid_a), assignment(uuid_b)])])
            open_route(id=record_key(uuid_a))
            expect(selected_row()).to_have_text(uuid_a)
            active_key = json.dumps([ws, pkg, uuid_a], separators=(',', ':'))
            page.get_by_role('button', name='Open spec', exact=True).click()
            expect(page.locator('h1')).to_have_text('Specs')
            assert params()['ws'] == [ws] and params()['id'] == [active_key], page.url
            assert 'filter' not in params(), page.url
            page.go_back()
            expect(page.locator('h1')).to_have_text('Agents')
            expect(selected_row()).to_have_text(uuid_a)
            sentinel_commit = 'fixture-completed-sentinel-commit'
            sentinel_verdict = 'sentinel-completed'
            completed = run_record(uuid_a, recent_completion=True, completed_at=generated_at, completion_basis='manual', evidence={
                'state': 'recorded',
                'verdict': sentinel_verdict,
                'scope': 'declared-artifact',
                'source': 'work-tour.html',
                'commit': sentinel_commit,
                'observed_at': generated_at,
            })
            state['value'] = envelope([observer([assignment(uuid_a)], runs=[], recently_completed=[completed])])
            completed_declared = page.locator('.agent-detail section').filter(has_text='Declared evidence')
            completed_observation = {
                'refreshRequestedFrom': urlsplit(page.url).fragment,
                'declaredBeforeRefresh': completed_declared.inner_text(),
                'sentinelConsumed': False,
            }
            report.setdefault('scenario8', {})['completed'] = completed_observation
            reads_before = len(report['stateReads'])
            page.locator('#refresh-button').click()
            try:
                expect(completed_declared).to_contain_text('Declared ' + sentinel_verdict + ' at commit ' + sentinel_commit)
                expect(completed_declared).to_contain_text('Package-level evidence; not evidence of this assignment.')
                completed_observation['sentinelConsumed'] = True
            finally:
                completed_observation['locationAfterWait'] = urlsplit(page.url).fragment
                completed_observation['declaredAfterWait'] = completed_declared.inner_text()
                completed_observation['stateReadsForRefresh'] = report['stateReads'][reads_before:]
            report.setdefault('transitions', []).append({'transition': 'completed', 'declaredEvidence': completed_declared.inner_text()})
            page.get_by_role('button', name='Open spec', exact=True).click()
            expect(page.locator('h1')).to_have_text('Specs')
            completed_key = json.dumps([ws, pkg, 'recent-completion'], separators=(',', ':'))
            assert params()['ws'] == [ws] and params()['id'] == [completed_key], page.url
            assert params()['filter'] == ['completed'], page.url
            page.go_back()
            expect(page.locator('h1')).to_have_text('Agents')
            planned = {'workspace': ws, 'package': pkg, 'package_ref': 'fixture/browser', 'planned_at': generated_at, 'targets': [], 'source_paths': []}
            state['value'] = envelope([observer([assignment(uuid_a)], runs=[], planned_packages=[planned])])
            page.locator('#refresh-button').click()
            planned_declared = page.locator('.agent-detail section').filter(has_text='Declared evidence')
            expect(planned_declared).to_contain_text('No linked run evidence in this snapshot.')
            expect(planned_declared).to_contain_text('Package-level evidence; not evidence of this assignment.')
            report.setdefault('transitions', []).append({'transition': 'planned', 'declaredEvidence': planned_declared.inner_text()})
            page.get_by_role('button', name='Open spec', exact=True).click()
            expect(page.locator('h1')).to_have_text('Specs')
            planned_key = json.dumps([ws, pkg, 'planned-package', None], separators=(',', ':'))
            assert params()['id'] == [planned_key] and params()['filter'] == ['planned'], page.url
            page.go_back()
            report['scenarios'].append('open spec follows the compatible workflow record.key with planned/completed filters and preserved ws')

            many = [assignment(uuid_a), assignment(uuid_b)] + [assignment('extra-%02d' % index) for index in range(10)]
            state['value'] = envelope([observer(many)])
            open_route(filter='active', id=record_key(uuid_a))
            expect(selected_row()).to_have_text(uuid_a)
            expect(page.locator('[data-assignment-key]')).to_have_count(len(many))
            records = page.locator('.records')
            list_offset = records.evaluate('el => { el.scrollTop = 140; return el.scrollTop; }')
            assert list_offset > 0, list_offset
            page.locator('#find-record').fill('b42f1903')
            expect(selected_row()).to_have_text(uuid_b)
            assert params()['q'] == ['b42f1903'] and params()['filter'] == ['active'] and params()['ws'] == [ws], page.url
            page.go_back()
            expect(selected_row()).to_have_text(uuid_a)
            assert 'q' not in params() and params()['filter'] == ['active'] and params()['ws'] == [ws], page.url
            page.wait_for_timeout(200)
            expected_offset = list_offset
            actual_offset = records.evaluate('el => el.scrollTop')
            report.setdefault('scrollChecks', []).append({
                'name': 'scenario8-back-list',
                'expected': expected_offset,
                'actual': actual_offset,
                'rows': page.locator('[data-assignment-key]').count(),
                'scrollHeight': records.evaluate('el => el.scrollHeight'),
                'clientHeight': records.evaluate('el => el.clientHeight'),
            })
            assert actual_offset == expected_offset, (actual_offset, expected_offset)
            page.go_forward()
            expect(selected_row()).to_have_text(uuid_b)
            assert params()['q'] == ['b42f1903'], page.url
            report['scenarios'].append('Back/Forward restores id/filter/q/ws and the in-memory list scroll offset')

            # 9. Open work tour routes to Files with source=package, the
            #    canonical record.package and work-tour.html, rendering the
            #    real sandboxed reader.
            state['value'] = envelope([observer([assignment(uuid_a)])])
            open_route(id=record_key(uuid_a))
            expect(selected_row()).to_have_text(uuid_a)
            page.get_by_role('button', name='Open work tour', exact=True).click()
            expect(page.locator('h1')).to_have_text('Files')
            assert params()['source'] == ['package'] and params()['path'] == ['work-tour.html'], page.url
            assert params()['id'] == [pkg] and params()['ws'] == [ws], page.url
            iframe = page.locator('iframe[title="work-tour.html"]')
            iframe.wait_for(state='attached')
            assert iframe.get_attribute('sandbox') == 'allow-scripts'
            expect(page.frame_locator('iframe[title="work-tour.html"]').locator('h1')).to_have_text('Isolated work tour')
            page.go_back()
            expect(page.locator('h1')).to_have_text('Agents')
            report['scenarios'].append('open work tour uses source=package/id=record.package/path=work-tour.html and the real sandboxed reader')

            # 10. Long detail keeps the object head and bottom action bar
            #     visible, wraps execution paths, focuses the heading only on
            #     identity change, and never steals focus during polls.
            long_dir = '/fixture/' + 'segment-' * 40 + 'checkout'
            long_repo = 'repo-' + 'x' * 220
            long_attention = ['Attention item %02d %s' % (index, 'detail' * 30) for index in range(20)]
            state['value'] = envelope([observer([
                assignment(uuid_a, execution_dir=long_dir, repository_id=long_repo, attention=long_attention),
                assignment(uuid_b, execution_dir=long_dir, repository_id=long_repo, attention=long_attention),
            ])])
            open_route(id=record_key(uuid_a))
            expect(selected_row()).to_have_text(uuid_a)
            execution_row = page.locator('.agent-detail table tr').filter(has_text='Execution directory')
            expect(execution_row).to_contain_text(long_dir)
            attention_rows = page.locator('.agent-detail section').filter(has_text='Attention').locator('.info-row')
            expect(attention_rows).to_have_count(len(long_attention))
            body = page.locator('.agent-detail .detail-body')
            assert body.evaluate('el => el.scrollHeight > el.clientHeight') is True
            body.evaluate('el => { el.scrollTop = el.scrollHeight; }')
            expect(page.locator('.agent-detail .object-head')).to_be_visible()
            expect(page.locator('.agent-detail .detail-actions')).to_be_visible()
            actions_box = page.locator('.agent-detail .detail-actions').bounding_box()
            assert actions_box is not None and actions_box['y'] + actions_box['height'] <= 861, actions_box
            head_box = page.locator('.agent-detail .object-head').bounding_box()
            assert head_box is not None and head_box['y'] >= 0, head_box
            paths = page.locator('.agent-detail .path')
            assert paths.count() >= 2
            for index in range(paths.count()):
                assert paths.nth(index).evaluate('el => el.scrollWidth <= el.clientWidth + 1') is True
            page.set_viewport_size({'width': 1600, 'height': 860})
            expect(page.locator('.agent-detail .detail-actions')).to_be_visible()
            wide_box = page.locator('.agent-detail .detail-actions').bounding_box()
            assert wide_box is not None and wide_box['y'] + wide_box['height'] <= 861, wide_box
            page.set_viewport_size({'width': 1280, 'height': 860})
            page.locator('#find-record').focus()
            page.wait_for_timeout(5600)
            assert page.evaluate('document.activeElement && document.activeElement.id') == 'find-record'
            assert page.locator('.agent-detail .object-head h2').evaluate('el => el === document.activeElement') is False
            body.evaluate('el => { el.scrollTop = 250; }')
            detail_offset = body.evaluate('el => el.scrollTop')
            row(record_key(uuid_b)).focus()
            page.keyboard.press('Enter')
            expect(page.locator('.agent-detail .object-head h2')).to_be_focused()
            expect(selected_row()).to_have_text(uuid_b)
            settle_frames()
            body.evaluate('el => { el.scrollTop = 90; }')
            b_detail_offset = body.evaluate('el => el.scrollTop')
            assert 0 < b_detail_offset < detail_offset, (b_detail_offset, detail_offset)
            settle_frames()
            page.go_back()
            expect(selected_row()).to_have_text(uuid_a)
            settle_frames()
            restored_a = body.evaluate('el => el.scrollTop')
            report.setdefault('scrollChecks', []).append({
                'name': 'scenario10-back-detail',
                'expected': detail_offset,
                'actual': restored_a,
                'attentionRows': attention_rows.count(),
                'scrollHeight': body.evaluate('el => el.scrollHeight'),
                'clientHeight': body.evaluate('el => el.clientHeight'),
            })
            assert restored_a == detail_offset, (restored_a, detail_offset)
            page.go_forward()
            expect(selected_row()).to_have_text(uuid_b)
            settle_frames()
            restored_b = body.evaluate('el => el.scrollTop')
            report.setdefault('scrollChecks', []).append({
                'name': 'scenario10-forward-detail',
                'expected': b_detail_offset,
                'actual': restored_b,
                'attentionRows': attention_rows.count(),
                'scrollHeight': body.evaluate('el => el.scrollHeight'),
                'clientHeight': body.evaluate('el => el.clientHeight'),
            })
            assert restored_b == b_detail_offset, (restored_b, b_detail_offset)
            report['scenarios'].append('long detail keeps object head and action bar visible at 1280/1600, execution paths wrap, heading focuses only on identity change, polls do not steal focus, and detail scroll survives Back')

            snapshot_html = page.locator('.detail-pane').evaluate('el => el.outerHTML')
            (evidence / 'agents-detail-source.html').write_text(snapshot_html + '\n')
            report['sourceSnapshot'] = 'agents-detail-source.html'
            context.close()
            browser.close()

        assert not report['pageErrors'], report['pageErrors']
        posts = [entry for entry in request_log if entry['method'] == 'POST']
        assert not posts, posts
        report['requests'] = {
            'total': len(request_log),
            'stateGets': sum(1 for entry in request_log if '/api/state' in entry['url']),
            'posts': posts,
        }
        report['scenarios'].append('Viewing, copying, refresh, route and history interactions issued no POST and no page error')
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
        (evidence / 'agents-detail.json').write_text(json.dumps(report, indent=2) + '\n')
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
        list_callout = page.locator('.list-pane .ds-callout')
        expect(list_callout).to_contain_text('Agents could not be read')
        expect(list_callout.get_by_role('button', name='Retry state')).to_be_enabled()
        detail_callout = page.locator('.detail-pane .ds-callout')
        expect(detail_callout).to_contain_text('Agent observation unavailable')
        expect(detail_callout.get_by_role('button', name='Retry state')).to_be_enabled()
        expect(page.locator('article.detail .object-head h2')).to_have_text(key_a)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
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

        # 3d. Active/Ended tabs and Clear filters settle the visible rows and
        #     the selected id in one transaction while preserving q/ws. Clear
        #     keeps a still-visible key and drops an incompatible id before
        #     re-inferring the group.
        open_route('agents', ws='fixture', id=key_a)
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        page.get_by_role('button', name='Ended', exact=True).click()
        expect(row(key_e)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        expect(row(key_a)).to_have_count(0)
        assert params()['filter'] == ['ended'] and params()['ws'] == ['fixture'], page.url
        page.get_by_role('button', name='Active', exact=True).click()
        expect(row(key_b)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('b-row')
        assert params()['filter'] == ['active'] and params()['ws'] == ['fixture'], page.url
        native_hash('#/agents?' + urlencode({'ws': 'fixture', 'filter': 'ended', 'q': 'no-such-match', 'id': key_e}))
        expect(page.get_by_text('No matching agents', exact=True)).to_be_visible()
        page.get_by_role('button', name='Clear filters', exact=True).click()
        assert 'q' not in params() and 'filter' not in params() and params()['ws'] == ['fixture'], page.url
        expect(row(key_e)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('shared-ended')
        absent_clear = record_key('absent-clear')
        native_hash('#/agents?' + urlencode({'ws': 'fixture', 'filter': 'active', 'q': 'no-such-match', 'id': absent_clear}))
        expect(page.get_by_text('No matching agents', exact=True)).to_be_visible()
        expect(page.locator('article.detail .object-head h2')).to_have_text(absent_clear)
        page.get_by_role('button', name='Clear filters', exact=True).click()
        assert 'q' not in params() and 'filter' not in params(), page.url
        expect(row(key_b)).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('article.detail .detail-title h2')).to_have_text('b-row')
        report['scenarios'].append('Active/Ended tabs and Clear filters settle visible rows and selected id in one transaction, preserving ws and keeping or clearing the selection')

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
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .ds-callout')).to_contain_text('last-known')
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
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .ds-callout')).to_contain_text('last-known')
        expect(page.locator('article.detail .footer')).to_contain_text(retained_label)

        complete_absence = envelope([observer(
            [assignment('b-row', nextAction='Attach to b-row complete-read')],
            observed_at=old_at, published_at=old_at,
        )])
        note_state('complete-absence', complete_absence)
        state['value'] = complete_absence
        page.locator('#refresh-button').click()
        expect(row(key_b)).to_contain_text('complete-read')
        expect(page.locator('article.detail .object-head h2')).to_have_text(key_a)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .ds-callout')).to_contain_text('did not report this assignment')
        expect(page.locator('article.detail .facts')).to_have_count(0)
        expect(page.locator('article.detail .footer')).to_have_count(0)
        expect(page.locator('article.detail .detail-actions')).to_have_count(0)
        assert params()['id'] == [key_a], page.url
        expect(row(key_b)).to_have_attribute('aria-pressed', 'false')
        report['scenarios'].append('HTTP 200 unavailable/partial omission retains A with its qualified timestamp; complete absence renders the addressed Not confirmed header, withholds assignment facts and never picks B')

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
        expect(page.locator('article.detail .object-head h2')).to_have_text(key_a)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .facts')).to_have_count(0)
        expect(page.locator('article.detail .footer')).to_have_count(0)
        assert params()['id'] == [key_a], page.url

        # 4c. Moving to an absent id drops the old pin; returning to A under
        #     the same partial read cannot revive it.
        absent_c = record_key('absent-c')
        open_route('agents', ws='fixture', id=absent_c)
        expect(page.locator('article.detail .object-head h2')).to_have_text(absent_c)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .facts')).to_have_count(0)
        native_hash('#/agents?' + urlencode({'ws': 'fixture', 'id': key_a}))
        expect(page.locator('article.detail .object-head h2')).to_have_text(key_a)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .footer')).to_have_count(0)
        assert params()['id'] == [key_a], page.url
        expect(row(key_b)).to_have_attribute('aria-pressed', 'false')
        report['scenarios'].append('Complete absence invalidates the retained pin and id changes drop it; later partial reads never resurrect A')

        # 4d. All workspaces: the selected row's own owning source decides
        #     retention. A complete owning read that omits A invalidates the
        #     retained row even though an unrelated B source is partial.
        key_b_beta = record_key('b-row', 'beta')
        all_partial_a = envelope([
            observer([assignment('selected-a')], coverage='partial', observed_at=old_at, published_at=old_at, workspace='fixture', observer_id='fixture'),
            observer([assignment('b-row')], coverage='partial', observed_at=old_at, published_at=old_at, workspace='beta', observer_id='beta'),
        ])
        note_state('all-workspaces-partial-a', all_partial_a)
        state['value'] = all_partial_a
        open_route('agents', id=key_a)
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        complete_a_partial_b = envelope([
            observer([assignment('other-row')], coverage='complete', observed_at=fresh_at, published_at=fresh_at, workspace='fixture', observer_id='fixture'),
            observer([assignment('b-row')], coverage='partial', observed_at=old_at, published_at=old_at, workspace='beta', observer_id='beta'),
        ])
        note_state('complete-a-partial-b-omission', complete_a_partial_b)
        state['value'] = complete_a_partial_b
        page.locator('#refresh-button').click()
        expect(page.locator('article.detail .object-head h2')).to_have_text(key_a)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .facts')).to_have_count(0)
        expect(page.locator('article.detail .footer')).to_have_count(0)
        assert params()['id'] == [key_a] and 'ws' not in params(), page.url
        expect(row(key_b_beta)).to_have_attribute('aria-pressed', 'false')
        report['scenarios'].append('All-workspaces complete owning A omission invalidates the retained row despite an unrelated partial B')

        # 4e. All workspaces: a partial owning A omission keeps A retained
        #     beside a complete unrelated B, with A's own saved timestamp and
        #     the last-known qualification instead of the fresh attempt.
        old_a_current = envelope([
            observer([assignment('selected-a')], coverage='partial', observed_at=old_at, published_at=old_at, workspace='fixture', observer_id='fixture'),
            observer([assignment('b-row')], coverage='complete', observed_at=old_at, published_at=old_at, workspace='beta', observer_id='beta'),
        ])
        note_state('partial-a-old-selected', old_a_current)
        state['value'] = old_a_current
        page.locator('#refresh-button').click()
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        saved_a_label = locale_label(old_at)
        fresh_label = locale_label(fresh_at)
        assert saved_a_label != fresh_label
        omit_a_partial = envelope([
            observer([], coverage='partial', observed_at=fresh_at, published_at=fresh_at, workspace='fixture', observer_id='fixture'),
            observer([assignment('b-row')], coverage='complete', observed_at=fresh_at, published_at=fresh_at, workspace='beta', observer_id='beta'),
        ])
        note_state('partial-a-complete-b-omission', omit_a_partial)
        state['value'] = omit_a_partial
        page.locator('#refresh-button').click()
        expect(row(key_b_beta)).to_contain_text('Attach to b-row')
        expect(page.locator('article.detail .object-head h2')).to_have_text('selected-a')
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .facts')).to_have_count(0)
        expect(page.locator('article.detail .footer')).to_contain_text(saved_a_label)
        expect(page.locator('article.detail .footer')).not_to_contain_text(fresh_label)
        expect(page.locator('article.detail .ds-callout')).to_contain_text('last-known')
        expect(page.locator('article.detail .ds-callout')).to_contain_text(saved_a_label)
        expect(page.locator('article.detail .ds-callout')).not_to_contain_text(fresh_label)
        expect(page.locator('.records .ds-callout')).to_contain_text('Assignment coverage incomplete')
        assert params()['id'] == [key_a] and 'ws' not in params(), page.url
        expect(row(key_b_beta)).to_have_attribute('aria-pressed', 'false')
        report['scenarios'].append('All-workspaces partial owning A omission retains A beside complete B with its saved old timestamp and last-known/Not confirmed')

        # 4f. Zero current rows under a fresh partial read: the retained old A
        #     keeps its own timestamp and last-known identity, the empty list
        #     copy names the incomplete read instead of claiming absence, and
        #     only the detail pane owns the primary recovery action.
        state['value'] = old_a_current
        page.locator('#refresh-button').click()
        expect(row(key_a)).to_have_count(1)
        expect(page.locator('article.detail .detail-title h2')).to_have_text('selected-a')
        empty_partial = envelope([observer([], coverage='partial', observed_at=fresh_at, published_at=fresh_at)])
        note_state('partial-empty-omission', empty_partial)
        state['value'] = empty_partial
        page.locator('#refresh-button').click()
        expect(page.locator('[data-assignment-key]')).to_have_count(0)
        expect(page.get_by_role('heading', name='No agents in this partial read', exact=True)).to_be_visible()
        expect(page.get_by_text('No agents observed', exact=True)).to_have_count(0)
        expect(page.locator('article.detail .object-head h2')).to_have_text('selected-a')
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.get_by_role('heading', name='Last-known execution identity', exact=True)).to_be_visible()
        expect(page.locator('article.detail .footer')).to_contain_text(saved_a_label)
        expect(page.locator('article.detail .footer')).not_to_contain_text(fresh_label)
        list_refresh = page.locator('.list-pane .empty').get_by_role('button', name='Refresh state', exact=True)
        expect(list_refresh).to_be_enabled()
        assert 'ds-btn--primary' not in (list_refresh.get_attribute('class') or ''), list_refresh.get_attribute('class')
        primaries = page.locator('.workspace .ds-btn--primary')
        expect(primaries).to_have_count(1)
        expect(page.locator('.agent-detail .ds-btn--primary')).to_have_count(1)
        expect(primaries).to_have_text('Refresh state')
        assert params()['id'] == [key_a], page.url
        report['urls']['partial-empty-omission'] = urlsplit(page.url).fragment
        shots = evidence / 'final-review'
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / 'retained-partial-fixed@1280.png'))
        page.set_viewport_size({'width': 1600, 'height': 860})
        page.screenshot(path=str(shots / 'retained-partial-fixed@1600.png'))
        page.set_viewport_size({'width': 1280, 'height': 860})
        report['screenshots'] = ['final-review/retained-partial-fixed@1280.png', 'final-review/retained-partial-fixed@1600.png']
        report['scenarios'].append('Zero current rows under a fresh partial read keeps retained A Not confirmed with its saved timestamp, Last-known identity, qualified incomplete-empty copy, and only the detail pane owning the primary recovery; the list refresh stays enabled and secondary')

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
        # All workspaces is the composition counterexample: the list's fresh
        # B read must not mask selected A's old read or recovery action.
        native_hash('#/agents?' + urlencode({'id': key_a}))
        detail_notice = page.locator('.agent-detail .ds-callout')
        expect(detail_notice).to_have_count(1)
        expect(detail_notice).to_contain_text('Last checked at ' + stale_label)
        expect(detail_notice).not_to_contain_text(fresh_label)
        expect(page.locator('.records .ds-callout')).to_have_count(0)
        primaries = page.locator('.agent-detail .ds-btn--primary')
        expect(primaries).to_have_count(1)
        expect(primaries).to_have_text('Refresh state')
        state['value'] = 'fail'
        page.locator('#refresh-button').click()
        expect(detail_notice).to_contain_text('Connection unavailable')
        expect(detail_notice).to_contain_text('Last received at ' + stale_label)
        expect(detail_notice).not_to_contain_text(fresh_label)
        expect(primaries).to_have_count(1)
        expect(primaries).to_have_text('Retry connection')
        state['value'] = noted
        primaries.click()
        expect(detail_notice).to_contain_text('Last checked at ' + stale_label)
        expect(primaries).to_have_text('Refresh state')
        report['scenarios'].append('All-workspaces portfolio keeps selected old A stale despite fresh B, with its own timestamp and one recovery primary; offline and retry preserve A time')
        native_hash('#/agents?' + urlencode({'ws': 'other', 'id': key_a}))
        expect(page.locator('article.detail .object-head h2')).to_have_text(key_a)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .facts')).to_have_count(0)
        expect(page.locator('article.detail .footer')).to_have_count(0)
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
        expect(page.locator('article.detail .object-head h2')).to_have_text(key_a)
        expect(page.locator('article.detail .object-head .status')).to_have_text('Not confirmed')
        expect(page.locator('article.detail .footer')).to_have_count(0)
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
