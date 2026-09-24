import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { Me } from '../perm';
import { api, CATEGORY_RU } from '../api';
import { ErrorLine, useAsync } from '../ui';

export function Trash({ me }: { me: Me }) {
  const t = useAsync(() => api('GET', '/api/trash'), []);
  const [err, setErr] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      t.reload();
    } catch (e) {
      setErr(e);
    }
  };
  const purge = (kind: 'orgs' | 'machines' | 'users', id: string, name: string) => {
    if (kind === 'users') {
      if (confirm(`Удалить пользователя ${name} навсегда?`)) act(() => api('DELETE', `/api/users/${id}/purge`));
      return;
    }
    const typed = prompt(`Окончательное удаление вместе со всей телеметрией. Восстановить будет нельзя.\nВведите точное название: ${name}`);
    if (typed !== null) act(() => api('DELETE', `/api/${kind}/${id}/purge`, { confirm: typed }));
  };
  const d = t.data;
  const Row = ({ title, sub, days, onRestore, onPurge }: { title: string; sub: string; days: number; onRestore: () => void; onPurge?: () => void }) => (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
      <div>
        <b>{title}</b>
        <div className="text-xs text-muted-foreground">
          {sub} · автоудаление через {days} дн.
        </div>
      </div>
      <div className="flex gap-1">
        <button className="btn-ghost h-8 px-2 text-xs" onClick={onRestore}>
          <RotateCcw className="h-3.5 w-3.5" /> Восстановить
        </button>
        {onPurge && (
          <button className="btn-ghost h-8 px-2 text-xs text-danger" onClick={onPurge}>
            <Trash2 className="h-3.5 w-3.5" /> Удалить навсегда
          </button>
        )}
      </div>
    </div>
  );
  const by = (x: any) => `удалено ${new Date(x.deleted_at).toLocaleString('ru-RU')}${x.deleted_by ? ` · ${x.deleted_by}` : ''}`;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Корзина</h1>
        <p className="text-sm text-muted-foreground">
          Удалённое хранится {d?.trash_days ?? 30} дней и восстанавливается вместе с данными. Организация уходит в корзину со всеми дочерними организациями, их
          пользователями и техникой. Окончательно удаляет только суперадминистратор.
        </p>
      </div>
      <ErrorLine e={t.error ?? err} />
      {d && (
        <>
          <section className="card space-y-2 p-5">
            <h2 className="font-semibold">Организации ({d.orgs.length})</h2>
            {d.orgs.map((o: any) => (
              <Row key={o.id} title={o.name} sub={`${by(o)} · вместе с ними ${o.machines} машин, ${o.users} пользователей`} days={o.days_left} onRestore={() => act(() => api('POST', `/api/orgs/${o.id}/restore`))} onPurge={d.can_purge && !(me.is_demo && o.protected) ? () => purge('orgs', o.id, o.name) : undefined} />
            ))}
            {!d.orgs.length && <p className="text-sm text-muted-foreground">пусто</p>}
          </section>
          <section className="card space-y-2 p-5">
            <h2 className="font-semibold">Техника ({d.machines.length})</h2>
            {d.machines.map((m: any) => (
              <Row key={m.id} title={m.name} sub={`${CATEGORY_RU[m.category] ?? m.category} · ${m.org_name} · ${by(m)}`} days={m.days_left} onRestore={() => act(() => api('POST', `/api/machines/${m.id}/restore`))} onPurge={d.can_purge && !(me.is_demo && m.protected) ? () => purge('machines', m.id, m.name) : undefined} />
            ))}
            {!d.machines.length && <p className="text-sm text-muted-foreground">пусто</p>}
          </section>
          <section className="card space-y-2 p-5">
            <h2 className="font-semibold">Пользователи ({d.users.length})</h2>
            {d.users.map((u: any) => (
              <Row key={u.id} title={u.login} sub={`${u.role_label} · ${u.org_name} · ${by(u)}`} days={u.days_left} onRestore={() => act(() => api('POST', `/api/users/${u.id}/restore`))} onPurge={d.can_purge && !(me.is_demo && u.protected) ? () => purge('users', u.id, u.login) : undefined} />
            ))}
            {!d.users.length && <p className="text-sm text-muted-foreground">пусто</p>}
          </section>
        </>
      )}
    </div>
  );
}
