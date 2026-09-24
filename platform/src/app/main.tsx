import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useState } from 'react';
import { Activity, BookOpen, Building2, Droplets, LogOut, Plug, ScrollText, Settings as SettingsIcon, Trash2, Truck, Wrench } from 'lucide-react';
import '../styles.css';
import { api, ApiError, apiBase, TOKEN_KEY } from './api';
import { ThemeToggle } from './main-toggle';
import { Fleet } from './pages/Fleet';
import { MachinePage } from './pages/Machine';
import { Orgs } from './pages/Orgs';
import { Connect } from './pages/Connect';
import { Service } from './pages/Service';
import { Oil } from './pages/Oil';
import { Login } from './pages/Login';
import { Cab } from './cab/Cab';
import { Trash } from './pages/Trash';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';
import { Stand } from './pages/Stand';
import { Knowledge } from './pages/Knowledge';
import { can, sees, type Me } from './perm';

export type { Me } from './perm';

function useHash(): string {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => {
    const f = () => setH(location.hash || '#/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return h;
}

export const go = (h: string) => (location.hash = h);

function App() {
  const hash = useHash();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => {
    api<{ user: Me }>('GET', '/api/me')
      .then((r) => setMe(r.user))
      .catch((e) => setMe(e instanceof ApiError && e.status === 0 ? (me ?? null) : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  // the cab screen works with a device token and without a user session
  if (hash.startsWith('#/cab')) return <Cab />;
  if (me === undefined) return <div className="p-10 text-muted-foreground">Загрузка…</div>;
  if (me === null) return <Login onDone={load} />;

  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    setMe(null);
  };
  const parts = hash.split('?')[0].slice(2).split('/');
  const nav = [
    { h: '#/', t: 'Парк', icon: Truck, on: true },
    { h: '#/oil', t: 'Масло', icon: Droplets, on: sees(me, 'oil') },
    { h: '#/service', t: 'Обслуживание', icon: Wrench, on: sees(me, 'service') },
    { h: '#/stand', t: 'Стенд', icon: Activity, on: can(me, 'stand.view') },
    { h: '#/orgs', t: me.org_kind === 'customer' ? 'Организация' : 'Организации', icon: Building2, on: true },
    { h: '#/connect', t: 'Подключения', icon: Plug, on: can(me, 'connectors.manage') || sees(me, 'sources') },
    { h: '#/trash', t: 'Корзина', icon: Trash2, on: can(me, 'trash.view') },
    { h: '#/audit', t: 'Журнал', icon: ScrollText, on: can(me, 'audit.view') },
    { h: '#/settings', t: 'Настройки', icon: SettingsIcon, on: can(me, 'settings.manage') },
    { h: '#/kb', t: 'База знаний', icon: BookOpen, on: true },
  ].filter((x) => x.on);
  let page;
  if (parts[0] === 'machine' && parts[1]) page = <MachinePage id={parts[1]} me={me} />;
  else if (parts[0] === 'orgs') page = <Orgs me={me} />;
  else if (parts[0] === 'connect') page = <Connect me={me} />;
  else if (parts[0] === 'service') page = <Service me={me} />;
  else if (parts[0] === 'oil') page = <Oil me={me} />;
  else if (parts[0] === 'trash') page = <Trash me={me} />;
  else if (parts[0] === 'audit') page = <Audit me={me} />;
  else if (parts[0] === 'settings') page = <Settings me={me} />;
  else if (parts[0] === 'stand') page = <Stand me={me} />;
  else if (parts[0] === 'kb') page = <Knowledge me={me} />;
  else page = <Fleet me={me} />;
  const active = (h: string) => (h === '#/' ? parts[0] === '' || parts[0] === 'machine' : hash.startsWith(h));
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card px-3 py-4 md:flex">
        <a href="#/" className="mb-5 flex items-center gap-2.5 px-2">
          <img src="../favicon.svg" className="h-8 w-8 rounded-lg" alt="" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">ITles</div>
            <div className="text-[11px] text-muted-foreground">мониторинг техники</div>
          </div>
        </a>
        <div className="mb-4 rounded-lg border border-border px-3 py-2">
          <div className="truncate text-[13px] font-medium">{me.org_name}</div>
          <div className="text-[11px] text-muted-foreground">{me.role_label}{me.label ? ` · ${me.label}` : ''}</div>
          {me.is_demo && <div className="mt-1 inline-block rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">демо-доступ</div>}
        </div>
        <nav className="flex flex-1 flex-col gap-0.5">
          {nav.map(({ h, t, icon: Icon }) => (
            <a
              key={h}
              href={h}
              className={`group flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors ${
                active(h) ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
            >
              <Icon className={`h-4 w-4 ${active(h) ? 'text-primary' : ''}`} strokeWidth={1.75} />
              {t}
            </a>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
          <div className="min-w-0 px-2">
            <div className="truncate text-[13px] font-medium">{me.login}</div>
            <div className="truncate text-[11px] text-muted-foreground">{(apiBase() || location.origin).replace(/^https?:\/\//, '')}</div>
          </div>
          <div className="flex items-center">
            <ThemeToggle />
            <button onClick={logout} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" title="Выйти" aria-label="Выйти">
              <LogOut className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-[1000] flex items-center gap-2 border-b border-border bg-card/90 px-3 py-2 backdrop-blur md:hidden">
          <img src="../favicon.svg" className="h-7 w-7 rounded-md" alt="" />
          <nav className="flex flex-1 gap-1 overflow-x-auto text-[13px]">
            {nav.map(({ h, t }) => (
              <a key={h} href={h} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 ${active(h) ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'}`}>
                {t}
              </a>
            ))}
          </nav>
          <ThemeToggle />
          <button onClick={logout} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground" aria-label="Выйти">
            <LogOut className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 md:px-8">{page}</main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('../sw.js').catch(() => {});
}
