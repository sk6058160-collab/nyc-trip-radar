# NYC Trip Radar

Mobile-first PWA for NYC rideshare / taxi drivers: for the current (or chosen) day-of-week and hour, which TLC pickup zones tend to give **LONG (>10 mi or airport-bound)**, **MEDIUM (3–10 mi)** or **SHORT (<3 mi)** trips, plus **Volume**. Historical baseline from real NYC TLC trip records, layered with transparent **live boosts** from free public feeds.

> Historical TLC data (May–July 2026), not live demand. Uber/Lyft real-time demand/surge is not public and is **not** shown or faked.

## Features
- Leaflet map (Esri World Dark Gray canvas tiles, no key) of 263 taxi zones colored radar-style; big Long / Medium / Short / Volume toggles.
- Defaults to the current America/New_York day + hour (rolls forward automatically); day/hour selectors; service filter All / Rideshare (HVFHV) / Yellow / Green.
- Top-10 list (live score, long %, trips/hr, median miles, median pay/fare, $/engaged hr).
- **Near me**: `navigator.geolocation.watchPosition` (GPS/Wi-Fi) → current zone highlighted, best zones within 3 mi with distance. Location never leaves the device.
- Zone detail sheet: short/medium/long mix, stats, 24-h stacked chart, top destinations (weekday/weekend × 6-h block, airports flagged), boosts applied, **Navigate here** (Apple Maps / Google Maps / Waze).
- **Live boosts** (each with source + fetch time, each fails gracefully):
  | Source | Endpoint | Browser CORS | Use |
  |---|---|---|---|
  | Open-Meteo | api.open-meteo.com | ✅ | rain/snow/extreme temp → citywide +5…20% |
  | NWS alerts | api.weather.gov | ✅ | shown as warnings |
  | MTA subway / LIRR / Metro-North alerts (GTFS-RT JSON) | api-endpoint.mta.info camsys/*-alerts.json (no key) | ✅ | active disruptions → zones of affected stops (GTFS stops → zone) or line, +3…20% |
  | MLB Stats API | statsapi.mlb.com | ✅ | Yankees/Mets/other games at NYC stadiums |
  | ESPN public scoreboards (unofficial, keyless) | site.api.espn.com | ✅ | NBA/NHL/NFL/WNBA/MLS at MSG, Barclays, UBS, MetLife, Yankee, Citi |
  | NYC permitted events (tvpp-9vvx) | data.cityofnewyork.us | ✅ | today's events with street closures / parades (listed; no coordinates so no zone boost) |
  | NYC DOT Traffic Speeds NBE (i4gi-tjb9) | data.cityofnewyork.us | ✅ (slow ~10 s, feed often lags hours) | slow links (<12 mph) → −5% in zone; overlay; ignored if >45 min stale |
  | Nager.Date holidays | date.nager.at | ✅ | holiday flag |
  | FAA NAS airport status | nasstatus.faa.gov | ❌ no CORS → needs optional proxy | JFK/LGA/EWR delay programs; otherwise historical baseline shown |
  | NHL api-web | api-web.nhle.com | ❌ no CORS (ESPN used instead) | – |
  | PATH ridepath.json | panynj.gov | ❌ no CORS, and arrivals not alerts | skipped |
  | NJ Transit / Amtrak | – | require developer registration / no official feed | skipped |
  | OpenSky (aircraft arrivals) | opensky-network.org | timed out / now needs account for most uses | skipped |
  | Ticketmaster (concerts) | – | needs (free) API key | skipped |
  | NYC school calendar | – | no official machine-readable feed | skipped |
- **Rule-based estimates** (tagged "estimate"): Broadway evening/matinee let-out, Lincoln Center let-out, Fri/Sat bar-close 2–4:30am (LES, East Village, Meatpacking, West Village, Williamsburg, Bushwick…), weeknight nightlife.
- **Driver chat tips**: import a WhatsApp “Export Chat” `.txt` or `.zip`; parsed on-device (fflate), messages from the last N hours mentioning NYC places (zone names + aliases JFK, LGA, EWR, MSG, Penn, PABT, GCT, LES, UWS…) and keywords (busy, surge, line, long trip, dead, police, traffic, accident) → 💬 pins + small user-labeled boosts (±5% each, capped). No WhatsApp API/bot.
- Driver app quick-launch: `uberdriver://` / `lyftdriver://` (not officially documented) with App Store fallback (Uber Driver id1131342792, Lyft Driver id1203077485).
- PWA: manifest, apple-touch-icon, iOS meta tags, generated service worker (precaches app + all data → offline historical radar; tiles stale-while-revalidate; live APIs never cached).

Live score = baseline × (1 + Σ boosts), clamped to −30%…+60%. Live boosts only apply when viewing **Now**.

## Data pipeline
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/build_data.py --months 2026-05 2026-06 2026-07   # ~3 min, ~1.9 GB download total
.venv/bin/python scripts/build_transit.py                                  # MTA GTFS stops/venues → zones
```
`build_data.py` downloads each monthly parquet (fhvhv ≈ 510 MB, yellow ≈ 65 MB, green ≈ 1 MB) one at a time from the TLC CloudFront bucket, projects it to a slim local parquet (zone, dest, dow, hour, miles, minutes, pay) and deletes the raw file, then aggregates with DuckDB by pickup zone × day-of-week × hour × service (+ "all"):
trip count, % short/medium/long, median miles, median minutes, median HVFHV `driver_pay` (taxi: `fare_amount`), pay per engaged hour (Σpay / Σtrip hours), airport-bound %, and top-5 destinations per zone × weekday/weekend × 6-h block. Cleaning: 0 < miles < 100, 1–240 min, 0 < pay < $1000, pickup inside the month, valid zone 1–263.
Zone shapes: TLC `taxi_zones.zip` (EPSG:2263) → simplified 150 ft → WGS84 GeoJSON (40 KB gzip).
Newer months: check https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page, pass new `--months`, delete `raw/slim/*` for months you drop, and update the month list in `package.json` → `npm run data`.

Outputs (`public/data/`): `cells_{all,rideshare,yellow,green}.json` (zone → 168 hour-of-week slots `[n, short%, med%, long%, medMi, medMin, medPay, payPerHr, airport%]`), `dests.json`, `zones.geojson`, `meta.json`, `transit.json`.

## Build / run
```
npm install
npm run build        # → dist/
npm run preview      # or: cd dist && python3 -m http.server 4173
python3 tests/screens.py http://127.0.0.1:4173/nyc-trip-radar/   # Playwright screenshots at 390×844 → screenshots/
```
URL params for testing: `?mode=long&svc=all&dow=5&hour=18&tab=top|near|live|chat|more&zone=132&nolive=1`.
`tests/sample_chat_ios.txt` is a **synthetic** parser fixture (not real chat data).

## Deploy (GitHub Pages)
**Live:** https://sk6058160-collab.github.io/nyc-trip-radar/

Every push to `main` runs `.github/workflows/pages.yml`: `npm ci` → `npm run build` (with `VITE_BASE=/<repo-name>/`) → uploads `dist/` to GitHub Pages (HTTPS, required for geolocation + service worker on iPhone).
The build base defaults to `/nyc-trip-radar/` (`vite.config.ts`); it drives asset URLs, data fetches (`import.meta.env.BASE_URL + 'data/'`), the service-worker scope and precache list, and the generated manifest's `start_url` / `scope` / `id` / icon paths. For root hosting elsewhere: `VITE_BASE=/ npm run build`.
Local check at the same sub-path: `npm run build && npm run preview` → http://127.0.0.1:4173/nyc-trip-radar/.
The built data JSON in `public/data/` is committed; the raw TLC parquet (`raw/`) is not — regenerate with `npm run data`.
On iPhone: Safari → Share → Add to Home Screen.

### Optional tiny CORS proxy (FAA airport status)
Cloudflare Worker example (allow-list only):
```js
export default { async fetch(req) {
  const u = new URL(req.url).searchParams.get('url') || '';
  if (!u.startsWith('https://nasstatus.faa.gov/')) return new Response('forbidden', { status: 403 });
  const r = await fetch(u); return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'text/plain', 'access-control-allow-origin': '*' } });
} };
```
Enter `https://<worker>.workers.dev/?url=` under More → Optional CORS proxy.

## Limitations
- Historical averages (3 months, ~13 occurrences per weekday-hour); summer months may differ from fall/winter; low-volume zones are noisy (ranking requires ≥3 trips/hr; yellow ≥1, green ≥0.3).
- Distance-based buckets use TLC `trip_miles` / `trip_distance`; "long" also includes any airport-bound trip.
- Pay = HVFHV `driver_pay` (excludes tips); taxi = meter fare only. $/hr counts on-trip time only (no waiting/deadhead).
- EWR has almost no TLC pickups. MetLife/UBS are outside NYC zones (MetLife boost goes to Penn/PABT as an estimate; UBS to Queens Village).
- Live boosts are heuristics with fixed weights, not a demand model. MTA planned work can light up many zones. DOT speeds feed often lags.
- URL schemes for Uber/Lyft Driver apps are not officially documented; fallback opens the App Store.
