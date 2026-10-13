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

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

root = Path(__file__).resolve().parent
args = sys.argv[1:]
section = args[args.index('--section') + 1] if '--section' in args else 'handoff'
evidence_dir = Path(os.environ['SENTINEL_EVIDENCE_DIR']) if os.environ.get('SENTINEL_EVIDENCE_DIR') else None
shots_dir = (evidence_dir / 'browser') if evidence_dir else Path('/tmp')
if evidence_dir: shots_dir.mkdir(parents=True, exist_ok=True)
receipt = (evidence_dir or Path('/tmp')) / ('ev-10-review.json' if section == 'review' else 'ev-9-brief.json' if section == 'brief' else 'ev-4-handoff.json')
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

            # The ordinary entry is Agents → Launch agent: portfolio scope opens
            # the picker, and choosing a workspace mounts the brief with Agents
            # current in the rail.
            page.goto(url + '/#/agents', wait_until='domcontentloaded')
            expect(page.locator('#launch-agent-action')).to_be_visible()
            page.locator('#launch-agent-action').click()
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

            # A Runs in change retargets file suggestions with the retained
            # draft target: the whole-workspace request finds the
            # second-repository file, and the delayed old-target match is
            # dropped once the bound request resolves without it.
            target_select = page.locator('#launch-target')
            content.press('End')
            content.type(' @fixture-docs-guide')
            expect(page.locator('.brief-suggestions')).to_contain_text('fixture-docs-guide')
            expect(page.locator('.brief-suggestion')).to_contain_text('fixture-docs')
            whole = [x for x in control()['posts'] if x['name'] == 'dispatchSuggestions']
            assert whole and not whole[-1]['input'].get('repository_id'), whole[-1] if whole else None
            passed(f'whole-workspace suggestions span repositories ({width})')
            control('delay-dispatch-suggestions', 'true')
            content.press('End')
            content.press('Backspace')
            page.wait_for_timeout(250)
            target_select.select_option('fixture-repo')
            content.press('End')
            content.type('e')
            expect(page.locator('.brief-suggestions')).to_contain_text('No matching text files in this target.')
            bound = [x for x in control()['posts'] if x['name'] == 'dispatchSuggestions']
            assert bound[-1]['input'].get('repository_id') == 'fixture-repo', bound[-1]
            assert any(not x['input'].get('repository_id') for x in bound)
            control('delay-dispatch-suggestions', 'false')
            passed(f'target change retargets suggestions and drops the stale match ({width})')

            assert not errors, errors
            summary['page_errors'].extend(errors)
        finally:
            context.close()

def run_review(browser, url):
    widths = (1280, 1600)
    sessions = {}
    api = browser.new_context()
    def control(action='', value=''):
        response = api.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()
    def posts(name):
        return [x for x in control()['posts'] if x['name'] == name]
    def capture(page, name):
        page.locator('#launch-review').scroll_into_view_if_needed()
        page.locator('#launch-review').screenshot(path=str(shots_dir / name))
        summary['captures'].append(str(shots_dir / name))
    def open_page(width):
        context = browser.new_context(viewport={'width': width, 'height': 1100}, device_scale_factor=1)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        # Ordinary entry, shared with the brief section: Agents → Launch
        # agent, then the picker mounts the brief in the chosen workspace.
        page.goto(url + '/#/agents', wait_until='domcontentloaded')
        page.locator('#launch-agent-action').click()
        expect(page.locator('.workspace-picker')).to_be_visible()
        page.locator('.workspace-picker button[data-workspace="fixture"]').click()
        expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=brief'))
        page.evaluate("location.hash = '#/launch?ws=fixture&tab=review'")
        expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=review'))
        expect(page.locator('#launch-brief-title')).to_be_visible()
        page.locator('#launch-brief-title').fill('Keep selected files in view')
        page.locator('#launch-brief-content').fill('Outcome\nOpen selected files beside the listing, with the source and filename visible.')
        return context, page, errors
    try:
        control('dispatch-preview-refusal', 'none')
        control('dispatch-launch-refusal', 'none')
        # Hold the first resolution until both widths captured the resolving state.
        control('hold-dispatch-preview', 'true')
        for width in widths:
            context, page, errors = open_page(width)
            page.locator('#launch-brief-title').press('Enter')
            expect(page.locator('#launch-review-status')).to_contain_text('Resolving execution contract')
            expect(page.locator('#launch-review .skeletons')).to_be_visible()
            expect(page.locator('#launch-review-requested')).to_contain_text('Whole workspace')
            expect(page.locator('#launch-assignment-launch')).to_be_disabled()
            assert not posts('dispatchLaunch')
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            capture(page, f'launch-resolving-{width}.png')
            sessions[width] = {'context': context, 'page': page, 'errors': errors}
            passed(f'resolving keeps requested facts ({width})')
        control('release-dispatch-preview', 'true')
        for width in widths:
            page = sessions[width]['page']
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            page.evaluate("[...document.querySelectorAll('#launch-what-pi details')].forEach(d=>d.open=true)")
            review = page.locator('#launch-review')
            expect(review).to_contain_text('Whole workspace')
            expect(review).to_contain_text('Pi default')
            expect(review).to_contain_text('None')
            digest = page.locator('#launch-review [data-fact="digest"] dd').inner_text()
            assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
            assert re.fullmatch(r'[0-9a-f]{64}', digest), digest
            assert UUID_RE.fullmatch(assignment), assignment
            expect(page.locator('#launch-what-pi')).to_contain_text('Perform the attached assignment brief.')
            expect(page.locator('#launch-what-pi')).to_contain_text('Open selected files beside the listing')
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            capture(page, f'launch-review-{width}.png')
            passed(f'fresh review shows resolved facts ({width})')
        for width in widths:
            page = sessions[width]['page']
            # Review cannot approve unsaved edits; Enter only ever saves.
            page.locator('#launch-assignment-edit').click()
            expect(page.locator('#launch-brief-title')).to_be_focused()
            page.locator('#launch-brief-title').fill('Keep selected files in view v2')
            expect(page.locator('#launch-review-unsaved')).to_contain_text('Unsaved changes are not reviewed')
            assert page.locator('#launch-assignment-launch').count() == 0
            page.locator('#launch-assignment-save').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            passed(f'unsaved edits cannot dispatch ({width})')
            # A stale launch refusal withholds dispatch until a fresh review succeeds.
            launches_before = len(posts('dispatchLaunch'))
            control('dispatch-launch-refusal', 'stale')
            page.locator('#launch-assignment-launch').click()
            expect(page.locator('#launch-review-error')).to_contain_text('The reviewed contract changed')
            expect(page.locator('#launch-review-error')).to_be_focused()
            previous = page.locator('#launch-review [data-fact="previous-digest"] dd').inner_text()
            assert re.fullmatch(r'[0-9a-f]{64}', previous), previous
            assert page.locator('#launch-assignment-launch').count() == 0
            assert len(posts('dispatchLaunch')) == launches_before + 1
            capture(page, f'launch-stale-{width}.png')
            control('dispatch-launch-refusal', 'none')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            passed(f'stale launch withholds dispatch ({width})')
            # Busy denial names and links the conflicting assignment UUID.
            control('dispatch-preview-refusal', 'busy')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-review-error')).to_contain_text('This directory already has a writer')
            expect(page.locator('#launch-review-busy')).to_contain_text('b42f1903-9508-46c1-a4aa-a0842dbce617')
            expect(page.locator('#launch-review-busy')).to_have_attribute('href', re.compile(r'b42f1903-9508-46c1-a4aa-a0842dbce617'))
            assert page.locator('#launch-assignment-launch').count() == 0
            capture(page, f'launch-denied-{width}.png')
            passed(f'busy denial names its assignment ({width})')
            control('dispatch-preview-refusal', 'none')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            # Run-active and a missing service stay distinct from busy.
            control('dispatch-preview-refusal', 'run-active')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-review-error')).to_contain_text('active run')
            expect(page.locator('#launch-review-error')).not_to_contain_text('already has a writer')
            passed(f'run-active denial is distinct ({width})')
            control('dispatch-preview-refusal', 'none')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            control('dispatch-preview-refusal', 'service')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-review-error')).to_contain_text('Dispatch service unavailable')
            passed(f'missing service is denied ({width})')
            control('dispatch-preview-refusal', 'none')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            # An ordinary preview failure is retryable and claims no reservation.
            control('dispatch-preview-refusal', 'error')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-review-error')).to_contain_text('Contract could not be resolved')
            expect(page.locator('#launch-review [data-fact="assignment"] dd')).to_have_text('Not reserved')
            assert page.locator('#launch-assignment-launch').count() == 0
            capture(page, f'launch-error-{width}.png')
            passed(f'ordinary failure is retryable ({width})')
            control('dispatch-preview-refusal', 'none')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
        # Hold dispatch until both widths captured the dispatching state.
        control('hold-dispatch-launch', 'true')
        for width in widths:
            page = sessions[width]['page']
            before = len(posts('dispatchLaunch'))
            digest = page.locator('#launch-review [data-fact="digest"] dd').inner_text()
            assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
            page.evaluate("() => { const b = document.getElementById('launch-assignment-launch'); b.click(); b.click(); }")
            expect(page.locator('#launch-assignment-launch')).to_be_disabled()
            expect(page.locator('#launch-assignment-launch')).to_contain_text('Starting agent')
            expect(page.locator('#launch-review')).to_contain_text(assignment[:8])
            expect(page.locator('#launch-review [data-fact="digest"] dd')).to_have_text(digest)
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            capture(page, f'launch-dispatching-{width}.png')
            assert len(posts('dispatchLaunch')) == before + 1
            submitted = posts('dispatchLaunch')[-1]['input']
            assert submitted['assignment_id'] == assignment
            assert submitted['expectedDigest'] == digest
            # Pending navigation keeps one submission and the reviewed facts.
            page.locator('.head-actions .ds-btn').click()
            expect(page).to_have_url(re.compile(r'#/agents'))
            page.evaluate("location.hash = '#/launch?ws=fixture&tab=review'")
            expect(page.locator('#launch-assignment-launch')).to_contain_text('Starting agent')
            assert len(posts('dispatchLaunch')) == before + 1
            passed(f'dispatching retains facts and one submission ({width})')
        control('release-dispatch-launch', 'true')
        for width in widths:
            page = sessions[width]['page']
            expect(page.locator('#launch-review')).to_contain_text('Assignment started')
            assert not sessions[width]['errors'], sessions[width]['errors']
            summary['page_errors'].extend(sessions[width]['errors'])
            passed(f'dispatch confirms without a second submission ({width})')
    finally:
        for session in sessions.values():
            try: session['context'].close()
            except Exception: pass
        try: api.close()
        except Exception: pass

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
        elif section == 'review':
            try:
                run_review(browser, url)
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
