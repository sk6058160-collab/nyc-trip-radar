// Minimal geo helpers: point-in-polygon + haversine (no deps)
type Ring = number[][];
interface ZoneGeom { id: number; bbox: [number, number, number, number]; polys: Ring[][] }
let zoneGeoms: ZoneGeom[] = [];

export function indexZones(fc: any) {
  zoneGeoms = fc.features.map((f: any) => {
    const polys: Ring[][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { id: Number(f.id), bbox: [x0, y0, x1, y1], polys };
  });
}
function inRing(x: number, y: number, r: Ring) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function zoneAt(lat: number, lon: number): number | null {
  for (const z of zoneGeoms) {
    const [x0, y0, x1, y1] = z.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    for (const p of z.polys) if (inRing(lon, lat, p[0]) && !p.slice(1).some(h => inRing(lon, lat, h))) return z.id;
  }
  return null;
}
export function miles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 3958.8, t = Math.PI / 180;
  const dLat = (lat2 - lat1) * t, dLon = (lon2 - lon1) * t;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
