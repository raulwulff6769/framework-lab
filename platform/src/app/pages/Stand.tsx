// Live stand view: what runs where, which trackers are connected and what bytes they send.
import { useEffect, useState } from 'react';
import { ArrowRight, Cpu, Radio, Satellite, Server, Signal, Truck } from 'lucide-react';
import { can, type Me } from '../perm';
import { go } from '../main';
import { api, ago, fmt } from '../api';
import { ErrorLine, Modal, useAsync } from '../ui';

const PATH_RU: Record<string, string> = {
  gateway: 'трекер → шлюз ITles (TCP)',
  wialon_local: 'трекер → Wialon Local → ретранслятор → шлюз ITles',
  omnicomm_online: 'трекер → Omnicomm Online → EGTS → шлюз ITles',
  traccar: 'трекер → Traccar → API → ITles',
};
const PROTO_RU: Record<string, string> = {
  galileosky: 'Galileosky (бинарный, теги)',
  navtelecom_flex: 'Навтелеком NTCB/FLEX',
  egts: 'EGTS (ГОСТ 33472)',
  egts_retranslator: 'EGTS, ретрансляция платформы',
  wialon_ips: 'Wialon IPS 2.0 (текстовый)',
  wialon_retranslator: 'Wialon Retranslator',
  teltonika: 'Teltonika Codec 8 Extended',
};
const KIND_CLS: Record<string, string> = {
  packet: 'bg-primary/10 text-primary',
  ack: 'bg-success/10 text-success',
  can: 'bg-violet-500/10 text-violet-500',
  conn: 'bg-warning/10 text-warning',
  scenario: 'bg-danger/10 text-danger',
  log: 'bg-muted text-muted-foreground',
};

function Step({ icon: Icon, title, sub, ok }: { icon: any; title: string; sub: string; ok?: boolean | null }) {
  return (
    <div className="flex min-w-[150px] flex-1 items-start gap-2 rounded-xl border border-border bg-card p-3">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.75} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          {title}
          {ok !== undefined && ok !== null && <span className={`h-2 w-2 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`} />}
        </div>
        <div className="text-[11px] leading-snug text-muted-foreground">{sub}</div>
      </div>
    </div>
  );
}

function Bind({ imei, onClose }: { imei: string; onClose: () => void }) {
  const ms = useAsync(() => api('GET', '/api/machines'), []);
  return (
    <Modal title="К какой машине привязать трекер?" onClose={onClose}>
      <p className="mb-3 text-sm text-muted-foreground">
        IMEI <span className="font-mono">{imei}</span>. Откроется страница машины с заполненной формой «Трекер по IMEI». После привязки шлюз отдаст накопленный
        архив трекера, и история появится на карте.
      </p>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {(ms.data?.machines ?? []).map((m: any) => (
          <button key={m.id} className="block w-full rounded-lg border border-border px-3 py-2 text-left text-sm hover:border-primary" onClick={() => go(`#/machine/${m.id}?imei=${imei}`)}>
            {m.name} <span className="text-xs text-muted-foreground">· {m.org_name}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function Stand({ me }: { me: Me }) {
  const [tick, setTick] = useState(0);
  const [imei, setImei] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [bind, setBind] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const r = useAsync(() => api('GET', `/api/stand${imei ? `?imei=${imei}` : ''}`), [tick, imei]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, []);
  const d = r.data;
  const st = d?.stands?.[0];
  const comp = (kind: string) => st?.components?.find((c: any) => c.kind === kind);
  const send = async (imeiNo: string, command: string) => {
    setErr(null);
    try {
      await api('POST', '/api/stand/commands', { imei: imeiNo, command, stand_id: st?.stand_id });
      setTick((x) => x + 1);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Стенд: от датчика до приложения</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Здесь работает не картинка, а цепочка программ. Модели двигателей выдают кадры CAN J1939. Эмуляторы прошивок трекеров читают эти кадры, копят
            записи в «чёрном ящике» и отправляют настоящие байты протоколов по TCP: на шлюз ITles, на публичный сервер Traccar или через эмулятор
            платформы-ретранслятора. Данные машин смоделированы; протоколы, соединения, шлюз, Traccar и эта платформа — настоящие.
          </p>
        </div>
        {st ? (
          <div className={`rounded-xl px-3 py-2 text-sm ${st.online ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
            <b>{st.online ? 'стенд в сети' : 'стенд не в сети'}</b>
            <div className="text-xs">
              {st.host ?? ''} · режим {st.mode === 'eco' ? 'экономичный (отчёт раз в 15 мин)' : 'живой (раз в 3 с)'} · отчёт {ago(st.reported_at)}
            </div>
            {st.online && st.mode === 'eco' && (
              <div className="mt-1 max-w-xs text-xs text-foreground/80">
                Живой режим включится со следующим отчётом стенда — около{' '}
                {new Date(st.reported_at + 15 * 60e3).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}; держите страницу открытой. Редкие отчёты
                дают базе данных засыпать, пока стенд никто не смотрит.
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">стенд ещё не подключался</div>
        )}
      </div>
      <ErrorLine e={r.error ?? err} />

      <div className="flex flex-wrap items-stretch gap-2">
        <Step icon={Truck} title="Машина и ЭБУ" sub="двигатель, датчики давления/температуры, ДУТ в баке" ok={st ? st.online : null} />
        <ArrowRight className="hidden h-5 w-5 self-center text-muted-foreground lg:block" />
        <Step icon={Cpu} title="CAN J1939" sub={`250 кбит/с, кадры PGN 61444, 65262, 65263, 65253, 65266… ${st?.stats?.can_frames ? `· ${fmt(st.stats.can_frames, 0)} кадров` : ''}`} ok={comp('can')?.status === 'up' || null} />
        <ArrowRight className="hidden h-5 w-5 self-center text-muted-foreground lg:block" />
        <Step icon={Satellite} title="Трекер" sub="ГЛОНАСС/GPS + CAN + RS-485, архив «чёрный ящик»" ok={comp('tracker')?.status === 'up' || null} />
        <ArrowRight className="hidden h-5 w-5 self-center text-muted-foreground lg:block" />
        <Step icon={Signal} title="Сотовая сеть" sub="SIM M2M, GPRS/LTE, TCP-сессия к серверу" ok={comp('network')?.status === 'up' || null} />
        <ArrowRight className="hidden h-5 w-5 self-center text-muted-foreground lg:block" />
        <Step icon={Server} title="Сервер приёма" sub="шлюз ITles (TCP → HTTPS), Traccar, платформы-ретрансляторы; подробности — в «Компонентах»" ok={comp('gateway')?.status === 'up' || null} />
        <ArrowRight className="hidden h-5 w-5 self-center text-muted-foreground lg:block" />
        <Step icon={Radio} title="ITles" sub="HTTPS API → PostgreSQL → карта, таймлайн, отчёты" ok={true} />
      </div>

      {st?.components?.length > 0 && (
        <div className="card p-5">
          <h2 className="mb-2 font-semibold">Компоненты стенда</h2>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {st.components.map((c: any) => (
              <div key={c.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center gap-2 font-semibold">
                  <span className={`h-2 w-2 rounded-full ${c.status === 'up' ? 'bg-success' : c.status === 'warn' ? 'bg-warning' : 'bg-danger'}`} />
                  {c.name}
                </div>
                <div className="text-xs text-muted-foreground">{c.detail}</div>
                {c.url && (
                  <a className="text-xs text-primary hover:underline" href={c.url} target="_blank" rel="noreferrer">
                    {c.url}
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Машина / трекер</th>
              <th className="px-3 py-2">Протокол и путь</th>
              <th className="px-3 py-2">Связь</th>
              <th className="px-3 py-2">Сейчас на машине</th>
              <th className="px-3 py-2">В ITles</th>
              {d?.can_control && <th className="px-3 py-2">Сценарий</th>}
            </tr>
          </thead>
          <tbody>
            {(st?.machines ?? []).map((m: any) => (
              <tr key={m.imei} className={`border-b border-border align-top last:border-0 ${imei === m.imei ? 'bg-accent' : ''}`}>
                <td className="px-3 py-2">
                  <button className="text-left" onClick={() => setImei(imei === m.imei ? null : m.imei)} title="Показать пакеты только этого трекера">
                    <div className="font-semibold">{m.link?.name ?? m.vehicle}</div>
                    <div className="text-xs text-muted-foreground">{m.model} · <span className="font-mono">{m.imei}</span></div>
                    <div className="text-[11px] text-muted-foreground">{m.can}{m.fuel_sensor ? ` · ${m.fuel_sensor}` : ''}</div>
                  </button>
                </td>
                <td className="px-3 py-2 text-xs">
                  <div>{PROTO_RU[m.protocol] ?? m.protocol}</div>
                  <div className="text-muted-foreground">{PATH_RU[m.path] ?? m.path}</div>
                  {m.endpoint && <div className="font-mono text-[11px] text-muted-foreground">{m.endpoint}</div>}
                </td>
                <td className="px-3 py-2 text-xs">
                  <div className={m.connected ? 'text-success' : 'text-danger'}>
                    {m.rebooting ? 'трекер перезагружается' : m.connected ? 'TCP-сессия открыта' : m.state?.coverage === false ? 'нет сотовой связи' : 'нет сессии'}
                  </div>
                  <div className="text-muted-foreground">пакет {ago(m.last_packet_t)} · {fmt(m.packets, 0)} пак. · {fmt((m.bytes ?? 0) / 1024, 1)} КБ</div>
                  {m.archive > 0 && <div className="text-warning">в чёрном ящике {fmt(m.archive, 0)} записей</div>}
                  {!m.connected && m.error && (
                    <div className="max-w-[16rem] text-danger">
                      {m.error}
                      {m.retry_in_s > 0 ? ` · повтор через ${fmt(m.retry_in_s, 0)} с` : ''}
                    </div>
                  )}
                  {!m.connected && m.path === 'traccar' && /IMEI/.test(m.error ?? '') && (
                    <div className="max-w-[16rem] text-muted-foreground">
                      Сервер Traccar отвечает 0x00 на IMEI: устройство там не заведено. Добавьте IMEI {m.imei} в своём аккаунте Traccar — трекер дошлёт архив.
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {m.state ? (
                    <>
                      <div>{m.state.activity}</div>
                      <div className="text-muted-foreground tabular-nums">
                        {m.state.engine ? `${fmt(m.state.rpm, 0)} об/мин` : 'двигатель заглушен'} · {fmt(m.state.speed, 0)} км/ч
                        {m.state.fuel_l !== undefined ? ` · ${fmt(m.state.fuel_l, 0)} л` : ''}
                        {m.state.coolant !== undefined ? ` · ОЖ ${fmt(m.state.coolant, 0)} °C` : ''}
                      </div>
                      {m.state.faults?.length > 0 && <div className="text-danger">DTC: {m.state.faults.join(', ')}</div>}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {m.link?.registered ? (
                    <a className="text-primary hover:underline" href={`#/machine/${m.link.machine_id}`}>
                      открыть машину →
                    </a>
                  ) : m.path === 'traccar' ? (
                    <span className="text-muted-foreground">через «Подключения → Traccar»</span>
                  ) : (
                    <div>
                      <div className="text-warning">IMEI не привязан: шлюз держит пакеты в очереди</div>
                      {can(me, 'sources.manage') && (
                        <button className="btn-primary mt-1 h-7 px-2 text-xs" onClick={() => setBind(m.imei)}>
                          Привязать к машине
                        </button>
                      )}
                    </div>
                  )}
                </td>
                {d?.can_control && (
                  <td className="px-3 py-2">
                    <select className="input h-8 w-48 py-0 text-xs" value="" onChange={(e) => e.target.value && send(m.imei, e.target.value)}>
                      <option value="">выбрать…</option>
                      {Object.entries(d.command_labels as Record<string, string>).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            ))}
            {!st?.machines?.length && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  Нет данных от стенда. Как запустить стенд на своём сервере — в «Базе знаний», раздел «Живой стенд».
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Пакеты и кадры {imei ? <span className="font-mono text-sm text-muted-foreground">· {imei}</span> : ''}</h2>
            {imei && (
              <button className="text-xs text-primary" onClick={() => setImei(null)}>
                все трекеры
              </button>
            )}
          </div>
          <div className="max-h-[560px] space-y-1 overflow-y-auto font-mono text-[11px]">
            {(d?.events ?? []).map((e: any) => (
              <div key={e.id} className="rounded-md border border-border/60 px-2 py-1">
                <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{new Date(e.t).toLocaleTimeString('ru-RU')}</span>
                  <span className={`shrink-0 rounded px-1 ${KIND_CLS[e.kind] ?? KIND_CLS.log}`}>{e.kind}</span>
                  {e.payload?.dir && <span className="shrink-0 text-muted-foreground">{e.payload.dir === 'out' ? '→' : '←'}</span>}
                  <span className="min-w-0 flex-1 break-words font-sans text-xs">{e.summary}</span>
                </button>
                {open === e.id && (
                  <div className="mt-1 space-y-1 border-t border-border/60 pt-1">
                    {e.payload?.hex && <div className="break-all text-muted-foreground">{e.payload.hex}</div>}
                    {e.payload?.fields && <pre className="whitespace-pre-wrap text-foreground">{JSON.stringify(e.payload.fields, null, 1)}</pre>}
                  </div>
                )}
              </div>
            ))}
            {!d?.events?.length && <div className="font-sans text-sm text-muted-foreground">пакетов пока нет</div>}
          </div>
        </div>
        <div className="card p-5">
          <h2 className="mb-2 font-semibold">Команды сценариев</h2>
          <div className="space-y-1 text-xs">
            {(d?.commands ?? []).map((c: any) => (
              <div key={c.id} className="rounded-md border border-border px-2 py-1">
                <div>{d.command_labels[c.command] ?? c.command}</div>
                <div className="text-muted-foreground">
                  <span className="font-mono">{c.imei}</span> · {c.status === 'queued' ? 'ждёт стенд' : c.status === 'taken' ? 'выполняется' : c.status === 'done' ? 'выполнено' : 'ошибка'} · {ago(c.created_at)}
                  {c.result ? ` · ${c.result}` : ''}
                </div>
              </div>
            ))}
            {!d?.commands?.length && <div className="text-muted-foreground">Команд не было. Выберите сценарий в таблице: например, «Падение давления масла» — через несколько секунд ошибка SPN 100 появится у машины.</div>}
          </div>
        </div>
      </div>
      {bind && <Bind imei={bind} onClose={() => setBind(null)} />}
    </div>
  );
}
