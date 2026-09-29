import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, X } from 'lucide-react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 loads its worker from a sibling file; let Vite bundle it (with the shared chunk) and pass the URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { ago } from './api';
import { getTheme, useTheme, type Theme } from './theme';

export function Fresh({ f, t }: { f: string; t: number | null }) {
  const cls =
    f === 'online' ? 'bg-success/10 text-success' : f === 'recent' ? 'bg-warning/10 text-warning' : f === 'stale' ? 'bg-danger/10 text-danger' : 'bg-muted text-muted-foreground';
  const dot = f === 'online' ? 'bg-success' : f === 'recent' ? 'bg-warning' : f === 'stale' ? 'bg-danger' : 'bg-muted-foreground';
  return (
    <span className={`badge whitespace-nowrap ${cls}`} title={t ? new Date(t).toLocaleString('ru-RU') : ''}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" /> {ago(t)}
    </span>
  );
}

// Open dialogs, innermost last: only the top one reacts to Escape and traps Tab.
const dialogStack: object[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focus in on open, trap Tab, close on Escape, lock page scroll, restore focus on close. */
export function useDialog(panel: React.RefObject<HTMLElement | null>, onClose: () => void, initialFocus = true) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const token = {};
    dialogStack.push(token);
    const previous = document.activeElement as HTMLElement | null;
    if (initialFocus) panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token || !panel.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      } else if (e.key === 'Tab') {
        const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!items.length) return e.preventDefault();
        const first = items[0];
        const last = items[items.length - 1];
        const inside = panel.current.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', onKey);
      dialogStack.splice(dialogStack.indexOf(token), 1);
      document.body.style.overflow = overflow;
      previous?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose);
  return (
    <div className="backdrop-in fixed inset-0 z-[2000] flex items-end justify-center bg-black/55 backdrop-blur-[3px] sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="card dialog-in max-h-[92svh] w-full max-w-lg overflow-y-auto rounded-b-none px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-[var(--shadow-pop)] outline-none sm:rounded-b-[16px] sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h3 id={titleId} className="min-w-0 pt-1 text-lg leading-snug font-bold break-words">
            {title}
          </h3>
          <button className="-mt-1 -mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={onClose} aria-label="Закрыть">
            <X className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorLine({ e }: { e: unknown }) {
  if (!e) return null;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
      <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span className="min-w-0 break-words">{(e as Error).message ?? String(e)}</span>
    </div>
  );
}

/** A single shimmering placeholder block; height/width come from className/style. */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <span className={`skeleton block ${className}`} style={style} aria-hidden="true" />;
}

/** Placeholder table rows shown while data loads — holds the layout so the table never flashes empty. */
export function SkeletonRows({ rows = 6, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-b border-border last:border-0" aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-4 py-3.5">
              <Skeleton className="h-3.5" style={{ width: c === 0 ? '65%' : `${38 + ((r + c) % 3) * 9}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: null, error, loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  label: string;
  color: string;
}

// OpenFreeMap: OpenStreetMap vector tiles, free incl. commercial use, no keys (openfreemap.org).
const MAP_STYLE: Record<Theme, string> = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
};

function addOverlay(m: MlMap, theme: Theme, onPick: (id: string) => void) {
  const style = m.getStyle();
  const bg = style.layers.find((l) => l.type === 'background');
  if (bg && theme === 'dark') m.setPaintProperty(bg.id, 'background-color', '#000000');
  for (const l of style.layers as any[]) {
    // Russian labels everywhere (OSM name:ru, falling back to the local name); road refs stay as they are
    const tf = l.layout?.['text-field'];
    if (l.type === 'symbol' && tf && !JSON.stringify(tf).includes('"ref"'))
      m.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ru'], ['get', 'name']]);
    // disputed boundary segments are not drawn
    if (l.type === 'line' && l.id.includes('boundary')) {
      if (l.id.includes('disputed')) m.setLayoutProperty(l.id, 'visibility', 'none');
      else if (l.filter) m.setFilter(l.id, ['all', l.filter, ['!=', ['get', 'disputed'], 1]] as any);
    }
  }
  const empty = { type: 'FeatureCollection' as const, features: [] };
  m.addSource('itles-track', { type: 'geojson', data: empty });
  m.addSource('itles-points', { type: 'geojson', data: empty });
  m.addLayer({
    id: 'itles-track',
    type: 'line',
    source: 'itles-track',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#e78a53', 'line-width': 3, 'line-opacity': 0.9 },
  });
  m.addLayer({
    id: 'itles-points',
    type: 'circle',
    source: 'itles-points',
    paint: {
      'circle-radius': 7,
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': theme === 'dark' ? '#000000' : '#ffffff',
    },
  });
  m.addLayer({
    id: 'itles-labels',
    type: 'symbol',
    source: 'itles-points',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': theme === 'dark' ? '#ededed' : '#111827',
      'text-halo-color': theme === 'dark' ? '#000000' : '#ffffff',
      'text-halo-width': 1.5,
    },
  });
  m.on('click', 'itles-points', (e) => {
    const id = e.features?.[0]?.properties?.id;
    if (id) onPick(String(id));
  });
  m.on('mouseenter', 'itles-points', () => (m.getCanvas().style.cursor = 'pointer'));
  m.on('mouseleave', 'itles-points', () => (m.getCanvas().style.cursor = ''));
}

export function MapView({ markers, track, height = 420, onPick }: { markers?: MapMarker[]; track?: Array<[number, number]>; height?: number; onPick?: (id: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const fitted = useRef('');
  const [theme] = useTheme();
  const [styleGen, setStyleGen] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) {
      setFailed(true);
      return;
    }
    import('maplibre-gl').then((ml) => {
      if (cancelled || !el.current) return;
      ml.setWorkerUrl(maplibreWorkerUrl);
      let m: MlMap;
      try {
        m = new ml.Map({
        container: el.current,
        style: MAP_STYLE[getTheme()],
        center: [37.6, 61],
        zoom: 3,
        attributionControl: { compact: true },
        });
      } catch {
        setFailed(true);
        return;
      }
      m.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
      m.addControl(new ml.FullscreenControl(), 'top-right');
      m.addControl(new ml.ScaleControl({ unit: 'metric' }), 'bottom-left');
      m.on('style.load', () => {
        addOverlay(m, document.documentElement.classList.contains('dark') ? 'dark' : 'light', (id) => pick.current?.(id));
        setStyleGen((g) => g + 1);
      });
      map.current = m;
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (map.current && styleGen > 0) map.current.setStyle(MAP_STYLE[theme]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    const m = map.current;
    if (!m || styleGen === 0 || !m.getSource('itles-points')) return;
    const pts = markers ?? [];
    (m.getSource('itles-points') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { id: p.id, label: p.label, color: p.color } })),
    });
    const line = (track ?? []).map(([lat, lon]) => [lon, lat]);
    (m.getSource('itles-track') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: line.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} }] : [],
    });
    const all = [...line, ...pts.map((p) => [p.lon, p.lat])];
    const key = all.length ? `${all.length}:${all[0]}:${all[all.length - 1]}` : '';
    if (!all.length || key === fitted.current) return;
    fitted.current = key;
    if (all.length === 1) m.jumpTo({ center: all[0] as [number, number], zoom: 13 });
    else {
      const lons = all.map((c) => c[0]);
      const lats = all.map((c) => c[1]);
      m.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 48, maxZoom: 15, duration: 0 },
      );
    }
  }, [markers, track, styleGen]);

  if (failed)
    return (
      <div style={{ height: Math.min(height, 160) }} className="flex w-full items-center justify-center rounded-xl border border-border bg-card px-6 text-center text-sm text-muted-foreground">
        Карта требует WebGL2: включите аппаратное ускорение в настройках браузера. Координаты доступны в таблице.
      </div>
    );
  return <div ref={el} style={{ height }} className="w-full overflow-hidden rounded-xl border border-border" />;
}

/** Async chart body: skeleton while loading, honest error+retry on failure, empty state only when data truly arrived empty. */
export function AsyncChart({ loading, error, empty, onRetry, children, height = 'h-40' }: { loading: boolean; error: unknown; empty: boolean; onRetry?: () => void; children: React.ReactNode; height?: string }) {
  if (loading) return <Skeleton className={`${height} w-full`} />;
  if (error)
    return (
      <div className={`flex ${height} w-full flex-col items-center justify-center gap-2`}>
        <ErrorLine e={error} />
        <button type="button" className="text-sm font-semibold underline underline-offset-4" onClick={onRetry}>Повторить</button>
      </div>
    );
  if (empty) return <div className={`flex ${height} items-center justify-center text-sm text-muted-foreground`}>нет данных за период</div>;
  return <>{children}</>;
}

// Daily series are never squeezed into unreadable slivers: each day gets a minimum slot, and when the
// card is narrower than the series the track scrolls horizontally instead (thin dark scrollbar comes
// from the global base rule). On wide cards flex-1 still stretches the track to full width, so the
// desktop look is unchanged.
const DAY_MIN = 16;

export function Bars({ data, unit, color = 'var(--primary)' }: { data: Array<{ label: string; value: number | null }>; unit: string; color?: string }) {
  const max = Math.max(1e-9, ...data.map((d) => d.value ?? 0));
  if (!data.some((d) => d.value)) return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">нет данных за период</div>;
  return (
    <div className="overflow-x-auto pb-1">
      <div style={{ minWidth: data.length * DAY_MIN }}>
        {/* h-full gives the % bar a definite height to resolve against (items-end alone collapses it to content) */}
        <div className="flex h-40 items-end gap-1">
          {data.map((d) => (
            <div key={d.label} className="flex h-full flex-1 flex-col justify-end" title={`${d.label}: ${d.value === null ? 'нет данных' : d.value.toFixed(1) + ' ' + unit}`}>
              <div className="w-full rounded-t" style={{ height: `${((d.value ?? 0) / max) * 100}%`, minHeight: d.value ? 2 : 0, background: color }} />
            </div>
          ))}
        </div>
        {/* day labels sit below the track inside the same scrolling box: keeping them out of the column
            stops a full-height bar from overflowing past the card top, and scrolling keeps them aligned
            with their bars instead of overlapping when the card is narrow */}
        <div className="mt-1 flex gap-1">
          {data.map((d) => (
            <div key={d.label} className="flex-1 text-center text-[10px] text-muted-foreground">{d.label.slice(8)}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
