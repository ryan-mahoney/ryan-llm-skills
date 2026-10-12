# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Run: uv run --script scripts/spec-observe/frontend/browser-session-check.py
Isolated dashboard fixture; session termination is fake and cannot reach live agents.
"""
import json,select,subprocess,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent
started=time.monotonic()
fixture=subprocess.Popen(['node',str(root/'browser-fixture.mjs')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    if not select.select([fixture.stdout],[],[],10)[0]:raise RuntimeError('Fixture startup timed out')
    url=json.loads(fixture.stdout.readline())['url']
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        context=browser.new_context(viewport={'width':1440,'height':1100},permissions=['clipboard-read','clipboard-write'])
        try:
            page=context.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            def control(action='',value=''):
                return context.request.get(url+'/__fixture/control?action='+action+'&value='+value).json()
            def ends():return [x for x in control()['posts'] if x['name']=='endSession']
            page.goto(url,wait_until='domcontentloaded')
            page.locator('[data-mode="agents"]').click()
            expect(page.locator('[data-assignment-key]').first).to_contain_text('Idle · response finished')
            page.locator('[data-assignment-key]').first.click()
            expect(page.locator('#session-attach-command')).to_be_visible()
            expect(page.locator('main')).to_contain_text('Ctrl+B')
            expect(page.locator('main')).to_contain_text('then press D')
            page.get_by_role('button',name='Copy attach command',exact=True).click()
            assert 'ssh -t operator@host' in page.evaluate('navigator.clipboard.readText()')
            page.get_by_text('Last response',exact=True).click()
            expect(page.locator('main')).to_contain_text('Architecture proposal complete.')
            page.get_by_role('button',name='End session…',exact=True).click()
            dialog=page.get_by_role('dialog')
            expect(dialog).to_be_visible()
            page.get_by_role('button',name='Refresh state',exact=True).evaluate('(el)=>el.click()')
            expect(dialog).to_be_visible()
            expect(dialog).to_contain_text('Saved files and the transcript will remain')
            page.screenshot(path='/tmp/sentinel-session-desktop.png')
            dialog.get_by_role('button',name='Cancel',exact=True).click()
            assert not ends()
            control('session-end-fails','true')
            page.get_by_role('button',name='End session…',exact=True).click()
            dialog.get_by_role('button',name='End session',exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('identity changed')
            expect(dialog).to_be_visible()
            dialog.get_by_role('button',name='Cancel',exact=True).click()
            control('session-end-fails','false')
            page.set_viewport_size({'width':390,'height':844})
            page.locator('#session-heading').scroll_into_view_if_needed()
            page.locator('.session-controls').screenshot(path='/tmp/sentinel-session-mobile.png')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.get_by_role('button',name='End session…',exact=True).click()
            dialog.get_by_role('button',name='End session',exact=True).click()
            expect(dialog).not_to_be_visible()
            expect(page.get_by_text('Session ended. Saved files and transcript remain available.',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='End session…',exact=True)).to_have_count(0)
            expect(page.locator('#session-attach-command')).to_have_count(0)
            assert len(ends())==2
            assert ends()[-1]['input']['confirm'] is True
            # Imported snapshots must not expose live-session controls or fetch their API.
            snapshot=context.request.get(url+'/api/state').json()
            reads=[]
            page.on('request',lambda r:reads.append(r.url) if '/api/assignment-session' in r.url else None)
            page.locator('#import-file').set_input_files({'name':'snapshot.json','mimeType':'application/json','buffer':json.dumps(snapshot).encode()})
            page.locator('[data-mode="agents"]').click()
            page.locator('[data-assignment-key]').first.click()
            expect(page.get_by_text('Open the live host dashboard to attach to or end a session.',exact=True)).to_be_visible()
            assert not reads
            assert not errors,errors
            print(json.dumps({'status':'passed','elapsed_seconds':round(time.monotonic()-started,2),'scenarios':['idle label and final response','copy attach command','detach help','cancel without mutation','stale identity refusal','confirmed end','mobile layout','offline read-only']}))
        finally:context.close()
finally:
    fixture.terminate();fixture.wait(timeout=10)
