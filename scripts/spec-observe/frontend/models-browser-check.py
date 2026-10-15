# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""EV-5 browser checker for the Models destination.

SENTINEL_EVIDENCE_DIR=/path/to/evidence timeout 240s uv run --script \
  scripts/spec-observe/frontend/models-browser-check.py --case models
SENTINEL_EVIDENCE_DIR=/path/to/evidence timeout 240s uv run --script \
  scripts/spec-observe/frontend/models-browser-check.py --case models \
  --reference-dir /path/to/designs/model-selection
"""
import argparse
import socket
import re
import json
import os
import select
import shutil
import subprocess
import threading
import time
import traceback
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['models', 'picker', 'assignment', 'conversation', 'integrated', 'host-parser'], default='models')
parser.add_argument('--reference-dir', default=None)
options = parser.parse_args()
case = options.case
reference_dir = Path(options.reference_dir).resolve() if options.reference_dir else None
planned_env = {'SENTINEL_PLANNED_LAUNCH': '1'} if case == 'assignment' else {}

root = Path(__file__).resolve().parent
checkout = root.parents[2]
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-models-evidence'))
browser_evidence = evidence / 'browser'
browser_evidence.mkdir(parents=True, exist_ok=True)
evidence_file = evidence / 'step-010-models-result.json' if case in ('integrated', 'host-parser') else (evidence / 'step-009-models-result.json' if case == 'conversation' else (evidence / 'step-008-models-result.json' if case == 'assignment' else (evidence / 'step-006-models-result.json' if case == 'picker' else evidence / 'step-005-models-result.json')))
receipt_path = evidence_file
started = time.monotonic()

report = {
    'status': 'failed',
    'case': case,
    'scenarios': [],
    'captures': [],
    'pageErrors': [],
    'consoleErrors': [],
    'requestFailures': [],
    'fixture': {},
    'observedCommit': None,
    'dirty': None,
    'reference': str(reference_dir) if reference_dir else None,
    'visual': {},
    'cleanup': {},
}

fixture = None
reference_server = None
browser = None
context = None
fixture_info = {}
held_routes = []
cleanup = {'fixtureTerminated': False, 'browserClosed': False, 'temporaryFixtureRootRemoved': None, 'errors': []}


class QuietRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def write_receipt():
    temporary = receipt_path.with_name(receipt_path.name + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    os.replace(temporary, receipt_path)

def update_step10_receipt(section, payload):
    """Read-merge-write the canonical EV-10 receipt under a cases map."""
    canonical = evidence / 'step-010-models-result.json'
    if canonical.exists():
        try:
            data = json.loads(canonical.read_text())
        except (json.JSONDecodeError, OSError):
            data = {}
    else:
        data = {}
    data.setdefault('cases', {})[section] = payload

    git_output = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    data['observedCommit'] = git_output.stdout.strip() if git_output.returncode == 0 else None
    git_dirty = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True)
    data['dirty'] = bool(git_dirty.stdout.strip())

    both = 'integrated' in data.get('cases', {}) and 'hostParser' in data.get('cases', {})
    data['status'] = 'passed' if (both and all(c.get('status') == 'passed' for c in data.get('cases', {}).values())) else 'failed'

    temporary = canonical.with_name(canonical.name + '.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    os.replace(temporary, canonical)


def run(url, page):
    global reference_server

    def control(action, value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def reload(page):
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('#catalog-meta')

    def goto_models(page):
        page.goto(url + '/#/models', wait_until='domcontentloaded')
        page.wait_for_selector('#catalog-meta')

    def cap(page, name, widths=(1280, 1600)):
        for width in widths:
            page.set_viewport_size({'width': width, 'height': 900})
            page.wait_for_timeout(200)
            path = browser_evidence / f'models-{name}@{width}.png'
            page.screenshot(path=str(path))
            report['captures'].append(str(path))

    def passed(label):
        report['scenarios'].append(label)

    try:
        # 1. ideal: initial render with catalog meta and preferred rows
        goto_models(page)
        expect(page.locator('#catalog-meta')).to_be_visible()
        meta_text = page.locator('#catalog-meta').text_content()
        assert 'models' in meta_text.lower() or 'model' in meta_text.lower()
        assert 'from' in meta_text.lower() or 'providers' in meta_text.lower()
        assert 'catalog read' in meta_text.lower()
        expect(page.locator('th.c-pref').first).to_contain_text('Preferred')
        first_table = page.locator('.mtable').first
        assert first_table.locator('tbody tr').count() >= 6, first_table.locator('tbody tr').count()
        assert page.locator('input.switch:checked').count() >= 5
        cap(page, 'ideal')
        passed('ideal')

        deepseek = page.locator('details.prov-group').filter(has=page.locator('summary .pname', has_text='deepseek'))
        if deepseek.get_attribute('open') is not None:
            deepseek.locator('summary').click()
        page.locator('#find-model').fill('deepseek')
        expect(deepseek.locator('tbody tr')).to_have_count(2)
        expect(deepseek).to_have_attribute('open', '')
        page.locator('#find-model').fill('')
        expect(deepseek).not_to_have_attribute('open', '')
        passed('search expands collapsed providers and clearing restores disclosure')

        # 2. search+chips: query and capability filters
        page.locator('#find-model').fill('claude')
        page.wait_for_timeout(100)
        meta_text = page.locator('#catalog-meta').text_content()
        assert 'match' in meta_text.lower()
        assert page.locator('mark').count() >= 1
        thinking_chip = page.locator('button.chip', has_text='Thinking')
        thinking_chip.click()
        expect(thinking_chip).to_have_attribute('aria-pressed', 'true')
        cap(page, 'search')
        passed('search+chips')

        # 3. no-matches: empty filter result
        page.locator('#find-model').fill('zzz-no-such-model')
        page.wait_for_timeout(100)
        expect(page.locator('.empty-inline')).to_be_visible()
        expect(page.locator('.empty-inline')).to_contain_text('No models match this search.')
        cap(page, 'no-matches')
        page.locator('.empty-inline button:has-text("Clear search")').click()
        page.wait_for_timeout(100)
        expect(page.locator('#find-model')).to_have_value('')
        assert first_table.locator('tbody tr').count() >= 6
        cap(page, 'no-matches-cleared')
        passed('no-matches')

        # 4. missing pair: preferred but not in catalog
        expect(page.locator('.prefcell:has-text("Not in fixture-host catalog")')).to_be_visible()
        expect(page.locator('.prefcell button:has-text("Remove preference")')).to_be_visible()
        cap(page, 'missing')
        passed('missing pair')

        # 5. empty preferred: remove all preferred
        while True:
            switches = page.locator('input.switch:checked')
            if switches.count() == 0:
                break
            switches.first.click()
            page.wait_for_timeout(300)
        # Remove the missing pair (no switch, needs Remove preference button)
        if page.locator('.prefcell button:has-text("Remove preference")').count() > 0:
            page.locator('.prefcell button:has-text("Remove preference")').first.click()
            page.wait_for_timeout(400)
        expect(page.locator('.empty-inline strong:has-text("No preferred models yet")')).to_be_visible()
        expect(page.locator('.empty-inline button:has-text("Find model")')).to_be_visible()
        page.locator('.empty-inline button:has-text("Find model")').click()
        page.wait_for_timeout(100)
        expect(page.locator('#find-model')).to_be_focused()
        cap(page, 'empty')
        passed('empty preferred')

        # Restore preferences
        control('models-preferences-broken', 'false')
        reload(page)

        # 6. failed row: save failure
        page.route('**/api/models/preferred', lambda route: route.fulfill(status=503) if route.request.method == 'POST' else route.continue_())
        reload(page)
        prov_group = None
        for group in page.locator('details.prov-group').all():
            if not group.evaluate('(el) => el.open'):
                group.locator('summary').click()
                page.wait_for_timeout(200)
            if group.locator('input.switch:not(:checked)').count() > 0:
                prov_group = group
                break
        assert prov_group is not None, 'failed-row scenario needs a provider group with an unchecked switch'
        candidate = prov_group.locator('input.switch:not(:checked)').first
        label = candidate.get_attribute('aria-label')
        candidate.click()
        page.wait_for_timeout(500)
        expect(page.locator('.row-error').first).to_contain_text('Change reverted')
        expect(page.locator('.row-error').first.locator('button:has-text("Retry")')).to_be_visible()
        expect(prov_group.locator(f'input.switch[aria-label="{label}"]')).not_to_be_checked()
        cap(page, 'failed-row')
        page.unroute('**/api/models/preferred')
        page.locator('.row-error').first.locator('button:has-text("Retry")').click()
        page.wait_for_timeout(500)
        expect(prov_group.locator(f'input.switch[aria-label="{label}"]')).to_be_checked()
        expect(page.locator('.row-error')).to_have_count(0)
        passed('failed row')

        # 7. loading: catalog loading state
        route_obj = page.route('**/api/models/catalog*', lambda route: held_routes.append(route))
        reload(page)
        expect(page.locator('.skeletons-table').first).to_be_visible()
        expect(page.locator('.ds-callout:has-text("Availability unknown")').first).to_be_visible()
        cap(page, 'loading')
        for r in held_routes:
            try:
                r.abort()
            except:
                pass
        held_routes.clear()
        page.unroute('**/api/models/catalog*')
        passed('loading')

        # 8. catalog error: failed catalog
        control('models-catalog-fail', 'true')
        reload(page)
        expect(page.locator('.ds-callout:has-text("Catalog not read")').first).to_be_visible()
        expect(page.locator('.ds-callout button:has-text("Retry catalog")').first).to_be_visible()
        cap(page, 'catalog-error')
        control('models-catalog-fail', 'false')
        passed('catalog error')

        # 9. preference error: broken preference file
        control('models-preferences-broken', 'true')
        reload(page)
        expect(page.locator('.ds-callout:has-text("Preferred models could not be read")').first).to_be_visible()
        expect(page.locator('.ds-callout button:has-text("Retry preferences")').first).to_be_visible()
        cap(page, 'preference-error')
        control('models-preferences-broken', 'false')
        passed('preference error')

        # 10. read-only: no token
        control('observer', 'true')
        reload(page)
        expect(page.locator('.banner:has-text("viewed but not changed")').first).to_be_visible()
        assert page.locator('input.switch:disabled').count() >= 1
        cap(page, 'read-only')
        control('observer', 'false')
        passed('read-only')

        # 11. offline: connection failed
        page.route('**/api/state*', lambda route: route.abort())
        reload(page)
        expect(page.locator('.ds-callout:has-text("Connection unavailable")').first).to_be_visible()
        expect(page.locator('.ds-callout button:has-text("Retry connection")').first).to_be_visible()
        expect(page.get_by_role('button', name='Refresh catalog', exact=True)).to_have_count(0)
        cap(page, 'offline')
        page.unroute('**/api/state*')
        passed('offline')

        # 12. stale: old catalog
        control('models-stale', 'true')
        reload(page)
        expect(page.locator('.banner:has-text("more than 24 hours ago")').first).to_be_visible()
        expect(page.locator('.banner button:has-text("Refresh catalog")').first).to_be_visible()
        expect(page.locator('input.switch').first).to_be_enabled()
        cap(page, 'stale')
        control('models-stale', 'false')
        passed('stale')

        # Reference captures if reference_dir provided (before scroll scenario)
        def capture_references():
            reference_captures = []
            if reference_dir:
                reference_root = reference_dir
                assert (reference_root / 'vendor' / 'tailwind.js').is_file()
                global reference_server
                reference_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_root)))
                port = reference_server.server_address[1]
                reference_thread = threading.Thread(target=reference_server.serve_forever, daemon=True)
                reference_thread.start()
                files = [
                    '01-models.html', '02-models-search.html', '03-models-save-error.html',
                    '04-models-unavailable.html', '05-models-empty.html', '06-models-no-matches.html',
                    '07-models-loading.html', '08-models-error.html', '09-models-denied.html',
                    '10-models-offline.html', '11-models-stale.html'
                ]
                ref_page = context.new_page()
                ref_page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
                for f in files:
                    for width in (1280, 1600):
                        ref_page.goto(f'http://127.0.0.1:{port}/screens/{f}')
                        ref_page.wait_for_timeout(300)
                        ref_page.set_viewport_size({'width': width, 'height': 900})
                        ref_page.wait_for_timeout(150)
                        path = browser_evidence / f'models-reference-{f.replace(".html", "")}@{width}.png'
                        ref_page.screenshot(path=str(path))
                        reference_captures.append(str(path))
                ref_page.close()
                reference_server.shutdown()
                report['reference'] = {'dir': str(reference_dir), 'captures': reference_captures}
            return reference_captures

        reference_captures = capture_references()

        # 13. scroll preservation: click doesn't reset scroll
        reload(page)
        saved_top = None
        current_top = None
        try:
            # Find a group with unchecked switch by walking backwards from last group
            groups = page.locator('details.prov-group').all()
            target_group = None
            for i in range(max(0, len(groups) - 1), max(0, len(groups) - 4), -1):
                group = groups[i]
                if not group.evaluate('(el) => el.open'):
                    group.locator('summary').click()
                    page.wait_for_timeout(200)
                if group.locator('input.switch:not(:checked)').count() > 0:
                    target_group = group
                    break
            if target_group is None:
                target_group = groups[-1]
            candidate = target_group.locator('input.switch:not(:checked)').first
            label = candidate.get_attribute('aria-label')
            # Capture server post count before click
            before_posts = control('').get('modelsPreferencePosts')
            # Install fetch counter on the page
            page.evaluate("""() => {
                window.__modelsPrefPosts = 0;
                const f = window.fetch;
                window.fetch = function(...a) {
                    try {
                        const u = String(a[0] && a[0].url ? a[0].url : a[0]);
                        const m = (a[1] && a[1].method) || 'GET';
                        if (u.indexOf('/api/models/preferred') !== -1 && String(m).toUpperCase() === 'POST')
                            window.__modelsPrefPosts++;
                    } catch(e) {}
                    return f.apply(this, a);
                };
            }""")
            candidate.scroll_into_view_if_needed()
            page.wait_for_timeout(150)
            # Record saved scroll position and the operator-visible anchor.
            full_page = page.locator('.full-page').first
            switch_locator = target_group.locator(f'input.switch[aria-label="{label}"]')
            saved_top = full_page.evaluate('(el) => el.scrollTop')
            saved_box = switch_locator.bounding_box()
            # Only assert non-zero if there's actual scrollable content
            scroll_info = full_page.evaluate('(el) => ({scrollHeight: el.scrollHeight, clientHeight: el.clientHeight})')
            if scroll_info['scrollHeight'] > scroll_info['clientHeight']:
                assert saved_top > 0, f'Expected non-zero scroll position, got {saved_top}'
            # Click the target with firmer interaction (no auto-scroll since we already scrolled into view)
            candidate.check(timeout=5000)
            page.wait_for_timeout(400)
            current_top = full_page.evaluate('(el) => el.scrollTop')
            current_box = switch_locator.bounding_box()
            # Turning the model on inserts a Preferred row above the viewport, which may
            # adjust scrollTop; the operator's place is the toggled control staying put.
            assert saved_box and current_box, 'switch missing before/after save for scroll check'
            visual_shift = abs(current_box['y'] - saved_box['y'])
            assert visual_shift <= 2, f'Operator scroll place moved: saved_y={saved_box["y"]}, current_y={current_box["y"]}, saved_top={saved_top}, current_top={current_top}'
            expect(switch_locator).to_be_checked()
            cap(page, 'scrolled')
            passed('scroll preservation')
        except Exception as error:
            # Record diagnostics without aborting the run
            report.setdefault('failures', []).append({
                'scenario': 'scroll preservation',
                'error': str(error),
                'rowError': page.locator('.row-error').first.text_content() if page.locator('.row-error').count() else None,
                'switchDisabled': target_group.locator(f'input.switch[aria-label="{label}"]').is_disabled() if target_group else None,
                'savedTop': saved_top,
                'currentTop': current_top,
            })
            cap(page, 'scrolled')

        report['visual'] = {
            'route': '#/models',
            'widths': [1280, 1600],
            'productionCaptures': report['captures'],
            'referenceCaptures': reference_captures,
        }

        visual_md = evidence / 'models-visual-inspection.md'
        visual_md.write_text(
            '# Models Visual Inspection\n\n'
            '## Captures\n\n'
            + '\n'.join(f'- {c}' for c in report['captures']) + '\n\n'
            '## Reference Captures\n\n'
            + '\n'.join(f'- {c}' for c in reference_captures) + '\n\n'
            '## States Covered\n\n'
            + '\n'.join(f'- {s}' for s in report['scenarios']) + '\n'
        )

        assert not report.get('failures'), report.get('failures')
        assert not report['pageErrors']
        report['status'] = 'passed'

    except Exception:
        raise

def pick_option_label(opt) -> str:
    model = opt.locator('.mid').text_content().strip()
    prov = opt.locator('.mprov').text_content().strip()
    return f'{model} ({prov})'


def run_picker(url, page):
    global reference_server

    def control(action, value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def goto_conversations_page(page):
        page.goto(url + '/#/conversations?ws=fixture&tab=new', wait_until='domcontentloaded')
        page.wait_for_selector('dialog#thread-new-dialog', timeout=5000)

    def cap_picker(page, name, widths=(1280, 1600)):
        for width in widths:
            page.set_viewport_size({'width': width, 'height': 900})
            page.wait_for_timeout(200)
            path = browser_evidence / f'picker-{name}@{width}.png'
            page.screenshot(path=str(path))
            report['captures'].append(str(path))

    def pick_close(page):
        if page.locator('#thread-new-model-list').count() > 0:
            page.keyboard.press('Escape')
            page.wait_for_selector('#thread-new-model-list', state='hidden', timeout=1000)

    def active_option(page):
        desc = page.locator('#thread-new-model').get_attribute('aria-activedescendant')
        if desc:
            return page.locator('#' + desc)
        return page.locator('')

    def passed(label):
        report['scenarios'].append(label)

    try:
        goto_conversations_page(page)
        dialog = page.locator('dialog#thread-new-dialog')
        expect(dialog).to_be_visible()

        # a. ideal
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        opts = page.locator('#thread-new-model-list [role="option"]')
        assert opts.count() >= 2, 'expected at least 2 options'
        expect(page.locator('#thread-new-model')).to_contain_text('Pi default')

        opt_labels = []
        for i in range(1, opts.count()):
            opt = opts.nth(i)
            opt_labels.append(pick_option_label(opt))

        expected_order = [
            'claude-haiku-5-5 (pi-claude-cli)',
            'claude-sonnet-5-5 (pi-claude-cli)',
            'deepseek-v4-pro (deepseek)',
            'glm-5.3 (zai)',
            'gpt-6-sol (openai-codex)',
            'k3 (kimi-coding)',
            'retired-model (old-provider)'
        ]
        assert opt_labels == expected_order, f'Expected {expected_order}, got {opt_labels}'

        retired = page.locator('#thread-new-model-list [role="option"]').filter(has_text='retired-model')
        expect(retired).to_have_attribute('aria-disabled', 'true')
        expect(retired.locator('.why')).to_contain_text('Not in fixture-host catalog')

        footer_text = page.locator('#thread-new-model-manage').text_content().strip()
        assert footer_text == 'Manage preferred models'

        cap_picker(page, 'ideal')
        passed('ideal')

        # b. keyboard
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        page.keyboard.press('Home')
        active = active_option(page)
        assert active.count() == 1, 'expected one active option after Home'
        assert active.locator('.mid').text_content().strip() == 'Pi default', 'expected Pi default after Home'
        page.keyboard.press('ArrowDown')
        page.wait_for_timeout(100)
        active = active_option(page)
        assert active.count() == 1, 'expected one active option after ArrowDown'
        assert active.locator('.mid').text_content().strip() == 'claude-haiku-5-5', 'expected claude-haiku-5-5 after ArrowDown'
        assert active.get_attribute('aria-disabled') != 'true', 'expected first enabled option not disabled'
        page.keyboard.press('ArrowDown')
        page.wait_for_timeout(100)
        active = active_option(page)
        assert active.locator('.mid').text_content().strip() == 'claude-sonnet-5-5', 'expected claude-sonnet-5-5 after second ArrowDown'
        page.keyboard.press('End')
        page.wait_for_timeout(100)
        active = active_option(page)
        assert active.locator('.mid').text_content().strip() == 'k3', 'expected k3 after End'
        assert active.evaluate("el => { const r=el.getBoundingClientRect(), list=el.closest('ul').getBoundingClientRect(), d=el.closest('dialog').getBoundingClientRect(); return r.top >= Math.max(0,list.top,d.top) && r.bottom <= Math.min(innerHeight,list.bottom,d.bottom); }")
        assert page.locator('#thread-create').evaluate("el => { const r=el.getBoundingClientRect(), d=el.closest('dialog').getBoundingClientRect(); return r.top >= d.top && r.bottom <= Math.min(innerHeight,d.bottom); }")

        page.keyboard.press('Enter')
        page.wait_for_timeout(300)
        expect(page.locator('#thread-new-model')).to_contain_text('k3')
        expect(page.locator('#thread-new-model')).to_contain_text('kimi-coding')
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        for _ in range(8):
            page.keyboard.press('ArrowDown')
            page.wait_for_timeout(50)
            active = active_option(page)
            assert active.get_attribute('aria-disabled') != 'true', 'expected active option never disabled in ArrowDown loop'
        cap_picker(page, 'keyboard')
        passed('keyboard')

        # c. typeahead
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        trigger_text_before = page.locator('#thread-new-model').text_content().strip()
        page.keyboard.type('r')
        page.wait_for_timeout(100)
        page.wait_for_timeout(700)
        active = active_option(page)
        assert active.count() == 0 or active.get_attribute('aria-disabled') != 'true', 'expected no option or not disabled after r'
        assert page.locator('#thread-new-model').text_content().strip() == trigger_text_before, 'expected trigger unchanged after r'
        page.keyboard.type('k')
        page.wait_for_timeout(100)
        active = active_option(page)
        assert active.count() == 1, 'expected one active option after k'
        assert active.locator('.mid').text_content().strip() == 'k3', 'expected k3 after k'
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        expect(dialog).to_be_visible()
        expect(page.locator('#thread-new-model')).to_contain_text('k3')
        cap_picker(page, 'typeahead')
        passed('typeahead')

        page.locator('#thread-new-model').click()
        page.keyboard.press('Tab')
        expect(page.locator('#thread-new-model-manage')).to_be_focused()
        page.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        expect(page.locator('#thread-new-model')).to_be_focused()
        expect(page.locator('#thread-new-model-list')).to_have_count(0)
        page.locator('#thread-new-model').click()
        dialog.locator('h2').click()
        expect(page.locator('#thread-new-model-list')).to_have_count(0)
        passed('footer Escape and outside click dismiss only the picker')

        # d. mouse
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        glm_opt = page.locator('#thread-new-model-list [role="option"]').filter(has_text='glm-5.3')
        expect(glm_opt).to_have_attribute('aria-disabled', 'false')
        glm_opt.click()
        page.wait_for_timeout(300)
        expect(page.locator('#thread-new-model')).to_contain_text('glm-5.3')
        expect(page.locator('#thread-new-model')).to_contain_text('zai')
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        expect(glm_opt).to_have_attribute('aria-selected', 'true')
        page.keyboard.press('Escape')
        cap_picker(page, 'mouse')
        passed('mouse')

        # e. Tab reaches the footer navigation, then leaves the picker
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        page.keyboard.press('Tab')
        page.wait_for_timeout(200)
        # The open list stays mounted so Tab lands on the footer navigation
        # element instead of Solid removing it before the browser moves focus.
        expect(page.locator('#thread-new-model-list')).to_have_count(1)
        expect(page.locator('#thread-new-model-manage')).to_be_focused()
        cap_picker(page, 'tab-footer')
        # Tabbing past the footer leaves the field and closes the list without
        # stealing the operator's next form control.
        page.keyboard.press('Tab')
        page.wait_for_timeout(200)
        expect(page.locator('#thread-new-model-list')).to_have_count(0)
        expect(dialog).to_be_visible()
        # Reopen and activate the footer with the keyboard: it navigates to Models.
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        page.keyboard.press('Tab')
        page.wait_for_timeout(150)
        expect(page.locator('#thread-new-model-manage')).to_be_focused()
        page.keyboard.press('Enter')
        page.wait_for_timeout(300)
        expect(page.locator('#catalog-meta')).to_be_visible()
        passed('footer keyboard navigation')

        # f. empty
        control('models-preferences-empty', 'true')
        page.reload(wait_until='domcontentloaded')
        goto_conversations_page(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        opts = page.locator('#thread-new-model-list [role="option"]')
        assert opts.count() == 1, 'expected exactly 1 option'
        expect(opts.first).to_have_attribute('aria-selected', 'true')
        expect(page.locator('#thread-new-model-list .mnote')).to_contain_text('No preferred models yet')
        footer_text = page.locator('#thread-new-model-manage').text_content().strip()
        assert footer_text == 'Choose preferred models'
        cap_picker(page, 'empty')
        passed('empty')

        control('models-preferences-empty', 'false')
        page.reload(wait_until='domcontentloaded')
        goto_conversations_page(page)

        # g. disabled option in place
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        retired = page.locator('#thread-new-model-list [role="option"]').filter(has_text='retired-model')
        assert retired.get_attribute('aria-disabled') == 'true'
        expect(retired.locator('.why')).to_have_text('Not in fixture-host catalog')
        trigger_text = page.locator('#thread-new-model').text_content().strip()
        retired.dispatch_event('click')
        page.wait_for_timeout(300)
        new_trigger_text = page.locator('#thread-new-model').text_content().strip()
        assert new_trigger_text == trigger_text, 'expected trigger unchanged after clicking disabled option'
        cap_picker(page, 'disabled-option-in-place')
        passed('disabled option in place')

        # h. selected unavailable
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        glm_opt = page.locator('#thread-new-model-list [role="option"]').filter(has_text='glm-5.3')
        expect(glm_opt).to_have_attribute('aria-disabled', 'false')
        glm_opt.click()
        page.wait_for_timeout(300)
        expect(page.locator('#thread-new-model')).to_contain_text('glm-5.3')
        expect(page.locator('#thread-new-model')).to_contain_text('zai')
        pick_close(page)
        control('models-catalog-drop', 'zai|glm-5.3')
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        error_loc = page.locator('.mfield .field-error[role="alert"]')
        error_loc.wait_for(state='visible', timeout=5000)
        expect(page.locator('#thread-new-model')).to_contain_text('glm-5.3')
        expect(page.locator('#thread-new-model')).to_contain_text('zai')
        glm_opt = page.locator('#thread-new-model-list [role="option"]').filter(has_text='glm-5.3')
        assert glm_opt.get_attribute('aria-disabled') == 'true'
        expect(glm_opt.locator('.why')).to_have_text('Not in fixture-host catalog')
        assert error_loc.first.text_content().strip().count('is not in the fixture-host catalog') >= 1
        assert error_loc.first.text_content().strip().count('manage preferred models') >= 1
        cap_picker(page, 'selected-unavailable')
        passed('selected unavailable')

        control('models-catalog-drop', '')
        page.reload(wait_until='domcontentloaded')
        goto_conversations_page(page)

        # i. catalog unreadable: the unread reason is named once, not twice
        control('models-catalog-fail', 'true')
        page.reload(wait_until='domcontentloaded')
        goto_conversations_page(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        unknown = page.locator('#thread-new-model-list [role="option"]').filter(has_text='claude-haiku-5-5')
        assert unknown.get_attribute('aria-disabled') == 'true', 'expected preferred option disabled without a catalog'
        assert unknown.locator('.why').text_content().strip() == 'Availability unknown; catalog not read', 'expected one unread-catalog reason'
        cap_picker(page, 'catalog-unreadable')
        passed('catalog unreadable')
        control('models-catalog-fail', 'false')
        page.reload(wait_until='domcontentloaded')
        goto_conversations_page(page)

        # Render the reference screens from their own origin the same way the
        # models case does, so the receipt carries real reference captures.
        reference_captures = []
        if reference_dir and (reference_dir / 'vendor' / 'tailwind.js').is_file():
            reference_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_dir)))
            port = reference_server.server_address[1]
            threading.Thread(target=reference_server.serve_forever, daemon=True).start()
            ref_page = context.new_page()
            ref_page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
            for ref in ['12-thread-model-picker.html', '14-model-picker-empty.html', '15-model-picker-unavailable.html']:
                if not (reference_dir / 'screens' / ref).is_file():
                    continue
                for width in (1280, 1600):
                    ref_page.set_viewport_size({'width': width, 'height': 900})
                    ref_page.goto(f'http://127.0.0.1:{port}/screens/{ref}')
                    ref_page.wait_for_timeout(300)
                    cap_path = browser_evidence / f'picker-reference-{ref.replace(".html", "")}@{width}.png'
                    ref_page.screenshot(path=str(cap_path))
                    reference_captures.append(str(cap_path))
            ref_page.close()
            reference_server.shutdown()
        if reference_dir:
            assert len(reference_captures) == 6, f'expected 6 picker reference captures, got {len(reference_captures)}'

        report['visual'] = {
            'route': '#/conversations?ws=fixture&tab=new + #thread-new-model',
            'widths': [1280, 1600],
            'productionCaptures': report['captures'],
            'referenceCaptures': reference_captures,
        }

        visual_md = evidence / 'picker-visual-inspection.md'
        visual_md.write_text(
            '# Picker Visual Inspection\n\n'
            '## Captures\n\n'
            + '\n'.join(f'- {c}' for c in report['captures']) + '\n\n'
            '## Reference Captures\n\n'
            + '\n'.join(f'- {c}' for c in reference_captures) + '\n\n'
            '## States Covered\n\n'
            + '\n'.join(f'- {s}' for s in report['scenarios']) + '\n'
        )

        assert not report.get('failures'), report.get('failures')
        assert not report['pageErrors']
        report['status'] = 'passed'

    except Exception as error:
        report.setdefault('failures', []).append({
            'scenario': 'runtime error',
            'error': str(error),
            'traceback': traceback.format_exc(),
        })

def run_conversation(url, page):
    global reference_server

    def control(action, value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def posts_of(name):
        return [p for p in control('')['posts'] if p['name'] == name]

    def goto_new(page):
        page.goto(url + '/#/conversations?ws=fixture&tab=new', wait_until='domcontentloaded')
        page.wait_for_selector('dialog#thread-new-dialog', timeout=5000)

    def cap_conv(name, widths=(1280, 1600)):
        for width in widths:
            page.set_viewport_size({'width': width, 'height': 900})
            page.wait_for_timeout(200)
            path = browser_evidence / f'conversation-{name}@{width}.png'
            page.screenshot(path=str(path))
            report['captures'].append(str(path))

    def choose(model):
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        expect(page.locator('#thread-new-model-list [role="option"]').filter(has_text=model).first).to_have_attribute('aria-disabled', 'false')
        page.locator('#thread-new-model-list [role="option"]').filter(has_text=model).first.click()
        page.wait_for_timeout(200)

    def open_picker():
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')

    def close_picker():
        if page.locator('#thread-new-model-list').count() > 0:
            page.keyboard.press('Escape')
            page.wait_for_selector('#thread-new-model-list', state='hidden', timeout=1000)

    def model_line():
        line = page.locator('.model-line').first
        return line.inner_text() if line.count() > 0 else ''

    def passed(label):
        report['scenarios'].append(label)

    def capture_references():
        reference_captures = []
        if not reference_dir:
            return reference_captures
        root = reference_dir
        assert (root / 'vendor' / 'tailwind.js').is_file()
        global reference_server
        reference_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(root)))
        port = reference_server.server_address[1]
        threading.Thread(target=reference_server.serve_forever, daemon=True).start()
        ref_page = context.new_page()
        ref_page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
        for ref in ['12-thread-model-picker.html', '16-conversation-model.html']:
            if not (root / 'screens' / ref).is_file():
                continue
            for width in (1280, 1600):
                ref_page.set_viewport_size({'width': width, 'height': 900})
                ref_page.goto(f'http://127.0.0.1:{port}/screens/{ref}')
                ref_page.wait_for_timeout(300)
                path = browser_evidence / f'conversation-reference-{ref.replace(".html", "")}@{width}.png'
                ref_page.screenshot(path=str(path))
                reference_captures.append(str(path))
        ref_page.close()
        reference_server.shutdown()
        return reference_captures

    try:
        reference_captures = capture_references()

        # a. explicit pair persists and the header matches
        goto_new(page)
        choose('glm-5.3')
        expect(page.locator('#thread-new-model')).to_contain_text('glm-5.3')
        expect(page.locator('#thread-new-model')).to_contain_text('zai')
        with page.expect_response('**/api/thread/create') as response:
            page.locator('#thread-create').click()
        assert response.value.ok, response.value
        created = posts_of('create')[-1]
        assert created['input'].get('model') == {'provider': 'zai', 'model': 'glm-5.3'}, created['input']
        created_id = created['result']['thread_id']
        assert control('')['createdThreads'][-1]['model'] == {'provider': 'zai', 'model': 'glm-5.3'}
        page.wait_for_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(created_id)))
        page.wait_for_selector('.model-line')
        assert 'glm-5.3' in model_line() and 'zai' in model_line()
        cap_conv('created-header')
        passed('explicit pair persists and the header matches')

        # b. real default body omits model and the header reads Pi default
        goto_new(page)
        expect(page.locator('#thread-new-model')).to_contain_text('Pi default')
        with page.expect_response('**/api/thread/create') as default_response:
            page.locator('#thread-create').click()
        assert default_response.value.ok, default_response.value
        default_created = posts_of('create')[-1]
        assert 'model' not in default_created['input'], default_created['input']
        default_id = default_created['result']['thread_id']
        page.wait_for_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(default_id)))
        page.wait_for_selector('.model-line')
        assert 'Pi default' in model_line()
        cap_conv('default-header')
        passed('real default body omits model and the header reads Pi default')

        # c. retained pair survives Manage/back and close/reopen
        goto_new(page)
        choose('deepseek-v4-pro')
        expect(page.locator('#thread-new-model')).to_contain_text('deepseek-v4-pro')
        open_picker()
        page.locator('#thread-new-model-manage').click()
        page.wait_for_timeout(300)
        assert '#/models' in page.url
        goto_new(page)
        expect(page.locator('#thread-new-model')).to_contain_text('deepseek-v4-pro')
        expect(page.locator('#thread-new-model')).to_contain_text('deepseek')
        page.locator('dialog#thread-new-dialog button', has_text='Return to threads').click()
        page.wait_for_timeout(200)
        page.goto(url + '/#/conversations?ws=fixture', wait_until='domcontentloaded')
        goto_new(page)
        expect(page.locator('#thread-new-model')).to_contain_text('deepseek-v4-pro')
        cap_conv('retained')
        passed('retained pair survives Manage/back and close/reopen')

        # d. catalog removal before create refuses and preserves the draft
        goto_new(page)
        choose('glm-5.3')
        control('models-catalog-drop', 'zai|glm-5.3')
        open_picker()
        close_picker()
        before = len(posts_of('create'))
        page.locator('#thread-create').click()
        page.wait_for_selector('.mfield .field-error', state='visible')
        expect(page.locator('.mfield .field-error')).to_contain_text('not in the fixture-host catalog')
        expect(page.locator('#thread-new-model')).to_be_focused()
        assert len(posts_of('create')) == before, 'unavailable create sent a request'
        expect(page.locator('#thread-new-model')).to_contain_text('glm-5.3')
        cap_conv('unavailable')
        control('models-catalog-drop', '')
        open_picker()
        expect(page.locator('#thread-new-model-list [role="option"]').filter(has_text='Pi default').first).to_have_attribute('aria-disabled', 'false')
        page.locator('#thread-new-model-list [role="option"]').filter(has_text='Pi default').first.click()
        expect(page.locator('.mfield .field-error')).to_have_count(0)
        passed('catalog removal before create refuses and preserves the draft')

        # e. preference change leaves an existing thread unchanged
        existing = next(t for t in control('')['threads'] if t.get('title') == 'Discussion one')
        page.goto(url + '/#/conversations?ws=fixture&id=' + existing['thread_id'], wait_until='domcontentloaded')
        page.wait_for_selector('.model-line')
        assert 'Pi default' in model_line()
        control('models-preferences-empty', 'true')
        page.goto(url + '/#/conversations?ws=fixture', wait_until='domcontentloaded')
        page.goto(url + '/#/conversations?ws=fixture&id=' + existing['thread_id'], wait_until='domcontentloaded')
        page.wait_for_selector('.model-line')
        assert 'Pi default' in model_line()
        page.goto(url + '/#/conversations?ws=fixture&id=' + created_id, wait_until='domcontentloaded')
        page.wait_for_selector('.model-line')
        assert 'glm-5.3' in model_line() and 'zai' in model_line()
        cap_conv('preference-independent')
        control('models-preferences-empty', 'false')
        passed('preference change leaves an existing thread unchanged')

        # f. New thread with another model opens the existing dialog
        page.goto(url + '/#/conversations?ws=fixture&id=' + created_id, wait_until='domcontentloaded')
        page.wait_for_selector('[data-thread-new-with-model]')
        page.locator('[data-thread-new-with-model]').click()
        expect(page.locator('dialog#thread-new-dialog')).to_be_visible()
        expect(page.locator('#thread-new-model')).to_be_visible()
        if page.locator('#thread-send').count() > 0:
            assert 'ds-btn--primary' in (page.locator('#thread-send').get_attribute('class') or '')
        cap_conv('new-with-another-model')
        passed('New thread with another model opens the existing dialog')

        if reference_dir:
            assert len(reference_captures) == 4, f'expected 4 conversation reference captures, got {len(reference_captures)}'

        report['visual'] = {
            'route': '#/conversations?ws=fixture&tab=new + thread header',
            'widths': [1280, 1600],
            'productionCaptures': report['captures'],
            'referenceCaptures': reference_captures,
        }
        visual_md = evidence / 'conversation-visual-inspection.md'
        visual_md.write_text(
            '# Conversation Model Visual Inspection\n\n'
            '## Captures\n\n' + '\n'.join(f'- {c}' for c in report['captures']) + '\n\n'
            '## Reference Captures\n\n' + '\n'.join(f'- {c}' for c in reference_captures) + '\n\n'
            '## States Covered\n\n' + '\n'.join(f'- {s}' for s in report['scenarios']) + '\n'
        )
        assert not report.get('failures'), report.get('failures')
        assert not report['pageErrors']
        report['status'] = 'passed'
    except Exception as error:
        report.setdefault('failures', []).append({
            'scenario': 'conversation',
            'error': str(error),
            'traceback': traceback.format_exc(),
        })

def run_assignment(url, page):
    global reference_server

    def control(action, value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def posts_of(name):
        return [p for p in control('')['posts'] if p['name'] == name]

    def brief(page):
        page.goto(url + '/#/launch?' + urlencode({'ws': 'fixture', 'target': 'fixture-repo'}), wait_until='domcontentloaded')
        page.wait_for_selector('#launch-model')

    def review_route(page):
        page.goto(url + '/#/launch?' + urlencode({'ws': 'fixture', 'tab': 'review', 'target': 'fixture-repo'}), wait_until='domcontentloaded')

    def choose(page, model):
        page.locator('#launch-model').click()
        page.wait_for_selector('#launch-model-list')
        expect(page.locator('#launch-model-list [role="option"]').filter(has_text=model).first).to_have_attribute('aria-disabled', 'false')
        page.locator('#launch-model-list [role="option"]').filter(has_text=model).first.click()
        page.wait_for_timeout(200)

    def model_fact(page):
        return page.locator('#launch-review .launch-contract [data-fact=model] dd')

    def cap_assignment(page, name):
        for width in (1280, 1600):
            page.set_viewport_size({'width': width, 'height': 900})
            page.wait_for_timeout(200)
            path = browser_evidence / f'assignment-{name}@{width}.png'
            page.screenshot(path=str(path))
            report['captures'].append(str(path))

    def fill_and_save(page, title, content):
        page.locator('#launch-brief-title').fill(title)
        page.locator('#launch-brief-content').fill(content)
        page.locator('#launch-save').click()

    def passed(label):
        report['scenarios'].append(label)

    def capture_references():
        reference_captures = []
        if reference_dir:
            reference_root = reference_dir
            assert (reference_root / 'vendor' / 'tailwind.js').is_file()
            global reference_server
            reference_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_root)))
            port = reference_server.server_address[1]
            reference_thread = threading.Thread(target=reference_server.serve_forever, daemon=True)
            reference_thread.start()
            files = ['13-assignment-model-picker.html', '15-model-picker-unavailable.html']
            ref_page = context.new_page()
            ref_page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
            for f in files:
                for width in (1280, 1600):
                    ref_page.goto(f'http://127.0.0.1:{port}/screens/{f}')
                    ref_page.wait_for_timeout(300)
                    ref_page.set_viewport_size({'width': width, 'height': 900})
                    ref_page.wait_for_timeout(150)
                    path = browser_evidence / f'assignment-reference-{f.replace(".html", "")}@{width}.png'
                    ref_page.screenshot(path=str(path))
                    reference_captures.append(str(path))
            ref_page.close()
            reference_server.shutdown()
        return reference_captures

    try:
        reference_captures = capture_references()

        # 1. FORM + REVIEW PAIR
        brief(page)
        expect(page.locator('#launch-heading')).to_contain_text('Prepare assignment')
        expect(page.locator('#launch-model')).to_contain_text('Pi default')
        choose(page, 'glm-5.3')
        expect(page.locator('#launch-model')).to_contain_text('glm-5.3')
        expect(page.locator('#launch-model')).to_contain_text('zai')
        expect(page.locator('#launch-form details p')).to_contain_text('glm-5.3 · zai')
        cap_assignment(page, 'form')
        fill_and_save(page, 'Model assignment', 'Verify the chosen model reaches the reviewed contract.')
        page.locator('#launch-review .launch-contract').wait_for(state='visible')
        expect(model_fact(page)).to_contain_text('glm-5.3 · zai')
        last_preview = posts_of('dispatchPreview')[-1]['input']
        assert last_preview.get('provider') == 'zai'
        assert last_preview.get('model') == 'glm-5.3'
        cap_assignment(page, 'review')
        passed('form and reviewed pair')

        # 1b. AVAILABILITY LOSS AFTER REVIEW BLOCKS LAUNCH
        # A current review exists for glm-5.3. Drop that pair from the catalog,
        # re-read the catalog through the brief form's picker, then return to
        # the review surface where the picker is absent and attempt the guarded
        # launch: the front-end availability guard must refuse and send no
        # dispatch.
        control('models-catalog-drop', 'zai|glm-5.3')
        page.locator('#launch-assignment-edit').click()
        page.wait_for_selector('#launch-model')
        page.locator('#launch-model').click()
        page.wait_for_selector('#launch-model-list')
        expect(page.locator('.mfield .field-error')).to_contain_text('not in the fixture-host catalog')
        page.keyboard.press('Escape')
        page.wait_for_selector('#launch-model-list', state='hidden', timeout=1000)
        page.goto(url + '/#/agents?ws=fixture', wait_until='domcontentloaded')
        review_route(page)
        launch_error = page.locator('#launch-model-review-error')
        launch_error.wait_for(state='visible')
        expect(launch_error).to_contain_text('not in the fixture-host catalog')
        before_launch = len(posts_of('dispatchLaunch'))
        page.locator('#launch-assignment-launch').click()
        expect(launch_error).to_be_focused()
        assert len(posts_of('dispatchLaunch')) == before_launch, 'unavailable reviewed pair reached dispatchLaunch'
        cap_assignment(page, 'unavailable-after-review')
        control('models-catalog-drop', '')
        passed('availability loss after review blocks launch')

        # 2. MODEL EDIT EXPIRES APPROVAL
        page.locator('#launch-assignment-edit').click()
        page.wait_for_selector('#launch-model')
        choose(page, 'claude-haiku-5-5')
        page.goto(url + '/#/agents?ws=fixture', wait_until='domcontentloaded')
        review_route(page)
        page.locator('#launch-review-error').wait_for(state='visible')
        expect(page.locator('#launch-review-error')).to_contain_text('model')
        expect(page.locator('#launch-assignment-launch')).to_have_count(0)
        assert len(posts_of('dispatchLaunch')) == 0
        page.locator('#launch-assignment-review').click()
        page.locator('#launch-review .launch-contract [data-fact=model] dd').wait_for(state='visible')
        expect(model_fact(page)).to_contain_text('claude-haiku-5-5 · pi-claude-cli')
        passed('model edit expires approval and re-review binds new pair')

        # 3. UNAVAILABLE BEFORE SAVE
        page.reload(wait_until='domcontentloaded')
        brief(page)
        choose(page, 'glm-5.3')
        control('models-catalog-drop', 'zai|glm-5.3')
        page.locator('#launch-model').click()
        page.wait_for_selector('#launch-model-list')
        page.keyboard.press('Escape')
        before = len(posts_of('dispatchSaveBrief'))
        page.locator('#launch-save').click()
        page.locator('.mfield .field-error').wait_for(state='visible')
        expect(page.locator('.mfield .field-error')).to_contain_text('not in the fixture-host catalog')
        expect(page.locator('#launch-model')).to_be_focused()
        assert len(posts_of('dispatchSaveBrief')) == before
        cap_assignment(page, 'unavailable')
        page.locator('#launch-model').click()
        page.wait_for_selector('#launch-model-list')
        expect(page.locator('#launch-model-list [role="option"]').filter(has_text='Pi default').first).to_have_attribute('aria-disabled', 'false')
        page.locator('#launch-model-list [role="option"]').filter(has_text='Pi default').first.click()
        expect(page.locator('.mfield .field-error')).to_have_count(0)
        expect(page.locator('#launch-model')).to_contain_text('Pi default')
        control('models-catalog-drop', '')
        passed('unavailable selection blocks save and Pi default recovers')

        # 4. REAL MATCHING LAUNCH
        page.reload(wait_until='domcontentloaded')
        brief(page)
        choose(page, 'deepseek-v4-pro')
        fill_and_save(page, 'Launch with model', 'Record the reviewed provider and model in the launch contract.')
        expect(model_fact(page)).to_contain_text('deepseek-v4-pro · deepseek')
        last_preview = posts_of('dispatchPreview')[-1]['input']
        assert last_preview.get('provider') == 'deepseek'
        assert last_preview.get('model') == 'deepseek-v4-pro'
        before_launch = len(posts_of('dispatchLaunch'))
        page.locator('#launch-assignment-launch').click()
        page.locator('#launch-result-facts').wait_for(state='visible')
        assert len(posts_of('dispatchLaunch')) == before_launch + 1
        last_launch = posts_of('dispatchLaunch')[-1]
        assert last_launch['input'].get('provider') == 'deepseek'
        assert last_launch['input'].get('model') == 'deepseek-v4-pro'
        entry = next((d for d in control('')['resolverDiagnostics'] if d.get('name') == 'dispatchLaunch'), None)
        assert entry is not None
        assert entry.get('matched') is True
        cap_assignment(page, 'launched')
        passed('real matching launch records the reviewed pair')

        # 5. PACKAGE DEFAULT
        page.goto(url + '/#/launch?' + urlencode({'ws': 'fixture', 'tab': 'brief', 'package': 'fixture/browser', 'skill': 'spec-end-to-end', 'target': 'fixture-repo'}), wait_until='domcontentloaded')
        page.wait_for_selector('#launch-model')
        expect(page.locator('#launch-model')).to_contain_text('Pi default')
        fill_and_save(page, 'Implement fixture/browser', 'Bound package assignment for the model default check.')
        page.locator('#launch-review .launch-contract--package').wait_for(state='visible')
        expect(page.locator('#launch-review .launch-contract--package [data-fact=model] dd')).to_contain_text('Host default')
        passed('package review keeps Host default')

        report['visual'] = {
            'route': '#/launch + #/launch-review',
            'widths': [1280, 1600],
            'productionCaptures': report['captures'],
            'referenceCaptures': reference_captures,
        }

        if reference_dir:
            assert len(reference_captures) == 4, f'expected 4 assignment reference captures, got {len(reference_captures)}'

        visual_md = evidence / 'assignment-visual-inspection.md'
        visual_md.write_text(
            '# Assignment Visual Inspection\n\n'
            '## Captures\n\n'
            + '\n'.join(f'- {c}' for c in report['captures']) + '\n\n'
            '## Reference Captures\n\n'
            + '\n'.join(f'- {c}' for c in reference_captures) + '\n\n'
            '## States Covered\n\n'
            + '\n'.join(f'- {s}' for s in report['scenarios']) + '\n'
        )

        assert not report.get('failures'), report.get('failures')
        assert not report['pageErrors']
        report['status'] = 'passed'

    except Exception as error:
        report.setdefault('failures', []).append({
            'scenario': 'runtime error',
            'error': str(error),
            'traceback': traceback.format_exc(),
        })

def main():
    global fixture, reference_server, browser, context, fixture_info
    try:
        if case == 'host-parser':
            run_host_parser()
        else:
            fixture_info = {'root': tempfile.mkdtemp(prefix='sentinel-solid-browser-')}
            fixture = subprocess.Popen(
                ['node', str(root / 'browser-fixture.mjs')],
                env={**os.environ, 'SENTINEL_MODELS': '1', 'SENTINEL_FIXTURE_ROOT': fixture_info['root'], **planned_env},
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
            )
            deadline = time.monotonic() + 10
            fixture_url = None
            while fixture.poll() is None and time.monotonic() < deadline:
                ready, _, _ = select.select([fixture.stdout], [], [], 1)
                if ready:
                    line = fixture.stdout.readline()
                    if line.startswith('{'):
                        fixture_info = json.loads(line)
                        fixture_url = fixture_info.get('url')
                        break
            if not fixture_url:
                raise RuntimeError('fixture did not start')
            report['fixture'] = {'url': fixture_url, 'root': fixture_info.get('root')}
            report['observedCommit'] = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
            report['dirty'] = bool(subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True).stdout.strip())
            with sync_playwright() as p:
                try:
                    browser = p.chromium.launch()
                    context = browser.new_context(viewport={'width': 1280, 'height': 900})
                    page = context.new_page()
                    page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
                    page.on('console', lambda c: report['consoleErrors'].append(c.text) if c.type == 'error' else None)
                    page.on('requestfailed', lambda r: report['requestFailures'].append(r.url))
                    runners = {'models': run, 'picker': run_picker, 'conversation': run_conversation, 'assignment': run_assignment, 'integrated': run_integrated}
                    runners[case](fixture_url, page)
                finally:
                    if context:
                        context.close()
                    if browser:
                        browser.close()
                    cleanup['browserClosed'] = True
    except Exception as error:
        report['status'] = 'failed'
        report.setdefault('failures', []).append({'error': str(error), 'traceback': traceback.format_exc()})
    finally:
        if reference_server:
            reference_server.shutdown()
            reference_server.server_close()
        if fixture:
            fixture.terminate()
            try:
                fixture.wait(timeout=5)
            except subprocess.TimeoutExpired:
                fixture.kill()
                fixture.wait(timeout=5)
            cleanup['fixtureTerminated'] = fixture.poll() is not None
        if fixture_info.get('root'):
            shutil.rmtree(fixture_info['root'], ignore_errors=True)
            cleanup['temporaryFixtureRootRemoved'] = fixture_info['root']
        report['cleanup'] = cleanup
        if case == 'integrated':
            update_step10_receipt('integrated', report.copy())
        elif case == 'host-parser':
            if report['status'] != 'passed':
                update_step10_receipt('hostParser', report.copy())
        else:
            write_receipt()
        print(json.dumps({'status': report['status'], 'elapsed_seconds': round(time.monotonic() - started, 3), 'scenarios': report['scenarios'], 'receipt_path': str(receipt_path)}, indent=2))
    return 0 if report['status'] == 'passed' else 1


def run_host_parser():
    """Run Node to parse the installed catalog and build the host-parser payload."""
    checkout_path = str(checkout)
    routes_path = str(checkout / 'scripts' / 'spec-observe' / 'model-routes.mjs')
    node_code = r'''
import { createModelCatalog } from "__ROUTES_PATH__";
(async () => {
  const start = Date.now();
  try {
    const { state, host, models, read_at, providers } = await createModelCatalog().read();
    const slashModels = models.filter(m => m.model.includes('/')).length;
    const samplePairs = models.slice(0, 8).map(m => `${m.provider}/${m.model}`);
    const distinctPairs = new Set(models.map(m => m.provider + '\u0000' + m.model)).size;
    const payload = {
      state,
      host,
      read_at,
      count: models.length,
      providers,
      distinctPairs,
      slashModels,
      samplePairs,
      elapsedMs: Date.now() - start,
      sourceRevision: '',
      candidateDirty: false,
      failures: []
    };
    if (state !== 'ready') payload.failures.push(`state is '${state}', expected 'ready'`);
    if (models.length === 0) payload.failures.push('count is 0');
    if (providers === 0) payload.failures.push('providers is 0');
    for (const m of models) {
      if (!m.provider || !m.model) payload.failures.push(`missing provider/model: ${JSON.stringify(m)}`);
      for (const c of [m.provider, m.model]) {
        for (const ch of c) { if (ch.charCodeAt(0) <= 32) { payload.failures.push(`invalid char in ${ch}`); break; } }
      }
      if (m.provider.startsWith('-')) payload.failures.push(`provider starts with -`);
      if (m.model.startsWith('-')) payload.failures.push(`model starts with -`);
      if (!/^\d+(?:\.\d+)?[KM]?$/.test(m.context)) payload.failures.push(`invalid context: ${m.context}`);
      if (!/^\d+(?:\.\d+)?[KM]?$/.test(m.max_out)) payload.failures.push(`invalid max_out: ${m.max_out}`);
      if (typeof m.thinking !== 'boolean') payload.failures.push(`thinking is not boolean: ${m.thinking}`);
      if (typeof m.images !== 'boolean') payload.failures.push(`images is not boolean: ${m.images}`);
      if (!/^[^/]*$/.test(m.provider)) payload.failures.push(`provider contains /`);
    }
    const seen = new Set();
    for (const m of models) {
      const key = `${m.provider}\u0000${m.model}`;
      if (seen.has(key)) payload.failures.push(`duplicate: ${key}`);
      seen.add(key);
    }
    payload.status = payload.failures.length === 0 ? 'passed' : 'failed';
    console.log(JSON.stringify({ result: payload, elapsedMs: Date.now() - start }));
  } catch (e) {
    console.log(JSON.stringify({ result: { state: 'error', host: '', count: 0, failures: [e.message], status: 'failed' }, elapsedMs: Date.now() - start }));
  }
})();
'''.replace('__ROUTES_PATH__', routes_path);
    result = subprocess.run(['node', '--input-type=module', '--eval', node_code], capture_output=True, text=True, cwd=checkout_path)
    try:
        output = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        output = {'result': {'state': 'error', 'host': '', 'count': 0, 'failures': ['failed to parse node output'], 'status': 'failed'}}
    data = output.get('result', {})
    data['sourceRevision'] = subprocess.run(['git', '-C', checkout_path, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    data['candidateDirty'] = bool(subprocess.run(['git', '-C', checkout_path, 'status', '--porcelain'], capture_output=True, text=True).stdout.strip())
    payload = {
        'state': data.get('state', ''),
        'host': data.get('host', ''),
        'read_at': data.get('read_at', ''),
        'count': data.get('count', 0),
        'providers': data.get('providers', 0),
        'distinctPairs': data.get('distinctPairs', 0),
        'slashModels': data.get('slashModels', 0),
        'samplePairs': data.get('samplePairs', []),
        'elapsedMs': data.get('elapsedMs', 0),
        'sourceRevision': data.get('sourceRevision', ''),
        'candidateDirty': data.get('candidateDirty', False),
        'failures': data.get('failures', []),
        'status': data.get('status', 'failed')
    }
    update_step10_receipt('hostParser', payload)
    report['status'] = payload['status']


def run_integrated(url, page):
    """Run the integrated workflow scenarios."""
    global reference_server

    def control(action, value=''):
        response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def posts_of(name):
        return [p for p in control('')['posts'] if p['name'] == name]

    def goto_new():
        page.goto(url + '/#/conversations?ws=fixture&tab=new', wait_until='domcontentloaded')
        page.wait_for_selector('dialog#thread-new-dialog', timeout=5000)

    def cap_integrated(name, widths=(1280, 1600)):
        for width in widths:
            page.set_viewport_size({'width': width, 'height': 900})
            page.wait_for_timeout(200)
            path = browser_evidence / f'integrated-{name}@{width}.png'
            page.screenshot(path=str(path))
            report['captures'].append(str(path))

    def choose(model):
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        expect(page.locator('#thread-new-model-list [role="option"]').filter(has_text=model).first).to_have_attribute('aria-disabled', 'false')
        page.locator('#thread-new-model-list [role="option"]').filter(has_text=model).first.click()
        page.wait_for_timeout(200)

    def choose_launch(model):
        page.locator('#launch-model').click()
        page.wait_for_selector('#launch-model-list')
        expect(page.locator('#launch-model-list [role="option"]').filter(has_text=model).first).to_have_attribute('aria-disabled', 'false')
        page.locator('#launch-model-list [role="option"]').filter(has_text=model).first.click()
        page.wait_for_timeout(200)

    def open_picker():
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')

    def close_picker():
        if page.locator('#thread-new-model-list').count() > 0:
            page.keyboard.press('Escape')
            page.wait_for_selector('#thread-new-model-list', state='hidden', timeout=1000)

    def model_line():
        line = page.locator('.model-line').first
        return line.inner_text() if line.count() > 0 else ''

    def brief():
        page.goto(url + '/#/launch?' + urlencode({'ws': 'fixture', 'target': 'fixture-repo'}), wait_until='domcontentloaded')
        page.wait_for_selector('#launch-model')

    def review_route():
        page.goto(url + '/#/launch?' + urlencode({'ws': 'fixture', 'tab': 'review', 'target': 'fixture-repo'}), wait_until='domcontentloaded')

    def model_fact():
        return page.locator('#launch-review .launch-contract [data-fact=model] dd')

    def fill_and_save(title, content):
        page.locator('#launch-brief-title').fill(title)
        page.locator('#launch-brief-content').fill(content)
        page.locator('#launch-save').click()

    def passed(label):
        report['scenarios'].append(label)

    def capture_references():
        reference_captures = []
        if reference_dir:
            reference_root = reference_dir
            assert (reference_root / 'vendor' / 'tailwind.js').is_file()
            global reference_server
            reference_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietRequestHandler, directory=str(reference_root)))
            port = reference_server.server_address[1]
            reference_thread = threading.Thread(target=reference_server.serve_forever, daemon=True)
            reference_thread.start()
            files = [
                '12-thread-model-picker.html',
                '13-assignment-model-picker.html',
                '16-conversation-model.html'
            ]
            ref_page = context.new_page()
            ref_page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
            for f in files:
                for width in (1280, 1600):
                    if not (reference_root / 'screens' / f).is_file():
                        continue
                    ref_page.set_viewport_size({'width': width, 'height': 900})
                    ref_page.goto(f'http://127.0.0.1:{port}/screens/{f}')
                    ref_page.wait_for_timeout(300)
                    path = browser_evidence / f'reference-{f.replace(".html", "")}@{width}.png'
                    ref_page.screenshot(path=str(path))
                    reference_captures.append(str(path))
            ref_page.close()
            reference_server.shutdown()
        return reference_captures

    try:
        reference_captures = capture_references()
        control('stale-launch', 'false')
        # 1. preference-enable
        page.goto(url + '/#/models', wait_until='domcontentloaded')
        zai_switch = page.locator('input.switch[aria-label="Preferred: glm-4.7 via zai"]')
        assert zai_switch.count() > 0
        assert not zai_switch.is_checked()
        zai_switch.click()
        page.wait_for_timeout(300)
        assert page.locator('input.switch[aria-label="Preferred: glm-4.7 via zai"]:checked').count() >= 1
        cap_integrated('preference-enabled')
        passed('preference-enable')

        # 2. picker-includes-without-reload
        page.goto(url + '/#/conversations?ws=fixture&tab=new', wait_until='domcontentloaded')
        page.wait_for_selector('dialog#thread-new-dialog')
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        opts = page.locator('#thread-new-model-list [role="option"]').filter(has_text='glm-4.7')
        assert opts.count() > 0
        first_opt = opts.first
        assert first_opt.locator('.mprov').text_content().strip() == 'zai'
        page.keyboard.press('Escape')
        page.wait_for_timeout(200)
        page.goto(url + '/#/launch?ws=fixture&target=fixture-repo', wait_until='domcontentloaded')
        page.locator('#launch-model').click()
        page.wait_for_selector('#launch-model-list')
        launch_opts = page.locator('#launch-model-list [role="option"]').filter(has_text='glm-4.7')
        assert launch_opts.count() > 0
        launch_opt = launch_opts.first
        assert launch_opt.locator('.mprov').text_content().strip() == 'zai'
        page.keyboard.press('Escape')
        cap_integrated('pickers-shared-list')
        passed('picker-includes-without-reload')

        # 3. create-explicit
        goto_new()
        choose('glm-4.7')
        with page.expect_response('**/api/thread/create') as response:
            page.locator('#thread-create').click()
        assert response.value.ok
        created = posts_of('create')[-1]
        assert created['input'].get('model') == {'provider': 'zai', 'model': 'glm-4.7'}, created['input']
        assert control('')['createdThreads'][-1]['model'] == {'provider': 'zai', 'model': 'glm-4.7'}
        created_id = created['result']['thread_id']
        page.wait_for_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(created_id)))
        page.wait_for_selector('.model-line')
        assert 'glm-4.7' in model_line() and 'zai' in model_line()
        page.locator('#thread-draft').fill('Fixture model handoff')
        page.locator('#thread-send').click()
        page.wait_for_timeout(300)
        rpc = control('')['modelRpcCalls'][-1]['args']
        assert rpc[rpc.index('--provider') + 1] == 'zai'
        assert rpc[rpc.index('--model') + 1] == 'glm-4.7'
        cap_integrated('created-header')
        passed('create-explicit')

        # 4. create-default
        goto_new()
        expect(page.locator('#thread-new-model')).to_contain_text('Pi default')
        with page.expect_response('**/api/thread/create') as default_response:
            page.locator('#thread-create').click()
        assert default_response.value.ok
        default_created = posts_of('create')[-1]
        assert 'model' not in default_created['input']
        page.wait_for_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(default_created['result']['thread_id'])))
        page.wait_for_selector('.model-line')
        assert 'Pi default' in model_line()
        cap_integrated('default-header')
        passed('create-default')

        # 5. assignment-default
        brief()
        expect(page.locator('#launch-model')).to_contain_text('Pi default')
        fill_and_save('Test', 'Test')
        page.locator('#launch-review .launch-contract').wait_for(state='visible')
        assert 'Pi default' in model_fact().text_content()
        cap_integrated('assignment-default')
        passed('assignment-default')

        # 6. assignment-explicit-review
        page.reload(wait_until='domcontentloaded')
        brief()
        choose_launch('glm-4.7')
        fill_and_save('Test', 'Test')
        page.locator('#launch-review .launch-contract').wait_for(state='visible')
        assert 'glm-4.7' in model_fact().text_content() and 'zai' in model_fact().text_content()
        last_preview = posts_of('dispatchPreview')[-1]['input']
        assert last_preview.get('provider') == 'zai' and last_preview.get('model') == 'glm-4.7'
        cap_integrated('assignment-review')
        passed('assignment-explicit-review')

        # 7. approval-expiry
        page.locator('#launch-assignment-edit').click()
        page.wait_for_selector('#launch-model')
        choose_launch('claude-haiku-5-5')
        page.goto(url + '/#/agents?ws=fixture')
        review_route()
        page.locator('#launch-review-error').wait_for(state='visible')
        assert 'model' in page.locator('#launch-review-error').text_content().lower()
        assert page.locator('#launch-assignment-launch').count() == 0
        cap_integrated('approval-expired')
        passed('approval-expiry')

        # 8. assignment-launch
        page.reload(wait_until='domcontentloaded')
        brief()
        choose_launch('glm-4.7')
        fill_and_save('Launch with model', 'Test')
        page.locator('#launch-review .launch-contract').wait_for(state='visible')
        assert 'glm-4.7' in model_fact().text_content() and 'zai' in model_fact().text_content()
        before_launch = len(posts_of('dispatchLaunch'))
        page.locator('#launch-assignment-launch').click()
        page.locator('#launch-result-facts').wait_for(state='visible')
        assert len(posts_of('dispatchLaunch')) == before_launch + 1
        last_launch = posts_of('dispatchLaunch')[-1]
        assert last_launch['input'].get('provider') == 'zai' and last_launch['input'].get('model') == 'glm-4.7'
        entry = next((d for d in control('')['resolverDiagnostics'] if d.get('name') == 'dispatchLaunch'), None)
        assert entry is not None and entry.get('matched') is True
        assert last_launch['persisted']['provider'] == 'zai'
        assert last_launch['persisted']['model'] == 'glm-4.7'
        launch_args = next(c['args'] for c in reversed(control('')['modelTmuxCalls']) if 'new-session' in c['args'])
        assert launch_args[launch_args.index('--provider') + 1] == 'zai'
        assert launch_args[launch_args.index('--model') + 1] == 'glm-4.7'

        cap_integrated('assignment-launched')
        passed('assignment-launch')

        # 9. preference-remove-thread-stable
        page.goto(url + '/#/models', wait_until='domcontentloaded')
        page.locator('input.switch[aria-label="Preferred: glm-4.7 via zai"]').first.click()
        page.wait_for_timeout(300)
        assert not page.locator('input.switch[aria-label="Preferred: glm-4.7 via zai"]').first.is_checked()
        page.goto(url + f'/#/conversations?ws=fixture&id={created_id}', wait_until='domcontentloaded')
        page.wait_for_selector('.model-line')
        assert 'glm-4.7' in model_line() and 'zai' in model_line()
        cap_integrated('preference-removed-thread-stable')
        passed('preference-remove-thread-stable')

        # 10. manage-return-draft
        page.goto(url + '/#/conversations?ws=fixture&tab=new', wait_until='domcontentloaded')
        page.wait_for_selector('dialog#thread-new-dialog')
        choose('deepseek-v4-pro')
        open_picker()
        page.locator('#thread-new-model-manage').click()
        page.wait_for_timeout(300)
        assert '/#/models' in page.url
        page.goto(url + '/#/conversations?ws=fixture&tab=new', wait_until='domcontentloaded')
        assert 'deepseek-v4-pro' in page.locator('#thread-new-model').text_content()
        cap_integrated('manage-return-draft')
        passed('manage-return-draft')

        # 11. selected-missing
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        expect(page.locator('#thread-new-model-list [role="option"]').filter(has_text='deepseek-v4-pro').first).to_have_attribute('aria-disabled', 'false')
        page.locator('#thread-new-model-list [role="option"]').filter(has_text='deepseek-v4-pro').first.click()
        page.wait_for_timeout(200)
        control('models-catalog-drop', 'deepseek|deepseek-v4-pro')
        open_picker()
        opt = page.locator('#thread-new-model-list [role="option"]').filter(has_text='deepseek-v4-pro').first
        expect(opt).to_have_attribute('aria-disabled', 'true')
        expect(opt.locator('.why')).to_contain_text('Not in fixture-host catalog')
        close_picker()
        before = len(posts_of('create'))
        page.locator('#thread-create').click()
        page.wait_for_selector('.mfield .field-error', state='visible')
        assert 'is not in the fixture-host catalog' in page.locator('.mfield .field-error').text_content()
        expect(page.locator('#thread-new-model')).to_be_focused()
        assert len(posts_of('create')) == before
        assert 'deepseek-v4-pro' in page.locator('#thread-new-model').text_content()
        control('models-catalog-drop', '')
        cap_integrated('selected-missing')
        passed('selected-missing')

        # 12. observer
        control('observer', 'true')
        page.goto(url + '/#/models', wait_until='domcontentloaded')
        expect(page.locator('.banner:has-text("viewed but not changed")')).to_be_visible()
        assert page.locator('input.switch:disabled').count() >= 1
        cap_integrated('observer')
        control('observer', 'false')
        passed('observer')

        if reference_dir:
            assert len(reference_captures) == 6, f'expected 6 reference captures, got {len(reference_captures)}'

        report['visual'] = {
            'route': '#/models + /conversations + /launch',
            'widths': [1280, 1600],
            'productionCaptures': report['captures'],
            'referenceCaptures': reference_captures,
        }

        assert not report.get('failures'), report.get('failures')
        assert not report['pageErrors']
        report['status'] = 'passed'

    except Exception as error:
        report.setdefault('failures', []).append({
            'scenario': 'integrated runtime error',
            'error': str(error),
            'traceback': traceback.format_exc(),
        })


if __name__ == '__main__':
    raise SystemExit(main())
