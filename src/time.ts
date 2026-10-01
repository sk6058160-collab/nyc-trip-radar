export const TZ = 'America/New_York';
export const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export interface NyParts { y: number; mo: number; d: number; h: number; mi: number; dow: number; ymd: string }
export function nyParts(date = new Date()): NyParts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  const y = +p.year, mo = +p.month, d = +p.day;
  return { y, mo, d, h: +p.hour % 24, mi: +p.minute, dow: DOWS.indexOf(p.weekday), ymd: `${p.year}-${p.month}-${p.day}` };
}
/** Minutes since NY midnight for a Date */
export function nyMinutes(date: Date) { const p = nyParts(date); return p.h * 60 + p.mi; }
export function fmtTime(d?: Date) {
  if (!d) return '—';
  return d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) + ' ET';
}
export function hourLabel(h: number) { const s = h % 12 === 0 ? 12 : h % 12; return `${s}${h < 12 ? 'am' : 'pm'}`; }
/** "YYYY-MM-DDTHH:MM:SS" local NY string for Socrata queries */
export function nyIso(date: Date) {
  const p = nyParts(date); const pad = (n: number) => String(n).padStart(2, '0');
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, second: '2-digit' }).format(date);
  return `${p.ymd}T${pad(p.h)}:${pad(p.mi)}:${pad(+s || 0)}`;
}
/** Parse a Socrata floating timestamp (NY local, no zone) into a Date */
export function parseNyLocal(s: string): Date {
  const [d, t = '00:00:00'] = s.split('T');
  const [y, m, dd] = d.split('-').map(Number); const [hh, mm, ss] = t.split(':').map(x => parseFloat(x));
  // guess offset: try -4 and -5, pick the one that round-trips
  for (const off of [4, 5]) {
    const dt = new Date(Date.UTC(y, m - 1, dd, hh + off, mm, ss || 0));
    const p = nyParts(dt); if (p.h === hh && p.d === dd) return dt;
  }
  return new Date(Date.UTC(y, m - 1, dd, hh + 4, mm, ss || 0));
}
