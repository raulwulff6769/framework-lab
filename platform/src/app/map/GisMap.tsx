// Professional map: base layers (scheme / satellite / hybrid / topo / 3D relief), geodesic ruler and
// area tools on the WGS-84 ellipsoid, cursor coordinates, scale bar, fullscreen, geofences, tracks
// coloured by speed, stops and a moving cursor for the timeline.
import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Crosshair, Layers, Maximize2, Mountain, Ruler, Square, Trash2 } from 'lucide-react';
import { geodesicM, polygonArea } from '../../../server/domain/geodesy';
import { getTheme, useTheme } from '../theme';

export interface GisMarker {
  id: string;
  lat: number;
  lon: number;
  label: string;
  color: string;
  course?: number | null;
}
export interface GisGeofence {
  id: string;
  name: string;
  kind: string;
  area_ha: number | null;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
}
export interface TrackPoint {
  t: number;
  lat: number;
  lon: number;
  speed: number | null;
}

type Base = 'scheme' | 'satellite' | 'hybrid' | 'topo';
const BASES: Array<{ id: Base; label: string }> = [
  { id: 'scheme', label: 'Схема' },
  { id: 'satellite', label: 'Спутник' },
  { id: 'hybrid', label: 'Гибрид' },
  { id: 'topo', label: 'Топокарта' },
];
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR = 'Снимки © Esri, Maxar, Earthstar Geographics';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

function rasterStyle(tiles: string[], attribution: string, maxzoom: number): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

function styleFor(base: Base): string | StyleSpecification {
  const theme = getTheme();
  if (base === 'scheme') return theme === 'dark' ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/liberty';
  if (base === 'satellite') return rasterStyle([ESRI_IMAGERY], ESRI_ATTR, 19);
  if (base === 'topo')
    return rasterStyle(
      ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
      '© OpenTopoMap (CC-BY-SA), © участники OpenStreetMap',
      17,
    );
  return 'https://tiles.openfreemap.org/styles/liberty';
}

const EMPTY = { type: 'FeatureCollection' as const, features: [] as any[] };

function localize(m: MlMap, base: Base) {
  const style = m.getStyle();
  if (base === 'hybrid') {
    // satellite under the vector roads and Russian labels of the OSM style
    m.addSource('sat', { type: 'raster', tiles: [ESRI_IMAGERY], tileSize: 256, attribution: ESRI_ATTR, maxzoom: 19 });
    const first = style.layers.find((l) => l.type !== 'background')?.id;
    m.addLayer({ id: 'sat', type: 'raster', source: 'sat' }, first);
    for (const l of style.layers as any[]) {
      if (l.type === 'fill' || l.type === 'fill-extrusion' || l.type === 'background') m.setLayoutProperty(l.id, 'visibility', 'none');
      if (l.type === 'symbol') {
        m.setPaintProperty(l.id, 'text-color', '#ffffff');
        m.setPaintProperty(l.id, 'text-halo-color', 'rgba(0,0,0,0.85)');
      }
    }
  }
  for (const l of style.layers as any[]) {
    const tf = l.layout?.['text-field'];
    if (l.type === 'symbol' && tf && !JSON.stringify(tf).includes('"ref"'))
      m.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ru'], ['get', 'name']]);
    if (l.type === 'line' && l.id.includes('boundary')) {
      if (l.id.includes('disputed')) m.setLayoutProperty(l.id, 'visibility', 'none');
      else if (l.filter) m.setFilter(l.id, ['all', l.filter, ['!=', ['get', 'disputed'], 1]] as any);
    }
  }
}

function addOverlays(m: MlMap, dark: boolean) {
  const halo = dark ? '#000000' : '#ffffff';
  const text = dark ? '#ededed' : '#111827';
  for (const id of ['gf', 'track', 'stops', 'points', 'cursor', 'tool']) m.addSource(`i-${id}`, { type: 'geojson', data: EMPTY });
  m.addLayer({ id: 'i-gf-fill', type: 'fill', source: 'i-gf', paint: { 'fill-color': ['match', ['get', 'kind'], 'field', '#16a34a', 'forest', '#15803d', 'quarry', '#a16207', 'site', '#7c3aed', '#0ea5e9'], 'fill-opacity': 0.14 } });
  m.addLayer({ id: 'i-gf-line', type: 'line', source: 'i-gf', paint: { 'line-color': ['match', ['get', 'kind'], 'field', '#16a34a', 'forest', '#15803d', 'quarry', '#a16207', 'site', '#7c3aed', '#0ea5e9'], 'line-width': 1.5, 'line-dasharray': [3, 2] } });
  m.addLayer({ id: 'i-gf-label', type: 'symbol', source: 'i-gf', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11 }, paint: { 'text-color': text, 'text-halo-color': halo, 'text-halo-width': 1.4 } });
  m.addLayer({
    id: 'i-track',
    type: 'line',
    source: 'i-track',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': 3.5,
      'line-opacity': 0.9,
      'line-color': ['case', ['==', ['get', 'speed'], null], '#e78a53', ['interpolate', ['linear'], ['get', 'speed'], 0, '#64748b', 3, '#22c55e', 12, '#eab308', 30, '#f97316', 60, '#dc2626']],
    },
  });
  m.addLayer({ id: 'i-stops', type: 'circle', source: 'i-stops', paint: { 'circle-radius': 6, 'circle-color': '#1f6feb', 'circle-stroke-color': halo, 'circle-stroke-width': 2 } });
  m.addLayer({ id: 'i-stops-label', type: 'symbol', source: 'i-stops', minzoom: 11, layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' }, paint: { 'text-color': text, 'text-halo-color': halo, 'text-halo-width': 1.4 } });
  m.addLayer({ id: 'i-points', type: 'circle', source: 'i-points', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-color': halo } });
  m.addLayer({ id: 'i-labels', type: 'symbol', source: 'i-points', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': text, 'text-halo-color': halo, 'text-halo-width': 1.5 } });
  m.addLayer({ id: 'i-cursor', type: 'circle', source: 'i-cursor', paint: { 'circle-radius': 9, 'circle-color': '#e11d48', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' } });
  m.addLayer({ id: 'i-cursor-dir', type: 'symbol', source: 'i-cursor', layout: { 'text-field': '▲', 'text-size': 13, 'text-rotate': ['get', 'course'], 'text-rotation-alignment': 'map', 'text-allow-overlap': true, 'text-offset': [0, -1.25] }, paint: { 'text-color': '#e11d48', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  m.addLayer({ id: 'i-tool-fill', type: 'fill', source: 'i-tool', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.18 } });
  m.addLayer({ id: 'i-tool-line', type: 'line', source: 'i-tool', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#f59e0b', 'line-width': 2.5 } });
  m.addLayer({ id: 'i-tool-pt', type: 'circle', source: 'i-tool', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4.5, 'circle-color': '#ffffff', 'circle-stroke-color': '#f59e0b', 'circle-stroke-width': 2.5 } });
  m.addLayer({ id: 'i-tool-label', type: 'symbol', source: 'i-tool', filter: ['==', ['geometry-type'], 'Point'], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -1.3], 'text-allow-overlap': true }, paint: { 'text-color': '#111827', 'text-halo-color': '#fde68a', 'text-halo-width': 2 } });
}

export const fmtDist = (m: number) => (m < 1000 ? `${m.toFixed(1)} м` : `${(m / 1000).toFixed(m < 10000 ? 3 : 2)} км`);
export const fmtArea = (m2: number) => (m2 < 10000 ? `${m2.toFixed(0)} м²` : `${(m2 / 1e4).toFixed(2)} га${m2 >= 1e6 ? ` (${(m2 / 1e6).toFixed(3)} км²)` : ''}`);

function dms(v: number, pos: string, neg: string) {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const mm = Math.floor((a - d) * 60);
  const s = ((a - d) * 60 - mm) * 60;
  return `${d}°${String(mm).padStart(2, '0')}′${s.toFixed(2).padStart(5, '0')}″${v >= 0 ? pos : neg}`;
}

export function GisMap({
  markers = [],
  track = [],
  stops = [],
  geofences = [],
  cursor = null,
  follow = false,
  height = 420,
  onPick,
  onSaveArea,
  fitKey,
}: {
  markers?: GisMarker[];
  track?: TrackPoint[];
  stops?: Array<{ from: number; to: number; lat: number; lon: number }>;
  geofences?: GisGeofence[];
  cursor?: { lat: number; lon: number; course: number | null } | null;
  follow?: boolean;
  height?: number;
  onPick?: (id: string) => void;
  onSaveArea?: (ring: Array<[number, number]>, areaM2: number) => void;
  fitKey?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [theme] = useTheme();
  const [base, setBase] = useState<Base>('scheme');
  const [relief, setRelief] = useState(false);
  const [gen, setGen] = useState(0);
  const [failed, setFailed] = useState(false);
  const [tool, setTool] = useState<'none' | 'ruler' | 'area'>('none');
  const [pts, setPts] = useState<Array<[number, number]>>([]);
  const [coord, setCoord] = useState<{ lat: number; lon: number } | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [showGf, setShowGf] = useState(true);
  const pick = useRef(onPick);
  pick.current = onPick;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const fitted = useRef('');

  useEffect(() => {
    let cancelled = false;
    if (!document.createElement('canvas').getContext('webgl2')) {
      setFailed(true);
      return;
    }
    import('maplibre-gl').then((ml) => {
      if (cancelled || !el.current) return;
      ml.setWorkerUrl(maplibreWorkerUrl);
      let m: MlMap;
      try {
        m = new ml.Map({ container: el.current, style: styleFor('scheme'), center: [37.6, 58], zoom: 3, attributionControl: { compact: true }, doubleClickZoom: true });
      } catch {
        setFailed(true);
        return;
      }
      m.addControl(new ml.NavigationControl({ visualizePitch: true }), 'top-right');
      m.addControl(new ml.ScaleControl({ unit: 'metric', maxWidth: 140 }), 'bottom-left');
      m.on('style.load', () => setGen((g) => g + 1));
      m.on('mousemove', (e: MapMouseEvent) => setCoord({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
      m.on('click', (e: MapMouseEvent) => {
        if (toolRef.current !== 'none') {
          setPts((p) => [...p, [e.lngLat.lng, e.lngLat.lat]]);
          return;
        }
        const f = m.queryRenderedFeatures(e.point, { layers: ['i-points'] })[0];
        const id = f?.properties?.id;
        if (id && pick.current) pick.current(String(id));
      });
      m.on('mouseenter', 'i-points', () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', 'i-points', () => (m.getCanvas().style.cursor = ''));
      map.current = m;
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // base layer or theme change → new style; overlays are re-added on style.load
  const firstStyle = useRef(true);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (firstStyle.current && base === 'scheme') {
      firstStyle.current = false;
      return;
    }
    firstStyle.current = false;
    m.setStyle(styleFor(base) as any);
  }, [base, theme]);

  useEffect(() => {
    const m = map.current;
    if (!m || gen === 0) return;
    if (!m.getSource('i-points')) {
      localize(m, base);
      addOverlays(m, getTheme() === 'dark' && base === 'scheme');
    }
    if (relief) {
      if (!m.getSource('dem')) {
        m.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Рельеф: Mapzen/AWS Terrain Tiles (SRTM, GMTED)' });
        m.addSource('dem-hs', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
        m.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-hs', paint: { 'hillshade-exaggeration': 0.45 } }, 'i-gf-fill');
      }
      m.setTerrain({ source: 'dem', exaggeration: 1.4 });
      if (m.getPitch() < 30) m.easeTo({ pitch: 55, duration: 600 });
    } else if (m.getSource('dem')) {
      m.setTerrain(null as any);
      if (m.getLayer('hillshade')) m.removeLayer('hillshade');
      m.removeSource('dem-hs');
      m.removeSource('dem');
      m.easeTo({ pitch: 0, duration: 400 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, relief]);

  useEffect(() => {
    const m = map.current;
    if (!m || gen === 0 || !m.getSource('i-points')) return;
    (m.getSource('i-points') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: markers.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { id: p.id, label: p.label, color: p.color } })),
    });
    const segs: any[] = [];
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1];
      const b = track[i];
      if (b.t - a.t > 30 * 60e3) continue; // gap in data: do not draw a straight jump
      segs.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }, properties: { speed: a.speed } });
    }
    (m.getSource('i-track') as GeoJSONSource).setData({ type: 'FeatureCollection', features: segs });
    (m.getSource('i-stops') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: stops.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: { label: `стоянка ${Math.round((s.to - s.from) / 60e3)} мин` },
      })),
    });
    (m.getSource('i-gf') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: showGf
        ? geofences.map((g) => ({ type: 'Feature', geometry: g.geometry, properties: { kind: g.kind, label: `${g.name}${g.area_ha ? ` · ${g.area_ha.toFixed(1)} га` : ''}` } }))
        : [],
    });
    const all = [...track.map((p) => [p.lon, p.lat]), ...markers.map((p) => [p.lon, p.lat])];
    const key = fitKey ?? (all.length ? `${all.length}:${all[0]}:${all[all.length - 1]}` : '');
    if (all.length && key !== fitted.current) {
      fitted.current = key;
      if (all.length === 1) m.jumpTo({ center: all[0] as [number, number], zoom: 13 });
      else {
        const lons = all.map((c) => c[0]);
        const lats = all.map((c) => c[1]);
        m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 48, maxZoom: 15, duration: 0 });
      }
    }
  }, [markers, track, stops, geofences, showGf, gen, fitKey]);

  useEffect(() => {
    const m = map.current;
    if (!m || gen === 0 || !m.getSource('i-cursor')) return;
    (m.getSource('i-cursor') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: cursor ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [cursor.lon, cursor.lat] }, properties: { course: cursor.course ?? 0 } }] : [],
    });
    if (cursor && follow) m.easeTo({ center: [cursor.lon, cursor.lat], duration: 250 });
  }, [cursor, follow, gen]);

  // measurement geometry with running totals at every vertex
  const segLens = pts.map((p, i) => (i ? geodesicM(pts[i - 1][1], pts[i - 1][0], p[1], p[0]) : 0));
  const total = segLens.reduce((a, b) => a + b, 0);
  const area = tool === 'area' && pts.length >= 3 ? polygonArea([...pts, pts[0]]) : null;
  useEffect(() => {
    const m = map.current;
    if (!m || gen === 0 || !m.getSource('i-tool')) return;
    const features: any[] = [];
    let acc = 0;
    pts.forEach((p, i) => {
      acc += segLens[i];
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { label: tool === 'ruler' && i > 0 ? fmtDist(acc) : '' } });
    });
    if (pts.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: tool === 'area' && pts.length >= 3 ? [...pts, pts[0]] : pts }, properties: {} });
    if (tool === 'area' && pts.length >= 3) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] }, properties: {} });
    (m.getSource('i-tool') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    m.doubleClickZoom[tool === 'none' ? 'enable' : 'disable']();
    m.getCanvas().style.cursor = tool === 'none' ? '' : 'crosshair';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, tool, gen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPts([]);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const toggleTool = (t: 'ruler' | 'area') => {
    setPts([]);
    setTool(tool === t ? 'none' : t);
  };
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : box.current?.requestFullscreen());

  if (failed)
    return (
      <div style={{ height: Math.min(height, 160) }} className="flex w-full items-center justify-center rounded-xl border border-border bg-card px-6 text-center text-sm text-muted-foreground">
        Карта требует WebGL2: включите аппаратное ускорение в настройках браузера.
      </div>
    );
  const btn = (active: boolean) => `flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium shadow-sm ${active ? 'bg-primary text-primary-foreground' : 'bg-card/95 text-foreground hover:bg-accent'}`;
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-xl border border-border bg-card" style={{ height }}>
      {/* maplibre-gl.css turns the container into position: relative, so inset-0 alone collapses it to 0 px */}
      <div ref={el} className="absolute inset-0 h-full w-full" />
      <div className="absolute left-2 top-2 z-10 flex flex-wrap gap-1">
        <button className={btn(layersOpen)} onClick={() => setLayersOpen(!layersOpen)} title="Слои карты">
          <Layers className="h-3.5 w-3.5" /> {BASES.find((b) => b.id === base)?.label}
        </button>
        <button className={btn(tool === 'ruler')} onClick={() => toggleTool('ruler')} title="Линейка: щёлкайте по карте; Esc — сброс">
          <Ruler className="h-3.5 w-3.5" /> Линейка
        </button>
        <button className={btn(tool === 'area')} onClick={() => toggleTool('area')} title="Площадь: обведите участок; Esc — сброс">
          <Square className="h-3.5 w-3.5" /> Площадь
        </button>
        <button className={btn(relief)} onClick={() => setRelief(!relief)} title="3D-рельеф (SRTM)">
          <Mountain className="h-3.5 w-3.5" /> 3D
        </button>
        <button className={btn(false)} onClick={fullscreen} title="Во весь экран">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {layersOpen && (
        <div className="absolute left-2 top-12 z-10 w-56 space-y-2 rounded-lg border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur">
          <div className="font-semibold">Подложка</div>
          {BASES.map((b) => (
            <label key={b.id} className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={base === b.id} onChange={() => setBase(b.id)} /> {b.label}
            </label>
          ))}
          <div className="pt-1 font-semibold">Слои</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showGf} onChange={(e) => setShowGf(e.target.checked)} /> Геозоны ({geofences.length})
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={relief} onChange={(e) => setRelief(e.target.checked)} /> Рельеф и отмывка (3D)
          </label>
          <div className="pt-1 text-[10px] leading-snug text-muted-foreground">
            Схема: OpenStreetMap (OpenFreeMap). Спутник: Esri World Imagery — демонстрационный слой, для коммерческой эксплуатации нужна лицензия поставщика.
          </div>
        </div>
      )}
      {tool !== 'none' && (
        <div className="absolute right-12 top-2 z-10 w-60 rounded-lg border border-warning/50 bg-card/95 p-3 text-xs shadow-lg">
          <div className="font-semibold">{tool === 'ruler' ? 'Линейка (геодезическое расстояние, WGS-84)' : 'Площадь (эллипсоид WGS-84)'}</div>
          {tool === 'ruler' ? (
            <div className="mt-1 text-lg font-bold tabular-nums">{fmtDist(total)}</div>
          ) : area ? (
            <div className="mt-1 space-y-0.5">
              <div className="text-lg font-bold tabular-nums">{fmtArea(area.areaM2)}</div>
              <div className="text-muted-foreground">периметр {fmtDist(area.perimeterM)}</div>
            </div>
          ) : (
            <div className="mt-1 text-muted-foreground">Поставьте не меньше трёх точек</div>
          )}
          <div className="mt-1 text-muted-foreground">Точек: {pts.length}. Щелчок — точка, Esc — сброс.</div>
          <div className="mt-2 flex flex-wrap gap-1">
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPts(pts.slice(0, -1))} disabled={!pts.length}>
              ← Отменить точку
            </button>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPts([])}>
              <Trash2 className="h-3 w-3" />
            </button>
            {tool === 'area' && area && onSaveArea && (
              <button className="btn-primary px-2 py-1 text-xs" onClick={() => onSaveArea([...pts, pts[0]], area.areaM2)}>
                Сохранить как геозону
              </button>
            )}
          </div>
        </div>
      )}
      {coord && (
        <button
          className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 rounded-md bg-card/90 px-2 py-1 font-mono text-[11px] tabular-nums text-foreground shadow-sm"
          title="Координаты курсора, WGS-84. Щелчок — скопировать"
          onClick={() => navigator.clipboard?.writeText(`${coord.lat.toFixed(6)}, ${coord.lon.toFixed(6)}`)}
        >
          <Crosshair className="h-3 w-3" />
          {coord.lat.toFixed(6)}, {coord.lon.toFixed(6)} · {dms(coord.lat, 'N', 'S')} {dms(coord.lon, 'E', 'W')}
        </button>
      )}
    </div>
  );
}
