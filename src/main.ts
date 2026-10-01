import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import type { Svc, Mode, Cell, Meta, Boost, SourceStatus } from './types';
import { DOWS, nyParts, hourLabel, fmtTime } from './time';
import { indexZones, zoneAt, miles } from './geo';
import { ruleBoosts } from './rules';
import * as live from './live';
import type { Transit, TrafficLink, EventItem } from './live';
import { readExport, parseChat, buildMatcher, extractTips, tipBoosts, type ChatMsg, type ChatTip } from './chat';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const BASE = import.meta.env.BASE_URL; // '/nyc-trip-radar/' on GitHub Pages
const DATA = BASE + 'data/';
const AIRPORT_NOTE: Record<number, string> = {
  132: 'JFK Airport — pickups are almost all long trips (most >10 mi). Expect queue/holding-lot waits before a dispatch; follow posted airport pickup rules.',
  138: 'LaGuardia — closer to Manhattan, so more medium (3–10 mi) trips than JFK; airport queue/holding-lot waits apply.',
  1: 'Newark (EWR, NJ) — TLC data contains very few EWR pickups (NYC-licensed vehicles rarely pick up there), so these numbers are tiny.',
};
const OUTSIDE: Record<number, string> = { 264: 'Unknown zone', 265: 'Outside NYC' };

// ---------------- state ----------------
const q = new URLSearchParams(location.search);
const saved = JSON.parse(localStorage.getItem('tr-state') || '{}');
const st = {
  mode: (q.get('mode') || saved.mode || 'long') as Mode,
  svc: (q.get('svc') || saved.svc || 'all') as Svc,
  tab: q.get('tab') || 'top',
  dow: 0, hour: 0, isNow: true,
  pos: null as null | { lat: number; lon: number; acc: number; zone: number | null; at: Date },
  watchId: null as null | number,
  proxy: localStorage.getItem('tr-proxy') || '',
  chatMsgs: [] as ChatMsg[], chatTips: [] as ChatTip[], chatHours: 3, chatRef: 'now' as 'now' | 'last', chatFile: '',
};
let meta: Meta; let geo: any; let transit: Transit; let dests: any = null;
const cellsCache: Partial<Record<Svc, Record<string, Cell[]>>> = {};
const liveStatus = new Map<string, SourceStatus>();
const liveBoosts = new Map<string, Boost[]>();
let trafficLinks: TrafficLink[] = []; let eventItems: EventItem[] = [];
let lastLiveFetch = 0;

function setNow() { const p = nyParts(); st.dow = p.dow; st.hour = p.h; st.isNow = true; }
setNow();
if (q.get('dow')) { st.dow = +q.get('dow')!; st.isNow = false; }
if (q.get('hour')) { st.hour = +q.get('hour')!; st.isNow = false; }
function persist() { localStorage.setItem('tr-state', JSON.stringify({ mode: st.mode, svc: st.svc })); }

// ---------------- data ----------------
async function getCells(svc: Svc) {
  if (!cellsCache[svc]) cellsCache[svc] = await (await fetch(`${DATA}cells_${svc}.json`)).json();
  return cellsCache[svc]!;
}
const zname = (id: number | string) => meta.zones[String(id)]?.z || OUTSIDE[+id] || `Zone ${id}`;
const slot = (dow: number, h: number) => dow * 24 + h;
const perHr = (c: Cell, dow: number) => (c ? c[0] / meta.dowOccurrences[dow] : 0);
const minPerHr = () => (st.svc === 'green' ? 0.3 : st.svc === 'yellow' ? 1 : 3);
function baseVal(c: Cell, mode: Mode, dow: number) {
  if (!c) return 0;
  return mode === 'long' ? c[3] : mode === 'medium' ? c[2] : mode === 'short' ? c[1] : perHr(c, dow);
}

// ---------------- boosts ----------------
function allBoosts(): Boost[] {
  const out = ruleBoosts(st.dow, st.hour, st.isNow ? nyParts().mi : -1);
  if (st.isNow) { for (const b of liveBoosts.values()) out.push(...b); }
  out.push(...tipBoosts(st.chatTips));
  return out;
}
function boostsFor(zone: number, all = allBoosts()) { return all.filter(b => b.zone === null || b.zone === zone); }
function mult(bs: Boost[]) { const s = bs.reduce((a, b) => a + b.pct, 0); return 1 + Math.max(-0.3, Math.min(0.6, s)); }

interface Row { id: number; c: Exclude<Cell, 0>; base: number; m: number; score: number; vol: number; bs: Boost[] }
async function rows(): Promise<Row[]> {
  const cells = await getCells(st.svc); const all = allBoosts(); const out: Row[] = [];
  for (const [id, arr] of Object.entries(cells)) {
    const c = arr[slot(st.dow, st.hour)]; if (!c) continue;
    const vol = perHr(c, st.dow); const bs = boostsFor(+id, all); const m = mult(bs);
    const base = baseVal(c, st.mode, st.dow);
    out.push({ id: +id, c, base, m, score: base * m, vol, bs });
  }
  return out;
}

// ---------------- map ----------------
const map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: true }).setView([40.72, -73.94], 10);
// Esri World Dark Gray Canvas: free, no API key (CARTO basemaps now require a key)
L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors · Data: NYC TLC' }).addTo(map);
map.createPane('labels'); map.getPane('labels')!.style.zIndex = '650'; map.getPane('labels')!.style.pointerEvents = 'none';
L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, pane: 'labels' }).addTo(map);
let zoneLayer: L.GeoJSON | null = null; const overlay = L.layerGroup().addTo(map); const meLayer = L.layerGroup().addTo(map); const trafficLayer = L.layerGroup();
let showTraffic = false;

const PAL = ['#0b1d3a', '#0f4c81', '#00a6c8', '#2ee6a6', '#d4f000', '#ffb020', '#ff4d6d'];
function hex(h: string) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
function color(t: number) {
  t = Math.max(0, Math.min(1, t)); const x = t * (PAL.length - 1); const i = Math.min(PAL.length - 2, Math.floor(x)); const f = x - i;
  const a = hex(PAL[i]), b = hex(PAL[i + 1]); return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}
let scale = { lo: 0, hi: 1, log: false };
async function paint() {
  const rs = await rows(); const by = new Map(rs.map(r => [r.id, r]));
  const elig = rs.filter(r => r.vol >= minPerHr());
  const vals = elig.map(r => st.mode === 'volume' ? Math.log10(1 + r.score) : r.score).sort((a, b) => a - b);
  scale = { lo: vals[Math.floor(vals.length * 0.05)] ?? 0, hi: vals[Math.floor(vals.length * 0.97)] ?? 1, log: st.mode === 'volume' };
  const norm = (r: Row) => { const v = scale.log ? Math.log10(1 + r.score) : r.score; return (v - scale.lo) / ((scale.hi - scale.lo) || 1); };
  zoneLayer!.setStyle((f: any) => {
    const r = by.get(Number(f.id)); const me = st.pos?.zone === Number(f.id);
    if (!r || r.vol < minPerHr()) return { fillColor: '#1a2230', fillOpacity: 0.25, color: me ? '#fff' : '#223', weight: me ? 3 : 0.5 };
    return { fillColor: color(norm(r)), fillOpacity: 0.62, color: me ? '#ffffff' : '#05080d', weight: me ? 3 : 0.6 };
  });
  const unit = st.mode === 'volume' ? 'trips/hr' : `% ${st.mode}`;
  const fmt = (v: number) => scale.log ? Math.round(10 ** v - 1) : Math.round(v);
  $('#legend').innerHTML = `<span>${fmt(scale.lo)}</span><div class="bar" style="background:linear-gradient(90deg,${PAL.join(',')})"></div><span>${fmt(scale.hi)}+ ${unit}</span>`;
  return rs;
}
function drawOverlays() {
  overlay.clearLayers();
  // chat tips
  const tipZones = new Map<number, ChatTip[]>();
  for (const t of st.chatTips) for (const z of t.zones) { const a = tipZones.get(z) || []; a.push(t); tipZones.set(z, a); }
  for (const [z, ts] of tipZones) {
    const c = meta.zones[z]?.c; if (!c) continue;
    const icon = L.divIcon({ className: '', html: `<div class="tip-pin">💬</div>`, iconSize: [24, 24] });
    L.marker([c[1], c[0]], { icon }).bindPopup(`<b>Chat tips · ${zname(z)}</b><br>${ts.slice(0, 4).map(t => `<small>${fmtTime(t.time)} ${esc(t.author)}:</small> ${esc(t.snippet.slice(0, 100))} ${t.tags.map(g => `<span class="tag user">${g}</span>`).join('')}`).join('<br>')}<br><i>User-imported, unverified</i>`).addTo(overlay);
  }
  for (const e of eventItems) {
    const pl = Object.values(transit.places).find(p => p.name === e.venue); if (!pl) continue;
    L.marker([pl.lat, pl.lon], { icon: L.divIcon({ className: '', html: '<div class="ev-pin">🏟️</div>', iconSize: [22, 22] }) })
      .bindPopup(`<b>${esc(e.title)}</b><br>${esc(e.venue)}<br>${fmtTime(e.start)} · est. end ${fmtTime(e.estEnd)}`).addTo(overlay);
  }
  trafficLayer.clearLayers();
  for (const l of trafficLinks) L.polyline(l.pts, { color: l.speed < 12 ? '#ff4d6d' : l.speed < 25 ? '#ffb020' : '#2ee6a6', weight: 3, opacity: 0.9 }).bindTooltip(`${l.name}: ${Math.round(l.speed)} mph`).addTo(trafficLayer);
  if (showTraffic) trafficLayer.addTo(map); else trafficLayer.remove();
}
function esc(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

// ---------------- UI: controls ----------------
function initControls() {
  $('#dow').innerHTML = DOWS.map((d, i) => `<option value="${i}">${d}</option>`).join('');
  $('#hour').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join('');
  $<HTMLSelectElement>('#dow').onchange = e => { st.dow = +(e.target as HTMLSelectElement).value; st.isNow = false; refresh(); };
  $<HTMLSelectElement>('#hour').onchange = e => { st.hour = +(e.target as HTMLSelectElement).value; st.isNow = false; refresh(); };
  $('#nowBtn').onclick = () => { setNow(); refresh(); };
  $('#modes').onclick = e => { const b = (e.target as HTMLElement).closest('button'); if (b) { st.mode = b.dataset.mode as Mode; persist(); refresh(); } };
  $('#svcs').onclick = e => { const b = (e.target as HTMLElement).closest('button'); if (b) { st.svc = b.dataset.svc as Svc; persist(); refresh(); } };
  $('#tabs').onclick = e => { const b = (e.target as HTMLElement).closest('button'); if (b) { st.tab = b.dataset.tab!; if (st.tab === 'near') startGeo(); if (st.tab === 'live') maybeFetchLive(); refresh(); } };
  $('#sheet').onclick = e => { if (e.target === $('#sheet')) closeSheet(); };
}
function syncControls() {
  $<HTMLSelectElement>('#dow').value = String(st.dow); $<HTMLSelectElement>('#hour').value = String(st.hour);
  $('#nowBtn').style.opacity = st.isNow ? '1' : '.55';
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.mode === st.mode));
  document.querySelectorAll('#svcs button').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.svc === st.svc));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.tab === st.tab));
  const lb = $('#liveBanner');
  if (!st.isNow) { lb.textContent = `Viewing ${DOWS[st.dow]} ${hourLabel(st.hour)} (historical). Live boosts apply only to "Now"; rule-based estimates still shown.`; lb.classList.remove('hidden'); }
  else lb.classList.add('hidden');
}

// ---------------- panels ----------------
const pctTxt = (r: Row) => st.mode === 'volume' ? `${r.vol < 10 ? r.vol.toFixed(1) : Math.round(r.vol)}` : `${r.base}%`;
const bigSub = () => st.mode === 'volume' ? 'trips/hr' : st.mode;
function chip(m: number) { const p = Math.round((m - 1) * 100); return p ? `<span class="boostchip ${p < 0 ? 'neg' : ''}">${p > 0 ? '+' : ''}${p}%</span>` : ''; }
function rowHtml(r: Row, i: number, extra = '') {
  const c = r.c; const payLbl = st.svc === 'rideshare' ? 'pay' : st.svc === 'all' ? 'pay/fare' : 'fare';
  return `<div class="row" data-zone="${r.id}"><div class="rk">${i + 1}</div><div class="nm"><b>${esc(zname(r.id))}${chip(r.m)}</b>
    <span>${meta.zones[r.id]?.b} · ${extra}~${r.vol < 10 ? r.vol.toFixed(1) : Math.round(r.vol)} trips/hr · long ${c[3]}% · ${c[4]} mi · $${Math.round(c[6])} ${payLbl} · $${c[7]}/hr</span></div>
    <div class="big">${pctTxt(r)}<small>${bigSub()}</small></div></div>`;
}
function disclaimer() {
  const m = meta.months; return `<div class="disclaimer">Historical NYC TLC trip records for ${m[0]} – ${m[m.length - 1]} (${(Object.values(meta.tripsBySvc).reduce((a, b) => a + b, 0) / 1e6).toFixed(1)}M trips), averaged by weekday & hour. <b>Not live demand.</b> Uber/Lyft live demand & surge are not publicly available and are not shown. Live boosts are transparent adjustments from public feeds; rule-based ones are estimates. Pay = HVFHV driver pay (excl. tips); taxi = meter fare. $/hr is per engaged (on-trip) hour, not including waiting.</div>`;
}
async function renderPanel(rs: Row[]) {
  const P = $('#panel'); const elig = rs.filter(r => r.vol >= minPerHr());
  if (st.tab === 'top') {
    const top = elig.sort((a, b) => b.score - a.score).slice(0, 10);
    P.innerHTML = `<div class="muted" style="margin:4px 2px 8px">Top 10 for <b>${st.mode.toUpperCase()}</b> · ${DOWS[st.dow]} ${hourLabel(st.hour)} · ${st.svc}. Ranked by live score = baseline × boosts (zones with ≥${minPerHr()} trips/hr).</div>`
      + top.map((r, i) => rowHtml(r, i)).join('') + disclaimer();
  } else if (st.tab === 'near') {
    if (!st.pos) { P.innerHTML = `<div class="card"><h3>📍 Near me</h3><p class="muted">Uses your device location (GPS/Wi-Fi) via the browser, updated continuously while the app is open. Location never leaves your phone.</p><button class="btn primary" id="geoBtn">Use my location</button><p class="muted small" id="geoMsg"></p></div>` + disclaimer();
      $('#geoBtn').onclick = startGeo; return; }
    const p = st.pos; const near = elig.map(r => ({ r, d: miles(p.lat, p.lon, meta.zones[r.id].c[1], meta.zones[r.id].c[0]) })).filter(x => x.d <= 3 || x.r.id === p.zone).sort((a, b) => b.r.score - a.r.score).slice(0, 12);
    P.innerHTML = `<div class="card"><b>You're in: ${p.zone ? esc(zname(p.zone)) : 'outside TLC zones'}</b><div class="muted small">±${Math.round(p.acc)} m · updated ${fmtTime(p.at)} · watching position</div></div>`
      + (near.length ? near.map((x, i) => rowHtml(x.r, i, `<b>${x.d.toFixed(1)} mi</b> · `)).join('') : '<p class="muted">No zones with enough data within 3 miles.</p>') + disclaimer();
  } else if (st.tab === 'live') {
    renderLive(P, rs);
  } else if (st.tab === 'chat') {
    renderChat(P);
  } else renderMore(P);
  P.querySelectorAll<HTMLElement>('.row[data-zone]').forEach(el => el.onclick = () => openZone(+el.dataset.zone!));
}

function renderLive(P: HTMLElement, rs: Row[]) {
  const order = ['weather', 'mta', 'events', 'traffic', 'airports', 'holidays'];
  const all = allBoosts().filter(b => b.source !== 'chat');
  const cards = order.map(id => liveStatus.get(id) || { id, name: id, state: 'loading', summary: 'Loading…' } as SourceStatus).map(s => {
    let extra = '';
    if (s.id === 'airports') {
      const lines = meta.airports.map(a => { const r = rs.find(x => x.id === a); return r ? `${zname(a)}: ~${r.vol.toFixed(0)} TLC pickups/hr typical now, long ${r.c[3]}%` : `${zname(a)}: too few TLC pickups`; });
      extra = `<div class="small">Scheduled-hour baseline (historical): ${lines.join(' · ')}</div>`;
    }
    return `<div class="card"><h3>${s.state === 'ok' ? '🟢' : s.state === 'error' ? '🔴' : s.state === 'na' ? '🟡' : '⏳'} ${esc(s.name)}</h3>
      <div class="${s.state}">${esc(s.summary)}</div>${extra}<div class="muted small">Fetched ${fmtTime(s.fetchedAt)}${s.url ? ` · <a href="${s.url}" target="_blank" rel="noopener" style="color:#9cf">source</a>` : ''}</div>
      ${s.detail?.length ? `<details><summary class="muted small">Details (${s.detail.length})</summary><div class="small">${s.detail.map(d => `<div class="boostline">${esc(d)}</div>`).join('')}</div></details>` : ''}</div>`;
  }).join('');
  const zb = all.filter(b => b.zone !== null).sort((a, b) => b.pct - a.pct);
  const cw = all.filter(b => b.zone === null);
  P.innerHTML = `<div class="card"><h3>How the live score works</h3><div class="small">Live score = historical baseline × (1 + sum of boosts), capped −30%…+60%. Every boost below names its source and when it was fetched. <span class="tag live">live</span> = public feed, <span class="tag est">estimate</span> = time-of-week rule, <span class="tag user">user</span> = your imported chat tips.<br><b>Not included:</b> Uber/Lyft real-time demand or surge — not publicly available, so not faked.</div>
    <div class="btns" style="margin-top:8px"><button class="btn primary" id="liveRefresh">↻ Refresh live data</button><button class="btn" id="trafficToggle">${showTraffic ? 'Hide' : 'Show'} traffic on map</button></div>
    <div class="muted small">Last refresh: ${lastLiveFetch ? fmtTime(new Date(lastLiveFetch)) : 'never'}${st.isNow ? '' : ' · <b>live boosts paused: not viewing Now</b>'}</div></div>
    <div class="card"><h3>Active boosts (${cw.length} citywide, ${zb.length} zone)</h3>${cw.map(b => `<div class="boostline">${b.estimate ? '<span class="tag est">estimate</span>' : '<span class="tag live">live</span>'}<b>Citywide ${b.pct > 0 ? '+' : ''}${Math.round(b.pct * 100)}%</b> — ${esc(b.label)}</div>`).join('')}
    ${zb.slice(0, 40).map(b => `<div class="boostline" data-zone="${b.zone}">${b.estimate ? '<span class="tag est">estimate</span>' : '<span class="tag live">live</span>'}<b>${esc(zname(b.zone!))} ${b.pct > 0 ? '+' : ''}${Math.round(b.pct * 100)}%</b> — ${esc(b.label)}</div>`).join('') || '<div class="muted small">No zone boosts right now.</div>'}${zb.length > 40 ? `<div class="muted small">…and ${zb.length - 40} more</div>` : ''}</div>` + cards + disclaimer();
  $('#liveRefresh').onclick = () => fetchLive(true);
  $('#trafficToggle').onclick = () => { showTraffic = !showTraffic; drawOverlays(); refresh(); };
  P.querySelectorAll<HTMLElement>('.boostline[data-zone]').forEach(el => el.onclick = () => openZone(+el.dataset.zone!));
}

function renderChat(P: HTMLElement) {
  P.innerHTML = `<div class="card"><h3>💬 Driver chat tips</h3><div class="small muted">Import a WhatsApp chat export (WhatsApp → chat → ⋯ → Export Chat → Without Media → Save to Files). The file is parsed <b>entirely on this phone</b>; nothing is uploaded. Messages mentioning NYC places + keywords (busy, surge, line, long trip, dead, police, traffic, accident) become map pins and small, clearly-labeled boosts.</div>
    <div style="margin:10px 0"><input type="file" id="chatFile" accept=".txt,.zip,text/plain,application/zip" /></div>
    <div class="btns"><select id="chatHours">${[1, 3, 6, 12, 24, 168].map(h => `<option value="${h}" ${h === st.chatHours ? 'selected' : ''}>Last ${h < 168 ? h + ' h' : '7 days'}</option>`).join('')}</select>
    <select id="chatRef"><option value="now" ${st.chatRef === 'now' ? 'selected' : ''}>…before now</option><option value="last" ${st.chatRef === 'last' ? 'selected' : ''}>…before last message</option></select>
    <button class="btn" id="chatClear">Clear</button></div>
    <div class="muted small">${st.chatFile ? `Loaded ${esc(st.chatFile)}: ${st.chatMsgs.length} messages, ${st.chatTips.length} place tips in window.` : 'No chat loaded.'}</div></div>`
    + st.chatTips.slice(0, 50).map(t => `<div class="card" data-zone="${t.zones[0]}"><div class="small"><span class="tag user">user-imported</span>${fmtTime(t.time)} · ${t.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · <b>${esc(t.author)}</b></div>
      <div>${esc(t.snippet)}</div><div class="small">📍 ${t.zones.map(z => esc(zname(z))).join(', ')} ${t.tags.map(g => `<span class="tag">${g}</span>`).join('')}</div></div>`).join('') + disclaimer();
  $<HTMLInputElement>('#chatFile').onchange = async e => {
    const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
    try { st.chatMsgs = parseChat(await readExport(f)); st.chatFile = f.name; recomputeTips(); } catch (err) { alert('Could not read chat: ' + (err as Error).message); }
    refresh();
  };
  $<HTMLSelectElement>('#chatHours').onchange = e => { st.chatHours = +(e.target as HTMLSelectElement).value; recomputeTips(); refresh(); };
  $<HTMLSelectElement>('#chatRef').onchange = e => { st.chatRef = (e.target as HTMLSelectElement).value as any; recomputeTips(); refresh(); };
  $('#chatClear').onclick = () => { st.chatMsgs = []; st.chatTips = []; st.chatFile = ''; refresh(); };
  P.querySelectorAll<HTMLElement>('.card[data-zone]').forEach(el => el.onclick = () => openZone(+el.dataset.zone!));
}
let matcher: ((t: string) => number[]) | null = null;
function recomputeTips() {
  matcher ||= buildMatcher(meta.zones);
  const ref = st.chatRef === 'last' && st.chatMsgs.length ? st.chatMsgs[st.chatMsgs.length - 1].time : new Date();
  st.chatTips = extractTips(st.chatMsgs, matcher, st.chatHours, ref);
}

function openApp(scheme: string, store: string) {
  const t = Date.now(); location.href = scheme;
  setTimeout(() => { if (document.visibilityState === 'visible' && Date.now() - t < 3000) location.href = store; }, 1600);
}
function renderMore(P: HTMLElement) {
  P.innerHTML = `<div class="card"><h3>🚗 Driver apps</h3><div class="btns"><button class="btn primary" id="uber">Open Uber Driver</button><button class="btn primary" id="lyft">Open Lyft Driver</button></div>
    <div class="muted small">Tries the app's URL scheme (<code>uberdriver://</code>, <code>lyftdriver://</code> — not officially documented by Uber/Lyft) and falls back to the App Store if the app doesn't open. No other Uber/Lyft integration.</div></div>
    <div class="card"><h3>📲 Install on iPhone</h3><div class="small">Open in Safari → Share → <b>Add to Home Screen</b>. Works offline for the historical radar (live boosts need a connection).</div></div>
    <div class="card"><h3>⚙️ Optional CORS proxy</h3><div class="small muted">FAA airport delay status has no CORS header. If you run a tiny proxy (see README), enter its prefix, e.g. <code>https://my-proxy.example.workers.dev/?url=</code></div>
    <input type="text" id="proxy" placeholder="https://…/?url=" value="${esc(st.proxy)}" /><div class="btns" style="margin-top:8px"><button class="btn" id="proxySave">Save</button></div></div>
    <div class="card"><h3>About the data</h3><div class="small">Source: <a style="color:#9cf" href="https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page" target="_blank" rel="noopener">NYC TLC Trip Record Data</a> — High Volume FHV (Uber/Lyft/Via), yellow & green taxi, months ${meta.months.join(', ')}. Trips: ${Object.entries(meta.tripsBySvc).map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)}M`).join(', ')}.
      Short &lt;3 mi · Medium 3–10 mi · Long &gt;10 mi or airport-bound (JFK/LGA/EWR). Built ${meta.generated}.</div></div>` + disclaimer();
  $('#uber').onclick = () => openApp('uberdriver://', 'https://apps.apple.com/us/app/uber-driver-drive-deliver/id1131342792');
  $('#lyft').onclick = () => openApp('lyftdriver://', 'https://apps.apple.com/us/app/lyft-driver/id1203077485');
  $('#proxySave').onclick = () => { st.proxy = $<HTMLInputElement>('#proxy').value.trim(); localStorage.setItem('tr-proxy', st.proxy); fetchLive(true); };
}

// ---------------- zone detail ----------------
async function openZone(id: number) {
  const z = meta.zones[id]; if (!z) return;
  const cells = await getCells(st.svc); const arr = cells[id] || [];
  if (!dests) dests = await (await fetch(`${DATA}dests.json`)).json();
  const c = arr[slot(st.dow, st.hour)]; const bs = boostsFor(id); const m = mult(bs);
  const hrs = Array.from({ length: 24 }, (_, h) => arr[slot(st.dow, h)]);
  const maxN = Math.max(1, ...hrs.map(x => (x ? x[0] : 0)));
  const W = 360, H = 120, bw = W / 24;
  const bars = hrs.map((x, h) => {
    if (!x) return '';
    const tot = (x[0] / maxN) * (H - 16); const sH = tot * x[1] / 100, mH = tot * x[2] / 100, lH = tot * x[3] / 100;
    const X = h * bw + 1, base = H - 14;
    return `<g opacity="${h === st.hour ? 1 : 0.75}"><rect x="${X}" y="${base - lH}" width="${bw - 2}" height="${lH}" fill="var(--long)"/><rect x="${X}" y="${base - lH - mH}" width="${bw - 2}" height="${mH}" fill="var(--med)"/><rect x="${X}" y="${base - lH - mH - sH}" width="${bw - 2}" height="${sH}" fill="var(--short)"/>${h === st.hour ? `<rect x="${X - 1}" y="2" width="${bw}" height="${base - 2}" fill="none" stroke="#fff" stroke-width="1.5" rx="2"/>` : ''}</g>`;
  }).join('') + [0, 6, 12, 18, 23].map(h => `<text x="${h * bw + bw / 2}" y="${H - 2}" fill="#8a9bb0" font-size="10" text-anchor="middle">${hourLabel(h)}</text>`).join('');
  const we = st.dow === 0 || st.dow === 6 ? 1 : 0; const blk = Math.floor(st.hour / 6);
  const dl = (dests[st.svc] || {})[`${id}_${we}_${blk}`] || [];
  const blkName = ['12am–6am', '6am–12pm', '12pm–6pm', '6pm–12am'][blk];
  const payLbl = st.svc === 'rideshare' ? 'driver pay' : st.svc === 'all' ? 'pay / fare' : 'meter fare';
  const nav = `${z.c[1]},${z.c[0]}`;
  const tipsHere = st.chatTips.filter(t => t.zones.includes(id));
  const slowHere = trafficLinks.filter(l => l.zone === id);
  $('#sheetInner').innerHTML = `<div class="grab"></div><button class="close" id="closeSheet" aria-label="Close">✕</button>
    <h2 style="margin:0 0 2px">${esc(z.z)}</h2><div class="muted">${z.b} · ${z.sz} · zone #${id} · ${DOWS[st.dow]} ${hourLabel(st.hour)} · ${st.svc}</div>
    ${AIRPORT_NOTE[id] ? `<div class="card" style="margin-top:8px;border-color:#ff4d6d66">✈️ ${AIRPORT_NOTE[id]}</div>` : ''}
    ${c ? `<div class="mix" title="short / medium / long"><i style="width:${c[1]}%;background:var(--short)"></i><i style="width:${c[2]}%;background:var(--med)"></i><i style="width:${c[3]}%;background:var(--long)"></i></div>
    <div class="small"><span style="color:var(--short)">■ Short ${c[1]}%</span> · <span style="color:var(--med)">■ Medium ${c[2]}%</span> · <span style="color:var(--long)">■ Long ${c[3]}%</span> · airport-bound ${c[8]}%</div>
    <div class="stats"><div class="stat"><b>${perHr(c, st.dow).toFixed(perHr(c, st.dow) < 10 ? 1 : 0)}</b><span>trips / hr</span></div><div class="stat"><b>${c[4]} mi</b><span>median trip</span></div><div class="stat"><b>${c[5]} min</b><span>median time</span></div>
    <div class="stat"><b>$${c[6].toFixed(0)}</b><span>median ${payLbl}</span></div><div class="stat"><b>$${c[7]}</b><span>per engaged hr</span></div><div class="stat"><b>${chip(m) || '—'}</b><span>live adj.</span></div></div>`
      : '<p class="muted">No trips recorded for this zone/hour/service.</p>'}
    <div class="card"><h3>Hourly mix · ${DOWS[st.dow]}</h3><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Hourly short/medium/long trips">${bars}</svg><div class="muted small">Bar height = trip volume; colors = short/medium/long. Tap a bar's hour in the selector to switch.</div></div>
    <div class="card"><h3>Top destinations · ${we ? 'weekend' : 'weekday'} ${blkName}</h3>${dl.length ? dl.map(([d, p]: [number, number]) => `<div class="dest"><span class="${meta.airports.includes(d) ? 'apt' : ''}">${meta.airports.includes(d) ? '✈️ ' : ''}${esc(zname(d))}</span><b>${p}%</b></div>`).join('') : '<div class="muted">Not enough data</div>'}</div>
    <div class="card"><h3>Boosts applied</h3>${bs.length ? bs.map(b => `<div class="boostline">${b.source === 'chat' ? '<span class="tag user">user</span>' : b.estimate ? '<span class="tag est">estimate</span>' : '<span class="tag live">live</span>'}${b.pct > 0 ? '+' : ''}${Math.round(b.pct * 100)}% ${b.zone === null ? '(citywide) ' : ''}— ${esc(b.label)}</div>`).join('') : '<div class="muted small">None — baseline only.</div>'}
      ${slowHere.length ? `<div class="small" style="margin-top:6px">🚦 DOT links here: ${slowHere.map(l => `${esc(l.name)} ${Math.round(l.speed)} mph`).join('; ')}</div>` : ''}
      ${tipsHere.length ? `<div class="small" style="margin-top:6px">💬 ${tipsHere.length} chat tip(s): ${tipsHere.slice(0, 3).map(t => `“${esc(t.snippet.slice(0, 80))}” (${fmtTime(t.time)})`).join(' · ')}</div>` : ''}</div>
    <div class="btns"><a class="btn primary" href="https://maps.apple.com/?daddr=${nav}&dirflg=d" target="_blank" rel="noopener">🧭 Apple Maps</a><a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${nav}&travelmode=driving" target="_blank" rel="noopener">Google Maps</a><a class="btn" href="https://waze.com/ul?ll=${nav}&navigate=yes" target="_blank" rel="noopener">Waze</a></div>
    <div class="muted small" style="margin-top:6px">Navigate here goes to the zone's interior point (${nav}).</div>`;
  $('#sheet').classList.remove('hidden');
  $('#closeSheet').onclick = closeSheet;
  history.replaceState(null, '', location.pathname + location.search.replace(/([?&])zone=\d+&?/, '$1') );
}
function closeSheet() { $('#sheet').classList.add('hidden'); }

// ---------------- geolocation ----------------
function startGeo() {
  if (st.watchId !== null) return;
  if (!('geolocation' in navigator)) { const m = document.getElementById('geoMsg'); if (m) m.textContent = 'Geolocation not supported.'; return; }
  st.watchId = navigator.geolocation.watchPosition(p => {
    const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
    const first = !st.pos;
    st.pos = { lat, lon, acc, zone: zoneAt(lat, lon), at: new Date() };
    meLayer.clearLayers();
    L.circle([lat, lon], { radius: 4828, color: '#3af', weight: 1, fillOpacity: 0.04, dashArray: '4 6' }).addTo(meLayer);
    L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }) }).addTo(meLayer);
    if (first) map.setView([lat, lon], 12);
    refresh();
  }, err => { const m = document.getElementById('geoMsg'); if (m) m.textContent = 'Location unavailable: ' + err.message; st.watchId = null; }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}

// ---------------- live fetching ----------------
async function fetchLive(force = false) {
  if (!force && Date.now() - lastLiveFetch < 4 * 60e3) return;
  lastLiveFetch = Date.now();
  const jobs: [string, () => Promise<live.LiveResult>][] = [
    ['weather', live.weather], ['mta', () => live.mta(transit)], ['events', () => live.events(transit)],
    ['traffic', live.traffic], ['airports', () => live.airports(st.proxy)], ['holidays', live.holidays],
  ];
  await Promise.all(jobs.map(async ([id, fn]) => {
    liveStatus.set(id, { id, name: liveStatus.get(id)?.name || id, state: 'loading', summary: 'Loading…' });
    let r: live.LiveResult;
    try { r = await fn(); } catch (e) { r = { status: { id, name: id, state: 'error', summary: String(e), fetchedAt: new Date() }, boosts: [] }; }
    liveStatus.set(id, r.status); liveBoosts.set(id, r.boosts);
    if (r.traffic) trafficLinks = r.traffic; if (r.events) eventItems = r.events;
    drawOverlays(); refresh();
  }));
}
function maybeFetchLive() { if (navigator.onLine !== false) fetchLive(); }

// ---------------- main loop ----------------
let busy = false, again = false;
async function refresh() {
  if (busy) { again = true; return; } busy = true;
  try { syncControls(); const rs = await paint(); await renderPanel(rs); drawOverlays(); } finally { busy = false; if (again) { again = false; refresh(); } }
}

async function boot() {
  initControls();
  [meta, geo, transit] = await Promise.all([fetch(DATA + 'meta.json').then(r => r.json()), fetch(DATA + 'zones.geojson').then(r => r.json()), fetch(DATA + 'transit.json').then(r => r.json())]);
  indexZones(geo);
  zoneLayer = L.geoJSON(geo, { onEachFeature: (f, layer) => layer.on('click', () => openZone(Number(f.id))) }).addTo(map);
  if (st.tab === 'near') startGeo();
  await refresh();
  if (q.get('zone')) openZone(+q.get('zone')!);
  if (q.get('nolive') !== '1') maybeFetchLive();
  // keep "Now" rolling and live data fresh while open
  setInterval(() => { if (st.isNow) { const p = nyParts(); if (p.h !== st.hour || p.dow !== st.dow) { setNow(); refresh(); } } if (document.visibilityState === 'visible') maybeFetchLive(); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (st.isNow) setNow(); maybeFetchLive(); refresh(); } });
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE }).catch(() => {});
}
boot();
