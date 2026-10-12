# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Run the dashboard's browser regression journey with isolated storage and fake workers.
Usage: uv run --script scripts/spec-observe/frontend/browser-check.py
Requires the uishot warm browser on localhost:9222; no provider or live-store writes.
"""
import json, os, select, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parent
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
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    def control(action=None,value=None):
        suffix='' if action is None else f'?action={action}&value={str(value).lower()}'
        response=context.request.get(url+'/__fixture/control'+suffix)
        assert response.ok
        return response.json()
    def posts(name): return [p for p in control()['posts'] if p['name']==name]
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
    page.locator('[data-filter="completed"]').click()
    page.locator('[data-key]').first.click()
    expect(page.locator('main')).to_contain_text('PR merged')
    page.locator('[data-mode="agents"]').click()
    page.locator('[data-assignment-key]').first.click()
    expect(page.locator('main')).to_contain_text('Execution')
    expect(page.locator('main')).to_contain_text('Lifecycle')
    assert page.locator('main button').count()==0
    page.locator('[data-mode="epics"]').click()
    page.locator('[data-epic]').first.click()
    expect(page.locator('main')).to_contain_text('Demo epic')
    expect(page.locator('main')).to_contain_text('Epic members')
    page.locator('[data-mode="workspaces"]').click()
    page.locator('[data-workspace="fixture"]').click()
    page.get_by_role('button',name='browser.md',exact=True).first.click()
    expect(page.locator('#file-content')).to_contain_text('A recorded note.')
    page.get_by_role('button',name='Design fixture',exact=True).click()
    expect(page.locator('.design-viewer')).to_contain_text('Screen 1')
    page.get_by_role('button',name='1280px',exact=True).click()
    expect(page.locator('.design-viewer iframe')).to_have_attribute('style',__import__('re').compile('width: 1280px'))
    page.get_by_role('button',name='Next',exact=True).click()
    expect(page.locator('.design-viewer')).to_contain_text('Screen 2')
    page.get_by_role('button',name='Previous',exact=True).click()
    expect(page.locator('.design-viewer')).to_contain_text('Screen 1')
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
    expect(page.get_by_text('the editor has unsaved changes',exact=False)).to_be_visible()
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
    page.screenshot(path='/tmp/sentinel-solid-threads.png')
    page.locator('[data-workspace="other"]').click()
    expect(page.locator('#threads-section')).to_contain_text('No threads yet')
    assert page.locator('#thread-draft').count()==0
    page.locator('[data-workspace="fixture"]').click()
    page.locator('#thread-draft').wait_for()
    before_import=len(control()['posts'])
    imported={'action_token':'untrusted-import-token','observers':[{'observer_id':'imported','state':'unknown','snapshot':{'runs':[{'workspace':'imported','package':'/imported/example','execution':'running','assignment_id':'imported-run','is_current_assignment':True,'coverage':{'state':'complete','reasons':[]},'activity':'Imported activity'}]}}]}
    page.locator('#import-file').set_input_files({'name':'snapshot.json','mimeType':'application/json','buffer':json.dumps(imported).encode()})
    expect(page.locator('#connection-status')).to_contain_text('Imported snapshot')
    page.locator('[data-mode="packages"]').click()
    page.locator('[data-filter="active"]').click()
    page.locator('[data-key]').first.click()
    expect(page.locator('main')).to_contain_text('Imported activity')
    expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
    assert len(control()['posts'])==before_import
    control('local',True)
    page.locator('#refresh-button').click()
    expect(page.locator('#connection-status')).to_contain_text('Monitor connected')
    page.locator('[data-filter="active"]').click()
    expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
    page.get_by_role('button',name='Mark complete',exact=True).click()
    expect(page.locator('#completion-dialog')).to_be_visible()
    page.locator('#completion-dialog').get_by_role('button',name='Mark complete',exact=True).click()
    expect(page.locator('#completion-dialog')).not_to_be_visible()
    page.locator('[data-filter="completed"]').click()
    expect(page.locator('main')).to_contain_text('Marked complete')
    assert errors==[],errors
    print(json.dumps({'status':'passed','scenarios':['package filters/files/sandbox/relative Markdown','agent execution and lifecycle','epic membership','workspace files and design navigation','message and brief cursor through polling/SSE','in-flight brief edits','stale preview refusal and reviewed launch','discuss result without sending','send failure retry identity','late send across thread switch','stalled stop/resume and uncertain discard','older history','create request cleanup','workspace change','offline snapshot read-only even with supplied token','explicit local package completion'],'page_errors':errors,'screenshot':'/tmp/sentinel-solid-threads.png'}))
    context.close();browser.close()
finally:
 if fixture:
    fixture.terminate()
    try: fixture.wait(timeout=5)
    except subprocess.TimeoutExpired: fixture.kill()
