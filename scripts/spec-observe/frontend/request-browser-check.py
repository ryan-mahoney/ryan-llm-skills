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
the native #request-work-dialog focus lifecycle (open, Escape, Ctrl+J, Meta+J,
the labelled close button), the existing New thread modal blocking the request
shortcut, and the responsive sheet geometry at 320, 390 and 1280 widths. It
writes request-dialog-<width>.png captures and browser/request-browser-entry.json.
With --capture-reference it also serves the reference screen from the owned
loopback server and captures request-reference-<width>.png at the same widths.

The App, Shell, route owner and request-state are real; browser-fixture.mjs
fakes only the final service boundary with its default flags. The checker owns
its Playwright Chromium (no CDP), its fixture process and its temporary
storage, and removes them in finally.
"""
import argparse
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
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['entry'], default='entry')
parser.add_argument('--capture-reference', default=None)
options = parser.parse_args()
case = options.case
reference_html = Path(options.capture_reference).resolve() if options.capture_reference else None

root = Path(__file__).resolve().parent
checkout = root.parents[2]
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-request-evidence'))
browser_evidence = evidence / 'browser'
browser_evidence.mkdir(parents=True, exist_ok=True)
receipt_path = browser_evidence / f'request-browser-{case}.json'
started = time.monotonic()
startup_seconds = None
check_started = None
report = {
    'status': 'failed',
    'case': case,
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


def write_receipt():
    temporary = receipt_path.with_name(receipt_path.name + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    os.replace(temporary, receipt_path)


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
    def dialog_open_focuses_title():
        page.goto(url + '/#/specs', wait_until='domcontentloaded')
        ensure_closed()
        open_via_trigger()
        assert dialog_open(), 'dialog did not open'
        expect(page.locator('#request-work-title')).to_be_focused()
        return {'activeElement': active_id()}
    run_assertion('dialog-open-focuses-title', dialog_open_focuses_title)

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
        expect(page.locator('#request-work-title')).to_be_focused()
        page.keyboard.press('Control+j')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        assert not dialog_open(), 'second Ctrl+J did not close the dialog'
        expect(page.locator('#request-work-trigger')).to_be_focused()
        return {'activeElement': active_id()}
    run_assertion('dialog-shortcut-ctrl-j-toggle', dialog_shortcut_ctrl_j_toggle)

    def dialog_shortcut_meta_j_toggle():
        ensure_closed()
        page.keyboard.press('Meta+j')
        expect(page.locator('#request-work-dialog')).to_be_visible()
        assert dialog_open(), 'Meta+J did not open the dialog'
        expect(page.locator('#request-work-title')).to_be_focused()
        page.keyboard.press('Meta+j')
        expect(page.locator('#request-work-dialog')).not_to_be_visible()
        assert not dialog_open(), 'second Meta+J did not close the dialog'
        expect(page.locator('#request-work-trigger')).to_be_focused()
        return {'activeElement': active_id()}
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

    # 5. The default fixture flags never changed; the run also stays clean of
    #    uncaught page errors.
    def no_page_errors():
        assert not report['pageErrors'], report['pageErrors']
        return {'pageErrors': len(report['pageErrors'])}
    run_assertion('no-page-errors', no_page_errors)


try:
    fixture = subprocess.Popen(
        ['node', str(root / 'browser-fixture.mjs')],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True,
    )
    fixture_pgid = os.getpgid(fixture.pid)
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
            run_entry(fixture_info['url'], fixture_info['thread1'])
            if reference_html:
                run_assertion('reference-captures', capture_reference)
            report['status'] = ('passed' if report['assertions']
                                and all(a['status'] == 'passed' for a in report['assertions'])
                                else 'failed')
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
    report['startupSeconds'] = startup_seconds
    report['checkSeconds'] = None if check_started is None else round(finished - check_started, 3)
    report['elapsedSeconds'] = round(finished - started, 3)
    report['cleanup'] = cleanup
    write_receipt()

print(json.dumps({
    'status': report['status'],
    'elapsed_seconds': report['elapsedSeconds'],
    'assertions': [{'name': a['name'], 'status': a['status']} for a in report['assertions']],
    'measurements': report['measurements'],
    'console_errors': len(report['consoleErrors']),
    'captures': report['captures'],
    'receipt': str(receipt_path),
}))
if report['status'] != 'passed':
    raise SystemExit(1)
