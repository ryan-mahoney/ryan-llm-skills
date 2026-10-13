# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Regression: saved briefs must visibly guide the operator through preview and launch,
and the hidden launch flow must save a brief without starting work.

Run: uv run --script scripts/spec-observe/frontend/browser-handoff-check.py [--section handoff|brief]
Uses isolated fixture storage and fake workers; never launches a real assignment.
The default handoff journey and the brief section share fixture/browser startup.
"""
import json, os, re, select, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent
args = sys.argv[1:]
section = args[args.index('--section') + 1] if '--section' in args else 'handoff'
evidence_dir = Path(os.environ['SENTINEL_EVIDENCE_DIR']) if os.environ.get('SENTINEL_EVIDENCE_DIR') else None
shots_dir = (evidence_dir / 'browser') if evidence_dir else Path('/tmp')
if evidence_dir: shots_dir.mkdir(parents=True, exist_ok=True)
receipt = (evidence_dir or Path('/tmp')) / ('ev-9-brief.json' if section == 'brief' else 'ev-4-handoff.json')
summary = {'status':'failed','section':section,'cases':[],'page_errors':[],'captures':[],'boundary':'1440x1100 desktop' if section == 'handoff' else '1280x1100 and 1600x1100 desktop'}
def passed(name): summary['cases'].append(name)
def shot(locator, name):
    path = shots_dir / name
    locator.screenshot(path=str(path))
    summary['captures'].append(str(path))
def full_shot(name):
    path = shots_dir / name
    page.screenshot(path=str(path))
    summary['captures'].append(str(path))
def write_receipt():
    temporary = receipt.with_name(receipt.name + '.tmp')
    temporary.write_text(json.dumps(summary, indent=2) + '\n')
    os.replace(temporary, receipt)

def run_brief(browser, url):
    for width in (1280, 1600):
        context = browser.new_context(viewport={'width': width, 'height': 1100}, device_scale_factor=1)
        try:
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            def control(action='', value=''):
                response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
                assert response.ok
                return response.json()
            def posts(name):
                return [x for x in control()['posts'] if x['name'] == name]
            def capture(name):
                path = shots_dir / name
                page.screenshot(path=str(path), full_page=True)
                summary['captures'].append(str(path))

            # A portfolio launch opens the picker; choosing a workspace mounts the brief with Agents current.
            page.goto(url + '/#/launch', wait_until='domcontentloaded')
            expect(page.locator('.workspace-picker')).to_be_visible()
            page.locator('.workspace-picker button[data-workspace="fixture"]').click()
            expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=brief'))
            expect(page.locator('#launch-brief-title')).to_be_visible()
            expect(page.locator('.nav-item[data-area="agents"]')).to_have_class(re.compile(r'\bcurrent\b'))
            passed(f'picker mounts brief under Agents ({width})')

            baseline_saves = len(posts('dispatchSaveBrief'))
            title = page.locator('#launch-brief-title')
            content = page.locator('#launch-brief-content')
            save = page.locator('#launch-save')

            # Empty title validates inline, focuses the field, and submits nothing.
            save.click()
            expect(title).to_be_focused()
            expect(title).to_have_attribute('aria-invalid', 'true')
            expect(page.locator('#launch-title-validation')).to_have_text('Enter a brief title.')
            assert len(posts('dispatchSaveBrief')) == baseline_saves
            passed(f'empty title inline validation ({width})')

            title.fill('Keep selected files in view')
            content.fill('Outcome\nOpen selected files beside the listing, with the source and filename visible.')
            expect(save).to_be_enabled()
            assert page.locator('.ds-btn--primary').count() == 1
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            capture(f'launch-brief-{width}.png')
            passed(f'brief capture {width}')

            # Saving locks the known fields; leaving mid-flight keeps one request and typed content.
            control('delay-dispatch-brief', 'true')
            save.click()
            expect(save).to_contain_text('Saving brief…')
            expect(title).to_be_disabled()
            expect(page.locator('#launch-target')).to_be_disabled()
            capture(f'launch-saving-{width}.png')
            page.locator('.head-actions .ds-btn').click()
            expect(page).to_have_url(re.compile(r'#/agents'))
            control('delay-dispatch-brief', 'false')
            page.wait_for_timeout(900)
            assert len(posts('dispatchSaveBrief')) == baseline_saves + 1
            page.go_back()
            expect(page.locator('#launch-brief-title')).to_have_value('Keep selected files in view')
            expect(page.locator('#launch-brief-content')).to_have_value('Outcome\nOpen selected files beside the listing, with the source and filename visible.')
            expect(page.locator('#launch-saved')).to_be_visible()
            passed(f'delayed save keeps one request and content ({width})')

            # Failure keeps the typed content and retries the same request identity.
            control('fail-dispatch-brief', 'true')
            title.fill('Keep selected files in view v2')
            save.click()
            expect(page.locator('#launch-error')).to_be_visible()
            expect(page.locator('#launch-error')).to_contain_text('Brief could not be saved')
            expect(title).to_have_value('Keep selected files in view v2')
            capture(f'launch-error-{width}.png')
            refused = posts('dispatchSaveBrief')[-1]['input']
            control('fail-dispatch-brief', 'false')
            save.click()
            expect(page.locator('#launch-error')).to_have_count(0)
            retried = posts('dispatchSaveBrief')[-1]['input']
            assert retried['request_id'] == refused['request_id']
            passed(f'failure keeps content and retries same identity ({width})')

            # Enter saves only: no suggestion request, preview or launch ever follows it.
            before = len(posts('dispatchSaveBrief'))
            content.press('Enter')
            page.wait_for_timeout(150)
            assert len(posts('dispatchSaveBrief')) == before
            assert not posts('dispatchPreview')
            assert not posts('dispatchLaunch')
            passed(f'Enter saves only ({width})')

            assert not errors, errors
            summary['page_errors'].extend(errors)
        finally:
            context.close()

started = time.monotonic()
fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture startup timed out')
    url = json.loads(fixture.stdout.readline())['url']
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        if section == 'brief':
            try:
                run_brief(browser, url)
                assert not summary['page_errors'], summary['page_errors']
                summary['status']='passed'
                print(json.dumps({'status': 'passed', 'elapsed_seconds': round(time.monotonic() - started, 2), 'cases': summary['cases'], 'captures': summary['captures'], 'boundary': summary['boundary'], 'receipt': str(receipt)}))
            except BaseException as exc:
                summary['error']=repr(exc)
                raise
        else:
            context = browser.new_context(viewport={'width': 1440, 'height': 1100}, device_scale_factor=1)
            try:
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                def control(action='', value=''):
                    response = context.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
                    assert response.ok
                    return response.json()
                def posts(name):
                    return [x for x in control()['posts'] if x['name'] == name]
                page.goto(url+'/#/conversations?ws=fixture', wait_until='domcontentloaded')
                assert page.evaluate('location.hash')=='#/conversations?ws=fixture', page.evaluate('location.hash')
                expect(page.locator('#thread-draft')).to_be_visible()
                title, brief = page.locator('#thread-brief-title'), page.locator('#thread-brief-content')
                status = page.locator('#thread-handoff-status')
                title.fill('Preferred models settings')
                brief.fill('/spec-architect-initial add a settings area for preferred models')
                brief.press('Enter')
                expect(status).to_contain_text('Brief saved. Assignment has not started.')
                expect(page.locator('[data-thread-preview]')).to_be_focused()
                assert len(posts('saveBrief')) == 1
                assert not posts('launchAssignment')
                passed('save-only confirmation')
                # Repeated Enter on unchanged content must not create another handoff.
                brief.press('Enter')
                expect(page.locator('[data-thread-preview]')).to_be_focused()
                assert len(posts('saveBrief')) == 1
                passed('unchanged Enter preserves handoff')
                page.locator('[data-thread-preview]').click()
                expect(page.locator('[data-thread-launch]')).to_be_focused()
                expect(status).to_contain_text('Review the details below')
                brief.press('Enter')
                expect(page.locator('[data-thread-launch]')).to_be_focused()
                assert len(posts('saveBrief')) == 1
                assert len(posts('previewAssignment')) == 1
                passed('preview then explicit launch')
                page.locator('[data-thread-launch]').click()
                expect(page.locator('[data-thread-launch]')).to_be_disabled()
                expect(status).to_contain_text('Preview again')
                control('stale-launch', 'false')
                page.locator('[data-thread-preview]').click()
                expect(page.locator('.thread-handoff [role="alert"]')).to_have_count(0)
                passed('stale preview recovery')
                brief.fill('Changed request')
                expect(status).to_contain_text('unsaved changes')
                expect(page.locator('[data-thread-launch]')).to_be_disabled()
                expect(page.locator('[data-thread-preview]')).to_be_disabled()
                # An edit made during saving must survive and still require another save.
                control('delay-brief', 'true')
                brief.press('Enter')
                expect(status).to_contain_text('Saving brief')
                brief.fill('Final request edited while saving')
                expect(status).to_contain_text('unsaved changes')
                expect(brief).to_have_value('Final request edited while saving')
                expect(brief).to_be_focused()
                control('delay-brief', 'false')
                brief.press('Enter')
                expect(status).to_contain_text('Brief saved. Assignment has not started.')
                passed('dirty and in-flight edits')
                shot(page.locator('.thread-handoff'), 'ev-4-handoff-saved.png')
                page.locator('#thread-handoff-status').scroll_into_view_if_needed()
                full_shot('ev-4-handoff-desktop.png')
                passed('desktop boundary capture')
                page.locator('[data-thread-preview]').click()
                page.locator('[data-thread-launch]').click()
                expect(status).to_contain_text('Assignment started.')
                expect(page.locator('#thread-result')).to_be_focused()
                assert len(posts('launchAssignment')) == 2  # one stale refusal, one launch
                assert len(posts('saveBrief')) == 3
                passed('launch confirmation')
                assert not errors, errors
                summary['status']='passed'; summary['page_errors']=errors
                print(json.dumps({'status': 'passed', 'elapsed_seconds': round(time.monotonic() - started, 2), 'cases': summary['cases'], 'captures': summary['captures'], 'boundary': summary['boundary'], 'receipt': str(receipt)}))
            except BaseException as exc:
                summary['error']=repr(exc)
                try: summary['page_errors']=errors
                except Exception: summary['page_errors']=[]
                raise
            finally:
                context.close()
finally:
    try:
        write_receipt()
    finally:
        fixture.terminate()
        try:
            fixture.wait(timeout=10)
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
