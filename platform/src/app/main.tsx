import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, BookOpen, Building2, Droplets, LogOut, MoreHorizontal, Plug, ScrollText, Settings as SettingsIcon, Trash2, Truck, Wrench, X } from 'lucide-react';
import '../styles.css';
import { api, ApiError, apiBase, TOKEN_KEY } from './api';
import { ThemeToggle } from './main-toggle';
import { BrandLockup, BrandSymbol } from './brand';
import { clearPreferences, loadPreferences } from './preferences';
import { setTheme } from './theme';
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
import { useDialog } from './ui';
import { DialogHost } from './dialogs';
import { LaunchIntro } from './intro';
import { MovingUnderline, PressButton, PressLink } from './motion';

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

// soft hyphens let long Russian labels wrap cleanly in the narrow mobile tab bar
const TAB_LABEL: Record<string, string> = {
  Обслуживание: 'Обслу\u00adживание',
  Организации: 'Органи\u00adзации',
  Организация: 'Органи\u00adзация',
  Подключения: 'Подклю\u00adчения',
  Настройки: 'Настрой\u00adки',
};

function MenuSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose, false);
  return (
    <div className="backdrop-in fixed inset-0 z-[1500] flex items-end bg-black/50 backdrop-blur-sm md:hidden" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Меню кабинета"
        className="dialog-in w-full rounded-t-[22px] border-t border-border bg-card px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function App() {
  const hash = useHash();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [booted, setBooted] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  const [sheet, setSheet] = useState(false);
  const sideNavRef = useRef<HTMLElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => setSheet(false), [hash]);
  useEffect(() => {
    const update = (e: Event) => setPreferenceError((e as CustomEvent<string>).detail);
    window.addEventListener('itles-preferences-error', update);
    return () => window.removeEventListener('itles-preferences-error', update);
  }, []);
  const load = useCallback(() => {
    api<{ user: Me }>('GET', '/api/me')
      .then(async (r) => {
        try {
          const preferences = await loadPreferences(r.user.id);
          if (preferences.theme) setTheme(preferences.theme, false);
        } catch {
          setPreferenceError('Не удалось загрузить настройки учётной записи. Обновите страницу после восстановления связи.');
        }
        setMe(r.user);
      })
      .catch((e) => setMe(e instanceof ApiError && e.status === 0 ? (me ?? null) : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  // the cab screen works with a device token and without a user session
  if (hash.startsWith('#/cab')) return <Cab />;
  if (!booted || me === undefined) return <LaunchIntro ready={me !== undefined} onDone={() => setBooted(true)} />;
  if (me === null) return <Login onDone={load} />;

  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    clearPreferences();
    setPreferenceError('');
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
  // one key per page component, so the entrance animation never remounts a page on its own route
  const pageKey = parts[0] === 'machine' && parts[1] ? 'machine' : ['orgs', 'connect', 'service', 'oil', 'trash', 'audit', 'settings', 'stand', 'kb'].includes(parts[0]) ? parts[0] : 'fleet';
  const active = (h: string) => (h === '#/' ? parts[0] === '' || parts[0] === 'machine' : hash.startsWith(h));
  const tabs = nav.slice(0, 4);
  const more = nav.slice(4);
  const initial = me.login.slice(0, 1).toUpperCase();
  const server = (apiBase() || location.origin).replace(/^https?:\/\//, '');
  const account = (
    <div className="rounded-xl border border-border bg-background/50 px-3 py-2.5">
      <div className="truncate text-[13px] font-semibold" title={me.org_name}>{me.org_name}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span>{me.role_label}{me.label ? ` · ${me.label}` : ''}</span>
        {me.is_demo && <span className="rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-semibold text-warning">демо-доступ</span>}
      </div>
    </div>
  );
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-card px-3 pb-3 pt-5 md:flex">
        <a href="#/" className="mb-6 flex items-center rounded-lg px-2.5 py-1" aria-label="Отсчёт — парк техники">
          <BrandLockup size={26} knockout="var(--bg-raised)" />
        </a>
        <div className="mb-5">{account}</div>
        <nav ref={sideNavRef} className="relative -mr-1 flex flex-1 flex-col gap-0.5 overflow-y-auto pr-1" aria-label="Разделы кабинета">
          <MovingUnderline containerRef={sideNavRef} activeKey={hash} orientation="vertical" size={20} />
          {nav.map(({ h, t, icon: Icon }) => (
            <PressLink
              key={h}
              href={h}
              aria-current={active(h) ? 'page' : undefined}
              className={`group relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13.5px] transition-colors ${
                active(h) ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
              }`}
            >
              <Icon className={`h-[18px] w-[18px] shrink-0 ${active(h) ? 'text-primary' : 'transition-colors group-hover:text-foreground'}`} strokeWidth={1.75} />
              {t}
            </PressLink>
          ))}
        </nav>
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/12 font-mono text-[12px] font-semibold text-primary" aria-hidden="true">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold" title={me.login}>{me.login}</div>
            <div className="truncate text-[11px] text-muted-foreground" title={server}>{server}</div>
          </div>
          <div className="flex shrink-0 items-center">
            <ThemeToggle />
            <button onClick={logout} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" title="Выйти" aria-label="Выйти">
              <LogOut className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-[1000] flex items-center gap-3 border-b border-border bg-background/85 px-4 pb-2.5 pt-[max(10px,env(safe-area-inset-top))] backdrop-blur-xl md:hidden">
          <a href="#/" aria-label="Отсчёт — парк техники" className="shrink-0">
            <BrandLockup size={22} knockout="var(--bg)" />
          </a>
          <div className="min-w-0 flex-1 truncate text-right text-[12px] text-muted-foreground" title={me.org_name}>{me.org_name}</div>
          <ThemeToggle />
        </header>
        <main className="mx-auto max-w-7xl px-4 pt-5 pb-28 md:px-8 md:pt-8 md:pb-12">
          {preferenceError && <div role="alert" className="mb-5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">{preferenceError}</div>}
          <div key={pageKey} className="page-in">{page}</div>
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-[1000] border-t border-border bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden" aria-label="Разделы кабинета">
          <div ref={tabBarRef} className="relative mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
            <MovingUnderline containerRef={tabBarRef} activeKey={hash} orientation="horizontal" size={24} />
            {tabs.map(({ h, t, icon: Icon }) => (
              <PressLink
                key={h}
                href={h}
                aria-current={active(h) ? 'page' : undefined}
                className={`relative flex min-h-[58px] flex-col items-center justify-center gap-1 px-1 pt-1.5 pb-1 text-center text-[10.5px] leading-[1.15] font-medium [hyphens:manual] ${active(h) ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <Icon className={`h-5 w-5 shrink-0 ${active(h) ? 'text-primary' : ''}`} strokeWidth={1.75} />
                <span className="max-w-full">{TAB_LABEL[t] ?? t}</span>
              </PressLink>
            ))}
            <PressButton
              type="button"
              onClick={() => setSheet(true)}
              aria-haspopup="dialog"
              aria-expanded={sheet}
              className={`flex min-h-[58px] flex-col items-center justify-center gap-1 px-1 pt-1.5 pb-1 text-[10.5px] font-medium ${more.some((x) => active(x.h)) ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              <MoreHorizontal className={`h-5 w-5 ${more.some((x) => active(x.h)) ? 'text-primary' : ''}`} strokeWidth={1.75} />
              Ещё
            </PressButton>
          </div>
        </nav>
        {sheet && (
          <MenuSheet onClose={() => setSheet(false)}>
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" aria-hidden="true" />
              <div className="mb-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">{account}</div>
                <button type="button" autoFocus onClick={() => setSheet(false)} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground" aria-label="Свернуть меню">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {more.length > 0 && (
                <nav className="grid grid-cols-2 gap-2" aria-label="Другие разделы">
                  {more.map(({ h, t, icon: Icon }) => (
                    <a
                      key={h}
                      href={h}
                      aria-current={active(h) ? 'page' : undefined}
                      className={`flex min-h-[52px] items-center gap-3 rounded-xl border px-3 text-[13.5px] ${active(h) ? 'border-primary/50 bg-primary/10 font-semibold' : 'border-border'}`}
                    >
                      <Icon className={`h-[18px] w-[18px] shrink-0 ${active(h) ? 'text-primary' : 'text-muted-foreground'}`} strokeWidth={1.75} />
                      <span className="min-w-0 [hyphens:auto]" lang="ru">{t}</span>
                    </a>
                  ))}
                </nav>
              )}
              <div className="mt-3 flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/12 font-mono text-[12px] font-semibold text-primary" aria-hidden="true">
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">{me.login}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{server}</div>
                </div>
                <button onClick={logout} className="btn-ghost shrink-0" aria-label="Выйти">
                  <LogOut className="h-4 w-4" strokeWidth={1.75} /> Выйти
                </button>
              </div>
          </MenuSheet>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <DialogHost />
  </>,
);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('../sw.js').catch(() => {});
}
