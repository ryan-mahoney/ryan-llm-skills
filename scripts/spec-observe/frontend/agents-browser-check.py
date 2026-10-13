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
parser.add_argument('--case', choices=['selection'], required=True)
case = parser.parse_args().case
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
