# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Focused composer journey: uv run --script scripts/spec-observe/frontend/autocomplete-check.py.
Uses scratch storage, real reference capture and HTTP, fake launch workers, and
the uishot browser on port 9222. The 5.2-second wait crosses a real refresh.
"""
import json, os, select, subprocess
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
    url = json.loads(line)['url']
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
            page.goto(url+'/#/conversations?ws=fixture', wait_until='domcontentloaded')
            assert page.evaluate('location.hash')=='#/conversations?ws=fixture', page.evaluate('location.hash')
            brief = page.locator('#thread-brief-content')
            brief.wait_for(); page.locator('#thread-brief-title').fill('Context handoff')

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
            assert posts('saveBrief') == []  # Enter accepts a suggestion before saving.
            expect(page.get_by_label('Selected assignment context')).to_contain_text('/fixture-skill')
            passed('contextual skill completion')

            brief.press('End'); brief.press('Shift+Enter'); brief.press_sequentially('Use @browser')
            file_option = page.get_by_role('option', name='@notes/browser.md', exact=False)
            expect(file_option).to_be_visible()
            expect(file_option).to_contain_text('Browser note')
            brief.press('ArrowDown'); brief.press('ArrowUp'); brief.press('Tab')
            expect(brief).to_have_value('/fixture-skill \nUse @workspace/notes/browser.md ')
            expect(page.get_by_label('Selected assignment context')).to_contain_text('@workspace/notes/browser.md')
            passed('file keyboard completion and metadata')
            brief.evaluate('(el)=>el.setSelectionRange(5,5)')
            page.wait_for_timeout(5200)
            assert brief.evaluate('(el)=>[el.selectionStart,el.selectionEnd]') == [5,5]
            expect(brief).to_be_focused()
            passed('polling cursor and metadata retention')

            page.locator('[data-thread-brief-save]').click()
            expect(page.locator('[data-thread-preview]')).to_be_enabled()
            saved = posts('saveBrief')[-1]['input']
            assert [ref['kind'] for ref in saved['references']] == ['skill','file']
            assert all(set(ref) == {'kind','id'} for ref in saved['references'])
            page.locator('[data-thread-preview]').click()
            expect(page.get_by_text('What Pi will receive', exact=True)).to_be_visible()
            page.get_by_text('Complete brief and context', exact=True).click()
            expect(page.locator('.assignment-input')).to_contain_text('Apply the selected workflow')
            expect(page.locator('.assignment-input')).to_contain_text('A recorded note.')
            expect(page.locator('.assignment-input')).to_contain_text('Supporting references are relative to')
            shot(page.locator('.assignment-input'), 'ev-3-autocomplete-preview.png')
            control('stale-launch', False)
            control('edit-context')
            page.locator('[data-thread-launch]').click()
            expect(page.locator('[data-thread-launch]')).to_be_disabled()
            page.locator('[data-thread-preview]').click()
            page.get_by_text('Complete brief and context',exact=True).click()
            expect(page.locator('.assignment-input')).to_contain_text('Changed source after preview.')
            passed('stale reply refusal and re-preview')
            page.locator('[data-thread-launch]').click()
            expect(page.locator('.thread-result')).to_contain_text('live')
            assert posts('launchAssignment')[-1]['input']['expectedDigest']
            passed('captured preview and launch digest')

            # Editing away a marker removes its identity and makes saved preview dirty.
            brief.fill('Revised brief without selected markers')
            expect(page.get_by_label('Selected assignment context')).to_have_count(0)
            expect(page.locator('[data-thread-preview]')).to_be_disabled()
            page.locator('[data-thread-brief-save]').click()
            expect(page.locator('[data-thread-preview]')).to_be_enabled()
            assert posts('saveBrief')[-1]['input']['references'] == []
            passed('marker removal makes preview dirty')

            # Superseded searches must not reopen a popup or insert into another thread.
            control('delay-suggestions', True)
            brief.fill('@browser')
            page.wait_for_timeout(150)
            brief.fill('@not-a-file')
            expect(page.get_by_text('No matching text files in this target.')).to_be_visible()
            expect(page.locator('.brief-suggestions [role=option]')).to_have_count(0)
            brief.press('Escape')
            expect(page.get_by_role('listbox')).to_have_count(0)
            expect(brief).to_have_value('@not-a-file')
            brief.fill('/fixture')
            page.get_by_role('button',name=__import__('re').compile('Discussion two')).click()
            expect(brief).to_have_value('')
            page.wait_for_timeout(750)
            expect(page.get_by_role('listbox')).to_have_count(0)
            control('delay-suggestions', False)
            passed('superseded search and thread switch')

            # Desktop pointer selection uses the same stable native editor.
            brief.fill('@browser')
            expect(page.get_by_role('option', name='@notes/browser.md',exact=False)).to_be_visible()
            shot(page.locator('.brief-composer'), 'ev-3-autocomplete-pointer.png')
            page.get_by_role('option', name='@notes/browser.md',exact=False).click()
            expect(brief).to_have_value('@workspace/notes/browser.md ')
            expect(brief).to_be_focused()
            page.get_by_role('button', name='Remove notes/browser.md',exact=True).click()
            expect(page.get_by_label('Selected assignment context')).to_have_count(0)
            passed('desktop pointer selection')
            assert not errors, errors
            summary['status']='passed'; summary['page_errors']=errors
            print('PASS: contextual skill/file completion, metadata editing, real captured preview, launch digest, stale replies, polling cursor, desktop pointer selection; receipt '+str(receipt))
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
