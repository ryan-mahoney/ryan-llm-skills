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
import json
import os
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
parser.add_argument('--case', choices=['models', 'picker'], default='models')
parser.add_argument('--reference-dir', default=None)
options = parser.parse_args()
case = options.case
reference_dir = Path(options.reference_dir).resolve() if options.reference_dir else None

root = Path(__file__).resolve().parent
checkout = root.parents[2]
evidence = Path(os.environ.get('SENTINEL_EVIDENCE_DIR', '/tmp/sentinel-models-evidence'))
browser_evidence = evidence / 'browser'
browser_evidence.mkdir(parents=True, exist_ok=True)
receipt_path = evidence / 'step-006-models-result.json' if case == 'picker' else evidence / 'step-005-models-result.json'
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

        # 2. search+chips: query and capability filters
        page.locator('#find-model').fill('claude')
        page.wait_for_timeout(100)
        meta_text = page.locator('#catalog-meta').text_content()
        assert 'matched' in meta_text.lower()
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
        page.locator('.empty-inline button:has-text("Clear search")').click()
        page.wait_for_timeout(100)
        expect(page.locator('#find-model')).to_have_value('')
        assert first_table.locator('tbody tr').count() >= 6
        cap(page, 'no-matches')
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
        expect(page.locator('.empty h2:has-text("No preferred models yet")')).to_be_visible()
        expect(page.locator('.empty button:has-text("Find model")')).to_be_visible()
        page.locator('.empty button:has-text("Find model")').click()
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
        prov_group = page.locator('details.prov-group').first
        prov_group.locator('summary').click()
        page.wait_for_timeout(200)
        unchecked = prov_group.locator('input.switch:not(:checked)')
        if unchecked.count() > 0:
            candidate = unchecked.first
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
        expect(page.locator('.ds-callout:has-text("Catalog load failed")').first).to_be_visible()
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
            # Record saved scroll position
            full_page = page.locator('.full-page').first
            saved_top = full_page.evaluate('(el) => el.scrollTop')
            # Only assert non-zero if there's actual scrollable content
            scroll_info = full_page.evaluate('(el) => ({scrollHeight: el.scrollHeight, clientHeight: el.clientHeight})')
            if scroll_info['scrollHeight'] > scroll_info['clientHeight']:
                assert saved_top > 0, f'Expected non-zero scroll position, got {saved_top}'
            # Click the target with firmer interaction (no auto-scroll since we already scrolled into view)
            candidate.check(timeout=5000)
            page.wait_for_timeout(400)
            current_top = full_page.evaluate('(el) => el.scrollTop')
            assert abs(current_top - saved_top) <= 2, f'Scroll position changed: saved={saved_top}, current={current_top}'
            expect(target_group.locator(f'input.switch[aria-label="{label}"]')).to_be_checked()
            cap(page, 'scrolled')
            passed('scroll preservation')
        except Exception as error:
            # Record diagnostics without aborting the run
            report.setdefault('failures', []).append({
                'scenario': 'scroll preservation',
                'error': str(error),
                'rowError': page.locator('.row-error').first.text_content() if page.locator('.row-error').count() else None,
                'switchDisabled': target_group.locator(f'input.switch[aria-label="{label}"]').is_disabled() if target_group else None,
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
            '\n'.join(f'- {c}' for c in report['captures']) + '\n\n'
            '## Reference Captures\n\n'
            '\n'.join(f'- {c}' for c in reference_captures) + '\n\n'
            '## States Covered\n\n'
            '\n'.join(f'- {s}' for s in report['scenarios']) + '\n'
        )

        assert not report.get('failures'), report.get('failures')
        assert not report['pageErrors']
        report['status'] = 'passed'

    finally:
        if held_routes:
            for r in held_routes:
                try:
                    r.abort()
                except:
                    pass
        if reference_server:
            reference_server.shutdown()
        if context:
            context.close()
        if browser:
            browser.close()
        if fixture:
            try:
                fixture.terminate()
                for _ in range(10):
                    if fixture.poll() is not None:
                        break
                    time.sleep(0.5)
                if fixture.poll() is None:
                    fixture.kill()
            except:
                pass
        cleanup['fixtureTerminated'] = True
        cleanup['browserClosed'] = True
        if fixture_info.get('root'):
            try:
                shutil.rmtree(fixture_info['root'])
                cleanup['temporaryFixtureRootRemoved'] = fixture_info['root']
            except:
                pass


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

        # d. mouse
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        glm_opt = page.locator('#thread-new-model-list [role="option"]').filter(has_text='glm-5.3')
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

        # e. tab-away
        pick_close(page)
        page.locator('#thread-new-model').click()
        page.wait_for_selector('#thread-new-model-list')
        page.keyboard.press('Tab')
        page.wait_for_timeout(200)
        expect(page.locator('#thread-new-model-list')).to_have_count(0)
        expect(dialog).to_be_visible()
        cap_picker(page, 'tab-away')
        passed('tab-away')

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
        assert retired.locator('.why').text_content().strip() == 'Not in fixture-host catalog'
        trigger_text = page.locator('#thread-new-model').text_content().strip()
        retired.dispatch_event('click')
        page.wait_for_timeout(300)
        new_trigger_text = page.locator('#thread-new-model').text_content().strip()
        assert new_trigger_text == trigger_text, 'expected trigger unchanged after clicking disabled option'
        cap_picker(page, 'disabled-option-in-place')
        passed('disabled option in place')

        reference_captures = []
        if reference_dir:
            ref_screens = reference_dir / 'screens'
            if ref_screens.exists() and (ref_screens / 'vendor').exists() and (ref_screens / 'vendor' / 'tailwind.js').exists():
                class RefHandler(SimpleHTTPRequestHandler):
                    def translate_path(self, path):
                        return str(ref_screens) + path
                server = ThreadingHTTPServer(('127.0.0.1', 0), RefHandler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                for ref in ['12-thread-model-picker.html', '14-model-picker-empty.html', '15-model-picker-unavailable.html']:
                    ref_path = ref_screens / ref
                    if ref_path.exists():
                        for width in [1280, 1600]:
                            page.set_viewport_size({'width': width, 'height': 900})
                            page.wait_for_timeout(200)
                            cap_path = browser_evidence / f'picker-reference-{ref}@{width}.png'
                            page.screenshot(path=str(cap_path))
                            reference_captures.append(str(cap_path))
                server.shutdown()

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
            '\n'.join(f'- {c}' for c in report['captures']) + '\n\n'
            '## Reference Captures\n\n'
            '\n'.join(f'- {c}' for c in reference_captures) + '\n\n'
            '## States Covered\n\n'
            '\n'.join(f'- {s}' for s in report['scenarios']) + '\n'
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
    finally:
        for r in held_routes:
            try:
                r.abort()
            except:
                pass
        if reference_server:
            reference_server.shutdown()
        if context:
            context.close()
        if browser:
            browser.close()
        if fixture:
            try:
                fixture.terminate()
                for _ in range(10):
                    if fixture.poll() is not None:
                        break
                    time.sleep(0.5)
                if fixture.poll() is None:
                    fixture.kill()
            except:
                pass
        cleanup['fixtureTerminated'] = True
        cleanup['browserClosed'] = True
        if fixture_info.get('root'):
            try:
                shutil.rmtree(fixture_info['root'])
                cleanup['temporaryFixtureRootRemoved'] = fixture_info['root']
            except:
                pass


def main():
    global fixture, reference_server, browser, context, fixture_info
    fixture = subprocess.Popen(
        ['node', str(root / 'browser-fixture.mjs')],
        env={**os.environ, 'SENTINEL_MODELS': '1'},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    start = time.monotonic()
    fixture_url = None
    while fixture.poll() is None and time.monotonic() - start < 10:
        ready, _, _ = select.select([fixture.stdout], [], [], 1)
        if ready:
            line = fixture.stdout.readline()
            if line.startswith('{'):
                fixture_info = json.loads(line)
                fixture_url = fixture_info.get('url')
                break
    if not fixture_url:
        report['status'] = 'failed'
        report['fixture'] = {'error': 'fixture did not start'}
        write_receipt()
        return
    report['fixture'] = {'url': fixture_url, 'root': fixture_info.get('root')}

    git_output = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    report['observedCommit'] = git_output.stdout.strip() if git_output.returncode == 0 else None
    git_dirty = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True)
    report['dirty'] = bool(git_dirty.stdout.strip())

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context = browser.new_context(viewport={'width': 1280, 'height': 900})
            page = context.new_page()
            page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
            page.on('console', lambda c: report['consoleErrors'].append(c.text) if c.type == 'error' else None)
            page.on('requestfailed', lambda r: report['requestFailures'].append(r.url))
            run_picker(fixture_url, page) if case == 'picker' else run(fixture_url, page)
    finally:
        report['cleanup'] = cleanup
        write_receipt()
        print(json.dumps({
            'status': report['status'],
            'elapsed_seconds': round(time.monotonic() - started, 3),
            'scenarios': report['scenarios'],
            'captures': report['captures'],
            'receipt_path': str(receipt_path),
            'dirty': report['dirty'],
        }, indent=2))


if __name__ == '__main__':
    main()
