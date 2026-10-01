export type Svc = 'all' | 'rideshare' | 'yellow' | 'green';
export type Mode = 'long' | 'medium' | 'short' | 'volume';
// [n, short%, medium%, long%, medMiles, medMinutes, medPayOrFare, payPerEngagedHour, airportBound%]
export type Cell = [number, number, number, number, number, number, number, number, number] | 0;
export interface ZoneMeta { b: string; z: string; sz: string; c: [number, number] }
export interface Meta {
  months: string[]; generated: string; dowOccurrences: number[];
  tripsBySvc: Record<string, number>; airports: number[]; zones: Record<string, ZoneMeta>;
}
export interface Boost {
  zone: number | null;      // null = citywide
  pct: number;              // +0.10 = +10%
  label: string;            // human explanation
  source: string;           // source id
  estimate?: boolean;       // rule-based estimate (not measured)
}
export interface SourceStatus {
  id: string; name: string; state: 'ok' | 'error' | 'idle' | 'na' | 'loading';
  fetchedAt?: Date; summary: string; detail?: string[]; url?: string; note?: string;
}
