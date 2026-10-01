"""Smoke-test the deployed site at 390x844 (iPhone UA; ESPN blocks the HeadlessChrome UA). Usage: python3 tests/live_check.py"""
from playwright.sync_api import sync_playwright
import json
URL='https://sk6058160-collab.github.io/nyc-trip-radar/'
errs=[]; failed=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True, timezone_id='America/New_York', user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
    pg=ctx.new_page()
    pg.on('console', lambda m: m.type=='error' and errs.append(m.text)); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('requestfailed', lambda r: failed.append(r.url))
    pg.on('response', lambda r: r.status>=400 and failed.append(f'{r.status} {r.url}'))
    pg.goto(URL, wait_until='networkidle', timeout=60000)
    pg.wait_for_selector('#panel .row', timeout=30000)
    pg.wait_for_function("document.querySelectorAll('.leaflet-tile-loaded').length > 3", timeout=30000)
    pg.wait_for_timeout(6000)
    info=pg.evaluate("""async () => ({
      zones: (() => { const c = document.querySelector('.leaflet-overlay-pane canvas'); if (!c) return 'no canvas'; const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for (let i=3;i<d.length;i+=4) if (d[i]>0) n++; return {canvas: c.width+'x'+c.height, paintedPx: n}; })(),
      legend: document.querySelector('#legend')?.innerText.replace(/\\s+/g,' '),
      banner: document.querySelector('#liveBanner')?.innerText.slice(0,200),
      tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
      rows: document.querySelectorAll('#panel .row').length,
      firstRow: document.querySelector('#panel .row')?.innerText.replace(/\\n/g,' | '),
      when: document.querySelector('#dow').value + ' ' + document.querySelector('#hour').value,
      sw: (await navigator.serviceWorker.getRegistration())?.scope || null,
      swActive: !!(await navigator.serviceWorker.getRegistration())?.active,
      caches: await caches.keys(),
    })""")
    pg.screenshot(path='screenshots/live-site.png')
    print(json.dumps(info, indent=1)); print('console errors:', errs); print('failed requests:', failed)
    b.close()
