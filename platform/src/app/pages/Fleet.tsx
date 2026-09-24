import { useEffect, useMemo, useState } from 'react';
import { can, sees, type Me } from '../perm';
import { go } from '../main';
import { api, CATEGORY_RU, fmt, METHOD_RU } from '../api';
import { ErrorLine, Fresh, Modal, useAsync } from '../ui';
import { GisMap, type GisMarker } from '../map/GisMap';
import { StatusDot, fmtSensor } from '../oil';

export function CounterCell({ c, unit }: { c: any; unit: string }) {
  if (!c) return <span className="text-muted-foreground">—</span>;
  return (
    <div>
      <div className="font-semibold tabular-nums">
        {c.exact ? '' : '≈ '}
        {fmt(c.value, unit === 'ч' ? 1 : 1)} {unit}
      </div>
      <div className="text-[11px] text-muted-foreground">{METHOD_RU[c.method] ?? c.method}</div>
    </div>
  );
}

export function AddMachine({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: (id: string) => void }) {
  const orgs = useAsync(() => api('GET', '/api/orgs'), []);
  const customers = (orgs.data?.orgs ?? []).filter((o: any) => o.kind === 'customer');
  const [f, setF] = useState<any>({ category: 'harvester', chassis: 'wheeled', rotating_upper: false });
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!f.org_id && customers.length) setF((x: any) => ({ ...x, org_id: me.org_kind === 'customer' ? me.org_id : customers[0].id }));
  }, [customers.length]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/machines', { ...f, year: f.year ? Number(f.year) : null });
      onDone(r.machine.id);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal title="Новая машина" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {me.org_kind !== 'customer' && (
          <div>
            <label className="label">Клиент (владелец техники)</label>
            <select className="input" value={f.org_id ?? ''} onChange={(e) => setF({ ...f, org_id: e.target.value })}>
              {customers.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label">Название / гаражный номер</label>
          <input className="input" required value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Тип</label>
            <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, rotating_upper: e.target.value === 'excavator' || e.target.value === 'crane' ? f.rotating_upper : false })}>
              {Object.entries(CATEGORY_RU).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Ходовая</label>
            <select className="input" value={f.chassis} onChange={(e) => setF({ ...f, chassis: e.target.value })}>
              <option value="wheeled">колёсная</option>
              <option value="tracked">гусеничная</option>
            </select>
          </div>
          <input className="input" placeholder="Марка" value={f.make ?? ''} onChange={(e) => setF({ ...f, make: e.target.value })} />
          <input className="input" placeholder="Модель" value={f.model ?? ''} onChange={(e) => setF({ ...f, model: e.target.value })} />
          <input className="input" placeholder="Год выпуска" inputMode="numeric" value={f.year ?? ''} onChange={(e) => setF({ ...f, year: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.rotating_upper} onChange={(e) => setF({ ...f, rotating_upper: e.target.checked })} /> поворотная платформа
          </label>
        </div>
        <ErrorLine e={err} />
        <button className="btn-primary w-full">Добавить</button>
      </form>
    </Modal>
  );
}

export function Fleet({ me }: { me: Me }) {
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const res = useAsync(() => api('GET', '/api/machines'), [tick]);
  const gf = useAsync(() => (sees(me, 'map') ? api('GET', '/api/geofences') : Promise.resolve({ geofences: [] })), []);
  const past = useAsync(() => (at ? api('GET', `/api/fleet/at?t=${new Date(at).toISOString()}`) : Promise.resolve(null)), [at]);
  useEffect(() => {
    const t = setInterval(async () => {
      await api('POST', '/api/refresh').catch(() => {});
      setTick((x) => x + 1);
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  const machines: any[] = res.data?.machines ?? [];
  const shown = machines.filter((m) => !q || `${m.name} ${m.org_name} ${m.make ?? ''} ${m.model ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const markers: GisMarker[] = useMemo(() => {
    if (at && past.data) {
      const ids = new Set(shown.map((m) => m.id));
      return (past.data.machines as any[])
        .filter((p) => ids.has(p.id))
        .map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, label: `${p.name} · ${new Date(p.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`, color: (p.speed_kmh ?? 0) > 2 ? '#22c55e' : '#1f6feb' }));
    }
    return shown
      .filter((m) => m.position)
      .map((m) => ({
        id: m.id,
        lat: m.position.lat,
        lon: m.position.lon,
        label: m.engine_hours ? `${m.name} · ${fmt(m.engine_hours.value)} ч` : m.name,
        color: m.freshness === 'online' ? '#22c55e' : m.freshness === 'recent' ? '#f59e0b' : '#ef4444',
      }));
  }, [res.data, q, at, past.data]);
  const online = machines.filter((m) => m.freshness === 'online').length;
  const canHistory = sees(me, 'map') && sees(me, 'history');
  const dayAgo = Date.now() - 24 * 3600e3;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Парк техники</h1>
          <p className="text-sm text-muted-foreground">
            {machines.length} машин · на связи {online} · обновление каждые 30 с
          </p>
        </div>
        <div className="flex gap-2">
          <input className="input w-48" placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
          {can(me, 'machines.create') && (
            <button className="btn-primary" onClick={() => setAdding(true)}>
              + Машина
            </button>
          )}
        </div>
      </div>
      <ErrorLine e={res.error} />
      {sees(me, 'map') && (markers.length > 0 || at) && (
        <div className="space-y-2">
          <GisMap markers={markers} geofences={gf.data?.geofences ?? []} height={420} onPick={(id) => go('#/machine/' + id)} fitKey={at ? 'fleet-at' : undefined} />
          {canHistory && (
            <div className="card flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <label className="flex items-center gap-2 whitespace-nowrap">
                <input type="checkbox" checked={at !== null} onChange={(e) => setAt(e.target.checked ? Date.now() - 3600e3 : null)} /> Парк на момент времени
              </label>
              {at !== null && (
                <>
                  <input type="range" className="min-w-[200px] flex-1 accent-[#e11d48]" min={dayAgo} max={Date.now()} step={60e3} value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label="Момент времени для всего парка" />
                  <span className="tabular-nums text-muted-foreground">{new Date(at).toLocaleString('ru-RU')}</span>
                  <span className="text-xs text-muted-foreground">{past.data ? `${past.data.machines.length} машин с точкой не старше 2 ч` : ''}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Машина</th>
              {me.org_kind !== 'customer' && <th className="px-4 py-3">Клиент</th>}
              {sees(me, 'hours') && <th className="px-4 py-3">Моточасы</th>}
              {sees(me, 'mileage') && <th className="px-4 py-3">Пробег</th>}
              {(sees(me, 'fuel') || sees(me, 'oil')) && <th className="px-4 py-3">{sees(me, 'fuel') ? 'Топливо / масло' : 'Масло'}</th>}
              {sees(me, 'map') && <th className="px-4 py-3">Местоположение</th>}
              <th className="px-4 py-3">Данные</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-accent" onClick={() => go('#/machine/' + m.id)}>
                <td className="px-4 py-3">
                  <div className="font-semibold">{m.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {CATEGORY_RU[m.category] ?? m.category} {m.make ? '· ' + m.make : ''} {m.model ?? ''}
                  </div>
                </td>
                {me.org_kind !== 'customer' && <td className="px-4 py-3 text-muted-foreground">{m.org_name}</td>}
                {sees(me, 'hours') && (
                  <td className="px-4 py-3">
                    <CounterCell c={m.engine_hours} unit="ч" />
                    {m.faults?.length > 0 && <div className="text-[11px] text-danger">DTC: {m.faults.map((f: any) => `${f.spn}/${f.fmi}`).join(', ')}</div>}
                  </td>
                )}
                {sees(me, 'mileage') && (
                  <td className="px-4 py-3">
                    <CounterCell c={m.odometer} unit="км" />
                  </td>
                )}
                {(sees(me, 'fuel') || sees(me, 'oil')) && <td className="px-4 py-3 tabular-nums">
                  {m.fuel?.values?.fuel_level_l ? <div>{fmt(m.fuel.values.fuel_level_l.value, 0)} л</div> : m.fuel?.values?.fuel_level_pct ? <div>{fmt(m.fuel.values.fuel_level_pct.value, 0)} %</div> : null}
                  {m.oil ? (
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot s={m.oil.status} />
                      {m.oil.values.oil_level_pct ? fmtSensor('oil_level_pct', m.oil.values.oil_level_pct.value) : 'есть данные'}
                    </span>
                  ) : !m.fuel ? (
                    <span className="text-muted-foreground">—</span>
                  ) : null}
                </td>}
                {sees(me, 'map') && <td className="px-4 py-3 text-xs text-muted-foreground">
                  {!m.location_enabled ? (
                    <span className="badge bg-muted text-muted-foreground">выключено владельцем</span>
                  ) : !m.location_visible ? (
                    <span className="badge bg-muted text-muted-foreground">скрыто владельцем</span>
                  ) : m.position ? (
                    `${m.position.lat.toFixed(5)}, ${m.position.lon.toFixed(5)}`
                  ) : (
                    '—'
                  )}
                </td>}
                <td className="px-4 py-3">
                  <Fresh f={m.freshness} t={m.last_data_t} />
                </td>
              </tr>
            ))}
            {!res.loading && shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  Машин пока нет. {can(me, 'machines.create') ? 'Добавьте первую кнопкой «+ Машина» или подключите платформу в разделе «Подключения».' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {adding && <AddMachine me={me} onClose={() => setAdding(false)} onDone={(id) => go('#/machine/' + id)} />}
    </div>
  );
}
