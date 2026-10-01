// Live signals from free, keyless, CORS-friendly public sources.
// Every source fails gracefully: an error just marks the source as unavailable.
import type { Boost, SourceStatus } from './types';
import { nyParts, nyIso, parseNyLocal, fmtTime } from './time';
import { zoneAt } from './geo';

export interface Transit {
  stops: Record<string, Record<string, number>>;
  routes: Record<string, Record<string, number[]>>;
  places: Record<string, { name: string; lat: number; lon: number; zone: number; outside: boolean }>;
}
export interface TrafficLink { name: string; speed: number; pts: [number, number][]; zone: number | null; asOf: Date }
export interface LiveResult { status: SourceStatus; boosts: Boost[]; traffic?: TrafficLink[]; events?: EventItem[] }
export interface EventItem { title: string; venue: string; start: Date; estEnd: Date; zone: number | null; league: string; state?: string }

const TIMEOUT = 12000;
async function getJson(url: string, timeout = TIMEOUT): Promise<any> {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
function fail(id: string, name: string, e: unknown, url?: string): LiveResult {
  return { status: { id, name, state: 'error', fetchedAt: new Date(), summary: `Unavailable (${(e as Error)?.message || e})`, url }, boosts: [] };
}

// ---------- 1. Weather: Open-Meteo + NWS alerts ----------
const WMO: Record<number, string> = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail' };
const isSnow = (c: number) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const isWet = (c: number) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;

export async function weather(): Promise<LiveResult> {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=40.7306&longitude=-73.9352&current=temperature_2m,precipitation,weather_code,wind_speed_10m&hourly=precipitation_probability,precipitation,weather_code,temperature_2m&forecast_hours=6&temperature_unit=fahrenheit&precipitation_unit=inch&wind_speed_unit=mph&timezone=America%2FNew_York';
  try {
    const d = await getJson(url);
    const c = d.current; const code = c.weather_code as number;
    const hrs = (d.hourly.time as string[]).map((t, i) => ({ t: t.slice(11, 16), p: d.hourly.precipitation_probability[i], mm: d.hourly.precipitation[i], code: d.hourly.weather_code[i], temp: d.hourly.temperature_2m[i] }));
    const boosts: Boost[] = [];
    const inch = c.precipitation as number;
    let label = '';
    if (isSnow(code)) { boosts.push({ zone: null, pct: 0.2, label: `Snow now (${WMO[code]}) — riders avoid walking/transit; citywide demand up (rule of thumb)`, source: 'weather' }); label = 'snow'; }
    else if (isWet(code) || inch > 0.004) {
      const heavy = inch >= 0.1 || code === 65 || code === 82 || code >= 95;
      boosts.push({ zone: null, pct: heavy ? 0.2 : 0.1, label: `${heavy ? 'Heavy rain' : 'Rain'} now (${WMO[code] || 'precip'}, ${inch.toFixed(2)} in/h) — citywide demand typically rises in rain`, source: 'weather' }); label = 'rain';
    } else {
      const soon = hrs.slice(1, 3).find(h => h.p >= 60 && (isWet(h.code) || isSnow(h.code)));
      if (soon) { boosts.push({ zone: null, pct: 0.05, label: `Precip likely by ${soon.t} (${soon.p}%) — demand may build`, source: 'weather' }); label = 'soon'; }
    }
    if (c.temperature_2m >= 92 || c.temperature_2m <= 25) boosts.push({ zone: null, pct: 0.05, label: `Extreme temperature (${Math.round(c.temperature_2m)}°F) — fewer people walk`, source: 'weather' });
    const detail = hrs.map(h => `${h.t}  ${Math.round(h.temp)}°F  ${WMO[h.code] || ''}  ${h.p}% precip`);
    // NWS alerts (best effort)
    try {
      const a = await getJson('https://api.weather.gov/alerts/active?point=40.7306,-73.9352', 8000);
      for (const f of a.features || []) detail.unshift(`⚠️ NWS: ${f.properties.event} — ${f.properties.headline || ''}`);
    } catch { detail.push('(NWS alerts unavailable)'); }
    return { status: { id: 'weather', name: 'Weather (Open-Meteo + NWS)', state: 'ok', fetchedAt: new Date(), summary: `${Math.round(c.temperature_2m)}°F, ${WMO[code] || 'code ' + code}${label ? '' : ' — no weather boost'}`, detail, url: 'https://open-meteo.com' }, boosts };
  } catch (e) { return fail('weather', 'Weather (Open-Meteo)', e, url); }
}

// ---------- 2. MTA service alerts (subway, LIRR, Metro-North) ----------
const MTA = {
  subway: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json',
  lirr: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Flirr-alerts.json',
  mnr: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fmnr-alerts.json',
};
function severity(t: string): number {
  const s = t.toLowerCase();
  if (s.includes('no trains') || (s.includes('suspended') && !s.startsWith('planned'))) return 0.15;
  if (s.includes('planned') && s.includes('suspended')) return 0.08;
  if (s.includes('delay') || s.includes('reduced')) return 0.06;
  if (s.includes('stops skipped') || s.includes('reroute') || s.includes('substitute bus') || s.includes('express to local')) return 0.03;
  return 0;
}
export async function mta(tr: Transit): Promise<LiveResult> {
  const now = Date.now() / 1000;
  const boosts: Boost[] = []; const detail: string[] = []; let ok = 0, errs: string[] = [];
  const perZone = new Map<number, number>();
  await Promise.all(Object.entries(MTA).map(async ([sys, url]) => {
    try {
      const d = await getJson(url, 15000); ok++;
      for (const e of d.entity || []) {
        const a = e.alert; if (!a) continue;
        const act = (a.active_period || []).some((p: any) => (p.start || 0) <= now && (!p.end || p.end >= now));
        if (!act) continue;
        const type = a['transit_realtime.mercury_alert']?.alert_type || '';
        const sev = severity(type); if (!sev) continue;
        const zones = new Set<number>(); const routes = new Set<string>();
        for (const ie of a.informed_entity || []) {
          if (ie.route_id) routes.add(ie.route_id);
          if (ie.stop_id && tr.stops[sys]?.[ie.stop_id]) zones.add(tr.stops[sys][ie.stop_id]);
        }
        if (!zones.size && sev >= 0.06) for (const r of routes) for (const z of tr.routes[sys]?.[r] || []) zones.add(z);
        if (!zones.size) continue;
        const text = (a.header_text?.translation || []).find((t: any) => t.language === 'en')?.text || type;
        detail.push(`${sys.toUpperCase()} · ${type}: ${text.slice(0, 160)}`);
        for (const z of zones) perZone.set(z, Math.min(0.2, (perZone.get(z) || 0) + sev / Math.max(1, Math.sqrt(zones.size / 4))));
      }
    } catch (e) { errs.push(`${sys}: ${(e as Error).message}`); }
  }));
  for (const [z, p] of perZone) if (p >= 0.01) boosts.push({ zone: z, pct: Math.round(p * 100) / 100, label: `MTA disruption at nearby stations/lines — riders shift to cars`, source: 'mta' });
  if (!ok) return { status: { id: 'mta', name: 'MTA alerts', state: 'error', fetchedAt: new Date(), summary: 'Unavailable: ' + errs.join('; ') }, boosts: [] };
  return { status: { id: 'mta', name: 'MTA alerts (subway/LIRR/Metro-North)', state: 'ok', fetchedAt: new Date(), summary: `${detail.length} active disruptions affecting ${perZone.size} zones${errs.length ? ' (partial: ' + errs.join('; ') + ')' : ''}`, detail: detail.slice(0, 40), url: 'https://new.mta.info/alerts' }, boosts };
}

// ---------- 3. Airports ----------
// No free, keyless, CORS-enabled real-time arrivals feed exists. FAA NAS Status works but has no CORS
// header, so it needs an optional proxy (Settings). Otherwise we show the historical scheduled-hour baseline.
export async function airports(proxy: string): Promise<LiveResult> {
  const name = 'Airports (FAA NAS status)';
  if (!proxy) return { status: { id: 'airports', name, state: 'na', fetchedAt: new Date(), summary: 'No free CORS arrivals feed — showing historical TLC pickup baseline for JFK/LGA/EWR at this hour. Set a CORS proxy in Settings to add FAA delay/ground-stop status.', url: 'https://nasstatus.faa.gov' }, boosts: [] };
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), TIMEOUT);
    const r = await fetch(proxy + encodeURIComponent('https://nasstatus.faa.gov/api/airport-status-information'), { signal: c.signal });
    const xml = await r.text();
    const detail: string[] = []; const boosts: Boost[] = [];
    const map: Record<string, number> = { JFK: 132, LGA: 138, EWR: 1 };
    for (const code of Object.keys(map)) {
      const re = new RegExp(`<ARPT>${code}</ARPT>[\\s\\S]{0,600}?<(Reason|Avg|Min|Max)>([^<]*)`, 'g');
      const m = re.exec(xml);
      if (m) { detail.push(`${code}: delay program — ${m[2]}`); boosts.push({ zone: map[code], pct: -0.05, label: `${code} FAA delay/ground stop — fewer arrivals now, surge later when released`, source: 'airports' }); }
    }
    if (!detail.length) detail.push('No FAA delay programs at JFK/LGA/EWR');
    return { status: { id: 'airports', name, state: 'ok', fetchedAt: new Date(), summary: detail.join(' · '), detail }, boosts };
  } catch (e) { return fail('airports', name, e); }
}

// ---------- 4. Events: MLB Stats API + ESPN public scoreboards + NYC permitted events ----------
const VENUES: [RegExp, string][] = [[/madison square garden/i, 'msg'], [/barclays/i, 'barclays'], [/yankee stadium/i, 'yankee'], [/citi field/i, 'citi'], [/metlife/i, 'metlife'], [/ubs arena/i, 'ubs'], [/arthur ashe|billie jean|louis armstrong/i, 'usta'], [/forest hills/i, 'forest']];
const LEAGUES: [string, string, number][] = [['basketball/nba', 'NBA', 150], ['hockey/nhl', 'NHL', 160], ['football/nfl', 'NFL', 195], ['basketball/wnba', 'WNBA', 130], ['soccer/usa.1', 'MLS', 120]];
export async function events(tr: Transit): Promise<LiveResult> {
  const p = nyParts(); const ymd = p.ymd.replace(/-/g, '');
  const items: EventItem[] = []; const errs: string[] = []; let ok = 0;
  const place = (venue: string) => { for (const [re, k] of VENUES) if (re.test(venue)) return tr.places[k]; return undefined; };
  const jobs: Promise<void>[] = [];
  jobs.push(getJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${p.ymd}&hydrate=venue`).then(d => {
    ok++;
    for (const dt of d.dates || []) for (const g of dt.games || []) {
      const pl = place(g.venue?.name || ''); if (!pl) continue;
      const start = new Date(g.gameDate);
      items.push({ title: `${g.teams.away.team.name} @ ${g.teams.home.team.name}`, venue: pl.name, start, estEnd: new Date(start.getTime() + 180 * 60000), zone: pl.zone, league: 'MLB', state: g.status?.detailedState });
    }
  }).catch(e => { errs.push('MLB ' + e.message); }));
  for (const [path, lg, dur] of LEAGUES) jobs.push(getJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}`).then(d => {
    ok++;
    for (const ev of d.events || []) {
      const comp = ev.competitions?.[0]; const v = comp?.venue?.fullName || '';
      const pl = place(v); if (!pl) continue;
      const start = new Date(ev.date);
      items.push({ title: ev.name, venue: pl.name, start, estEnd: new Date(start.getTime() + dur * 60000), zone: pl.zone, league: lg, state: ev.status?.type?.shortDetail });
    }
  }).catch(e => { errs.push(lg + ' ' + e.message); }));
  // NYC Open Data — permitted events today with street closures / parades
  const permitted: string[] = [];
  const dayStart = `${p.ymd}T00:00:00`, dayEnd = `${p.ymd}T23:59:59`;
  const q = `https://data.cityofnewyork.us/resource/tvpp-9vvx.json?$limit=200&$where=${encodeURIComponent(`start_date_time <= '${dayEnd}' AND end_date_time >= '${dayStart}' AND (street_closure_type != 'N/A' OR event_type like '%Parade%')`)}`;
  jobs.push(getJson(q).then((rows: any[]) => {
    ok++;
    for (const r of rows) permitted.push(`${r.event_type}: ${r.event_name} — ${r.event_borough}, ${r.event_location?.slice(0, 80)} (${r.start_date_time?.slice(11, 16)}–${r.end_date_time?.slice(11, 16)}, ${r.street_closure_type})`);
  }).catch(e => { errs.push('NYC permitted events ' + e.message); }));
  await Promise.all(jobs);
  const now = Date.now(); const boosts: Boost[] = [];
  for (const ev of items) {
    if (ev.zone == null) continue;
    const pl = Object.values(tr.places).find(x => x.name === ev.venue);
    const t0 = ev.estEnd.getTime() - 20 * 60000, t1 = ev.estEnd.getTime() + 75 * 60000;
    const pre0 = ev.start.getTime() - 90 * 60000;
    if (now >= t0 && now <= t1) {
      const lbl = `${ev.league} let-out: ${ev.title} at ${ev.venue} (est. end ${fmtTime(ev.estEnd)})`;
      if (pl?.outside && ev.venue.includes('MetLife')) { // NJ: no TLC zone; fans return via NJ Transit to Penn / buses to PABT
        boosts.push({ zone: 186, pct: 0.08, label: lbl + ' — NJ venue; fans return via Penn Station (est.)', source: 'events', estimate: true });
        boosts.push({ zone: 48, pct: 0.06, label: lbl + ' — NJ venue; buses to Port Authority (est.)', source: 'events', estimate: true });
      } else boosts.push({ zone: ev.zone, pct: 0.25, label: lbl, source: 'events' });
    } else if (now >= pre0 && now < ev.start.getTime() + 30 * 60000) {
      boosts.push({ zone: ev.zone, pct: 0.05, label: `${ev.league} arrivals: ${ev.title} starts ${fmtTime(ev.start)} — drop-offs, traffic`, source: 'events' });
    }
  }
  const detail = items.sort((a, b) => +a.start - +b.start).map(e => `${e.league}: ${e.title} @ ${e.venue} — ${fmtTime(e.start)} (est. end ${fmtTime(e.estEnd)})${e.state ? ' · ' + e.state : ''}`);
  if (!items.length) detail.push('No pro games at NYC-area arenas/stadiums today (concerts need a Ticketmaster key — not included).');
  if (permitted.length) detail.push(`— NYC permitted events with street closures today (${permitted.length}) —`, ...permitted.slice(0, 25));
  if (!ok) return { status: { id: 'events', name: 'Events', state: 'error', fetchedAt: new Date(), summary: 'Unavailable: ' + errs.join('; ') }, boosts: [] };
  return { status: { id: 'events', name: 'Events (MLB, ESPN scoreboards, NYC permitted events)', state: 'ok', fetchedAt: new Date(), summary: `${items.length} games today at NYC venues · ${permitted.length} permitted events w/ closures${errs.length ? ' · partial: ' + errs.join('; ') : ''}`, detail }, boosts, events: items };
}

// ---------- 5. NYC DOT real-time traffic speeds ----------
export async function traffic(): Promise<LiveResult> {
  const name = 'Traffic (NYC DOT speeds)';
  const url = `https://data.cityofnewyork.us/resource/i4gi-tjb9.json?$select=id,speed,data_as_of,link_points,link_name,borough,status&$order=data_as_of DESC&$limit=600`;
  try {
    const rows: any[] = await getJson(url, 25000); // Socrata sort on this big dataset can take ~10s
    const seen = new Set<string>(); const links: TrafficLink[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue; seen.add(r.id);
      if (r.status === '-101' || !r.link_points) continue;
      const pts = (r.link_points as string).trim().split(/\s+/).map(s => s.split(',').map(Number) as [number, number]).filter(p => p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) && Math.abs(p[0]) <= 90);
      if (pts.length < 2) continue;
      const mid = pts[Math.floor(pts.length / 2)];
      links.push({ name: r.link_name, speed: +r.speed, pts, zone: zoneAt(mid[0], mid[1]), asOf: parseNyLocal(r.data_as_of) });
    }
    const newest = links.reduce((m, l) => Math.max(m, +l.asOf), 0);
    const stale = Date.now() - newest > 45 * 60000;
    const boosts: Boost[] = []; const slowBy = new Map<number, string[]>();
    for (const l of links) if (l.speed > 0 && l.speed < 12 && l.zone) { const a = slowBy.get(l.zone) || []; a.push(`${l.name} ${Math.round(l.speed)} mph`); slowBy.set(l.zone, a); }
    if (!stale) for (const [z, a] of slowBy) boosts.push({ zone: z, pct: -0.05, label: `Slow traffic (${a.slice(0, 2).join(', ')}) — trips take longer, fewer per hour`, source: 'traffic' });
    const slow = links.filter(l => l.speed > 0 && l.speed < 12).length;
    return { status: { id: 'traffic', name, state: 'ok', fetchedAt: new Date(), summary: `${links.length} highway/arterial links · ${slow} slow (<12 mph) · data as of ${fmtTime(new Date(newest))}${stale ? ' (stale — not used for scoring)' : ''}`, detail: links.filter(l => l.speed < 15).sort((a, b) => a.speed - b.speed).slice(0, 15).map(l => `${l.name}: ${Math.round(l.speed)} mph`), url: 'https://data.cityofnewyork.us/d/i4gi-tjb9' }, boosts, traffic: links };
  } catch (e) { return fail('traffic', name, e, url); }
}

// ---------- 6. Holidays (Nager.Date) ----------
export async function holidays(): Promise<LiveResult> {
  const p = nyParts(); const name = 'US holidays (Nager.Date)';
  try {
    const d: any[] = await getJson(`https://date.nager.at/api/v3/PublicHolidays/${p.y}/US`);
    const today = d.filter(h => h.date === p.ymd);
    const next = d.find(h => h.date > p.ymd);
    const detail = [`Next: ${next ? next.date + ' ' + next.localName : 'n/a'}`, 'NYC public-school calendar: no official machine-readable feed — not included.'];
    return { status: { id: 'holidays', name, state: 'ok', fetchedAt: new Date(), summary: today.length ? `Today is ${today.map(h => h.localName).join(', ')} — commute patterns differ; compare with the Sunday baseline` : 'Not a federal holiday today', detail }, boosts: [] };
  } catch (e) { return fail('holidays', name, e); }
}

export { nyIso };
