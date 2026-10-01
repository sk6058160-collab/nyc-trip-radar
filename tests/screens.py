"""Headless screenshots at iPhone viewport (390x844). Usage: python3 tests/screens.py [base_url]"""
import sys, json, os
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4173/'
OUT = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
                        geolocation={'latitude': 40.7580, 'longitude': -73.9855}, permissions=['geolocation'], timezone_id='America/New_York')
    def page(url, wait='.row'):
        pg = ctx.new_page(); pg.on('console', lambda m: m.type == 'error' and errors.append(m.text)); pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(BASE + url); pg.wait_for_selector(wait, timeout=30000); pg.wait_for_timeout(2500); return pg
    pg = page('?mode=long&dow=5&hour=18&svc=all&nolive=1')
    pg.screenshot(path=f'{OUT}/01-map-long-fri-6pm.png')
    pg.evaluate("document.querySelector('#tabs').scrollIntoView()"); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/02-top10-long-fri-6pm.png')
    top = pg.eval_on_selector_all('#panel .row', 'els => els.map(e => e.innerText.replace(/\\n/g," | "))')
    pg.close()
    pg = page('?mode=long&dow=5&hour=18&svc=all&nolive=1&zone=132', '#sheet:not(.hidden)')
    pg.screenshot(path=f'{OUT}/03-zone-detail-jfk.png')
    pg.close()
    pg = page('?mode=short&dow=5&hour=18&svc=rideshare&nolive=1&zone=230', '#sheet:not(.hidden)')
    pg.screenshot(path=f'{OUT}/04-zone-detail-times-sq.png'); pg.close()
    # live boosts (current time, live feeds fetched from the browser)
    pg = page('?mode=volume&tab=live', '.card h3')
    pg.wait_for_function("document.querySelectorAll('#panel .card h3').length >= 7 && ![...document.querySelectorAll('#panel .card h3')].some(h => h.textContent.includes('⏳'))", timeout=60000)
    pg.wait_for_timeout(1500)
    live = pg.eval_on_selector_all('#panel .card', 'els => els.map(e => e.innerText.slice(0, 400))')
    pg.screenshot(path=f'{OUT}/05-live-boosts.png'); pg.screenshot(path=f'{OUT}/05b-live-boosts-full.png', full_page=True); pg.close()
    # near me
    pg = page('?mode=long&tab=near&nolive=1', '#panel .row')
    pg.wait_for_timeout(2000); pg.screenshot(path=f'{OUT}/06-near-me.png')
    pg.evaluate("document.querySelector('#tabs').scrollIntoView()"); pg.wait_for_timeout(400); pg.screenshot(path=f'{OUT}/06b-near-me-list.png')
    near = pg.eval_on_selector_all('#panel .card, #panel .row', 'els => els.slice(0,5).map(e => e.innerText.replace(/\\n/g," | "))'); pg.close()
    # chat tips (synthetic fixture)
    pg = page('?mode=long&tab=chat&nolive=1', '#chatFile')
    pg.set_input_files('#chatFile', os.path.join(os.path.dirname(__file__), 'sample_chat_ios.txt'))
    pg.wait_for_timeout(1500)
    chat = pg.eval_on_selector_all('#panel .card', 'els => els.map(e => e.innerText.replace(/\\n/g," | "))')
    pg.screenshot(path=f'{OUT}/07-chat-tips.png', full_page=True)
    pg.evaluate("window.scrollTo(0,0)"); pg.wait_for_timeout(300); pg.screenshot(path=f'{OUT}/07b-chat-pins-map.png'); pg.close()
    pg = page('?tab=more&nolive=1', '#uber'); pg.screenshot(path=f'{OUT}/08-more-driver-apps.png', full_page=True)
    sw = pg.evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)"); pg.close()
    b.close()
print(json.dumps({'top10': top, 'live': live, 'near': near, 'chat': chat, 'sw': sw, 'errors': errors}, indent=1))
