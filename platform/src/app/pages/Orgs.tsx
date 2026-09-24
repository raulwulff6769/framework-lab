import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Trash2, UserPlus } from 'lucide-react';
import { can, type Me } from '../perm';
import { api } from '../api';
import { ErrorLine, Modal, useAsync } from '../ui';
import { ALL_BLOCKS, BLOCKS, ROLES, type Block, type Role } from '../../../server/domain/roles';

const KIND_RU: Record<string, string> = { fuchs: 'FUCHS', distributor: 'Дистрибьютор', customer: 'Клиент' };

function Visibility({ user, onClose, onSaved }: { user: any; onClose: () => void; onSaved: () => void }) {
  const defaults = new Set<Block>(ROLES[user.role as Role].blocks);
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(ALL_BLOCKS.map((b) => [b, user.blocks.includes(b)])));
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api('PATCH', `/api/users/${user.id}`, { blocks: state });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal title={`Видимость данных: ${user.login}`} onClose={onClose}>
      <p className="mb-3 text-xs text-muted-foreground">
        Роль «{user.role_label}» задаёт набор по умолчанию (отмечен точкой). Здесь можно скрыть или открыть отдельный блок именно этому сотруднику. Сервер не
        отдаёт скрытые данные ни в интерфейсе, ни через API.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {ALL_BLOCKS.map((b) => (
          <label key={b} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-sm ${state[b] ? 'border-primary/40 bg-primary/5' : 'border-border'}`}>
            <input type="checkbox" className="mt-0.5" checked={state[b]} onChange={(e) => setState({ ...state, [b]: e.target.checked })} />
            <span>
              <span className="font-medium">{BLOCKS[b].label}</span>
              {defaults.has(b) && <span className="ml-1 text-primary" title="по умолчанию для роли">•</span>}
              <span className="block text-[11px] text-muted-foreground">{BLOCKS[b].hint}</span>
            </span>
          </label>
        ))}
      </div>
      <ErrorLine e={err} />
      <div className="mt-4 flex justify-between gap-2">
        <button className="btn-ghost" onClick={() => setState(Object.fromEntries(ALL_BLOCKS.map((b) => [b, defaults.has(b)])))}>
          Как у роли
        </button>
        <button className="btn-primary" onClick={save}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}

function Scope({ user, machines, onClose, onSaved }: { user: any; machines: any[]; onClose: () => void; onSaved: () => void }) {
  const [all, setAll] = useState(!user.machine_ids);
  const [sel, setSel] = useState<string[]>(user.machine_ids ?? []);
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api('PATCH', `/api/users/${user.id}`, { machine_ids: all ? null : sel });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal title={`Машины сотрудника: ${user.login}`} onClose={onClose}>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> все машины организации
      </label>
      {!all && (
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {machines.map((m) => (
            <label key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
              <input type="checkbox" checked={sel.includes(m.id)} onChange={(e) => setSel(e.target.checked ? [...sel, m.id] : sel.filter((x) => x !== m.id))} /> {m.name}
            </label>
          ))}
        </div>
      )}
      <ErrorLine e={err} />
      <button className="btn-primary mt-4 w-full" onClick={save} disabled={!all && !sel.length}>
        Сохранить
      </button>
    </Modal>
  );
}

function Users({ org, me }: { org: any; me: Me }) {
  const users = useAsync(() => api('GET', `/api/orgs/${org.id}/users`), [org.id]);
  const [code, setCode] = useState<any>(null);
  const [role, setRole] = useState<string>('');
  const [vis, setVis] = useState<any>(null);
  const [scope, setScope] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const roles: string[] = users.data?.assignable_roles ?? [];
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      users.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="space-y-2">
      <ErrorLine e={users.error ?? err} />
      {(users.data?.users ?? []).map((u: any) => (
        <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
          <div className="min-w-0">
            <b>{u.login}</b>
            {u.label && <span className="text-muted-foreground"> · {u.label}</span>}
            {u.disabled && <span className="badge ml-2 bg-muted text-muted-foreground">отключён</span>}
            {u.protected && <span className="badge ml-2 bg-warning/10 text-warning">демо</span>}
            <div className="text-[11px] text-muted-foreground">
              видит: {u.blocks.length === ALL_BLOCKS.length ? 'все блоки' : u.blocks.map((b: Block) => BLOCKS[b].label.toLowerCase()).join(', ') || 'ничего'}
              {u.machine_ids ? ` · машин: ${u.machine_ids.length}` : ''}
              {u.last_login_at ? ` · вход ${new Date(u.last_login_at).toLocaleDateString('ru-RU')}` : ''}
            </div>
          </div>
          {u.manageable ? (
            <div className="flex flex-wrap items-center gap-1">
              <select className="input h-8 w-44 py-0 text-xs" value={u.role} onChange={(e) => act(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }))}>
                {[...new Set([u.role, ...roles])].map((r) => (
                  <option key={r} value={r} disabled={!roles.includes(r)}>
                    {ROLES[r as Role].label}
                  </option>
                ))}
              </select>
              <button className="btn-ghost h-8 px-2 text-xs" title="Какие блоки данных видит сотрудник" onClick={() => setVis(u)}>
                <Eye className="h-3.5 w-3.5" /> Видимость
              </button>
              {org.kind === 'customer' && (
                <button className="btn-ghost h-8 px-2 text-xs" title="Закрепить за машинами" onClick={() => setScope(u)}>
                  Машины
                </button>
              )}
              <button className="btn-ghost h-8 px-2 text-xs" title={u.disabled ? 'Включить' : 'Отключить вход'} onClick={() => act(() => api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }))}>
                {u.disabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
              <button
                className="btn-ghost h-8 px-2 text-xs"
                title="Задать новый пароль"
                onClick={() => {
                  const pw = prompt(`Новый пароль для ${u.login} (не короче 8 символов)`);
                  if (pw) act(() => api('POST', `/api/users/${u.id}/password`, { password: pw }));
                }}
              >
                <KeyRound className="h-3.5 w-3.5" />
              </button>
              <button
                className="btn-ghost h-8 px-2 text-xs text-danger"
                title="Удалить в корзину"
                onClick={() => confirm(`Удалить пользователя ${u.login}? В течение 30 дней его можно восстановить в разделе «Корзина».`) && act(() => api('DELETE', `/api/users/${u.id}`))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{u.role_label}</span>
          )}
        </div>
      ))}
      {roles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <select className="input h-9 w-56 text-sm" value={role || roles[roles.length - 1]} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLES[r as Role].label}
              </option>
            ))}
          </select>
          <button className="btn-ghost" onClick={() => act(async () => setCode(await api('POST', `/api/orgs/${org.id}/invites`, { role: role || roles[roles.length - 1] })))}>
            <UserPlus className="h-4 w-4" /> Пригласить
          </button>
          <span className="text-xs text-muted-foreground">{ROLES[(role || roles[roles.length - 1]) as Role]?.summary}</span>
        </div>
      )}
      {code && (
        <Modal title="Код приглашения" onClose={() => setCode(null)}>
          <p className="text-sm text-muted-foreground">
            Передайте код человеку: вход → «У меня есть код». Действует {code.expires_in_days} дней, одноразовый. Роль: <b>{code.role_label}</b>.
          </p>
          <div className="my-5 text-center font-mono text-4xl font-bold tracking-widest text-primary">{code.code}</div>
        </Modal>
      )}
      {vis && <Visibility user={vis} onClose={() => setVis(null)} onSaved={users.reload} />}
      {scope && <Scope user={scope} machines={users.data?.machines ?? []} onClose={() => setScope(null)} onSaved={users.reload} />}
    </div>
  );
}

export function Orgs({ me }: { me: Me }) {
  const orgs = useAsync(() => api('GET', '/api/orgs'), []);
  const [open, setOpen] = useState<string | null>(me.org_id);
  const [f, setF] = useState<any>({ kind: me.org_kind === 'fuchs' ? 'distributor' : 'customer' });
  const [err, setErr] = useState<unknown>(null);
  const list: any[] = orgs.data?.orgs ?? [];
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/api/orgs', f);
      setF({ ...f, name: '' });
      orgs.reload();
    } catch (e) {
      setErr(e);
    }
  };
  const remove = async (o: any) => {
    if (!confirm(`Переместить «${o.name}» в корзину вместе с дочерними организациями, их пользователями и техникой? Восстановить можно в течение 30 дней.`)) return;
    try {
      await api('DELETE', `/api/orgs/${o.id}`);
      orgs.reload();
    } catch (e) {
      setErr(e);
    }
  };
  const depth = (o: any) => (o.kind === 'fuchs' ? 0 : o.kind === 'distributor' ? 1 : 2);
  // tree order: FUCHS, then each distributor followed by its customers
  const ordered = [
    ...list.filter((o) => o.kind === 'fuchs'),
    ...list.filter((o) => o.kind === 'distributor').flatMap((d) => [d, ...list.filter((c) => c.parent_id === d.id)]),
    ...list.filter((o) => o.kind === 'customer' && !list.some((d) => d.id === o.parent_id)),
  ];
  const canUsers = can(me, 'users.manage');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{me.org_kind === 'customer' ? 'Организация и сотрудники' : 'Организации и пользователи'}</h1>
        <p className="text-sm text-muted-foreground">
          Вы — {me.role_label.toLowerCase()} ({me.org_name}). {ROLES[me.role].summary}.
        </p>
      </div>
      {can(me, 'orgs.manage') && me.org_kind !== 'customer' && (
        <form onSubmit={create} className="card grid gap-3 p-5 md:grid-cols-4">
          {me.org_kind === 'fuchs' && (
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="distributor">Дистрибьютор</option>
              <option value="customer">Клиент</option>
            </select>
          )}
          {me.org_kind === 'fuchs' && f.kind === 'customer' && (
            <select className="input" value={f.parent_id ?? ''} onChange={(e) => setF({ ...f, parent_id: e.target.value })} required>
              <option value="">— дистрибьютор —</option>
              {list
                .filter((o) => o.kind === 'distributor')
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          )}
          <input className="input md:col-span-2" placeholder="Название организации" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <button className="btn-primary">Создать</button>
        </form>
      )}
      <ErrorLine e={err} />
      <div className="space-y-3">
        {ordered.map((o) => (
          <div key={o.id} className="card p-5" style={{ marginLeft: `${depth(o) * 1.25}rem` }}>
            <div className="flex cursor-pointer flex-wrap items-center justify-between gap-2" onClick={() => setOpen(open === o.id ? null : o.id)}>
              <div>
                <span className="badge mr-2 bg-primary/10 text-primary">{KIND_RU[o.kind]}</span>
                <b>{o.name}</b>
                <span className="ml-2 text-sm text-muted-foreground">
                  {o.machines} машин · {o.users} пользователей
                </span>
              </div>
              <div className="flex items-center gap-2">
                {can(me, 'orgs.manage') && o.id !== me.org_id && o.kind !== 'fuchs' && !(me.is_demo && o.protected) && (
                  <button
                    className="btn-ghost h-8 px-2 text-xs text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(o);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Удалить
                  </button>
                )}
                <span className="text-muted-foreground">{open === o.id ? '▲' : '▼'}</span>
              </div>
            </div>
            {open === o.id && (
              <div className="mt-4 space-y-4">
                {o.kind === 'customer' && me.org_id === o.id && me.owner_admin && (
                  <label className="flex items-start gap-3 rounded-xl bg-warning/10 p-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={o.share_location_up}
                      onChange={async (e) => {
                        await api('PATCH', `/api/orgs/${o.id}`, { share_location_up: e.target.checked });
                        orgs.reload();
                      }}
                    />
                    <span>
                      <b>Показывать местоположение машин дистрибьютору и FUCHS.</b> Моточасы и пробег видны им всегда; координаты — только если отмечено.
                      Отключить сбор координат отдельной машины можно на её странице.
                    </span>
                  </label>
                )}
                {canUsers ? <Users org={o} me={me} /> : <p className="text-sm text-muted-foreground">Состав сотрудников видят администраторы.</p>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
