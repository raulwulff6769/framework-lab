import { useMemo, useState } from 'react';
import type { Me } from '../main';
import { go } from '../main';
import { api, fmt } from '../api';
import { ErrorLine, SkeletonRows, useAsync } from '../ui';

export function Service({ me }: { me: Me }) {
  const [sort, setSort] = useState<'priority' | 'hours' | 'date'>('priority');
  const res = useAsync(() => api('GET', '/api/service/overview'), []);
  const items: any[] = res.data?.items ?? [];
  const sortedItems = useMemo(() => [...items].sort((a, b) => {
    if (sort === 'date') return dateValue(a.due_date) - dateValue(b.due_date) || statusRank(a.status) - statusRank(b.status);
    if (sort === 'hours') return numberValue(a.remaining_h) - numberValue(b.remaining_h) || statusRank(a.status) - statusRank(b.status);
    return statusRank(a.status) - statusRank(b.status) || numberValue(a.remaining_h) - numberValue(b.remaining_h) || dateValue(a.due_date) - dateValue(b.due_date);
  }), [items, sort]);
  const soon = items.filter((i) => i.status === 'overdue' || i.status === 'soon');
  const litres = soon.reduce((s, i) => s + (i.volume_l ?? 0), 0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Обслуживание</h1>
        <p className="text-sm text-muted-foreground">
          Замены масел и жидкостей по моточасам{me.org_kind !== 'customer' ? ' по всем клиентам' : ''}. Ближайшие и просроченные: {soon.length}
          {litres ? `, объём ≈ ${fmt(litres, 0)} л` : ''}.
        </p>
      </div>
      <ErrorLine e={res.error} />
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="text-sm font-medium">Сначала требующие внимания</span>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">Сортировать
            <select className="input min-w-44" value={sort} onChange={(e) => setSort(e.target.value as 'priority' | 'hours' | 'date')}>
              <option value="priority">По срочности</option>
              <option value="hours">По остатку моточасов</option>
              <option value="date">По предполагаемой дате</option>
            </select>
          </label>
        </div>
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Машина</th>
              <th className="px-4 py-3">Узел / продукт</th>
              <th className="px-4 py-3">Моточасы</th>
              <th className="px-4 py-3">Следующая</th>
              <th className="px-4 py-3">Статус</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((i) => (
              <tr key={i.id} className="cursor-pointer border-b border-border hover:bg-accent" onClick={() => go('#/machine/' + i.machine_id)}>
                <td className="px-4 py-3">
                  <b>{i.machine}</b>
                  <div className="text-xs text-muted-foreground">{i.org}</div>
                </td>
                <td className="px-4 py-3">
                  {i.item}
                  <div className="text-xs text-muted-foreground">
                    {i.product ?? ''} {i.volume_l ? `· ${fmt(i.volume_l, 0)} л` : ''}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums">{fmt(i.hours, 0)}</td>
                <td className="px-4 py-3 tabular-nums">
                  {fmt(i.due_at_h, 0)} ч{i.due_date ? <div className="text-xs text-muted-foreground">≈ {new Date(i.due_date).toLocaleDateString('ru-RU')}</div> : null}
                </td>
                <td className="px-4 py-3">
                  <span className={`badge ${i.status === 'overdue' ? 'bg-danger/10 text-danger' : i.status === 'soon' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}>
                    {i.status === 'overdue' ? 'просрочено' : i.status === 'soon' ? 'скоро' : i.status === 'ok' ? 'в норме' : 'нет данных'}
                  </span>
                </td>
              </tr>
            ))}
            {res.loading && <SkeletonRows cols={5} />}
            {!res.loading && items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  Интервалы обслуживания задаются на странице машины.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function statusRank(status: string) {
  return status === 'overdue' ? 0 : status === 'soon' ? 1 : status === 'unknown' ? 2 : 3;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function dateValue(value: unknown) {
  if (typeof value !== 'string') return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
