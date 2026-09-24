import { useEffect, useState } from 'react';
import { api, API_KEY, TOKEN_KEY } from '../api';
import { ErrorLine } from '../ui';
import { ThemeToggle } from '../main-toggle';

const KIND_RU: Record<string, string> = { fuchs: 'FUCHS', distributor: 'Дилер', customer: 'Клиент' };

function DemoAccess({ onDone }: { onDone: () => void }) {
  const [demo, setDemo] = useState<{ enabled: boolean; accounts: any[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    api('GET', '/api/demo', undefined, null).then(setDemo).catch(() => setDemo(null));
  }, []);
  if (!demo?.enabled || !demo.accounts.length) return null;
  const enter = async (login: string) => {
    setErr(null);
    try {
      const r = await api('POST', '/api/auth/demo', { login }, null);
      localStorage.setItem(TOKEN_KEY, r.token);
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="card w-full max-w-2xl space-y-3 p-6 shadow-2xl">
      <div>
        <div className="text-lg font-bold">Демо-доступ: войдите под любой ролью</div>
        <p className="text-xs text-muted-foreground">
          Демо-организации с живым стендом: агрохолдинг на Кубани, леспромхоз в Карелии, карьер и стройка. У каждой роли свои права и свой набор видимых
          данных — сравните, что видит суперадминистратор, диспетчер, механик и оператор. Демо-учётки видят только демо-данные; ночью демо восстанавливается.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {demo.accounts.map((a) => (
          <button key={a.login} onClick={() => enter(a.login)} className="rounded-xl border border-border p-3 text-left transition hover:border-primary hover:bg-primary/5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{a.role_label}</span>
              <span className="badge bg-muted text-[10px] text-muted-foreground">{KIND_RU[a.org_kind]}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {a.label ? `${a.label} · ` : ''}
              {a.org_name}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{a.summary}</div>
          </button>
        ))}
      </div>
      <ErrorLine e={err} />
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'redeem' | 'setup'>('login');
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
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
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center gap-6 bg-background p-4 py-10">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-7 shadow-2xl">
        <div className="flex items-center gap-3">
          <img src="../favicon.svg" className="h-10 w-10" alt="" />
          <div>
            <div className="text-lg font-bold">ITles</div>
            <div className="text-xs text-muted-foreground">моточасы · пробег · местоположение</div>
          </div>
        </div>
        <div className="flex gap-1 rounded-xl bg-muted p-1 text-sm">
          {(needsSetup ? [['setup', 'Первый запуск']] : [['login', 'Вход'], ['redeem', 'У меня есть код']]).map(([m, t]) => (
            <button type="button" key={m} onClick={() => setMode(m as any)} className={`flex-1 rounded-md py-1.5 font-medium ${mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>
              {t}
            </button>
          ))}
        </div>
        {mode === 'setup' && (
          <>
            <p className="text-xs text-muted-foreground">Создание учётной записи FUCHS — главной организации системы. Ключ установки задан на сервере (SETUP_KEY).</p>
            <div>
              <label className="label">Ключ установки</label>
              <input className="input" value={f.setup_key ?? ''} onChange={set('setup_key')} required />
            </div>
            <div>
              <label className="label">Название организации</label>
              <input className="input" value={f.org_name ?? 'FUCHS'} onChange={set('org_name')} />
            </div>
          </>
        )}
        {mode === 'redeem' && (
          <div>
            <label className="label">Код приглашения</label>
            <input className="input font-mono uppercase" placeholder="XXXX-XXXX" value={f.code ?? ''} onChange={set('code')} required />
          </div>
        )}
        <div>
          <label className="label">{mode === 'login' ? 'Логин' : 'Придумайте логин'}</label>
          <input className="input" autoComplete="username" value={f.login ?? ''} onChange={set('login')} required />
        </div>
        <div>
          <label className="label">Пароль</label>
          <input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password ?? ''} onChange={set('password')} required minLength={mode === 'login' ? 1 : 8} />
        </div>
        <ErrorLine e={err} />
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Подождите…' : mode === 'login' ? 'Войти' : mode === 'redeem' ? 'Создать учётную запись' : 'Создать'}
        </button>
        <div className="flex justify-between text-xs text-muted-foreground">
          <a className="hover:text-primary" href="#/cab">
            Режим «Телефон в кабине» →
          </a>
          <button
            type="button"
            className="hover:text-primary"
            onClick={() => {
              const v = prompt('Адрес сервера (пусто — по умолчанию)', localStorage.getItem(API_KEY) ?? '');
              if (v === null) return;
              if (v.trim()) localStorage.setItem(API_KEY, v.trim());
              else localStorage.removeItem(API_KEY);
              location.reload();
            }}
          >
            Сервер
          </button>
        </div>
      </form>
      {!needsSetup && <DemoAccess onDone={onDone} />}
    </div>
  );
}
