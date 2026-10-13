# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Run the dashboard's browser regression journey with isolated storage and fake workers.
Usage: uv run --script scripts/spec-observe/frontend/browser-check.py [--case completion]
Requires the uishot warm browser on localhost:9222; no provider or live-store writes.
"""
import argparse, json, os, re, select, subprocess, time, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

class CompletionCaseComplete(Exception):
    pass

parser=argparse.ArgumentParser(description='Run the dashboard browser regression journey.')
parser.add_argument('--case',choices=['completion'])
case=parser.parse_args().case

root=Path(__file__).resolve().parent
evidence_dir=Path(os.environ.get('SENTINEL_EVIDENCE_DIR','/tmp/sentinel-browser-evidence'))
browser_evidence=evidence_dir/'browser'
browser_evidence.mkdir(parents=True,exist_ok=True)
uishot=Path.home()/'.agents/skills/uishot/scripts/uishot'
summary={'status':'failed','scenarios':[],'captures':[],'page_errors':[]}
fixture=None
receipt={}
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
        console_errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.on('console',lambda m: console_errors.append(m.text) if m.type=='error' else None)
        failed_responses=[]
        phase=None
        def record_failed_response(response):
            if response.status>=400 and response.url.startswith(url):
                path=response.url.split('?')[0]
                path=path[len(url):] if path.startswith(url) else path
                query=response.url.split('?',1)[1] if '?' in response.url else ''
                failed_responses.append({'path':path or '/','query':query,'status':response.status,'phase':phase})
        page.on('response',record_failed_response)
        completion_posts=[]
        def record_completion_request(request):
            if request.method=='POST' and request.url.endswith('/api/package-completion'):
                try: body=json.loads(request.post_data or '{}')
                except Exception: body={}
                completion_posts.append({'package':body.get('package'),'phase':phase})
        page.on('request',record_completion_request)
        def control(action=None,value=None):
            suffix='' if action is None else f'?action={action}&value={str(value).lower()}'
            response=context.request.get(url+'/__fixture/control'+suffix)
            assert response.ok
            return response.json()
        # The control endpoint owns package identity for both fixture entry paths.
        identity=control()
        for key in ('package','mismatchPackage','mismatchAlphaPackage'):
            assert isinstance(identity.get(key),str) and Path(identity[key]).is_absolute(), f'Missing fixture identity: {key}'
            assert key not in receipt or receipt[key]==identity[key], f'Fixture identity changed: {key}'
            receipt[key]=identity[key]
        assert len({receipt[key] for key in ('package','mismatchPackage','mismatchAlphaPackage')})==3
        def posts(name): return [p for p in control()['posts'] if p['name']==name]
        def passed(name): summary.setdefault('scenarios',[]).append(name)
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
        def capture_uishot(route,name,width,height,wait_for='.records',allow_console_errors=False):
            assert uishot.exists(), f'uishot not found at {uishot}'
            result=subprocess.run([str(uishot),f'{url}/#{route}','--viewport',f'{width}x{height}','--wait-for',wait_for,'--out',str(browser_evidence/name)],capture_output=True,text=True)
            print((result.stdout or '').strip())
            if result.stderr: print((result.stderr or '').strip())
            assert result.returncode==0, f'uishot failed for {name}: {result.stderr or result.stdout}'
            capture_path=str(browser_evidence/name)
            if capture_path not in summary['captures']: summary['captures'].append(capture_path)
            match=re.search(r'^console_errors:\s*(\d+)\s*$',result.stdout,re.M)
            assert match, f'uishot did not report console_errors for {name}: {result.stdout}'
            count=int(match.group(1))
            if count:
                assert allow_console_errors, f'uishot reported console errors for {name}: {result.stdout}'
                messages=re.findall(r'^console_error:\s*(.+)$',result.stdout,re.M)
                allowed=bool(messages) and all(re.search(r'Failed to load resource.*503',message) for message in messages)
                assert allowed, f'uishot reported unexpected console errors for {name}: {messages}'
                summary.setdefault('expected_http_errors',[]).append({'capture':name,'console_errors':count,'messages':messages})

        def boundary_snapshot():
            data=control()
            return data.get('boundaryLog',[]), data.get('active',[])
        def boundary_attempt_count(kind):
            log,_=boundary_snapshot()
            return len([e for e in log if e['kind']==kind and e['phase']=='start'])
        def boundary_active(kind):
            _,active=boundary_snapshot()
            return [e for e in active if e.get('kind')==kind]
        def wait_boundary_start(kind,baseline=0,timeout=10):
            deadline=time.monotonic()+timeout
            while time.monotonic()<deadline:
                if boundary_attempt_count(kind)>baseline: return
                page.wait_for_timeout(50)
            raise AssertionError(f'{kind} boundary start not observed after attempt {baseline}')
        def wait_boundary_settled(kind,timeout=15):
            deadline=time.monotonic()+timeout
            while time.monotonic()<deadline:
                if not boundary_active(kind): return
                page.wait_for_timeout(100)
            raise AssertionError(f'{kind} boundary did not settle: {boundary_active(kind)}')
        def reset_workspace():
            for kind in ('catalog','detail','state'): wait_boundary_settled(kind)
            control('workspace-reset')
            _,active=boundary_snapshot()
            assert active==[],f'boundary still open after reset: {active}'
        def goto_workspaces(route):
            # Force a fresh document so initial-state cases never inherit retained data
            # from a previous route; in-place interactions stay on the live page.
            page.goto('about:blank',wait_until='domcontentloaded')
            page.goto(url+'/#'+route,wait_until='domcontentloaded')
        def check_state(label):
            assert_horizontal_fits(label)
            assert_controls_min_44(label)
        def live_region_recorder():
            page.evaluate("""() => {
              window.__sentinelLive = [];
              if (window.__sentinelLiveObserver) window.__sentinelLiveObserver.disconnect();
              const region = document.querySelector('.workspace-destination [aria-live="polite"]');
              if (!region) return;
              window.__sentinelLiveObserver = new MutationObserver(() => window.__sentinelLive.push({text: region.textContent, at: Date.now()}));
              window.__sentinelLiveObserver.observe(region, {childList: true, characterData: true, subtree: true});
            }""")
        def live_announcements():
            return page.evaluate('() => window.__sentinelLive || []')
        def feedback_recorder():
            page.evaluate("""() => {
              window.__sentinelFeedback = [];
              if (window.__sentinelFeedbackObserver) window.__sentinelFeedbackObserver.disconnect();
              const record = (kind, text) => window.__sentinelFeedback.push({kind, text, at: Date.now()});
              window.__sentinelFeedbackObserver = new MutationObserver(records => {
                for (const entry of records) for (const node of entry.addedNodes) {
                  if (!(node instanceof Element)) continue;
                  if (node.matches('.skeletons') || node.querySelector('.skeletons')) record('skeleton','');
                  if (node.matches('.ds-callout') || node.querySelector('.ds-callout')) record('callout',(node.textContent||'').slice(0,120));
                  const note = node.matches('.section-note') ? node : node.querySelector('.section-note');
                  if (note) record('note', note.textContent || '');
                }
              });
              window.__sentinelFeedbackObserver.observe(document.body,{childList:true,subtree:true});
            }""")
        def feedback_additions():
            return page.evaluate('() => window.__sentinelFeedback || []')
        def assert_shell_controls_min_44(label):
            below=[]
            for selector in ['.skip','.rail .brand','.rail .nav-item','.rail-footer a','.rail-footer button','.scope select','.page-head .ds-btn']:
                for element in page.locator(selector).all():
                    if not element.is_visible(): continue
                    box=element.bounding_box()
                    if box and box['width']<44 and box['height']<44: below.append({'selector':selector,'box':box})
            assert not below,f'{label}: shell controls below 44px {below}'
        def assert_keyboard_focus_visible(label):
            observed=None
            for _ in range(20):
                page.keyboard.press('Tab')
                observed=page.evaluate("""() => {
                  const el=document.activeElement;
                  if(!el || !el.matches('.app a, .app button, .app select, .app input')) return null;
                  const style=getComputedStyle(el);
                  return {tag:el.tagName,cls:String(el.className),focusVisible:el.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth)||0};
                }""")
                if observed: break
            assert observed,f'{label}: keyboard focus never reached a shell control'
            assert observed['focusVisible'] and observed['outlineStyle'] not in ('none','') and observed['outlineWidth']>=1,f'{label}: focus not visibly styled {observed}'

        if case=='completion':
            # EV-8 completion-only journey: destination-owned dialog, authority
            # states, single-POST refusal/uncertainty and the App Done handoff.
            def capture_completion(name):
                capture_playwright('completion-'+name+'-1280.png',1280,860)
                capture_playwright('completion-'+name+'-1600.png',1600,900)
                page.set_viewport_size({'width':1280,'height':860})
            (evidence_dir/'reference').mkdir(parents=True,exist_ok=True)
            design_screens=Path(os.environ['SENTINEL_DESIGN_SCREENS']) if os.environ.get('SENTINEL_DESIGN_SCREENS') else evidence_dir.resolve().parent.parent.parent/'designs'/'app-ui'/'screens'
            for screen in ('14-spec-completion-confirm','94-spec-completion-saving','95-spec-completion-error'):
                source=design_screens/f'{screen}.html'
                if not source.exists():
                    summary.setdefault('referenceMissing',[]).append(screen)
                    continue
                for width in (1280,1600):
                    reference=context.new_page()
                    reference.set_viewport_size({'width':width,'height':800})
                    reference.goto(source.as_uri(),wait_until='domcontentloaded')
                    reference.evaluate('document.fonts.ready')
                    path=evidence_dir/'reference'/f'{screen}-{width}.png'
                    reference.screenshot(path=str(path),full_page=True)
                    reference.close()
                    summary.setdefault('referenceCaptures',[]).append(str(path))
            page.set_viewport_size({'width':1280,'height':860})
            phase='completion-authority'
            control('local',False)
            page.goto(url+'/#/specs?ws=fixture',wait_until='domcontentloaded')
            completion_row=page.locator('.records [data-key]').filter(has_text='Building the dashboard').first
            completion_row.wait_for()
            completion_row.click()
            expect(page.locator('.detail-actions')).to_contain_text('Mark complete')
            expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
            expect(page.locator('#completion-help')).to_contain_text("host's local dashboard")
            capture_completion('remote')
            passed('remote operator lacks completion authority with local-dashboard help')

            imported={'action_token':'untrusted-import-token','observers':[{'observer_id':'imported','state':'unknown','snapshot':{'runs':[{'workspace':'fixture','package':'/fixture/imported','package_ref':'fixture/imported','assignment_id':'imported-completion','execution':'running','workflow_state':'waiting-worker','is_current_assignment':True,'coverage':{'state':'complete','reasons':[]},'activity':'Imported completion run'}]}}]}
            page.locator('#import-file').set_input_files({'name':'completion-import.json','mimeType':'application/json','buffer':json.dumps(imported).encode()})
            expect(page.locator('#connection-status')).to_contain_text('Imported snapshot')
            imported_row=page.locator('.records [data-key]').filter(has_text='Imported completion run').first
            imported_row.wait_for()
            imported_row.click()
            expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
            expect(page.locator('#completion-help')).to_contain_text('Completion is available on the live dashboard')
            assert completion_posts==[],completion_posts
            passed('imported snapshot lacks completion authority')

            control('local',True)
            # The imported snapshot lives in App memory until a fresh document loads.
            page.goto('about:blank',wait_until='domcontentloaded')
            page.goto(url+'/#/specs?ws=fixture',wait_until='domcontentloaded')
            completion_row=page.locator('.records [data-key]').filter(has_text='Building the dashboard').first
            completion_row.wait_for()
            completion_row.click()
            expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()

            phase='completion-offline'
            control('state-fail',True)
            state_baseline=boundary_attempt_count('state')
            page.locator('#refresh-button').click()
            wait_boundary_start('state',state_baseline)
            wait_boundary_settled('state',timeout=10)
            expect(page.locator('main')).to_contain_text('Connection lost')
            expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
            expect(page.locator('#completion-help')).to_contain_text('Reconnect to the live dashboard')
            control('state-fail',False)
            page.locator('.list-pane').get_by_role('button',name='Retry connection',exact=True).click()
            wait_boundary_settled('state',timeout=10)
            expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
            passed('offline retained state disables completion until retry recovers')

            phase='completion-dialog'
            dialog=page.locator('#completion-dialog')
            page.get_by_role('button',name='Mark complete',exact=True).click()
            expect(dialog).to_be_visible()
            expect(dialog).to_contain_text('Mark spec complete?')
            expect(dialog.get_by_role('button',name='Keep spec active',exact=True)).to_be_focused()
            capture_completion('confirm')
            for _ in range(6):
                page.keyboard.press('Tab')
                assert page.evaluate("() => document.querySelector('#completion-dialog')?.contains(document.activeElement)===true"),'Tab left the completion dialog'
            page.keyboard.press('Escape')
            expect(dialog).not_to_be_visible()
            assert completion_posts==[],'idle dialog wrote a completion'
            passed('dialog opens with Keep spec active focus, contains Tab and closes on Escape')

            phase='completion-refused'
            page.goto(url+'/#/specs',wait_until='domcontentloaded')
            mismatch_row=page.locator('[data-key]').filter(has_text='Neighbor physical run').first
            mismatch_row.wait_for()
            mismatch_row.click()
            expect(page.locator('main')).to_contain_text('physical-kit')
            expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
            page.get_by_role('button',name='Mark complete',exact=True).click()
            expect(dialog).to_be_visible()
            posts_before=len(completion_posts)
            dialog.get_by_role('button',name='Mark complete',exact=True).click()
            expect(dialog).to_contain_text('Dashboard data unavailable')
            expect(dialog.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
            expect(dialog.get_by_role('button',name='Cancel',exact=True)).to_be_enabled()
            for _ in range(40):
                if len(completion_posts)>posts_before: break
                page.wait_for_timeout(50)
            assert len(completion_posts)==posts_before+1,(posts_before,completion_posts)
            assert completion_posts[-1]['package']==receipt['mismatchPackage'],completion_posts[-1]
            capture_completion('refused')
            dialog.get_by_role('button',name='Cancel',exact=True).click()
            expect(dialog).not_to_be_visible()
            expect(page.locator('main')).to_contain_text('physical-kit')
            assert 'Marked complete' not in page.locator('.detail-pane').inner_text()
            assert len(completion_posts)==posts_before+1
            passed('server refusal keeps the dialog with the message and an explicit retry')

            phase='completion-uncertain'
            def abort_completion(route):
                route.abort('timedout')
            page.route('**/api/package-completion',abort_completion)
            page.get_by_role('button',name='Mark complete',exact=True).click()
            expect(dialog).to_be_visible()
            posts_before=len(completion_posts)
            dialog.get_by_role('button',name='Mark complete',exact=True).click()
            expect(dialog).to_contain_text('Completion is unconfirmed')
            expect(dialog.get_by_role('button',name='Refresh state',exact=True)).to_be_visible()
            expect(dialog.get_by_role('button',name='Return to spec',exact=True)).to_be_visible()
            assert dialog.get_by_role('button',name='Mark complete',exact=True).count()==0,'uncertain state offered a retry'
            for _ in range(40):
                if len(completion_posts)>posts_before: break
                page.wait_for_timeout(50)
            assert len(completion_posts)==posts_before+1,(posts_before,completion_posts)
            capture_completion('uncertain')
            state_baseline=boundary_attempt_count('state')
            dialog.get_by_role('button',name='Refresh state',exact=True).click()
            expect(dialog).not_to_be_visible()
            wait_boundary_start('state',state_baseline)
            wait_boundary_settled('state',timeout=10)
            assert len(completion_posts)==posts_before+1,'uncertain refresh posted again'
            page.unroute('**/api/package-completion',abort_completion)
            passed('aborted completion shows Refresh state/Return to spec with no second POST')

            phase='completion-handoff'
            handoff={'absent':False}
            def doctor_state(route):
                if not handoff['absent']:
                    route.continue_()
                    return
                response=route.fetch()
                value=response.json()
                for observer in value.get('observers',[]):
                    snapshot=observer.get('snapshot') or {}
                    if snapshot.get('workspace')!='fixture': continue
                    snapshot['recently_completed']=[entry for entry in snapshot.get('recently_completed',[]) if entry.get('package')!=receipt['package']]
                    snapshot.setdefault('recently_completed',[]).append({'workspace':'fixture','package':'/fixture/specs/unrelated-done','package_ref':'fixture/unrelated-done','assignment_id':'unrelated-done','execution':'completed','workflow_state':'complete','is_current_assignment':False,'completion_basis':'manual','completed_at':'2026-10-12T12:00:00.000Z','coverage':{'state':'complete','reasons':[]},'activity':'Unrelated completion'})
                route.fulfill(status=response.status,headers={'content-type':'application/json'},body=json.dumps(value))
            page.route('**/api/state**',doctor_state)
            handoff['absent']=True
            page.goto(url+'/#/specs?ws=fixture',wait_until='domcontentloaded')
            completion_row=page.locator('.records [data-key]').filter(has_text='Building the dashboard').first
            completion_row.wait_for()
            completion_row.click()
            page.locator('#find-record').fill('waiting-worker')
            expect(page.locator('.records [data-key]').filter(has_text='Building the dashboard')).to_have_count(1)
            completion_row.click()
            expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
            held={'route':None,'package':None,'token':None}
            def hold_completion(route):
                held['route']=route
                held['package']=json.loads(route.request.post_data or '{}').get('package')
                held['token']=route.request.headers.get('x-sentinel-token')
            page.route('**/api/package-completion',hold_completion)
            page.get_by_role('button',name='Mark complete',exact=True).click()
            expect(dialog).to_be_visible()
            expect(dialog.get_by_role('button',name='Keep spec active',exact=True)).to_be_focused()
            posts_before=len(completion_posts)
            dialog.get_by_role('button',name='Mark complete',exact=True).click()
            expect(dialog.get_by_role('button',name='Recording completion…',exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button',name='Keep spec active',exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(dialog).to_be_visible()
            for _ in range(40):
                if held['route']: break
                page.wait_for_timeout(25)
            assert held['route'],'completion POST was not intercepted'
            token=context.request.get(url+'/api/state').json().get('action_token')
            assert held['package']==receipt['package'],held
            assert held['token']==token,{'sent':held['token'],'expected':token}
            assert len(completion_posts)==posts_before+1,completion_posts
            capture_completion('saving')
            held['route'].continue_()
            expect(dialog).not_to_be_visible()
            page.unroute('**/api/package-completion',hold_completion)
            hash_value=page.evaluate('location.hash')
            assert 'q=' not in hash_value,hash_value
            assert 'filter=completed' in hash_value,hash_value
            expected_key=json.dumps(['fixture',receipt['package'],'recent-completion'],separators=(',',':'))
            selected_id=urllib.parse.parse_qs(hash_value.split('?',1)[1]).get('id',[None])[0]
            assert selected_id==expected_key,{'selected':selected_id,'expected':expected_key}
            expect(page.locator('.records [data-key]')).to_have_count(1)
            unrelated_key=json.dumps(['fixture','/fixture/specs/unrelated-done','recent-completion'],separators=(',',':'))
            unrelated=page.locator('.records [data-key]').first
            assert unrelated.get_attribute('data-key')==unrelated_key,unrelated.get_attribute('data-key')
            expect(unrelated).to_contain_text('unrelated-done')
            expect(unrelated).to_contain_text('Marked complete')
            assert 'selected' not in (unrelated.get_attribute('class') or ''),'unrelated Done row stole the completion selection'
            expect(page.locator('.records [data-key].selected')).to_have_count(0)
            assert 'Unrelated completion' not in page.locator('.detail-pane').inner_text()
            assert len(completion_posts)==posts_before+1,'handoff posted more than once'
            handoff['absent']=False
            expected_row=page.locator('.records [data-key]').filter(has_text='Marked complete').first
            expect(expected_row).to_be_visible(timeout=12000)
            expect(expected_row).to_have_attribute('aria-pressed','true')
            focused=page.evaluate("() => document.activeElement?.closest('[data-key]')?.getAttribute('data-key') ?? null")
            assert focused==expected_key,{'focused':focused,'expected':expected_key}
            expect(page.locator('.detail-pane')).to_contain_text('Marked complete')
            expect(page.get_by_role('button',name='Done',exact=True)).to_have_attribute('aria-pressed','true')
            capture_completion('done')
            page.unroute('**/api/state**',doctor_state)
            passed('search-cleared exact Done handoff focuses the observed completion without stealing an unrelated row')

            summary['status']='passed'
            summary['page_errors']=errors
            summary['console_errors']=console_errors
            summary['expected_http_errors']=[{'path':entry['path'],'status':entry['status'],'phase':entry['phase']} for entry in failed_responses]
            raise CompletionCaseComplete()

        # Step 4 controlled Workspaces states, all at 1280x860 with resets before/after each case.
        page.set_viewport_size({'width':1280,'height':860})
        phase='state-errors'

        # (1) Empty directory states: missing_projects, then empty.
        reset_workspace()
        control('catalog-mode','missing_projects')
        goto_workspaces('/workspaces')
        expect(page.locator('.records')).to_contain_text('No workspaces recorded')
        expect(page.locator('main')).to_contain_text('Workspace storage needs setup')
        expect(page.locator('main')).to_contain_text('projects')
        assert page.get_by_role('button',name=re.compile('Create')).count()==0
        check_state('workspaces empty')
        capture_playwright('workspaces-empty-1280.png',1280,860)
        capture_uishot('/workspaces','workspaces-empty-1280.png',1280,860)
        control('catalog-mode','empty')
        goto_workspaces('/workspaces')
        expect(page.locator('.records')).to_contain_text('No workspaces recorded')
        assert 'No matching workspaces' not in page.locator('.records').inner_text()
        reset_workspace()
        passed('workspaces empty')

        # (2) No-match with Clear filters, plus retained selected detail when query excludes.
        reset_workspace()
        goto_workspaces('/workspaces?q=no-such-item')
        expect(page.locator('.records')).to_contain_text('No matching workspaces')
        expect(page.locator('.records')).to_contain_text('no-such-item')
        check_state('workspaces no-match')
        capture_playwright('workspaces-no-match-1280.png',1280,860)
        capture_uishot('/workspaces?q=no-such-item','workspaces-no-match-1280.png',1280,860)
        page.get_by_role('button',name='Clear filters',exact=True).click()
        expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
        assert 'q=' not in page.evaluate('location.hash')
        goto_workspaces('/workspaces?q=no-such-item&ws=fixture')
        expect(page.locator('.records')).to_contain_text('No matching workspaces')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        reset_workspace()
        passed('workspaces no-match')

        # (3) Initial delayed loading: no skeleton before 300ms, four sections after, no action bar.
        reset_workspace()
        control('catalog-delay-ms',1200)
        control('detail-delay-ms',1200)
        started=time.monotonic()
        catalog_baseline=boundary_attempt_count('catalog')
        goto_workspaces('/workspaces?ws=fixture')
        page.wait_for_timeout(150)
        assert page.locator('.skeletons').count()==0,'skeleton rendered before 300ms'
        assert 'Reading workspaces' not in page.locator('.records').inner_text()
        wait_boundary_start('catalog',catalog_baseline)
        page.locator('.skeletons').first.wait_for(timeout=5000)
        elapsed=time.monotonic()-started
        assert elapsed>=0.3,f'skeleton appeared after {elapsed:.2f}s'
        for heading in ('Repositories','Registered context','Workspace material','Workspace kit'):
            expect(page.locator('.detail-body')).to_contain_text(heading)
        assert page.get_by_role('button',name='Open workspace',exact=True).count()==0
        assert 'Available' not in page.locator('main .detail-body').inner_text()
        check_state('workspaces loading')
        capture_playwright('workspaces-loading-1280.png',1280,860)
        summary.setdefault('timings',{})['loading_skeleton_seconds']=round(elapsed,3)
        reset_workspace()
        control('catalog-delay-ms',1200)
        goto_workspaces('/workspaces')
        page.wait_for_timeout(450)
        expect(page.locator('.detail-body')).to_contain_text('Repositories')
        expect(page.locator('.detail-body')).to_contain_text('Workspace kit')
        reset_workspace()
        passed('workspaces loading')

        # (4a) Fresh scoped detail failure keeps identity/search; retry routes detail.
        reset_workspace()
        detail_baseline=boundary_attempt_count('detail')
        control('detail-fail',True)
        goto_workspaces('/workspaces?ws=fixture&q=Browser')
        wait_boundary_start('detail',detail_baseline)
        wait_boundary_settled('detail',timeout=10)
        expect(page.locator('#find-record')).to_have_value('Browser')
        expect(page.locator('.scope select')).to_have_value('fixture')
        expect(page.locator('main')).to_contain_text('Workspace could not be read')
        expect(page.locator('main')).to_contain_text('Not confirmed')
        expect(page.get_by_role('button',name='Retry workspace',exact=True)).to_be_visible()
        assert 'Connection unavailable' not in page.locator('main').inner_text()
        assert 'No workspaces recorded' not in page.locator('.records').inner_text()
        check_state('workspaces error')
        capture_playwright('workspaces-error-1280.png',1280,860)
        capture_uishot('/workspaces?ws=fixture&q=Browser','workspaces-error-1280.png',1280,860,wait_for='.detail-body',allow_console_errors=True)
        control('detail-fail',False)
        page.get_by_role('button',name='Retry workspace',exact=True).click()
        expect(page.locator('main')).to_contain_text('fixture-repo')
        reset_workspace()
        passed('workspaces detail error')

        # (4b) Catalog failure without retained catalog: retry catalog recovers.
        reset_workspace()
        catalog_baseline=boundary_attempt_count('catalog')
        control('catalog-fail',True)
        goto_workspaces('/workspaces?ws=fixture')
        wait_boundary_start('catalog',catalog_baseline)
        wait_boundary_settled('catalog',timeout=10)
        expect(page.locator('.records')).to_contain_text('Workspaces could not be read')
        expect(page.locator('main')).to_contain_text('Workspace could not be read')
        control('catalog-fail',False)
        page.get_by_role('button',name='Retry',exact=True).first.click()
        expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
        reset_workspace()
        passed('workspaces catalog error')

        # (4c) Loaded catalog retained through failed revalidation; detail failure retries detail.
        reset_workspace()
        goto_workspaces('/workspaces?ws=fixture')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        catalog_baseline=boundary_attempt_count('catalog')
        control('catalog-fail',True)
        page.get_by_role('button',name='Refresh workspaces',exact=True).click()
        wait_boundary_start('catalog',catalog_baseline)
        wait_boundary_settled('catalog',timeout=10)
        expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
        expect(page.locator('.records')).to_contain_text('Workspaces could not be read')
        control('catalog-fail',False)
        page.get_by_role('button',name='Retry',exact=True).first.click()
        page.wait_for_timeout(400)
        catalog_baseline=boundary_attempt_count('catalog')
        detail_baseline=boundary_attempt_count('detail')
        control('detail-fail',True)
        page.get_by_role('button',name='Refresh workspaces',exact=True).click()
        wait_boundary_start('catalog',catalog_baseline)
        wait_boundary_start('detail',detail_baseline)
        wait_boundary_settled('catalog',timeout=10)
        wait_boundary_settled('detail',timeout=10)
        expect(page.locator('main')).to_contain_text('fixture-repo')
        expect(page.locator('main')).to_contain_text('Workspace could not be read')
        control('detail-fail',False)
        page.get_by_role('button',name='Retry workspace',exact=True).click()
        expect(page.get_by_role('button',name='Open workspace',exact=True)).to_be_visible()
        reset_workspace()
        passed('workspaces retained revalidation')

        # (5) Partial catalog mode: missing repo, outside-root context, invalid kit, real material.
        reset_workspace()
        control('catalog-mode','partial')
        goto_workspaces('/workspaces?ws=fixture')
        expect(page.locator('main')).to_contain_text('fixture-missing')
        expect(page.locator('main')).to_contain_text('outside-context.md')
        assert page.get_by_role('button',name=re.compile('outside-context')).count()==0
        expect(page.locator('main')).to_contain_text('Workspace coverage incomplete')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        expect(page.locator('main')).to_contain_text('1 saved brief')
        expect(page.get_by_role('button',name='Open workspace',exact=True)).to_be_visible()
        check_state('workspaces partial')
        capture_playwright('workspaces-partial-1280.png',1280,860)
        capture_uishot('/workspaces?ws=fixture','workspaces-partial-1280.png',1280,860,wait_for='.object-head')
        reset_workspace()
        passed('workspaces partial')

        # (6) Offline retained content via failed state refresh; retry recovers.
        reset_workspace()
        goto_workspaces('/workspaces?ws=fixture')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        state_baseline=boundary_attempt_count('state')
        control('state-fail',True)
        page.locator('#refresh-button').click()
        wait_boundary_start('state',state_baseline)
        wait_boundary_settled('state',timeout=10)
        expect(page.locator('main')).to_contain_text('Connection unavailable')
        expect(page.get_by_role('button',name='Retry connection',exact=True)).to_have_count(1)
        expect(page.locator('main')).to_contain_text('fixture-repo')
        expect(page.locator('main')).to_contain_text('1 saved brief')
        assert page.locator('main .detail-actions .ds-btn--primary').count()==0
        check_state('workspaces offline')
        capture_playwright('workspaces-offline-1280.png',1280,860)
        control('state-fail',False)
        page.get_by_role('button',name='Retry connection',exact=True).click()
        wait_boundary_settled('state',timeout=10)
        expect(page.locator('.scope select')).to_have_value('fixture')
        reset_workspace()
        passed('workspaces offline')

        # (7) Retained revalidation timing and live-region dedupe.
        reset_workspace()
        goto_workspaces('/workspaces?ws=fixture')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        page.evaluate("() => { document.querySelector('.workspace .table-wrap').dataset.retained='1'; }")
        live_region_recorder()
        feedback_recorder()
        assert page.locator('.workspace-destination [role="status"]').count()==1
        control('detail-delay-ms',100)
        page.get_by_role('button',name='Refresh workspaces',exact=True).click()
        page.wait_for_timeout(5200)
        wait_boundary_settled('detail',timeout=10)
        assert live_announcements()==[],f'quick revalidation announced: {live_announcements()}'
        assert feedback_additions()==[],f'quick revalidation added notices: {feedback_additions()}'
        assert page.evaluate("() => document.querySelector('.workspace .table-wrap').dataset.retained")=='1'
        live_region_recorder()
        feedback_recorder()
        control('detail-delay-ms',900)
        delayed_baseline=boundary_attempt_count('detail')
        page.get_by_role('button',name='Refresh workspaces',exact=True).click()
        wait_boundary_start('detail',delayed_baseline)
        page.wait_for_timeout(150)
        assert 'Checking workspace' not in page.locator('main').inner_text()
        page.locator('.section-note',has_text='Checking workspace').wait_for(timeout=3000)
        expect(page.locator('main')).to_contain_text('fixture-repo')
        wait_boundary_settled('detail',timeout=10)
        delayed_baseline=boundary_attempt_count('detail')
        page.get_by_role('button',name='Refresh workspaces',exact=True).click()
        wait_boundary_start('detail',delayed_baseline)
        wait_boundary_settled('detail',timeout=10)
        checking=[a for a in live_announcements() if a['text'].strip()=='Checking workspace Browser fixture.']
        assert len(checking)==1,f'expected exactly one checking transition: {checking}'
        assert page.evaluate("() => document.querySelector('.workspace .table-wrap').dataset.retained")=='1'
        reset_workspace()
        passed('workspaces revalidation timing')

        # (8) Stale via real server-clock anchor; no sleep or fake browser clock.
        reset_workspace()
        goto_workspaces('/workspaces?ws=fixture')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        page.evaluate("() => { document.querySelector('.workspace .table-wrap').dataset.retained='1'; }")
        control('catalog-delay-ms',2500)
        control('detail-delay-ms',2500)
        state_baseline=boundary_attempt_count('state')
        control('state-clock-offset-ms',44000)
        page.locator('#refresh-button').click()
        wait_boundary_start('state',state_baseline)
        wait_boundary_settled('state',timeout=10)
        assert 'Last checked at' not in page.locator('main .detail-body').inner_text()
        state_baseline=boundary_attempt_count('state')
        control('state-clock-offset-ms',60000)
        page.locator('#refresh-button').click()
        wait_boundary_start('state',state_baseline)
        wait_boundary_settled('state',timeout=10)
        expect(page.locator('main')).to_contain_text('Last checked at')
        expect(page.get_by_role('button',name='Refresh workspace',exact=True)).to_be_visible()
        assert page.evaluate("() => document.querySelector('.workspace .table-wrap').dataset.retained")=='1'
        check_state('workspaces stale')
        capture_playwright('workspaces-stale-1280.png',1280,860)
        # The stale CTA only exists before the delayed read lands; click it now and let
        # the successful retained read dismiss the notice, never re-query the CTA later.
        detail_baseline=boundary_attempt_count('detail')
        page.get_by_role('button',name='Refresh workspace',exact=True).click()
        wait_boundary_start('detail',detail_baseline)
        wait_boundary_settled('catalog',timeout=10)
        wait_boundary_settled('detail',timeout=10)
        expect(page.locator('main')).not_to_contain_text('Last checked at')
        expect(page.locator('main')).to_contain_text('fixture-repo')
        assert page.evaluate("() => document.querySelector('.workspace .table-wrap').dataset.retained")=='1'
        control('state-clock-offset-ms',0)
        control('catalog-delay-ms',0)
        control('detail-delay-ms',0)
        reset_workspace()
        passed('workspaces stale')

        # (9) Scope race: delayed fixture detail must not land under other or after empty catalog.
        reset_workspace()
        control('detail-delay-id','fixture')
        control('detail-delay-ms',900)
        detail_baseline=boundary_attempt_count('detail')
        goto_workspaces('/workspaces?ws=fixture')
        wait_boundary_start('detail',detail_baseline)
        page.locator('[data-workspace="other"]').click()
        expect(page.locator('.scope select')).to_have_value('other')
        wait_boundary_settled('detail',timeout=10)
        expect(page.locator('.detail-pane .object-head h2')).to_have_text('Other workspace')
        assert 'fixture-repo' not in page.locator('.detail-pane').inner_text()
        expect(page.locator('[data-workspace="fixture"]')).to_be_visible()
        assert page.get_by_role('button',name='Retry workspace',exact=True).count()==0
        reset_workspace()
        control('detail-delay-id','fixture')
        control('detail-delay-ms',900)
        detail_baseline=boundary_attempt_count('detail')
        goto_workspaces('/workspaces?ws=fixture')
        wait_boundary_start('detail',detail_baseline)
        control('catalog-mode','empty')
        catalog_baseline=boundary_attempt_count('catalog')
        page.get_by_role('button',name='Refresh workspaces',exact=True).click()
        wait_boundary_start('catalog',catalog_baseline)
        wait_boundary_settled('catalog',timeout=10)
        wait_boundary_settled('detail',timeout=10)
        expect(page.locator('.detail-pane')).to_contain_text('Workspace storage needs setup')
        assert 'fixture-repo' not in page.locator('.detail-pane').inner_text()
        expect(page.locator('[data-workspace="fixture"]')).to_have_count(0)
        assert page.get_by_role('button',name='Retry workspace',exact=True).count()==0
        reset_workspace()
        passed('workspaces scope race')

        # Route, history, focus, typed scope identity and shell accessibility.
        phase='route-focus'
        goto_workspaces('/specs')
        for dest,label in [('specs','Specs'),('epics','Epics'),('agents','Agents'),('conversations','Conversations'),('files','Files'),('designs','Designs'),('workspaces','Workspaces')]:
            page.locator(f'[data-area="{dest}"]').click()
            expect(page.locator('h1')).to_have_text(label)
            assert page.locator('h1').count()==1
            expect(page.locator(f'[data-area="{dest}"]')).to_have_attribute('aria-current','page')
            assert_shell_controls_min_44(f'rail {dest}')
        assert_keyboard_focus_visible('rail keyboard focus')
        passed('rail reaches every destination with one heading, current state, visible focus and 44px targets')

        goto_workspaces('/specs?ws=fixture')
        fixture_run=page.locator('[data-key]').filter(has_text='Building the dashboard').first
        fixture_run.wait_for()
        fixture_run.click()
        scoped_object_hash=page.evaluate('location.hash')
        assert 'id=' in scoped_object_hash,scoped_object_hash
        page.locator('.skip').focus()
        page.keyboard.press('Enter')
        expect(page.locator('h1')).to_be_focused()
        assert page.evaluate('location.hash')==scoped_object_hash,'skip changed the route hash'
        passed('skip focuses the page heading from a scoped object route without hash mutation')

        goto_workspaces('/specs?ws=fixture')
        page.get_by_role('button',name='Done',exact=True).click()
        page.locator('[data-key]').filter(has_text='PR merged').first.click()
        specs_object_url=page.url
        page.locator('[data-area="epics"]').click()
        expect(page.locator('main')).to_contain_text('Demo epic')
        page.locator('.epic-table').get_by_role('button',name='browser',exact=True).click()
        expect(page).to_have_url(re.compile(r'#/specs\?ws=fixture&id='))
        page.go_back()
        expect(page.locator('main')).to_contain_text('Demo epic')
        page.go_back()
        assert page.url==specs_object_url,(page.url,specs_object_url)
        expect(page.get_by_role('button',name='Done',exact=True)).to_have_attribute('aria-pressed','true')
        expect(page.locator('[data-key]').filter(has_text='PR merged').first).to_have_attribute('aria-pressed','true')
        passed('spec object -> epic member spec -> Back twice restores selection and package filter')
        page.go_forward()
        expect(page).to_have_url(re.compile(r'#/epics'))
        expect(page.locator('main')).to_contain_text('Demo epic')
        page.go_forward()
        expect(page).to_have_url(re.compile(r'#/specs\?ws=fixture&id='))
        expect(page.locator('.detail-pane')).to_contain_text('Keep editors stable')
        page.go_back()
        page.go_back()
        assert page.url==specs_object_url,(page.url,specs_object_url)
        expect(page.get_by_role('button',name='Done',exact=True)).to_have_attribute('aria-pressed','true')
        expect(page.locator('[data-key]').filter(has_text='PR merged').first).to_have_attribute('aria-pressed','true')
        passed('Forward restores epic and member spec, then Back twice restores Done selection and filter')

        phase='scope-mismatch'
        goto_workspaces('/specs?ws=alpha')
        expect(page.locator('.records')).to_contain_text('alpha-kit')
        assert 'physical-kit' not in page.locator('.records').inner_text()
        goto_workspaces('/specs?ws=physical')
        expect(page.locator('.records')).to_contain_text('physical-kit')
        assert 'alpha-kit' not in page.locator('.records').inner_text()
        goto_workspaces('/agents?ws=alpha')
        expect(page.locator('.records')).to_contain_text('alpha-assignment')
        assert 'physical-assignment' not in page.locator('.records').inner_text()
        goto_workspaces('/agents?ws=physical')
        expect(page.locator('.records')).to_contain_text('physical-assignment')
        assert 'alpha-assignment' not in page.locator('.records').inner_text()
        goto_workspaces('/epics?ws=alpha')
        expect(page.locator('.records')).to_contain_text('Alpha kit epic')
        assert 'Neighbor physical epic' not in page.locator('.records').inner_text()
        goto_workspaces('/epics?ws=physical')
        expect(page.locator('.records')).to_contain_text('Neighbor physical epic')
        assert 'Alpha kit epic' not in page.locator('.records').inner_text()
        goto_workspaces('/specs')
        expect(page.locator('.records')).to_contain_text('alpha-kit')
        expect(page.locator('.records')).to_contain_text('physical-kit')
        passed('directory-mismatch scope keeps runs/epics by directory basename and assignments by kit id')

        phase='scope-clear'
        goto_workspaces('/files?ws=fixture&source=workspace&path=notes%2Fbrowser.md')
        expect(page.locator('#file-content')).to_contain_text('A recorded note')
        page.locator('.scope select').select_option('other')
        expect(page).to_have_url(re.compile(r'#/files\?ws=other$'))
        page.locator('.scope select').select_option('alpha')
        expect(page).to_have_url(re.compile(r'#/files\?ws=alpha$'))
        passed('scope change clears incompatible selection and picker selection pushes the kit id')
        phase=None

        phase=None
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
        page.set_viewport_size({'width':1600,'height':900})
        page.wait_for_timeout(150)
        assert_horizontal_fits('picker 1600')
        assert_controls_min_44('picker 1600')
        capture_playwright('workspace-picker-1600.png',1600,900)
        capture_uishot('/conversations','workspace-picker-1600.png',1600,900)
        page.set_viewport_size({'width':1280,'height':860})
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
        ideal_run=page.locator('[data-key]').filter(has_text='Building the dashboard').first
        ideal_run.wait_for()
        ideal_run.click()
        expect(page.locator('main')).to_contain_text('Keep editors stable')
        for width,height in ((1280,860),(1600,900)):
            page.set_viewport_size({'width':width,'height':height})
            page.wait_for_timeout(150)
            assert_horizontal_fits(f'specs ideal {width}')
            capture_playwright(f'specs-ideal-{width}.png',width,height)
            capture_uishot('/specs?ws=fixture',f'specs-ideal-{width}.png',width,height,'.detail-body')
        page.set_viewport_size({'width':1280,'height':860})
        passed('specs ideal captures at both desktop viewports')
        expect(page.locator('.detail-actions')).to_contain_text('Mark complete')
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
        expect(page.locator('#completion-help')).to_contain_text("host's local dashboard")
        page.get_by_role('button',name='Open spec',exact=True).click()
        page.get_by_role('button',name='Open work tour',exact=True).click()
        expect(page).to_have_url(re.compile(r'#/files\?.*path=work-tour\.html'))
        page.get_by_role('button',name='spec.md',exact=True).click()
        evidence=page.locator('#file-content')
        expect(evidence).to_contain_text('Browser specification')
        expect(evidence.locator('a')).to_have_attribute('href',__import__('re').compile(r'^/package-view/.+/linked.md$'))
        assert evidence.locator('script').count()==0
        page.get_by_role('button',name='work-tour.html',exact=True).click()
        expect(page.frame_locator('iframe[title="work-tour.html"]').locator('h1')).to_have_text('Isolated work tour')
        assert page.locator('iframe[title="work-tour.html"]').get_attribute('sandbox')=='allow-scripts'
        page.goto(url,wait_until='domcontentloaded')
        page.get_by_role('button',name='Done',exact=True).click()
        page.locator('[data-key]').first.click()
        expect(page.locator('main')).to_contain_text('PR merged')
        end_posts_before=len(posts('endSession'))
        page.locator('[data-area="agents"]').click()
        page.locator('[data-assignment-key]').filter(has_text='run-1').first.click()
        expect(page.locator('main')).to_contain_text('Execution')
        expect(page.locator('main')).to_contain_text('Lifecycle')
        expect(page.get_by_role('button',name='Refresh session',exact=True)).to_be_visible()
        expect(page.locator('dialog[open]')).to_have_count(0)
        assert len(posts('endSession'))==end_posts_before,'viewing an agent ended a session'
        page.locator('[data-area="epics"]').click()
        page.locator('[data-epic]').filter(has_text='Demo epic').first.click()
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
        phase='stale-launch'
        page.locator('#thread-assignment-launch').click()
        expect(page.locator('#thread-assignment-launch')).to_be_disabled()
        expect(page.locator('#thread-preview')).to_contain_text('Re-preview required')
        assert posts('launchAssignment')[-1]['input']['expectedDigest']==first_digest
        control('stale-launch',False)
        phase=None
        page.locator('[data-thread-preview]').click()
        expect(page.locator('#thread-assignment-launch')).to_be_enabled()
        page.locator('#thread-assignment-launch').click()
        expect(page.locator('#thread-result')).to_contain_text('Live')
        before_send=len(posts('send'))
        page.locator('[data-thread-discuss]').click()
        expect(draft).to_have_value(__import__('re').compile('Discuss assignment'))
        assert len(posts('send'))==before_send
        control('fail-send',True)
        phase='fail-send'
        draft.fill('Retry this message')
        page.locator('#thread-send').click()
        expect(page.locator('[role="alert"]')).to_contain_text('Discussion service unavailable')
        expect(draft).to_have_value('Retry this message')
        first=posts('send')[-1]['input']['id']
        control('fail-send',False)
        phase=None
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
        threads_capture=str(browser_evidence/'sentinel-solid-threads.png')
        page.screenshot(path=threads_capture)
        if threads_capture not in summary['captures']: summary['captures'].append(threads_capture)
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
        phase='import-to-live'
        page.locator('#refresh-button').click()
        expect(page.locator('#connection-status')).to_contain_text('Monitor connected')
        page.get_by_role('button',name='Active',exact=True).click()
        page.locator('[data-key]').filter(has_text='Building the dashboard').first.click()
        selected_key=json.loads(page.locator('[data-key]').filter(has_text='Building the dashboard').first.get_attribute('data-key'))
        assert selected_key[1]==receipt['package'],selected_key
        expect(page.locator('.detail-pane')).to_contain_text('Keep editors stable')
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
        phase=None
        # Retained completion failure for the intentional mismatch pair: the API refuses
        # these packages, so the dialog must stay open with a retryable error.
        phase='mismatch-completion'
        page.locator('[data-key]').filter(has_text='Neighbor physical run').first.click()
        expect(page.locator('main')).to_contain_text('physical-kit')
        page.get_by_role('button',name='Mark complete',exact=True).click()
        expect(page.locator('#completion-dialog')).to_be_visible()
        page.locator('#completion-dialog').get_by_role('button',name='Mark complete',exact=True).click()
        expect(page.locator('#completion-dialog')).to_be_visible()
        expect(page.locator('#completion-dialog')).to_contain_text('Dashboard data unavailable')
        expect(page.locator('#completion-dialog').get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
        expect(page.locator('#completion-dialog').get_by_role('button',name='Cancel',exact=True)).to_be_enabled()
        page.locator('#completion-dialog').get_by_role('button',name='Cancel',exact=True).click()
        expect(page.locator('#completion-dialog')).not_to_be_visible()
        expect(page.locator('main')).to_contain_text('physical-kit')
        assert 'Marked complete' not in page.locator('.detail-pane').inner_text()
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
        passed('retained completion failure for mismatched fixture package')
        phase=None
        # Canonical fixture package completes normally after the refused mismatch attempt.
        page.get_by_role('button',name='Active',exact=True).click()
        page.locator('[data-key]').filter(has_text='Building the dashboard').first.click()
        selected_key=json.loads(page.locator('[data-key]').filter(has_text='Building the dashboard').first.get_attribute('data-key'))
        assert selected_key[1]==receipt['package'],selected_key
        expect(page.locator('.detail-pane')).to_contain_text('Keep editors stable')
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_enabled()
        page.get_by_role('button',name='Mark complete',exact=True).click()
        expect(page.locator('#completion-dialog')).to_be_visible()
        page.locator('#completion-dialog').get_by_role('button',name='Mark complete',exact=True).click()
        expect(page.locator('#completion-dialog')).not_to_be_visible()
        page.get_by_role('button',name='Done',exact=True).click()
        expect(page.locator('main')).to_contain_text('Marked complete')
        phase=None
        allowed_reads={('/api/state',503),('/api/workspaces',503),('/api/workspace',503)}
        def package_query(query):
            values=urllib.parse.parse_qs(query).get('package')
            return values[0] if values else None
        def failure_reason(entry):
            if entry['phase']=='state-errors' and (entry['path'],entry['status']) in allowed_reads:
                return 'controlled state read failure'
            if entry['phase']=='stale-launch' and entry['path']=='/api/thread/launch-assignment' and entry['status']==409:
                return 'intentional stale-preview launch refusal'
            if entry['phase']=='fail-send' and entry['path']=='/api/thread/send' and entry['status']==503:
                return 'intentional service-closed send refusal'
            if entry['phase']=='import-to-live' and package_query(entry['query'])=='/imported/example' and ((entry['path']=='/api/package-files' and entry['status']==503) or (entry['path']=='/api/package-preview' and entry['status']==403)):
                return 'safe unpublished-package refusal during import-to-live'
            if entry['path'] in ('/api/package-files','/api/package-preview') and ((entry['path']=='/api/package-files' and entry['status']==503) or (entry['path']=='/api/package-preview' and entry['status']==403)) and package_query(entry['query']) in {receipt.get('mismatchPackage'),receipt.get('mismatchAlphaPackage')}:
                return 'expected mismatch read refusal'
            if entry['phase']=='mismatch-completion' and entry['path']=='/api/package-completion' and entry['status']==503 and any(post['phase']=='mismatch-completion' and post['package']==receipt.get('mismatchPackage') for post in completion_posts):
                return 'retained completion refusal for mismatched fixture package'
            return None
        unexpected_responses=[entry for entry in failed_responses if failure_reason(entry) is None]
        assert not unexpected_responses,unexpected_responses
        http_console=[message for message in console_errors if 'Failed to load resource' in message]
        unexpected_console=[message for message in console_errors if 'Failed to load resource' not in message]
        assert errors==[],errors
        assert unexpected_console==[],unexpected_console
        assert len(http_console)<=len(failed_responses),{'console':http_console,'responses':failed_responses}
        summary.setdefault('expected_http_errors',[])
        summary['expected_http_errors'].extend({'path':entry['path'],'status':entry['status'],'phase':entry['phase'],'reason':failure_reason(entry)} for entry in failed_responses if failure_reason(entry))
        # File asset import: built dashboard over file:, untrusted token, read-only proof.
        file_api_requests=[]
        def track_file_api(request):
            if '/api/' in request.url: file_api_requests.append(request.url)
        page.on('request',track_file_api)
        fixture_posts_before=len(control()['posts'])
        errors_before=len(errors); console_before=len(console_errors); responses_before=len(failed_responses)
        page.set_viewport_size({'width':1280,'height':860})
        dashboard_asset=(root.parent/'dashboard.html').as_uri()
        file_snapshot={'action_token':'untrusted-import-token','observers':[{'observer_id':'imported','state':'unknown','snapshot':{'runs':[{'workspace':'imported','package':'/imported/example','execution':'running','assignment_id':'file-import-run','is_current_assignment':True,'coverage':{'state':'complete','reasons':[]},'activity':'Imported activity'}]}}]}
        page.goto(dashboard_asset+'#/specs',wait_until='domcontentloaded')
        page.locator('#import-file').set_input_files({'name':'snapshot.json','mimeType':'application/json','buffer':json.dumps(file_snapshot).encode()})
        expect(page.locator('#connection-status')).to_contain_text('Imported snapshot')
        file_row=page.locator('[data-key]').filter(has_text='Imported activity').first
        file_row.wait_for()
        file_row.click()
        expect(page.locator('main')).to_contain_text('Imported activity')
        expect(page.get_by_role('button',name='Mark complete',exact=True)).to_be_disabled()
        capture_playwright('file-import-1280.png',1280,860)
        file_hash=page.evaluate('location.hash')
        page.locator('.skip').focus()
        page.keyboard.press('Enter')
        expect(page.locator('h1')).to_be_focused()
        assert page.evaluate('location.hash')==file_hash,'file-mode skip changed the route hash'
        page.locator('[data-area="workspaces"]').click()
        expect(page.locator('.records')).to_contain_text('A live dashboard is required')
        page.locator('[data-area="conversations"]').click()
        expect(page.locator('main')).to_contain_text('A live dashboard is required')
        assert file_api_requests==[],file_api_requests
        assert len(control()['posts'])==fixture_posts_before
        assert len(errors)==errors_before and len(console_errors)==console_before and len(failed_responses)==responses_before
        page.remove_listener('request',track_file_api)
        passed('file asset import is read-only with live-required workspaces/picker and no API traffic')
        summary['status']='passed'
        summary['scenarios'].extend(['healthy workspaces directory, detail, scope search and focus','workspace route actions and exact-path files','workspace picker and imported live requirement','package filters/files/sandbox/relative Markdown','agent execution and lifecycle','epic membership','workspace files and design navigation','message and brief cursor through polling/SSE','in-flight brief edits','stale preview refusal and reviewed launch','discuss result without sending','send failure retry identity','late send across thread switch','stalled stop/resume and uncertain discard','older history','create request cleanup','workspace change','offline snapshot read-only even with supplied token','explicit local package completion'])
        summary['page_errors']=errors
        summary['console_errors']=console_errors
        summary['expected_http_errors']=summary.get('expected_http_errors',[])
        print(json.dumps({'status':'passed','scenarios':summary['scenarios'],'page_errors':errors,'screenshot':str(browser_evidence/'sentinel-solid-threads.png'),'receipt':str(evidence_dir/'ev-2-browser-check.json')}))
    except CompletionCaseComplete:
        pass
    except BaseException as exc:
        # Capture while the page and fixture are still owned so the next boundary
        # failure is observable without rerunning solely for logs.
        diagnostics={}
        try:
            diagnostics['url']=page.url
        except Exception:
            diagnostics['url']=None
        try:
            diagnostics['main_text']=page.locator('main').inner_text(timeout=2000)[:2000]
        except Exception:
            diagnostics['main_text']=None
        try:
            diagnostics['boundary']=control()
        except Exception:
            diagnostics['boundary']=None
        try:
            diagnostics['page_errors']=errors
            summary['page_errors']=errors
        except Exception:
            diagnostics['page_errors']=[]
        try:
            diagnostics['console_errors']=console_errors
        except Exception:
            diagnostics['console_errors']=[]
        summary['failure_diagnostics']=diagnostics
        raise
    finally:
        context.close()
except BaseException as exc:
    summary['error']=repr(exc)
    raise
finally:
    receipt=evidence_dir/('browser/completion.json' if case=='completion' else 'ev-2-browser-check.json')
    temporary=receipt.with_name(receipt.name+'.tmp')
    temporary.write_text(json.dumps(summary,indent=2)+'\n')
    os.replace(temporary,receipt)
    tour=['# EV-2 QA tour','',f"- Status: {summary.get('status','failed')}",f'- Fixture: {url}',"- Viewports: 1280x860, 1600x900","- Command: SENTINEL_EVIDENCE_DIR=<package>/evidence timeout 120s uv run --script scripts/spec-observe/frontend/browser-check.py",'','## Automated scenarios','']
    tour+=[f'{index+1}. {name}' for index,name in enumerate(summary.get('scenarios',[]))]
    tour+=['','## Captures','']+[f"- `{Path(path).name}`" for path in summary.get('captures',[])]
    tour+=['','## Controlled HTTP failures','']+[f"- {entry.get('path')} → {entry.get('status')} ({entry.get('reason') or 'expected'})" for entry in summary.get('expected_http_errors',[])]
    tour+=['','## Timing facts','']+[f'- {key}: {value}s' for key,value in (summary.get('timings') or {}).items()]
    if summary.get('error'): tour+=['','## Failure','',f"```\n{summary['error']}\n```"]
    tour+=['','## Proof boundary','','Isolated production composition and approved desktop/file modes; no phone layout or live operator storage.','']
    if case is None:
        (evidence_dir/'qa-tour.md').write_text('\n'.join(tour)+'\n')
    if fixture:
        fixture.terminate()
        try: fixture.wait(timeout=5)
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
