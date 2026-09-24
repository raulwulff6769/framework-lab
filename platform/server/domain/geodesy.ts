// Geodesic computations on the WGS-84 ellipsoid (Karney's algorithms, GeographicLib): the same
// code measures distances and field areas on the server and in the map tools of the UI.
// default import: the package is UMD/CommonJS, so plain Node ESM (dev/server.ts on a VPS) has no named exports
import geographiclib from 'geographiclib-geodesic';

const G = geographiclib.Geodesic.WGS84;

export function geodesicM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return G.Inverse(lat1, lon1, lat2, lon2).s12 ?? 0;
}

/** Length of a polyline given as [lon, lat] pairs (GeoJSON order). */
export function polylineM(coords: Array<[number, number]>): number {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += geodesicM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return s;
}

/** Area (m²) and perimeter (m) of a simple polygon ring given as [lon, lat] pairs. */
export function polygonArea(ring: Array<[number, number]>): { areaM2: number; perimeterM: number } {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return { areaM2: 0, perimeterM: polylineM(pts) };
  const p = G.Polygon(false);
  for (const [lon, lat] of pts) p.AddPoint(lat, lon);
  const r = p.Compute(false, true);
  return { areaM2: Math.abs(r.area ?? 0), perimeterM: r.perimeter };
}

export function validRing(v: unknown): v is Array<[number, number]> {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    v.length <= 5000 &&
    v.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)
  );
}
