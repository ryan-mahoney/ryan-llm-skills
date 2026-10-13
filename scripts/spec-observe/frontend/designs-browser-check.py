# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused Designs EV-3/EV-4 checks: real App/adapter/API with seeded temporary design packages.

After npm run build --prefix scripts/spec-observe/frontend:
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case journey \
  --capture-reference /path/to/designs/app-ui/screens/08-designs.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case unproduced \
  --capture-reference /path/to/designs/app-ui/screens/26-design-screen-unproduced.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case empty \
  --capture-reference /path/to/designs/app-ui/screens/76-designs-empty.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case loading \
  --capture-reference /path/to/designs/app-ui/screens/77-designs-loading.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case error \
  --capture-reference /path/to/designs/app-ui/screens/78-designs-error.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case partial \
  --capture-reference /path/to/designs/app-ui/screens/79-designs-partial.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case unavailable \
  --capture-reference /path/to/designs/app-ui/screens/80-designs-unavailable.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case offline \
  --capture-reference /path/to/designs/app-ui/screens/81-designs-offline.html
SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 180s uv run --script \
  scripts/spec-observe/frontend/designs-browser-check.py --case stale \
  --capture-reference /path/to/designs/app-ui/screens/82-designs-stale.html

Only the temporary fixture storage, one final index HTTP delay, and the imported
snapshot are substituted; App, route, adapters, /api/workspace-designs and the
workspace-view reader are real. The checker owns its Playwright Chromium (no CDP)
and its reference loopback static server, and removes both plus the fixture in
finally. It carries the two Design assertion blocks migrated out of
browser-check.py: the Workspaces Designs entry and the step/width/Next/Previous
selection journey.
"""
import argparse
import base64
import json
import os
import re
import select
import shutil
import subprocess
import threading
import time
import traceback
from datetime import datetime, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['journey', 'unproduced', 'empty', 'loading', 'error', 'partial', 'unavailable', 'offline', 'stale'], default='journey')
parser.add_argument('--capture-reference', default=None)
options = parser.parse_args()
case = options.case
reference_html = Path(options.capture_reference).resolve() if options.capture_reference else None

root = Path(__file__).resolve().parent
checkout = root.parents[2]
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-designs-evidence'))
browser_evidence = evidence / 'browser'
browser_evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
startup_seconds = None
check_started = None
report = {
    'status': 'failed',
    'case': case,
    'scenarios': [],
    'captures': [],
    'pageErrors': [],
    'consoleErrors': [],
    'requestFailures': [],
    'expectedFailures': [],
    'fixture': {},
    'seededDesigns': {},
    'transferredCoverage': [
        'browser-check.py 633-637: Workspaces Designs entry into the real adapter/API',
        'browser-check.py 715-723: design screen step, width and Next/Previous selection',
    ],
    'observedCommit': None,
    'dirty': None,
    'cleanup': {},
}
fixture = None
reference_server = None
browser = None
context = None
receipt = {}
cleanup = {'fixtureTerminated': False, 'browserClosed': False, 'referenceServerStopped': False,
           'temporaryFixtureRootRemoved': None, 'errors': []}

PNG_1X1 = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)
MARKER_JS = """(function () {
  var count = 1;
  try { count = Number(window.name || '0') + 1; window.name = String(count); } catch (error) { count = 1; }
  document.documentElement.dataset.marker = '42';
  document.documentElement.dataset.lifetime = String(count);
  document.documentElement.dataset.nonce = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
})();
"""
SCREEN_CSS = (
    'body { margin: 0; padding: 24px; background-color: rgb(250, 250, 245); color: rgb(24, 28, 36); '
    'font-family: system-ui, sans-serif; }\n'
    'h1 { color: rgb(37, 99, 235); }\n'
    'a.sibling { color: rgb(21, 128, 61); font-weight: 600; }\n'
    '.marker-copy { color: rgb(71, 85, 105); }\n'
)


def screen_html(title, heading, sibling=None):
    link = f'<a class="sibling" href="{sibling}">Sibling screen</a>' if sibling else ''
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        f'<title>{title}</title><link rel="stylesheet" href="../screen.css">'
        '<script src="../marker.js"></script></head>'
        f'<body><h1>{heading}</h1><p class="marker-copy">relative resources loaded</p>{link}</body></html>'
    )


def seed_designs(storage):
    fixture_root = storage / 'projects' / 'fixture' / 'designs'
    other_root = storage / 'projects' / 'other' / 'designs'
    demo = fixture_root / 'demo'
    (demo / 'screens').mkdir(parents=True, exist_ok=True)
    (demo / 'captures').mkdir(parents=True, exist_ok=True)
    (demo / 'marker.js').write_text(MARKER_JS)
    (demo / 'screen.css').write_text(SCREEN_CSS)
    demo_first = screen_html('Demo screen one', 'Marker screen one', '02-screen-2.html')
    demo_second = screen_html('Demo screen two', 'Marker screen two')
    (demo / 'screens' / '01-screen-1.html').write_text(demo_first)
    (demo / 'screens' / '02-screen-2.html').write_text(demo_second)
    for width in (1280, 1600):
        (demo / 'captures' / f'01-screen-1@{width}.png').write_bytes(PNG_1X1)
    demo_record = {
        'schema_version': 1,
        'design': 'demo',
        'title': 'Design fixture',
        'brief': 'brief.md',
        'note': 'Fixture index for the Designs journey.',
        'viewport': {'posture': 'responsive', 'widths': [1280, 1600]},
        'screens': [
            {'step': 1, 'id': 'screen-1', 'title': 'Screen one', 'person': 'Operator',
             'job': 'Choose the first fixture screen', 'kind': 'decision', 'state': 'ideal',
             'primary_action': 'Open first screen', 'notes': 'First screen note.'},
            {'step': 2, 'id': 'screen-2', 'title': 'Screen two', 'person': 'Operator',
             'job': 'Review the second fixture screen', 'kind': 'action', 'state': 'ideal',
             'primary_action': 'Open second screen', 'notes': 'Second screen note.'},
        ],
        'deviations': [{'screen': 1, 'token': '--ds-accent', 'from': '#4f46e5', 'to': '#6366f1',
                        'reason': 'Fixture departure for the compact disclosure.'}],
    }
    (demo / 'design.json').write_text(json.dumps(demo_record))

    second = fixture_root / 'second'
    (second / 'screens').mkdir(parents=True, exist_ok=True)
    (second / 'marker.js').write_text(MARKER_JS)
    (second / 'screen.css').write_text(SCREEN_CSS)
    (second / 'screens' / '01-wide-shot.html').write_text(screen_html('Alternate wide shot', 'Alternate wide screen'))
    second_record = {
        'schema_version': 1,
        'design': 'second',
        'title': 'Alternate fixture',
        'viewport': {'posture': 'responsive', 'widths': [1200, 1440]},
        'screens': [{'step': 1, 'id': 'wide-shot', 'title': 'Wide shot', 'person': 'Operator',
                     'job': 'Prove selection resets path and width', 'kind': 'action', 'state': 'ideal',
                     'primary_action': 'Open wide shot'}],
    }
    (second / 'design.json').write_text(json.dumps(second_record))

    other = other_root / 'other-demo'
    other_record = {
        'schema_version': 1,
        'design': 'other-demo',
        'title': 'Other fixture',
        'viewport': {'posture': 'desktop-only', 'widths': [1280]},
        'screens': [{'step': 1, 'id': 'other-screen', 'title': 'Other screen', 'person': 'Operator',
                     'job': 'Prove workspace scope isolation', 'kind': 'action', 'state': 'ideal'}],
    }
    if case != 'empty':
        (other / 'screens').mkdir(parents=True, exist_ok=True)
        (other / 'marker.js').write_text(MARKER_JS)
        (other / 'screen.css').write_text(SCREEN_CSS)
        (other / 'screens' / '01-other-screen.html').write_text(screen_html('Other screen', 'Other workspace screen'))
        (other / 'design.json').write_text(json.dumps(other_record))
    seeded = {
        'fixture/demo': demo_record,
        'fixture/second': second_record,
        'other/other-demo': other_record if case != 'empty' else 'absent (empty case: other workspace has no designs directory)',
        'markerScriptSource': MARKER_JS,
        'screenCssSource': SCREEN_CSS,
        'screenHtmlSources': {'01-screen-1.html': demo_first, '02-screen-2.html': demo_second},
        'files': [
            'fixture/designs/demo/design.json', 'fixture/designs/demo/screens/01-screen-1.html',
            'fixture/designs/demo/screens/02-screen-2.html', 'fixture/designs/demo/marker.js',
            'fixture/designs/demo/screen.css', 'fixture/designs/demo/captures/01-screen-1@1280.png',
            'fixture/designs/demo/captures/01-screen-1@1600.png', 'fixture/designs/second/design.json',
            'fixture/designs/second/screens/01-wide-shot.html',
        ] + ([] if case == 'empty' else [
            'other/designs/other-demo/design.json', 'other/designs/other-demo/screens/01-other-screen.html',
        ]),
    }
    if case == 'unproduced':
        # Planned-screen branch fixtures: one produced step to enter from, one
        # planned step with a real capture but no HTML, plus missing/unsafe briefs.
        planned = fixture_root / 'planned'
        (planned / 'screens').mkdir(parents=True, exist_ok=True)
        (planned / 'captures').mkdir(parents=True, exist_ok=True)
        (planned / 'marker.js').write_text(MARKER_JS)
        (planned / 'screen.css').write_text(SCREEN_CSS)
        (planned / 'brief.md').write_text('# Planned fixture brief\n\nPlanned screen guidance.\n')
        (planned / 'screens' / '01-ready.html').write_text(screen_html('Ready screen', 'Produced ready screen'))
        (planned / 'captures' / '01-ready@1280.png').write_bytes(PNG_1X1)
        (planned / 'captures' / '02-kickoff@1280.png').write_bytes(PNG_1X1)
        planned_record = {
            'schema_version': 1,
            'design': 'planned',
            'title': 'Planned fixture',
            'brief': 'brief.md',
            'note': 'Fixture index for the planned-screen branch.',
            'viewport': {'posture': 'responsive', 'widths': [1280, 1600]},
            'screens': [
                {'step': 1, 'id': 'ready', 'title': 'Ready screen', 'person': 'Operator',
                 'job': 'Start from the produced fixture screen', 'kind': 'action', 'state': 'ideal',
                 'primary_action': 'Continue to the planned step'},
                {'step': 2, 'id': 'kickoff', 'title': 'Kickoff planned', 'person': 'Operator',
                 'job': 'Choose where a new fixture discussion should run', 'kind': 'action', 'state': 'ideal',
                 'primary_action': 'Create fixture thread', 'notes': 'Planned screen note.'},
            ],
        }
        (planned / 'design.json').write_text(json.dumps(planned_record))

        missing = fixture_root / 'missing-brief'
        missing.mkdir(parents=True, exist_ok=True)
        missing_record = {
            'schema_version': 1, 'design': 'missing-brief', 'title': 'Missing brief fixture',
            'viewport': {'posture': 'desktop-only', 'widths': [1280]},
            'screens': [{'step': 1, 'id': 'no-brief', 'title': 'No brief recorded', 'person': 'Operator',
                         'job': 'Explain the missing brief state', 'kind': 'decision', 'state': 'ideal'}],
        }
        (missing / 'design.json').write_text(json.dumps(missing_record))

        unsafe = fixture_root / 'unsafe-brief'
        unsafe.mkdir(parents=True, exist_ok=True)
        unsafe_record = {
            'schema_version': 1, 'design': 'unsafe-brief', 'title': 'Unsafe brief fixture',
            'brief': '../brief.md',
            'viewport': {'posture': 'desktop-only', 'widths': [1280]},
            'screens': [{'step': 1, 'id': 'unsafe-brief', 'title': 'Unsafe brief recorded', 'person': 'Operator',
                         'job': 'Explain the unsafe brief state', 'kind': 'decision', 'state': 'ideal'}],
        }
        (unsafe / 'design.json').write_text(json.dumps(unsafe_record))
        seeded['fixture/planned'] = planned_record
        seeded['fixture/missing-brief'] = missing_record
        seeded['fixture/unsafe-brief'] = unsafe_record
        seeded['plannedBrief'] = '# Planned fixture brief\n\nPlanned screen guidance.\n'
        seeded['files'].extend([
            'fixture/designs/planned/design.json', 'fixture/designs/planned/brief.md',
            'fixture/designs/planned/screens/01-ready.html', 'fixture/designs/planned/marker.js',
            'fixture/designs/planned/screen.css', 'fixture/designs/planned/captures/01-ready@1280.png',
            'fixture/designs/planned/captures/02-kickoff@1280.png',
            'fixture/designs/missing-brief/design.json', 'fixture/designs/unsafe-brief/design.json',
        ])
    if case == 'partial':
        # Real disk evidence for the partial case: one missing declared capture,
        # a marker brief, an unrelated invalid index, and an all-invalid other scope.
        (demo / 'captures' / '01-screen-1@1600.png').unlink(missing_ok=True)
        partial_brief = '# Demo marker brief\n\nMarker brief for the partial case.\n'
        (demo / 'brief.md').write_text(partial_brief)
        broken_index = '{ invalid json'
        broken = fixture_root / 'broken'
        broken.mkdir(parents=True, exist_ok=True)
        (broken / 'design.json').write_text(broken_index)
        other_demo = other_root / 'other-demo'
        if other_demo.exists():
            shutil.rmtree(other_demo)
        other_broken = other_root / 'broken-other'
        other_broken.mkdir(parents=True, exist_ok=True)
        (other_broken / 'design.json').write_text(broken_index)
        seeded['partialMode'] = {
            'removedCapture': 'fixture/designs/demo/captures/01-screen-1@1600.png',
            'brief': partial_brief,
            'brokenIndex': broken_index,
            'otherBrokenIndex': broken_index,
            'validFixtureDesigns': ['demo', 'second'],
            'validOtherDesigns': [],
        }
    return seeded


class QuietRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


class CaseComplete(Exception):
    """Raised after a non-journey case finishes so the shared cleanup still runs."""


try:
    fixture = subprocess.Popen(
        ['node', str(root / 'browser-fixture.mjs')],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture readiness exceeded 10 seconds')
    receipt = json.loads(fixture.stdout.readline())
    report['fixture'] = receipt
    report['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
    report['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=checkout, text=True).strip())
    report['seededDesigns'] = seed_designs(Path(receipt['root']) / 'storage')

    with sync_playwright() as p:
        try:
            executable = shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': executable} if executable else {}),
                                        headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1280, 'height': 900}, device_scale_factor=1)
            page = context.new_page()
            requests = []
            page.on('request', lambda request: requests.append({'method': request.method, 'url': request.url}))
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('console', lambda message: report['consoleErrors'].append(message.text) if message.type == 'error' else None)
            page.on('requestfailed', lambda request: report['requestFailures'].append(
                {'method': request.method, 'url': request.url, 'failure': str(request.failure)}))
            startup_seconds = round(time.monotonic() - started, 3)
            check_started = time.monotonic()
            base = receipt['url']
            workspace_view = '/workspace-view/'

            def passed(name):
                report['scenarios'].append(name)

            def params():
                return parse_qs(urlsplit(page.url).fragment.partition('?')[2])

            def frame():
                return page.frame_locator('#design-frame')

            def head_count():
                return len([r for r in requests if r['method'] == 'HEAD' and workspace_view in r['url']])

            def marker_loads():
                return len([r for r in requests if '/marker.js' in r['url']])

            def design_reads():
                return len([r for r in requests if '/api/workspace-designs' in r['url'] or workspace_view in r['url']])

            def frame_geometry(declared):
                geometry = page.evaluate("""() => {
                  const wrap = document.getElementById('design-frame-wrap');
                  const frameElement = document.getElementById('design-frame');
                  const style = getComputedStyle(frameElement);
                  const matrix = new DOMMatrixReadOnly(style.transform);
                  return { wrapWidth: wrap.clientWidth, frameWidth: parseFloat(style.width),
                           frameHeight: parseFloat(style.height), scale: matrix.a,
                           wrapHeight: wrap.getBoundingClientRect().height };
                }""")
                geometry['declared'] = declared
                return geometry

            def assert_frame_geometry(declared, timeout=2):
                deadline = time.monotonic() + timeout
                while True:
                    geometry = frame_geometry(declared)
                    expected_scale = min(1, geometry['wrapWidth'] / declared)
                    if (geometry['frameWidth'] == declared and geometry['frameHeight'] == 900
                            and abs(geometry['scale'] - expected_scale) < 0.001
                            and abs(geometry['wrapHeight'] - 900 * geometry['scale']) < 1):
                        return geometry
                    if time.monotonic() >= deadline:
                        raise AssertionError((declared, geometry))
                    page.wait_for_timeout(50)

            def active_control():
                return page.evaluate("""() => {
                  const el = document.activeElement;
                  if (!el) return null;
                  return { id: el.id || '', text: (el.textContent || '').trim().slice(0, 40),
                           disabled: el.hasAttribute('disabled'), ariaDisabled: el.getAttribute('aria-disabled') };
                }""")

            def reference_geometry(reference_page):
                return reference_page.evaluate("""() => {
                  const wrap = document.getElementById('design-frame-wrap');
                  const frameElement = document.getElementById('design-frame');
                  const canvas = document.querySelector('.design-canvas');
                  if (!wrap || !frameElement) return null;
                  const style = getComputedStyle(frameElement);
                  const matrix = new DOMMatrixReadOnly(style.transform);
                  return { wrapWidth: wrap.clientWidth, frameWidth: parseFloat(style.width),
                           frameHeight: parseFloat(style.height), scale: matrix.a,
                           wrapHeight: wrap.getBoundingClientRect().height,
                           scrollTop: canvas ? canvas.scrollTop : null };
                }""")

            def capture_reference(prefix, details=True, wait_for_frame=True, select_width=True):
                global reference_server
                assert reference_html and reference_html.is_file(), reference_html
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
                if details:
                    reference_page.evaluate("() => { const details = document.querySelector('.design-canvas details'); if (details) details.open = true; }")
                reference_state = []
                for width in (1280, 1600):
                    reference_page.set_viewport_size({'width': width, 'height': 900})
                    reference_page.wait_for_timeout(150)
                    if select_width:
                        reference_page.select_option('#design-width', f'{width}px')
                    if select_width and wait_for_frame:
                        reference_page.wait_for_function("""(declared) => {
                          const frameElement = document.getElementById('design-frame');
                          if (!frameElement) return false;
                          return parseFloat(getComputedStyle(frameElement).width) === declared;
                        }""", arg=width)
                    reference_page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) canvas.scrollTop = 0; }")
                    frame_path = browser_evidence / f'{prefix}@{width}.png'
                    reference_page.screenshot(path=str(frame_path))
                    report['captures'].append(str(frame_path))
                    state = {
                        'width': width,
                        'declaredReferenceWidth': reference_page.evaluate("() => { const select = document.getElementById('design-width'); return select ? select.value : null; }"),
                        'frameCapture': str(frame_path),
                    }
                    if details:
                        reference_page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) { const target = canvas.querySelector('details'); if (target) target.scrollIntoView({ block: 'start' }); } }")
                        details_path = browser_evidence / f'{prefix}-details@{width}.png'
                        reference_page.screenshot(path=str(details_path))
                        report['captures'].append(str(details_path))
                        state['detailsCapture'] = str(details_path)
                    state['geometry'] = reference_geometry(reference_page)
                    reference_state.append(state)
                reference_page.close()
                report['reference'] = {'html': str(reference_html), 'url': reference_url, 'captures': reference_state}

            if case == 'stale':
                stale_state = {}
                report['staleState'] = stale_state
                modes = {'hold_index': False, 'fail_index': False, 'fail_head': False}
                state_mode = {'kind': 'normal', 'generated_at': None}
                held_index = []

                def wait_until(condition, label, timeout=5):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if condition():
                            return
                        page.wait_for_timeout(25)
                    raise AssertionError(f'{label} not observed')

                def index_reads():
                    return len([r for r in requests if '/api/workspace-designs' in r['url']])

                def iso_offset(iso, milliseconds):
                    base = datetime.fromisoformat(iso.replace('Z', '+00:00'))
                    return (base + timedelta(milliseconds=milliseconds)).isoformat().replace('+00:00', 'Z')

                def designs_boundary(route):
                    if '/api/workspace-designs' in route.request.url and 'id=fixture' in route.request.url:
                        if modes['hold_index']:
                            held_index.append(route)
                            return
                        if modes['fail_index']:
                            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Fixture generic 503'}))
                            return
                    route.continue_()

                def state_boundary(route):
                    if state_mode['kind'] == 'normal' or route.request.method != 'GET':
                        route.continue_()
                        return
                    response = route.fetch()
                    try:
                        body = response.json()
                    except Exception:
                        route.continue_()
                        return
                    if state_mode['kind'] == 'offset':
                        body['generated_at'] = state_mode['generated_at']
                    elif state_mode['kind'] == 'invalid':
                        body.pop('generated_at', None)
                    headers = {key: value for key, value in response.headers.items() if key.lower() != 'content-length'}
                    route.fulfill(status=response.status, headers=headers, json=body)

                def head_boundary(route):
                    if modes['fail_head'] and route.request.method == 'HEAD':
                        route.fulfill(status=503)
                    else:
                        route.continue_()
                page.route('**/api/workspace-designs**', designs_boundary)
                page.route('**/api/state**', state_boundary)
                page.route('**/workspace-view/**', head_boundary)

                page.clock.install(time=datetime(2026, 1, 1, 12, 0, 0))
                page.clock.pause_at(datetime(2026, 1, 1, 12, 0, 0))
                try:
                    # Cold confirmed demo.
                    page.goto(base + '/#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1280&q=fixture', wait_until='domcontentloaded')
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                    confirmed_handle = page.locator('#design-frame').element_handle()
                    confirmed_nonce = frame().locator('html').get_attribute('data-nonce')
                    confirmed_route = page.url
                    heads_before = head_count()
                    initial_state = context.request.get(base + '/api/state').json()['generated_at']
                    stale_state['confirmed'] = {'stateGeneratedAt': initial_state, 'route': confirmed_route,
                                                'nonce': confirmed_nonce, 'headReads': heads_before}

                    # 1. Held revalidation on the real state clock: no callout before 300ms, exact copy after.
                    modes['hold_index'] = True
                    state_mode['kind'] = 'normal'
                    with page.expect_response(lambda response: '/api/state' in response.url) as state_refresh:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert state_refresh.value.status == 200
                    page.clock.fast_forward(299)
                    assert page.locator('.design-canvas .ds-callout').count() == 0, 'revalidation appeared before 300ms'
                    page.clock.fast_forward(1)
                    wait_until(lambda: page.locator('.design-canvas .ds-callout').count() == 1, 'revalidation callout at 300ms')
                    notice = page.locator('.design-canvas .ds-callout')
                    expect(notice).to_contain_text('Last checked at')
                    expect(notice).to_contain_text('Existing content is kept while the host revalidates it.')
                    expect(notice.get_by_role('button', name='Refresh designs', exact=True)).to_have_class(re.compile(r'ds-btn--primary'))
                    assert (page.get_by_role('link', name='Open screen', exact=True).get_attribute('class') or '') == 'ds-btn'
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    assert confirmed_handle.evaluate('(el) => el.isConnected')
                    assert page.url == confirmed_route
                    assert head_count() == heads_before
                    stale_state['delayBoundary'] = {'at299': 'absent', 'at300': notice.text_content(),
                                                    'clock': 'real-state', 'stale': False}

                    # Captures with fitting widths and the native disclosure activation.
                    for width in (1280, 1600):
                        page.set_viewport_size({'width': width, 'height': 900})
                        page.locator('#design-width').focus()
                        page.select_option('#design-width', str(width))
                        page.wait_for_function("(selected) => location.hash.includes('tab=' + selected)", arg=str(width))
                        expect(page.locator('#design-width')).to_have_value(str(width))
                        page.clock.fast_forward(16)
                        assert_frame_geometry(width)
                        page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) canvas.scrollTop = 0; }")
                        path = browser_evidence / f'designs-stale@{width}.png'
                        page.screenshot(path=str(path))
                        report['captures'].append(str(path))
                        details = page.locator('.design-canvas details')
                        if not details.evaluate('element => element.open'):
                            summary = details.locator('summary')
                            summary.focus()
                            summary.click()
                            page.clock.fast_forward(16)
                        assert details.evaluate('element => element.open'), 'details disclosure closed before scrolling'
                        paragraph = details.locator('p').first
                        expect(paragraph).to_be_visible()
                        expect(paragraph).to_contain_text('Capture: 1280px and 1600px')
                        page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) { const target = canvas.querySelector('details'); if (target) target.scrollIntoView({ block: 'start' }); } }")
                        details = page.locator('.design-canvas details')
                        assert details.evaluate('element => element.open'), 'details disclosure closed after scrolling'
                        path = browser_evidence / f'designs-stale-details@{width}.png'
                        page.screenshot(path=str(path))
                        report['captures'].append(str(path))
                    if reference_html:
                        capture_reference('reference-82', details=True, select_width=True, wait_for_frame=True)
                    page.locator('#find-record').fill('demo')
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    assert head_count() == heads_before

                    # Repeated refresh while held coalesces a single in-flight read.
                    held_before = len(held_index)
                    reads_before = index_reads()
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    page.clock.fast_forward(50)
                    assert len(held_index) == held_before, (held_before, len(held_index))
                    assert index_reads() == reads_before, 'repeated refresh issued another in-flight read'
                    assert notice.text_content().startswith('Last checked at')

                    # Keyboard, 44px and 200% zoom on the notice action.
                    notice_refresh = notice.get_by_role('button', name='Refresh designs', exact=True)
                    box = notice_refresh.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, box
                    page.evaluate("document.documentElement.style.zoom = '2'")
                    notice_refresh.scroll_into_view_if_needed()
                    zoom_box = notice_refresh.bounding_box()
                    assert zoom_box and zoom_box['x'] >= 0 and zoom_box['y'] >= 0 and zoom_box['y'] < 900, zoom_box
                    page.evaluate("document.documentElement.style.zoom = ''")
                    notice_refresh.focus()
                    assert page.evaluate("document.activeElement && document.activeElement.textContent") == 'Refresh designs'
                    held_after_keyboard = len(held_index)
                    reads_after_keyboard = index_reads()
                    page.keyboard.press('Enter')
                    page.clock.fast_forward(16)
                    assert len(held_index) == held_after_keyboard, 'keyboard refresh started another in-flight read'
                    assert index_reads() == reads_after_keyboard, 'keyboard refresh issued another index request'

                    # Third planned screen + real title change consumed on release.
                    demo_index = Path(receipt['root']) / 'storage' / 'projects' / 'fixture' / 'designs' / 'demo' / 'design.json'
                    original_record = json.loads(demo_index.read_text())
                    third = {'step': 3, 'id': 'screen-3', 'title': 'Screen three', 'person': 'Operator',
                             'job': 'Confirm the revalidated index', 'kind': 'action', 'state': 'ideal',
                             'primary_action': 'Review revalidation'}
                    changed_record = {**original_record, 'title': 'Design fixture revalidated',
                                      'screens': [*original_record['screens'], third]}
                    demo_index.write_text(json.dumps(changed_record))
                    report['fixtureInputsDelta'] = {'fixture/designs/demo/design.json': changed_record}
                    modes['hold_index'] = False
                    while held_index:
                        held_index.pop(0).continue_()
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture revalidated')
                    expect(page.locator('.list-pane .record.selected')).to_contain_text('2 of 3 screens produced')
                    expect(page.locator('.design-canvas .ds-callout')).to_have_count(0)
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    assert head_count() == heads_before
                    stale_state['freshRecovery'] = {'title': 'Design fixture revalidated', 'screens': 3, 'notice': 'cleared'}
                    passed('a held revalidation on the real clock shows no callout before 300ms, the exact warning at 300ms with primary Refresh and secondary Open screen, coalesces repeats, and clears when the changed real index is consumed')

                    # 2. Stale threshold on a cold entry with a known server clock: the state
                    #    generated_at is pinned before the initial index read, so the observed
                    #    loadedAt is exactly that known server ISO and no other read is inferred.
                    baseline_iso = context.request.get(base + '/api/state').json()['generated_at']
                    state_mode['kind'] = 'offset'
                    state_mode['generated_at'] = baseline_iso
                    modes['hold_index'] = False
                    page.goto('about:blank')
                    page.goto(base + '/#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1280&q=fixture', wait_until='domcontentloaded')
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture revalidated')
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                    age_handle = page.locator('#design-frame').element_handle()
                    age_nonce = frame().locator('html').get_attribute('data-nonce')
                    age_route = page.url
                    age_heads = head_count()
                    stale_state['ageBaseline'] = {'apiIso': baseline_iso, 'route': age_route, 'nonce': age_nonce, 'headReads': age_heads}
                    modes['hold_index'] = True
                    held_index.clear()
                    state_mode['generated_at'] = iso_offset(baseline_iso, 45000)
                    with page.expect_response(lambda response: '/api/state' in response.url) as age_state_45000:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert age_state_45000.value.status == 200
                    assert page.locator('.design-canvas .ds-callout').count() == 0, '45000ms age was treated as stale'
                    state_mode['generated_at'] = iso_offset(baseline_iso, 45001)
                    with page.expect_response(lambda response: '/api/state' in response.url) as age_state_45001:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert age_state_45001.value.status == 200
                    wait_until(lambda: page.locator('.design-canvas .ds-callout').count() == 1, 'stale callout at 45001ms')
                    expect(page.locator('.design-canvas .ds-callout')).to_contain_text('Last checked at')
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == age_nonce
                    stale_state['ageBoundary'] = {'at45000': 'fresh', 'at45001': page.locator('.design-canvas .ds-callout').text_content(),
                                                  'baselineIso': baseline_iso,
                                                  'responseIsos': [age_state_45000.value.json().get('generated_at'),
                                                                   age_state_45001.value.json().get('generated_at')]}
                    passed('a cold known server clock keeps 45000ms fresh and shows the stale warning at 45001ms without advancing the page clock')

                    # 3. Invalid/missing generated_at keeps the honest unknown time: consume the
                    #    real state response, then release a real index read so the unknown
                    #    observation timestamp is recorded before the title is asserted.
                    state_mode['kind'] = 'invalid'
                    with page.expect_response(lambda response: '/api/state' in response.url) as unknown_state:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert unknown_state.value.status == 200
                    assert unknown_state.value.json().get('generated_at') is None
                    modes['hold_index'] = False
                    while held_index:
                        held_index.pop(0).continue_()
                    wait_until(lambda: 'Last checked time unknown' in page.locator('.design-canvas .ds-callout').text_content(), 'unknown time title')
                    expect(page.locator('.design-canvas .ds-callout')).to_contain_text('Existing content is kept while the host revalidates it.')
                    stale_state['unknownClock'] = {'title': 'Last checked time unknown', 'stateGeneratedAt': None}
                    # Restore the real state; the fresh local index read clears the unknown region.
                    state_mode['kind'] = 'normal'
                    with page.expect_response(lambda response: '/api/state' in response.url) as restored_state:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert restored_state.value.status == 200
                    expect(page.locator('.design-canvas .ds-callout')).to_have_count(0)
                    passed('a missing generated_at shows the honest unknown-time title and the restored real state with a fresh index clears it')

                    # 4. Held revalidation 503 keeps the frame and becomes the ordinary error.
                    modes['fail_index'] = True
                    with page.expect_response(lambda response: '/api/workspace-designs' in response.url) as stale_503:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert stale_503.value.status == 503
                    expect(page.locator('.designs-index-error')).to_contain_text('Designs could not be read')
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == age_nonce
                    assert age_handle.evaluate('(el) => el.isConnected')
                    stale_state['errorRetained'] = {'nonce': age_nonce, 'frameConnected': True}
                    modes['fail_index'] = False
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.designs-index-error')).to_have_count(0)
                    passed('a held revalidation 503 becomes the ordinary error with the age-entry frame and nonce retained')

                    # 5. A failed selected-screen HEAD must not hide independent
                    #    inventory freshness or redirect either recovery action.
                    modes['fail_head'] = True
                    with page.expect_response(lambda response: response.request.method == 'HEAD') as failed_head:
                        page.get_by_role('button', name='Next screen', exact=True).click()
                    assert failed_head.value.status == 503
                    retry_screen = page.get_by_role('button', name='Retry screen', exact=True)
                    expect(retry_screen).to_be_visible()
                    expect(page.locator('.design-canvas')).to_contain_text('Screen could not be read')
                    failed_route = page.url
                    failed_heads = head_count()
                    modes['hold_index'] = True
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    wait_until(lambda: len(held_index) == 1, 'held inventory refresh with failed screen')
                    page.clock.fast_forward(300)
                    freshness = page.locator('.design-canvas .ds-callout').filter(has_text='Last checked at')
                    expect(freshness).to_be_visible()
                    expect(retry_screen).to_be_visible()
                    expect(page.locator('.list-pane .record.selected')).to_contain_text('2 of 3 screens produced')
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture revalidated')
                    assert page.url == failed_route and head_count() == failed_heads

                    # Consuming the delayed read clears only freshness, not the screen error.
                    modes['hold_index'] = False
                    while held_index:
                        held_index.pop(0).continue_()
                    expect(freshness).to_have_count(0)
                    expect(retry_screen).to_be_visible()
                    baseline_iso = context.request.get(base + '/api/state').json()['generated_at']
                    state_mode['kind'] = 'offset'
                    state_mode['generated_at'] = iso_offset(baseline_iso, 45001)
                    modes['hold_index'] = True
                    with page.expect_response(lambda response: '/api/state' in response.url):
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(freshness).to_be_visible()
                    expect(retry_screen).to_be_visible()
                    reads_before = index_reads()
                    with page.expect_response(lambda response: response.request.method == 'HEAD') as retry_failure:
                        retry_screen.click()
                    assert retry_failure.value.status == 503
                    assert head_count() == failed_heads + 1 and index_reads() == reads_before
                    failed_heads = head_count()
                    expect(freshness).to_be_visible()
                    modes['hold_index'] = False
                    while held_index:
                        held_index.pop(0).continue_()
                    expect(freshness).to_have_count(0)
                    expect(retry_screen).to_be_visible()
                    # Unknown time supplies a persistent freshness notice after
                    # a completed read, so Refresh designs can issue a new read.
                    state_mode['kind'] = 'invalid'
                    with page.expect_response(lambda response: '/api/workspace-designs' in response.url):
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    freshness = page.locator('.design-canvas .ds-callout').filter(has_text='Last checked time unknown')
                    expect(freshness).to_be_visible()
                    reads_before = index_reads()
                    with page.expect_response(lambda response: '/api/workspace-designs' in response.url):
                        freshness.get_by_role('button', name='Refresh designs', exact=True).click()
                    assert index_reads() == reads_before + 1
                    assert head_count() == failed_heads
                    expect(retry_screen).to_be_visible()
                    modes['fail_head'] = False
                    reads_before = index_reads()
                    with page.expect_response(lambda response: response.request.method == 'HEAD'):
                        retry_screen.click()
                    expect(frame().locator('h1')).to_have_text('Marker screen two')
                    assert head_count() == failed_heads + 1 and index_reads() == reads_before
                    expect(freshness).to_be_visible()
                    assert page.url == failed_route
                    stale_state['screenFailureFreshness'] = {'delayed': 'coexists', 'aged': 'coexists',
                                                            'refreshDesigns': 'index only', 'retryScreen': 'HEAD only'}
                    passed('failed selected-screen HEAD coexists with delayed/aged retained inventory freshness; Refresh designs reads only inventory and Retry screen reads only HEAD')
                    state_mode['kind'] = 'normal'
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(freshness).to_have_count(0)

                    # 6. A scope change while a revalidation read is pending never inherits the delay.
                    held_index.clear()
                    modes['hold_index'] = True
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    page.evaluate("location.hash = '#/designs?ws=other'")
                    expect(frame().locator('h1')).to_have_text('Other workspace screen')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    expect(page.get_by_text('Existing content is kept while the host revalidates it.', exact=True)).to_have_count(0)
                    modes['hold_index'] = False
                    stale_state['scopeChange'] = {'route': page.url, 'inherited': False}
                    passed('a scope change while a revalidation read is pending never inherits the retained delay')

                    assert not report['pageErrors'], report['pageErrors']
                    allowed_console = [message for message in report['consoleErrors'] if '503' in message]
                    unexpected_console = [message for message in report['consoleErrors'] if '503' not in message]
                    assert not unexpected_console, unexpected_console
                    unexpected = [failure for failure in report['requestFailures'] if 'ERR_ABORTED' not in failure['failure']]
                    assert not unexpected, unexpected
                    mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
                    assert not mutations, f'mutation requests observed: {mutations}'
                finally:
                    while held_index:
                        try:
                            held_index.pop(0).continue_()
                        except Exception:
                            pass
                    page.unroute('**/api/workspace-designs**', designs_boundary)
                    page.unroute('**/api/state**', state_boundary)
                    page.unroute('**/workspace-view/**', head_boundary)
                report['status'] = 'passed'
                raise CaseComplete()

            if case == 'offline':
                offline_state = {}
                report['offlineState'] = offline_state
                modes = {'hold_index': False, 'abort_designs': False, 'abort_head': False}
                held_index = []

                def wait_until(condition, label, timeout=5):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if condition():
                            return
                        page.wait_for_timeout(25)
                    raise AssertionError(f'{label} not observed')

                def index_reads():
                    return len([r for r in requests if '/api/workspace-designs' in r['url']])

                def set_state_fail(value):
                    control = context.request.get(base + f'/__fixture/control?action=state-fail&value={str(value).lower()}')
                    assert control.ok

                def designs_boundary(route):
                    if '/api/workspace-designs' in route.request.url and 'id=fixture' in route.request.url:
                        if modes['hold_index']:
                            held_index.append(route)
                            return
                        if modes['abort_designs']:
                            report['expectedFailures'].append({'method': route.request.method, 'url': route.request.url,
                                                               'failure': 'net::ERR_FAILED', 'intentional': 'designs-abort'})
                            route.abort()
                            return
                    route.continue_()

                def head_boundary(route):
                    if modes['abort_head'] and route.request.method == 'HEAD' and 'workspace-view' in route.request.url:
                        report['expectedFailures'].append({'method': route.request.method, 'url': route.request.url,
                                                           'failure': 'net::ERR_FAILED', 'intentional': 'head-abort'})
                        route.abort()
                    else:
                        route.continue_()
                page.route('**/api/workspace-designs**', designs_boundary)
                page.route('**/workspace-view/**', head_boundary)

                page.clock.install(time=datetime(2026, 1, 1, 12, 0, 0))
                page.clock.pause_at(datetime(2026, 1, 1, 12, 0, 0))
                try:
                    # Cold confirmed demo at the explicit screen/width/query.
                    page.goto(base + '/#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1280&q=fixture', wait_until='domcontentloaded')
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                    confirmed_handle = page.locator('#design-frame').element_handle()
                    confirmed_nonce = frame().locator('html').get_attribute('data-nonce')
                    confirmed_identity = page.locator('#design-frame-wrap').get_attribute('data-viewer-identity')
                    confirmed_route = page.url
                    heads_before = head_count()
                    announcer = page.locator('main [role="status"][aria-atomic="true"]')
                    offline_state['confirmed'] = {'route': confirmed_route, 'nonce': confirmed_nonce, 'identity': confirmed_identity,
                                                  'headReads': heads_before, 'indexReads': index_reads()}

                    # 1. State read failure with a held designs index read.
                    modes['hold_index'] = True
                    set_state_fail(True)
                    with page.expect_response(lambda response: '/api/state' in response.url) as state_failure:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert state_failure.value.status == 503
                    wait_until(lambda: page.locator('.design-canvas .ds-callout').count() == 1, 'state-failure offline callout')
                    callout = page.locator('.design-canvas .ds-callout')
                    expect(callout).to_contain_text('Connection unavailable')
                    expect(callout).to_contain_text('Last received at')
                    expect(callout).to_contain_text('These records may have changed on the host.')
                    offline_text = callout.text_content()
                    expect(announcer).to_have_count(1)
                    assert announcer.text_content() == 'Connection unavailable. These records may have changed on the host.'
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    assert confirmed_handle.evaluate('(el) => el.isConnected')
                    assert page.url == confirmed_route
                    assert head_count() == heads_before
                    held_before = len(held_index)
                    reads_before = index_reads()
                    page.clock.fast_forward(5000)
                    expect(announcer).to_have_text('Connection unavailable. These records may have changed on the host.')
                    assert held_before == 1 and len(held_index) == 1, (held_before, len(held_index))
                    assert index_reads() == reads_before, 'poll issued a second in-flight index read'
                    assert announcer.text_content() == 'Connection unavailable. These records may have changed on the host.'
                    assert callout.text_content() == offline_text
                    offline_state['stateFailure'] = {'status': 503, 'indexReads': index_reads(), 'held': len(held_index),
                                                      'announcement': announcer.text_content(), 'timestamp': offline_text}
                    report['offlineState']['detailsCapture'] = []
                    for width in (1280, 1600):
                        page.set_viewport_size({'width': width, 'height': 900})
                        page.locator('#design-width').focus()
                        page.select_option('#design-width', str(width))
                        page.wait_for_function("(selected) => location.hash.includes('tab=' + selected)", arg=str(width))
                        expect(page.locator('#design-width')).to_have_value(str(width))
                        page.clock.fast_forward(16)
                        assert_frame_geometry(width)
                        page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) canvas.scrollTop = 0; }")
                        path = browser_evidence / f'designs-offline@{width}.png'
                        page.screenshot(path=str(path))
                        report['captures'].append(str(path))
                        details = page.locator('.design-canvas details')
                        observed = {
                            'width': width,
                            'route': page.url,
                            'tab': params().get('tab'),
                            'beforeOpen': details.evaluate('element => element.open'),
                        }
                        if not observed['beforeOpen']:
                            summary = details.locator('summary')
                            page.evaluate("""() => {
                              window.__detailsLog = [];
                              const node = document.querySelector('.design-canvas details');
                              const head = node && node.querySelector('summary');
                              if (node) node.addEventListener('toggle', () => window.__detailsLog.push({kind:'toggle', open: node.open, at: Date.now()}));
                              if (head) head.addEventListener('click', event => window.__detailsLog.push({kind:'click', open: node.open, target: event.target.tagName, at: Date.now()}));
                            }""")
                            summary.focus()
                            observed['summaryFocused'] = page.evaluate("document.activeElement && document.activeElement.tagName")
                            summary.click()
                            observed['afterClickOpen'] = details.evaluate('element => element.open')
                            observed['afterClickCount'] = page.locator('.design-canvas details').count()
                            observed['afterClickHtml'] = page.locator('.design-canvas details').first.evaluate('element => element.outerHTML.slice(0, 160)') if observed['afterClickCount'] else None
                            observed['afterClickLog'] = page.evaluate('() => window.__detailsLog')
                            page.clock.fast_forward(16)
                            observed['afterClockOpen'] = page.locator('.design-canvas details').first.evaluate('element => element.open') if page.locator('.design-canvas details').count() else None
                            observed['afterClockLog'] = page.evaluate('() => window.__detailsLog')
                            if not observed['afterClickOpen'] and not observed['afterClockOpen']:
                                summary.press('Enter')
                                observed['afterKeyboardOpen'] = details.evaluate('element => element.open')
                                page.clock.fast_forward(16)
                                observed['afterKeyboardClockOpen'] = details.evaluate('element => element.open')
                                observed['afterKeyboardLog'] = page.evaluate('() => window.__detailsLog')
                        report['offlineState']['detailsCapture'].append(observed)
                        details = page.locator('.design-canvas details')
                        assert details.evaluate('element => element.open'), 'details disclosure closed before scrolling'
                        details_paragraph = details.locator('p').first
                        expect(details_paragraph).to_be_visible()
                        expect(details_paragraph).to_contain_text('Capture: 1280px and 1600px')
                        expect(details_paragraph).to_contain_text('First screen note.')
                        page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) { const target = canvas.querySelector('details'); if (target) target.scrollIntoView({ block: 'start' }); } }")
                        details = page.locator('.design-canvas details')
                        assert details.evaluate('element => element.open'), 'details disclosure closed after scrolling'
                        path = browser_evidence / f'designs-offline-details@{width}.png'
                        page.screenshot(path=str(path))
                        report['captures'].append(str(path))
                    if reference_html:
                        capture_reference('reference-81', details=False, select_width=True, wait_for_frame=True)
                    page.locator('#find-record').fill('demo')
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    assert head_count() == heads_before, 'offline edits re-probed the frame'
                    retry_button = page.get_by_role('button', name='Retry connection', exact=True)
                    box = retry_button.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, box
                    page.evaluate("document.documentElement.style.zoom = '2'")
                    retry_button.scroll_into_view_if_needed()
                    zoom_box = retry_button.bounding_box()
                    assert zoom_box and zoom_box['x'] >= 0 and zoom_box['y'] >= 0 and zoom_box['y'] < 900, zoom_box
                    page.evaluate("document.documentElement.style.zoom = ''")
                    set_state_fail(False)
                    retry_button.focus()
                    assert page.evaluate("document.activeElement && document.activeElement.textContent") == 'Retry connection'
                    recovery_reads = index_reads()
                    with page.expect_response(lambda response: '/api/state' in response.url) as state_recovery:
                        page.keyboard.press('Enter')
                    assert state_recovery.value.status == 200
                    modes['hold_index'] = False
                    released = 0
                    while held_index:
                        held_index.pop(0).continue_()
                        released += 1
                    expect(page.locator('.design-canvas .ds-callout')).to_have_count(0)
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    assert confirmed_handle.evaluate('(el) => el.isConnected')
                    offline_state['stateRecovery'] = {'state': 200, 'released': released,
                                                      'indexReadsDelta': index_reads() - recovery_reads}
                    passed('a state read failure with a held index keeps one in-flight read, the retained frame, timestamp and route while offline, and Retry connection restores the real paths')

                    # 2. Designs transport abort with a healthy state.
                    transport_before = {'route': page.url, 'nonce': confirmed_nonce,
                                        'lifetime': frame().locator('html').get_attribute('data-lifetime')}
                    modes['abort_designs'] = True
                    with page.expect_response(lambda response: '/api/state' in response.url) as state_ok:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert state_ok.value.status == 200
                    wait_until(lambda: page.locator('.design-canvas .ds-callout').count() == 1, 'transport offline callout')
                    transport_callout = page.locator('.design-canvas .ds-callout')
                    expect(transport_callout).to_contain_text('Connection unavailable')
                    assert (page.get_by_role('link', name='Open screen', exact=True).get_attribute('class') or '') == 'ds-btn'
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    transport_text = transport_callout.text_content()
                    transport_after = {'route': page.url, 'nonce': frame().locator('html').get_attribute('data-nonce'),
                                       'lifetime': frame().locator('html').get_attribute('data-lifetime'),
                                       'timestamp': transport_text}
                    assert transport_after['route'] == transport_before['route']
                    assert transport_after['nonce'] == transport_before['nonce'] == confirmed_nonce
                    assert transport_after['lifetime'] == transport_before['lifetime']
                    announcer_before = announcer.text_content()
                    page.clock.fast_forward(5000)
                    expect(announcer).to_have_text(announcer_before)
                    assert transport_callout.text_content() == transport_text
                    offline_state['transportAbort'] = {'before': transport_before, 'after': transport_after,
                                                       'announcement': announcer_before}
                    modes['abort_designs'] = False
                    demo_index = Path(receipt['root']) / 'storage' / 'projects' / 'fixture' / 'designs' / 'demo' / 'design.json'
                    original_record = json.loads(demo_index.read_text())
                    changed_record = {**original_record, 'title': 'Design fixture offline recovered'}
                    demo_index.write_text(json.dumps(changed_record))
                    report['fixtureInputsDelta'] = {'fixture/designs/demo/design.json': changed_record}
                    recovery_reads = index_reads()
                    page.get_by_role('button', name='Retry connection', exact=True).click()
                    expect(page.locator('.design-canvas .ds-callout')).to_have_count(0)
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture offline recovered')
                    offline_state['transportRecovery'] = {'indexReadsDelta': index_reads() - recovery_reads}
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-nonce') == confirmed_nonce
                    passed('a designs transport abort shows the same offline callout with a secondary Open screen and recovers the changed real title without replacing the frame')

                    # 3. Aborted designs establish the offline callout, then an aborted HEAD for a new step-2 screen.
                    modes['abort_designs'] = True
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    wait_until(lambda: page.locator('.design-canvas .ds-callout').count() == 1, 'transport offline before next')
                    expect(page.locator('.design-canvas .ds-callout')).to_contain_text('Connection unavailable')
                    modes['abort_head'] = True
                    page.get_by_role('button', name='Next screen', exact=True).click()
                    page.wait_for_function("() => location.hash.includes('path=screens%2F02-screen-2.html')")
                    wait_until(lambda: 'Screen could not be read' in page.locator('.design-canvas').text_content(), 'step-2 failure preview')
                    expect(page.locator('.design-canvas')).to_contain_text('Connection unavailable')
                    assert page.locator('#design-frame').count() == 0, 'old frame rendered as the new identity'
                    assert not confirmed_handle.evaluate('(el) => el.isConnected')
                    expect(page.get_by_role('button', name='Open screen', exact=True)).to_be_disabled()
                    offline_state['newScreenFailure'] = {'route': page.url, 'oldFrameConnected': False}
                    modes['abort_head'] = False
                    modes['abort_designs'] = False
                    page.get_by_role('button', name='Retry connection', exact=True).click()
                    wait_until(lambda: page.locator('.design-canvas').get_by_role('button', name='Retry screen', exact=True).count() == 1, 'retry screen available')
                    page.locator('.design-canvas').get_by_role('button', name='Retry screen', exact=True).click()
                    expect(frame().locator('h1')).to_have_text('Marker screen two')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    assert params().get('path') == ['screens/02-screen-2.html'] and params().get('tab') == ['1600'] and params().get('q') == ['demo'], page.url
                    passed('an uncached screen selected while aborting shows its own retry failure without reusing the old marker and recovers the real step-2 bytes')

                    # 4. An HTTP 503 index alone is a normal read error, not offline.
                    index_modes = {'on': True}
                    def fail_index_503(route):
                        if index_modes['on'] and '/api/workspace-designs' in route.request.url and 'id=fixture' in route.request.url:
                            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Fixture generic 503'}))
                        else:
                            route.continue_()
                    page.route('**/api/workspace-designs**', fail_index_503)
                    with page.expect_response(lambda response: '/api/workspace-designs' in response.url) as index_503:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert index_503.value.status == 503
                    expect(page.locator('.designs-index-error')).to_contain_text('Designs could not be read')
                    expect(page.locator('.design-canvas .ds-callout')).to_have_count(0)
                    index_modes['on'] = False
                    page.unroute('**/api/workspace-designs**', fail_index_503)
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.designs-index-error')).to_have_count(0)
                    passed('an HTTP 503 index read alone stays the normal read error and never becomes the offline treatment')

                    # 5. A scope change while transport failed never inherits the old state.
                    modes['abort_designs'] = True
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    wait_until(lambda: page.locator('.design-canvas .ds-callout').count() == 1, 'offline before scope change')
                    page.evaluate("location.hash = '#/designs?ws=other'")
                    expect(frame().locator('h1')).to_have_text('Other workspace screen')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    expect(page.locator('#design-detail-heading')).to_have_text('Other fixture')
                    expect(page.get_by_text('Connection unavailable', exact=True)).to_have_count(0)
                    other_notices = page.locator('.design-canvas .ds-callout')
                    notice_title = other_notices.first.locator('strong').text_content() if other_notices.count() else None
                    offline_state['scopeIsolation'] = {'route': page.url, 'inheritedOffline': False, 'noticeTitle': notice_title}
                    assert page.locator('#design-frame').count() == 1
                    modes['abort_designs'] = False
                    passed('a scope change while transport failed clears the old offline and index data and the other workspace does not inherit them')

                    assert not report['pageErrors'], report['pageErrors']
                    intentional = {(item['method'], item['url']) for item in report['expectedFailures'] if item.get('intentional')}
                    unexpected = []
                    for failure in report['requestFailures']:
                        if 'ERR_ABORTED' in failure['failure']:
                            continue
                        if 'ERR_FAILED' in failure['failure'] and (failure['method'], failure['url']) in intentional:
                            continue
                        unexpected.append(failure)
                    assert not unexpected, unexpected
                    mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
                    assert not mutations, f'mutation requests observed: {mutations}'
                finally:
                    while held_index:
                        try:
                            held_index.pop(0).continue_()
                        except Exception:
                            pass
                    set_state_fail(False)
                    page.unroute('**/api/workspace-designs**', designs_boundary)
                    page.unroute('**/workspace-view/**', head_boundary)
                report['status'] = 'passed'
                raise CaseComplete()

            if case == 'unavailable':
                unavailable_state = {}
                report['unavailableState'] = unavailable_state
                storage = Path(receipt['root']) / 'storage'
                projects_dir = storage / 'projects'
                fixture_dir = projects_dir / 'fixture'
                demo_dir = fixture_dir / 'designs' / 'demo'
                demo_index = demo_dir / 'design.json'
                other_demo = projects_dir / 'other' / 'designs' / 'other-demo'
                held_demo = fixture_dir / 'designs-held-demo'
                held_fixture = storage / 'held-fixture'
                held_projects = storage / 'held-projects'
                degraded_marker = storage / 'projects-held-file'

                def wait_until(condition, label, timeout=5):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if condition():
                            return
                        page.wait_for_timeout(25)
                    raise AssertionError(f'{label} not observed')

                def demo_requests():
                    return len([r for r in requests if '/designs/demo/' in r['url']])

                def catalog_body():
                    response = context.request.get(base + '/api/workspaces')
                    assert response.ok, response.status
                    return response.json()

                def catalog_facts(body):
                    return {
                        'status': (body.get('storage') or {}).get('status'),
                        'storageErrors': (body.get('storage') or {}).get('errors'),
                        'errors': body.get('errors'),
                        'valid': [entry.get('id') for entry in body.get('valid', [])],
                        'invalidCount': len(body.get('invalid', [])),
                    }

                def catalog_incomplete(facts):
                    return facts['status'] not in ('ok', 'missing_projects') or bool(facts['storageErrors']) or bool(facts['errors'])

                def move_demo():
                    if demo_dir.exists():
                        demo_dir.rename(held_demo)

                def restore_demo():
                    if held_demo.exists() and not demo_dir.exists():
                        held_demo.rename(demo_dir)

                def move_fixture():
                    if fixture_dir.exists() and not held_fixture.exists():
                        fixture_dir.rename(held_fixture)

                def restore_fixture():
                    if held_fixture.exists() and not fixture_dir.exists():
                        held_fixture.rename(fixture_dir)

                def degrade_catalog():
                    projects_dir.rename(held_projects)
                    projects_dir.write_text('projects held for the degraded catalog boundary')

                def restore_catalog():
                    if projects_dir.is_file():
                        projects_dir.unlink()
                    if held_projects.is_dir() and not projects_dir.exists():
                        held_projects.rename(projects_dir)

                page.clock.install(time=datetime(2026, 1, 1, 12, 0, 0))
                page.clock.pause_at(datetime(2026, 1, 1, 12, 0, 0))
                try:
                    # Scenario 1: successful omission of the explicit slug preserves identity.
                    page.goto(base + '/#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1600&q=demo', wait_until='domcontentloaded')
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    expect(page.locator('#design-width')).to_have_value('1600')
                    unavailable_state['initiatingRoute'] = page.url
                    move_demo()
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.design-canvas .empty h2')).to_have_text('Design screen unavailable')
                    assert params().get('id') == ['demo'] and params().get('path') == ['screens/01-screen-1.html'] and params().get('tab') == ['1600'] and params().get('q') == ['demo'], page.url
                    expect(page.locator('.object-head h2')).to_have_text('Design fixture')
                    expect(page.locator('.object-head')).to_contain_text('Screen 1 · Screen one')
                    expect(page.locator('.design-canvas')).to_contain_text('The workspace or selected file is no longer available through the current reader boundary.')
                    expect(page.locator('.design-canvas')).to_contain_text('Last known selection: Design fixture · Screen 1 screens/01-screen-1.html')
                    assert page.locator('#design-frame').count() == 0
                    open_screen = page.get_by_role('button', name='Open screen', exact=True)
                    expect(open_screen).to_be_disabled()
                    expect(open_screen).to_have_attribute('title', 'The workspace or selected file is no longer available through the current reader boundary.')
                    expect(page.get_by_role('button', name='Previous screen', exact=True)).to_be_disabled()
                    expect(page.locator('#design-width')).to_be_disabled()
                    demo_before = demo_requests()
                    page.clock.fast_forward(1000)
                    assert demo_requests() == demo_before, 'unavailable selection kept reading the demo assets'
                    details = page.locator('.design-canvas details')
                    if details.count() and not details.evaluate('element => element.open'):
                        details.locator('summary').click()
                    expect(details).to_contain_text('Screen details and deviations')
                    for width in (1280, 1600):
                        page.set_viewport_size({'width': width, 'height': 900})
                        page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) canvas.scrollTop = 0; }")
                        path = browser_evidence / f'designs-unavailable@{width}.png'
                        page.screenshot(path=str(path))
                        report['captures'].append(str(path))
                        if details.count() and not details.evaluate('element => element.open'):
                            details.locator('summary').click()
                        page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) { const target = canvas.querySelector('details'); if (target) target.scrollIntoView({ block: 'start' }); } }")
                        path = browser_evidence / f'designs-unavailable-details@{width}.png'
                        page.screenshot(path=str(path))
                        report['captures'].append(str(path))
                    if reference_html:
                        capture_reference('reference-80', details=False, wait_for_frame=False, select_width=False)
                    unavailable_state['omission'] = {'route': page.url, 'demoReads': demo_requests() - demo_before}
                    passed('a successful current-scope omission keeps the explicit identity, last metadata and boundary explanation with no frame access')

                    # A later index 503 keeps the retained successful omission unavailable.
                    omission_modes = {'on': True}
                    def fail_omitted_index(route):
                        if omission_modes['on'] and '/api/workspace-designs' in route.request.url and 'id=fixture' in route.request.url:
                            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Fixture generic 503'}))
                        else:
                            route.continue_()
                    page.route('**/api/workspace-designs**', fail_omitted_index)
                    with page.expect_response(lambda response: '/api/workspace-designs' in response.url and 'id=fixture' in response.url) as omission_failure:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert omission_failure.value.status == 503
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_be_visible()
                    assert params().get('id') == ['demo'] and params().get('path') == ['screens/01-screen-1.html'] and params().get('tab') == ['1600'] and params().get('q') == ['demo'], page.url
                    assert page.locator('#design-frame').count() == 0
                    demo_after_failure = demo_requests()
                    page.clock.fast_forward(1000)
                    assert demo_requests() == demo_after_failure, 'index failure resumed demo asset access'
                    unavailable_state['omissionFailure'] = {'status': 503, 'route': page.url, 'frame': 0}
                    omission_modes['on'] = False
                    page.unroute('**/api/workspace-designs**', fail_omitted_index)
                    with page.expect_response(lambda response: '/api/workspace-designs' in response.url and 'id=fixture' in response.url) as omission_recovery:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert omission_recovery.value.status == 200
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_be_visible()
                    assert page.locator('#design-frame').count() == 0

                    # Choose design: focus search, clear id/path/tab, recover a real row, Back restores.
                    choose = page.get_by_role('button', name='Choose design', exact=True)
                    box = choose.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, box
                    page.evaluate("document.documentElement.style.zoom = '2'")
                    page.wait_for_timeout(50)
                    choose.scroll_into_view_if_needed()
                    zoom_box = choose.bounding_box()
                    assert zoom_box and zoom_box['x'] >= 0 and zoom_box['y'] >= 0 and zoom_box['y'] < 900, zoom_box
                    page.evaluate("document.documentElement.style.zoom = ''")
                    choose.focus()
                    assert page.evaluate("document.activeElement && document.activeElement.textContent") == 'Choose design'
                    page.keyboard.press('Enter')
                    expect(page.locator('#find-record')).to_be_visible()
                    page.wait_for_function("() => location.hash.includes('id=second')")
                    page.clock.fast_forward(16)
                    active_element = page.evaluate("document.activeElement ? document.activeElement.id : ''")
                    unavailable_state['chooseRecovery'] = {'activeElement': active_element, 'route': page.url}
                    assert params().get('ws') == ['fixture'] and params().get('q') == ['demo'], page.url
                    assert params().get('id') != ['demo'], page.url
                    assert active_element == 'find-record', active_element
                    expect(page.locator('#design-detail-heading')).to_have_text('Alternate fixture')
                    expect(frame().locator('h1')).to_have_text('Alternate wide screen')
                    page.go_back()
                    expect(page.locator('.design-canvas .empty h2')).to_have_text('Design screen unavailable')
                    assert params().get('id') == ['demo'], page.url
                    passed('Choose design clears id/path/tab, keeps ws/q, focuses the search and Back restores the unavailable identity')

                    # Scenario 2: restore, corrupt the selected index, unrelated broken index stays partial.
                    restore_demo()
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    original_demo_index = demo_index.read_text()
                    demo_index.write_text('{ invalid json')
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.design-canvas .empty h2')).to_have_text('Design screen unavailable')
                    unavailable_state['namedSlugError'] = params().get('id')
                    demo_index.write_text(original_demo_index)
                    unrelated = fixture_dir / 'designs' / 'broken-unrelated'
                    unrelated.mkdir(parents=True, exist_ok=True)
                    (unrelated / 'design.json').write_text('{ invalid json')
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    expect(page.locator('.design-canvas .ds-callout')).to_contain_text('1 design index could not be read.')
                    expect(page.locator('.list-pane')).to_contain_text('designs/broken-unrelated/design.json')
                    unrelated_details = page.locator('.design-canvas details')
                    if not unrelated_details.evaluate('element => element.open'):
                        unrelated_details.locator('summary').click()
                    expect(unrelated_details).to_contain_text('designs/broken-unrelated/design.json')
                    (unrelated / 'design.json').unlink()
                    unrelated.rmdir()
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.design-canvas .ds-callout')).to_have_count(0)
                    passed('restoring the real index recovers; a selected slug error is unavailable while an unrelated broken index stays a partial warning')

                    # Scenario 3: generic index/HEAD failures stay errors; a missing path normalizes.
                    index_modes = {'on': True}
                    def fail_index(route):
                        if index_modes['on'] and '/api/workspace-designs' in route.request.url and 'id=fixture' in route.request.url:
                            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Fixture generic 503'}))
                        else:
                            route.continue_()
                    page.route('**/api/workspace-designs**', fail_index)
                    with page.expect_response(lambda response: '/api/workspace-designs' in response.url) as index_failure:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert index_failure.value.status == 503
                    expect(page.locator('.list-pane')).to_contain_text('The host did not return a usable result. Your selection is kept.')
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    index_modes['on'] = False
                    page.unroute('**/api/workspace-designs**', fail_index)
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.designs-index-error')).to_have_count(0)
                    head_modes = {'on': True}
                    def fail_head(route):
                        if head_modes['on'] and route.request.method == 'HEAD' and 'workspace-view' in route.request.url:
                            route.fulfill(status=503, content_type='text/html', body='')
                        else:
                            route.continue_()
                    page.route('**/workspace-view/**', fail_head)
                    page.get_by_role('button', name='Next screen', exact=True).click()
                    page.wait_for_function("() => location.hash.includes('path=screens%2F02-screen-2.html')")
                    expect(page.locator('.design-canvas')).to_contain_text('Screen could not be read')
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    head_modes['on'] = False
                    page.unroute('**/workspace-view/**', fail_head)
                    page.get_by_role('button', name='Retry screen', exact=True).click()
                    expect(page.locator('#design-frame')).to_have_count(1)
                    page.evaluate("location.hash = '#/designs?ws=fixture&id=demo&path=screens/99-missing.html&tab=1600'")
                    page.wait_for_function("() => location.hash.includes('path=screens%2F01-screen-1.html')")
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    unavailable_state['genericFailures'] = {'index503': 'error', 'head503': 'error', 'missingPath': 'normalized'}
                    passed('generic index/HEAD 503 stay errors and an omitted path inside a valid design normalizes instead of denying access')

                    # Scenario 4: same-outlet transition to an all-invalid other scope.
                    other_original = (other_demo / 'design.json').read_text()
                    (other_demo / 'design.json').write_text('{ invalid json')
                    demo_before_switch = demo_requests()
                    initiating = page.url
                    page.evaluate("location.hash = '#/designs?ws=other'")
                    expect(page.locator('.detail-body')).to_contain_text('Design indexes could not be read')
                    assert params().get('ws') == ['other'] and params().get('id') is None, page.url
                    assert demo_requests() == demo_before_switch, 'scope transition requested the previous demo assets'
                    other_api = context.request.get(base + '/api/workspace-designs?id=other')
                    other_body = other_api.json()
                    assert other_body.get('designs') == [] and other_body.get('errors'), other_body
                    assert page.locator('#design-frame').count() == 0
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    expect(page.locator('.detail-body')).to_contain_text('designs/other-demo/design.json')
                    unavailable_state['scopeTransition'] = {
                        'initiatingRoute': initiating, 'finalRoute': page.url,
                        'otherDesigns': other_body.get('designs'),
                        'otherErrorNames': [item.get('name') for item in other_body.get('errors', [])],
                        'demoReadsDuringSwitch': demo_requests() - demo_before_switch,
                    }
                    (other_demo / 'design.json').write_text(other_original)
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('#design-detail-heading')).to_have_text('Other fixture')
                    passed('a same-outlet scope transition renders the real all-invalid other diagnostics without touching the previous demo assets')

                    # Scenario 5: degraded catalog never removes; complete omission does.
                    page.goto(base + '/#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1600', wait_until='domcontentloaded')
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                    degraded_handle = page.locator('#design-frame').element_handle()
                    degraded_nonce = frame().locator('html').get_attribute('data-nonce')
                    unavailable_state['degradedFrame'] = {'nonce': degraded_nonce}
                    move_fixture()
                    degrade_catalog()
                    degraded_catalog = catalog_body()
                    degraded_facts = catalog_facts(degraded_catalog)
                    unavailable_state['degradedCatalog'] = degraded_facts
                    assert catalog_incomplete(degraded_facts), degraded_facts
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.list-pane')).to_contain_text('The host did not return a usable result. Your selection is kept.')
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                    assert frame().locator('html').get_attribute('data-marker') == '42'
                    assert frame().locator('html').get_attribute('data-nonce') == degraded_nonce
                    assert degraded_handle.evaluate('(el) => el.isConnected')
                    page.set_viewport_size({'width': 1600, 'height': 900})
                    path = browser_evidence / 'designs-unavailable-degraded@1600.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                    restore_catalog()
                    complete_catalog = catalog_body()
                    complete_facts = catalog_facts(complete_catalog)
                    unavailable_state['completeCatalog'] = complete_facts
                    assert complete_facts['status'] in ('ok', 'missing_projects') and not complete_facts['storageErrors'] and not complete_facts['errors'], complete_facts
                    assert 'fixture' not in complete_facts['valid'], complete_facts
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('.design-canvas .empty h2')).to_have_text('Design screen unavailable')
                    assert page.locator('#design-frame').count() == 0
                    choose_removed = page.get_by_role('button', name='Choose design', exact=True)
                    choose_removed.click()
                    expect(page.locator('[data-workspace="other"]')).to_be_visible()
                    assert params() == {}, page.url
                    assert page.locator('[data-workspace="fixture"]').count() == 0, 'dead workspace still offered'
                    restore_fixture()
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
                    page.locator('[data-workspace="fixture"]').click()
                    expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    passed('a degraded catalog keeps the retained workspace while a complete omission removes it and offers the real unscoped picker')

                    # Catalog 503 with a retained frame never removes the workspace.
                    catalog_modes = {'on': True}
                    def fail_catalog(route):
                        if catalog_modes['on'] and '/api/workspaces' in route.request.url:
                            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Fixture generic 503'}))
                        else:
                            route.continue_()
                    page.route('**/api/workspaces', fail_catalog)
                    with page.expect_response(lambda response: '/api/workspaces' in response.url) as catalog_failure:
                        page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    assert catalog_failure.value.status == 503
                    expect(page.get_by_role('heading', name='Design screen unavailable', exact=True)).to_have_count(0)
                    expect(frame().locator('h1')).to_have_text('Marker screen one')
                    catalog_modes['on'] = False
                    page.unroute('**/api/workspaces', fail_catalog)
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                    passed('a catalog 503 with a retained frame never declares the workspace removed')
                finally:
                    restore_catalog()
                    restore_fixture()
                    restore_demo()
                assert not report['pageErrors'], report['pageErrors']
                report['status'] = 'passed'
                raise CaseComplete()

            if case == 'partial':
                partial_state = {}
                report['partialState'] = partial_state

                def wait_until(condition, label, timeout=5):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if condition():
                            return
                        page.wait_for_timeout(25)
                    raise AssertionError(f'{label} not observed')

                page.clock.install(time=datetime(2026, 1, 1, 12, 0, 0))
                page.clock.pause_at(datetime(2026, 1, 1, 12, 0, 0))

                # Cold real entry into the partial demo.
                page.goto(base + '/#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1280', wait_until='domcontentloaded')
                wait_until(lambda: page.locator('#design-detail-heading').text_content() == 'Design fixture', 'partial demo detail')
                expect(page.get_by_text('Screen 1 · Screen one', exact=True)).to_be_visible()
                expect(frame().locator('h1')).to_have_text('Marker screen one')
                assert frame().locator('html').get_attribute('data-marker') == '42'
                expect(page.locator('.list-pane .record')).to_have_count(2)
                expect(page.locator('.list-pane .record.selected')).to_contain_text('Design fixture')
                expect(page.locator('.list-pane .record.selected')).to_contain_text('screens produced')
                callout = page.locator('.design-canvas .ds-callout')
                expect(callout).to_contain_text('Capture evidence incomplete')
                expect(callout).to_contain_text('Screen 1 has a 1280px capture. Its 1600px capture is missing. 1 design index could not be read.')
                brief_primary = callout.get_by_role('link', name='Open brief', exact=True)
                expect(brief_primary).to_have_class(re.compile(r'ds-btn--primary'))
                open_screen_link = page.get_by_role('link', name='Open screen', exact=True)
                assert (open_screen_link.get_attribute('class') or '') == 'ds-btn', 'Open screen was not secondary'
                details = page.locator('.design-canvas details')
                details.locator('summary').click()
                expect(details).to_contain_text('Capture: 1280px · Missing: 1600px')
                expect(details).to_contain_text('designs/broken/design.json')
                assert 'review complete' not in page.locator('main').inner_text().lower()
                partial_state['entry'] = {'validRows': 2, 'marker': '42', 'callout': 'partial', 'openScreen': 'secondary'}

                # Producer truth for the demo fixture: real API maps, summary and error count.
                producer = context.request.get(base + '/api/workspace-designs?id=fixture')
                assert producer.ok, producer.status
                producer_body = producer.json()
                producer_demo = next((item for item in producer_body.get('designs', []) if item.get('slug') == 'demo'), None)
                assert producer_demo is not None, producer_body
                producer_screen = next((item for item in producer_demo.get('screens', []) if item.get('step') == 1), None)
                assert producer_screen is not None and producer_screen.get('produced') is True, producer_screen
                assert producer_screen.get('captured', {}).get('1280') is True, producer_screen
                assert producer_screen.get('captured', {}).get('1600') is False, producer_screen
                assert producer_demo.get('summary', {}).get('total') == 2, producer_demo.get('summary')
                assert producer_demo.get('summary', {}).get('produced') == 2, producer_demo.get('summary')
                assert producer_demo.get('summary', {}).get('captured') == 0, producer_demo.get('summary')
                partial_state['producer'] = {
                    'demoSummary': producer_demo.get('summary'),
                    'screenProduced': producer_screen.get('produced'),
                    'screenCaptured': producer_screen.get('captured'),
                    'errorCount': len(producer_body.get('errors', [])),
                    'errorNames': [item.get('name') for item in producer_body.get('errors', [])],
                }

                for width in (1280, 1600):
                    page.locator('#design-width').focus()
                    page.select_option('#design-width', str(width))
                    page.set_viewport_size({'width': width, 'height': 900})
                    assert_frame_geometry(width)
                    details = page.locator('.design-canvas details')
                    if not details.evaluate('element => element.open'):
                        details.locator('summary').click()
                    assert details.evaluate('element => element.open'), 'details disclosure closed before the top capture'
                    page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) canvas.scrollTop = 0; }")
                    path = browser_evidence / f'designs-partial@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                    page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) { const target = canvas.querySelector('details'); if (target) target.scrollIntoView({ block: 'start' }); } }")
                    assert details.evaluate('element => element.open'), 'details disclosure closed after scrolling'
                    expect(details).to_be_visible()
                    expect(details).to_contain_text('Capture: 1280px · Missing: 1600px')
                    expect(details).to_contain_text('designs/broken/design.json')
                    path = browser_evidence / f'designs-partial-details@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                if reference_html:
                    capture_reference('reference-79', details=True)
                page.locator('#design-width').focus()
                page.select_option('#design-width', '1280')

                # 44px, keyboard and 200% zoom reachability for the partial actions.
                page.set_viewport_size({'width': 1600, 'height': 900})
                controls = [page.locator('#find-record'), brief_primary, open_screen_link, page.locator('#design-width'),
                            page.get_by_role('button', name='Next screen', exact=True)]
                for control in controls:
                    box = control.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, (control, box)
                page.locator('#find-record').focus()
                reachable = []
                for _ in range(24):
                    reachable.append(active_control())
                    page.keyboard.press('Tab')
                reachable_text = [item['text'] for item in reachable if item]
                reachable_ids = [item['id'] for item in reachable if item]
                assert 'Open brief' in reachable_text and 'Open screen' in reachable_text, reachable_text
                assert 'Next screen' in reachable_text and 'design-width' in reachable_ids, (reachable_text, reachable_ids)
                page.evaluate("document.documentElement.style.zoom = '2'")
                page.wait_for_timeout(50)
                for control in controls:
                    control.scroll_into_view_if_needed()
                    box = control.bounding_box()
                    assert box and box['x'] >= 0 and box['y'] >= 0 and box['y'] < 900, (control, box)
                page.evaluate("document.documentElement.style.zoom = ''")
                passed('partial demo shows the exact capture-gap and index callout with a real frame, primary Open brief, secondary Open screen and named diagnostics')

                # Open screen reads the actual HTML; Open brief crosses the real Files route.
                with context.expect_page(timeout=5000) as popup_info:
                    open_screen_link.click()
                popup = popup_info.value
                popup.wait_for_load_state('domcontentloaded')
                assert 'workspace-view' in popup.url and '01-screen-1.html' in popup.url, popup.url
                assert 'Marker screen one' in popup.content()
                popup.close()
                brief_primary.click()
                expect(page).to_have_url(re.compile(r'#/files\?ws=fixture&source=workspace&path=designs%2Fdemo%2Fbrief\.md'))
                expect(page.locator('#file-content')).to_contain_text('Demo marker brief')
                page.go_back()
                wait_until(lambda: page.locator('#design-frame').count() == 1, 'frame after brief return')
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                assert params().get('id') == ['demo'] and params().get('path') == ['screens/01-screen-1.html'] and params().get('tab') == ['1280'], page.url
                expect(frame().locator('h1')).to_have_text('Marker screen one')
                page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                handle = page.locator('#design-frame').element_handle()
                nonce = frame().locator('html').get_attribute('data-nonce')
                heads = head_count()
                partial_state['navigation'] = {'popup': 'real-html', 'brief': 'real-files', 'route': 'preserved'}

                # Restore the 1600 capture: coverage becomes complete, unrelated index error stays.
                capture_1600 = Path(receipt['root']) / 'storage' / 'projects' / 'fixture' / 'designs' / 'demo' / 'captures' / '01-screen-1@1600.png'
                capture_1600.parent.mkdir(parents=True, exist_ok=True)
                capture_1600.write_bytes(PNG_1X1)
                demo_index = Path(receipt['root']) / 'storage' / 'projects' / 'fixture' / 'designs' / 'demo' / 'design.json'
                original_record = json.loads(demo_index.read_text())
                report['fixtureInputsDelta'] = {'restoredCapture': 'fixture/designs/demo/captures/01-screen-1@1600.png'}
                page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                wait_until(lambda: 'Capture coverage is complete for this screen.' in callout.text_content(), 'complete coverage callout')
                expect(callout).to_contain_text('1 design index could not be read.')
                expect(details).to_contain_text('Capture: 1280px and 1600px · Missing: none')
                expect(details).to_contain_text('designs/broken/design.json')
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == nonce
                assert head_count() == heads, 'capture restore triggered a HEAD'
                expect(page.locator('#design-width')).to_have_value('1280')

                # Null optional brief: explanation without a forged link, frame retained.
                without_brief = {key: value for key, value in original_record.items() if key != 'brief'}
                demo_index.write_text(json.dumps(without_brief))
                report['fixtureInputsDelta']['withoutBrief'] = without_brief
                page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                wait_until(lambda: 'No safe relative brief is recorded' in callout.text_content(), 'brief absence explanation')
                assert callout.get_by_role('link', name='Open brief', exact=True).count() == 0
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == nonce

                # Restore the brief and remove the unrelated broken index: callout clears.
                demo_index.write_text(json.dumps(original_record))
                broken_dir = Path(receipt['root']) / 'storage' / 'projects' / 'fixture' / 'designs' / 'broken'
                (broken_dir / 'design.json').unlink()
                broken_dir.rmdir()
                report['fixtureInputsDelta']['removedBrokenDirectory'] = 'fixture/designs/broken'
                page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                wait_until(lambda: page.locator('.design-canvas .ds-callout').count() == 0, 'callout cleared after recovery')
                expect(details).to_contain_text('Capture: 1280px and 1600px · Missing: none')
                assert (page.get_by_role('link', name='Open screen', exact=True).get_attribute('class') or '') == 'ds-btn ds-btn--primary'
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == nonce
                assert head_count() == heads, 'recovery triggered a HEAD'
                assert handle.evaluate('(el) => el.isConnected')
                partial_state['recovery'] = {'callout': 'none', 'openScreen': 'primary', 'nonce': nonce}

                # Same-data poll stays silent on the single announcer.
                announcer = page.locator('main [role="status"][aria-atomic="true"]')
                announcement_before = announcer.text_content()
                page.clock.fast_forward(5000)
                page.wait_for_timeout(50)
                expect(announcer).to_have_count(1)
                assert announcer.text_content() == announcement_before, 'same-data poll changed the announcement'
                partial_state['pollSilent'] = announcement_before

                # Real other scope with only an invalid index: cold entry, observable prerequisites.
                page.goto('about:blank')
                page.goto(base + '/#/designs?ws=other', wait_until='domcontentloaded')
                partial_state['otherEntry'] = {'url': page.url, 'params': dict(params())}
                other_api = context.request.get(base + '/api/workspace-designs?id=other')
                assert other_api.ok, other_api.status
                other_body = other_api.json()
                assert other_body.get('designs') == [], other_body
                assert other_body.get('errors'), other_body
                partial_state['otherProducer'] = {
                    'designs': other_body.get('designs'),
                    'errorCount': len(other_body.get('errors', [])),
                    'errorNames': [item.get('name') for item in other_body.get('errors', [])],
                }
                assert params().get('id') is None, page.url
                wait_until(lambda: 'Design indexes could not be read' in page.locator('.detail-body').text_content(), 'other all-invalid detail')
                expect(page.locator('.list-caption')).to_have_text('Design indexes could not be read')
                expect(page.locator('.detail-body')).to_contain_text('1 design index could not be read. Fix them in the workspace, then refresh.')
                expect(page.locator('.detail-body')).to_contain_text('designs/broken-other/design.json')
                assert 'No designs recorded' not in page.locator('main').inner_text()
                assert 'No design selected' not in page.locator('main').inner_text()
                assert page.locator('#design-frame').count() == 0
                assert page.locator('#design-width').count() == 0
                expect(page.locator('.detail-body').get_by_role('button', name='Refresh designs', exact=True)).to_be_visible()
                expect(page.locator('.detail-body').get_by_role('link', name='Open files', exact=True)).to_be_visible()
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    path = browser_evidence / f'designs-partial-invalid@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                page.locator('.detail-body').get_by_role('link', name='Open files', exact=True).click()
                expect(page).to_have_url(re.compile(r'#/files\?ws=other&source=workspace'))
                page.go_back()
                wait_until(lambda: 'Design indexes could not be read' in page.locator('.detail-body').text_content(), 'diagnostics after back')
                page.locator('.detail-body').get_by_role('button', name='Refresh designs', exact=True).click()
                page.clock.fast_forward(50)
                expect(page.locator('.detail-body')).to_contain_text('designs/broken-other/design.json')
                assert params().get('id') is None, page.url
                partial_state['otherInvalid'] = {'rows': 0, 'diagnostics': 'kept', 'fabricated': False}
                passed('other scope with zero valid designs and an invalid index keeps diagnostics with safe Refresh designs/Open files actions and no fabricated selection')

                report['partialState'] = partial_state
                assert not report['pageErrors'], report['pageErrors']
                assert not report['consoleErrors'], report['consoleErrors']
                unexpected = [failure for failure in report['requestFailures'] if 'ERR_ABORTED' not in failure['failure']]
                assert not unexpected, unexpected
                mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
                assert not mutations, f'mutation requests observed: {mutations}'
                report['status'] = 'passed'
                raise CaseComplete()

            if case == 'error':
                error_state = {}
                injected = []
                modes = {'index503': True, 'head503': False}

                def wait_until(condition, label, timeout=5):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if condition():
                            return
                        page.wait_for_timeout(25)
                    raise AssertionError(f'{label} not observed')

                def screen_gets(fragment):
                    return len([r for r in requests if r['method'] == 'GET' and fragment in r['url']])

                page.clock.install(time=datetime(2026, 1, 1, 12, 0, 0))
                page.clock.pause_at(datetime(2026, 1, 1, 12, 0, 0))

                def substitute_503(route, kind):
                    if kind == 'index' and modes['index503'] and '/api/workspace-designs' in route.request.url and 'id=fixture' in route.request.url:
                        injected.append({'kind': kind, 'method': route.request.method, 'url': route.request.url, 'status': 503})
                        route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Fixture generic 503'}))
                    elif kind == 'head' and modes['head503'] and route.request.method == 'HEAD' and 'workspace-view' in route.request.url:
                        injected.append({'kind': kind, 'method': route.request.method, 'url': route.request.url, 'status': 503})
                        route.fulfill(status=503, content_type='text/html', body='')
                    else:
                        route.continue_()
                page.route('**/api/workspace-designs**', lambda route: substitute_503(route, 'index'))
                page.route('**/workspace-view/**', lambda route: substitute_503(route, 'head'))

                # Cold deep link with an injected initial index 503.
                error_route = '#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1600&q=demo'
                page.goto(base + '/' + error_route, wait_until='domcontentloaded')
                wait_until(lambda: any(item['kind'] == 'index' for item in injected), 'initial index 503 injected')
                expect(page.locator('.list-caption')).to_have_text('Designs unavailable')
                expect(page.locator('.list-pane')).to_contain_text('Designs could not be read')
                expect(page.locator('.list-pane')).to_contain_text('The host did not return a usable result. Your selection is kept.')
                expect(page.locator('.design-canvas')).to_contain_text('Designs could not be read')
                initial_refresh = page.locator('.design-canvas').get_by_role('button', name='Refresh designs', exact=True)
                expect(initial_refresh).to_be_visible()
                expect(initial_refresh).to_have_class(re.compile(r'ds-btn--primary'))
                expect(page.locator('#design-width')).to_have_count(0)
                expect(page.locator('#design-frame')).to_have_count(0)
                assert page.locator('main').inner_text().count('No designs recorded') == 0
                assert params().get('ws') == ['fixture'] and params().get('id') == ['demo'], page.url
                assert params().get('path') == ['screens/01-screen-1.html'] and params().get('tab') == ['1600'] and params().get('q') == ['demo'], page.url
                expect(page.locator('main [role="status"][aria-atomic="true"]')).to_have_text('Designs could not be read.')
                report['errorCaptureState'] = []
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    path = browser_evidence / f'designs-error-initial@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                    report['errorCaptureState'].append({'state': 'initial-index-error', 'width': width, 'capture': str(path), 'url': page.url})
                modes['index503'] = False
                initial_refresh.click()
                expect(frame().locator('h1')).to_have_text('Marker screen one')
                assert frame().locator('html').get_attribute('data-marker') == '42'
                assert any('/marker.js' in r['url'] for r in requests), 'marker script was not requested after recovery'
                assert params().get('ws') == ['fixture'] and params().get('id') == ['demo'], page.url
                assert params().get('path') == ['screens/01-screen-1.html'] and params().get('tab') == ['1600'] and params().get('q') == ['demo'], page.url
                assert page.locator('.list-pane').inner_text().count('Designs could not be read') == 0
                passed('cold initial index 503 preserves the deep-link route and shows the exact list/detail recovery; Refresh designs renders the real marker viewer')

                # Retained index 503 via the App-owned Shell Refresh state.
                page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                held_handle = page.locator('#design-frame').element_handle()
                held_nonce = frame().locator('html').get_attribute('data-nonce')
                heads_before = head_count()
                url_before = page.url
                modes['index503'] = True
                page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                wait_until(lambda: 'Last known catalog' in page.locator('.list-caption').text_content(), 'retained index error caption')
                expect(page.locator('.list-caption')).to_have_text('Last known catalog: 1 of 2 design packages')
                expect(page.locator('.object-head')).to_contain_text('Not confirmed')
                expect(page.locator('.list-pane')).to_contain_text('Designs could not be read')
                expect(page.locator('.list-pane')).to_contain_text('The host did not return a usable result. Your selection is kept.')
                expect(page.locator('.list-pane').get_by_role('button', name='Refresh designs', exact=True)).to_be_visible()
                announcer = page.locator('main [role="status"][aria-atomic="true"]')
                expect(announcer).to_have_count(1)
                expect(announcer).to_have_text('Designs could not be read.')
                retained_announcement = announcer.text_content()
                assert page.url == url_before, page.url
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == held_nonce
                assert head_count() == heads_before, 'retained index error triggered a HEAD'
                page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                page.clock.fast_forward(50)
                assert announcer.text_content() == retained_announcement, 'repeated failed refresh changed the announcement'
                expect(page.locator('.list-caption')).to_have_text('Last known catalog: 1 of 2 design packages')
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    path = browser_evidence / f'designs-error-retained@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                    report['errorCaptureState'].append({'state': 'retained-index-error', 'width': width, 'capture': str(path), 'url': page.url})
                modes['index503'] = False
                demo_index = Path(receipt['root']) / 'storage' / 'projects' / 'fixture' / 'designs' / 'demo' / 'design.json'
                changed_record = {**report['seededDesigns']['fixture/demo'], 'title': 'Design fixture error recovered'}
                demo_index.write_text(json.dumps(changed_record))
                report['fixtureInputsDelta'] = {'fixture/designs/demo/design.json': changed_record}
                page.locator('.list-pane').get_by_role('button', name='Refresh designs', exact=True).click()
                expect(page.locator('.list-pane .record').filter(has_text='Design fixture error recovered')).to_be_visible()
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture error recovered')
                expect(page.locator('.list-caption')).to_have_text('1 of 2 design packages')
                expect(page.locator('.object-head')).not_to_contain_text('Not confirmed')
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == held_nonce
                assert held_handle.evaluate('(el) => el.isConnected'), 'index recovery remounted the frame'
                assert head_count() == heads_before, 'index recovery triggered a HEAD'
                passed('retained index 503 keeps the route, frame, single announcer and silence across repeats; local Refresh designs consumes the changed real title without remount or HEAD')

                # Combined retained index 503 and step-2 HEAD 503 (reference-78 state).
                page.locator('#find-record').fill('')
                page.clock.fast_forward(50)
                expect(page.locator('.list-pane .record')).to_have_count(2)
                modes['index503'] = True
                modes['head503'] = True
                page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                wait_until(lambda: 'Last known catalog' in page.locator('.list-caption').text_content(), 'combined retained index error')
                expect(page.locator('.list-caption')).to_have_text('Last known catalog: 2 design packages')
                page.get_by_role('button', name='Next screen', exact=True).click()
                page.wait_for_function("() => location.hash.includes('path=screens%2F02-screen-2.html')")
                wait_until(lambda: page.locator('.design-canvas').get_by_role('button', name='Retry screen', exact=True).count() == 1, 'screen failure preview')
                expect(page.locator('.design-canvas')).to_contain_text('Screen could not be read')
                expect(page.locator('.design-canvas')).to_contain_text('The design index and selected step are kept. Retry the screen file.')
                retry_button = page.locator('.design-canvas').get_by_role('button', name='Retry screen', exact=True)
                expect(page.locator('.design-canvas').get_by_role('button')).to_have_count(1)
                expect(page.locator('.list-pane .record')).to_have_count(2)
                expect(page.locator('.object-head h2')).to_have_text('Design fixture error recovered')
                expect(page.locator('.object-head')).to_contain_text('Not confirmed')
                expect(page.get_by_text('Screen 2 · Screen two', exact=True)).to_be_visible()
                expect(page.locator('#design-width')).to_have_value('1600')
                details = page.locator('.design-canvas details')
                expect(details).to_be_visible()
                assert details.evaluate('element => element.open') is False, 'disclosure was open in the error state'
                open_screen = page.get_by_role('button', name='Open screen', exact=True)
                expect(open_screen).to_be_disabled()
                expect(open_screen).to_have_attribute('title', 'The recorded screen file could not be read.')
                for guess in ('permission', 'denied', 'removed', 'no longer exists'):
                    assert guess not in page.locator('main').inner_text().lower(), guess
                assert page.locator('#design-frame').count() == 0
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    path = browser_evidence / f'designs-error@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                    report['errorCaptureState'].append({'state': 'combined-index-head-error', 'width': width, 'capture': str(path), 'url': page.url})
                if reference_html:
                    capture_reference('reference-78', details=False, wait_for_frame=False, select_width=False)
                passed('combined retained index and HEAD 503 renders the reference-78 preview with retained rows, disabled Open screen and sole Retry screen')

                # a11y in the error state: 44px, keyboard and zoom reachability.
                page.set_viewport_size({'width': 1600, 'height': 900})
                controls = [page.locator('#find-record'), page.get_by_role('button', name='Previous screen', exact=True),
                            page.get_by_role('button', name='Next screen', exact=True), retry_button,
                            page.locator('#design-width')]
                for control in controls:
                    box = control.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, (control, box)
                page.locator('#find-record').focus()
                reachable = []
                for _ in range(24):
                    reachable.append(active_control())
                    page.keyboard.press('Tab')
                reachable_text = [item['text'] for item in reachable if item]
                reachable_ids = [item['id'] for item in reachable if item]
                assert 'Previous screen' in reachable_text and 'Next screen' in reachable_text, reachable_text
                assert 'Retry screen' in reachable_text, reachable_text
                assert 'design-width' in reachable_ids, reachable_ids
                page.evaluate("document.documentElement.style.zoom = '2'")
                page.wait_for_timeout(50)
                for control in controls:
                    control.scroll_into_view_if_needed()
                    box = control.bounding_box()
                    assert box and box['x'] >= 0 and box['y'] >= 0 and box['y'] < 900, (control, box)
                page.evaluate("document.documentElement.style.zoom = ''")
                passed('error-state search, step, width and Retry screen controls meet 44px, stay keyboard reachable and survive 200% zoom')

                # Failed explicit retry while the HEAD is still 503.
                heads_before_failed = head_count()
                gets_before = screen_gets('02-screen-2.html')
                retry_button.click()
                wait_until(lambda: head_count() == heads_before_failed + 1, 'failed retry HEAD')
                page.clock.fast_forward(400)
                expect(page.locator('.design-canvas')).to_contain_text('Screen could not be read')
                assert page.locator('#design-frame').count() == 0, 'failed retry loaded a frame'
                assert screen_gets('02-screen-2.html') == gets_before, 'failed retry loaded the screen'
                assert 'No designs recorded' not in page.locator('main').inner_text()
                assert 'No design selected' not in page.locator('main').inner_text()
                assert params().get('path') == ['screens/02-screen-2.html'] and params().get('tab') == ['1600'], page.url
                passed('a failed Retry screen keeps the same route and preview, adds exactly one HEAD and no frame GET or fabricated empty')

                # Allowed HEAD: one HEAD plus one frame/marker load; the nonce advances once.
                modes['head503'] = False
                heads_before_success = head_count()
                markers_before = marker_loads()
                gets_before_success = screen_gets('02-screen-2.html')
                page.locator('.design-canvas').get_by_role('button', name='Retry screen', exact=True).click()
                expect(frame().locator('h1')).to_have_text('Marker screen two')
                assert frame().locator('html').get_attribute('data-marker') == '42'
                assert head_count() == heads_before_success + 1, 'successful retry HEAD count'
                assert marker_loads() == markers_before + 1, 'successful retry marker load'
                assert screen_gets('02-screen-2.html') == gets_before_success + 1, 'successful retry screen load'
                identity = page.locator('#design-frame-wrap').get_attribute('data-viewer-identity')
                assert identity and identity.split('\u0000')[-1] == '1', identity
                expect(page.locator('.list-caption')).to_have_text('Last known catalog: 2 design packages')
                expect(page.locator('.object-head')).to_contain_text('Not confirmed')
                page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                recovered_handle = page.locator('#design-frame').element_handle()
                recovered_nonce = frame().locator('html').get_attribute('data-nonce')
                heads_before_recovery = head_count()
                modes['index503'] = False
                page.locator('.list-pane').get_by_role('button', name='Refresh designs', exact=True).click()
                page.clock.fast_forward(50)
                expect(page.locator('.list-caption')).to_have_text('2 design packages')
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == recovered_nonce
                assert recovered_handle.evaluate('(el) => el.isConnected')
                assert head_count() == heads_before_recovery, 'index recovery added a HEAD'
                page.locator('#design-width').focus()
                page.select_option('#design-width', '1280')
                assert page.evaluate("document.activeElement && document.activeElement.id") == 'design-width', 'width change lost control focus'
                passed('an allowed Retry screen adds one HEAD and one frame/marker load, advances the viewer identity once, and the confirmed frame survives index recovery with step/width focus retained')

                allowed_console = [message for message in report['consoleErrors'] if '503' in message]
                unexpected_console = [message for message in report['consoleErrors'] if '503' not in message]
                assert not unexpected_console, unexpected_console
                assert not report['pageErrors'], report['pageErrors']
                unexpected = [failure for failure in report['requestFailures'] if 'ERR_ABORTED' not in failure['failure']]
                assert not unexpected, unexpected
                mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
                assert not mutations, f'mutation requests observed: {mutations}'
                report['errorState'] = {
                    'injected': injected,
                    'allowedConsoleDiagnostics': allowed_console,
                    'captureState': report['errorCaptureState'],
                    'retainedAnnouncement': retained_announcement,
                    'retryIdentity': identity,
                }
                report['status'] = 'passed'
                raise CaseComplete()

            if case == 'loading':
                loading_state = {}
                held_index = []
                held_heads = []
                index_hold = {'on': True}

                def wait_until(condition, label, timeout=5):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if condition():
                            return
                        page.wait_for_timeout(25)
                    raise AssertionError(f'{label} not observed')

                def release_route(held):
                    try:
                        response = held.fetch(timeout=5000)
                        held.fulfill(response=response)
                        return 'fulfilled'
                    except Exception as error:
                        try:
                            held.continue_()
                            return f'continued-after:{error}'
                        except Exception as nested:
                            return f'aborted:{nested}'

                def hold_fixture_index(route):
                    if index_hold['on'] and '/api/workspace-designs' in route.request.url and 'id=fixture' in route.request.url:
                        held_index.append(route)
                    else:
                        route.continue_()
                page.route('**/api/workspace-designs**', hold_fixture_index)

                page.clock.install(time=datetime(2026, 1, 1, 12, 0, 0))
                page.clock.pause_at(datetime(2026, 1, 1, 12, 0, 0))

                # Scenario 1: held initial index; 299ms reserves the screen-77
                # footprint without bars, 300ms reveals the labelled skeletons.
                page.goto(base + '/#/designs?ws=fixture', wait_until='domcontentloaded')
                wait_until(lambda: bool(held_index), 'initial index request entered')
                page.clock.fast_forward(100)
                search = page.locator('#find-record')
                search.fill('fixture')
                page.wait_for_function("() => location.hash.includes('q=fixture')")
                page.clock.fast_forward(199)
                assert page.locator('.list-pane .skeletons .skeleton span').count() == 0, 'list bars flashed before 300ms'
                assert page.locator('.design-canvas .skeleton span').count() == 0, 'canvas bars flashed before 300ms'
                expect(page.locator('.list-caption')).to_have_text('Reading designs…')
                expect(page.get_by_role('heading', name='Design screen', exact=True)).to_be_visible()
                expect(page.locator('.design-toolbar')).to_have_count(0)
                expect(page.locator('#design-frame')).to_have_count(0)
                initial_region = page.get_by_role('region', name='Reading design index and screen', exact=True)
                expect(initial_region).to_be_visible()
                expect(initial_region).to_have_attribute('aria-busy', 'true')
                loading_state['before300'] = {'listBars': 0, 'canvasBars': 0, 'caption': 'Reading designs…'}
                page.clock.fast_forward(1)
                list_region = page.locator('.list-pane').get_by_role('region', name='Reading designs', exact=True)
                expect(list_region).to_be_visible()
                expect(list_region).to_have_attribute('aria-busy', 'true')
                expect(page.locator('.list-pane .skeleton span').first).to_be_visible()
                expect(page.locator('.design-canvas .skeleton span').first).to_be_visible()
                expect(page.locator('main [role="status"][aria-atomic="true"]')).to_have_text('Reading designs.')
                expect(page.locator('.list-caption')).to_have_text('Reading designs…')
                assert params().get('ws') == ['fixture'], page.url
                loading_state['at300'] = {'listBars': page.locator('.list-pane .skeleton span').count(),
                                          'canvasBars': page.locator('.design-canvas .skeleton span').count()}
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.wait_for_timeout(50)
                    path = browser_evidence / f'designs-loading@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                if reference_html:
                    capture_reference('reference-77', details=False, wait_for_frame=False, select_width=False)
                loading_state['release'] = release_route(held_index.pop(0))
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                expect(page.locator('#design-width')).to_have_value('1280')
                expect(frame().locator('h1')).to_have_text('Marker screen one')
                assert frame().locator('html').get_attribute('data-marker') == '42'
                assert any('/marker.js' in r['url'] for r in requests), 'relative marker script was not requested'
                page.wait_for_function("() => location.hash.includes('id=demo') && location.hash.includes('tab=1280')")
                assert params().get('path') == ['screens/01-screen-1.html'], page.url
                assert params().get('q') == ['fixture'], 'q did not survive the held response'
                loading_state['querySurvived'] = params().get('q')
                passed('held initial index reserves the screen-77 footprint without bars, shows labelled skeletons only at 300ms, and renders the real step-1 viewer on release')

                # Scenario 2: a release below the threshold adds no skeleton bars.
                held_index.clear()
                page.goto('about:blank')
                page.goto(base + '/#/designs?ws=fixture', wait_until='domcontentloaded')
                wait_until(lambda: bool(held_index), 'fast index request entered')
                page.evaluate("""() => {
                  window.__skeletonAdditions = 0;
                  window.__readingAnnouncements = 0;
                  new MutationObserver(records => {
                    for (const record of records) for (const node of record.addedNodes) {
                      if (node.nodeType !== 1 || !node.querySelector) continue;
                      if (node.matches('.skeleton span') || node.querySelector('.skeleton span')) window.__skeletonAdditions += 1;
                    }
                  }).observe(document.body, {childList: true, subtree: true});
                  const announcer = document.querySelector('main [role="status"][aria-atomic="true"]');
                  if (announcer) new MutationObserver(() => {
                    if (announcer.textContent === 'Reading designs.') window.__readingAnnouncements += 1;
                  }).observe(announcer, {childList: true, characterData: true, subtree: true});
                }""")
                page.clock.fast_forward(100)
                release_route(held_index.pop(0))
                expect(frame().locator('h1')).to_have_text('Marker screen one')
                page.clock.fast_forward(1000)
                additions = page.evaluate('() => window.__skeletonAdditions')
                reading_announcements = page.evaluate('() => window.__readingAnnouncements')
                assert additions == 0, additions
                assert reading_announcements == 0, reading_announcements
                assert page.locator('.list-pane .skeletons .skeleton span').count() == 0
                expect(page.locator('main [role="status"][aria-atomic="true"]')).to_have_text('Screen 1 of 2 · Design fixture · Screen one')
                loading_state['fastRelease'] = {'skeletonAdditions': additions, 'readingAnnouncements': reading_announcements}
                passed('an index released below the 300ms threshold adds no skeleton bars or delayed announcement and goes straight to the real viewer')

                # Scenario 3: a held step-2 HEAD shows the frame-only checking
                # footprint after 300ms while list/header/step/width stay usable.
                held_heads.clear()
                def hold_head(route):
                    if route.request.method == 'HEAD' and 'workspace-view' in route.request.url:
                        held_heads.append(route)
                    else:
                        route.continue_()
                page.route('**/workspace-view/**', hold_head)
                page.get_by_role('button', name='Next screen', exact=True).click()
                page.wait_for_function("() => location.hash.includes('path=screens%2F02-screen-2.html')")
                wait_until(lambda: bool(held_heads), 'step-2 HEAD entered')
                page.clock.fast_forward(299)
                assert page.locator('.design-canvas .skeleton span').count() == 0, 'checking bars flashed before 300ms'
                expect(page.locator('.design-toolbar')).to_have_count(1)
                expect(page.locator('#design-width')).to_have_value('1280')
                page.clock.fast_forward(1)
                checking_region = page.locator('.design-canvas').get_by_role('region', name='Checking screen', exact=True)
                expect(checking_region).to_be_visible()
                expect(checking_region).to_have_attribute('aria-busy', 'true')
                expect(page.locator('.design-canvas .skeleton span').first).to_be_visible()
                expect(page.locator('#design-width')).to_have_value('1280')
                expect(page.get_by_role('button', name='Previous screen', exact=True)).to_have_attribute('aria-disabled', 'false')
                open_screen = page.get_by_role('button', name='Open screen', exact=True)
                expect(open_screen).to_be_disabled()
                expect(open_screen).to_have_attribute('title', 'Checking that the recorded screen file is available…')
                expect(page.locator('main [role="status"][aria-atomic="true"]')).to_have_text('Checking screen.')
                loading_state['headHold'] = {'before300Bars': 0, 'at300Bars': page.locator('.design-canvas .skeleton span').count()}
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.wait_for_timeout(50)
                    path = browser_evidence / f'designs-loading-frame@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                page.set_viewport_size({'width': 1600, 'height': 900})
                controls = [page.locator('#find-record'), page.get_by_role('button', name='Previous screen', exact=True),
                            page.get_by_role('button', name='Next screen', exact=True), page.locator('#design-width')]
                for control in controls:
                    box = control.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, (control, box)
                page.locator('#find-record').focus()
                reachable = []
                for _ in range(20):
                    reachable.append(active_control())
                    page.keyboard.press('Tab')
                reachable_text = [item['text'] for item in reachable if item]
                reachable_ids = [item['id'] for item in reachable if item]
                assert 'Previous screen' in reachable_text and 'Next screen' in reachable_text, reachable_text
                assert 'design-width' in reachable_ids, reachable_ids
                page.evaluate("document.documentElement.style.zoom = '2'")
                page.wait_for_timeout(50)
                for control in controls:
                    control.scroll_into_view_if_needed()
                    box = control.bounding_box()
                    assert box and box['x'] >= 0 and box['y'] >= 0 and box['y'] < 900, (control, box)
                page.evaluate("document.documentElement.style.zoom = ''")
                loading_state['headRelease'] = release_route(held_heads.pop(0))
                expect(frame().locator('h1')).to_have_text('Marker screen two')
                assert frame().locator('html').get_attribute('data-marker') == '42'
                page.unroute('**/workspace-view/**', hold_head)
                passed('a held step-2 HEAD keeps list/header/step/width usable, shows the labelled checking skeleton only after 300ms, explains the disabled Open screen, and renders the real step-2 frame on release')

                # Scenario 4: a late previous-identity HEAD cannot replace the frame.
                held_heads.clear()
                def hold_old_head(route):
                    if route.request.method == 'HEAD' and '01-screen-1.html' in route.request.url:
                        held_heads.append(route)
                    else:
                        route.continue_()
                page.route('**/workspace-view/**', hold_old_head)
                page.get_by_role('button', name='Previous screen', exact=True).click()
                wait_until(lambda: bool(held_heads), 'previous step HEAD entered')
                page.get_by_role('button', name='Next screen', exact=True).click()
                expect(frame().locator('h1')).to_have_text('Marker screen two')
                page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                race_handle = page.locator('#design-frame').element_handle()
                race_nonce = frame().locator('html').get_attribute('data-nonce')
                page.clock.fast_forward(400)
                race_release = release_route(held_heads.pop(0))
                page.clock.fast_forward(200)
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable', 'late old HEAD replaced the frame'
                assert frame().locator('html').get_attribute('data-nonce') == race_nonce
                assert race_handle.evaluate('(el) => el.isConnected'), 'late old HEAD detached the frame'
                expect(frame().locator('h1')).to_have_text('Marker screen two')
                loading_state['cancellationRace'] = {'release': race_release, 'nonce': race_nonce, 'frameConnected': True}
                page.unroute('**/workspace-view/**', hold_old_head)
                passed('a late previous-identity HEAD release cannot clear or replace the current step-2 frame')

                # Scenario 5: a held same-scope index refresh keeps the mounted frame
                # while consuming an actually changed index response.
                page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                refresh_handle = page.locator('#design-frame').element_handle()
                refresh_nonce = frame().locator('html').get_attribute('data-nonce')
                heads_before = head_count()
                changed_record = {**report['seededDesigns']['fixture/demo'], 'title': 'Design fixture refreshed'}
                demo_index = Path(receipt['root']) / 'storage' / 'projects' / 'fixture' / 'designs' / 'demo' / 'design.json'
                demo_index.write_text(json.dumps(changed_record))
                report['fixtureInputsDelta'] = {'fixture/designs/demo/design.json': changed_record}
                page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                wait_until(lambda: bool(held_index), 'same-scope index refresh entered')
                page.clock.fast_forward(300)
                assert page.locator('.list-pane .skeletons .skeleton span').count() == 0, 'refresh flashed list bars over retained data'
                expect(page.locator('#design-width')).to_have_value('1280')
                assert params().get('id') == ['demo'] and params().get('path') == ['screens/02-screen-2.html'] and params().get('tab') == ['1280'], page.url
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == refresh_nonce
                assert head_count() == heads_before, 'same-scope refresh added a produced-screen HEAD'
                loading_state['revalidateRelease'] = release_route(held_index.pop(0))
                page.clock.fast_forward(400)
                expect(page.locator('.list-pane .record').filter(has_text='Design fixture refreshed')).to_be_visible()
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture refreshed')
                refreshed_announcement = 'Screen 2 of 2 · Design fixture refreshed · Screen two'
                announcer = page.locator('main [role="status"][aria-atomic="true"]')
                expect(announcer).to_have_text(refreshed_announcement)
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == refresh_nonce
                assert refresh_handle.evaluate('(el) => el.isConnected')
                assert head_count() == heads_before, 'same-scope refresh added a produced-screen HEAD after release'
                page.locator('#design-width').focus()
                page.select_option('#design-width', '1600')
                page.clock.fast_forward(50)
                expect(announcer).to_have_text(refreshed_announcement)
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == refresh_nonce
                loading_state['revalidate'] = {'frameConnected': True, 'headReadsUnchanged': True, 'announcement': refreshed_announcement}
                passed('a held same-scope index refresh consumes the changed title, keeps the iframe/route and repeats the same announcement on an unrelated width change')

                # Scenario 6: a scope switch before the threshold cancels the old timer.
                held_index.clear()
                page.goto('about:blank')
                page.goto(base + '/#/designs?ws=fixture', wait_until='domcontentloaded')
                wait_until(lambda: bool(held_index), 'scope-switch fixture index entered')
                page.clock.fast_forward(299)
                page.get_by_label('Workspace scope').select_option('other')
                expect(page.locator('.list-pane .record')).to_have_count(1)
                expect(page.locator('.list-pane .record')).to_contain_text('Other fixture')
                page.clock.fast_forward(400)
                assert page.locator('.list-pane .skeletons .skeleton span').count() == 0, 'old scope skeleton appeared after the threshold'
                assert page.locator('.design-canvas .skeleton span').count() == 0
                scope_release = release_route(held_index.pop(0))
                page.clock.fast_forward(200)
                assert 'ws=other' in page.url, page.url
                expect(page.locator('.list-pane .record')).to_have_count(1)
                expect(page.locator('.list-pane .record')).to_contain_text('Other fixture')
                loading_state['scopeSwitch'] = {'release': scope_release, 'rows': 1}
                page.unroute('**/api/workspace-designs**', hold_fixture_index)
                passed('a scope switch before the threshold cancels the old initial timer and the fast other response never shows the old skeleton')

                report['loadingState'] = loading_state
                report['intentionalWaits'] = ['controlled 300ms threshold advances for the initial index and produced HEAD regions']
                assert not report['pageErrors'], report['pageErrors']
                assert not report['consoleErrors'], report['consoleErrors']
                unexpected = [failure for failure in report['requestFailures'] if 'ERR_ABORTED' not in failure['failure']]
                assert not unexpected, unexpected
                mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
                assert not mutations, f'mutation requests observed: {mutations}'
                report['status'] = 'passed'
                raise CaseComplete()

            if case == 'unproduced':
                # Cold link enters the real destination; the planned design is
                # selected through its row, never a preselected store.
                page.goto(base + '/#/designs?ws=fixture', wait_until='domcontentloaded')
                expect(page.locator('.list-caption')).to_have_text('5 design packages')
                page.locator('.list-pane .record').filter(has_text='Planned fixture').click()
                expect(page.locator('#design-detail-heading')).to_have_text('Planned fixture')
                page.wait_for_function("() => location.hash.includes('path=screens%2F01-ready.html')")
                assert params().get('ws') == ['fixture'] and params().get('id') == ['planned'], page.url
                assert params().get('path') == ['screens/01-ready.html'] and params().get('tab') == ['1280'], page.url
                expect(frame().locator('h1')).to_have_text('Produced ready screen')
                planned_request = f"{base}{workspace_view}Zml4dHVyZQ/designs/planned/screens/02-kickoff.html"
                assert not any(planned_request in item['url'] for item in requests), 'planned file was requested before selection'
                heads_before = head_count()

                # Next enters the planned step: identity is preserved, the exact
                # job and planned details render, and the missing HTML is never
                # probed or framed.
                page.get_by_role('button', name='Next screen', exact=True).click()
                page.wait_for_function("() => location.hash.includes('path=screens%2F02-kickoff.html')")
                assert params().get('ws') == ['fixture'] and params().get('id') == ['planned'], page.url
                assert params().get('path') == ['screens/02-kickoff.html'] and params().get('tab') == ['1280'], page.url
                expect(page.locator('#design-detail-heading')).to_have_text('Planned fixture')
                expect(page.get_by_text('Screen 2 · Kickoff planned', exact=True)).to_be_visible()
                canvas = page.locator('.design-canvas')
                empty = canvas.locator('.empty')
                expect(empty).to_contain_text('Screen 2 has not been produced')
                expect(empty).to_contain_text('Kickoff planned · Choose where a new fixture discussion should run.')
                expect(empty).to_contain_text('The planned screen is recorded; its HTML file does not exist yet.')
                open_screen = page.get_by_role('button', name='Open screen', exact=True)
                expect(open_screen).to_be_disabled()
                assert 'Screen 2 has not been produced' in (open_screen.get_attribute('title') or ''), open_screen.get_attribute('title')
                assert page.locator('#design-frame').count() == 0, 'planned step mounted the frame'
                assert not any(planned_request in item['url'] for item in requests), 'planned step was probed or framed'
                assert head_count() == heads_before, 'planned step added a produced-screen HEAD'
                planned_details = canvas.locator('details')
                expect(planned_details.locator('summary')).to_have_text('Planned screen details')
                if not planned_details.evaluate('element => element.open'):
                    planned_details.locator('summary').click()
                expect(planned_details).to_contain_text('Produced: No')
                expect(planned_details).to_contain_text('Captured: 1280px')
                assert '1600px' not in planned_details.inner_text(), planned_details.inner_text()
                passed('Next enters a planned step: ws/id/path/tab preserved, exact job, disabled Open screen, Produced: No with truthful captures, no HEAD or iframe request')

                # Previous returns to the produced step; Next comes back.
                page.get_by_role('button', name='Previous screen', exact=True).click()
                page.wait_for_function("() => location.hash.includes('path=screens%2F01-ready.html')")
                expect(frame().locator('h1')).to_have_text('Produced ready screen')
                page.get_by_role('button', name='Next screen', exact=True).click()
                page.wait_for_function("() => location.hash.includes('path=screens%2F02-kickoff.html')")
                expect(canvas.locator('.empty')).to_contain_text('Screen 2 has not been produced')

                # Open brief follows the real Files route and reads real bytes.
                brief_link = canvas.get_by_role('link', name='Open brief', exact=True)
                expect(brief_link).to_have_attribute('href', '#/files?ws=fixture&source=workspace&path=designs%2Fplanned%2Fbrief.md')
                brief_link.click()
                expect(page).to_have_url(re.compile(r'#/files\?ws=fixture&source=workspace&path=designs%2Fplanned%2Fbrief\.md'))
                expect(page.locator('#file-content')).to_contain_text('Planned fixture brief')
                brief_reader = context.request.get(base + '/api/workspace-file?id=fixture&file=designs%2Fplanned%2Fbrief.md')
                assert brief_reader.ok and 'Planned fixture brief' in brief_reader.text(), brief_reader.status
                passed('Open brief reaches the real Files route and the fixture brief bytes read through the real workspace-file reader')

                # Missing and unsafe briefs explain the absence without a link.
                for slug, title, path, job in (
                    ('missing-brief', 'Missing brief fixture', 'screens/01-no-brief.html', 'Explain the missing brief state'),
                    ('unsafe-brief', 'Unsafe brief fixture', 'screens/01-unsafe-brief.html', 'Explain the unsafe brief state'),
                ):
                    page.goto(f'{base}/#/designs?ws=fixture&id={slug}&path={path.replace("/", "%2F")}&tab=1280', wait_until='domcontentloaded')
                    expect(page.locator('#design-detail-heading')).to_have_text(title)
                    empty = page.locator('.design-canvas .empty')
                    expect(empty).to_contain_text('Screen 1 has not been produced')
                    expect(empty).to_contain_text(job)
                    expect(empty).to_contain_text('No safe relative brief is recorded')
                    assert empty.get_by_role('link', name='Open brief').count() == 0, slug
                    assert 'Open brief' not in empty.inner_text(), slug
                passed('missing and unsafe briefs render explanatory text with no invented file link')

                # Width stays available and focused on the planned step; no
                # generation control is offered.
                page.goto(base + '/#/designs?ws=fixture&id=planned&path=screens%2F02-kickoff.html&tab=1280', wait_until='domcontentloaded')
                expect(page.locator('.design-canvas .empty')).to_contain_text('Screen 2 has not been produced')
                page.locator('#design-width').focus()
                page.select_option('#design-width', '1600')
                assert params().get('path') == ['screens/02-kickoff.html'] and params().get('tab') == ['1600'], page.url
                expect(page.locator('.design-canvas .empty')).to_contain_text('Screen 2 has not been produced')
                active = active_control()
                assert active and active['id'] == 'design-width', active
                generation = re.compile('generate|produce|build|create html', re.I)
                assert page.locator('.design-canvas').get_by_role('button', name=generation).count() == 0
                assert page.locator('.design-canvas').get_by_role('link', name=generation).count() == 0
                passed('Width stays available and focused on the planned step, and no generation control is offered')

                # Captures: planned-step production at both declared widths.
                page.goto(base + '/#/designs?ws=fixture&id=planned&path=screens%2F02-kickoff.html&tab=1280', wait_until='domcontentloaded')
                page.reload(wait_until='domcontentloaded')
                expect(page.locator('#design-detail-heading')).to_have_text('Planned fixture')
                expect(page.locator('.design-canvas .empty')).to_contain_text('Screen 2 has not been produced')
                planned_details = page.locator('.design-canvas details')
                if not planned_details.evaluate('element => element.open'):
                    planned_details.locator('summary').click()
                report['captureState'] = []
                for width in (1280, 1600):
                    page.locator('#design-width').focus()
                    page.select_option('#design-width', str(width))
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.wait_for_timeout(150)
                    page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) canvas.scrollTop = 0; }")
                    frame_path = browser_evidence / f'designs-unproduced@{width}.png'
                    page.screenshot(path=str(frame_path))
                    report['captures'].append(str(frame_path))
                    report['captureState'].append({
                        'width': width,
                        'frameCapture': str(frame_path),
                        'details': planned_details.inner_text(),
                        'canvas': page.evaluate("""() => {
                          const canvas = document.querySelector('.design-canvas');
                          return canvas ? { scrollTop: canvas.scrollTop, clientHeight: canvas.clientHeight, scrollHeight: canvas.scrollHeight } : null;
                        }"""),
                    })
                if reference_html:
                    capture_reference('reference-26', details=False, wait_for_frame=False)
                report['intentionalWaits'] = [
                    'production and reference captures at both widths for the planned-screen state',
                ]
                passed('captured planned-step production at 1280 and 1600' + (' and the reference at matching widths' if reference_html else ''))

                assert not report['pageErrors'], report['pageErrors']
                assert not report['consoleErrors'], report['consoleErrors']
                unexpected = [failure for failure in report['requestFailures'] if 'ERR_ABORTED' not in failure['failure']]
                assert not unexpected, unexpected
                mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
                assert not mutations, f'mutation requests observed: {mutations}'
                report['status'] = 'passed'
                raise CaseComplete()

            if case == 'empty':
                list_pane = page.locator('.list-pane')
                canvas = page.locator('.design-canvas')
                announcement = page.locator('main [role="status"][aria-atomic="true"]')

                # Ordinary entry: Workspaces ws=other -> Designs action -> real empty index.
                page.goto(base + '/#/workspaces?ws=other', wait_until='domcontentloaded')
                with page.expect_response(lambda response: '/api/workspace-designs' in response.url) as empty_response:
                    page.get_by_role('button', name='Designs', exact=True).click()
                assert empty_response.value.status == 200, empty_response.value.status
                empty_body = empty_response.value.json()
                assert empty_body.get('designs') == [], empty_body
                assert empty_body.get('errors') == [], empty_body
                expect(page).to_have_url(re.compile(r'#/designs\?ws=other'))
                expect(page.locator('.list-caption')).to_have_text('No designs recorded')
                expect(list_pane.get_by_role('heading', name='No designs recorded', exact=True)).to_be_visible()
                expect(list_pane).to_contain_text('Create a design plan in this workspace to begin.')
                expect(page.locator('.object-head h2')).to_have_text('Design screen')
                expect(canvas.get_by_role('heading', name='No design selected', exact=True)).to_be_visible()
                expect(canvas).to_contain_text('Open Files to read the planning material for this workspace.')
                expect(page.locator('.design-toolbar')).to_have_count(0)
                expect(page.locator('#design-width')).to_have_count(0)
                expect(page.locator('#design-frame-wrap')).to_have_count(0)
                expect(page.locator('#design-frame')).to_have_count(0)
                expect(canvas.locator('details')).to_have_count(0)
                expect(page.locator('.detail-foot')).to_have_text('Produced and captured status comes from files · Screen content is read only')
                files_links = page.get_by_role('link', name='Open files', exact=True)
                expect(files_links).to_have_count(2)
                for index in range(2):
                    href = files_links.nth(index).get_attribute('href')
                    assert href == '#/files?ws=other&source=workspace', href
                expect(page.locator('.detail-pane a.ds-btn--primary', has_text='Open files')).to_have_count(1)
                expect(page.locator('.list-pane a.ds-btn--primary')).to_have_count(0)
                refresh_local = list_pane.get_by_role('button', name='Refresh designs', exact=True)
                expect(refresh_local).to_be_visible()
                expect(announcement).to_have_count(1)
                expect(announcement).to_have_text('No designs recorded.')
                passed('other workspace with no designs renders No designs recorded and No design selected with no frame/toolbar and one primary Open files')

                # Both Files links cross the real Files adapter with ws=other preserved.
                for index in range(2):
                    files_links.nth(index).click()
                    expect(page).to_have_url(re.compile(r'#/files\?ws=other&source=workspace'))
                    expect(page.locator('h1')).to_have_text('Files')
                    page.go_back()
                    expect(page).to_have_url(re.compile(r'#/designs\?ws=other'))
                passed('both empty Files links enter the real Files route with ws=other preserved')

                # Empty captures at both widths; reference 76 has no width control.
                report['emptyCaptureState'] = []
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.wait_for_timeout(150)
                    path = browser_evidence / f'designs-empty@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                    report['emptyCaptureState'].append({
                        'width': width,
                        'capture': str(path),
                        'url': page.url,
                        'announcement': announcement.text_content(),
                        'framePresent': page.locator('#design-frame').count(),
                        'toolbarPresent': page.locator('.design-toolbar').count(),
                    })
                if reference_html:
                    capture_reference('reference-76', details=False, wait_for_frame=False, select_width=False)
                report['intentionalWaits'] = ['empty production and reference captures at both widths']
                passed('captured empty production at 1280 and 1600' + (' and the 76 reference at matching widths' if reference_html else ''))

                # 44px, keyboard and 200% zoom reachability for the empty controls.
                search = page.locator('#find-record')
                controls = [search, refresh_local, files_links.nth(0), files_links.nth(1)]
                for control in controls:
                    box = control.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, (control, box)
                search.focus()
                reachable = []
                for _ in range(24):
                    reachable.append(active_control())
                    page.keyboard.press('Tab')
                reachable_ids = [item['id'] for item in reachable if item]
                reachable_text = [item['text'] for item in reachable if item]
                assert 'find-record' in reachable_ids, reachable_ids
                assert 'Refresh designs' in reachable_text, reachable_text
                assert 'Open files' in reachable_text, reachable_text
                page.evaluate("document.documentElement.style.zoom = '2'")
                page.wait_for_timeout(150)
                for control in controls:
                    control.scroll_into_view_if_needed()
                    box = control.bounding_box()
                    assert box and box['x'] >= 0 and box['y'] >= 0 and box['y'] < 900, (control, box)
                page.evaluate("document.documentElement.style.zoom = ''")
                passed('empty search, local Refresh designs and both Files links meet 44px, stay keyboard reachable and survive 200% zoom')

                # Explicit unknown id keeps the unavailable contract while the catalog is empty.
                page.evaluate("location.hash = '#/designs?ws=other&id=missing-design'")
                expect(page.locator('.detail-body')).to_contain_text('Design not found')
                expect(page.locator('.design-canvas')).to_have_count(0)
                expect(page.locator('.list-caption')).to_have_text('No designs recorded')
                assert params().get('id') == ['missing-design'], page.url
                expect(announcement).to_have_text('Design not found.')
                passed('an explicit unknown id keeps the unavailable detail and its id while the real catalog stays empty')

                # Write a real temporary design, then let the local Refresh designs discover it.
                page.evaluate("location.hash = '#/designs?ws=other'")
                expect(page.locator('.list-caption')).to_have_text('No designs recorded')
                other_design = Path(receipt['root']) / 'storage' / 'projects' / 'other' / 'designs' / 'empty-demo'
                discovered_record = {
                    'schema_version': 1, 'design': 'empty-demo', 'title': 'Empty discovered',
                    'viewport': {'posture': 'desktop-only', 'widths': [1280]},
                    'screens': [{'step': 1, 'id': 'empty-screen', 'title': 'Empty discovered screen', 'person': 'Operator',
                                 'job': 'Prove the local refresh discovers a new temporary design',
                                 'kind': 'action', 'state': 'ideal'}],
                }
                discovered_screen = screen_html('Empty discovered screen', 'Discovered empty screen')
                (other_design / 'screens').mkdir(parents=True, exist_ok=True)
                (other_design / 'marker.js').write_text(MARKER_JS)
                (other_design / 'screen.css').write_text(SCREEN_CSS)
                (other_design / 'screens' / '01-empty-screen.html').write_text(discovered_screen)
                (other_design / 'design.json').write_text(json.dumps(discovered_record))
                report['fixtureInputs'] = {
                    'designJson': discovered_record,
                    'screenHtml': discovered_screen,
                    'markerScript': MARKER_JS,
                    'screenCss': SCREEN_CSS,
                }
                with page.expect_response(lambda response: '/api/workspace-designs' in response.url and 'id=other' in response.url) as discovered:
                    refresh_local.click()
                discovered_body = discovered.value.json()
                assert [item['slug'] for item in discovered_body.get('designs', [])] == ['empty-demo'], discovered_body
                expect(page.locator('.list-pane .record')).to_have_count(1)
                expect(page.locator('.list-pane .record')).to_contain_text('Empty discovered')
                expect(page.locator('#design-detail-heading')).to_have_text('Empty discovered')
                page.wait_for_function("() => location.hash.includes('id=empty-demo') && location.hash.includes('tab=1280')")
                assert params().get('id') == ['empty-demo'], page.url
                assert params().get('path') == ['screens/01-empty-screen.html'], page.url
                assert params().get('tab') == ['1280'], page.url
                passed('the local Refresh designs discovers a newly written design and normalizes the actual selection')

                # Invalid index on disk: the shell refresh, real errors, no false empty state.
                invalid_index = '{ this is not json'
                report['fixtureInputs']['invalidIndexLiteral'] = invalid_index
                (other_design / 'design.json').write_text(invalid_index)
                with page.expect_response(lambda response: '/api/workspace-designs' in response.url and 'id=other' in response.url) as invalidated:
                    page.locator('.head-actions').get_by_role('button', name='Refresh state', exact=True).click()
                invalid_body = invalidated.value.json()
                assert invalid_body.get('designs') == [], invalid_body
                assert invalid_body.get('errors'), invalid_body
                expect(page.locator('.list-caption')).to_have_text('Design indexes could not be read')
                expect(page.locator('.list-pane .warn')).to_contain_text('designs/empty-demo/design.json')
                expect(page.locator('main')).not_to_contain_text('No designs recorded')
                expect(page.locator('main')).not_to_contain_text('No design selected')
                page.evaluate("location.hash = '#/designs?ws=other'")
                expect(page.locator('.detail-body')).to_contain_text('Design indexes could not be read')
                expect(announcement).to_have_text('Design indexes could not be read.')
                passed('an all-invalid index exposes its diagnostic instead of claiming No designs recorded or No design selected')

                # No-match search on the populated fixture keeps the selected detail.
                canonical = base + '/#/designs?ws=fixture&id=demo&path=screens%2F02-screen-2.html&tab=1600'
                page.goto(canonical, wait_until='domcontentloaded')
                page.reload(wait_until='domcontentloaded')
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                expect(page.locator('#design-width')).to_have_value('1600')
                expect(frame().locator('h1')).to_have_text('Marker screen two')
                page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
                frame_handle = page.locator('#design-frame').element_handle()
                stable_nonce = frame().locator('html').get_attribute('data-nonce')
                heads_before = head_count()
                search = page.locator('#find-record')
                search.fill('Design fixture')
                expect(page.locator('.list-pane .record')).to_have_count(1)
                expect(page.locator('.list-pane .record').first).to_contain_text('Design fixture')
                search.fill('second')
                expect(page.locator('.list-pane .record')).to_have_count(1)
                expect(page.locator('.list-pane .record').first).to_contain_text('Alternate fixture')
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                assert params().get('id') == ['demo'], page.url
                search.fill('no-such-design')
                expect(page.locator('.list-pane')).to_contain_text('No designs match')
                clear_search = page.locator('.list-pane').get_by_role('button', name='Clear search', exact=True)
                expect(clear_search).to_be_visible()
                expect(page.locator('.detail-pane').get_by_role('button', name='Clear search', exact=True)).to_have_count(0)
                expect(announcement).to_have_count(1)
                expect(announcement).to_have_text('No designs match. Clear search to restore the design list.')
                no_match_announcement = announcement.text_content()
                clear_box = clear_search.bounding_box()
                assert clear_box and clear_box['width'] >= 44 and clear_box['height'] >= 44, clear_box
                assert params().get('id') == ['demo'] and params().get('path') == ['screens/02-screen-2.html'] and params().get('tab') == ['1600'], page.url
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == stable_nonce
                assert head_count() == heads_before, 'search added a produced-screen HEAD'
                for width in (1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.wait_for_timeout(150)
                    path = browser_evidence / f'designs-no-match@{width}.png'
                    page.screenshot(path=str(path))
                    report['captures'].append(str(path))
                clear_search.click()
                expect(page.locator('.list-pane .record')).to_have_count(2)
                expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
                assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
                assert frame().locator('html').get_attribute('data-nonce') == stable_nonce
                assert head_count() == heads_before, 'clear added a produced-screen HEAD'
                assert frame_handle.evaluate('(el) => el.isConnected'), 'no-match search replaced the iframe'
                expect(announcement).to_have_count(1)
                expect(announcement).to_have_text('Screen 2 of 2 · Design fixture · Screen two')
                report['noMatchIdentity'] = {
                    'announcement': no_match_announcement,
                    'id': params().get('id'), 'path': params().get('path'), 'tab': params().get('tab'),
                    'nonce': stable_nonce,
                    'headReadsBefore': heads_before, 'headReadsAfter': head_count(),
                    'frameConnected': frame_handle.evaluate('(el) => el.isConnected'),
                }
                passed('title and slug search match rows, an impossible q shows No designs match with Clear search, and the detail, width, iframe and HEAD count survive')

                assert not report['pageErrors'], report['pageErrors']
                assert not report['consoleErrors'], report['consoleErrors']
                unexpected = [failure for failure in report['requestFailures'] if 'ERR_ABORTED' not in failure['failure']]
                assert not unexpected, unexpected
                mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
                assert not mutations, f'mutation requests observed: {mutations}'
                report['status'] = 'passed'
                raise CaseComplete()

            # Migrated coverage 1/2: Workspaces Designs enters the real adapter/API.
            page.goto(base + '/#/workspaces?ws=fixture', wait_until='domcontentloaded')
            with page.expect_response(lambda response: '/api/workspace-designs' in response.url) as index_response:
                page.get_by_role('button', name='Designs', exact=True).click()
            assert index_response.value.status == 200, index_response.value.status
            assert 'id=fixture' in index_response.value.url, index_response.value.url
            expect(page).to_have_url(re.compile(r'#/designs\?ws=fixture'))
            expect(page.locator('.list-caption')).to_have_text('2 design packages')
            expect(page.locator('.list-pane .record')).to_have_count(2)
            demo_row = page.locator('.list-pane .record').filter(has_text='Design fixture')
            expect(demo_row).to_contain_text('Produced')
            expect(demo_row).to_contain_text('1 captured')
            expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
            expect(page.get_by_text('Screen 1 · Screen one', exact=True)).to_be_visible()
            expect(page.locator('#design-frame')).to_have_attribute('sandbox', 'allow-scripts')
            expect(frame().locator('h1')).to_have_text('Marker screen one')
            assert frame().locator('html').get_attribute('data-marker') == '42'
            assert frame().locator('html').get_attribute('data-lifetime') == '1'
            nonce = frame().locator('html').get_attribute('data-nonce')
            assert nonce, 'marker script did not record a load nonce'
            background = frame().locator('body').evaluate('element => getComputedStyle(element).backgroundColor')
            assert background == 'rgb(250, 250, 245)', background
            assert any('/screen.css' in r['url'] for r in requests), 'relative stylesheet was not requested'
            sibling = frame().locator('a.sibling')
            resolved = sibling.evaluate('element => element.href')
            assert resolved.startswith(base + workspace_view) and resolved.endswith('/designs/demo/screens/02-screen-2.html'), resolved
            sibling_response = context.request.get(resolved)
            assert sibling_response.ok and 'marker.js' in sibling_response.text()
            passed('Workspaces Designs enters the real adapter/API; relative marker script and CSS load; the sibling link resolves inside the same workspace-view folder')

            # Migrated coverage 2/2: step, width, Next/Previous selection with real routes.
            next_button = page.get_by_role('button', name='Next screen', exact=True)
            next_handle = next_button.element_handle()
            next_button.focus()
            diagnostic = {'before': {
                'active': active_control(),
                'indexReads': len([r for r in requests if '/api/workspace-designs' in r['url']]),
                'headReads': head_count(),
            }}
            next_button.click()
            diagnostic['after'] = {
                'url': page.url,
                'params': dict(params()),
                'buttonConnected': next_handle.evaluate('(el) => el.isConnected') if next_handle else None,
                'active': active_control(),
                'indexReads': len([r for r in requests if '/api/workspace-designs' in r['url']]),
                'headReads': head_count(),
                'heading': page.locator('#design-detail-heading').text_content(),
                'widthValue': page.locator('#design-width').input_value(),
            }
            active = diagnostic['after']['active']
            if active is None or active.get('text') != 'Next screen' or not diagnostic['after']['buttonConnected']:
                page.screenshot(path=str(browser_evidence / 'designs-focus-diagnostic.png'))
                diagnostic['screenshot'] = str(browser_evidence / 'designs-focus-diagnostic.png')
            report['nextFocusDiagnostic'] = diagnostic
            assert params().get('path') == ['screens/02-screen-2.html'], page.url
            assert params().get('tab') == ['1280'], page.url
            assert active and active['text'] == 'Next screen', active
            expect(frame().locator('h1')).to_have_text('Marker screen two')
            page.go_back()
            expect(frame().locator('h1')).to_have_text('Marker screen one')
            page.go_forward()
            expect(frame().locator('h1')).to_have_text('Marker screen two')
            page.go_back()
            expect(frame().locator('h1')).to_have_text('Marker screen one')
            page.locator('#design-width').focus()
            page.select_option('#design-width', '1600')
            assert params().get('tab') == ['1600'], page.url
            active = active_control()
            assert active and active['id'] == 'design-width', active
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#design-width')).to_have_value('1600')
            expect(frame().locator('h1')).to_have_text('Marker screen one')
            page.go_back()
            expect(page.locator('#design-width')).to_have_value('1280')
            page.go_forward()
            expect(page.locator('#design-width')).to_have_value('1600')
            passed('Next/Previous and width push history, keep control focus, and a cold reload restores step and width')

            # Invalid path/tab normalizes with replace and adds no extra history entry.
            history_before_hash = page.evaluate('history.length')
            page.evaluate("location.hash = '#/designs?ws=fixture&id=demo&path=screens/99-missing.html&tab=9999'")
            expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
            page.wait_for_function("() => location.hash.includes('path=screens%2F01-screen-1.html')")
            assert params().get('path') == ['screens/01-screen-1.html'] and params().get('tab') == ['1280'], page.url
            assert page.evaluate('history.length') == history_before_hash + 1, 'normalization pushed instead of replacing'
            passed('invalid path/tab normalizes with replace and adds no extra history entry')

            # q replaces and never clears the hidden selected detail.
            history_before_q = page.evaluate('history.length')
            page.locator('#find-record').fill('alternate')
            expect(page.locator('.list-pane .record')).to_have_count(1)
            expect(page.locator('.list-pane .record').first).to_contain_text('Alternate fixture')
            expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
            assert params().get('q') == ['alternate'] and params().get('id') == ['demo'], page.url
            assert page.evaluate('history.length') == history_before_q, 'q navigation pushed instead of replacing'
            page.locator('#find-record').fill('')
            expect(page.locator('.list-pane .record')).to_have_count(2)
            passed('q filters rows with replace and retains the hidden selected detail')

            # Row selection resets incompatible path/tab and focuses the detail heading.
            page.locator('.list-pane .record').filter(has_text='Design fixture').click()
            page.get_by_role('button', name='Next screen', exact=True).click()
            page.locator('#design-width').focus()
            page.select_option('#design-width', '1600')
            assert params().get('id') == ['demo'] and params().get('path') == ['screens/02-screen-2.html'] and params().get('tab') == ['1600'], page.url
            page.locator('.list-pane .record').filter(has_text='Alternate fixture').click()
            assert params().get('id') == ['second'], page.url
            assert params().get('path') == ['screens/01-wide-shot.html'] and params().get('tab') == ['1200'], page.url
            expect(page.locator('#design-detail-heading')).to_be_focused()
            expect(page.locator('#design-width')).to_have_value('1200')
            expect(page.locator('.list-pane .record.selected')).to_contain_text('Alternate fixture')
            passed('selecting a second design resets incompatible path/tab, selects the first declared width and focuses the heading')

            with context.expect_page(timeout=5000) as popup_info:
                page.locator('.list-pane .record').filter(has_text='Design fixture').click(modifiers=['Shift'])
            popup = popup_info.value
            popup.wait_for_load_state('domcontentloaded')
            assert 'id=demo' in popup.url, popup.url
            popup.close()
            passed('a modified row click keeps native anchor navigation')

            # Identity: width change and a real 5s poll keep the iframe, marker and HEAD count.
            page.locator('.list-pane .record').filter(has_text='Design fixture').click()
            expect(frame().locator('h1')).to_have_text('Marker screen one')
            page.evaluate("document.getElementById('design-frame').dataset.viewer = 'stable'")
            frame_handle = page.locator('#design-frame').element_handle()
            stable_nonce = frame().locator('html').get_attribute('data-nonce')
            heads_before = head_count()
            markers_before = marker_loads()
            status_region = page.locator('main [role="status"][aria-atomic="true"]')
            expect(status_region).to_have_count(1)
            expect(page.locator('.workspace [role="status"]')).to_have_count(0)
            announcement_before = status_region.first.text_content()
            page.locator('#design-width').focus()
            page.select_option('#design-width', '1600')
            assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable'
            assert frame().locator('html').get_attribute('data-nonce') == stable_nonce
            with page.expect_response(lambda response: '/api/workspace-designs' in response.url, timeout=8000):
                pass
            assert page.evaluate("document.getElementById('design-frame').dataset.viewer") == 'stable', 'index poll recreated the frame'
            assert frame().locator('html').get_attribute('data-nonce') == stable_nonce, 'index poll reloaded the frame document'
            assert head_count() == heads_before, 'width change or poll added a produced-screen HEAD'
            assert marker_loads() == markers_before, 'width change or poll reloaded the marker script'
            assert frame_handle.evaluate('(el) => el.isConnected'), 'iframe element was replaced'
            expect(status_region).to_have_count(1)
            assert status_region.first.text_content() == announcement_before, 'poll changed the region announcement'
            passed('width change and a real five-second poll retain the iframe element, marker nonce and HEAD count')

            # Delayed workspace A index while switching to B; releasing A never replaces B.
            held = {'route': None, 'response': None}
            def hold_fixture_index(route):
                if 'id=fixture' in route.request.url and held['route'] is None:
                    held['route'] = route
                else:
                    route.continue_()
            page.route('**/api/workspace-designs**', hold_fixture_index)
            page.goto(base + '/#/designs?ws=fixture', wait_until='domcontentloaded')
            page.reload(wait_until='domcontentloaded')
            deadline = time.monotonic() + 5
            while held['route'] is None and time.monotonic() < deadline:
                page.wait_for_timeout(50)
            assert held['route'] is not None, 'the fixture index request was not held'
            try:
                held['response'] = held['route'].fetch(timeout=5000)
            except Exception as error:
                report['expectedFailures'].append(f'fixture index fetch while held: {error}')
            reads_before_b = design_reads()
            page.get_by_label('Workspace scope').select_option('other')
            expect(page).to_have_url(re.compile(r'#/designs\?ws=other'))
            expect(page.locator('#design-detail-heading')).to_have_text('Other fixture')
            expect(page.locator('.list-pane .record')).to_have_count(1)
            assert design_reads() > reads_before_b, 'workspace B index was not read'
            released = 'not-released'
            if held['response'] is not None:
                try:
                    held['route'].fulfill(response=held['response'])
                    released = 'fulfilled-after-switch'
                except Exception as error:
                    released = f'aborted-before-release: {error}'
                    report['expectedFailures'].append(released)
            else:
                try:
                    held['route'].continue_()
                    released = 'continued-after-switch'
                except Exception as error:
                    released = f'continue-failed: {error}'
                    report['expectedFailures'].append(released)
            page.wait_for_timeout(400)
            assert 'ws=other' in page.url, page.url
            expect(page.locator('.list-pane .record')).to_have_count(1)
            expect(page.locator('.list-pane .record').first).to_contain_text('Other fixture')
            expect(page.locator('#design-detail-heading')).to_have_text('Other fixture')
            expect(page.locator('#design-detail-heading')).not_to_have_text('Design fixture')
            page.unroute('**/api/workspace-designs**', hold_fixture_index)
            report['delayedIndexRelease'] = released
            passed('a delayed workspace A index released after switching to B never renders A rows or selection')

            # Imported snapshot: live requirement, no design index or workspace-view reads.
            page.goto(base + '/#/specs?ws=fixture', wait_until='domcontentloaded')
            reads_before_import = design_reads()
            live_state = context.request.get(base + '/api/state')
            assert live_state.ok, live_state.status
            imported = live_state.json()
            page.locator('#import-file').set_input_files({'name': 'snapshot.json', 'mimeType': 'application/json',
                                                          'buffer': json.dumps(imported).encode()})
            expect(page.locator('#connection-status')).to_contain_text('Imported snapshot')
            page.locator('[data-area="designs"]').click()
            expect(page.locator('main')).to_contain_text('A live dashboard is required')
            page.wait_for_timeout(400)
            assert design_reads() == reads_before_import, 'imported snapshot read design data'
            passed('an imported snapshot shows the live-server requirement and reads no design index or workspace-view file')

            # Return to the live server, then check sizing, keyboard and zoom posture.
            page.goto(base + '/#/designs?ws=fixture', wait_until='domcontentloaded')
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
            expect(frame().locator('h1')).to_have_text('Marker screen one')
            details = page.locator('.design-canvas details')
            if not details.evaluate('element => element.open'):
                details.locator('summary').click()
            expect(details).to_contain_text('Operator · Choose the first fixture screen')
            expect(details).to_contain_text('Primary action: Open first screen')
            expect(details).to_contain_text('Capture: 1280px and 1600px')
            expect(details).to_contain_text('--ds-accent')
            page.get_by_role('button', name='Next screen', exact=True).click()
            below = []
            for selector in ['.list-pane .record', '.design-toolbar .ds-btn', '#design-width', '#find-record', '.design-toolbar a.ds-btn']:
                for element in page.locator(selector).all():
                    box = element.bounding_box()
                    if box and (box['width'] < 44 or box['height'] < 44):
                        below.append({'selector': selector, 'box': box})
            assert not below, below

            def tab_reachable():
                page.locator('#find-record').focus()
                found = []
                for _ in range(30):
                    found.append(page.evaluate(
                        "() => { const el = document.activeElement; if (!el) return ''; "
                        "return el.id || (el.textContent || '').trim().slice(0, 30); }"))
                    page.keyboard.press('Tab')
                return found

            at_second = tab_reachable()
            for name in ['Previous screen', 'design-width', 'Open screen']:
                assert name in at_second, (name, at_second)
            page.get_by_role('button', name='Previous screen', exact=True).click()
            at_first = tab_reachable()
            for name in ['Next screen', 'design-width', 'Open screen']:
                assert name in at_first, (name, at_first)
            page.evaluate("document.documentElement.style.zoom = '2'")
            page.wait_for_timeout(150)
            for selector in ['#design-width', '.design-toolbar a.ds-btn']:
                element = page.locator(selector).first
                element.scroll_into_view_if_needed()
                box = element.bounding_box()
                assert box and box['x'] >= 0 and box['y'] >= 0 and box['y'] < 900, (selector, box)
            page.evaluate("document.documentElement.style.zoom = ''")
            passed('changed controls and rows meet 44px, stay keyboard reachable, and remain reachable at 200% zoom')

            # Captures: canonical cold selection; the frame state and the scrolled
            # disclosure state are captured separately so neither mislabels the other.
            canonical = base + '/#/designs?ws=fixture&id=demo&path=screens%2F01-screen-1.html&tab=1280'
            page.goto(canonical, wait_until='domcontentloaded')
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#design-detail-heading')).to_have_text('Design fixture')
            expect(page.locator('#design-width')).to_have_value('1280')
            expect(frame().locator('h1')).to_have_text('Marker screen one')
            page.wait_for_timeout(150)
            assert_frame_geometry(1280)
            details = page.locator('.design-canvas details')
            if not details.evaluate('element => element.open'):
                details.locator('summary').click()
            report['captureState'] = []
            for width in (1280, 1600):
                page.locator('#design-width').focus()
                page.select_option('#design-width', str(width))
                page.set_viewport_size({'width': width, 'height': 900})
                assert_frame_geometry(width)
                page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) canvas.scrollTop = 0; }")
                frame_path = browser_evidence / f'designs-journey@{width}.png'
                page.screenshot(path=str(frame_path))
                report['captures'].append(str(frame_path))
                page.evaluate("() => { const canvas = document.querySelector('.design-canvas'); if (canvas) { const target = canvas.querySelector('details'); if (target) target.scrollIntoView({ block: 'start' }); } }")
                details_path = browser_evidence / f'designs-journey-details@{width}.png'
                page.screenshot(path=str(details_path))
                report['captures'].append(str(details_path))
                report['captureState'].append({
                    'width': width,
                    'frameCapture': str(frame_path),
                    'detailsCapture': str(details_path),
                    'frameGeometry': frame_geometry(width),
                    'canvas': page.evaluate("""() => {
                      const canvas = document.querySelector('.design-canvas');
                      return canvas ? { scrollTop: canvas.scrollTop, clientHeight: canvas.clientHeight, scrollHeight: canvas.scrollHeight } : null;
                    }"""),
                })
            if reference_html:
                capture_reference('reference-8')
            report['intentionalWaits'] = [
                'one real five-second Designs index poll boundary',
                'production and reference captures at both widths with separate frame and scrolled-disclosure states',
            ]
            passed('captured production frame and scrolled-disclosure states at 1280 and 1600' + (' and the reference at matching widths' if reference_html else ''))

            assert not report['pageErrors'], report['pageErrors']
            assert not report['consoleErrors'], report['consoleErrors']
            unexpected = [failure for failure in report['requestFailures'] if 'ERR_ABORTED' not in failure['failure']]
            assert not unexpected, unexpected
            mutations = [r for r in requests if r['method'] not in ('GET', 'HEAD')]
            assert not mutations, f'mutation requests observed: {mutations}'
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
except CaseComplete:
    pass
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
    if receipt:
        try:
            cleanup['temporaryFixtureRootRemoved'] = not Path(receipt['root']).exists()
            if not cleanup['temporaryFixtureRootRemoved']:
                cleanup['errors'].append(f"temporary fixture root still present: {receipt['root']}")
        except Exception as error:
            cleanup['errors'].append(f'temporary fixture root check: {error}')
    report['elapsedSeconds'] = round(finished - started, 3)
    report['startupSeconds'] = startup_seconds
    report['checkSeconds'] = None if check_started is None else round(finished - check_started, 3)
    report['cleanup'] = cleanup
    target = evidence / f'designs-browser-{case}.json'
    temporary = target.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    os.replace(temporary, target)
    print(json.dumps(report, indent=2))
