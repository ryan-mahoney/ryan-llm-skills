# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Regression: saved briefs must visibly guide the operator through preview and launch,
and the hidden launch flow must save a brief without starting work.

Run: uv run --script scripts/spec-observe/frontend/browser-handoff-check.py [--section handoff|brief|review|result|thread|final-review]
Uses isolated fixture storage and fake workers; never launches a real assignment.
The default handoff journey and the brief section share fixture/browser startup.
"""
import json, os, re, select, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

root = Path(__file__).resolve().parent
args = sys.argv[1:]
section = args[args.index('--section') + 1] if '--section' in args else 'handoff'
evidence_dir = Path(os.environ['SENTINEL_EVIDENCE_DIR']) if os.environ.get('SENTINEL_EVIDENCE_DIR') else None
shots_dir = (evidence_dir / 'browser') if evidence_dir else Path('/tmp')
if evidence_dir: shots_dir.mkdir(parents=True, exist_ok=True)
receipt = (evidence_dir or Path('/tmp')) / ('final-review-browser.json' if section == 'final-review' else 'ev-12-thread.json' if section == 'thread' else 'ev-10-review.json' if section == 'review' else 'ev-11-result.json' if section == 'result' else 'ev-9-brief.json' if section == 'brief' else 'ev-4-handoff.json')
summary = {'status':'failed','section':section,'cases':[],'page_errors':[],'captures':[],'boundary':'1440x1100 desktop' if section == 'handoff' else '1280x1100 and 1600x1100 desktop'}
# Shared receipt metadata: actual revision/dirty plus the owned-resource
# cleanup record. Only the thread section launches and closes its own
# Playwright Chromium; every other section keeps the CDP browser contract.
browser = None
fixture_info = {}
checkout = root.parents[2]
cleanup = {'fixtureTerminated': False, 'browserClosed': False, 'temporaryFixtureRootRemoved': None, 'errors': []}
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
            # A successful brief-entry save transitions to review through the
            # route owner; return to brief for the save-only Enter assertion.
            expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=review'))
            page.evaluate("location.hash = '#/launch?ws=fixture&tab=brief'")
            expect(page.locator('#launch-brief-content')).to_be_visible()

            # Enter saves only: no new save, suggestion request, preview or
            # launch follows it (the save->review transition may already have
            # resolved once; Enter itself must add nothing).
            before = len(posts('dispatchSaveBrief'))
            previews_before = len(posts('dispatchPreview'))
            launches_before_enter = len(posts('dispatchLaunch'))
            content.press('Enter')
            page.wait_for_timeout(150)
            assert len(posts('dispatchSaveBrief')) == before
            assert len(posts('dispatchPreview')) == previews_before
            assert len(posts('dispatchLaunch')) == launches_before_enter
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
            # Ordinary brief-entry path: explicit Save transitions through the
            # route owner to review, then the saved handoff auto-resolves.
            page.locator('#launch-save').click()
            expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=review'))
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
            # Refusals retain known contract facts as explicit previous facts;
            # the current requested target/brief stay separate and dispatch is withheld.
            expect(page.locator('#launch-review-previous')).to_contain_text('not approved for launch')
            expect(page.locator('#launch-review [data-fact="previous-execution"] dd')).not_to_be_empty()
            expect(page.locator('#launch-review [data-fact="previous-assignment"] dd')).to_contain_text(re.compile(r'[0-9a-f-]{36}'))
            expect(page.locator('#launch-review [data-fact="previous-skill"] dd')).to_contain_text('general')
            expect(page.locator('#launch-review [data-fact="previous-authority"] dd')).to_contain_text('None')
            assert page.locator('#launch-assignment-launch').count() == 0
            assert len(posts('dispatchLaunch')) == launches_before + 1
            capture(page, f'launch-stale-{width}.png')
            control('dispatch-launch-refusal', 'none')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            passed(f'stale launch withholds dispatch ({width})')
            # Busy denial names and links the conflicting assignment UUID.
            # The conflicting writer is absent from the fixture snapshot while
            # the unrelated run-1 row exists first, so the link must use the
            # workspace-scoped q route and never select the unrelated agent.
            control('dispatch-preview-refusal', 'busy')
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-review-error')).to_contain_text('This directory already has a writer')
            expect(page.locator('#launch-review-busy')).to_contain_text('b42f1903-9508-46c1-a4aa-a0842dbce617')
            busy_href = page.locator('#launch-review-busy').get_attribute('href')
            assert busy_href is not None and 'q=b42f1903-9508-46c1-a4aa-a0842dbce617' in busy_href, busy_href
            assert '&id=' not in busy_href, busy_href
            expect(page.locator('#launch-review-previous')).to_contain_text('not approved for launch')
            expect(page.locator('#launch-review [data-fact="previous-execution"] dd')).not_to_be_empty()
            expect(page.locator('#launch-review [data-fact="previous-assignment"] dd')).to_contain_text(re.compile(r'[0-9a-f-]{36}'))
            assert page.locator('#launch-assignment-launch').count() == 0
            capture(page, f'launch-denied-{width}.png')
            page.locator('#launch-review-busy').click()
            expect(page).to_have_url(re.compile(r'#/agents\?ws=fixture&q=b42f1903-9508-46c1-a4aa-a0842dbce617'))
            expect(page.locator('.observation-rows')).to_contain_text('No matching agents')
            busy_shot = shots_dir / f'launch-busy-link-{width}.png'
            page.screenshot(path=str(busy_shot))
            summary['captures'].append(str(busy_shot))
            page.evaluate("location.hash = '#/launch?ws=fixture&tab=review'")
            expect(page.locator('#launch-review-error')).to_contain_text('This directory already has a writer')
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

def run_result(browser, url, thread1):
    widths = (1280, 1600)
    api = browser.new_context()
    contexts = []

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
        page_name = name[:-4] + '-page.png' if name.endswith('.png') else name + '-page.png'
        page.screenshot(path=str(shots_dir / page_name), full_page=True)
        summary['captures'].append(str(shots_dir / page_name))

    def reset():
        control('stale-launch', 'false')
        control('hold-dispatch-preview', 'false')
        control('hold-dispatch-launch', 'false')
        control('dispatch-preview-refusal', 'none')
        control('dispatch-launch-refusal', 'none')
        control('dispatch-launch-outcome', 'live')
        control('clear-launch-publications')

    def open_brief(width, thread=''):
        context = browser.new_context(viewport={'width': width, 'height': 1100}, device_scale_factor=1)
        contexts.append(context)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(url + '/#/agents', wait_until='domcontentloaded')
        page.locator('#launch-agent-action').click()
        expect(page.locator('.workspace-picker')).to_be_visible()
        page.locator('.workspace-picker button[data-workspace="fixture"]').click()
        expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=brief'))
        if thread:
            page.evaluate("location.hash = '#/launch?ws=fixture&thread=" + thread + "&tab=brief'")
        expect(page.locator('#launch-brief-title')).to_be_visible()
        page.locator('#launch-brief-title').fill('Keep selected files in view')
        page.locator('#launch-brief-content').fill('Outcome\nOpen selected files beside the listing, with the source and filename visible.')
        page.locator('#launch-save').click()
        expect(page.locator('#launch-assignment-launch')).to_be_enabled()
        return context, page, errors

    def last_resolver(snapshot, name, assignment):
        entries = (snapshot.get('diagnostics') or {}).get('resolvers') or []
        return next((x for x in reversed(entries) if x['name'] == name and x.get('record') and (x.get('input') or {}).get('assignment_id') == assignment), None)

    def resolver_names(page):
        on_thread = 'thread=' in page.url
        return ('previewAssignment', 'launchAssignment') if on_thread else ('dispatchPreview', 'dispatchLaunch')

    def digest_evidence(pre_click, post_click, preview_name, launch_name, assignment, displayed_digest):
        preview_entry = last_resolver(pre_click, preview_name, assignment)
        launch_entry = last_resolver(post_click, launch_name, assignment)
        preview_digest = (preview_entry or {}).get('contract_digest') or ((preview_entry or {}).get('record') or {}).get('contract_digest')
        expected_digest = ((launch_entry or {}).get('input') or {}).get('expected_digest')
        fresh_digest = (launch_entry or {}).get('fresh_digest') or ((launch_entry or {}).get('record') or {}).get('contract_digest')
        evidence = {
            'assignment': assignment,
            'displayed_digest': displayed_digest,
            'preview_digest': preview_digest,
            'expected_digest': expected_digest,
            'fresh_digest': fresh_digest,
        }
        return evidence, preview_entry, launch_entry

    def launch(page, outcome):
        control('dispatch-launch-outcome', outcome)
        assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
        preview_name, launch_name = resolver_names(page)
        # Diagnostics only: retain the digest currently displayed on the review
        # and the fixture's resolver evidence from before the click. Neither
        # value replaces the submitted identity or relaxes any assertion below.
        digest_fact = page.locator('#launch-review [data-fact="digest"] dd')
        displayed_digest = digest_fact.inner_text() if digest_fact.count() else None
        pre_click = control()
        try:
            page.locator('#launch-assignment-launch').click()
            expect(page.locator('#launch-result-facts')).to_be_visible()
            expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&id=' + re.escape(assignment) + '&tab=result'))
        except BaseException:
            # A failed result assertion keeps both fixture snapshots so
            # ev-11-result.json identifies the first preview/launch mismatch.
            post_click = control()
            evidence, preview_entry, launch_entry = digest_evidence(pre_click, post_click, preview_name, launch_name, assignment, displayed_digest)
            preview_record = (preview_entry or {}).get('record') or {}
            launch_record = (launch_entry or {}).get('record') or {}
            mismatch_key = next((key for key in sorted(set(preview_record) | set(launch_record)) if preview_record.get(key) != launch_record.get(key)), None)
            summary['launch_diagnostics'] = {
                'outcome': outcome,
                'submitted_assignment': assignment,
                'resolvers': {'preview': preview_name, 'launch': launch_name},
                'displayed_digest': displayed_digest,
                'launch_expected_digest': evidence['expected_digest'],
                'launch_fresh_digest': evidence['fresh_digest'],
                'launch_matched': (launch_entry or {}).get('matched'),
                'first_record_mismatch': {'field': mismatch_key, 'preview': preview_record.get(mismatch_key), 'launch': launch_record.get(mismatch_key)} if mismatch_key else None,
                'preview_record': preview_record,
                'launch_record': launch_record,
                'pre_click_resolvers': (pre_click.get('diagnostics') or {}).get('resolvers', [])[-4:],
                'post_click_resolvers': (post_click.get('diagnostics') or {}).get('resolvers', [])[-4:],
            }
            raise
        # Proved boundary: displayed, reviewed, submitted and freshly
        # recomputed digests agree for the submitted assignment identity.
        post_click = control()
        evidence, _, _ = digest_evidence(pre_click, post_click, preview_name, launch_name, assignment, displayed_digest)
        summary.setdefault('result_digests', []).append(evidence)
        assert displayed_digest == evidence['preview_digest'], evidence
        assert evidence['expected_digest'] == evidence['preview_digest'], evidence
        assert evidence['fresh_digest'] == evidence['expected_digest'], evidence
        return assignment

    def finish(errors, name):
        assert not errors, errors
        summary['page_errors'].extend(errors)
        passed(name)

    try:
        # Live: started work with the submitted identity, never a completion claim.
        for width in widths:
            reset()
            _, page, errors = open_brief(width)
            assignment = launch(page, 'live')
            old_request = page.locator('#launch-result-facts [data-fact="request"] dd').inner_text()
            expect(page.locator('#launch-heading')).to_have_text('Agent is live')
            expect(page.locator('#launch-heading')).to_be_focused()
            expect(page.locator('#launch-review .section-heading')).to_contain_text('Live')
            callout = page.locator('#launch-review .ds-callout')
            expect(callout).to_contain_text('Assignment started')
            expect(callout).to_contain_text('Work completion has not been established')
            assert UUID_RE.fullmatch(page.locator('#launch-result-facts [data-fact="request"] dd').inner_text())
            expect(page.locator('#launch-result-facts [data-fact="assignment"] dd')).to_have_text(assignment)
            expect(page.locator('#launch-result-facts [data-fact="execution"] dd')).not_to_be_empty()
            expect(page.locator('#launch-result-facts [data-fact="brief"] dd')).to_contain_text('Keep selected files in view')
            expect(page.locator('#launch-result-discuss')).to_have_count(0)
            href = page.locator('#launch-result-open-agent').get_attribute('href')
            assert href and ('q=' + assignment) in href and '&id=' not in href, href
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            capture(page, f'launch-result-live-{width}.png')
            # Publication exposes the exact observer key for this assignment.
            control('publish-assignment', assignment)
            expect(page.locator('#launch-result-open-agent')).to_have_attribute('href', re.compile(r'id='), timeout=12000)
            href = page.locator('#launch-result-open-agent').get_attribute('href')
            assert href and 'q=' not in href, href
            page.locator('#launch-result-open-agent').click()
            expect(page).to_have_url(re.compile(r'#/agents\?ws=fixture&id='))
            expect(page.locator('.run-row', has_text=assignment)).to_have_attribute('aria-pressed', 'true')
            # History restores the acknowledged result; only the explicit
            # Agents entry starts independent work in the retained direct slot.
            page.go_back()
            expect(page.locator('#launch-result-facts [data-fact="assignment"] dd')).to_have_text(assignment)
            page.go_forward()
            expect(page.locator('#launch-agent-action')).to_be_visible()
            saves_before = len(posts('dispatchSaveBrief'))
            launches_before = len(posts('dispatchLaunch'))
            page.locator('#launch-agent-action').click()
            expect(page.locator('#launch-brief-title')).to_have_value('')
            expect(page.locator('#launch-brief-content')).to_have_value('')
            expect(page.locator('#launch-result-facts')).to_have_count(0)
            page.locator('#launch-brief-title').fill('Prepare independent follow-up')
            page.locator('#launch-brief-content').fill('Different work: document the navigation contract.')
            page.locator('#launch-save').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            assert len(posts('dispatchSaveBrief')) == saves_before + 1
            fresh_request = posts('dispatchSaveBrief')[-1]['input']['request_id']
            fresh_assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
            assert UUID_RE.fullmatch(fresh_request) and fresh_request != old_request
            assert UUID_RE.fullmatch(fresh_assignment) and fresh_assignment != assignment
            assert posts('dispatchSaveBrief')[-1]['input']['title'] == 'Prepare independent follow-up'
            expect(page.locator('#launch-review')).to_contain_text('Different work: document the navigation contract.')
            assert len(posts('dispatchLaunch')) == launches_before
            passed(f'explicit repeat entry saves and reviews different work with fresh identities ({width})')
            finish(errors, f'live result keeps started identity and open agent reaches the exact assignment ({width})')
        # Unconfirmed: locate only, no retry/reset, delayed observation.
        for width in widths:
            reset()
            _, page, errors = open_brief(width)
            assignment = launch(page, 'unknown')
            expect(page.locator('#launch-heading')).to_have_text('Launch is unconfirmed')
            expect(page.locator('#launch-review .section-heading')).to_contain_text('Unconfirmed')
            callout = page.locator('#launch-review .ds-callout')
            expect(callout).to_contain_text('The launch acknowledgement was lost')
            expect(callout).not_to_contain_text('is reserved')
            expect(callout).not_to_contain_text('reservation retained')
            expect(page.locator('#launch-result-facts [data-fact="observation"] dd')).to_contain_text('Unknown identity')
            expect(page.locator('#launch-assignment-launch')).to_have_count(0)
            expect(page.locator('#launch-assignment-review')).to_have_count(0)
            expect(page.locator('#launch-result-correct')).to_have_count(0)
            capture(page, f'launch-result-unconfirmed-{width}.png')
            # Before publication the UUID filter lists nothing, never an unrelated row.
            page.locator('#launch-result-open-agent').click()
            expect(page).to_have_url(re.compile(r'#/agents\?ws=fixture&q=' + re.escape(assignment)))
            expect(page.locator('.observation-rows')).to_contain_text('No matching agents')
            empty_shot = shots_dir / f'launch-result-open-agent-empty-{width}.png'
            page.screenshot(path=str(empty_shot))
            summary['captures'].append(str(empty_shot))
            # Publication then selects the matching observed row.
            control('publish-assignment', assignment)
            page.wait_for_timeout(1200)
            page.locator('.head-actions .ds-btn', has_text='Refresh state').click()
            expect(page.locator('.run-row', has_text=assignment)).to_have_attribute('aria-pressed', 'true')
            page.locator('#launch-agent-action').click()
            expect(page.locator('#launch-result-facts [data-fact="assignment"] dd')).to_have_text(assignment)
            expect(page.locator('#launch-result-correct')).to_have_count(0)
            expect(page.locator('#launch-brief-title')).to_have_count(0)
            expect(page.locator('#launch-save')).to_have_count(0)
            page.go_back()
            page.go_back()
            expect(page.locator('#launch-heading')).to_have_text('Launch is unconfirmed')
            expect(page.locator('#launch-result-facts [data-fact="assignment"] dd')).to_have_text(assignment)
            finish(errors, f'unconfirmed locates without retry and observes after publication ({width})')
        # Confirmed failure: correction preserves the text and mints both identities.
        for width in widths:
            reset()
            _, page, errors = open_brief(width)
            assignment = launch(page, 'failed')
            old_request = page.locator('#launch-result-facts [data-fact="request"] dd').inner_text()
            assert UUID_RE.fullmatch(old_request), old_request
            expect(page.locator('#launch-heading')).to_have_text('Agent could not start')
            expect(page.locator('#launch-review .section-heading')).to_contain_text('Failed')
            expect(page.locator('#launch-review .ds-callout')).to_contain_text('Process startup failed')
            expect(page.locator('#launch-result-facts [data-fact="observation"] dd')).to_contain_text('process confirmed gone')
            capture(page, f'launch-result-failed-{width}.png')
            page.locator('#launch-result-open-agent').click()
            expect(page.locator('#launch-agent-action')).to_be_visible()
            page.locator('#launch-agent-action').click()
            expect(page.locator('#launch-result-facts [data-fact="assignment"] dd')).to_have_text(assignment)
            expect(page.locator('#launch-result-correct')).to_be_visible()
            expect(page.locator('#launch-brief-title')).to_have_count(0)
            page.go_back()
            page.go_back()
            expect(page.locator('#launch-heading')).to_have_text('Agent could not start')
            expect(page.locator('#launch-result-facts [data-fact="assignment"] dd')).to_have_text(assignment)
            saves_before = len(posts('dispatchSaveBrief'))
            page.locator('#launch-result-correct').click()
            expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=brief'))
            expect(page.locator('#launch-brief-title')).to_have_value('Keep selected files in view')
            expect(page.locator('#launch-brief-content')).to_have_value(re.compile(r'Open selected files beside the listing'))
            expect(page.locator('#launch-saved')).to_have_count(0)
            expect(page.locator('#launch-result-facts')).to_have_count(0)
            page.locator('#launch-save').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            assert len(posts('dispatchSaveBrief')) == saves_before + 1
            fresh_request = posts('dispatchSaveBrief')[-1]['input']['request_id']
            assert fresh_request != old_request
            fresh_assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
            assert fresh_assignment != assignment
            finish(errors, f'failed correction keeps text and changes both identities ({width})')
        # Bound result keeps the originating thread and seeds one unsent draft.
        reset()
        _, page, errors = open_brief(1280, thread1)
        launch(page, 'live')
        expect(page.locator('#launch-result-facts [data-fact="thread"] dd')).to_contain_text(thread1)
        expect(page.locator('#launch-result-discuss')).to_be_visible()
        capture(page, 'launch-result-thread-1280.png')
        sends_before = len(posts('send'))
        page.locator('#launch-result-discuss').click()
        expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
        expect(page.locator('#thread-draft')).to_be_visible()
        assert len(posts('send')) == sends_before
        finish(errors, 'bound result retains the originating thread and seeds without sending')
    finally:
        for context in contexts:
            try: context.close()
            except Exception: pass
        try: api.close()
        except Exception: pass

def run_thread(browser, url, thread1, thread2):
    widths = (1280, 1600)
    api = browser.new_context()
    contexts = []

    def control(action='', value=''):
        response = api.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def posts(name):
        return [x for x in control()['posts'] if x['name'] == name]

    def capture(page, name):
        path = shots_dir / name
        page.screenshot(path=str(path), full_page=True)
        summary['captures'].append(str(path))

    def reset():
        control('stale-launch', 'false')
        control('hold-dispatch-preview', 'false')
        control('hold-dispatch-launch', 'false')
        control('dispatch-preview-refusal', 'none')
        control('dispatch-launch-refusal', 'none')
        control('dispatch-launch-outcome', 'live')
        control('clear-launch-publications')

    def open(width):
        context = browser.new_context(viewport={'width': width, 'height': 1100}, device_scale_factor=1)
        contexts.append(context)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        return page, errors

    def save_review_launch(page, title, content):
        expect(page.locator('#launch-brief-title')).to_be_visible()
        page.locator('#launch-brief-title').fill(title)
        page.locator('#launch-brief-content').fill(content)
        page.locator('#launch-save').click()
        expect(page.locator('#launch-assignment-launch')).to_be_enabled()
        page.locator('#launch-assignment-launch').click()
        expect(page.locator('#launch-result-facts')).to_be_visible()
        expect(page.locator('#launch-result-discuss')).to_be_visible()

    def finish(errors, name):
        assert not errors, errors
        summary['page_errors'].extend(errors)
        passed(name)

    try:
        # Entry: thread Prepare opens the same launch identity and the old
        # in-thread handoff composer is gone; the server binds the target.
        for width in widths:
            reset()
            page, errors = open(width)
            page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
            expect(page.locator('#thread-draft')).to_be_visible()
            for selector in ('#thread-brief-title', '#thread-brief-content', '#thread-handoff-status', '[data-thread-preview]', '[data-thread-launch]', '#thread-preview', '#thread-result'):
                assert page.locator(selector).count() == 0, selector
            expect(page.locator('#thread-prepare-assignment')).to_be_visible()
            capture(page, f'thread-entry-{width}.png')
            page.locator('#thread-prepare-assignment').click()
            expect(page).to_have_url(re.compile(r'#/launch\?[^#]*thread=' + re.escape(thread1)))
            hash_value = page.evaluate('location.hash')
            assert 'target=fixture-repo' in hash_value, hash_value
            assert 'tab=brief' in hash_value, hash_value
            page.locator('#launch-brief-title').fill('Thread entry brief')
            page.locator('#launch-brief-content').fill('Outcome\nPrepare the launch brief from the thread entry.')
            page.locator('#launch-save').click()
            # Requested facts render the route-carried repository identity while
            # the contract resolves; the resolved contract binds the thread's
            # stored repository target server-side (fixture-repo) and is never
            # invented from the client route.
            expect(page.locator('#launch-review-requested [data-fact="target"] dd')).to_have_text('fixture-repo')
            expect(page.locator('.launch-contract [data-fact="target"] dd')).to_have_text('fixture-repo')
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            finish(errors, f'thread Prepare opens the same launch identity with the server-bound target ({width})')

        # Return: Discuss seeds the exact thread once without sending. The
        # retained per-thread draft survives A -> B -> A; once explicitly
        # cleared it stays cleared across switches and the Files rail return,
        # and the consumed one-use seed never replays.
        for width in widths:
            reset()
            page, errors = open(width)
            page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
            page.locator('#thread-prepare-assignment').click()
            save_review_launch(page, 'Thread result brief', 'Outcome\nReturn the result draft to this thread.')
            sends_before = len(posts('send'))
            page.locator('#launch-result-discuss').click()
            expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
            draft = page.locator('#thread-draft')
            expect(draft).not_to_have_value('')
            seeded = draft.input_value()
            assert seeded.startswith('Assignment '), seeded
            assert len(posts('send')) == sends_before
            capture(page, f'thread-return-{width}.png')
            # Retained draft: A -> B -> A restores the seeded text.
            page.locator('[data-thread="' + thread2 + '"]').click()
            expect(draft).to_have_value('')
            page.locator('[data-thread="' + thread1 + '"]').click()
            expect(draft).to_have_value(seeded)
            # Explicitly clear A: switching away/back and leaving through the
            # Files rail both keep the empty retained draft, and no send is
            # ever posted for the seeded or cleared text.
            draft.fill('')
            page.locator('[data-thread="' + thread2 + '"]').click()
            page.locator('[data-thread="' + thread1 + '"]').click()
            expect(draft).to_have_value('')
            page.locator('.nav-item[data-area="files"]').click()
            expect(page).to_have_url(re.compile(r'#/files'))
            page.locator('.nav-item[data-area="conversations"]').click()
            expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
            expect(page.locator('#thread-draft')).to_have_value('')
            assert len(posts('send')) == sends_before
            finish(errors, f'Discuss result returns the exact thread, retains the seed until cleared and never replays it ({width})')

        # Missing requested thread: the conversations surface selects nothing and
        # the launch surface refuses fallback and mutations, so no draft is
        # seeded, saved or launched for an unavailable UUID.
        for width in widths:
            reset()
            page, errors = open(width)
            missing = '33333333-3333-4333-8333-333333333333'
            page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
            expect(page.locator('#thread-draft')).to_be_visible()
            page.evaluate("location.hash = '#/conversations?ws=fixture&id=" + missing + "'")
            expect(page.locator('#thread-requested-unavailable')).to_be_visible()
            assert page.locator('[data-thread][aria-pressed="true"]').count() == 0
            assert page.locator('#thread-draft').count() == 0
            assert page.locator('#thread-prepare-assignment').count() == 0
            saves_before = len(posts('saveBrief'))
            launches_before = len(posts('launchAssignment'))
            sends_before = len(posts('send'))
            page.evaluate("location.hash = '#/launch?ws=fixture&thread=" + missing + "&target=fixture-repo&tab=brief'")
            expect(page.locator('#launch-thread-unavailable')).to_be_visible()
            expect(page.locator('#launch-thread-target')).to_have_text('Thread unavailable')
            assert page.locator('#launch-target').count() == 0
            expect(page.locator('#launch-brief-title')).to_be_disabled()
            expect(page.locator('#launch-brief-content')).to_be_disabled()
            expect(page.locator('#launch-save')).to_be_disabled()
            page.wait_for_timeout(200)
            assert len(posts('saveBrief')) == saves_before
            assert len(posts('launchAssignment')) == launches_before
            assert len(posts('send')) == sends_before
            capture(page, f'thread-missing-{width}.png')
            finish(errors, f'missing requested thread refuses fallback and mutations ({width})')

        # Message composer and queue stay message-scoped: sending posts only the
        # thread message, and no thread control launches an assignment.
        for width in widths:
            reset()
            page, errors = open(width)
            page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
            expect(page.locator('#thread-draft')).to_be_visible()
            expect(page.locator('#thread-queue')).to_have_attribute('aria-label', 'Pending messages')
            expect(page.locator('[data-thread-refresh]')).to_be_visible()
            assert page.locator('[data-thread-prepare]').count() == 1
            launches_before = len(posts('launchAssignment'))
            dispatches_before = len(posts('dispatchLaunch'))
            sends_before = len(posts('send'))
            page.locator('#thread-draft').fill('A normal thread message from the composer.')
            expect(page.locator('#thread-send')).to_be_enabled()
            page.locator('#thread-send').click()
            expect(page.locator('#thread-draft')).to_have_value('')
            assert len(posts('send')) == sends_before + 1
            assert posts('send')[-1]['input']['thread_id'] == thread1
            assert posts('send')[-1]['input']['text'] == 'A normal thread message from the composer.'
            page.locator('[data-thread-refresh]').click()
            page.wait_for_timeout(200)
            assert len(posts('launchAssignment')) == launches_before
            assert len(posts('dispatchLaunch')) == dispatches_before
            capture(page, f'thread-composer-{width}.png')
            # A workspace-bound thread carries no repository route target.
            page.locator('[data-thread="' + thread2 + '"]').click()
            expect(page.locator('#thread-prepare-assignment')).to_be_visible()
            page.locator('#thread-prepare-assignment').click()
            expect(page).to_have_url(re.compile(r'#/launch\?[^#]*thread=' + re.escape(thread2)))
            hash_value = page.evaluate('location.hash')
            assert 'target=' not in hash_value, hash_value
            finish(errors, f'message composer and queue remain usable and never launch ({width})')
    finally:
        for context in contexts:
            try: context.close()
            except Exception: pass
        try: api.close()
        except Exception: pass


def run_final_review(browser, url, thread1, thread2, thread3, worktree_target):
    """Focused final-review cases for the three accepted fixes. The fixture
    provides the stored thread bindings and dispatch outcomes; no new matrix is
    started beyond the reused fixture and browser private contexts."""
    widths = (1280, 1600)
    api = browser.new_context()
    contexts = []

    def control(action='', value=''):
        response = api.request.get(url + '/__fixture/control?action=' + action + '&value=' + value)
        assert response.ok
        return response.json()

    def posts(name):
        return [x for x in control()['posts'] if x['name'] == name]

    def capture(page, name):
        path = shots_dir / name
        page.screenshot(path=str(path), full_page=True)
        summary['captures'].append(str(path))

    def open_page(width):
        context = browser.new_context(viewport={'width': width, 'height': 1100}, device_scale_factor=1)
        contexts.append(context)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        return page, errors

    def reset():
        control('stale-launch', 'false')
        control('hold-dispatch-preview', 'false')
        control('hold-dispatch-launch', 'false')
        control('dispatch-preview-refusal', 'none')
        control('dispatch-launch-refusal', 'none')
        control('dispatch-launch-outcome', 'live')
        control('clear-launch-publications')

    def finish(errors, name):
        assert not errors, errors
        summary['page_errors'].extend(errors)
        passed(name)

    try:
        # 1. Thread-bound Runs in reads the stored thread record and thread
        #    suggestions never carry the route target; a missing UUID refuses
        #    fallback display and every mutation control.
        for width in widths:
            reset()
            page, errors = open_page(width)
            # 1a. Repository-bound thread with a misleading route target.
            page.goto(url + '/#/launch?ws=fixture&thread=' + thread1 + '&target=fixture-docs&tab=brief', wait_until='domcontentloaded')
            expect(page.locator('#launch-brief-title')).to_be_visible()
            expect(page.locator('#launch-thread-target')).to_have_text('fixture-repo')
            expect(page.locator('#launch-thread-target')).to_have_attribute('data-thread-target-kind', 'repository')
            expect(page.locator('#launch-thread-target')).not_to_contain_text('fixture-docs')
            assert page.locator('#launch-target').count() == 0
            thread_calls_before = len(posts('suggestions'))
            dispatch_calls_before = len(posts('dispatchSuggestions'))
            page.locator('#launch-brief-content').fill('Review @fixture-repo-plan')
            expect(page.locator('.brief-suggestions')).to_contain_text('fixture-repo-plan')
            thread_calls = posts('suggestions')[thread_calls_before:]
            assert thread_calls, 'thread suggestions come from the thread endpoint'
            assert thread_calls[-1]['input']['workspace_id'] == 'fixture'
            assert thread_calls[-1]['input']['thread_id'] == thread1
            assert 'repository_id' not in thread_calls[-1]['input']
            assert len(posts('dispatchSuggestions')) == dispatch_calls_before
            capture(page, f'final-review-thread-target-repo-{width}.png')
            # 1b. Worktree thread keeps its stored path, never an inferred repo.
            page.evaluate("location.hash = '#/launch?ws=fixture&thread=" + thread3 + "&tab=brief'")
            expect(page.locator('#launch-thread-target')).to_have_text(worktree_target)
            expect(page.locator('#launch-thread-target')).to_have_attribute('data-thread-target-kind', 'worktree')
            expect(page.locator('#launch-thread-target')).not_to_contain_text('fixture-docs')
            assert page.locator('#launch-target').count() == 0
            thread_calls_before = len(posts('suggestions'))
            page.locator('#launch-brief-content').fill('Review @fixture-docs-guide')
            expect(page.locator('.brief-suggestions')).to_contain_text('fixture-docs-guide')
            thread_calls = posts('suggestions')[thread_calls_before:]
            assert thread_calls and thread_calls[-1]['input']['thread_id'] == thread3
            assert 'repository_id' not in thread_calls[-1]['input']
            capture(page, f'final-review-thread-target-worktree-{width}.png')
            # 1c. Missing UUID: unavailable display and no mutation controls.
            missing = '99999999-9999-4999-8999-999999999999'
            saves_before = len(posts('saveBrief'))
            previews_before = len(posts('previewAssignment'))
            launches_before = len(posts('launchAssignment'))
            dispatch_calls_before = len(posts('dispatchSuggestions'))
            page.evaluate("location.hash = '#/launch?ws=fixture&thread=" + missing + "&target=fixture-repo&tab=brief'")
            expect(page.locator('#launch-thread-unavailable')).to_be_visible()
            expect(page.locator('#launch-thread-target')).to_have_text('Thread unavailable')
            assert page.locator('#launch-target').count() == 0
            expect(page.locator('#launch-brief-title')).to_be_disabled()
            expect(page.locator('#launch-brief-content')).to_be_disabled()
            expect(page.locator('#launch-save')).to_be_disabled()
            page.wait_for_timeout(200)
            assert len(posts('saveBrief')) == saves_before
            assert len(posts('previewAssignment')) == previews_before
            assert len(posts('launchAssignment')) == launches_before
            assert len(posts('dispatchSuggestions')) == dispatch_calls_before
            capture(page, f'final-review-thread-missing-{width}.png')
            finish(errors, f'final-review: stored thread target, thread suggestions and missing-thread refusal ({width})')

        # 2. Retained direct outcomes keep result presentation on explicit
        #    Agents -> Launch agent re-entry: failed exposes correction, an
        #    unconfirmed result stays locate-only, and nothing is submitted.
        for width in widths:
            for outcome, expectation in (('failed', 'correct'), ('unknown', 'locate')):
                reset()
                page, errors = open_page(width)
                control('dispatch-launch-outcome', outcome)
                page.goto(url + '/#/launch?ws=fixture&tab=brief', wait_until='domcontentloaded')
                expect(page.locator('#launch-brief-title')).to_be_visible()
                page.locator('#launch-brief-title').fill('Retained outcome brief')
                page.locator('#launch-brief-content').fill('Outcome\nKeep the retained result inspectable.')
                page.locator('#launch-save').click()
                expect(page.locator('#launch-assignment-launch')).to_be_enabled()
                assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
                page.locator('#launch-assignment-launch').click()
                expect(page.locator('#launch-result-facts')).to_be_visible()
                saves_before = len(posts('dispatchSaveBrief'))
                previews_before = len(posts('dispatchPreview'))
                launches_before = len(posts('dispatchLaunch'))
                page.locator('#launch-result-open-agent').click()
                expect(page.locator('#launch-agent-action')).to_be_visible()
                page.locator('#launch-agent-action').click()
                expect(page.locator('#launch-result-facts [data-fact="assignment"] dd')).to_have_text(assignment)
                expect(page.locator('#launch-brief-title')).to_have_count(0)
                expect(page.locator('#launch-save')).to_have_count(0)
                if expectation == 'correct':
                    expect(page.locator('#launch-result-correct')).to_be_visible()
                    capture(page, f'final-review-reentry-failed-{width}.png')
                    # A mismatched result id still renders inspect-only, never a
                    # fallback claim for the retained identity.
                    page.evaluate("location.hash = '#/launch?ws=fixture&tab=result&id=99999999-9999-4999-8999-999999999999'")
                    expect(page.locator('#launch-result-inspection')).to_be_visible()
                    assert page.locator('#launch-result-facts').count() == 0
                    capture(page, f'final-review-result-inspection-{width}.png')
                else:
                    expect(page.locator('#launch-result-correct')).to_have_count(0)
                    href = page.locator('#launch-result-open-agent').get_attribute('href')
                    assert href is not None and 'q=' in href, href
                    capture(page, f'final-review-reentry-unconfirmed-{width}.png')
                page.wait_for_timeout(200)
                assert len(posts('dispatchSaveBrief')) == saves_before
                assert len(posts('dispatchPreview')) == previews_before
                assert len(posts('dispatchLaunch')) == launches_before
                finish(errors, f'final-review: retained {outcome} re-entry stays in result presentation ({width})')

        # 3. Explicit thread Prepare after an acknowledged result clears only
        #    that draft and starts independent work with fresh identities; the
        #    navigation itself never dispatches.
        for width in widths:
            reset()
            page, errors = open_page(width)
            page.goto(url + '/#/conversations?ws=fixture&id=' + thread1, wait_until='domcontentloaded')
            expect(page.locator('#thread-prepare-assignment')).to_be_visible()
            page.locator('#thread-prepare-assignment').click()
            expect(page).to_have_url(re.compile(r'#/launch\?[^#]*thread=' + re.escape(thread1)))
            expect(page.locator('#launch-brief-title')).to_be_visible()
            page.locator('#launch-brief-title').fill('First thread brief')
            page.locator('#launch-brief-content').fill('Outcome\nFirst thread work.')
            page.locator('#launch-save').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            first_request = posts('saveBrief')[-1]['input']['request_id']
            page.locator('#launch-assignment-launch').click()
            expect(page.locator('#launch-result-facts')).to_be_visible()
            first_assignment = posts('launchAssignment')[-1]['input']['assignment_id']
            sends_before = len(posts('send'))
            page.locator('#launch-result-discuss').click()
            expect(page).to_have_url(re.compile(r'#/conversations\?ws=fixture&id=' + re.escape(thread1)))
            assert len(posts('send')) == sends_before
            saves_before = len(posts('saveBrief'))
            previews_before = len(posts('previewAssignment'))
            launches_before = len(posts('launchAssignment'))
            page.locator('#thread-prepare-assignment').click()
            expect(page.locator('#launch-brief-title')).to_have_value('')
            expect(page.locator('#launch-brief-content')).to_have_value('')
            assert page.locator('#launch-result-facts').count() == 0
            assert len(posts('saveBrief')) == saves_before
            assert len(posts('previewAssignment')) == previews_before
            assert len(posts('launchAssignment')) == launches_before
            page.locator('#launch-brief-title').fill('Independent follow-up')
            page.locator('#launch-brief-content').fill('Outcome\nIndependent follow-up work.')
            page.locator('#launch-save').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            fresh_request = posts('saveBrief')[-1]['input']['request_id']
            assert fresh_request != first_request, 'the saved brief mints a fresh request identity'
            fresh_assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
            assert fresh_assignment != first_assignment, 'the review mints a fresh assignment identity'
            assert len(posts('launchAssignment')) == launches_before
            capture(page, f'final-review-thread-independent-{width}.png')
            finish(errors, f'final-review: explicit thread Prepare after acknowledged success starts independent work ({width})')
    finally:
        for context in contexts:
            try: context.close()
            except Exception: pass
        try: api.close()
        except Exception: pass


started = time.monotonic()
fixture = subprocess.Popen(['node', str(root / 'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    if not select.select([fixture.stdout], [], [], 10)[0]:
        raise RuntimeError('Fixture startup timed out')
    fixture_info = json.loads(fixture.stdout.readline())
    summary['observedCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
    summary['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=checkout, text=True).strip())
    url = fixture_info['url']
    thread1 = fixture_info['thread1']
    thread2 = fixture_info['thread2']
    thread3 = fixture_info['thread3']
    worktree_target = fixture_info['worktreeTarget']
    with sync_playwright() as p:
        if section == 'thread':
            # The thread route/draft section owns its Playwright Chromium (no
            # CDP) so it can run standalone against the temporary fixture;
            # every other section keeps the existing CDP contract.
            executable = shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': executable} if executable else {}), headless=True, args=['--no-sandbox'])
        else:
            browser = p.chromium.connect_over_cdp(os.environ.get('SENTINEL_CDP_URL', 'http://127.0.0.1:9222'))
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
        elif section == 'result':
            try:
                run_result(browser, url, thread1)
                assert not summary['page_errors'], summary['page_errors']
                summary['status']='passed'
                print(json.dumps({'status': 'passed', 'elapsed_seconds': round(time.monotonic() - started, 2), 'cases': summary['cases'], 'captures': summary['captures'], 'boundary': summary['boundary'], 'receipt': str(receipt)}))
            except BaseException as exc:
                summary['error']=repr(exc)
                raise
        elif section == 'thread':
            try:
                run_thread(browser, url, thread1, thread2)
                assert not summary['page_errors'], summary['page_errors']
                summary['status']='passed'
                print(json.dumps({'status': 'passed', 'elapsed_seconds': round(time.monotonic() - started, 2), 'cases': summary['cases'], 'captures': summary['captures'], 'boundary': summary['boundary'], 'receipt': str(receipt)}))
            except BaseException as exc:
                summary['error']=repr(exc)
                raise
            finally:
                # Close the thread-owned Chromium inside the live Playwright
                # session: closing after the context manager exits raises
                # "Event loop is closed". browserClosed records only an
                # observed successful close.
                if browser is not None:
                    try:
                        browser.close()
                        cleanup['browserClosed'] = True
                    except Exception as error:
                        cleanup['errors'].append(f'browser close: {error}')
        elif section == 'final-review':
            try:
                run_final_review(browser, url, thread1, thread2, thread3, worktree_target)
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
                # Direct journey: Agents -> Launch agent -> picker -> brief.
                # The retired thread composer is replaced by the direct launch
                # flow while every named save/review/dispatch protection remains.
                page.goto(url+'/#/agents', wait_until='domcontentloaded')
                expect(page.locator('#launch-agent-action')).to_be_visible()
                page.locator('#launch-agent-action').click()
                expect(page.locator('.workspace-picker')).to_be_visible()
                page.locator('.workspace-picker button[data-workspace="fixture"]').click()
                expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=brief'))
                title, brief = page.locator('#launch-brief-title'), page.locator('#launch-brief-content')
                save = page.locator('#launch-save')
                title.fill('Preferred models settings')
                brief.fill('/spec-architect-initial add a settings area for preferred models')
                brief.press('End'); brief.press_sequentially(' See @browser')
                expect(page.get_by_role('option', name='@notes/browser.md', exact=False)).to_be_visible()
                brief.press('Tab')
                expect(page.locator('.brief-references')).to_contain_text('@workspace/notes/browser.md')

                # Screen 85 locked saving: a pending save disables the submitted
                # fields. The retired in-flight edit/focus assertion is replaced
                # by leaving mid-save: one request and the typed content survive.
                control('delay-dispatch-brief', 'true')
                save.click()
                expect(save).to_contain_text('Saving brief…')
                expect(title).to_be_disabled()
                expect(brief).to_be_disabled()
                expect(page.locator('#launch-target')).to_be_disabled()
                page.locator('.head-actions .ds-btn').click()
                expect(page).to_have_url(re.compile(r'#/agents'))
                control('delay-dispatch-brief', 'false')
                page.wait_for_timeout(900)
                assert len(posts('dispatchSaveBrief')) == 1
                page.go_back()
                expect(page.locator('#launch-brief-title')).to_have_value('Preferred models settings')
                expect(page.locator('#launch-brief-content')).to_have_value('/spec-architect-initial add a settings area for preferred models See @workspace/notes/browser.md ')
                expect(page.locator('#launch-saved')).to_be_visible()
                passed('locked saving restores pending work')

                # Save-only confirmation: the restored handoff is saved once and
                # nothing previews or launches until an explicit action.
                expect(page.locator('#launch-saved')).to_contain_text('Saving does not start an agent')
                saved_input = posts('dispatchSaveBrief')[-1]['input']
                assert saved_input['title'] == 'Preferred models settings'
                assert saved_input['content'].startswith('/spec-architect-initial add a settings area for preferred models')
                assert not posts('dispatchPreview')
                assert not posts('dispatchLaunch')
                passed('save-only confirmation')

                # Repeated Enter on unchanged content must not create another handoff.
                before = len(posts('dispatchSaveBrief'))
                expect(save).to_be_disabled()
                brief.press('Enter')
                expect(save).to_be_disabled()
                assert len(posts('dispatchSaveBrief')) == before
                passed('unchanged Enter preserves handoff')

                shot(page.locator('.flow'), 'ev-4-handoff-saved.png')
                full_shot('ev-4-handoff-desktop.png')
                passed('desktop boundary capture')

                # Review resolves the saved handoff once; dispatch stays explicit.
                page.evaluate("location.hash = '#/launch?ws=fixture&tab=review'")
                expect(page.locator('#launch-review')).to_be_visible()
                expect(page.locator('#launch-assignment-launch')).to_be_enabled()
                expect(page.locator('#launch-heading')).to_be_focused()
                assert len(posts('dispatchPreview')) == 1
                assert not posts('dispatchLaunch')
                page.evaluate("[...document.querySelectorAll('#launch-what-pi details')].forEach(d=>d.open=true)")
                expect(page.locator('#launch-what-pi')).to_contain_text('add a settings area for preferred models')
                expect(page.locator('#launch-what-pi')).to_contain_text('Perform the attached assignment brief.')
                expect(page.locator('#launch-what-pi')).to_contain_text('A recorded note.')
                passed('preview then explicit launch')

                # Changed source: the launch refuses the stale digest until a
                # fresh review captures the new file contents.
                control('edit-context')
                page.locator('#launch-assignment-launch').click()
                expect(page.locator('#launch-review-error')).to_contain_text('The reviewed contract changed')
                expect(page.locator('#launch-assignment-launch')).to_have_count(0)
                page.locator('#launch-assignment-review').click()
                expect(page.locator('#launch-assignment-launch')).to_be_enabled()
                page.evaluate("[...document.querySelectorAll('#launch-what-pi details')].forEach(d=>d.open=true)")
                expect(page.locator('#launch-what-pi')).to_contain_text('Changed source after preview.')
                passed('stale source-change recovery')

                # Dirty edits withdraw review until the revised brief is saved.
                page.locator('#launch-assignment-edit').click()
                brief.fill('Changed request')
                expect(page.locator('#launch-review-unsaved')).to_contain_text('Unsaved changes are not reviewed')
                expect(page.locator('#launch-assignment-launch')).to_have_count(0)
                save.click()
                expect(page.locator('#launch-assignment-launch')).to_be_enabled()
                assert posts('dispatchSaveBrief')[-1]['input']['content'] == 'Changed request'
                page.evaluate("[...document.querySelectorAll('#launch-what-pi details')].forEach(d=>d.open=true)")
                expect(page.locator('#launch-what-pi')).to_contain_text('Changed request')
                passed('dirty edits require a fresh save')

                # Single submission: a held dispatch rejects a second click and
                # pending navigation retains the reviewed facts.
                control('hold-dispatch-launch', 'true')
                launches_before = len(posts('dispatchLaunch'))
                assignment = page.locator('#launch-review [data-fact="assignment"] dd').inner_text()
                digest = page.locator('#launch-review [data-fact="digest"] dd').inner_text()
                page.evaluate("() => { const b = document.getElementById('launch-assignment-launch'); b.click(); b.click(); }")
                expect(page.locator('#launch-assignment-launch')).to_be_disabled()
                expect(page.locator('#launch-assignment-launch')).to_contain_text('Starting agent')
                assert len(posts('dispatchLaunch')) == launches_before + 1
                submitted = posts('dispatchLaunch')[-1]['input']
                assert submitted['assignment_id'] == assignment
                assert submitted['expectedDigest'] == digest
                page.locator('.head-actions .ds-btn').click()
                expect(page).to_have_url(re.compile(r'#/agents'))
                page.evaluate("location.hash = '#/launch?ws=fixture&tab=review'")
                expect(page.locator('#launch-assignment-launch')).to_contain_text('Starting agent')
                assert len(posts('dispatchLaunch')) == launches_before + 1
                passed('single submit retains reviewed facts')
                control('release-dispatch-launch', 'true')
                expect(page.locator('#launch-result-facts')).to_be_visible()
                expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&id=' + re.escape(assignment) + '&tab=result'))
                expect(page.locator('#launch-heading')).to_have_text('Agent is live')
                expect(page.locator('#launch-heading')).to_be_focused()
                expect(page.locator('#launch-result-facts [data-fact="observation"] dd')).to_contain_text('Live process confirmed')
                assert len(posts('dispatchLaunch')) == 2  # one stale refusal, one launch
                assert len(posts('dispatchSaveBrief')) == 2
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
    summary['elapsedSeconds'] = round(time.monotonic() - started, 3)
    summary['cleanup'] = cleanup
    write_receipt()
