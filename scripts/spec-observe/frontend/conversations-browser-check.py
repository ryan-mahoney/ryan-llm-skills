# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused production route/draft regression: real built App, dashboard routes
and conversations adapter against the temporary fixture.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 240s uv run --script \
  scripts/spec-observe/frontend/conversations-browser-check.py --case route-drafts
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 240s uv run --script \
  scripts/spec-observe/frontend/conversations-browser-check.py --case journey \
  --capture-reference /path/to/designs/app-ui/screens/05-conversations.html

route-drafts keeps the route/draft/retry regression only. journey runs the same
traversals against the renamed Conversations adapter, then captures the
production reading surface and the reference at 1280x900 and 1600x900, writing
conversations-*.png captures, conversations-visual-inspection.md and
conversations-browser-journey.json. new-thread runs only the EV-7 creation
scenarios against the built App plus an isolated Vite source-app seed proof,
writing conversations-browser-new-thread.json; it never runs route-drafts.
view-states runs the screens 54-60 list/read/connection states against the
built App and the owned fixture, writing conversations-browser-view-states.json,
state captures at 1280 (plus an ideal 1600 capture) and reference captures.

The App, route owner, API transport and adapter are real; browser-fixture.mjs
fakes only the final discussion service/process boundary. The checker owns its
Playwright Chromium (no CDP), its fixture process, its temporary storage and its
reference loopback static server, and removes them in finally. No internal store
is injected.
"""
import argparse
import json
import os
import re
import select
import shutil
import subprocess
import threading
import time
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['route-drafts', 'journey', 'new-thread', 'view-states'], default='route-drafts')
parser.add_argument('--capture-reference', default=None)
parser.add_argument('--reference-dir', default=None)
options = parser.parse_args()
case = options.case
reference_html = Path(options.capture_reference).resolve() if options.capture_reference else None
reference_dir = Path(options.reference_dir).resolve() if options.reference_dir else None

root = Path(__file__).resolve().parent
checkout = root.parents[2]
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-conversations-evidence'))
browser_evidence = evidence / 'browser'
browser_evidence.mkdir(parents=True, exist_ok=True)
receipt_path = evidence / f'conversations-browser-{case}.json'
started = time.monotonic()
startup_seconds = None
check_started = None
report = {
    'status': 'failed',
    'case': case,
    'scenarios': [],
    'scenarioTimings': [],
    'captures': [],
    'pageErrors': [],
    'consoleErrors': [],
    'requestFailures': [],
    'fixture': {},
    'observedCommit': None,
    'dirty': None,
    'reference': str(reference_html) if reference_html else (str(reference_dir) if reference_dir else None),
    'visualParity': ('not claimed (route/draft regression only)' if case == 'route-drafts'
                     else 'not claimed (EV-7 creation coverage; captures recorded, owner inspects images)' if case == 'new-thread'
                     else 'not claimed (view-state coverage; captures recorded, owner inspects images)' if case == 'view-states'
                     else 'observed (production and reference captures at 1280x900 and 1600x900; see conversations-visual-inspection.md)'),
    'cleanup': {},
}
fixture = None
reference_server = None
browser = None
context = None
fixture_info = {}
cleanup = {'fixtureTerminated': False, 'browserClosed': False, 'temporaryFixtureRootRemoved': None, 'errors': []}
VITE_SOURCE_SCRIPT = """
import {createServer} from 'vite';
import solid from 'vite-plugin-solid';
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: 'silent',
  plugins: [solid()],
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    proxy: {
      '/api': {target: process.env.FIXTURE_URL, changeOrigin: true},
      '/package-view': {target: process.env.FIXTURE_URL, changeOrigin: true},
    },
  },
});
await server.listen();
const address = server.httpServer.address();
console.log(JSON.stringify({url: 'http://127.0.0.1:' + address.port + '/'}));
const stop = async () => { try { await server.close(); } finally { process.exit(0); } };
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
"""


class QuietRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def write_receipt():
    temporary = receipt_path.with_name(receipt_path.name + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    os.replace(temporary, receipt_path)


def run(url, thread1, thread2):
    def control(action='', value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def posts(name):
        return [x for x in control()['posts'] if x['name'] == name]

    def send_count():
        return len(posts('send'))

    def passed(name):
        report['scenarios'].append(name)
        report['scenarioTimings'].append({'scenario': name, 'atSeconds': round(time.monotonic() - started, 3)})

    def capture(name):
        # journey keeps every capture under the conversations-*.png evidence
        # prefix; route-drafts keeps its original names.
        path = browser_evidence / (f'conversations-{name}' if case == 'journey' else name)
        page.screenshot(path=str(path), full_page=True)
        report['captures'].append(str(path))

    def expect_spine_gone():
        # A route transition away from the exact row must drop the previous
        # thread's transcript, queue, composer, send and Prepare immediately,
        # before any held or rejected list read completes.
        expect(page.locator('#thread-draft')).to_have_count(0)
        expect(page.locator('#thread-send')).to_have_count(0)
        expect(page.locator('#thread-prepare-assignment')).to_have_count(0)
        expect(page.locator('#thread-queue')).to_have_count(0)
        expect(page.locator('.thread-transcript')).to_have_count(0)
        expect(page.locator('.thread-entry')).to_have_count(0)

    try:
        # 1. Cold deep link B selects exactly B and never a sibling row.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread2, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread2)))
        expect(page.locator('[data-thread="' + thread2 + '"]')).to_have_attribute('aria-pressed', 'true')
        assert page.locator('[data-thread][aria-pressed="true"]').count() == 1
        expect(draft).to_have_value('')
        passed('cold deep link selects exactly B, never a sibling row')
        capture('route-drafts-cold-deep-link.png')

        # 2. No-id entry normalizes to the first loaded row with a replace
        #    navigation: history length grows by the entry hash only.
        page.goto(url + '/#/agents?ws=fixture', wait_until='domcontentloaded')
        expect(page.locator('.nav-item[data-area="conversations"]')).to_be_visible()
        history_before = page.evaluate('history.length')
        page.evaluate("location.hash = '#/conversations?ws=fixture'")
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
        history_after = page.evaluate('history.length')
        assert history_after == history_before + 1, (history_before, history_after)
        expect(page.locator('[data-thread="' + thread1 + '"]')).to_have_attribute('aria-pressed', 'true')
        passed('no-id entry replaces the hash with the first row without adding history')
        capture('route-drafts-normalized-first-row.png')

        # 3. Row selection pushes B; Back restores A's retained text.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Route draft for A')
        page.locator('[data-thread="' + thread2 + '"]').click()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread2)))
        expect(draft).to_have_value('')
        page.go_back()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
        expect(draft).to_have_value('Route draft for A')
        passed('row A -> B pushes history and Back restores A text')

        # 4. A real 6.1s poll window and an SSE delta keep the same textarea
        #    node with its value, caret and focus.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Caret keeping draft')
        draft.focus()
        draft.evaluate('(el) => el.setSelectionRange(6, 6)')
        page.evaluate("() => { window.__routeDraftsNode = document.querySelector('#thread-draft'); }")
        control('delta')
        expect(page.locator('[role="log"][aria-label="Thread transcript"]')).to_contain_text('Streamed reply')
        page.wait_for_timeout(6100)
        assert page.evaluate("() => window.__routeDraftsNode === document.querySelector('#thread-draft')"), 'textarea was remounted'
        expect(draft).to_have_value('Caret keeping draft')
        assert draft.evaluate('(el) => [el.selectionStart, el.selectionEnd]') == [6, 6]
        expect(draft).to_be_focused()
        passed('6.1s poll and SSE delta keep the textarea node, value, caret and focus')
        capture('route-drafts-poll-caret.png')

        # 5. Files rail -> Conversations restores the remembered B selection,
        #    its draft and the actual transcript reading position.
        control('long-history', 'true')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread2, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('B reading draft')
        transcript = page.locator('.thread-transcript')
        expect(transcript.locator('.thread-entry')).to_have_count(48)
        page.wait_for_function("() => { const el = document.querySelector('.thread-transcript'); return el && el.scrollHeight > el.clientHeight + 200; }")
        transcript.evaluate('(el) => { el.scrollTop = 180; }')
        page.wait_for_timeout(120)
        saved_top = transcript.evaluate('(el) => el.scrollTop')
        assert saved_top > 100, saved_top
        page.locator('.nav-item[data-area="files"]').click()
        expect(page).to_have_url(re.compile(r'#/files'))
        page.locator('.nav-item[data-area="conversations"]').click()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread2)))
        expect(page.locator('[data-thread="' + thread2 + '"]')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('#thread-draft')).to_have_value('B reading draft')
        transcript = page.locator('.thread-transcript')
        page.wait_for_function("() => { const el = document.querySelector('.thread-transcript'); return el && el.scrollHeight > el.clientHeight + 200; }")
        page.wait_for_timeout(150)
        restored_top = transcript.evaluate('(el) => el.scrollTop')
        assert abs(restored_top - saved_top) <= 2, (saved_top, restored_top)
        control('long-history', 'false')
        passed('Files rail return restores B selection, draft and transcript position')
        capture('route-drafts-files-return.png')

        # 6. A -> missing during a HELD list drops A's spine immediately with
        #    no send posted, and A's draft returns after the release.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Held-draft A')
        sends_before = send_count()
        control('hold-threads', 'true')
        page.evaluate("location.hash = '#/conversations?ws=fixture&id=33333333-3333-4333-8333-333333333333'")
        expect_spine_gone()
        assert send_count() == sends_before, 'a send was posted during the held transition'
        control('release-threads', 'true')
        expect(page.locator('#thread-requested-unavailable')).to_be_visible()
        page.evaluate("location.hash = '#/conversations?ws=fixture&id=" + thread1 + "'")
        expect(page.locator('#thread-draft')).to_have_value('Held-draft A')
        assert send_count() == sends_before
        passed('held list: A -> missing drops the spine immediately, no send, A restores after release')

        # 7. The same transition under a REJECTED list read.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Rejected-draft A')
        sends_before = send_count()
        control('fail-threads', 'true')
        page.evaluate("location.hash = '#/conversations?ws=fixture&id=33333333-3333-4333-8333-333333333333'")
        expect_spine_gone()
        assert send_count() == sends_before, 'a send was posted during the rejected transition'
        page.wait_for_timeout(300)
        control('fail-threads', 'false')
        page.evaluate("location.hash = '#/conversations?ws=fixture&id=" + thread1 + "'")
        expect(page.locator('#thread-draft')).to_have_value('Rejected-draft A')
        assert send_count() == sends_before
        passed('rejected list: A -> missing drops the spine immediately, no send, A restores after failure')

        # 8. Failed send: retry keeps the same request id across a switch.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        control('fail-send', 'true')
        draft.fill('Retry this route message')
        page.locator('#thread-send').click()
        expect(page.locator('[role="alert"]')).to_contain_text('Discussion service unavailable')
        expect(draft).to_have_value('Retry this route message')
        first_id = posts('send')[-1]['input']['id']
        # Hash-only navigation never reloads the document, so the retained B
        # owner keeps the reading draft stored by the earlier Files-return case;
        # this is the explicit intended state, not a reset.
        page.locator('[data-thread="' + thread2 + '"]').click()
        expect(draft).to_have_value('B reading draft')
        page.locator('[data-thread="' + thread1 + '"]').click()
        expect(draft).to_have_value('Retry this route message')
        control('fail-send', 'false')
        page.locator('#thread-send').click()
        expect(draft).to_have_value('')
        retried = posts('send')[-1]['input']
        assert retried['id'] == first_id, (first_id, retried['id'])
        assert retried['thread_id'] == thread1
        passed('failed send retries with the same request id across a thread switch')

        # 9. A delayed A send leaves B's text untouched; the late
        #    acknowledgement clears only A's matching submitted text.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        control('hold-send', 'true')
        draft.fill('Delayed A text')
        with page.expect_request('**/api/thread/send'):
            page.locator('#thread-send').click()
        page.locator('[data-thread="' + thread2 + '"]').click()
        draft.fill('B stays')
        expect(draft).to_have_value('B stays')
        page.locator('[data-thread="' + thread1 + '"]').click()
        expect(draft).to_have_value('Delayed A text')
        sends_before_ack = send_count()
        with page.expect_response('**/api/thread/send'):
            control('release-send')
        expect(page.locator('#thread-draft')).to_have_value('')
        expect(page.locator('#thread-send')).to_be_disabled()
        assert send_count() == sends_before_ack, 'settlement submitted a duplicate'
        page.locator('[data-thread="' + thread2 + '"]').click()
        expect(draft).to_have_value('B stays')
        page.locator('[data-thread="' + thread1 + '"]').click()
        expect(draft).to_have_value('')
        sent = posts('send')[-1]['input']
        assert sent['thread_id'] == thread1 and sent['text'] == 'Delayed A text'
        assert all(item['input']['thread_id'] == thread1 for item in posts('send'))
        passed('held send: A -> B -> A before acknowledgement clears mounted A and leaves B untouched, no duplicate')

        # 10. A delayed acknowledgement after destination unmount still clears
        #     the retained A draft on the Files rail return.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        control('hold-send', 'true')
        draft.fill('Unmount ack text')
        with page.expect_request('**/api/thread/send'):
            page.locator('#thread-send').click()
        page.locator('.nav-item[data-area="files"]').click()
        expect(page).to_have_url(re.compile(r'#/files'))
        page.locator('.nav-item[data-area="conversations"]').click()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
        expect(page.locator('#thread-draft')).to_have_value('Unmount ack text')
        sends_before_ack = send_count()
        with page.expect_response('**/api/thread/send'):
            control('release-send')
        expect(page.locator('#thread-draft')).to_have_value('')
        expect(page.locator('#thread-send')).to_be_disabled()
        assert send_count() == sends_before_ack, 'remount settlement submitted a duplicate'
        assert posts('send')[-1]['input']['text'] == 'Unmount ack text'
        passed('held send: Files -> Conversations before acknowledgement clears the remounted composer, no duplicate')

        # 11. Newer text typed during a delayed send survives the late
        #     acknowledgement of the earlier submitted text.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        control('hold-send', 'true')
        draft.fill('Sent before edit')
        with page.expect_request('**/api/thread/send'):
            page.locator('#thread-send').click()
        page.locator('.nav-item[data-area="files"]').click()
        page.locator('.nav-item[data-area="conversations"]').click()
        expect(draft).to_have_value('Sent before edit')
        draft.fill('Newer A text')
        with page.expect_response('**/api/thread/send'):
            control('release-send')
        expect(draft).to_have_value('Newer A text')
        page.locator('[data-thread="' + thread2 + '"]').click()
        page.locator('[data-thread="' + thread1 + '"]').click()
        expect(page.locator('#thread-draft')).to_have_value('Newer A text')
        passed('newer A text typed after remount survives held send acknowledgement')
    finally:
        # Release any deliberate held/rejected read and delayed send controls so
        # a failed scenario cannot block teardown.
        for action in ('release-send', 'release-threads', 'hold-threads', 'fail-threads', 'long-history', 'delay-send', 'fail-send'):
            try:
                context.request.get(url + '/__fixture/control?action=' + action + '&value=false')
            except Exception:
                pass


def run_view_states(url, thread1, thread2):
    """Screens 54-60: list/read/connection states on the production surface.

    The owned fixture serves exact list/history HTTP statuses, scoped holds,
    incomplete-tail and invalid-record facts; the offline stream is an
    aborted Playwright route and the stale check uses a page-local Date.now
    offset (never a server timestamp). The built App, route owner, adapter
    and API transport stay real.
    """
    global reference_server

    def control(action='', value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + str(value))
        assert response.ok
        return response.json()

    def posts(name):
        return [item for item in control()['posts'] if item['name'] == name]

    def send_count():
        return len(posts('send'))

    def passed(name):
        report['scenarios'].append(name)
        report['scenarioTimings'].append({'scenario': name, 'atSeconds': round(time.monotonic() - started, 3)})

    def capture(name):
        path = browser_evidence / name
        page.screenshot(path=str(path), full_page=True)
        report['captures'].append(str(path))
        return str(path)

    imported_envelope = {
        'schema_version': 1,
        'generated_at': '2026-01-01T00:00:00.000Z',
        'observers': [{
            'observer_id': 'imported',
            'state': 'observing',
            'published_at': '2026-01-01T00:00:00.000Z',
            'snapshot': {'workspace': 'fixture', 'runs': [], 'coverage': {'state': 'complete', 'observed_at': '2026-01-01T00:00:00.000Z'}},
        }],
    }
    try:
        page.set_viewport_size({'width': 1280, 'height': 900})

        # 1. Loading: a held fixture list leaves the regional skeleton with no
        #    invented selection or composer.
        control('hold-threads', 'true')
        control('hold-threads-workspace', 'fixture')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        expect(page.locator('.list-pane .skeletons').first).to_be_visible()
        expect(page.locator('#thread-draft')).to_have_count(0)
        expect(page.locator('#thread-send')).to_have_count(0)
        expect(page.locator('[data-thread]')).to_have_count(0)
        capture('conversations-state-loading@1280.png')
        control('release-threads')
        control('hold-threads', 'false')
        control('hold-threads-workspace', '')
        expect(page.locator('#thread-draft')).to_be_visible()
        passed('view-states loading: regional skeleton with no invented selection or composer')

        # 2. Empty: a loaded empty workspace exposes no fabricated thread or
        #    composer, and Create thread enters tab=new.
        page.goto(url + '/#/conversations?ws=other', wait_until='domcontentloaded')
        expect(page.locator('.list-pane').get_by_text('No conversations yet')).to_be_visible()
        expect(page.locator('#thread-draft')).to_have_count(0)
        expect(page.locator('[data-thread]')).to_have_count(0)
        capture('conversations-state-empty@1280.png')
        page.locator('#thread-empty-create').click()
        expect(page).to_have_url(re.compile(r'tab=new'))
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        page.keyboard.press('Escape')
        passed('view-states empty: EmptyState with no composer or fabricated thread; Create thread enters tab=new')

        # 3. Denied: list 503, list 403 and history 403 suppress every private
        #    region and offer Open workspaces preserving the current ws.
        control('list-fail-status', '503')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        expect(page.locator('#thread-open-workspaces')).to_be_visible()
        expect(page.locator('[data-thread]')).to_have_count(0)
        expect(page.locator('#thread-draft')).to_have_count(0)
        expect(page.locator('.thread-transcript')).to_have_count(0)
        assert 'Discussion one' not in page.content()
        capture('conversations-state-denied-list503@1280.png')
        page.locator('#thread-open-workspaces').click()
        expect(page).to_have_url(re.compile(r'#/workspaces\?ws=fixture'))
        passed('view-states denied: list 503 suppresses the private projection and Open workspaces keeps the ws')

        control('list-fail-status', '403')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        expect(page.locator('#thread-open-workspaces')).to_be_visible()
        expect(page.locator('.thread-transcript')).to_have_count(0)
        expect(page.locator('#thread-draft')).to_have_count(0)
        assert 'Discussion one' not in page.content()
        capture('conversations-state-denied-list403@1280.png')
        passed('view-states denied: list 403 exposes no private content with Open workspaces')

        control('list-fail-status', '0')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        page.locator('#thread-draft').wait_for()
        control('history-fail-status', '403')
        page.locator('[data-thread-refresh]').click()
        expect(page.locator('#thread-open-workspaces')).to_be_visible()
        expect(page.locator('.thread-transcript')).to_have_count(0)
        expect(page.locator('#thread-draft')).to_have_count(0)
        assert 'Discussion one' not in page.content()
        capture('conversations-state-denied-history403@1280.png')
        control('history-fail-status', '0')
        passed('view-states denied: history 403 suppresses the prior projection and offers Open workspaces')

        # A successful list never clears a failed history read (production
        # contract), so a same-URL hash goto would keep the mounted denied
        # view over the retained historyError. Reload so 3b starts from a
        # fresh Conversations mount; no app-side clearing is introduced.
        page.reload(wait_until='domcontentloaded')

        # 3b. Imported/file page: the non-live source shares the denied
        #     composition and preserves the workspace on exit.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        page.locator('#thread-draft').wait_for()
        page.set_input_files('#import-file', {'name': 'snapshot.json', 'mimeType': 'application/json', 'buffer': json.dumps(imported_envelope).encode('utf-8')})
        expect(page).to_have_url(re.compile(r'#/specs'))
        page.evaluate("location.hash = '#/conversations?ws=fixture&id=" + thread1 + "'")
        expect(page.locator('#thread-open-workspaces')).to_be_visible()
        expect(page.locator('.thread-transcript')).to_have_count(0)
        expect(page.locator('#thread-draft')).to_have_count(0)
        assert 'Discussion one' not in page.content()
        capture('conversations-state-imported@1280.png')
        page.locator('#thread-open-workspaces').click()
        expect(page).to_have_url(re.compile(r'#/workspaces\?ws=fixture'))
        passed('view-states denied: an imported/file page suppresses private content and keeps the ws on Open workspaces')

        # Imported snapshot mode persists until an explicit Refresh state or a
        # document reload, so the hash navigation above leaves App live()
        # false and the step-4 mount would stay denied. Reload to start
        # step 4 from a fresh live mount.
        page.reload(wait_until='domcontentloaded')

        # 4. Error: history 503 keeps the retained transcript and draft with
        #    Send disabled; a successful list poll never clears the read
        #    error; Retry clears it only after history succeeds. A failed
        #    send keeps its retry identity until an explicit recovery.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Retained read draft')
        sends_before = send_count()
        control('history-fail-status', '503')
        page.locator('[data-thread-refresh]').click()
        expect(page.locator('.detail-pane')).to_contain_text('Thread state could not be read')
        expect(page.locator('.thread-transcript')).to_contain_text('Ready to discuss.')
        expect(draft).to_have_value('Retained read draft')
        expect(page.locator('#thread-send')).to_be_disabled()
        page.wait_for_timeout(5500)
        expect(page.locator('.detail-pane')).to_contain_text('Thread state could not be read')
        capture('conversations-state-error@1280.png')
        control('history-fail-status', '0')
        page.locator('#thread-error-retry').click()
        expect(page.locator('.detail-pane')).not_to_contain_text('Thread state could not be read')
        assert send_count() == sends_before, 'Retry thread posted a send'
        expect(page.locator('#thread-send')).to_be_enabled()
        passed('view-states error: history 503 keeps transcript/draft and disables Send; list poll alone never clears it; Retry clears only after history succeeds with no send')

        control('fail-send', 'true')
        draft.fill('Failing view-state message')
        page.locator('#thread-send').click()
        expect(page.locator('#thread-mutation-error')).to_contain_text('Discussion service unavailable')
        first_id = posts('send')[-1]['input']['id']
        control('fail-send', 'false')
        page.locator('#thread-send').click()
        expect(draft).to_have_value('')
        retried = posts('send')[-1]['input']
        assert retried['id'] == first_id and retried['thread_id'] == thread1, (first_id, retried)
        passed('view-states error: a failed send keeps the retry id and error until an explicit successful recovery')

        # 5. Partial: incomplete-tail and invalid-record warnings name reasons
        #    without raw dumps; transcript, older page and composer stay usable.
        control('incomplete-tail', 'true')
        control('invalid-records', 'true')
        # Step 4 ends on the same URL, so a same-URL hash goto would reuse the
        # mounted instance: the 5s list poll picks up invalid records, but the
        # retained history (incomplete_tail false) is never refetched because
        # history loads only on materialize/refresh/retry. Reload to start the
        # partial case from a fresh mount with both flags set.
        page.reload(wait_until='domcontentloaded')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        expect(page.locator('.list-pane')).to_contain_text('One record is not valid JSON.')
        expect(page.locator('.detail-pane')).to_contain_text('Some history could not be read')
        assert 'fixture-secret-token' not in page.content()
        expect(page.locator('.thread-transcript')).to_contain_text('Ready to discuss.')
        draft.fill('Partial state draft')
        expect(page.locator('#thread-send')).to_be_enabled()
        page.locator('[data-thread-older]').click()
        expect(page.locator('.thread-transcript .thread-entry').first).to_contain_text('Older message')
        capture('conversations-state-partial@1280.png')
        control('incomplete-tail', 'false')
        control('invalid-records', 'false')
        passed('view-states partial: incomplete-tail and invalid-record warnings name reasons without dumps; transcript, older page and composer stay usable')

        # 6. Offline: an aborted SSE keeps the response and draft with
        #    Reconnect thread; reconnecting opens a fresh stream and reloads
        #    the list without auto-send.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Offline retained draft')
        expect(page.locator('.detail-actions .status')).to_have_text('Live')
        page.route('**/api/thread/events*', lambda route: route.abort())
        # The already-open EventSource survives a route abort (only new
        # requests are intercepted), so the stream would stay Live. Remount
        # Conversations with the abort installed: the retained per-thread
        # draft owner survives the destination change, and the fresh mount's
        # openEvents() opens an aborted SSE that reaches reconnecting. A full
        # document reload would instead clear the in-memory draft owner, so
        # the destination remount keeps the retained-value proof.
        page.goto(url + '/#/workspaces?ws=fixture', wait_until='domcontentloaded')
        expect(page.locator('#thread-draft')).to_have_count(0)
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        expect(page.locator('#thread-reconnect')).to_be_visible()
        expect(page.locator('.thread-transcript')).to_contain_text('Ready to discuss.')
        expect(draft).to_have_value('Offline retained draft')
        expect(page.locator('#thread-send')).to_be_disabled()
        capture('conversations-state-offline@1280.png')
        sends_before = send_count()
        with page.expect_request(lambda request: '/api/thread/events' in request.url):
            page.locator('#thread-reconnect').click()
        page.unroute('**/api/thread/events*')
        expect(page.locator('#thread-reconnect')).to_have_count(0, timeout=10000)
        expect(page.locator('.detail-actions .status')).to_have_text('Live')
        assert send_count() == sends_before, 'Reconnect posted a send'
        passed('view-states offline: aborted SSE retains content and draft; Reconnect opens a fresh stream and reloads without auto-send')

        # 7. Stale: browser-local elapsed observation only; a server clock
        #    offset never manufactures staleness, and a successful list
        #    refresh restores ready.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Stale retained draft')
        control('hold-threads', 'true')
        control('hold-threads-workspace', 'fixture')
        control('state-clock-offset-ms', '120000')
        page.wait_for_timeout(5400)
        expect(page.locator('#thread-stale-refresh')).to_have_count(0)
        control('state-clock-offset-ms', '0')
        page.evaluate("""() => {
          if (window.__vsRealNow) return;
          window.__vsRealNow = Date.now.bind(Date);
          window.__vsOffset = 0;
          Date.now = () => window.__vsRealNow() + window.__vsOffset;
        }""")
        page.evaluate('() => { window.__vsOffset = 50000; }')
        page.locator('#thread-stale-refresh').wait_for(timeout=8000)
        expect(page.locator('.thread-transcript')).to_contain_text('Ready to discuss.')
        expect(draft).to_have_value('Stale retained draft')
        capture('conversations-state-stale@1280.png')
        page.locator('#thread-stale-refresh').click()
        page.wait_for_timeout(200)
        expect(page.locator('#thread-stale-refresh')).to_be_visible()
        control('release-threads')
        control('hold-threads', 'false')
        expect(page.locator('#thread-stale-refresh')).to_have_count(0, timeout=10000)
        page.evaluate('() => { window.__vsOffset = 0; }')
        passed('view-states stale: local elapsed >45s (server offset irrelevant) retains data; a successful list refresh restores ready')

        # 8. Isolation: a held old-workspace list response cannot leak rows,
        #    draft or controls under the new workspace.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Workspace A leak candidate')
        control('hold-threads', 'true')
        control('hold-threads-workspace', 'fixture')
        with page.expect_request(lambda request: '/api/threads' in request.url):
            page.locator('[data-thread-refresh]').click()
        page.wait_for_timeout(150)
        page.evaluate("location.hash = '#/conversations?ws=other'")
        expect(page.locator('.list-pane').get_by_text('No conversations yet')).to_be_visible()
        expect(page.locator('[data-thread]')).to_have_count(0)
        expect(page.locator('#thread-draft')).to_have_count(0)
        control('release-threads')
        control('hold-threads', 'false')
        control('hold-threads-workspace', '')
        page.wait_for_timeout(400)
        expect(page.locator('.list-pane').get_by_text('No conversations yet')).to_be_visible()
        expect(page.locator('[data-thread]')).to_have_count(0)
        expect(page.locator('#thread-draft')).to_have_count(0)
        assert 'Discussion one' not in page.content()
        passed('view-states isolation: a held old-workspace list cannot leak rows/draft/controls under another workspace')

        # 9. Ideal production precedent at 1600 for the state set.
        page.set_viewport_size({'width': 1600, 'height': 900})
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        page.locator('#thread-draft').wait_for()
        capture('conversations-state-ideal@1600.png')
        passed('view-states ideal: production capture at 1600')
    finally:
        for action, value in (('release-threads', 'false'), ('hold-threads', 'false'), ('hold-threads-workspace', ''),
                              ('list-fail-status', '0'), ('history-fail-status', '0'), ('fail-send', 'false'),
                              ('incomplete-tail', 'false'), ('invalid-records', 'false')):
            try:
                context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
            except Exception:
                pass
        try:
            page.unroute('**/api/thread/events*')
        except Exception:
            pass

    # Reference captures 54-60 at 1280 from the owned loopback static server.
    if reference_dir:
        reference_root = reference_dir.parent
        assert (reference_root / 'vendor' / 'tailwind.js').is_file(), reference_root
        reference_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_root)))
        threading.Thread(target=reference_server.serve_forever, daemon=True).start()
        base_url = f'http://127.0.0.1:{reference_server.server_address[1]}/'
        reference_page = context.new_page()
        reference_page.on('pageerror', lambda error: report['pageErrors'].append(f'reference: {error}'))
        reference_captures = []
        for index in range(54, 61):
            screen = next(path for path in sorted(reference_dir.glob(f'{index}-*.html')))
            reference_page.goto(base_url + screen.relative_to(reference_root).as_posix(), wait_until='load')
            reference_page.wait_for_timeout(250)
            reference_page.set_viewport_size({'width': 1280, 'height': 900})
            reference_page.wait_for_timeout(120)
            path = browser_evidence / f'conversations-state-reference-{index}@1280.png'
            reference_page.screenshot(path=str(path), full_page=True)
            report['captures'].append(str(path))
            reference_captures.append(str(path))
        reference_page.close()
        report['reference'] = {'dir': str(reference_dir), 'screens': [Path(path).name for path in reference_captures]}
        passed('view-states reference: screens 54-60 captured from the owned loopback server at 1280')

    inspection = evidence / 'conversations-view-states-inspection.md'
    inspection.write_text('\n'.join([
        '# Conversations view-state inspection (step 6)',
        '',
        '- Case: view-states at 1280x900 plus an ideal production capture at 1600x900.',
        '- Observed: loading shows RegionalSkeleton only (no selection/composer); empty shows EmptyState and Create thread enters tab=new.',
        '- Observed: list 503/403, history 403 and an imported snapshot suppress rows/title/transcript/composer and offer Open workspaces preserving ws.',
        '- Observed: history 503 keeps transcript/draft and disables Send; a successful list poll never clears it; Retry thread clears only after history succeeds with no send; a failed send keeps its retry id until explicit recovery.',
        '- Observed: incomplete-tail and invalid-record notices name reasons without raw dumps; parsed transcript, older page and composer stay usable.',
        '- Observed: aborted SSE retains content/draft with Reconnect thread; reconnecting opens a fresh stream and reloads the list without auto-send.',
        '- Observed: >45s browser-local elapsed observation yields stale with retained data; a server clock offset does not; a successful list refresh restores ready.',
        '- Observed: a held old-workspace list cannot leak rows/draft/controls under another workspace.',
        '- Recorded deviation: Prepare assignment stays in the detail ActionBar; the reference has no detail action bar.',
        '',
        'Captures:',
    ] + [f'- `{path}`' for path in report['captures']] + [
        f'- Receipt: `{receipt_path}`',
    ]) + '\n')
    report['viewStates'] = {'inspection': str(inspection)}


def run_new_thread(url, thread1, thread2):
    """EV-7 production creation coverage: the built App plus the owned fixture
    for the creation lifecycle, then an isolated Vite source-app seed proof.

    This case owns its scenarios and never runs the route-drafts traversal.
    Ordinary scenarios and captures use the built dashboard; the seed proof
    starts its own installed Vite server (configFile:false) and uses only the
    public conversations-state seed/open path.
    """
    global reference_server

    def control(action='', value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + str(value))
        assert response.ok
        return response.json()

    def posts(name):
        return [item for item in control()['posts'] if item['name'] == name]

    def create_posts():
        return posts('create')

    def send_count():
        return len(posts('send'))

    def passed(name):
        report['scenarios'].append(name)
        report['scenarioTimings'].append({'scenario': name, 'atSeconds': round(time.monotonic() - started, 3)})

    def capture(name):
        path = browser_evidence / name
        page.screenshot(path=str(path))
        report['captures'].append(str(path))
        return str(path)

    def active_id(target_page=None):
        return (target_page or page).evaluate("() => document.activeElement ? document.activeElement.id : ''")

    def active_text(target_page=None):
        return (target_page or page).evaluate("() => document.activeElement ? document.activeElement.textContent.trim() : ''")

    def wait_target_options(target_page):
        target_page.wait_for_function("() => [...document.querySelectorAll('#thread-new-target option')].some(option => option.value === 'fixture-repo')")

    vite = None
    try:
        # 0. Cold addressable entry: a direct tab=new deep link opens the real
        #    dialog for the same thread id, and Escape removes only the tab.
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1 + '&tab=new', wait_until='domcontentloaded')
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        page.locator('#thread-new-target').wait_for()
        expect(page.locator('[data-thread="' + thread1 + '"]')).to_have_attribute('aria-pressed', 'true')
        page.keyboard.press('Escape')
        expect(page.locator('#thread-new-dialog')).not_to_be_visible()
        assert 'tab=new' not in page.url, page.url
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1) + r'$'))
        passed('new thread: a cold tab=new deep link opens the dialog for the same thread id and Escape removes only the tab')

        # 1. Real header entry at both widths; the selected thread draft is
        #    retained; dialog Tab/Shift+Tab wraps; Escape removes only the tab
        #    and restores header focus.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Creation route draft')
        expect(page.locator('#thread-new-action')).to_be_visible()
        page.set_viewport_size({'width': 1600, 'height': 900})
        page.wait_for_timeout(120)
        expect(page.locator('#thread-new-action')).to_be_visible()
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.wait_for_timeout(120)
        page.locator('#thread-new-action').click()
        expect(page).to_have_url(re.compile(r'tab=new'))
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        page.wait_for_function("() => document.activeElement && document.activeElement.id === 'thread-new-target'")
        expect(page.locator('#thread-draft')).to_have_value('Creation route draft')
        page.locator('#thread-create').focus()
        page.keyboard.press('Tab')
        assert active_id() == 'thread-new-target', ('forward wrap', active_id())
        page.keyboard.press('Shift+Tab')
        assert active_id() == 'thread-create', ('backward wrap', active_id())
        page.locator('#thread-new-target').focus()
        expect(page.locator('#thread-new-target')).to_be_focused()
        capture('conversations-new-thread-ideal@1280.png')
        page.set_viewport_size({'width': 1600, 'height': 900})
        page.wait_for_timeout(150)
        capture('conversations-new-thread-ideal@1600.png')
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.wait_for_timeout(120)
        page.keyboard.press('Escape')
        expect(page.locator('#thread-new-dialog')).not_to_be_visible()
        assert 'tab=new' not in page.url, page.url
        page.wait_for_function("() => document.activeElement && document.activeElement.id === 'thread-new-action'")
        expect(page.locator('#thread-draft')).to_have_value('Creation route draft')
        passed('new thread: header entry at both widths, dialog Tab wrap, Escape removes only the tab and restores header focus with the thread draft retained')

        # 2. Chosen fixture repository: exact POST target shape, exact returned
        #    id selection, focused empty composer, zero send.
        sends_before = send_count()
        page.locator('#thread-new-action').click()
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        wait_target_options(page)
        page.locator('#thread-new-target').select_option('fixture-repo')
        with page.expect_response('**/api/thread/create') as creation_response:
            page.locator('#thread-create').click()
        assert creation_response.value.ok, creation_response.value
        created = create_posts()[-1]
        assert created['input']['workspace_id'] == 'fixture', created['input']
        assert created['input']['target'] == {'kind': 'repository', 'repository_id': 'fixture-repo'}, created['input']
        created_id = created['result']['thread_id']
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(created_id)))
        expect(page.locator('[data-thread="' + created_id + '"]')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('#thread-draft')).to_have_value('')
        page.wait_for_function("() => document.activeElement && document.activeElement.id === 'thread-draft'")
        assert send_count() == sends_before, 'creation triggered a send'
        passed('new thread: chosen repository target posts exactly, the exact created id is selected and its empty composer is focused with no send')

        # 3. Held create: fields/Create disabled, Return enabled and focused
        #    with a single-control Tab wrap, one POST reused across
        #    Return/reopen, then settlement to the exact created id.
        control('delay-create', 'true')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        page.locator('#thread-new-action').click()
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        wait_target_options(page)
        page.locator('#thread-new-target').select_option('fixture-repo')
        creates_before = len(create_posts())
        with page.expect_request('**/api/thread/create'):
            page.locator('#thread-create').click()
        expect(page.locator('#thread-new-target')).to_be_disabled()
        expect(page.locator('#thread-create')).to_be_disabled()
        expect(page.locator('#thread-new-dialog')).to_have_attribute('aria-busy', 'true')
        page.wait_for_function("() => document.activeElement && document.activeElement.textContent.trim() === 'Return to threads'")
        page.keyboard.press('Tab')
        assert active_text() == 'Return to threads', ('pending wrap', active_text())
        capture('conversations-new-thread-pending@1280.png')
        assert len(create_posts()) == creates_before + 1, create_posts()
        page.locator('#thread-new-dialog button:has-text("Return to threads")').click()
        expect(page.locator('#thread-new-dialog')).not_to_be_visible()
        assert 'tab=new' not in page.url, page.url
        page.locator('#thread-new-action').click()
        expect(page.locator('#thread-create')).to_be_disabled()
        page.wait_for_function("() => document.activeElement && document.activeElement.textContent.trim() === 'Return to threads'")
        assert len(create_posts()) == creates_before + 1, 'reopen started a duplicate create'
        with page.expect_response('**/api/thread/create') as held_response:
            control('release-create', 'true')
        assert held_response.value.ok, held_response.value
        held_id = create_posts()[-1]['result']['thread_id']
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(held_id)))
        page.wait_for_function("() => document.activeElement && document.activeElement.id === 'thread-draft'")
        assert len(create_posts()) == creates_before + 1, 'acknowledgement started another create'
        passed('new thread: held create disables fields/Create, focuses and wraps the enabled Return, reuses one POST across reopen and settles to the exact created id with composer focus')

        # 4. Held create closed and left for Files: the late release never
        #    steals the route and the created row is discoverable on return.
        control('delay-create', 'true')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('Retained thread draft')
        page.locator('#thread-new-action').click()
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        wait_target_options(page)
        page.locator('#thread-new-target').select_option('fixture-repo')
        creates_before = len(create_posts())
        with page.expect_request('**/api/thread/create'):
            page.locator('#thread-create').click()
        page.keyboard.press('Escape')
        expect(page.locator('#thread-new-dialog')).not_to_be_visible()
        page.locator('.nav-item[data-area="files"]').click()
        expect(page).to_have_url(re.compile(r'#/files'))
        with page.expect_response('**/api/thread/create') as away_response:
            control('release-create', 'true')
        assert away_response.value.ok, away_response.value
        away_id = create_posts()[-1]['result']['thread_id']
        assert len(create_posts()) == creates_before + 1
        page.wait_for_timeout(300)
        expect(page).to_have_url(re.compile(r'#/files'))
        page.locator('.nav-item[data-area="conversations"]').click()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
        expect(page.locator('[data-thread="' + away_id + '"]')).to_be_visible()
        expect(page.locator('#thread-draft')).to_have_value('Retained thread draft')
        passed('new thread: a held create closed before release never steals the Files route and the created row is discoverable with the thread draft retained on return')

        # 5. Failed create with a chosen target: warning and target retained,
        #    Refresh threads stays GET-only, reopen keeps the warning and
        #    Create unavailable — no automatic retry.
        control('fail-create', 'true')
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        page.locator('#thread-new-action').click()
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        wait_target_options(page)
        page.locator('#thread-new-target').select_option('fixture-repo')
        creates_before = len(create_posts())
        with page.expect_response('**/api/thread/create'):
            page.locator('#thread-create').click()
        expect(page.locator('#thread-new-dialog .ds-callout.error')).to_contain_text('Creation could not be confirmed')
        expect(page.locator('#thread-create')).to_have_count(0)
        expect(page.locator('#thread-new-target')).to_have_value('fixture-repo')
        assert len(create_posts()) == creates_before + 1
        capture('conversations-new-thread-error@1280.png')
        with page.expect_request(lambda request: '/api/threads' in request.url and request.method == 'GET'):
            page.locator('#thread-new-dialog button:has-text("Refresh threads")').click()
        page.wait_for_timeout(250)
        assert len(create_posts()) == creates_before + 1, 'Refresh threads sent a create'
        page.keyboard.press('Escape')
        expect(page.locator('#thread-new-dialog')).not_to_be_visible()
        page.locator('#thread-new-action').click()
        expect(page.locator('#thread-new-dialog .ds-callout.error')).to_contain_text('Creation could not be confirmed')
        expect(page.locator('#thread-new-target')).to_have_value('fixture-repo')
        expect(page.locator('#thread-create')).to_have_count(0)
        assert len(create_posts()) == creates_before + 1, 'reopen sent a create'
        control('fail-create', 'false')
        passed('new thread: failed create retains the warning and chosen target, Refresh threads stays GET-only, and reopening keeps the warning with Create unavailable')

        # References 09/83/84 through the owned loopback static server at the
        # matching widths; image inspection belongs to the owner.
        if reference_html:
            reference_root = reference_html.parent.parent
            assert (reference_root / 'vendor' / 'tailwind.js').is_file(), reference_root
            screens = [
                (reference_html, 'conversations-new-thread-reference-09', (1280, 1600)),
                (reference_html.with_name('83-new-thread-creating.html'), 'conversations-new-thread-reference-83', (1280,)),
                (reference_html.with_name('84-new-thread-error.html'), 'conversations-new-thread-reference-84', (1280,)),
            ]
            for screen, _prefix, _widths in screens:
                assert screen.is_file(), screen
            if reference_server is None:
                reference_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_root)))
                threading.Thread(target=reference_server.serve_forever, daemon=True).start()
            base_url = f'http://127.0.0.1:{reference_server.server_address[1]}/'
            reference_page = context.new_page()
            reference_page.on('pageerror', lambda error: report['pageErrors'].append(f'reference: {error}'))
            reference_captures = []
            for screen, prefix, widths in screens:
                reference_page.goto(base_url + screen.relative_to(reference_root).as_posix(), wait_until='load')
                reference_page.wait_for_timeout(300)
                for width in widths:
                    reference_page.set_viewport_size({'width': width, 'height': 900})
                    reference_page.wait_for_timeout(150)
                    path = browser_evidence / f'{prefix}@{width}.png'
                    reference_page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                    reference_captures.append(str(path))
            reference_page.close()
            report['reference'] = {'html': str(reference_html), 'captures': reference_captures}
            passed('new thread: reference captures for 09/83/84 from the owned loopback static server')

        # Seed proof: isolated Vite source App; ordinary captures above stay on
        # the built dashboard. Only the public seed/open path is used.
        vite = subprocess.Popen(
            ['node', '--input-type=module', '-e', VITE_SOURCE_SCRIPT],
            cwd=str(root), env={**os.environ, 'FIXTURE_URL': url},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        source_info = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            if not select.select([vite.stdout], [], [], remaining)[0]:
                break
            line = vite.stdout.readline()
            if not line:
                break
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and candidate.get('url'):
                source_info = candidate
                break
        if source_info is None:
            vite.terminate()
            try:
                _, error_output = vite.communicate(timeout=5)
            except Exception:
                vite.kill()
                error_output = ''
            vite = None
            raise RuntimeError(f'Vite source readiness exceeded 15 seconds: {(error_output or "")[-2000:]}')
        source_url = source_info['url']
        source_page = context.new_page()
        source_page.on('pageerror', lambda error: report['pageErrors'].append(f'source: {error}'))
        source_page.on('console', lambda message: report['consoleErrors'].append(f'source: {message.text}') if message.type == 'error' else None)

        # Case A (fresh document): the workspace GET is the actual App ready
        # signal; the seed is written only after it, then the dialog opens and
        # its rendered options are awaited. All later assertions stay in-app.
        with source_page.expect_response(re.compile(r'/api/workspace\?id=fixture')) as workspace_ready:
            source_page.goto(source_url + '#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        assert workspace_ready.value.ok, workspace_ready.value
        source_draft = source_page.locator('#thread-draft')
        source_draft.wait_for()
        source_creates_before = len(create_posts())
        source_sends_before = send_count()
        source_page.evaluate("async () => { const mod = await import('/src/conversations-state.ts'); mod.seedNewThreadDraft('fixture', { text: 'Source prepared text', target: 'fixture-repo' }); }")
        source_page.locator('#thread-new-action').click()
        expect(source_page).to_have_url(re.compile(r'tab=new'))
        wait_target_options(source_page)
        expect(source_page.locator('#thread-new-target')).to_have_value('fixture-repo')
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Source prepared text')
        expect(source_page.locator('#thread-new-fields textarea')).to_have_count(0)
        expect(source_draft).to_have_value('')
        source_page.keyboard.press('Escape')
        expect(source_page.locator('#thread-new-dialog')).not_to_be_visible()
        source_page.locator('#thread-new-action').click()
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Source prepared text')
        with source_page.expect_response('**/api/thread/create') as source_response:
            source_page.locator('#thread-create').click()
        assert source_response.value.ok, source_response.value
        source_created = create_posts()[-1]['result']['thread_id']
        expect(source_page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(source_created)))
        expect(source_page.locator('#thread-draft')).to_have_value('Source prepared text')
        source_page.wait_for_function("() => document.activeElement && document.activeElement.id === 'thread-draft'")
        assert send_count() == source_sends_before, 'source seed proof posted a send'
        assert len(create_posts()) == source_creates_before + 1, 'source seed proof posted extra creates'
        passed('new thread seed proof: the public seed opens the real dialog with the prepared unsent note, Escape/reopen keeps it, and Create lands the exact text once with zero send')

        # Case B (reload resets the independent case): Escape the modal before
        # leaving for Files; the exact created id is re-entered through in-app
        # hash navigation so the in-memory prepared text survives.
        with source_page.expect_response(re.compile(r'/api/workspace\?id=fixture')) as workspace_ready:
            source_page.reload(wait_until='domcontentloaded')
        assert workspace_ready.value.ok, workspace_ready.value
        source_page.evaluate("(id) => { location.hash = '#/conversations?ws=fixture&id=' + id; }", thread1)
        source_page.locator('#thread-draft').wait_for()
        source_page.evaluate("async () => { const mod = await import('/src/conversations-state.ts'); mod.seedNewThreadDraft('fixture', { text: 'Held source text', target: 'fixture-repo' }); }")
        control('delay-create', 'true')
        source_page.locator('#thread-new-action').click()
        expect(source_page).to_have_url(re.compile(r'tab=new'))
        wait_target_options(source_page)
        expect(source_page.locator('#thread-new-target')).to_have_value('fixture-repo')
        source_creates_before = len(create_posts())
        with source_page.expect_request('**/api/thread/create'):
            source_page.locator('#thread-create').click()
        source_page.keyboard.press('Escape')
        expect(source_page.locator('#thread-new-dialog')).not_to_be_visible()
        source_page.locator('.nav-item[data-area="files"]').click()
        expect(source_page).to_have_url(re.compile(r'#/files'))
        with source_page.expect_response('**/api/thread/create') as held_source_response:
            control('release-create', 'true')
        assert held_source_response.value.ok, held_source_response.value
        held_source_id = create_posts()[-1]['result']['thread_id']
        source_page.wait_for_timeout(300)
        expect(source_page).to_have_url(re.compile(r'#/files'))
        assert len(create_posts()) == source_creates_before + 1
        source_page.evaluate("(id) => { location.hash = '#/conversations?ws=fixture&id=' + id; }", held_source_id)
        expect(source_page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(held_source_id)))
        expect(source_page.locator('#thread-draft')).to_have_value('Held source text')
        passed('new thread seed proof: a held prepared create released while Files is active never steals the route and the exact created id retains the prepared text')

        # Case C (reload resets): a newer seed written while the request is
        # pending replaces the retained draft and survives the earlier
        # acknowledgement; every later assertion stays in-app.
        with source_page.expect_response(re.compile(r'/api/workspace\?id=fixture')) as workspace_ready:
            source_page.reload(wait_until='domcontentloaded')
        assert workspace_ready.value.ok, workspace_ready.value
        source_page.evaluate("(id) => { location.hash = '#/conversations?ws=fixture&id=' + id; }", thread1)
        source_page.locator('#thread-draft').wait_for()
        source_page.evaluate("async () => { const mod = await import('/src/conversations-state.ts'); mod.seedNewThreadDraft('fixture', { text: 'First pending text', target: 'fixture-repo' }); }")
        control('delay-create', 'true')
        source_page.locator('#thread-new-action').click()
        expect(source_page).to_have_url(re.compile(r'tab=new'))
        wait_target_options(source_page)
        expect(source_page.locator('#thread-new-target')).to_have_value('fixture-repo')
        with source_page.expect_request('**/api/thread/create'):
            source_page.locator('#thread-create').click()
        source_page.keyboard.press('Escape')
        expect(source_page.locator('#thread-new-dialog')).not_to_be_visible()
        source_page.evaluate("async () => { const mod = await import('/src/conversations-state.ts'); mod.seedNewThreadDraft('fixture', { text: 'Newer retained text' }); }")
        source_page.locator('#thread-new-action').click()
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Newer retained text')
        with source_page.expect_response('**/api/thread/create') as newer_response:
            control('release-create', 'true')
        assert newer_response.value.ok, newer_response.value
        newer_created = create_posts()[-1]['result']['thread_id']
        expect(source_page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(newer_created)))
        expect(source_page.locator('#thread-draft')).to_have_value('First pending text')
        source_page.locator('#thread-new-action').click()
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Newer retained text')
        passed('new thread seed proof: a newer seed arriving during a pending create survives the earlier acknowledgement as the retained draft')

        # Case D (reload resets): an invalid repository seed falls back to
        # Whole workspace while its prepared text is retained.
        with source_page.expect_response(re.compile(r'/api/workspace\?id=fixture')) as workspace_ready:
            source_page.reload(wait_until='domcontentloaded')
        assert workspace_ready.value.ok, workspace_ready.value
        source_page.evaluate("(id) => { location.hash = '#/conversations?ws=fixture&id=' + id; }", thread1)
        source_page.locator('#thread-draft').wait_for()
        source_page.evaluate("async () => { const mod = await import('/src/conversations-state.ts'); mod.seedNewThreadDraft('fixture', { text: 'Invalid target text', target: 'missing-repo' }); }")
        source_page.locator('#thread-new-action').click()
        expect(source_page).to_have_url(re.compile(r'tab=new'))
        wait_target_options(source_page)
        expect(source_page.locator('#thread-new-target')).to_have_value('')
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Invalid target text')
        passed('new thread seed proof: an invalid repository seed falls back to Whole workspace while its prepared text is retained')

        # Case E (reload resets): a public seeded failure keeps the prepared
        # note and chosen target through Refresh threads and Escape/reopen with
        # no extra create or send.
        with source_page.expect_response(re.compile(r'/api/workspace\?id=fixture')) as workspace_ready:
            source_page.reload(wait_until='domcontentloaded')
        assert workspace_ready.value.ok, workspace_ready.value
        source_page.evaluate("(id) => { location.hash = '#/conversations?ws=fixture&id=' + id; }", thread1)
        source_page.locator('#thread-draft').wait_for()
        source_page.evaluate("async () => { const mod = await import('/src/conversations-state.ts'); mod.seedNewThreadDraft('fixture', { text: 'Failed prepared text', target: 'fixture-repo' }); }")
        control('fail-create', 'true')
        source_creates_before = len(create_posts())
        source_sends_before = send_count()
        source_page.locator('#thread-new-action').click()
        expect(source_page).to_have_url(re.compile(r'tab=new'))
        wait_target_options(source_page)
        expect(source_page.locator('#thread-new-target')).to_have_value('fixture-repo')
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Failed prepared text')
        with source_page.expect_response('**/api/thread/create'):
            source_page.locator('#thread-create').click()
        expect(source_page.locator('#thread-new-dialog .ds-callout.error')).to_contain_text('Creation could not be confirmed')
        expect(source_page.locator('#thread-new-target')).to_have_value('fixture-repo')
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Failed prepared text')
        with source_page.expect_request(lambda request: '/api/threads' in request.url and request.method == 'GET'):
            source_page.locator('#thread-new-dialog button:has-text("Refresh threads")').click()
        source_page.wait_for_timeout(250)
        source_page.keyboard.press('Escape')
        expect(source_page.locator('#thread-new-dialog')).not_to_be_visible()
        source_page.locator('#thread-new-action').click()
        expect(source_page.locator('#thread-new-dialog .ds-callout.error')).to_contain_text('Creation could not be confirmed')
        expect(source_page.locator('#thread-new-target')).to_have_value('fixture-repo')
        expect(source_page.locator('#thread-new-fields')).to_contain_text('Failed prepared text')
        assert len(create_posts()) == source_creates_before + 1, 'source failure retried create'
        assert send_count() == source_sends_before, 'source failure posted a send'
        control('fail-create', 'false')
        passed('new thread seed proof: a failed public seeded create retains the prepared note and chosen target through Refresh threads and Escape/reopen with no retry')
        source_page.close()
    finally:
        if vite is not None:
            try:
                vite.terminate()
                vite.wait(timeout=10)
            except Exception as error:
                cleanup['errors'].append(f'vite source stop: {error}')
                try:
                    vite.kill()
                    vite.wait()
                except Exception:
                    pass
        for action in ('release-create', 'delay-create', 'fail-create'):
            try:
                context.request.get(url + '/__fixture/control?action=' + action + '&value=false')
            except Exception:
                pass


def capture_visual(url, thread1, thread2):
    # journey-only phase: the same route/draft/retry traversals have already
    # run against the renamed Conversations adapter. This captures the ideal
    # reading surface and the reference at both declared widths, and asserts
    # the retained contracts the captures are meant to show.
    global reference_server

    def control(action='', value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def passed(name):
        report['scenarios'].append(name)
        report['scenarioTimings'].append({'scenario': name, 'atSeconds': round(time.monotonic() - started, 3)})

    def transcript_state():
        return page.evaluate("""() => {
          const el = document.querySelector('.thread-transcript');
          if (!el) return null;
          return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
        }""")

    def overflow_state():
        return page.evaluate("""() => {
          const doc = document.documentElement;
          const main = document.querySelector('.main');
          const pane = document.querySelector('.detail-pane');
          const transcript = document.querySelector('.thread-transcript');
          return {
            documentWidth: doc.scrollWidth - doc.clientWidth,
            main: main ? main.scrollWidth - main.clientWidth : 0,
            detail: pane ? pane.scrollWidth - pane.clientWidth : 0,
            transcript: transcript ? transcript.scrollWidth - transcript.clientWidth : 0,
          };
        }""")

    def latest_turn_above_composer():
        return page.evaluate("""() => {
          const transcript = document.querySelector('.thread-transcript');
          const composer = document.querySelector('.composer');
          if (!transcript || !composer) return null;
          const entries = transcript.querySelectorAll('.thread-entry');
          if (!entries.length) return null;
          const last = entries[entries.length - 1].getBoundingClientRect();
          const box = transcript.getBoundingClientRect();
          const composerTop = composer.getBoundingClientRect().top;
          return {
            atBottom: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 40,
            lastEntryBottom: last.bottom,
            transcriptTop: box.top,
            composerTop: composerTop,
            visible: last.bottom <= composerTop + 1 && last.bottom > box.top,
          };
        }""")

    production_captures = []
    reference_captures = []

    # 1. Ideal identity: Threads/list, exact selected title/meta/transcript,
    #    new-thread control and Shell/detail heading precedence.
    page.set_viewport_size({'width': 1280, 'height': 900})
    page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
    draft = page.locator('#thread-draft')
    draft.wait_for()
    expect(page.locator('#thread-new-action')).to_be_visible()
    expect(page.locator('.list-controls h2')).to_have_text('Threads')
    expect(page.locator('.list-controls p.muted')).to_contain_text('fixture')
    expect(page.locator('[data-thread][aria-pressed="true"]')).to_have_count(1)
    expect(page.locator('[data-thread="' + thread1 + '"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.object-head h2')).to_have_text('Discussion one')
    expect(page.locator('.object-head h2')).to_have_attribute('tabindex', '-1')
    expect(page.locator('.thread-meta')).to_contain_text('Thread ' + thread1)
    # F1: the selected thread's recorded execution target renders in the
    # header against independent fixture facts (thread1 is repository
    # fixture-repo); the workspace scope stays visible separately.
    expect(page.locator('.thread-meta')).to_contain_text('Repository fixture-repo')
    expect(page.locator('.thread-meta')).to_contain_text('fixture')
    expect(page.locator('.thread-transcript')).to_contain_text('Ready to discuss.')
    headings = page.evaluate("""() => {
      const shell = document.querySelector('.page-head h1');
      const list = document.querySelector('.list-controls h2');
      const detail = document.querySelector('.object-head h2');
      const firstDetailHeading = document.querySelector('.detail-pane h2');
      if (!shell || !list || !detail) return null;
      return {
        shell: shell.textContent,
        list: list.textContent,
        detail: detail.textContent,
        shellBeforeDetail: Boolean(shell.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING),
        detailFirstInPane: firstDetailHeading === detail,
      };
    }""")
    assert headings == {'shell': 'Conversations', 'list': 'Threads', 'detail': 'Discussion one',
                        'shellBeforeDetail': True, 'detailFirstInPane': True}, headings
    passed('journey ideal: Threads/list, exact selected title/meta/transcript and Shell/detail heading precedence')

    # 2. Keyboard operation keeps the native row contract: Enter selects B,
    #    Space returns to A, and aria-pressed follows the route. F2: ordinary
    #    selection moves actual focus to the selected title once (activeElement
    #    is the detail h2, not the list row); a steady delta never steals it.
    page.locator('[data-thread="' + thread2 + '"]').focus()
    page.keyboard.press('Enter')
    expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread2)))
    expect(page.locator('[data-thread="' + thread2 + '"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#thread-draft')).to_be_visible()
    expect(page.locator('.object-head h2')).to_have_text('Discussion two')
    expect(page.locator('.object-head h2')).to_be_focused()
    assert page.evaluate("() => document.activeElement === document.querySelector('.object-head h2')"), 'ordinary selection did not focus the selected title'
    # F1 workspace fact: thread2 records a workspace target.
    expect(page.locator('.thread-meta')).to_contain_text('Workspace discussion')
    expect(page.locator('.thread-meta')).to_contain_text('Thread ' + thread2)
    # Steady delta keeps title focus instead of stealing it elsewhere.
    control('delta')
    page.wait_for_timeout(300)
    expect(page.locator('.object-head h2')).to_be_focused()
    page.locator('[data-thread="' + thread1 + '"]').focus()
    page.keyboard.press(' ')
    expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
    expect(page.locator('[data-thread="' + thread1 + '"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.object-head h2')).to_have_text('Discussion one')
    expect(page.locator('.object-head h2')).to_be_focused()
    assert page.evaluate("() => document.activeElement === document.querySelector('.object-head h2')"), 'return selection did not focus the selected title'
    # F1 worktree fact: thread3 records the fixture docs-checkout path.
    thread3 = fixture_info.get('thread3')
    worktree_target = fixture_info.get('worktreeTarget')
    assert thread3 and worktree_target, (thread3, worktree_target)
    page.goto(url + '/#/conversations?ws=fixture&id=' + thread3, wait_until='domcontentloaded')
    expect(page.locator('.object-head h2')).to_have_text('Discussion worktree')
    expect(page.locator('.thread-meta')).to_contain_text('Thread ' + thread3)
    expect(page.locator('.thread-meta')).to_contain_text('Worktree')
    assert worktree_target in page.locator('.thread-meta').inner_text(), page.locator('.thread-meta').inner_text()
    # Return to thread1 for the populated-transcript phases below.
    page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
    draft = page.locator('#thread-draft')
    draft.wait_for()
    passed('journey ideal: row keyboard operation keeps the aria-pressed selection and route identity')
    passed('journey ideal: ordinary selection focuses the selected title; steady delta keeps it')
    passed('journey ideal: header shows recorded repository/workspace/worktree targets')

    # 3. Populated 48-entry transcript: the latest turn is visible above the
    #    stable composer, and a live delta keeps the same composer node.
    control('long-history', 'true')
    page.reload(wait_until='domcontentloaded')
    draft = page.locator('#thread-draft')
    draft.wait_for()
    transcript = page.locator('.thread-transcript')
    expect(transcript.locator('.thread-entry')).to_have_count(48)
    page.wait_for_function("() => { const el = document.querySelector('.thread-transcript'); return el && el.scrollHeight > el.clientHeight + 200; }")
    transcript.evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
    page.wait_for_timeout(150)
    geometry = latest_turn_above_composer()
    assert geometry and geometry['atBottom'] and geometry['visible'], geometry
    passed('journey ideal: latest turn visible above the stable composer at 1280x900')

    page.evaluate("() => { window.__journeyComposer = document.querySelector('#thread-draft'); window.__journeyComposerValue = document.querySelector('#thread-draft').value; }")
    control('delta')
    expect(transcript).to_contain_text('Streamed reply')
    assert page.evaluate("() => window.__journeyComposer === document.querySelector('#thread-draft')"), 'composer remounted during a delta'
    assert page.evaluate("() => document.querySelector('#thread-draft').value === window.__journeyComposerValue"), 'draft value changed during a delta'
    passed('journey ideal: live delta keeps the composer node and draft value stable')

    # 4. Load older prepends the Older message with the prior viewport anchor;
    #    a reader scrolled away is not forced to the bottom by a later delta.
    transcript.evaluate('(el) => { el.scrollTop = 200; }')
    page.wait_for_timeout(150)
    before = transcript_state()
    assert before and before['scrollHeight'] - before['scrollTop'] - before['clientHeight'] > 40, before
    page.evaluate("() => { const button = document.querySelector('[data-thread-older]'); if (button) button.click(); }")
    expect(transcript.locator('.thread-entry').first).to_contain_text('Older message')
    page.wait_for_timeout(200)
    after = transcript_state()
    assert after and after['scrollHeight'] > before['scrollHeight'], (before, after)
    assert abs(after['scrollTop'] - (before['scrollTop'] + after['scrollHeight'] - before['scrollHeight'])) <= 2, (before, after)
    anchor = after['scrollTop']
    text_length = len(transcript.inner_text())
    control('delta')
    page.wait_for_function("(length) => { const el = document.querySelector('.thread-transcript'); return el && el.innerText.length > length; }", arg=text_length)
    page.wait_for_timeout(100)
    scrolled = transcript_state()
    assert scrolled and scrolled['scrollHeight'] - scrolled['scrollTop'] - scrolled['clientHeight'] > 40, scrolled
    assert abs(scrolled['scrollTop'] - anchor) <= 2, (anchor, scrolled)
    passed('journey ideal: load older prepends Older with the anchor retained; a scrolled-away reader stays put')

    # 5. Production ideal captures at both widths with the populated lower
    #    transcript scrolled to its latest turn and no horizontal overflow.
    page.reload(wait_until='domcontentloaded')
    draft = page.locator('#thread-draft')
    draft.wait_for()
    transcript = page.locator('.thread-transcript')
    expect(transcript.locator('.thread-entry')).to_have_count(48)
    page.wait_for_function("() => { const el = document.querySelector('.thread-transcript'); return el && el.scrollHeight > el.clientHeight + 200; }")
    for width in (1280, 1600):
        page.set_viewport_size({'width': width, 'height': 900})
        page.wait_for_timeout(200)
        transcript.evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
        page.wait_for_timeout(150)
        geometry = latest_turn_above_composer()
        assert geometry and geometry['atBottom'] and geometry['visible'], (width, geometry)
        overflow = overflow_state()
        assert all(value <= 1 for value in overflow.values()), (width, overflow)
        path = browser_evidence / f'conversations-production@{width}.png'
        page.screenshot(path=str(path))
        report['captures'].append(str(path))
        production_captures.append(str(path))
    passed('journey ideal: production captures at 1280 and 1600 with latest turn above the composer and no horizontal overflow')

    # 6. Reference captures at the same widths from the owned loopback server.
    if reference_html:
        assert reference_html.is_file(), reference_html
        reference_root = reference_html.parent.parent
        assert (reference_root / 'vendor' / 'tailwind.js').is_file(), reference_root
        reference_server = ThreadingHTTPServer(
            ('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_root)))
        threading.Thread(target=reference_server.serve_forever, daemon=True).start()
        reference_page = context.new_page()
        reference_page.on('pageerror', lambda error: report['pageErrors'].append(f'reference: {error}'))
        reference_url = (f'http://127.0.0.1:{reference_server.server_address[1]}/'
                         f'{reference_html.relative_to(reference_root).as_posix()}')
        reference_page.goto(reference_url, wait_until='load')
        reference_page.wait_for_timeout(300)
        for width in (1280, 1600):
            reference_page.set_viewport_size({'width': width, 'height': 900})
            reference_page.wait_for_timeout(150)
            reference_page.evaluate("() => { const log = document.querySelector('.ds-transcript'); if (log) log.scrollTop = log.scrollHeight; }")
            reference_page.wait_for_timeout(100)
            path = browser_evidence / f'conversations-reference@{width}.png'
            reference_page.screenshot(path=str(path))
            report['captures'].append(str(path))
            reference_captures.append(str(path))
        reference_page.close()
        report['reference'] = {'html': str(reference_html), 'url': reference_url, 'captures': reference_captures}
        passed('journey ideal: reference captures at 1280 and 1600 from the owned loopback server')

    report['visual'] = {
        'route': '#/conversations?ws=fixture&id=' + thread1,
        'widths': [1280, 1600],
        'productionCaptures': production_captures,
        'referenceCaptures': reference_captures,
    }
    inspection = evidence / 'conversations-visual-inspection.md'
    inspection.write_text('\n'.join([
        '# Conversations visual inspection (step 4)',
        '',
        '- Case: journey. Production route: `#/conversations?ws=fixture&id=' + thread1 + '`.',
        '- Captures: production ideal at 1280x900 and 1600x900 with the populated `.ds-transcript` scrolled to its latest turn above the stable composer; reference screens at matching widths.',
        '- Observed: Threads list with workspace label, list caption and record rows (one aria-pressed selected row); the object head shows the exact selected title, Thread id/generation/updated meta and status; the latest turn stays visible above the composer pane.',
        '- Observed: a live delta kept the same `#thread-draft` node and draft value; loading older messages prepended the Older message while retaining the viewport anchor; a reader scrolled away was not forced to the bottom by a later delta.',
        '- Observed: no horizontal overflow on the document, main region, detail pane or transcript at either width.',
        '- Recorded deviation: Prepare assignment stays in the detail ActionBar; the reference has no detail action bar.',
        '- Reference 05 composition/hierarchy/spacing/copy is the comparison target; fixture thread ids and the copied shell are not parity targets.',
        '',
        'Captures:',
    ] + [f'- `{path}`' for path in production_captures + reference_captures] + [
        f'- Receipt: `{receipt_path}`',
    ]) + '\n')
    report['visual']['inspection'] = str(inspection)
    control('long-history', 'false')


try:
    fixture = subprocess.Popen(
        ['node', str(root / 'browser-fixture.mjs')],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture readiness exceeded 10 seconds')
    fixture_info = json.loads(fixture.stdout.readline())
    report['fixture'] = fixture_info
    report['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
    report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=checkout, text=True).strip())
    with sync_playwright() as p:
        try:
            executable = shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': executable} if executable else {}), headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1280, 'height': 900}, device_scale_factor=1)
            page = context.new_page()
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('console', lambda message: report['consoleErrors'].append(message.text) if message.type == 'error' else None)
            page.on('requestfailed', lambda request: report['requestFailures'].append(
                {'method': request.method, 'url': request.url, 'failure': str(request.failure)}))
            startup_seconds = round(time.monotonic() - started, 3)
            check_started = time.monotonic()
            if case in ('route-drafts', 'journey'):
                run(fixture_info['url'], fixture_info['thread1'], fixture_info['thread2'])
            if case == 'journey':
                capture_visual(fixture_info['url'], fixture_info['thread1'], fixture_info['thread2'])
            if case == 'new-thread':
                run_new_thread(fixture_info['url'], fixture_info['thread1'], fixture_info['thread2'])
            if case == 'view-states':
                run_view_states(fixture_info['url'], fixture_info['thread1'], fixture_info['thread2'])
            assert not report['pageErrors'], report['pageErrors']
            if case == 'new-thread':
                unexpected_console = [text for text in report['consoleErrors'] if 'Failed to load resource' not in text]
                assert not unexpected_console, unexpected_console
            report['status'] = 'passed'
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception as error:
                    cleanup['errors'].append(f'context close: {error}')
            if browser is not None:
                try:
                    browser.close()
                    cleanup['browserClosed'] = True
                except Exception as error:
                    cleanup['errors'].append(f'browser close: {error}')
except BaseException:
    report['error'] = traceback.format_exc()
    raise
finally:
    finished = time.monotonic()
    if reference_server is not None:
        try:
            reference_server.shutdown()
            reference_server.server_close()
            cleanup['referenceServerStopped'] = True
        except Exception as error:
            cleanup['errors'].append(f'reference server shutdown: {error}')
    if fixture is not None:
        fixture.terminate()
        try:
            fixture.wait(timeout=10)
            cleanup['fixtureTerminated'] = True
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
            cleanup['fixtureTerminated'] = True
    if fixture_info.get('root'):
        try:
            cleanup['temporaryFixtureRootRemoved'] = not Path(fixture_info['root']).exists()
            if not cleanup['temporaryFixtureRootRemoved']:
                cleanup['errors'].append(f"temporary fixture root still present: {fixture_info['root']}")
        except Exception as error:
            cleanup['errors'].append(f'temporary fixture root check: {error}')
    report['startupSeconds'] = startup_seconds
    report['checkSeconds'] = None if check_started is None else round(finished - check_started, 3)
    report['elapsedSeconds'] = round(finished - started, 3)
    report['cleanup'] = cleanup
    write_receipt()

print(json.dumps({
    'status': report['status'],
    'elapsed_seconds': report['elapsedSeconds'],
    'scenarios': report['scenarios'],
    'captures': report['captures'],
    'receipt': str(receipt_path),
    'dirty': report['dirty'],
}))
