# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Run: uv run --script scripts/spec-observe/frontend/browser-session-check.py
Isolated dashboard fixture; session termination is fake and cannot reach live agents.
"""
import json,os,re,select,subprocess,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent
evidence_dir=Path(os.environ['SENTINEL_EVIDENCE_DIR']) if os.environ.get('SENTINEL_EVIDENCE_DIR') else None
shots_dir=(evidence_dir/'browser') if evidence_dir else Path('/tmp')
if evidence_dir:shots_dir.mkdir(parents=True,exist_ok=True)
receipt=(evidence_dir or Path('/tmp'))/'ev-5-session.json'
summary={'status':'failed','cases':[],'page_errors':[],'captures':[],'boundary':'1440x1100 desktop'}
def passed(name):summary['cases'].append(name)
def full_shot(name):
    path=shots_dir/name
    page.screenshot(path=str(path))
    summary['captures'].append(str(path))
def write_receipt():
    temporary=receipt.with_name(receipt.name+'.tmp')
    temporary.write_text(json.dumps(summary,indent=2)+'\n')
    os.replace(temporary,receipt)
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
            page.goto(url+'/#/agents',wait_until='domcontentloaded')
            expect(page).to_have_url(re.compile(r'#/agents(?:\?id=[^&]+)?$'))
            canonical_assignment=page.locator('[data-assignment-key]').filter(has=page.get_by_text('run-1',exact=True))
            expect(canonical_assignment).to_have_count(1)
            expect(canonical_assignment).to_contain_text('Idle · response finished')
            canonical_assignment.click()
            expect(page.get_by_role('button',name='Refresh session',exact=True)).to_be_visible()
            expect(page.locator('#session-attach-command')).to_be_visible()
            expect(page.locator('main')).to_contain_text('Ctrl+B')
            expect(page.locator('main')).to_contain_text('then press D')
            passed('detach help')
            page.get_by_role('button',name='Copy attach command',exact=True).click()
            assert 'ssh -t operator@host' in page.evaluate('navigator.clipboard.readText()')
            passed('copy attach command')
            page.get_by_text('Last response',exact=True).click()
            expect(page.locator('main')).to_contain_text('Architecture proposal complete.')
            passed('idle label and final response')
            page.get_by_role('button',name='End session…',exact=True).click()
            dialog=page.get_by_role('dialog')
            expect(dialog).to_be_visible()
            page.get_by_role('button',name='Refresh state',exact=True).evaluate('(el)=>el.click()')
            expect(dialog).to_be_visible()
            expect(dialog).to_contain_text('Saved files and the transcript will remain')
            full_shot('ev-5-session-desktop.png')
            dialog.get_by_role('button',name='Cancel',exact=True).click()
            assert not ends()
            passed('cancel without mutation')
            control('session-end-fails','true')
            page.get_by_role('button',name='End session…',exact=True).click()
            dialog.get_by_role('button',name='End session',exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('identity changed')
            expect(dialog).to_be_visible()
            dialog.get_by_role('button',name='Cancel',exact=True).click()
            control('session-end-fails','false')
            passed('stale identity refusal')
            page.get_by_role('button',name='End session…',exact=True).click()
            dialog.get_by_role('button',name='End session',exact=True).click()
            expect(dialog).not_to_be_visible()
            expect(page.get_by_text('Session ended. Saved files and transcript remain available.',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='End session…',exact=True)).to_have_count(0)
            expect(page.locator('#session-attach-command')).to_have_count(0)
            assert len(ends())==2
            assert ends()[-1]['input']['confirm'] is True
            passed('confirmed end')
            # Imported snapshots must not expose live-session controls or fetch their API.
            snapshot=context.request.get(url+'/api/state').json()
            reads=[]
            page.on('request',lambda r:reads.append(r.url) if '/api/assignment-session' in r.url else None)
            page.locator('#import-file').set_input_files({'name':'snapshot.json','mimeType':'application/json','buffer':json.dumps(snapshot).encode()})
            page.locator('[data-area="agents"]').click()
            canonical_assignment.click()
            expect(page.get_by_text('Open the live host dashboard to attach to or end a session.',exact=True)).to_be_visible()
            assert not reads
            passed('offline read-only')
            assert not errors,errors
            summary['status']='passed';summary['page_errors']=errors
            print(json.dumps({'status':'passed','elapsed_seconds':round(time.monotonic()-started,2),'cases':summary['cases'],'captures':summary['captures'],'boundary':summary['boundary'],'receipt':str(receipt)}))
        except BaseException as exc:
            summary['error']=repr(exc)
            try: summary['page_errors']=errors
            except Exception: summary['page_errors']=[]
            raise
        finally:context.close()
finally:
    try:
        write_receipt()
    finally:
        fixture.terminate()
        try:fixture.wait(timeout=10)
        except subprocess.TimeoutExpired:fixture.kill();fixture.wait()
