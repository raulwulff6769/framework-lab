import { useState } from 'react';
import type { Me } from '../perm';
import { api } from '../api';
import { ErrorLine, useAsync } from '../ui';

const ACTION_RU: Record<string, string> = {
  org_created: 'создана организация',
  org_updated: 'изменена организация',
  org_deleted: 'организация в корзину',
  org_restored: 'организация восстановлена',
  org_purged: 'организация удалена навсегда',
  invite_created: 'создано приглашение',
  user_updated: 'изменён пользователь',
  user_deleted: 'пользователь в корзину',
  user_restored: 'пользователь восстановлен',
  user_purged: 'пользователь удалён навсегда',
  password_reset: 'сброшен пароль',
  machine_created: 'добавлена машина',
  machine_updated: 'изменена машина',
  machine_deleted: 'машина в корзину',
  machine_restored: 'машина восстановлена',
  machine_purged: 'машина удалена навсегда',
  location_enabled: 'переключено местоположение',
  share_location_up: 'изменён доступ к координатам',
  positions_purged: 'удалена история координат',
  source_added: 'подключён источник',
  source_disabled: 'отключён источник',
  connector_created: 'подключена платформа',
  connector_deleted: 'отключена платформа',
  geofence_created: 'создана геозона',
  geofence_deleted: 'удалена геозона',
  gateway_key_created: 'создан ключ шлюза',
  gateway_key_revoked: 'отозван ключ шлюза',
  demo_login: 'изменён демо-доступ',
  stand_command: 'команда стенду',
  track_exported: 'экспорт трека',
  reading_deleted: 'удалено показание',
};

export function Audit({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const r = useAsync(() => api('GET', '/api/audit?limit=300'), []);
  const rows = (r.data?.entries ?? []).filter((e: any) => !q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Журнал действий</h1>
          <p className="text-sm text-muted-foreground">
            Кто и что менял {me.role === 'superadmin' && !me.is_demo ? 'во всём сервисе' : 'в ваших организациях'}: пользователи, техника, удаление и восстановление, доступ к координатам.
          </p>
        </div>
        <input className="input w-56" placeholder="Фильтр" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorLine e={r.error} />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Время</th>
              <th className="px-4 py-2">Кто</th>
              <th className="px-4 py-2">Действие</th>
              <th className="px-4 py-2">Где</th>
              <th className="px-4 py-2">Подробности</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e: any) => (
              <tr key={e.id} className="border-b border-border last:border-0 align-top">
                <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">{new Date(e.t).toLocaleString('ru-RU')}</td>
                <td className="px-4 py-2">{e.login ?? '—'}</td>
                <td className="px-4 py-2">{ACTION_RU[e.action] ?? e.action}</td>
                <td className="px-4 py-2 text-muted-foreground">{e.target_name ?? e.org_name ?? ''}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">
                  {e.details
                    ? Object.entries(e.details)
                        .filter(([k]) => k !== 'by')
                        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                        .join(' · ')
                    : ''}
                </td>
              </tr>
            ))}
            {!r.loading && !rows.length && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  Записей нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
