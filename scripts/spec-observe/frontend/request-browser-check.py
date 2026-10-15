# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Step-9 request-work entry check: real built App against the temporary fixture.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 240s uv run --script \
  scripts/spec-observe/frontend/request-browser-check.py --case entry \
  --capture-reference /path/to/designs/context-command-surfacing/screens/01-command-proposal.html

entry runs the step-9 request-work shell proof: the persistent
#request-work-trigger in the page head on every real destination (including the
hidden launch route, workspace-scoped routes and the workspace-picker state),
the compact pinned 56px phone title/trigger header entry at 390 and 320 with the
sheet below it, the native #request-work-dialog focus lifecycle (open/ready
focuses Start recording, or the request field when recording is disabled;
transcribing focuses the panel heading; Escape/close returns focus to the
trigger; plus Ctrl+J, Meta+J and the labelled close button), the existing New
thread modal
blocking the request shortcut, and the responsive sheet geometry at 320, 390 and
1280 widths. It writes request-dialog-<width>.png,
request-entry-closed-<width>.png, request-sheet-below-<width>.png captures and
browser/request-browser-entry.json.

scope runs the focused removal interaction on a selected spec entity: the
request-state store initializes the route scope, Remove context falls back to
the workspace scope, the displayed context matches it, and the removal survives
close/reopen on the same route. It writes request-scope-entity-<width>.png and
request-scope-removed-<width>.png captures and browser/request-browser-scope.json.

spoken-plan runs the real oscillator-media capture journey with SENTINEL_REQUEST_FIXTURE
scenarios: the built App's #request-work-trigger opens the native dialog, Start
recording shows the labelled red-dot/level/elapsed readout, Cancel recording
stops the granted tracks and discards the audio, Stop transcribes through the
real store and HTTP route to editable request text and the interpreted result.
It writes request-spoken-recording-1280.png, request-spoken-cancelled-1280.png,
request-spoken-transcript-1280.png and request-spoken-result-1280.png captures
and browser/request-browser-spoken-plan.json.

input-failures runs four named recovery journeys: denied microphone, unavailable
speech readiness, transcription failure with an identical-bytes/same-request-id
retry, and interpretation failure plus offline retry. It writes
request-input-<state>-1280.png captures and
browser/request-browser-input-failures.json.

With --capture-reference it also serves the reference screen from the owned
loopback server and captures request-reference-<width>.png at the same widths.

The App, Shell, route owner and request-state are real; browser-fixture.mjs
fakes only the final service boundary. Entry/scope runs keep its default flags.
The spoken-plan and input-failures cases set SENTINEL_REQUEST_FIXTURE=1 in the
fixture child environment (and only for those case sets), which enables the
real request routes' deterministic final-child seam; the checker then drives
scenarios through GET /__fixture/control?action=request-scenario. The checker
owns its Playwright Chromium (no CDP), its fixture process and its temporary
storage, and removes them in finally.
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
import threading
import time
import traceback
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case', action='append', choices=['entry', 'scope', 'spoken-plan', 'input-failures'], default=None)
parser.add_argument('--capture-reference', default=None)
options = parser.parse_args()
# Repeatable --case: one receipt per case, all against one owned fixture.
cases = options.case or ['entry']
reference_html = Path(options.capture_reference).resolve() if options.capture_reference else None

root = Path(__file__).resolve().parent
checkout = root.parents[2]
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-request-evidence'))
browser_evidence = evidence / 'browser'
browser_evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
startup_seconds = None
case_receipts = []


def fresh_report(case_name):
    return {
        'status': 'failed',
        'case': case_name,
        'assertions': [],
        'captures': [],
        'referenceCaptures': [],
        'measurements': {},
        'pageErrors': [],
        'consoleErrors': [],
        'requestFailures': [],
        'fixture': {},
        'observedCommit': None,
        'dirty': None,
        'reference': str(reference_html) if reference_html else None,
        'cleanup': {},
    }


report = fresh_report(cases[0])
receipt_path = browser_evidence / f'request-browser-{cases[0]}.json'
fixture = None
fixture_pgid = None
reference_server = None
browser = None
context = None
page = None
fixture_info = {}
cleanup = {
    'fixtureTerminated': False,
    'fixtureTreeKilled': False,
    'browserClosed': False,
    'temporaryFixtureRootRemoved': None,
    'errors': [],
}


class QuietRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def write_receipt(path, payload):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(payload, indent=2) + '\n')
    os.replace(temporary, path)


def run_assertion(name, action):
    """One named result per assertion group; failures name themselves."""
    result = {'name': name, 'status': 'failed'}
    try:
        detail = action()
        result['status'] = 'passed'
        if detail is not None:
            result['detail'] = detail
    except Exception:
        result['error'] = traceback.format_exc()
    report['assertions'].append(result)
    return result['status'] == 'passed'


def kill_fixture_tree():
    """Process-level enforcement: SIGKILL the fixture's whole process group."""
    if fixture_pgid is None:
        return False
    try:
        os.killpg(fixture_pgid, signal.SIGKILL)
    except ProcessLookupError:
        return False
    except Exception as error:
        cleanup['errors'].append(f'fixture tree kill: {error}')
        return False
    return True


def capture_reference():
    global reference_server
    assert reference_html.is_file(), reference_html
    reference_root = reference_html.parent.parent
    assert (reference_root / 'vendor' / 'tailwind.js').is_file(), reference_root
    if reference_server is None:
        reference_server = ThreadingHTTPServer(
            ('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_root)))
        threading.Thread(target=reference_server.serve_forever, daemon=True).start()
    reference_page = context.new_page()
    reference_page.on('pageerror', lambda error: report['pageErrors'].append(f'reference: {error}'))
    reference_url = (f'http://127.0.0.1:{reference_server.server_address[1]}/'
                     f'{reference_html.relative_to(reference_root).as_posix()}')
    reference_page.goto(reference_url, wait_until='load')
    # The reference keeps its command panel closed on load; reveal it so the
    # capture shows the same surface the production captures show.
    reference_page.evaluate("() => { const cmd = document.getElementById('cmd'); if (cmd) cmd.hidden = false; }")
    reference_page.wait_for_timeout(250)
    for width, height in ((1280, 900), (390, 900), (320, 568)):
        reference_page.set_viewport_size({'width': width, 'height': height})
        reference_page.wait_for_timeout(150)
        path = browser_evidence / f'request-reference-{width}.png'
        reference_page.screenshot(path=str(path))
        report['captures'].append(str(path))
        report['referenceCaptures'].append(str(path))
    reference_page.close()
    report['reference'] = {'html': str(reference_html), 'url': reference_url, 'captures': list(report['referenceCaptures'])}
    return {'widths': [1280, 390, 320]}


def run_entry(url, thread1):
    def capture(name):
        path = browser_evidence / name
        page.screenshot(path=str(path))
        report['captures'].append(str(path))
        return str(path)

    def dialog_open():
        return page.evaluate(
            "() => { const d = document.getElementById('request-work-dialog'); return Boolean(d && d.open); }")

    def active_id():
        return page.evaluate("() => document.activeElement ? document.activeElement.id : null")

    def trigger_visible(hash_route):
        page.goto(url + '/' + hash_route, wait_until='domcontentloaded')
        expect(page.locator('.page-head #request-work-trigger')).to_be_visible()
        return {'hash': hash_route}

    def ensure_closed():
        if dialog_open():
            page.keyboard.press('Escape')
            expect(page.locator('#request-work-dialog')).not_to_be_visible()

    def open_via_trigger():
        page.locator('#request-work-trigger').click()
        expect(page.locator('#request-work-dialog')).to_be_visible()

    # 0. Default fixture landing keeps its existing heading.
    def default_landing():
        page.goto(url + '/', wait_until='domcontentloaded')
        heading = page.locator('.page-head h1')
        expect(heading).to_be_visible()
        text = heading.inner_text()
        assert text == 'New files waiting for a next step', text
        return {'heading': text}
    run_assertion('default-fixture-landing', default_landing)

    # 1. The persistent trigger renders on every real destination. The
    #    workspace-requiring destinations (conversations, files, designs,
    #    launch) render the workspace-picker state without ws; the trigger
    #    stays visible there too.
    for dest in ('next-steps', 'specs', 'epics', 'agents', 'conversations', 'files',
                 'designs', 'workspaces', 'models', 'launch'):
        run_assertion(f'trigger-on-destination:{dest}', (lambda d=dest: trigger_visible('#/' + d)))
    for scoped in (f'#/conversations?ws=fixture&id={thread1}', '#/designs?ws=fixture',
                   '#/files?ws=fixture', '#/launch?ws=fixture'):
        run_assertion(f'trigger-on-workspace-scoped:{scoped}', (lambda h=scoped: trigger_visible(h)))

    def picker_state_trigger():
        page.goto(url + '/#/files', wait_until='domcontentloaded')
        expect(page.locator('.workspace-picker')).to_be_visible()
        expect(page.locator('.page-head #request-work-trigger')).to_be_visible()
        return {'hash': '#/files', 'picker': True}
    run_assertion('trigger-on-picker-state:files', picker_state_trigger)

    # 2. Native dialog and real focus lifecycle against the built App.
    def expect_ready_focus():
        # Step-10 focus rule: open in ready focuses Start recording when the
        # control is enabled, otherwise the request textarea. The disabled
        # property is read at assert time so the rule's target is exact.
        target = page.evaluate(
            "() => { const start = document.getElementById('request-work-start');"
            " return start && !start.disabled ? 'request-work-start' : 'request-work-text'; }")
        focused = active_id()
        assert focused == target, {'expected': target, 'focused': focused}
        return target

    def dialog_open_focuses_ready_target():
        page.goto(url + '/#/specs', wait_until='domcontentloaded')
        ensure_closed()
        open_via_trigger()
        assert dialog_open(), 'dialog did not open'
        target = expect_ready_focus()
        return {'activeElement': active_id(), 'focusTarget': target}
    run_assertion('dialog-open-focuses-ready-target', dialog_open_focuses_ready_target)

    def dialog_escape_closes_returns_focus():
        ensure_open = not dialog_open()
        if ensure_open:
            open_via_trigger()
        page.keyboard.press('Escape')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        assert not dialog_open(), 'dialog stayed open after Escape'
        expect(page.locator('#request-work-trigger')).to_be_focused()
        return {'activeElement': active_id()}
    run_assertion('dialog-escape-closes-returns-focus', dialog_escape_closes_returns_focus)

    def dialog_shortcut_ctrl_j_toggle():
        ensure_closed()
        page.keyboard.press('Control+j')
        expect(page.locator('#request-work-dialog')).to_be_visible()
        assert dialog_open(), 'Ctrl+J did not open the dialog'
        target = expect_ready_focus()
        page.keyboard.press('Control+j')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        assert not dialog_open(), 'second Ctrl+J did not close the dialog'
        expect(page.locator('#request-work-trigger')).to_be_focused()
        return {'activeElement': active_id(), 'focusTarget': target}
    run_assertion('dialog-shortcut-ctrl-j-toggle', dialog_shortcut_ctrl_j_toggle)

    def dialog_shortcut_meta_j_toggle():
        ensure_closed()
        page.keyboard.press('Meta+j')
        expect(page.locator('#request-work-dialog')).to_be_visible()
        assert dialog_open(), 'Meta+J did not open the dialog'
        target = expect_ready_focus()
        page.keyboard.press('Meta+j')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        assert not dialog_open(), 'second Meta+J did not close the dialog'
        expect(page.locator('#request-work-trigger')).to_be_focused()
        return {'activeElement': active_id(), 'focusTarget': target}
    run_assertion('dialog-shortcut-meta-j-toggle', dialog_shortcut_meta_j_toggle)

    def dialog_close_button_returns_focus():
        ensure_closed()
        open_via_trigger()
        page.locator('#request-work-dialog button[aria-label="Close request panel"]').click()
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        assert not dialog_open(), 'close button did not close the dialog'
        expect(page.locator('#request-work-trigger')).to_be_focused()
        return {'activeElement': active_id()}
    run_assertion('dialog-close-button-returns-focus', dialog_close_button_returns_focus)

    # 3. An existing modal owns the shortcut: Ctrl+J must leave the New thread
    #    dialog alone and must not open the request dialog behind it.
    def existing_modal_blocks_shortcut():
        ensure_closed()
        page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
        expect(page.locator('#thread-new-action')).to_be_visible()
        page.locator('#thread-new-action').click()
        expect(page).to_have_url(re.compile(r'tab=new'))
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        page.keyboard.press('Control+j')
        page.wait_for_timeout(150)
        assert not dialog_open(), 'request dialog opened while the New thread modal was open'
        expect(page.locator('#thread-new-dialog')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('#thread-new-dialog')).not_to_be_visible()
        return {'thread': thread1}
    run_assertion('existing-modal-blocks-shortcut', existing_modal_blocks_shortcut)

    # 4. Responsive sheet geometry with the dialog open.
    def desktop_1280_geometry():
        ensure_closed()
        page.set_viewport_size({'width': 1280, 'height': 900})
        open_via_trigger()
        geometry = page.evaluate("""() => {
          const dialog = document.getElementById('request-work-dialog').getBoundingClientRect();
          const head = document.querySelector('.page-head').getBoundingClientRect();
          return {dialogWidth: dialog.width, dialogTop: dialog.top, headBottom: head.bottom};
        }""")
        report['measurements']['desktop1280'] = geometry
        assert geometry['dialogWidth'] <= 680, geometry
        assert geometry['dialogTop'] >= geometry['headBottom'], geometry
        trigger_box = page.locator('.page-head #request-work-trigger').bounding_box()
        assert trigger_box, 'trigger has no box while the dialog is open'
        assert trigger_box['y'] + trigger_box['height'] <= geometry['dialogTop'], (trigger_box, geometry)
        capture('request-dialog-1280.png')
        return geometry
    run_assertion('desktop-1280-panel-geometry', desktop_1280_geometry)

    def phone_390_thumb_zone():
        ensure_closed()
        page.set_viewport_size({'width': 390, 'height': 900})
        open_via_trigger()
        measurements = page.evaluate("""() => {
          const primary = document.querySelector('.cmd-foot .ds-btn--primary');
          const foot = document.querySelector('.cmd-foot');
          const box = primary.getBoundingClientRect();
          return {
            primaryLeft: box.left, primaryRight: box.right,
            primaryTop: box.top, primaryBottom: box.bottom,
            primaryHeight: box.height,
            primaryCenterY: (box.top + box.bottom) / 2,
            viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
            footScrollWidth: foot.scrollWidth, footClientWidth: foot.clientWidth,
          };
        }""")
        report['measurements']['thumb390'] = measurements
        assert measurements['primaryHeight'] >= 52, measurements
        assert measurements['primaryTop'] >= 0, measurements
        assert measurements['primaryBottom'] <= measurements['viewportHeight'], measurements
        assert measurements['primaryLeft'] >= 0 and measurements['primaryRight'] <= measurements['viewportWidth'], measurements
        assert measurements['primaryCenterY'] >= measurements['viewportHeight'] * 0.6, measurements
        assert measurements['footScrollWidth'] <= measurements['footClientWidth'], measurements
        capture('request-dialog-390.png')
        return measurements
    run_assertion('phone-390-thumb-zone-primary', phone_390_thumb_zone)

    def phone_320_no_overflow():
        ensure_closed()
        page.set_viewport_size({'width': 320, 'height': 568})
        open_via_trigger()
        measurements = page.evaluate("""() => {
          const doc = document.documentElement;
          const dialog = document.getElementById('request-work-dialog');
          return {
            viewportWidth: window.innerWidth,
            documentScrollWidth: doc.scrollWidth,
            dialogScrollWidth: dialog.scrollWidth,
            dialogClientWidth: dialog.clientWidth,
          };
        }""")
        report['measurements']['overflow320'] = measurements
        assert measurements['documentScrollWidth'] <= 320, measurements
        assert measurements['dialogScrollWidth'] <= measurements['dialogClientWidth'], measurements
        capture('request-dialog-320.png')
        return measurements
    run_assertion('phone-320-no-horizontal-overflow', phone_320_no_overflow)

    # 4b. Compact phone entry (step-9 phone header): a pinned 56px
    #     title/trigger header is the closed phone entry at 390 and 320 while
    #     the stacked rail stays reachable below it.
    def phone_header_hidden_desktop():
        ensure_closed()
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.goto(url + '/#/specs?ws=fixture', wait_until='domcontentloaded')
        display = page.evaluate("() => getComputedStyle(document.querySelector('.phone-head')).display")
        assert display == 'none', display
        return {'display': display}
    run_assertion('phone-header-hidden-desktop', phone_header_hidden_desktop)

    def phone_compact_entry(width, height, name):
        ensure_closed()
        page.set_viewport_size({'width': width, 'height': height})
        page.goto(url + '/#/specs?ws=fixture', wait_until='domcontentloaded')
        measurements = page.evaluate("""() => {
          const head = document.querySelector('.phone-head');
          const headBox = head.getBoundingClientRect();
          const trigger = document.getElementById('request-work-phone-trigger');
          const triggerBox = trigger.getBoundingClientRect();
          const rail = document.querySelector('.rail').getBoundingClientRect();
          return {
            headPosition: getComputedStyle(head).position,
            headTop: headBox.top, headHeight: headBox.height, headBottom: headBox.bottom,
            triggerVisible: triggerBox.width > 0 && triggerBox.height > 0,
            triggerHeight: triggerBox.height, triggerWidth: triggerBox.width,
            railTop: rail.top, railHeight: rail.height,
            viewportWidth: window.innerWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
          };
        }""")
        report['measurements'][f'entry{width}'] = measurements
        assert measurements['headPosition'] == 'fixed', measurements
        assert measurements['headTop'] == 0, measurements
        assert measurements['headHeight'] == 56, measurements
        assert measurements['triggerVisible'], measurements
        assert measurements['triggerHeight'] >= 44, measurements
        assert measurements['railHeight'] > 0, measurements
        assert measurements['railTop'] >= measurements['headBottom'], measurements
        assert measurements['documentScrollWidth'] <= measurements['viewportWidth'], measurements
        capture(name)
        return measurements
    run_assertion('phone-compact-entry-390', lambda: phone_compact_entry(390, 900, 'request-entry-closed-390.png'))
    run_assertion('phone-compact-entry-320', lambda: phone_compact_entry(320, 568, 'request-entry-closed-320.png'))

    # 4c. The open sheet sits below the pinned header, opened from the phone
    #     entry trigger, and Escape returns focus to that trigger.
    def phone_sheet_below_header(width, height, name):
        ensure_closed()
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('#request-work-phone-trigger').click()
        expect(page.locator('#request-work-dialog')).to_be_visible()
        measurements = page.evaluate("""() => {
          const head = document.querySelector('.phone-head').getBoundingClientRect();
          const dialog = document.getElementById('request-work-dialog').getBoundingClientRect();
          return {
            headTop: head.top, headBottom: head.bottom, headHeight: head.height,
            dialogTop: dialog.top, dialogBottom: dialog.bottom,
            viewportHeight: window.innerHeight, viewportWidth: window.innerWidth,
          };
        }""")
        report['measurements'][f'sheet{width}'] = measurements
        assert measurements['headTop'] == 0 and measurements['headHeight'] == 56, measurements
        assert measurements['dialogTop'] >= measurements['headBottom'], measurements
        assert abs(measurements['dialogBottom'] - measurements['viewportHeight']) <= 1, measurements
        capture(name)
        return measurements
    run_assertion('phone-sheet-below-header-390', lambda: phone_sheet_below_header(390, 900, 'request-sheet-below-390.png'))
    run_assertion('phone-sheet-below-header-320', lambda: phone_sheet_below_header(320, 568, 'request-sheet-below-320.png'))

    def phone_escape_returns_focus():
        assert dialog_open(), 'dialog was not open for the phone Escape proof'
        page.keyboard.press('Escape')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        expect(page.locator('#request-work-phone-trigger')).to_be_focused()
        return {'activeElement': active_id()}
    run_assertion('phone-escape-returns-focus-to-phone-trigger', phone_escape_returns_focus)

    # 5. The default fixture flags never changed; the run also stays clean of
    #    uncaught page errors.
    def no_page_errors():
        assert not report['pageErrors'], report['pageErrors']
        return {'pageErrors': len(report['pageErrors'])}
    run_assertion('no-page-errors', no_page_errors)


def run_scope(url):
    """Focused removal interaction on a selected spec entity (F1 proof)."""
    def capture(name):
        path = browser_evidence / name
        page.screenshot(path=str(path))
        report['captures'].append(str(path))
        return str(path)

    def dialog_open():
        return page.evaluate(
            "() => { const d = document.getElementById('request-work-dialog'); return Boolean(d && d.open); }")

    def ensure_closed():
        if dialog_open():
            page.keyboard.press('Escape')
            expect(page.locator('#request-work-dialog')).not_to_be_visible()

    def chip_text():
        return page.locator('#request-work-dialog .cmd-context').inner_text()

    def removal_fallback(width, height, trigger, name_prefix):
        ensure_closed()
        page.set_viewport_size({'width': width, 'height': height})
        page.goto(url + '/#/specs?ws=fixture&id=browser', wait_until='domcontentloaded')
        page.locator(trigger).click()
        expect(page.locator('#request-work-dialog')).to_be_visible()
        # The route's selected spec entity is the displayed context.
        expect(page.locator('#request-work-dialog .cmd-context')).to_contain_text('browser')
        expect(page.locator('#request-work-dialog .cmd-context')).to_contain_text('Spec')
        if width == 1280:
            capture('request-scope-entity-1280.png')
        # Remove context falls back to the workspace scope of the same entry.
        page.locator('#request-work-dialog button[aria-label="Remove context"]').click()
        expect(page.locator('#request-work-dialog .cmd-context')).to_contain_text('Browser fixture')
        expect(page.locator('#request-work-dialog .cmd-context')).to_contain_text('Workspace')
        text = chip_text()
        assert 'Spec' not in text and 'browser' not in text, text
        capture(f'{name_prefix}-removed-{width}.png')
        # The removal survives close/reopen on the same route: reopening must
        # not re-derive the removed entity.
        page.keyboard.press('Escape')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        page.locator(trigger).click()
        expect(page.locator('#request-work-dialog')).to_be_visible()
        text = chip_text()
        assert 'Browser fixture' in text and 'Workspace' in text, text
        assert 'Spec' not in text and 'browser' not in text, text
        if width == 1280:
            capture('request-scope-removed-reopen-1280.png')
        page.keyboard.press('Escape')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        return {'width': width, 'chip': text}

    run_assertion('remove-context-workspace-fallback-1280',
                  lambda: removal_fallback(1280, 900, '.page-head #request-work-trigger', 'request-scope'))
    run_assertion('remove-context-workspace-fallback-390',
                  lambda: removal_fallback(390, 900, '#request-work-phone-trigger', 'request-scope'))

    def no_page_errors():
        assert not report['pageErrors'], report['pageErrors']
        return {'pageErrors': len(report['pageErrors'])}
    run_assertion('no-page-errors', no_page_errors)


# Client-side media seam: fake ONLY navigator.mediaDevices.getUserMedia with a
# real oscillator -> MediaStreamAudioDestinationNode stream, and expose the
# granted stream on window for the cancellation assertions. Everything else
# (the built App, capture pipeline, store and HTTP routes) stays real.
MEDIA_FIXTURE_SCRIPT = r'''
(() => {
  window.__fixtureRequestStreams = [];
  window.__fixtureMic = 'grant';
  const granted = async () => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 440;
    const gain = context.createGain();
    gain.gain.value = 0.25;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    try { await context.resume(); } catch (error) { /* the launch flag permits audio */ }
    window.__fixtureRequestStreams.push(destination.stream);
    window.__fixtureRequestContext = context;
    window.__fixtureRequestOscillator = oscillator;
    return destination.stream;
  };
  const install = () => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = () => window.__fixtureMic === 'deny'
      ? Promise.reject(Object.assign(new Error('fixture microphone denied'), {name: 'NotAllowedError'}))
      : granted();
  };
  install();
})();
'''


def fixture_control(url, action, value=''):
    """Drive the owned fixture's scenario seam and return its JSON reply."""
    query = urllib.parse.urlencode({'action': action, 'value': value})
    with urllib.request.urlopen(f'{url}/__fixture/control?{query}', timeout=15) as response:
        return json.loads(response.read())


def watch_request_bodies(network):
    """Collect request-route traffic with body digests and interpret ids."""
    def handler(request):
        if '/api/request/' not in request.url:
            return
        body = request.post_data_buffer
        item = {'method': request.method, 'url': request.url}
        if body is not None:
            item['bytes'] = len(body)
            item['sha256'] = hashlib.sha256(body).hexdigest()
            if '/api/request/interpret' in request.url:
                try:
                    item['requestId'] = json.loads(body.decode('utf-8')).get('request_id')
                except Exception:
                    pass
        network.append(item)
    page.on('request', handler)


def run_spoken_plan(url):
    """Real oscillator capture through the built store and request routes."""
    network = []
    watch_request_bodies(network)
    expected_text = 'spoken request fixture text for the request work plan'

    def capture(name):
        path = browser_evidence / name
        page.screenshot(path=str(path))
        report['captures'].append(str(path))
        return str(path)

    def dialog_open():
        return page.evaluate(
            "() => { const d = document.getElementById('request-work-dialog'); return Boolean(d && d.open); }")

    def ensure_closed():
        if dialog_open():
            page.keyboard.press('Escape')
            expect(page.locator('#request-work-dialog')).not_to_be_visible()

    def field():
        return page.locator('#request-work-dialog #request-work-text')

    def foot_button(label):
        return page.locator('#request-work-dialog .cmd-foot').get_by_role('button', name=label, exact=True)

    def open_panel():
        ensure_closed()
        page.locator('.page-head #request-work-trigger').click()
        expect(page.locator('#request-work-dialog')).to_be_visible()

    def recording_readout():
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.goto(url + '/#/specs?ws=fixture&id=browser', wait_until='domcontentloaded')
        # Fresh document + store even when the previous case left the same URL.
        page.reload(wait_until='domcontentloaded')
        open_panel()
        start = page.locator('#request-work-dialog #request-work-start')
        expect(start).to_be_enabled()
        assert not page.locator('#request-work-dialog .rec-live').is_visible()
        start.click()
        expect(page.locator('#request-work-dialog .rec-live')).to_be_visible()
        expect(page.locator('#request-work-dialog .rec-label')).to_have_text('Recording')
        assert page.locator('#request-work-dialog .rec-dot').is_visible()
        clock = page.locator('#request-work-dialog .rec-clock').inner_text()
        assert re.fullmatch(r'0:0\d of 0:30', clock), clock
        assert page.locator('#request-work-dialog .rec-levels span').count() == 8
        live_regions = page.locator('#request-work-dialog [aria-live="polite"]').count()
        assert live_regions == 1, live_regions
        tracks = page.evaluate("() => (window.__fixtureRequestStreams || []).map(stream => stream.getTracks().map(track => track.readyState))")
        assert tracks and all(state == 'live' for group in tracks for state in group), tracks
        capture('request-spoken-recording-1280.png')
        page.set_viewport_size({'width': 390, 'height': 900})
        capture('request-spoken-recording-390.png')
        page.set_viewport_size({'width': 1280, 'height': 900})
        return {'clock': clock, 'tracks': tracks}
    run_assertion('spoken-plan-recording-readout', recording_readout)

    def cancellation_release():
        assert page.locator('#request-work-dialog .rec-live').is_visible()
        foot_button('Cancel recording').click()
        expect(page.locator('#request-work-dialog .rec-live')).not_to_be_visible()
        expect(page.locator('#request-work-dialog #request-work-start')).to_be_visible()
        states = page.evaluate("() => ((window.__fixtureRequestStreams || []).slice(-1)[0] || {getTracks: () => []}).getTracks().map(track => track.readyState)")
        assert states and all(state == 'ended' for state in states), states
        assert not [item for item in network if '/api/request/transcribe' in item['url']], network
        value = field().input_value()
        assert value == '', {'value': value}
        capture('request-spoken-cancelled-1280.png')
        return {'tracks': states}
    run_assertion('spoken-plan-cancel-stops-tracks-and-discards', cancellation_release)

    held_interpret_routes = []

    def hold_interpret(route, request):
        # Hold the automatic interpret response so the transcript-installed
        # capture is deterministic instead of racing the pipeline's interpret
        # stage; the route is released right after the capture.
        held_interpret_routes.append(route)

    def stop_transcribes_and_installs():
        page.route('**/api/request/interpret', hold_interpret)
        try:
            foot_button('Start recording').click()
            expect(page.locator('#request-work-dialog .rec-live')).to_be_visible()
            page.wait_for_timeout(700)
            assert not [item for item in network if '/api/request/interpret' in item['url']], network
            foot_button('Stop recording').click()
            expect(page.locator('#request-work-dialog .req-notice').first).to_contain_text('Transcribing')
            expect(field()).to_have_value(expected_text, timeout=20000)
            expect(field()).to_be_editable()
            capture('request-spoken-transcript-1280.png')
            page.set_viewport_size({'width': 390, 'height': 900})
            capture('request-spoken-transcript-390.png')
            page.set_viewport_size({'width': 1280, 'height': 900})
            return {'transcript': field().input_value()}
        finally:
            for route in held_interpret_routes:
                route.continue_()
            held_interpret_routes.clear()
            page.unroute('**/api/request/interpret', hold_interpret)
    run_assertion('spoken-plan-stop-transcribes-to-editable-text', stop_transcribes_and_installs)

    def interpreted_result():
        expect(page.locator('#request-work-dialog')).to_contain_text('Request interpreted.', timeout=20000)
        interpret_requests = [item for item in network if '/api/request/interpret' in item['url']]
        assert interpret_requests, network
        assert page.locator('#request-work-dialog .cmd-foot').get_by_role('button', name='Plan epic', exact=True).is_disabled()
        capture('request-spoken-result-1280.png')
        return {'interpretRequests': len(interpret_requests)}
    run_assertion('spoken-plan-interpreted-result', interpreted_result)

    def transcript_editable():
        edited = expected_text + ' Add a typed clarification.'
        field().fill(edited)
        expect(field()).to_have_value(edited)
        return {'value': field().input_value()}
    run_assertion('spoken-plan-transcript-editable', transcript_editable)

    def limit_waits_for_interpretation():
        # Fresh document and request store. The real client 30 s capture limit
        # auto-stops the oscillator recording and auto-transcribes; the case
        # then proves the limit path waits for the explicit Interpret request.
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.goto(url + '/#/specs?ws=fixture&id=browser', wait_until='domcontentloaded')
        page.reload(wait_until='domcontentloaded')
        open_panel()
        expect(page.locator('#request-work-dialog #request-work-start')).to_be_enabled()
        limit_marker = len(network)
        page.locator('#request-work-dialog #request-work-start').click()
        expect(page.locator('#request-work-dialog .rec-live')).to_be_visible()
        # Real 30 s capture limit + transcribe round-trip.
        expect(field()).to_have_value(expected_text, timeout=45000)
        # (a) The limit path auto-transcribes only: no interpret POST happened
        # in this sub-journey before the explicit action.
        interpret_waiting = [item for item in network[limit_marker:] if '/api/request/interpret' in item['url']]
        assert interpret_waiting == [], interpret_waiting
        # (b) The spoken text is installed and editable.
        assert field().input_value() == expected_text
        expect(field()).to_be_editable()
        # (c) The limit install puts focus and the caret at the transcript end.
        expect(field()).to_be_focused()
        caret = page.evaluate("() => { const f = document.getElementById('request-work-text'); return {start: f.selectionStart, end: f.selectionEnd, length: f.value.length}; }")
        assert caret['start'] == caret['length'] and caret['end'] == caret['length'], caret
        # Waiting-for-interpret moment, before the explicit action.
        capture('request-spoken-limit-1280.png')
        page.set_viewport_size({'width': 390, 'height': 900})
        capture('request-spoken-limit-390.png')
        page.set_viewport_size({'width': 1280, 'height': 900})
        with page.expect_request(lambda request: '/api/request/interpret' in request.url) as captured:
            foot_button('Interpret request').click()
        assert captured.value
        interpret_after = [item for item in network[limit_marker:] if '/api/request/interpret' in item['url']]
        assert len(interpret_after) == 1, interpret_after
        expect(page.locator('#request-work-dialog')).to_contain_text('Request interpreted.', timeout=20000)
        return {'interpretBefore': 0, 'interpretAfter': len(interpret_after), 'caret': caret}
    run_assertion('spoken-plan-limit-waits-for-interpretation', limit_waits_for_interpretation)

    report['measurements']['spokenPlanLimitPath'] = {
        'driven': 'limit+manual-stop',
        'reason': ('The real client 30 s capture limit auto-stops and auto-transcribes the '
                   'oscillator recording; the case waits for the transcript, proves the caret '
                   'lands at its end and that the explicit Interpret request is the first '
                   'interpret POST in the sub-journey. The manual Stop sub-journey covers the '
                   'ordinary transcribe-then-interpret pipeline and its editable transcript.'),
    }

    def no_page_errors():
        assert not report['pageErrors'], report['pageErrors']
        return {'pageErrors': len(report['pageErrors'])}
    run_assertion('no-page-errors', no_page_errors)


def run_input_failures(url):
    """Four named recovery journeys over the real request routes."""
    network = []
    watch_request_bodies(network)

    def capture(name):
        path = browser_evidence / name
        page.screenshot(path=str(path))
        report['captures'].append(str(path))
        return str(path)

    def field():
        return page.locator('#request-work-dialog #request-work-text')

    def foot_button(label):
        return page.locator('#request-work-dialog .cmd-foot').get_by_role('button', name=label, exact=True)

    def failure_notice():
        return page.locator('#request-work-dialog #request-work-failure')

    def dialog_open():
        return page.evaluate(
            "() => { const d = document.getElementById('request-work-dialog'); return Boolean(d && d.open); }")

    def ensure_closed():
        if dialog_open():
            page.keyboard.press('Escape')
            expect(page.locator('#request-work-dialog')).not_to_be_visible()
            expect(page.locator('.page-head #request-work-trigger')).to_be_focused()

    def open_fresh():
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.goto(url + '/#/specs?ws=fixture&id=browser', wait_until='domcontentloaded')
        # A same-URL hash goto can stay same-document, leaving the prior
        # journey's dialog open and its request store populated. Force a real
        # document reload so each sub-journey starts from a fresh App + store.
        page.reload(wait_until='domcontentloaded')
        ensure_closed()
        page.locator('.page-head #request-work-trigger').click()
        expect(page.locator('#request-work-dialog')).to_be_visible()

    def scenario(value):
        reply = fixture_control(url, 'request-scenario', value)
        assert reply.get('requestFixture', {}).get('scenario') == value, reply

    def mic_denied():
        scenario('happy')
        open_fresh()
        page.evaluate("() => { window.__fixtureMic = 'deny'; }")
        typed = 'Keep this typed request through the microphone failure.'
        field().fill(typed)
        foot_button('Start recording').click()
        expect(failure_notice()).to_be_visible()
        notice = failure_notice().inner_text().lower()
        assert 'microphone' in notice, notice
        assert field().input_value() == typed
        foot = page.locator('#request-work-dialog .cmd-foot').inner_text()
        assert 'Recording needs microphone access.' in foot, foot
        assert foot_button('Start recording').is_visible()
        capture('request-input-mic-denied-1280.png')
        page.set_viewport_size({'width': 390, 'height': 900})
        capture('request-input-mic-denied-390.png')
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.evaluate("() => { window.__fixtureMic = 'grant'; }")
        return {'retained': typed}
    run_assertion('input-failures-mic-denied-retains-typed-input', mic_denied)

    def speech_unavailable():
        scenario('speech-unavailable')
        open_fresh()
        expect(failure_notice()).to_be_visible()
        notice = failure_notice().inner_text().lower()
        assert 'speech model' in notice, notice
        expect(page.locator('#request-work-dialog #request-work-start')).to_be_disabled()
        foot = page.locator('#request-work-dialog .cmd-foot').inner_text()
        assert 'speech model is prepared' in foot, foot
        typed = 'Typing still works without recording.'
        field().fill(typed)
        expect(field()).to_have_value(typed)
        capture('request-input-speech-unavailable-1280.png')
        scenario('happy')
        return {'notice': notice}
    run_assertion('input-failures-speech-unavailable-disables-recording', speech_unavailable)

    def transcription_failure():
        scenario('transcribe-failed')
        open_fresh()
        typed = 'Typed bytes survive the failed clip.'
        field().fill(typed)
        foot_button('Start recording').click()
        expect(page.locator('#request-work-dialog .rec-live')).to_be_visible()
        page.wait_for_timeout(700)
        foot_button('Stop recording').click()
        expect(failure_notice()).to_be_visible(timeout=20000)
        notice = failure_notice().inner_text().lower()
        assert 'speech service' in notice, notice
        assert field().input_value() == typed
        first = [item for item in network if '/api/request/transcribe' in item['url']]
        assert len(first) == 1, first
        with page.expect_request(lambda request: '/api/request/transcribe' in request.url) as captured:
            foot_button('Retry transcription').click()
        retried_body = captured.value.post_data_buffer
        assert retried_body is not None
        first_id = urllib.parse.parse_qs(urllib.parse.urlparse(first[0]['url']).query)['request_id'][0]
        second_id = urllib.parse.parse_qs(urllib.parse.urlparse(captured.value.url).query)['request_id'][0]
        assert first_id == second_id, (first_id, second_id)
        assert first[0]['sha256'] == hashlib.sha256(retried_body).hexdigest(), 'retry bytes differ'
        assert first[0]['bytes'] == len(retried_body)
        expect(page.locator('#request-work-dialog')).to_contain_text('Retry transcription')
        assert field().input_value() == typed
        capture('request-input-transcription-failed-1280.png')
        scenario('happy')
        return {'requestId': first_id, 'bytes': len(retried_body)}
    run_assertion('input-failures-transcription-retry-identical-bytes', transcription_failure)

    def interpretation_failure_and_offline():
        scenario('interpret-failed')
        open_fresh()
        typed = 'Interpret this typed request and keep it.'
        field().fill(typed)
        foot_button('Interpret request').click()
        expect(failure_notice()).to_be_visible()
        notice = failure_notice().inner_text().lower()
        assert 'interpretation model' in notice, notice
        assert field().input_value() == typed
        first = [item for item in network if '/api/request/interpret' in item['url']]
        assert len(first) == 1 and first[0].get('requestId'), first
        first_id = first[0]['requestId']
        with page.expect_request(lambda request: '/api/request/interpret' in request.url) as captured:
            foot_button('Retry interpretation').click()
        retried_body = captured.value.post_data_buffer
        assert retried_body is not None
        retried = json.loads(retried_body.decode('utf-8'))
        assert retried.get('request_id') == first_id, (first_id, retried.get('request_id'))
        assert retried.get('transcript') == typed, retried.get('transcript')
        expect(failure_notice()).to_be_visible()
        assert field().input_value() == typed
        scenario('interpret-offline')
        with page.expect_request(lambda request: '/api/request/interpret' in request.url) as offline_captured:
            foot_button('Retry interpretation').click()
        offline_body = offline_captured.value.post_data_buffer
        assert offline_body is not None
        offline = json.loads(offline_body.decode('utf-8'))
        assert offline.get('request_id') == first_id, (first_id, offline.get('request_id'))
        expect(failure_notice()).to_contain_text('Reconnecting', timeout=20000)
        assert field().input_value() == typed
        assert foot_button('Retry connection').is_visible()
        assert foot_button('Retry connection').is_enabled()
        capture('request-input-offline-1280.png')
        page.set_viewport_size({'width': 390, 'height': 900})
        capture('request-input-offline-390.png')
        page.set_viewport_size({'width': 1280, 'height': 900})
        scenario('happy')
        return {'requestId': first_id}
    run_assertion('input-failures-interpretation-retry-identity-and-offline', interpretation_failure_and_offline)

    report['measurements']['inputFailureScenarios'] = {
        'control': 'GET /__fixture/control?action=request-scenario&value=<happy|speech-unavailable|transcribe-failed|interpret-failed|interpret-offline>',
        'scenarios': ['happy', 'speech-unavailable', 'transcribe-failed', 'interpret-failed', 'interpret-offline'],
    }

    def no_page_errors():
        assert not report['pageErrors'], report['pageErrors']
        return {'pageErrors': len(report['pageErrors'])}
    run_assertion('no-page-errors', no_page_errors)


try:
    # Request fixture mode composes the real request routes' final child
    # boundaries. Only the two new case sets need it; entry/scope runs keep the
    # fixture's default flags because the env gate stays off for them.
    fixture_env = {**os.environ}
    if any(name in ('spoken-plan', 'input-failures') for name in cases):
        fixture_env['SENTINEL_REQUEST_FIXTURE'] = '1'
    fixture = subprocess.Popen(
        ['node', str(root / 'browser-fixture.mjs')],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True,
        env=fixture_env,
    )
    fixture_pgid = os.getpgid(fixture.pid)
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture readiness exceeded 10 seconds')
    fixture_info = json.loads(fixture.stdout.readline())
    observed_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=checkout, text=True).strip())
    with sync_playwright() as p:
        try:
            executable = shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': executable} if executable else {}), headless=True,
                                        args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            context = browser.new_context(viewport={'width': 1280, 'height': 900}, device_scale_factor=1)
            if any(name in ('spoken-plan', 'input-failures') for name in cases):
                context.add_init_script(script=MEDIA_FIXTURE_SCRIPT)
            startup_seconds = round(time.monotonic() - started, 3)
            for case_name in cases:
                report = fresh_report(case_name)
                receipt_path = browser_evidence / f'request-browser-{case_name}.json'
                report['fixture'] = fixture_info
                report['observedCommit'] = observed_commit
                report['dirty'] = dirty
                case_started = time.monotonic()
                case_receipts.append((receipt_path, report))
                page = context.new_page()
                page.on('pageerror', lambda error, current=report: current['pageErrors'].append(str(error)))
                page.on('console', lambda message, current=report: current['consoleErrors'].append(message.text) if message.type == 'error' else None)
                page.on('requestfailed', lambda request, current=report: current['requestFailures'].append(
                    {'method': request.method, 'url': request.url, 'failure': str(request.failure)}))
                if case_name == 'entry':
                    run_entry(fixture_info['url'], fixture_info['thread1'])
                elif case_name == 'scope':
                    run_scope(fixture_info['url'])
                elif case_name == 'spoken-plan':
                    run_spoken_plan(fixture_info['url'])
                else:
                    run_input_failures(fixture_info['url'])
                if reference_html:
                    run_assertion('reference-captures', capture_reference)
                report['status'] = ('passed' if report['assertions']
                                    and all(a['status'] == 'passed' for a in report['assertions'])
                                    else 'failed')
                report['checkSeconds'] = round(time.monotonic() - case_started, 3)
                report['elapsedSeconds'] = round(time.monotonic() - started, 3)
                page.close()
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
        try:
            if fixture.poll() is None:
                fixture.terminate()
                try:
                    fixture.wait(timeout=10)
                    cleanup['fixtureTerminated'] = True
                except subprocess.TimeoutExpired:
                    cleanup['errors'].append('fixture did not exit on SIGTERM within 10 seconds')
            else:
                cleanup['fixtureTerminated'] = True
        except Exception as error:
            cleanup['errors'].append(f'fixture terminate: {error}')
        # The checker owns the fixture server; kill its whole process tree so
        # no fixture-spawned process outlives the check.
        cleanup['fixtureTreeKilled'] = kill_fixture_tree()
        try:
            fixture.wait(timeout=5)
        except Exception:
            pass
    if fixture_info.get('root'):
        try:
            cleanup['temporaryFixtureRootRemoved'] = not Path(fixture_info['root']).exists()
            if not cleanup['temporaryFixtureRootRemoved']:
                cleanup['errors'].append(f"temporary fixture root still present: {fixture_info['root']}")
        except Exception as error:
            cleanup['errors'].append(f'temporary fixture root check: {error}')
    pairs = case_receipts or [(receipt_path, report)]
    for path, payload in pairs:
        payload['startupSeconds'] = startup_seconds
        payload.setdefault('checkSeconds', None)
        payload.setdefault('elapsedSeconds', round(finished - started, 3))
        payload['cleanup'] = cleanup
        write_receipt(path, payload)

failed = []
for path, payload in (case_receipts or [(receipt_path, report)]):
    print(json.dumps({
        'status': payload['status'],
        'case': payload['case'],
        'elapsed_seconds': payload.get('elapsedSeconds'),
        'assertions': [{'name': a['name'], 'status': a['status']} for a in payload['assertions']],
        'measurements': payload['measurements'],
        'console_errors': len(payload['consoleErrors']),
        'captures': payload['captures'],
        'receipt': str(path),
    }))
    if payload['status'] != 'passed':
        failed.append(payload['case'])
if failed:
    raise SystemExit(1)
