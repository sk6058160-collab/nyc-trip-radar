// Rule-based time-window boosts. These are ESTIMATES based on well-known NYC patterns
// (show let-outs, bar close), NOT measured data. Shown with an "estimate" tag in the UI.
import type { Boost } from './types';

interface Rule { name: string; days: number[]; start: number; end: number; zones: number[]; pct: number; why: string }
// days: 0=Sun..6=Sat, start/end in minutes after midnight (same day)
const RULES: Rule[] = [
  { name: 'Broadway evening let-out', days: [0, 2, 3, 4, 5, 6], start: 21 * 60 + 45, end: 23 * 60 + 30, zones: [230, 161, 163, 48, 100, 164], pct: 0.15,
    why: 'Most Broadway evening shows start 7–8pm and end ~10–11pm (Tue–Sun).' },
  { name: 'Broadway matinee let-out', days: [0, 3, 6], start: 16 * 60 + 30, end: 17 * 60 + 45, zones: [230, 161, 163, 48], pct: 0.10,
    why: 'Wed/Sat/Sun matinees (2–3pm) typically end ~4:30–5:30pm.' },
  { name: 'Lincoln Center let-out', days: [0, 2, 3, 4, 5, 6], start: 22 * 60, end: 23 * 60 + 15, zones: [142, 143], pct: 0.08,
    why: 'Opera/ballet/concerts at Lincoln Center usually end ~10–11pm.' },
  { name: 'Bar / club close window', days: [6, 0], start: 2 * 60, end: 4 * 60 + 30, zones: [148, 79, 144, 158, 249, 113, 114, 234, 255, 256, 80, 36, 37, 232, 45], pct: 0.20,
    why: 'Fri & Sat nights: NYC last call is 4am; heavy outflow 2–4:30am in LES, East Village, Meatpacking, West Village, Williamsburg, Bushwick.' },
  { name: 'Late-night nightlife (weeknight)', days: [4, 5], start: 0, end: 2 * 60, zones: [148, 79, 158, 249, 255], pct: 0.06,
    why: 'Thu/Fri after-midnight nightlife (milder than weekend close).' },
];

export function ruleBoosts(dow: number, hour: number, minute = 30): Boost[] {
  const t = hour * 60 + minute;
  const out: Boost[] = [];
  for (const r of RULES) {
    if (!r.days.includes(dow)) continue;
    // treat the selected hour as active if the window overlaps it at all
    const hs = hour * 60, he = hs + 59;
    const active = minute >= 0 ? (t >= r.start && t <= r.end) || (r.start <= he && r.end >= hs) : false;
    if (!active) continue;
    for (const z of r.zones) out.push({ zone: z, pct: r.pct, label: `${r.name} (est.) — ${r.why}`, source: 'rules', estimate: true });
  }
  return out;
}
export const RULE_LIST = RULES;
