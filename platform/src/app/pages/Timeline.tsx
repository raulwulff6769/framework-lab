// Machine history with a time slider: the marker on the map, the values panel and the charts all
// show the same moment. Positions are interpolated between fixes; sensor values are the last sample
// not older than 15 minutes (as a dispatcher would read them from the tracker archive).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { api, apiBase, fmt } from '../api';
import { ErrorLine, useAsync } from '../ui';
import { GisMap, type GisGeofence } from '../map/GisMap';
import { SENSORS } from '../../../server/domain/sensors';

type Row = [number, number, number, number | null, number | null];
type Pt = [number, number];

const SPEEDS = [1, 10, 60, 300, 1800];
const STALE = 15 * 60e3;

function lastIdx(arr: Array<{ 0: number }>, t: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  if (hi < 0 || arr[0][0] > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function valueAt(series: Pt[] | undefined, t: number): number | null {
  if (!series?.length) return null;
  const i = lastIdx(series, t);
  if (i < 0 || t - series[i][0] > STALE) return null;
  return series[i][1];
}

function interpCounter(series: Pt[] | undefined, t: number): number | null {
  if (!series?.length) return null;
  const i = lastIdx(series, t);
  if (i < 0) return null;
  const a = series[i];
  const b = series[i + 1];
  if (!b) return t - a[0] > STALE ? null : a[1];
  return a[1] + ((b[1] - a[1]) * (t - a[0])) / Math.max(1, b[0] - a[0]);
}

function positionAt(pos: Row[], t: number) {
  const i = lastIdx(pos, t);
  if (i < 0) return null;
  const a = pos[i];
  const b = pos[i + 1];
  if (!b || b[0] - a[0] > 30 * 60e3) return t - a[0] > STALE ? { lat: a[1], lon: a[2], speed: 0, course: a[4], stale: true } : { lat: a[1], lon: a[2], speed: a[3], course: a[4], stale: false };
  const k = (t - a[0]) / Math.max(1, b[0] - a[0]);
  return { lat: a[1] + (b[1] - a[1]) * k, lon: a[2] + (b[2] - a[2]) * k, speed: a[3], course: a[4], stale: false };
}

function Chart({ points, from, to, t, unit, color, label, onSeek, digits = 0 }: { points: Pt[]; from: number; to: number; t: number; unit: string; color: string; label: string; onSeek: (t: number) => void; digits?: number }) {
  const W = 600;
  const H = 70;
  const vals = points.map((p) => p[1]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (tt: number) => ((tt - from) / Math.max(1, to - from)) * W;
  const y = (v: number) => H - 4 - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 10);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const now = valueAt(points, t);
  return (
    <div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums text-foreground">{now === null ? '—' : `${fmt(now, digits)} ${unit}`}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full cursor-pointer rounded-md bg-muted/50"
        onClick={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          onSeek(from + ((e.clientX - r.left) / r.width) * (to - from));
        }}
      >
        <path d={d} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        <line x1={x(t)} x2={x(t)} y1={0} y2={H} stroke="#e11d48" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{fmt(lo, digits)}</span>
        <span>{fmt(hi, digits)}</span>
      </div>
    </div>
  );
}

function dayStart(offsetDays: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - offsetDays * 86400e3;
}

export function MachineTimeline({ id, geofences, liveTick }: { id: string; geofences: GisGeofence[]; liveTick: number }) {
  const presets = [
    { k: 'today', label: 'Сегодня', range: () => [dayStart(0), Date.now()] },
    { k: 'yesterday', label: 'Вчера', range: () => [dayStart(1), dayStart(0)] },
    { k: '24h', label: '24 ч', range: () => [Date.now() - 86400e3, Date.now()] },
    { k: '3d', label: '3 суток', range: () => [Date.now() - 3 * 86400e3, Date.now()] },
    { k: '7d', label: '7 суток', range: () => [Date.now() - 7 * 86400e3, Date.now()] },
  ] as const;
  const [preset, setPreset] = useState<string>('24h');
  const [day, setDay] = useState('');
  const [range, setRange] = useState<[number, number]>(() => [Date.now() - 86400e3, Date.now()]);
  const [t, setT] = useState<number>(Date.now());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [follow, setFollow] = useState(false);
  const live = preset === 'today' || preset === '24h' || preset === '3d' || preset === '7d';

  const pick = (k: string) => {
    const p = presets.find((x) => x.k === k)!;
    const r = p.range() as [number, number];
    setPreset(k);
    setDay('');
    setRange(r);
    setT(r[1]);
    setPlaying(false);
  };
  const pickDay = (v: string) => {
    setDay(v);
    if (!v) return;
    const d = new Date(v + 'T00:00:00');
    setPreset('day');
    setRange([d.getTime(), d.getTime() + 86400e3]);
    setT(d.getTime());
    setPlaying(false);
  };
  // live periods slide forward with the page refresh
  useEffect(() => {
    if (!live || playing) return;
    const r = presets.find((x) => x.k === preset)?.range() as [number, number] | undefined;
    if (r) {
      setRange(r);
      setT((old) => (old >= range[1] - 60e3 ? r[1] : old));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  const [from, to] = range;
  const tl = useAsync(() => api('GET', `/api/machines/${id}/timeline?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`), [id, from, to]);
  const d = tl.data;
  const pos: Row[] = d?.positions ?? [];
  const track = useMemo(() => pos.map((p) => ({ t: p[0], lat: p[1], lon: p[2], speed: p[3] })), [d]);
  const speedSeries: Pt[] = useMemo(() => pos.filter((p) => p[3] !== null).map((p) => [p[0], p[3] as number]), [d]);

  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setT((x) => {
        const nx = x + dt * speed;
        if (nx >= to) {
          setPlaying(false);
          return to;
        }
        return nx;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, speed, to]);

  const here = positionAt(pos, t);
  const s = d?.series ?? {};
  const rpm = valueAt(s.rpm, t);
  const engineOn = rpm === null ? null : rpm > 300;
  const hours = interpCounter(d?.counters?.engine_hours, t);
  const odo = interpCounter(d?.counters?.odometer_km, t);
  const fuelL = valueAt(s.fuel_level_l, t);
  const fuelPct = valueAt(s.fuel_level_pct, t);
  const activeFaults = (d?.faults ?? []).filter((f: any) => t >= f.first_t && t <= f.last_t + STALE);
  const jump = (dir: 1 | -1) => {
    const i = lastIdx(pos, t);
    const j = Math.min(pos.length - 1, Math.max(0, i + dir));
    if (pos[j]) setT(pos[j][0]);
  };
  const marks = [
    ...(d?.stops ?? []).map((x: any) => ({ t: x.from, w: x.to - x.from, c: 'bg-primary/60', title: `стоянка ${Math.round((x.to - x.from) / 60e3)} мин` })),
    ...(d?.fuel?.events ?? []).map((e: any) => ({ t: e.t_start, w: Math.max(e.t_end - e.t_start, (to - from) / 300), c: e.kind === 'refill' ? 'bg-success' : 'bg-danger', title: `${e.kind === 'refill' ? 'заправка' : 'слив'} ${fmt(e.litres, 0)} л` })),
    ...(d?.faults ?? []).map((f: any) => ({ t: f.first_t, w: Math.max(f.last_t - f.first_t, (to - from) / 300), c: 'bg-warning', title: f.text })),
  ];
  const gpx = `${apiBase()}/api/machines/${id}/track.gpx?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;

  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">История и таймлайн</h2>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {presets.map((p) => (
            <button key={p.k} onClick={() => pick(p.k)} className={`rounded-lg px-2 py-1 ${preset === p.k ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}>
              {p.label}
            </button>
          ))}
          <input type="date" className="input h-8 w-36 py-0 text-xs" value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => pickDay(e.target.value)} />
        </div>
      </div>
      <ErrorLine e={tl.error} />
      {d && !d.location && <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">Координаты этой машины недоступны вам (выключены владельцем или скрыты для роли) — ниже только показатели по времени.</div>}
      {d?.location && (
        <GisMap
          track={track}
          stops={d?.stops ?? []}
          geofences={geofences}
          cursor={here ? { lat: here.lat, lon: here.lon, course: here.course } : null}
          follow={follow}
          height={440}
          fitKey={`${id}:${from}:${to}:${pos.length > 0}`}
        />
      )}
      <div className="space-y-2">
        <div className="relative h-2">
          {marks.map((mk, i) => (
            <div key={i} title={mk.title} className={`absolute top-0 h-2 rounded-sm ${mk.c}`} style={{ left: `${((mk.t - from) / (to - from)) * 100}%`, width: `${Math.max(0.4, (mk.w / (to - from)) * 100)}%` }} />
          ))}
        </div>
        <input type="range" className="w-full accent-[#e11d48]" min={from} max={to} step={1000} value={Math.min(to, Math.max(from, t))} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Ползунок времени" />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="tabular-nums text-muted-foreground">{new Date(from).toLocaleString('ru-RU')}</span>
          <div className="flex items-center gap-1">
            <button className="btn-ghost h-8 px-2" onClick={() => jump(-1)} title="Предыдущая точка"><SkipBack className="h-4 w-4" /></button>
            <button className="btn-primary h-8 px-3" onClick={() => { if (t >= to) setT(from); setPlaying(!playing); }} title="Воспроизведение">
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <button className="btn-ghost h-8 px-2" onClick={() => jump(1)} title="Следующая точка"><SkipForward className="h-4 w-4" /></button>
            <select className="input h-8 w-20 py-0 text-xs" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Скорость воспроизведения">
              {SPEEDS.map((x) => <option key={x} value={x}>×{x}</option>)}
            </select>
            <label className="ml-2 flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> следовать</label>
            {d?.location && <a className="btn-ghost ml-1 h-8 px-2" href={gpx} title="Скачать трек (GPX)" onClick={async (e) => {
              e.preventDefault();
              const r = await fetch(gpx, { headers: { authorization: `Bearer ${localStorage.getItem('itles_token') ?? ''}`, 'x-itles-client': 'web' } });
              const url = URL.createObjectURL(await r.blob());
              Object.assign(document.createElement('a'), { href: url, download: `track-${id.slice(0, 8)}.gpx` }).click();
              URL.revokeObjectURL(url);
            }}><Download className="h-4 w-4" /> GPX</a>}
          </div>
          <span className="tabular-nums text-muted-foreground">{new Date(to).toLocaleString('ru-RU')}</span>
        </div>
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border-2 border-[#e11d48]/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Момент</div>
          <div className="text-lg font-bold tabular-nums">{new Date(t).toLocaleString('ru-RU')}</div>
          <div className="text-xs text-muted-foreground">{d ? `${d.total_positions} точек за период` : 'загрузка…'}</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Где</div>
          {here ? (
            <>
              <div className="font-semibold tabular-nums">{here.lat.toFixed(5)}, {here.lon.toFixed(5)}</div>
              <div className="text-xs text-muted-foreground">{here.stale ? 'последняя известная точка' : `${here.speed === null ? '—' : fmt(here.speed, 0) + ' км/ч'} · курс ${here.course === null ? '—' : Math.round(here.course) + '°'}`}</div>
            </>
          ) : (
            <div className="text-muted-foreground">нет точки до этого момента</div>
          )}
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Двигатель</div>
          <div className={`font-semibold ${engineOn ? 'text-success' : ''}`}>{engineOn === null ? 'нет данных CAN' : engineOn ? `работает · ${fmt(rpm, 0)} об/мин` : 'заглушен'}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {hours !== null ? `моточасы ${fmt(hours, 2)} ч` : ''} {odo !== null ? `· пробег ${fmt(odo, 1)} км` : ''}
          </div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Топливо и ошибки</div>
          <div className="font-semibold tabular-nums">{fuelL !== null ? `${fmt(fuelL, 0)} л` : fuelPct !== null ? `${fmt(fuelPct, 0)} %` : '—'}</div>
          <div className={`text-xs ${activeFaults.length ? 'text-danger' : 'text-muted-foreground'}`}>{activeFaults.length ? activeFaults.map((f: any) => f.text).join('; ') : 'активных ошибок нет'}</div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {speedSeries.length > 1 && <Chart points={speedSeries} from={from} to={to} t={t} unit="км/ч" color="#22c55e" label="Скорость (ГНСС)" onSeek={setT} />}
        {(['rpm', 'fuel_level_l', 'fuel_level_pct', 'coolant_temp_c', 'engine_load_pct', 'oil_pressure_kpa'] as const).map((k) =>
          s[k]?.length > 1 ? <Chart key={k} points={s[k]} from={from} to={to} t={t} unit={SENSORS[k].unit} color={k.startsWith('fuel') ? '#0ea5e9' : k === 'rpm' ? '#8b5cf6' : '#f97316'} label={SENSORS[k].label} onSeek={setT} /> : null,
        )}
      </div>
      {d && (
        <div className="grid gap-4 text-sm md:grid-cols-3">
          <div>
            <div className="label">Стоянки ({d.stops.length})</div>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {d.stops.map((x: any) => (
                <button key={x.from} className="block w-full rounded-md px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => setT(x.from)}>
                  {new Date(x.from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}–{new Date(x.to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · {Math.round((x.to - x.from) / 60e3)} мин
                </button>
              ))}
              {!d.stops.length && <div className="text-xs text-muted-foreground">нет</div>}
            </div>
          </div>
          <div>
            <div className="label">Топливо за период</div>
            {d.fuel ? (
              <div className="space-y-1 text-xs">
                <div>израсходовано: <b className="tabular-nums">{fmt(d.fuel.consumed_l, 0)} л</b></div>
                {d.fuel.events.map((e: any) => (
                  <button key={e.t_start} className={`block w-full rounded-md px-2 py-1 text-left hover:bg-accent ${e.kind === 'drain' ? 'text-danger' : 'text-success'}`} onClick={() => setT(e.t_start)}>
                    {new Date(e.t_start).toLocaleString('ru-RU')}: {e.kind === 'refill' ? 'заправка' : 'слив'} {fmt(e.litres, 0)} л ({fmt(e.level_before, 0)} → {fmt(e.level_after, 0)} л)
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">нет датчика уровня или раздел скрыт</div>
            )}
          </div>
          <div>
            <div className="label">Работа и ошибки</div>
            {d.agro && <div className="text-xs">обработано по треку: <b className="tabular-nums">{fmt(d.agro.area_ha, 1)} га</b> ({fmt(d.agro.work_km, 1)} км × {fmt(d.agro.width_m, 1)} м, {fmt(d.agro.work_h, 1)} ч)</div>}
            {(d.faults ?? []).map((f: any) => (
              <button key={`${f.spn}-${f.fmi}`} className="block w-full rounded-md px-2 py-1 text-left text-xs text-warning hover:bg-accent" onClick={() => setT(f.first_t)}>
                SPN {f.spn} FMI {f.fmi}: {f.text} · {new Date(f.first_t).toLocaleString('ru-RU')}
              </button>
            ))}
            {!d.agro && !(d.faults ?? []).length && <div className="text-xs text-muted-foreground">нет событий</div>}
          </div>
        </div>
      )}
    </div>
  );
}
