// On-device parser for WhatsApp "Export Chat" files (.txt or .zip). Nothing is uploaded anywhere.
import { unzipSync, strFromU8 } from 'fflate';
import type { ZoneMeta, Boost } from './types';

export interface ChatMsg { time: Date; author: string; text: string }
export interface ChatTip { time: Date; author: string; snippet: string; zones: number[]; tags: string[] }

// iOS:     [9/30/26, 10:15:32 PM] Name: text      Android: 9/30/26, 10:15 PM - Name: text   (also 24h, d/m/y)
const LINE = /^\u200e?\[?(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:-\s*)?([^:]{1,60}?):\s([\s\S]*)$/;

export async function readExport(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase().endsWith('.zip') || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const files = unzipSync(buf, { filter: f => f.name.toLowerCase().endsWith('.txt') });
    const name = Object.keys(files).sort((a, b) => (b.includes('_chat') ? 1 : 0) - (a.includes('_chat') ? 1 : 0))[0];
    if (!name) throw new Error('No .txt chat file found inside the zip');
    return strFromU8(files[name]);
  }
  return new TextDecoder().decode(buf);
}

export function parseChat(txt: string): ChatMsg[] {
  const lines = txt.replace(/\r/g, '').split('\n');
  const raw: { a: number; b: number; y: number; h: number; mi: number; s: number; ap?: string; author: string; text: string }[] = [];
  for (const ln of lines) {
    const m = LINE.exec(ln.replace(/[\u202f\u00a0]/g, ' '));
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      raw.push({ a: +m[1], b: +m[2], y, h: +m[4], mi: +m[5], s: +(m[6] || 0), ap: m[7]?.replace(/[\.\s]/g, '').toLowerCase(), author: m[8].replace(/^\u200e/, '').trim(), text: m[9] });
    } else if (raw.length && ln.trim()) raw[raw.length - 1].text += '\n' + ln;
  }
  // date order: if any first number > 12 => day/month
  const dayFirst = raw.some(r => r.a > 12 && r.a <= 31);
  return raw.map(r => {
    let h = r.h; if (r.ap === 'pm' && h < 12) h += 12; if (r.ap === 'am' && h === 12) h = 0;
    const mo = dayFirst ? r.b : r.a, d = dayFirst ? r.a : r.b;
    // chat timestamps are phone-local; we assume the phone is on NYC time
    return { time: new Date(r.y, mo - 1, d, h, r.mi, r.s), author: r.author, text: r.text.replace(/\u200e/g, '') };
  }).filter(m => !isNaN(+m.time));
}

const ALIASES: Record<string, number[]> = {
  jfk: [132], kennedy: [132], 'terminal 4': [132], t4: [132], 'terminal 8': [132], lga: [138], laguardia: [138], 'la guardia': [138], ewr: [1], newark: [1],
  msg: [186], 'madison square garden': [186], 'the garden': [186], penn: [186], 'penn station': [186], moynihan: [68], pabt: [48], 'port authority': [48],
  gct: [162], 'grand central': [162], barclays: [181], 'yankee stadium': [247], yankees: [247], 'citi field': [93], mets: [93], 'us open': [93],
  'times square': [230], 'times sq': [230], 'theater district': [230], 'theatre district': [230], broadway: [230], 'hells kitchen': [48], "hell's kitchen": [48],
  les: [148], 'lower east side': [148], 'east village': [79], meatpacking: [158], 'west village': [249], 'the village': [113, 114], williamsburg: [255, 256], wburg: [255, 256], bushwick: [36, 37],
  midtown: [161, 162, 163, 164], soho: [211], dumbo: [66], uws: [238, 239], 'upper west side': [238, 239], ues: [236, 237], 'upper east side': [236, 237],
  fidi: [87, 88], 'financial district': [87, 88], wtc: [261], 'world trade': [261], 'hudson yards': [246], javits: [246], 'lincoln center': [142, 143], 'radio city': [161],
  harlem: [41, 42], 'east harlem': [74, 75], chelsea: [68, 246], lic: [145, 146], 'long island city': [145, 146], astoria: [7, 179], flushing: [92], jamaica: [130],
  'downtown brooklyn': [65], 'park slope': [181], greenpoint: [112], tribeca: [231], seaport: [209], 'union square': [234], 'union sq': [234], 'murray hill': [170],
};
const KEYWORDS: Record<string, RegExp> = {
  busy: /\b(busy|packed|crazy|slammed|poppin|popping|nonstop|back to back|pinging|pings)\b/i,
  surge: /\b(surge|surging|boost|prime time|multiplier|\dx)\b/i,
  line: /\b(long line|line is|line at|the line|in line|queue|queued|holding lot|lot is|fifo)\b/i,
  'long trip': /\b(long trips?|long rides?|airport runs?|to the airport|jersey run|long island run|upstate)\b/i,
  dead: /\b(dead|slow|quiet|empty|nothing|no pings|no rides|dry)\b/i,
  police: /\b(police|cops?|nypd|tlc enforcement|ticket(?:ing)?|tow(?:ing)?|checkpoint)\b/i,
  traffic: /\b(traffic|jam(?:med)?|gridlock|backed up|bumper)\b/i,
  accident: /\b(accident|crash|collision|overturned)\b/i,
};
const POS = new Set(['busy', 'surge', 'line', 'long trip']);

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function buildMatcher(zones: Record<string, ZoneMeta>) {
  const dict: [RegExp, number[]][] = [];
  const generic = new Set(['north', 'south', 'east', 'west', 'park', 'heights', 'village', 'hill', 'center', 'beach', 'airport', 'square', 'island', 'point', 'city', 'bay', 'gardens', 'hills']);
  for (const [k, ids] of Object.entries(ALIASES)) dict.push([new RegExp(`\\b${esc(k)}\\b`, 'i'), ids]);
  for (const [id, z] of Object.entries(zones)) {
    for (const part of z.z.split(/[\/()]/).map(s => s.trim().toLowerCase()).filter(Boolean)) {
      if (part.length < 5 || generic.has(part)) continue;
      dict.push([new RegExp(`\\b${esc(part)}\\b`, 'i'), [+id]]);
    }
  }
  return (text: string) => {
    const found = new Set<number>();
    for (const [re, ids] of dict) if (re.test(text)) ids.forEach(i => found.add(i));
    return [...found];
  };
}

export function extractTips(msgs: ChatMsg[], match: (t: string) => number[], hours: number, ref: Date): ChatTip[] {
  const from = ref.getTime() - hours * 3600e3;
  const out: ChatTip[] = [];
  for (const m of msgs) {
    if (+m.time < from || +m.time > ref.getTime() + 60e3) continue;
    if (/<media omitted>|image omitted|video omitted|sticker omitted/i.test(m.text)) continue;
    const zones = match(m.text); if (!zones.length) continue;
    const tags = Object.entries(KEYWORDS).filter(([, re]) => re.test(m.text)).map(([k]) => k);
    out.push({ time: m.time, author: m.author, snippet: m.text.slice(0, 180), zones, tags });
  }
  return out.sort((a, b) => +b.time - +a.time);
}

export function tipBoosts(tips: ChatTip[]): Boost[] {
  const acc = new Map<number, { p: number; n: number }>();
  for (const t of tips) {
    const pos = t.tags.filter(x => POS.has(x)).length, neg = t.tags.includes('dead') ? 1 : 0;
    const d = (pos ? 0.05 : 0) - (neg ? 0.05 : 0);
    if (!d) continue;
    for (const z of t.zones) { const a = acc.get(z) || { p: 0, n: 0 }; a.p += d; a.n++; acc.set(z, a); }
  }
  return [...acc].map(([z, a]) => ({ zone: z, pct: Math.max(-0.1, Math.min(0.15, a.p)), label: `User-imported chat tips (${a.n} msg${a.n > 1 ? 's' : ''}) — unverified`, source: 'chat' }));
}
