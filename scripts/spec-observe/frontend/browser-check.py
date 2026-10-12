# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Run the dashboard's browser regression journey with isolated storage and fake workers.
Usage: uv run --script scripts/spec-observe/frontend/browser-check.py
Requires the uishot warm browser on localhost:9222; no provider or live-store writes.
"""
import json, os, re, select, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parent
evidence_dir=Path(os.environ.get('SENTINEL_EVIDENCE_DIR','/tmp/sentinel-browser-evidence'))
browser_evidence=evidence_dir/'browser'
browser_evidence.mkdir(parents=True,exist_ok=True)
uishot=Path.home()/'.agents/skills/uishot/scripts/uishot'
summary={'status':'failed','scenarios':[],'captures':[],'page_errors':[]}
fixture=None
url=os.environ.get('SENTINEL_FIXTURE_URL')
if not url:
    fixture=subprocess.Popen(['node',str(root/'browser-fixture.mjs')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    if not select.select([fixture.stdout],[],[],10)[0]:
        fixture.terminate()
        raise RuntimeError('Fixture did not start within 10 seconds')
    line=fixture.stdout.readline()
    if not line:
        raise RuntimeError(fixture.stderr.read())
    receipt=json.loads(line)
    url=receipt['url']

try:
 with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    context=browser.new_context(viewport={'width':1440,'height':1100},device_scale_factor=1)
    try:
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        def control(action=None,value=None):
            suffix='' if action is None else f'?action={action}&value={str(value).lower()}'
            response=context.request.get(url+'/__fixture/control'+suffix)
            assert response.ok
            return response.json()
        def posts(name): return [p for p in control()['posts'] if p['name']==name]
        def assert_horizontal_fits(label):
            metrics=page.evaluate("""() => {
              const measure = el => el ? {scrollWidth: el.scrollWidth, clientWidth: el.clientWidth} : null;
              return {document: measure(document.documentElement), workspace: measure(document.querySelector('.workspace')), detailBody: measure(document.querySelector('.detail-body')), tableWrap: measure(document.querySelector('.table-wrap'))};
            }""")
            for name,metric in metrics.items():
                if metric: assert metric['scrollWidth']<=metric['clientWidth'], f'{label}: {name} horizontal overflow {metric}'
        def assert_controls_min_44(label):
            below=[]
            for selector in ['.workspace .text-link','.workspace .record','.workspace .ds-btn','.head-actions .ds-btn','.scope select','.nav-item']:
                for element in page.locator(selector).all():
                    box=element.bounding_box()
                    if box and box['width']<44 and box['height']<44: below.append({'selector':selector,'box':box})
            assert not below, f'{label}: workspace controls below 44px {below}'
        def capture_playwright(name,width,height):
            page.set_viewport_size({'width':width,'height':height})
            page.wait_for_timeout(150)
            page.screenshot(path=str(browser_evidence/name))
            summary['captures'].append(str(browser_evidence/name))
        def capture_uishot(route,name,width,height,wait_for='.records'):
            assert uishot.exists(), f'uishot not found at {uishot}'
            result=subprocess.run([str(uishot),f'{url}/#{route}','--viewport',f'{width}x{height}','--wait-for',wait_for,'--out',str(browser_evidence/name)],capture_output=True,text=True)
            print((result.stdout or '').strip())
            if result.stderr: print((result.stderr or '').strip())
            assert result.returncode==0, f'uishot failed for {name}: {result.stderr or result.stdout}'
            match=re.search(r'^console_errors:\s*(\d+)\s*$',result.stdout,re.M)
            assert match, f'uishot did not report console_errors for {name}: {result.stdout}'
            assert int(match.group(1))==0, f'uishot reported console errors for {name}: {result.stdout}'

        # Healthy Workspaces: catalog facts, detail, scope filtering, focus and exact-path links.
        page.goto(url+'/#/workspaces?ws=fixture',wait_until='domcontentloaded')
        fixture_row=page.locator('[data-workspace="fixture"]')
        fixture_row.wait_for()
        expect(fixture_row).to_have_attribute('aria-pressed','true')
        expect(fixture_row).to_contain_text('1 repository')
        expect(fixture_row).to_contain_text('fixture-repo · Browser verification')
        expect(fixture_row).to_contain_text('1 context reference')
        page.locator('main').get_by_text('kit.yaml · version 1').wait_for()
        expect(page.locator('.scope select')).to_have_value('fixture')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        expect(page.locator('main')).to_contain_text('Browser verification')
        expect(page.locator('main')).to_contain_text('context/project-context.md')
        expect(page.locator('main')).to_contain_text('1 saved brief')
        expect(page.locator('main')).to_contain_text('1 saved note')
        find=page.locator('#find-record')
        find.fill('Other')
        expect(page.locator('[data-workspace="fixture"]')).to_have_count(0)
        expect(page.locator('[data-workspace="other"]')).to_be_visible()
        expect(page.locator('main')).to_contain_text('fixture-repo')
        find.fill('')
        expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
        other=page.locator('[data-workspace="other"]')
        other.focus();page.keyboard.press('Enter')
        expect(page.locator('.scope select')).to_have_value('other')
        expect(page.locator('main')).to_contain_text('Other workspace')
        expect(other).to_have_attribute('aria-pressed','true')
        expect(other).to_be_focused()
        fixture_row=page.locator('[data-workspace="fixture"]')
        fixture_row.focus();page.keyboard.press('Enter')
        expect(fixture_row).to_have_attribute('aria-pressed','true')
        expect(fixture_row).to_be_focused()
        expect(page.locator('.scope select')).to_have_value('fixture')
        page.locator('main').get_by_text('kit.yaml · version 1').wait_for()
        for width,height in ((1280,860),(1600,900)):
            page.set_viewport_size({'width':width,'height':height})
            page.wait_for_timeout(150)
            assert_horizontal_fits(f'workspaces {width}')
            assert_controls_min_44(f'workspaces {width}')
            capture_playwright(f'workspaces-ideal-{width}.png',width,height)
            capture_uishot('/workspaces?ws=fixture',f'workspaces-ideal-{width}.png',width,height,'.object-head')
        page.set_viewport_size({'width':1280,'height':860})
        page.get_by_role('button',name='Open workspace',exact=True).click()
        expect(page).to_have_url(__import__('re').compile(r'#/conversations\?ws=fixture'))
        page.goto(url+'/#/workspaces?ws=fixture',wait_until='domcontentloaded')
        page.get_by_role('button',name='Open files',exact=True).click()
        expect(page).to_have_url(__import__('re').compile(r'#/files\?ws=fixture'))
        page.goto(url+'/#/workspaces?ws=fixture',wait_until='domcontentloaded')
        page.get_by_role('button',name='context/project-context.md',exact=True).click()
        expect(page).to_have_url(__import__('re').compile(r'#/files\?ws=fixture&source=workspace&path=context%2Fproject-context\.md'))
        expect(page.locator('#file-content')).to_contain_text('Browser context note')
        page.goto(url+'/#/workspaces?ws=fixture',wait_until='domcontentloaded')
        notes_rows=page.locator('.rows').filter(has=page.get_by_role('button',name='browser.md',exact=True)).last
        notes_rows.get_by_role('button',name='browser.md',exact=True).click()
        expect(page).to_have_url(__import__('re').compile(r'#/files\?ws=fixture&source=workspace&path=notes%2Fbrowser\.md'))
        expect(page.locator('#file-content')).to_contain_text('A recorded note')
        page.evaluate("location.hash='#/files?ws=fixture&source=workspace&path=notes%2F'")
        expect(page).to_have_url(__import__('re').compile(r'#/files\?ws=fixture&source=workspace&path=notes%2F'))
        expect(page.locator('.file-viewer')).to_have_count(0)
        expect(page.locator('.files-list')).to_contain_text('browser.md')
        page.goto(url+'/#/workspaces?ws=fixture',wait_until='domcontentloaded')
        page.get_by_role('button',name='Notes',exact=True).click()
        expect(page).to_have_url(__import__('re').compile(r'#/files\?ws=fixture&source=workspace&path=notes%2F'))
        listing=page.locator('.files-list')
        expect(listing).to_contain_text('browser.md')
        assert 'spec.md' not in listing.inner_text()
        page.goto(url+'/#/workspaces?ws=fixture',wait_until='domcontentloaded')
        page.get_by_role('button',name='Designs',exact=True).click()
        expect(page).to_have_url(__import__('re').compile(r'#/designs\?ws=fixture'))
        expect(page.locator('#designs-heading')).to_be_visible()
        expect(page.locator('main')).to_contain_text('Design fixture')

        # Picker: same searchable directory, choose pushes ws, imported never reads workspace APIs.
        page.goto(url+'/#/conversations',wait_until='domcontentloaded')
        page.locator('[data-workspace="fixture"]').wait_for()
        page.locator('#find-record').fill('Browser fixture')
        expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
        expect(page.locator('[data-workspace="other"]')).to_have_count(0)
        page.locator('[data-workspace="fixture"]').click()
        expect(page).to_have_url(__import__('re').compile(r'#/conversations\?ws=fixture'))
        page.locator('#thread-draft').wait_for()
        page.goto(url+'/#/conversations',wait_until='domcontentloaded')
        page.locator('[data-workspace="fixture"]').wait_for()
        assert_horizontal_fits('picker 1280')
        assert_controls_min_44('picker 1280')
        capture_playwright('workspace-picker-1280.png',1280,860)
        capture_uishot('/conversations','workspace-picker-1280.png',1280,860)
        workspace_reads=[]
        def track_workspace_request(request):
            if '/api/workspace' in request.url: workspace_reads.append(request.url)
        page.on('request',track_workspace_request)
        imported={'action_token':'untrusted-import-token','observers':[]}
        page.locator('#import-file').set_input_files({'name':'snapshot.json','mimeType':'application/json','buffer':json.dumps(imported).encode()})
        expect(page.locator('#connection-status')).to_contain_text('Imported snapshot')
        page.locator('[data-area="conversations"]').click()
        expect(page.locator('main')).to_contain_text('A live dashboard is required')
        page.wait_for_timeout(300)
        assert workspace_reads==[],f'workspace APIs read while imported: {workspace_reads}'
        page.remove_listener('request',track_workspace_request)

        page.goto(url,wait_until='domcontentloaded')
        page.locator('[data-key]').first.wait_for()
        page.locator('[data-key]').first.click()
        expect(page.locator('main')).to_contain_text('Keep editors stable')
        expect(page.locator('main')).to_contain_text('Step durations')
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
        expect(page.locator('#completion-help')).to_contain_text("host's local dashboard")
        page.get_by_role('button',name='spec.md',exact=True).click()
        evidence=page.locator('#file-content')
        expect(evidence).to_contain_text('Browser specification')
        expect(evidence.locator('a')).to_have_attribute('href',__import__('re').compile(r'^/package-view/.+/linked.md$'))
        assert evidence.locator('script').count()==0
        page.get_by_role('button',name='work-tour.html',exact=True).click()
        expect(page.frame_locator('iframe[title="work-tour.html"]').locator('h1')).to_have_text('Isolated work tour')
        assert page.locator('iframe[title="work-tour.html"]').get_attribute('sandbox')=='allow-scripts'
        page.get_by_role('button',name='Completed',exact=True).click()
        page.locator('[data-key]').first.click()
        expect(page.locator('main')).to_contain_text('PR merged')
        end_posts_before=len(posts('endSession'))
        page.locator('[data-area="agents"]').click()
        page.locator('[data-assignment-key]').first.click()
        expect(page.locator('main')).to_contain_text('Execution')
        expect(page.locator('main')).to_contain_text('Lifecycle')
        expect(page.get_by_role('button',name='Refresh session',exact=True)).to_be_visible()
        expect(page.locator('dialog[open]')).to_have_count(0)
        assert len(posts('endSession'))==end_posts_before,'viewing an agent ended a session'
        page.locator('[data-area="epics"]').click()
        page.locator('[data-epic]').first.click()
        expect(page.locator('main')).to_contain_text('Demo epic')
        expect(page.locator('main')).to_contain_text('Epic members')
        page.goto(url+'/#/files?ws=fixture&source=workspace&path=notes%2Fbrowser.md',wait_until='domcontentloaded')
        expect(page.locator('#file-content')).to_contain_text('A recorded note')
        page.goto(url+'/#/designs?ws=fixture',wait_until='domcontentloaded')
        page.get_by_role('button',name='Design fixture',exact=True).click()
        expect(page.locator('.design-viewer')).to_contain_text('Screen 1')
        page.get_by_role('button',name='1280px',exact=True).click()
        expect(page.locator('.design-viewer iframe')).to_have_attribute('style',__import__('re').compile('width: 1280px'))
        page.get_by_role('button',name='Next',exact=True).click()
        expect(page.locator('.design-viewer')).to_contain_text('Screen 2')
        page.get_by_role('button',name='Previous',exact=True).click()
        expect(page.locator('.design-viewer')).to_contain_text('Screen 1')
        page.goto(url+'/#/conversations?ws=fixture',wait_until='domcontentloaded')
        draft=page.locator('#thread-draft')
        draft.wait_for()
        draft.fill('A message edited in the middle')
        draft.focus()
        draft.evaluate('(el)=>el.setSelectionRange(10,10)')
        control('delta')
        expect(page.get_by_role('log',name='Thread transcript')).to_contain_text('Streamed reply')
        page.wait_for_timeout(6100)  # Cross a real 5-second poll and multiple SSE state frames.
        assert draft.evaluate('(el)=>el.selectionStart')==10
        assert draft.evaluate('(el)=>el.selectionEnd')==10
        expect(draft).to_be_focused()
        expect(draft).to_have_value('A message edited in the middle')
        page.keyboard.type('X')
        expect(draft).to_have_value('A message Xedited in the middle')
        brief=page.locator('#thread-brief-content');title=page.locator('#thread-brief-title')
        title.fill('Browser brief');brief.fill('First draft')
        brief.focus();brief.evaluate('(el)=>el.setSelectionRange(3,5)')
        page.wait_for_timeout(5200)
        assert brief.evaluate('(el)=>[el.selectionStart,el.selectionEnd]')==[3,5]
        expect(brief).to_be_focused()
        control('delay-brief',True)
        page.locator('[data-thread-brief-save]').click()
        brief.fill('New edit while saving')
        expect(page.locator('[data-thread-preview]')).to_be_disabled()
        expect(page.locator('#thread-handoff-status')).to_be_visible()
        expect(page.locator('#thread-handoff-status')).to_contain_text('editor has unsaved changes')
        expect(brief).to_have_value('New edit while saving')
        control('delay-brief',False)
        page.locator('[data-thread-brief-save]').click()
        expect(page.locator('[data-thread-preview]')).to_be_enabled()
        page.locator('[data-thread-preview]').click()
        expect(page.locator('#thread-assignment-launch')).to_be_enabled()
        first_digest=page.locator('#thread-preview .thread-facts > div').filter(has_text='Contract digest').locator('dd').inner_text()
        expect(page.locator('#thread-preview')).to_contain_text('Contract digest')
        page.locator('#thread-assignment-launch').click()
        expect(page.locator('#thread-assignment-launch')).to_be_disabled()
        expect(page.locator('#thread-preview')).to_contain_text('Re-preview required')
        assert posts('launchAssignment')[-1]['input']['expectedDigest']==first_digest
        control('stale-launch',False)
        page.locator('[data-thread-preview]').click()
        expect(page.locator('#thread-assignment-launch')).to_be_enabled()
        page.locator('#thread-assignment-launch').click()
        expect(page.locator('#thread-result')).to_contain_text('Live')
        before_send=len(posts('send'))
        page.locator('[data-thread-discuss]').click()
        expect(draft).to_have_value(__import__('re').compile('Discuss assignment'))
        assert len(posts('send'))==before_send
        control('fail-send',True)
        draft.fill('Retry this message')
        page.locator('#thread-send').click()
        expect(page.locator('[role="alert"]')).to_contain_text('Discussion service unavailable')
        expect(draft).to_have_value('Retry this message')
        first=posts('send')[-1]['input']['id']
        control('fail-send',False)
        page.locator('#thread-send').click()
        expect(draft).to_have_value('')
        assert posts('send')[-1]['input']['id']==first
        control('delay-send',True)
        draft.fill('Submitted before thread change')
        page.locator('#thread-send').click()
        page.get_by_role('button',name=__import__('re').compile('Discussion two')).click()
        draft.fill('New thread draft')
        page.wait_for_timeout(1000)
        expect(draft).to_have_value('New thread draft')
        control('delay-send',False)
        page.get_by_role('button',name=__import__('re').compile('Discussion one')).click()
        control('attention')
        page.wait_for_timeout(1100)
        expect(page.locator('#thread-stop')).to_be_visible()
        page.locator('#thread-stop').click()
        expect(page.locator('#thread-resume')).to_be_visible()
        page.locator('#thread-resume').click()
        control('queue')
        page.wait_for_timeout(1000)
        page.locator('[data-thread-discard]').click()
        expect(page.get_by_text('Uncertain message',exact=True)).to_have_count(0)
        control('clear-attention')
        page.locator('[data-thread-older]').click()
        expect(page.get_by_role('log',name='Thread transcript')).to_contain_text('Older message')
        page.locator('#thread-create').click()
        expect(page.locator('#thread-create')).to_be_enabled()
        expect(page.locator('#threads-section')).to_contain_text('New thread')
        page.locator('#threads-section').scroll_into_view_if_needed()
        page.screenshot(path=str(browser_evidence/'sentinel-solid-threads.png'))
        page.locator('.scope select').select_option('other')
        expect(page.locator('#threads-section')).to_contain_text('No threads yet')
        assert page.locator('#thread-draft').count()==0
        page.locator('.scope select').select_option('fixture')
        page.locator('#thread-draft').wait_for()
        before_import=len(control()['posts'])
        imported={'action_token':'untrusted-import-token','observers':[{'observer_id':'imported','state':'unknown','snapshot':{'runs':[{'workspace':'imported','package':'/imported/example','execution':'running','assignment_id':'imported-run','is_current_assignment':True,'coverage':{'state':'complete','reasons':[]},'activity':'Imported activity'}]}}]}
        page.locator('#import-file').set_input_files({'name':'snapshot.json','mimeType':'application/json','buffer':json.dumps(imported).encode()})
        expect(page.locator('#connection-status')).to_contain_text('Imported snapshot')
        page.locator('[data-area="specs"]').click()
        page.get_by_role('button',name='Active',exact=True).click()
        page.locator('[data-key]').first.click()
        expect(page.locator('main')).to_contain_text('Imported activity')
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
        assert len(control()['posts'])==before_import
        control('local',True)
        page.locator('#refresh-button').click()
        expect(page.locator('#connection-status')).to_contain_text('Monitor connected')
        page.get_by_role('button',name='Active',exact=True).click()
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
        page.get_by_role('button',name='Mark complete',exact=True).click()
        expect(page.locator('#completion-dialog')).to_be_visible()
        page.locator('#completion-dialog').get_by_role('button',name='Mark complete',exact=True).click()
        expect(page.locator('#completion-dialog')).not_to_be_visible()
        page.get_by_role('button',name='Completed',exact=True).click()
        expect(page.locator('main')).to_contain_text('Marked complete')
        assert errors==[],errors
        summary.update({'status':'passed','scenarios':['healthy workspaces directory, detail, scope search and focus','workspace route actions and exact-path files','workspace picker and imported live requirement','package filters/files/sandbox/relative Markdown','agent execution and lifecycle','epic membership','workspace files and design navigation','message and brief cursor through polling/SSE','in-flight brief edits','stale preview refusal and reviewed launch','discuss result without sending','send failure retry identity','late send across thread switch','stalled stop/resume and uncertain discard','older history','create request cleanup','workspace change','offline snapshot read-only even with supplied token','explicit local package completion'],'page_errors':errors})
        print(json.dumps({'status':'passed','scenarios':summary['scenarios'],'page_errors':errors,'screenshot':str(browser_evidence/'sentinel-solid-threads.png'),'receipt':str(evidence_dir/'step-3-browser-check.json')}))
    finally:
        context.close()
except BaseException as exc:
    summary['error']=repr(exc)
    raise
finally:
    receipt=evidence_dir/'step-3-browser-check.json'
    temporary=receipt.with_name(receipt.name+'.tmp')
    temporary.write_text(json.dumps(summary,indent=2)+'\n')
    os.replace(temporary,receipt)
    if fixture:
        fixture.terminate()
        try: fixture.wait(timeout=5)
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
