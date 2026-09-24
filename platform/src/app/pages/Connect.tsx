import { useEffect, useState } from 'react';
import { can, type Me } from '../perm';
import { api, ago } from '../api';
import { ErrorLine, useAsync } from '../ui';

const KINDS = [
  {
    kind: 'wialon',
    title: 'Wialon (Hosting или Local у интегратора)',
    hint: 'Самая распространённая платформа у интеграторов. Wialon Hosting недоступен с российских адресов, поэтому российские парки обычно работают на Wialon Local — укажите адрес вашего сервера.',
    fields: [
      ['base_url', 'Адрес API', 'https://wialon.ваш-интегратор.ru'],
      ['token', 'Токен доступа (только чтение)', ''],
    ],
  },
  {
    kind: 'traccar',
    title: 'Traccar',
    hint: 'Открытый сервер мониторинга. Токен: профиль пользователя Traccar → «Токен».',
    fields: [
      ['base_url', 'Адрес сервера', 'https://traccar.example.ru'],
      ['token', 'Токен', ''],
    ],
  },
  {
    kind: 'aemp',
    title: 'ISO 15143-3 (AEMP 2.0)',
    hint: 'Стандартный API телематики производителей техники: местоположение, моточасы и пробег в одном формате.',
    fields: [
      ['base_url', 'Адрес снимка парка (Fleet)', 'https://api.oem.example/Fleet/1'],
      ['token', 'Bearer-токен', ''],
    ],
  },
];

export function Connect({ me }: { me: Me }) {
  const list = useAsync(() => api('GET', '/api/connectors'), []);
  const orgs = useAsync(() => api('GET', '/api/orgs'), []);
  const customers = (orgs.data?.orgs ?? []).filter((o: any) => o.kind === 'customer');
  const [kind, setKind] = useState('wialon');
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => {
    // return from the official Wialon login page: #/connect/wialon?access_token=...
    const m = /access_token=([^&]+)/.exec(location.hash);
    if (m) {
      setKind('wialon');
      setF((x) => ({ ...x, token: decodeURIComponent(m[1]) }));
    }
  }, []);
  const k = KINDS.find((x) => x.kind === kind)!;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await api('POST', '/api/connectors', { kind, ...f, org_id: me.org_kind === 'customer' ? me.org_id : f.org_id });
      setOk(`Подключено: ${r.units} единиц техники, новых машин: ${r.report.new_machines}, точек: ${r.report.result.positions}.`);
      list.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const wialonLogin = async () => {
    const host = prompt('Адрес страницы входа Wialon (hosting.wialon.com или адрес Wialon Local)', 'https://hosting.wialon.com');
    if (!host) return;
    const r = await api('GET', `/api/connectors/wialon/login-url?host=${encodeURIComponent(host)}&redirect=${encodeURIComponent(location.href.split('#')[0] + '#/connect/wialon')}`);
    location.href = r.url;
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Подключения</h1>
        <p className="text-sm text-muted-foreground">
          Если у машин уже есть трекеры в мониторинговой платформе, подключите платформу — все машины появятся в парке автоматически, без нового оборудования.
        </p>
      </div>
      <div className="card divide-y divide-border">
        {(list.data?.connectors ?? []).map((c: any) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
            <div>
              <b>{c.label}</b> <span className="text-muted-foreground">· {c.org_name} · {c.units} машин</span>
              <div className="text-xs text-muted-foreground">
                {c.status === 'error' ? <span className="text-danger">{c.last_error}</span> : `синхронизация ${ago(c.last_sync_at)}`}
              </div>
            </div>
            <button
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={async () => {
                await api('POST', `/api/connectors/${c.id}/sync`).catch((e) => alert(e.message));
                list.reload();
              }}
            >
              Обновить
            </button>
          </div>
        ))}
        {list.data?.connectors?.length === 0 && <div className="p-4 text-sm text-muted-foreground">Подключений пока нет.</div>}
      </div>
      {can(me, 'connectors.manage') && (
        <form onSubmit={submit} className="card space-y-4 p-5">
          <div className="flex flex-wrap gap-2">
            {KINDS.map((x) => (
              <button type="button" key={x.kind} onClick={() => setKind(x.kind)} className={`rounded-xl px-3 py-2 text-sm font-medium ${kind === x.kind ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
                {x.title}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{k.hint}</p>
          {kind === 'wialon' && (
            <button type="button" className="btn-ghost" onClick={wialonLogin}>
              Войти в Wialon и получить токен автоматически
            </button>
          )}
          {me.org_kind !== 'customer' && (
            <select className="input" value={f.org_id ?? ''} onChange={(e) => setF({ ...f, org_id: e.target.value })} required>
              <option value="">— клиент, чьи машины подключаются —</option>
              {customers.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          {k.fields.map(([name, label, ph]) => (
            <div key={name}>
              <label className="label">{label}</label>
              <input className="input" placeholder={ph} value={f[name] ?? ''} onChange={(e) => setF({ ...f, [name]: e.target.value })} required />
            </div>
          ))}
          <ErrorLine e={err} />
          {ok && <div className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">{ok}</div>}
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Проверяем доступ…' : 'Подключить'}
          </button>
        </form>
      )}
    </div>
  );
}
