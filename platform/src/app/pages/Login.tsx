import { useEffect, useState } from 'react';
import { ArrowRight, Eye, EyeOff, Server, Smartphone } from 'lucide-react';
import { api, API_KEY, TOKEN_KEY } from '../api';
import { ErrorLine } from '../ui';
import { ThemeToggle } from '../main-toggle';
import { BrandLockup, BrandSpinner } from '../brand';

const TICKS = Array.from({ length: 60 }, (_, i) => i);

/** Graphite panel that continues the landing: the dial with its index dot making a slow lap. */
function BrandPanel() {
  return (
    <aside className="dark relative hidden overflow-hidden bg-background text-foreground lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
      <a href="../" className="relative z-10 w-fit rounded-lg" aria-label="Отсчёт — на главную">
        <BrandLockup size={30} knockout="var(--bg)" />
      </a>
      <svg className="pointer-events-none absolute top-[44%] left-1/2 w-[min(64vh,560px)] -translate-x-[34%] -translate-y-1/2" viewBox="0 0 400 400" aria-hidden="true">
        <defs>
          {/* bone ceramic lit from the upper left, like the ring in the film */}
          <linearGradient id="login-ceramic" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
            <stop offset="0" stopColor="#fbf6ec" />
            <stop offset="0.55" stopColor="#f2ebdd" />
            <stop offset="1" stopColor="#c9bba1" />
          </linearGradient>
          <radialGradient id="login-dot-glow">
            <stop offset="0" style={{ stopColor: 'var(--signal-graphic)', stopOpacity: 0.42 }} />
            <stop offset="1" style={{ stopColor: 'var(--signal-graphic)', stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        {TICKS.map((i) => {
          const a = (i / 60) * Math.PI * 2;
          const long = i % 5 === 0;
          const r1 = long ? 176 : 181;
          return <line key={i} x1={200 + Math.sin(a) * r1} y1={200 - Math.cos(a) * r1} x2={200 + Math.sin(a) * 188} y2={200 - Math.cos(a) * 188} stroke={long ? 'var(--accent-gold)' : 'var(--line-strong)'} strokeOpacity={long ? 0.75 : 1} strokeWidth={long ? 2 : 1} />;
        })}
        <circle cx="200" cy="200" r="118" fill="none" stroke="url(#login-ceramic)" strokeWidth="50" />
        <g className="login-orbit">
          <circle cx="200" cy="82" r="100" fill="url(#login-dot-glow)" />
          <circle cx="200" cy="82" r="56" fill="var(--bg)" />
          <circle cx="200" cy="82" r="40" fill="var(--signal-graphic)" />
        </g>
      </svg>
      <div className="relative z-10 max-w-md">
        <p className="eyebrow mb-4" style={{ color: 'var(--accent-gold)' }}>
          Кабинет
        </p>
        <p className="text-[clamp(2.4rem,3.6vw,3.6rem)] leading-[0.95] font-extrabold tracking-[-0.045em]">Техника на&nbsp;связи.</p>
        {/* «плёнка»: the temper colours of the film's facets */}
        <div className="mt-5 h-[3px] w-40 rounded-full bg-[linear-gradient(90deg,#ecc587,#d6994c_22%,#b86440_40%,#943277_58%,#6d43ae_72%,#4d79d8_88%,#4aaaf0)]" aria-hidden="true" />
        <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-[var(--fg-2)]">Моточасы, пробег, местоположение и&nbsp;масло&nbsp;— из&nbsp;того, что уже стоит в&nbsp;машине.</p>
        <p className="eyebrow mt-8">трекер · платформа · телефон · счётчик</p>
      </div>
    </aside>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'redeem' | 'setup'>('login');
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    api('GET', '/api/setup/status')
      .then((r) => {
        setNeedsSetup(r.needs_setup);
        if (r.needs_setup) setMode('setup');
      })
      .catch(() => {});
  }, []);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const path = mode === 'login' ? '/api/auth/login' : mode === 'redeem' ? '/api/auth/redeem' : '/api/setup';
      const r = await api(mode === 'login' ? 'POST' : 'POST', path, { ...f, login: (f.login ?? '').trim().toLowerCase() }, null);
      localStorage.setItem(TOKEN_KEY, r.token);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const heading = {
    login: { title: 'Вход в\u00a0кабинет', text: 'Логин и\u00a0пароль выдаёт администратор вашей организации.' },
    redeem: { title: 'Код приглашения', text: 'Введите код от\u00a0администратора, затем придумайте логин и\u00a0пароль.' },
    setup: { title: 'Настройка системы', text: 'Первая учётная запись становится главной организацией.' },
  }[mode];
  const tabs: Array<[string, string]> = needsSetup ? [['setup', 'Первый запуск']] : [['login', 'Вход'], ['redeem', 'У меня есть код']];
  return (
    <div className="grid min-h-full bg-background lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
      <BrandPanel />
      <main className="relative flex min-h-full flex-col px-5 pt-[max(18px,env(safe-area-inset-top))] pb-6 sm:px-10">
        <div className="flex items-center justify-between">
          <a href="../" className="rounded-lg lg:invisible" aria-label="Отсчёт — на главную">
            <BrandLockup size={24} knockout="var(--bg)" />
          </a>
          <ThemeToggle />
        </div>
        <div className="page-in mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          <p className="eyebrow">Отсчёт · кабинет</p>
          <h1 className="mt-2 text-[30px] leading-[1.05] font-bold sm:text-[34px]">{heading.title}</h1>
          <p className="mt-2.5 text-[14.5px] text-muted-foreground">{heading.text}</p>
          <form onSubmit={submit} className="mt-7 space-y-4">
            <div className="relative grid gap-1 rounded-xl bg-muted p-1 text-sm" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
              {tabs.map(([m, t]) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setMode(m as any)}
                  aria-pressed={mode === m}
                  className={`relative min-h-9 rounded-lg px-2 font-semibold transition-[background-color,color,box-shadow] duration-200 ${mode === m ? 'bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_1px_var(--line)]' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            {mode === 'setup' && (
              <>
                <p className="rounded-xl border border-border bg-muted/50 px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground">
                  Создание учётной записи FUCHS&nbsp;— главной организации системы. Ключ установки задан на&nbsp;сервере (SETUP_KEY).
                </p>
                <div>
                  <label className="label" htmlFor="auth-setup-key">Ключ установки</label>
                  <input id="auth-setup-key" className="input font-mono" value={f.setup_key ?? ''} onChange={set('setup_key')} required />
                </div>
                <div>
                  <label className="label" htmlFor="auth-org">Название организации</label>
                  <input id="auth-org" className="input" value={f.org_name ?? 'FUCHS'} onChange={set('org_name')} />
                </div>
              </>
            )}
            {mode === 'redeem' && (
              <div>
                <label className="label" htmlFor="auth-code">Код приглашения</label>
                <input id="auth-code" className="input font-mono tracking-[0.18em] uppercase" placeholder="XXXX-XXXX" autoComplete="one-time-code" value={f.code ?? ''} onChange={set('code')} required />
              </div>
            )}
            <div>
              <label className="label" htmlFor="auth-login">{mode === 'login' ? 'Логин' : 'Придумайте логин'}</label>
              <input id="auth-login" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={f.login ?? ''} onChange={set('login')} required />
            </div>
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <label className="label" htmlFor="auth-password">Пароль</label>
                {mode !== 'login' && <span className="text-[11.5px] text-muted-foreground">не&nbsp;короче 8&nbsp;символов</span>}
              </div>
              <div className="relative">
                <input
                  id="auth-password"
                  className="input pr-11"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={f.password ?? ''}
                  onChange={set('password')}
                  required
                  minLength={mode === 'login' ? 1 : 8}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  className="absolute top-1/2 right-1.5 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" strokeWidth={1.75} /> : <Eye className="h-4 w-4" strokeWidth={1.75} />}
                </button>
              </div>
            </div>
            <ErrorLine e={err} />
            <button className="btn-primary min-h-11 w-full text-[15px]" disabled={busy} aria-busy={busy}>
              {busy ? (
                <>
                  <BrandSpinner tone="current" />
                  Подождите…
                </>
              ) : mode === 'login' ? (
                'Войти'
              ) : mode === 'redeem' ? (
                'Создать учётную запись'
              ) : (
                'Создать'
              )}
            </button>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[13px] text-muted-foreground">
              <a className="group inline-flex items-center gap-1.5 rounded-md hover:text-foreground" href="#/cab">
                <Smartphone className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                Режим «Телефон в&nbsp;кабине»
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </a>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md hover:text-foreground"
                onClick={() => {
                  const v = prompt('Адрес сервера (пусто — по умолчанию)', localStorage.getItem(API_KEY) ?? '');
                  if (v === null) return;
                  if (v.trim()) localStorage.setItem(API_KEY, v.trim());
                  else localStorage.removeItem(API_KEY);
                  location.reload();
                }}
              >
                <Server className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                Сервер
              </button>
            </div>
          </form>
        </div>
        <p className="text-center text-[11.5px] text-muted-foreground">
          <a className="rounded hover:text-foreground" href="../">
            Отсчёт&nbsp;— мониторинг спецтехники
          </a>
        </p>
      </main>
    </div>
  );
}
