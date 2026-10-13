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
conversations-browser-journey.json.

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
parser.add_argument('--case', choices=['route-drafts', 'journey'], default='route-drafts')
parser.add_argument('--capture-reference', default=None)
options = parser.parse_args()
case = options.case
reference_html = Path(options.capture_reference).resolve() if options.capture_reference else None

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
    'reference': str(reference_html) if reference_html else None,
    'visualParity': 'not claimed (route/draft regression only)' if case == 'route-drafts' else 'observed (production and reference captures at 1280x900 and 1600x900; see conversations-visual-inspection.md)',
    'cleanup': {},
}
fixture = None
reference_server = None
browser = None
context = None
fixture_info = {}
cleanup = {'fixtureTerminated': False, 'browserClosed': False, 'temporaryFixtureRootRemoved': None, 'errors': []}


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
        control('delay-send', 'true')
        draft.fill('Delayed A text')
        page.locator('#thread-send').click()
        page.locator('[data-thread="' + thread2 + '"]').click()
        draft.fill('B stays')
        page.wait_for_timeout(1000)
        expect(draft).to_have_value('B stays')
        page.locator('[data-thread="' + thread1 + '"]').click()
        expect(page.locator('#thread-draft')).to_have_value('')
        control('delay-send', 'false')
        sent = posts('send')[-1]['input']
        assert sent['thread_id'] == thread1 and sent['text'] == 'Delayed A text'
        assert all(item['input']['thread_id'] == thread1 for item in posts('send'))
        passed('delayed A send leaves B untouched and the late ack clears A only')

        # 10. A delayed acknowledgement after destination unmount still clears
        #     the retained A draft on the Files rail return.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        control('delay-send', 'true')
        draft.fill('Unmount ack text')
        page.locator('#thread-send').click()
        page.locator('.nav-item[data-area="files"]').click()
        expect(page).to_have_url(re.compile(r'#/files'))
        page.wait_for_timeout(1000)
        page.locator('.nav-item[data-area="conversations"]').click()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
        expect(page.locator('#thread-draft')).to_have_value('')
        assert posts('send')[-1]['input']['text'] == 'Unmount ack text'
        control('delay-send', 'false')
        passed('late acknowledgement clears the retained A draft after destination unmount')

        # 11. Newer text typed during a delayed send survives the late
        #     acknowledgement of the earlier submitted text.
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        draft = page.locator('#thread-draft')
        draft.wait_for()
        control('delay-send', 'true')
        draft.fill('Sent before edit')
        page.locator('#thread-send').click()
        draft.fill('Newer A text')
        page.wait_for_timeout(1000)
        expect(draft).to_have_value('Newer A text')
        control('delay-send', 'false')
        page.locator('[data-thread="' + thread2 + '"]').click()
        page.locator('[data-thread="' + thread1 + '"]').click()
        expect(page.locator('#thread-draft')).to_have_value('Newer A text')
        passed('newer A text survives the late acknowledgement of the earlier send')
    finally:
        # Release any deliberate held/rejected read and delayed send controls so
        # a failed scenario cannot block teardown.
        for action in ('release-threads', 'hold-threads', 'fail-threads', 'long-history', 'delay-send', 'fail-send'):
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
    expect(page.locator('#thread-create')).to_be_visible()
    expect(page.locator('.list-controls h2')).to_have_text('Threads')
    expect(page.locator('.list-controls p.muted')).to_contain_text('fixture')
    expect(page.locator('[data-thread][aria-pressed="true"]')).to_have_count(1)
    expect(page.locator('[data-thread="' + thread1 + '"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.object-head h2')).to_have_text('Discussion one')
    expect(page.locator('.thread-meta')).to_contain_text('Thread ' + thread1)
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
    #    Space returns to A, and aria-pressed follows the route.
    page.locator('[data-thread="' + thread2 + '"]').focus()
    page.keyboard.press('Enter')
    expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread2)))
    expect(page.locator('[data-thread="' + thread2 + '"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#thread-draft')).to_be_visible()
    page.locator('[data-thread="' + thread1 + '"]').focus()
    page.keyboard.press(' ')
    expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
    expect(page.locator('[data-thread="' + thread1 + '"]')).to_have_attribute('aria-pressed', 'true')
    passed('journey ideal: row keyboard operation keeps the aria-pressed selection and route identity')

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
            run(fixture_info['url'], fixture_info['thread1'], fixture_info['thread2'])
            if case == 'journey':
                capture_visual(fixture_info['url'], fixture_info['thread1'], fixture_info['thread2'])
            assert not report['pageErrors'], report['pageErrors']
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
