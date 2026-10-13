# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused launch brief journey: uv run --script scripts/spec-observe/frontend/autocomplete-check.py.
Uses scratch storage, real reference capture and HTTP, and fake dispatch workers;
the fake dispatch boundary proves browser request/response behavior, not backend
composition, and never launches a real assignment. The 5.2-second wait crosses a
real refresh.
"""
import json, os, re, select, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent
evidence_dir = Path(os.environ['SENTINEL_EVIDENCE_DIR']) if os.environ.get('SENTINEL_EVIDENCE_DIR') else None
shots_dir = (evidence_dir / 'browser') if evidence_dir else Path('/tmp')
if evidence_dir: shots_dir.mkdir(parents=True, exist_ok=True)
receipt = (evidence_dir or Path('/tmp')) / 'ev-3-autocomplete.json'
summary = {'status':'failed','cases':[],'page_errors':[],'captures':[],'boundary':'1440x1100 desktop'}
def passed(name): summary['cases'].append(name)
def shot(locator, name):
    path = shots_dir / name
    locator.screenshot(path=str(path))
    summary['captures'].append(str(path))
def write_receipt():
    temporary = receipt.with_name(receipt.name + '.tmp')
    temporary.write_text(json.dumps(summary, indent=2) + '\n')
    os.replace(temporary, receipt)
fixture = subprocess.Popen(['node', str(root/'browser-fixture.mjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    if not select.select([fixture.stdout], [], [], 10)[0]: raise RuntimeError('Fixture startup timed out')
    line = fixture.stdout.readline()
    if not line: raise RuntimeError('Fixture startup failed: '+fixture.stderr.read())
    info = json.loads(line); url = info['url']; thread1 = info['thread1']
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        context = browser.new_context(viewport={'width':1440,'height':1100}, device_scale_factor=1)
        try:
            page = context.new_page(); errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            def control(action=None, value=None):
                response = context.request.get(url+'/__fixture/control'+('' if action is None else f'?action={action}&value={str(value).lower()}'))
                assert response.ok
                return response.json()
            def posts(name): return [post for post in control()['posts'] if post['name'] == name]
            def open_details(): page.evaluate("[...document.querySelectorAll('#launch-what-pi details')].forEach(d=>d.open=true)")

            # Ordinary entry: Agents -> Launch agent, then the workspace picker
            # mounts the direct brief; no thread is created.
            page.goto(url+'/#/agents', wait_until='domcontentloaded')
            expect(page.locator('#launch-agent-action')).to_be_visible()
            page.locator('#launch-agent-action').click()
            expect(page.locator('.workspace-picker')).to_be_visible()
            page.locator('.workspace-picker button[data-workspace="fixture"]').click()
            expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=brief'))
            brief = page.locator('#launch-brief-content')
            brief.wait_for(); page.locator('#launch-brief-title').fill('Context handoff')
            refs = page.locator('.brief-references[aria-label="Selected assignment context"]')

            # Trigger boundaries don't turn ordinary paths or emails into references.
            brief.fill('Inspect src/work and email me@example.com'); brief.press('End')
            expect(page.get_by_role('listbox')).to_have_count(0)
            brief.fill('/fixture')
            option = page.get_by_role('option', name='/fixture-skill', exact=False)
            expect(option).to_be_visible()
            expect(option).to_contain_text('Plan work from the chosen brief.')
            shot(page.locator('.brief-composer'), 'ev-3-autocomplete-skills.png')
            brief.press('Enter')
            expect(brief).to_have_value('/fixture-skill ')
            assert posts('dispatchSaveBrief') == []  # Enter accepts a suggestion before saving.
            expect(refs).to_contain_text('/fixture-skill')
            passed('contextual skill completion')

            brief.press('End'); brief.press('Shift+Enter'); brief.press_sequentially('Use @browser')
            file_option = page.get_by_role('option', name='@notes/browser.md', exact=False)
            expect(file_option).to_be_visible()
            expect(file_option).to_contain_text('Browser note')
            brief.press('ArrowDown'); brief.press('ArrowUp'); brief.press('Tab')
            expect(brief).to_have_value('/fixture-skill \nUse @workspace/notes/browser.md ')
            expect(refs).to_contain_text('@workspace/notes/browser.md')
            passed('file keyboard completion and metadata')

            # A real refresh keeps the caret and the selected metadata.
            brief.evaluate('(el)=>el.setSelectionRange(5,5)')
            page.wait_for_timeout(5200)
            assert brief.evaluate('(el)=>[el.selectionStart,el.selectionEnd]') == [5,5]
            passed('polling cursor and metadata retention')

            # Screen 85 (85-launch-brief-saving): saving locks the submitted
            # fields, and the save->review transition focuses the heading. This
            # replaces the retired editor-focus-while-editing assertion.
            control('delay-dispatch-brief', True)
            page.locator('#launch-save').click()
            expect(page.locator('#launch-save')).to_contain_text('Saving brief…')
            expect(page.locator('#launch-brief-title')).to_be_disabled()
            expect(brief).to_be_disabled()
            expect(page.locator('#launch-target')).to_be_disabled()
            control('delay-dispatch-brief', False)
            expect(page).to_have_url(re.compile(r'#/launch\?ws=fixture&tab=review'))
            expect(page.locator('#launch-heading')).to_be_focused()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            passed('locked saving and heading focus')

            # References cross the wire as identity only; the resolved contract
            # captures the skill and file contents from those identities.
            preview = posts('dispatchPreview')[-1]['input']
            assert [ref['kind'] for ref in preview['references']] == ['skill','file']
            assert all(set(ref) == {'kind','id'} for ref in preview['references'])
            open_details()
            expect(page.locator('#launch-what-pi')).to_contain_text('Apply the selected workflow')
            expect(page.locator('#launch-what-pi')).to_contain_text('A recorded note.')
            expect(page.locator('#launch-what-pi')).to_contain_text('Supporting references are relative to')
            shot(page.locator('#launch-what-pi'), 'ev-3-autocomplete-preview.png')
            passed('identity-only references and captured preview')

            # A changed source file invalidates the reviewed contract; the stale
            # refusal withholds dispatch until a fresh review captures it.
            control('edit-context')
            page.locator('#launch-assignment-launch').click()
            expect(page.locator('#launch-review-error')).to_contain_text('The reviewed contract changed')
            expect(page.locator('#launch-assignment-launch')).to_have_count(0)
            page.locator('#launch-assignment-review').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            open_details()
            expect(page.locator('#launch-what-pi')).to_contain_text('Changed source after preview.')
            passed('stale reply refusal and re-preview')
            page.locator('#launch-assignment-launch').click()
            expect(page.locator('#launch-result-facts')).to_be_visible()
            expect(page.locator('#launch-result-facts')).to_contain_text('Live process confirmed')
            assert posts('dispatchLaunch')[-1]['input']['expectedDigest']
            passed('captured preview and launch digest')

            # An explicit new entry after the acknowledged result starts an
            # independent draft; editing away a marker drops its identity and
            # withholds the saved approval until the brief is saved again.
            page.locator('#launch-result-open-agent').click()
            expect(page.locator('#launch-agent-action')).to_be_visible()
            page.locator('#launch-agent-action').click()
            expect(page.locator('#launch-brief-title')).to_have_value('')
            expect(brief).to_have_value('')
            page.locator('#launch-brief-title').fill('Marker removal check')
            brief.fill('/fixture')
            expect(page.get_by_role('option', name='/fixture-skill', exact=False)).to_be_visible()
            brief.press('Enter')
            expect(refs).to_contain_text('/fixture-skill')
            page.locator('#launch-save').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            page.locator('#launch-assignment-edit').click()
            brief.fill('Revised brief without selected markers')
            expect(refs).to_have_count(0)
            expect(page.locator('#launch-review-unsaved')).to_contain_text('Unsaved changes are not reviewed')
            expect(page.locator('#launch-assignment-launch')).to_have_count(0)
            page.locator('#launch-save').click()
            expect(page.locator('#launch-assignment-launch')).to_be_enabled()
            assert posts('dispatchPreview')[-1]['input']['references'] == []
            passed('marker removal makes preview dirty')

            # Superseded searches must not reopen a popup or insert into another
            # thread context.
            page.locator('#launch-assignment-edit').click()
            control('delay-dispatch-suggestions', True)
            brief.fill('@browser')
            page.wait_for_timeout(150)
            brief.fill('@not-a-file')
            expect(page.get_by_text('No matching text files in this target.')).to_be_visible()
            expect(page.locator('.brief-suggestions [role=option]')).to_have_count(0)
            brief.press('Escape')
            expect(page.get_by_role('listbox')).to_have_count(0)
            expect(brief).to_have_value('@not-a-file')

            # Desktop pointer selection uses the same stable native editor.
            brief.fill('@browser')
            expect(page.get_by_role('option', name='@notes/browser.md', exact=False)).to_be_visible()
            shot(page.locator('.brief-composer'), 'ev-3-autocomplete-pointer.png')
            page.get_by_role('option', name='@notes/browser.md', exact=False).click()
            expect(brief).to_have_value('@workspace/notes/browser.md ')
            expect(brief).to_be_focused()
            page.get_by_role('button', name='Remove notes/browser.md', exact=True).click()
            expect(refs).to_have_count(0)

            # A superseded delayed request must not populate another thread
            # context's composer.
            brief.fill('/fixture')
            page.evaluate("location.hash = '#/launch?ws=fixture&thread=" + thread1 + "&target=fixture-repo&tab=brief'")
            expect(page.locator('#launch-brief-content')).to_have_value('')
            page.wait_for_timeout(750)
            expect(page.get_by_role('listbox')).to_have_count(0)
            control('delay-dispatch-suggestions', False)
            passed('superseded search and thread switch')
            passed('desktop pointer selection')

            assert not errors, errors
            summary['status']='passed'; summary['page_errors']=errors
            print('PASS: launch brief skill/file completion, locked saving, captured preview, launch digest, changed-source refusal, marker removal, superseded search, pointer selection; receipt '+str(receipt))
        except BaseException as exc:
            summary['error']=repr(exc)
            try: summary['page_errors']=errors
            except Exception: summary['page_errors']=[]
            raise
        finally: context.close()
finally:
    try:
        write_receipt()
    finally:
        fixture.terminate()
        try: fixture.wait(timeout=10)
        except subprocess.TimeoutExpired: fixture.kill(); fixture.wait()
