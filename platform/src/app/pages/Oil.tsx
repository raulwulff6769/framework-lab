import { useMemo, useState } from 'react';
import type { Me } from '../main';
import { sees } from '../perm';
import { go } from '../main';
import { api, ago, fmt } from '../api';
import { ErrorLine, SkeletonRows, useAsync } from '../ui';
import { OilHowTo, STATUS_CLS, STATUS_RU, StatusDot, fmtSensor } from '../oil';

const COLS = ['oil_level_pct', 'oil_temp_c', 'hyd_temp_c', 'oil_pressure_kpa', 'oil_water_aw'] as const;
const HEAD: Record<string, string> = { oil_level_pct: 'Уровень', oil_temp_c: 'T масла', hyd_temp_c: 'T гидравлики', oil_pressure_kpa: 'Давление', oil_water_aw: 'Вода, aw' };

export function Oil({ me }: { me: Me }) {
  const res = useAsync(() => api('GET', '/api/oil/overview'), []);
  const service = useAsync(() => (sees(me, 'service') ? api('GET', '/api/service/overview') : Promise.resolve({ items: [] })), [me.blocks]);
  const [viscosity, setViscosity] = useState('all');
  const [urgency, setUrgency] = useState('all');
  const [oilSort, setOilSort] = useState<'spec' | 'urgency'>('urgency');
  const rows: any[] = res.data?.machines ?? [];
  const products = useMemo(() => {
    const byProduct = new Map<string, any>();
    for (const item of service.data?.items ?? []) {
      const name = String(item.product ?? '').trim();
      if (!name) continue;
      const key = name.toLocaleLowerCase('ru');
      const current = byProduct.get(key) ?? { name, viscosity: name.match(/\b\d{1,2}W-\d{2}\b/i)?.[0]?.toUpperCase() ?? '', machines: new Set<string>(), items: 0, status: 'ok' };
      current.machines.add(item.machine);
      current.items++;
      if (item.status === 'overdue' || (item.status === 'soon' && current.status !== 'overdue')) current.status = item.status;
      if (item.status === 'unknown' && current.status === 'ok') current.status = 'unknown';
      byProduct.set(key, current);
    }
    return [...byProduct.values()];
  }, [service.data]);
  const viscosities = [...new Set(products.map((p) => p.viscosity).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  const visibleProducts = products
    .filter((p) => viscosity === 'all' || (viscosity === 'unspecified' ? !p.viscosity : p.viscosity === viscosity))
    .filter((p) => urgency === 'all' || p.status === urgency)
    .sort((a, b) => oilSort === 'spec'
      ? a.name.localeCompare(b.name, 'ru', { numeric: true })
      : urgencyRank(a.status) - urgencyRank(b.status) || a.name.localeCompare(b.name, 'ru'));
  const crit = rows.filter((r) => r.oil.status === 'crit').length;
  const warn = rows.filter((r) => r.oil.status === 'warn').length;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Масло</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} машин с датчиками масла · критично {crit} · внимание {warn}. Пределы — ориентиры по умолчанию; расход считается по уровню и моточасам.
        </p>
      </div>
      <ErrorLine e={res.error} />
      <ErrorLine e={service.error} />
      {sees(me, 'service') && <section className="card space-y-4 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Продукты в регламентах</h2>
            <p className="text-xs text-muted-foreground">Данные из настроек ТО; наличие на складе не передаётся.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-muted-foreground">Вязкость
              <select className="input mt-1 min-w-32" value={viscosity} onChange={(e) => setViscosity(e.target.value)}>
                <option value="all">Любая</option>
                {viscosities.map((v) => <option key={v} value={v}>{v}</option>)}
                <option value="unspecified">Не указана</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">Актуальность
              <select className="input mt-1 min-w-36" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
                <option value="all">Любая</option>
                <option value="overdue">Просрочено</option>
                <option value="soon">Скоро</option>
                <option value="ok">В норме</option>
                <option value="unknown">Нет данных</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">Сортировка
              <select className="input mt-1 min-w-36" value={oilSort} onChange={(e) => setOilSort(e.target.value as 'spec' | 'urgency')}>
                <option value="urgency">По актуальности</option>
                <option value="spec">По спецификации</option>
              </select>
            </label>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground"><tr>
              <th className="px-3 py-2">Спецификация / продукт</th><th className="px-3 py-2">Вязкость</th><th className="px-3 py-2">Регламенты</th><th className="px-3 py-2">Актуальность</th><th className="px-3 py-2">Наличие</th>
            </tr></thead>
            <tbody>{visibleProducts.map((p) => <tr key={p.name} className="border-b border-border last:border-0">
              <td className="px-3 py-3 font-medium">{p.name}</td><td className="px-3 py-3">{p.viscosity || '—'}</td>
              <td className="px-3 py-3">{p.items} · {p.machines.size} машин</td>
              <td className="px-3 py-3"><span className={`badge ${p.status === 'overdue' ? 'bg-danger/10 text-danger' : p.status === 'soon' ? 'bg-warning/10 text-warning' : p.status === 'ok' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>{urgencyLabel(p.status)}</span></td>
              <td className="px-3 py-3 text-muted-foreground">Не указано</td>
            </tr>)}
              {service.loading && <SkeletonRows rows={3} cols={5} />}
              {!service.loading && visibleProducts.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">{products.length ? 'Нет продуктов по выбранным фильтрам.' : 'Продукты пока не указаны в регламентах ТО.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>}
      {!res.loading && rows.length === 0 ? (
        <div className="card p-6">
          <OilHowTo />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Машина</th>
                <th className="px-4 py-3">Статус</th>
                {COLS.map((k) => (
                  <th key={k} className="px-4 py-3">
                    {HEAD[k]}
                  </th>
                ))}
                <th className="px-4 py-3">Расход, %/100 ч</th>
                <th className="px-4 py-3">Доливы 30 дн</th>
                <th className="px-4 py-3">Обновлено</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-accent" onClick={() => go('#/machine/' + r.id)}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.name}</div>
                    {me.org_kind !== 'customer' && <div className="text-xs text-muted-foreground">{r.org_name}</div>}
                  </td>
                  <td className="px-4 py-3">{r.oil.status ? <span className={`badge ${STATUS_CLS[r.oil.status]}`}>{STATUS_RU[r.oil.status]}</span> : '—'}</td>
                  {COLS.map((k) => {
                    const v = r.oil.values[k];
                    return (
                      <td key={k} className="px-4 py-3 tabular-nums">
                        <span className="inline-flex items-center gap-1.5">
                          {v && <StatusDot s={v.status} />}
                          {fmtSensor(k, v?.value)}
                        </span>
                      </td>
                    );
                  })}
                  <td className="px-4 py-3 tabular-nums">{r.consumption_pct_per_100h === null ? '—' : fmt(r.consumption_pct_per_100h, 1)}</td>
                  <td className="px-4 py-3 tabular-nums">{r.topups_30d ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{ago(r.oil.t)}</td>
                </tr>
              ))}
              {res.loading && <SkeletonRows cols={2 + COLS.length + 3} />}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function urgencyRank(status: string) {
  return status === 'overdue' ? 0 : status === 'soon' ? 1 : status === 'unknown' ? 2 : 3;
}

function urgencyLabel(status: string) {
  return status === 'overdue' ? 'Просрочено' : status === 'soon' ? 'Скоро' : status === 'ok' ? 'В норме' : 'Нет данных';
}
