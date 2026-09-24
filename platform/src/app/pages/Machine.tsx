import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { can, sees, type Me } from '../perm';
import { go } from '../main';
import { api, apiBase, CATEGORY_RU, fmt, METHOD_RU, SOURCE_RU } from '../api';
import { Bars, ErrorLine, Fresh, Modal, useAsync } from '../ui';
import { Line, OilHowTo, STATUS_CLS, STATUS_RU, fmtSensor } from '../oil';
import { SENSORS } from '../../../server/domain/sensors';
import { BLOCKS, type Block } from '../../../server/domain/roles';
import { MachineTimeline } from './Timeline';

export function Hidden({ block }: { block: Block }) {
  return <div className="text-sm text-muted-foreground">Раздел «{BLOCKS[block].label}» скрыт для вашей роли. Его может открыть администратор организации.</div>;
}

async function fileToJpeg(file: File, max = 1280): Promise<string> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

function ReadingForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [metric, setMetric] = useState('engine_hours');
  const [value, setValue] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/api/machines/${id}/readings`, { metric, value: Number(value.replace(',', '.')), photo, confirm_decrease: confirm });
      setValue('');
      setPhoto(null);
      setConfirm(false);
      setErr(null);
      onDone();
    } catch (e: any) {
      setErr(e);
      if (e.code === 'decrease') setConfirm(true);
    }
  };
  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <select className="input" value={metric} onChange={(e) => setMetric(e.target.value)}>
          <option value="engine_hours">Моточасы (счётчик на панели)</option>
          <option value="odometer_km">Одометр, км</option>
        </select>
        <input className="input tabular-nums" inputMode="decimal" placeholder="Показание" value={value} onChange={(e) => setValue(e.target.value)} required />
      </div>
      <label className="btn-ghost w-full cursor-pointer">
        {photo ? 'Фото прикреплено ✓' : 'Сфотографировать счётчик'}
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async (e) => e.target.files?.[0] && setPhoto(await fileToJpeg(e.target.files[0]))} />
      </label>
      {photo && <img src={photo} className="max-h-40 rounded-xl" alt="счётчик" />}
      <ErrorLine e={err} />
      <button className="btn-primary w-full">{confirm ? 'Подтвердить: счётчик заменён' : 'Сохранить показание'}</button>
    </form>
  );
}

const PATH_RU: Record<string, string> = {
  gateway: 'напрямую на шлюз ITles (TCP)',
  wialon_local: 'через Wialon Local интегратора → ретранслятор Wialon Retranslator',
  omnicomm_online: 'через Omnicomm Online → ретрансляция EGTS',
  traccar: 'через сервер Traccar → подключение API',
};

function SourcesBlock({ id, sources, canManage, onChange }: { id: string; sources: any[]; canManage: boolean; onChange: () => void }) {
  const [pair, setPair] = useState<{ code: string } | null>(null);
  const [osmand, setOsmand] = useState<{ device_id: string; server_url: string } | null>(null);
  const [tracker, setTracker] = useState(() => /[?&]imei=\d+/.test(location.hash));
  const [imei, setImei] = useState(() => /[?&]imei=(\d+)/.exec(location.hash)?.[1] ?? '');
  const [err, setErr] = useState<unknown>(null);
  const stand = useAsync(() => (tracker ? api('GET', '/api/stand').catch(() => null) : Promise.resolve(null)), [tracker]);
  const free: any[] = (stand.data?.stands ?? []).flatMap((s: any) => (s.machines ?? []).filter((x: any) => !x.link?.registered));
  const addPhone = async () => {
    const r = await api('POST', `/api/machines/${id}/sources`, { kind: 'phone' });
    setPair({ code: r.pairing_code });
    onChange();
  };
  const addOsmand = async () => {
    setOsmand(await api('POST', `/api/machines/${id}/sources`, { kind: 'osmand' }));
    onChange();
  };
  const addTracker = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const hit = free.find((x) => x.imei === imei.trim());
      await api('POST', `/api/machines/${id}/sources`, {
        kind: 'tracker',
        external_id: imei,
        label: hit?.model,
        meta: hit ? { model: hit.model, protocol: hit.protocol, path: hit.path } : undefined,
      });
      setImei('');
      setTracker(false);
      if (location.hash.includes('imei=')) history.replaceState(null, '', location.hash.replace(/[?&]imei=\d+/, ''));
      onChange();
    } catch (e) {
      setErr(e);
    }
  };
  const phoneLink = (apiBase() || location.origin) + '/app/#/cab?code=' + (pair?.code ?? '');
  return (
    <div className="space-y-3">
      {sources.length === 0 && <p className="text-sm text-muted-foreground">Источников пока нет — подключите телефон, трекер или платформу.</p>}
      {sources.map((s) => (
        <div key={s.id} className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
          <div>
            <div className="font-semibold">
              {SOURCE_RU[s.kind] ?? s.kind}
              {s.meta?.model ? <span className="font-normal text-muted-foreground"> · {s.meta.model}</span> : null}
            </div>
            <div className="text-xs text-muted-foreground">
              {s.kind === 'tracker' && s.external_id ? `IMEI ${s.external_id}` : s.kind === 'osmand' && s.external_id ? `идентификатор ${s.external_id}` : s.external_id ? `ID ${s.external_id}` : s.label}
              {s.connector_label ? ' · ' + s.connector_label : ''}
              {s.meta?.path ? ` · ${PATH_RU[s.meta.path] ?? s.meta.path}` : ''}
              {s.meta?.can ? ` · ${s.meta.can}` : ''}
              {s.meta?.fuel_sensor ? ` · ДУТ: ${s.meta.fuel_sensor}` : ''}
              {s.kind === 'phone' && !s.paired ? ' · ожидает сопряжения' : ''}
              {s.last_seen_at ? ` · данные ${new Date(s.last_seen_at).toLocaleString('ru-RU')}` : ''}
            </div>
          </div>
          {canManage && (
            <button
              className="text-xs text-danger hover:underline"
              onClick={async () => {
                if (confirm('Отключить источник? Полученные данные сохранятся.')) {
                  await api('DELETE', `/api/sources/${s.id}`);
                  onChange();
                }
              }}
            >
              отключить
            </button>
          )}
        </div>
      ))}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={addPhone}>
            + Телефон (ссылка)
          </button>
          <button className="btn-ghost" onClick={addOsmand}>
            + Traccar Client
          </button>
          <button className="btn-ghost" onClick={() => setTracker(!tracker)}>
            + Трекер по IMEI
          </button>
        </div>
      )}
      {tracker && (
        <form onSubmit={addTracker} className="space-y-2 rounded-xl bg-muted p-3 text-sm">
          <div className="text-xs leading-relaxed text-muted-foreground">
            <b className="text-foreground">Что такое IMEI и зачем он здесь.</b> IMEI — 15-значный заводской номер GSM-модема трекера (на наклейке корпуса и в программе
            настройки). Трекер сам подключается к серверу по мобильному интернету и первым пакетом сообщает IMEI. Эта форма говорит платформе: «пакеты от трекера
            с таким IMEI — это данные этой машины». Пока IMEI не привязан, шлюз держит пакеты трекера в очереди и не теряет их.
          </div>
          <input className="input font-mono" placeholder="IMEI трекера (15 цифр)" inputMode="numeric" value={imei} onChange={(e) => setImei(e.target.value)} required />
          {free.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-semibold">Трекеры стенда в сети, ещё не привязанные к машинам:</div>
              {free.map((x) => (
                <button type="button" key={x.imei} className="block w-full rounded-md border border-border bg-card px-2 py-1 text-left text-xs hover:border-primary" onClick={() => setImei(x.imei)}>
                  <span className="font-mono">{x.imei}</span> · {x.model} · {x.vehicle ?? ''} · {x.protocol}
                </button>
              ))}
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            В программе настройки трекера (Galileosky Configurator, NTC Configurator и т. п.) укажите адрес шлюза ITles и порт протокола. Основной сервер
            (например, региональная система или платформа интегратора) можно не трогать — используйте второй сервер. Подробно — в разделе «База знаний».
          </div>
          <ErrorLine e={err} />
          <button className="btn-primary">Привязать трекер</button>
        </form>
      )}
      {pair && (
        <Modal title="Сопряжение телефона" onClose={() => setPair(null)}>
          <p className="text-sm text-muted-foreground">
            Откройте ссылку на телефоне (Safari на iPhone, Chrome на Android) или введите код на странице «Телефон в кабине». Код действует 24 часа и
            подходит один раз. Для работы с выключенным экраном используйте приложение ITles для Android или Traccar Client.
          </p>
          <div className="my-5 text-center font-mono text-5xl font-bold tracking-[0.3em] text-primary">{pair.code}</div>
          <div className="flex items-center gap-2 rounded-lg bg-muted p-2 text-xs">
            <span className="min-w-0 flex-1 break-all font-mono">{phoneLink}</span>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => navigator.clipboard?.writeText(phoneLink)}>
              копировать
            </button>
          </div>
        </Modal>
      )}
      {osmand && (
        <Modal title="Traccar Client: настройки" onClose={() => setOsmand(null)}>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Traccar Client — бесплатное приложение (App Store / Google Play), которое передаёт координаты в фоне, даже при заблокированном экране. Установите
              его на телефон и введите два значения:
            </p>
            {[
              ['Идентификатор устройства (Device identifier)', osmand.device_id],
              ['Адрес сервера (Server URL)', osmand.server_url],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="label">{k}</div>
                <div className="flex items-center gap-2 rounded-lg bg-muted p-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-sm">{v}</span>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => navigator.clipboard?.writeText(v)}>
                    копировать
                  </button>
                </div>
              </div>
            ))}
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>Точность: «Высокая»; интервал: 10–30 с; расстояние: 0–20 м.</li>
              <li>Разрешение геопозиции: «Всегда» (iPhone) / «Разрешить всегда» и отключить экономию батареи для приложения (Android).</li>
              <li>Включите переключатель «Отслеживание» — точки появятся на карте машины в течение минуты.</li>
            </ol>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ServiceBlock({ id, items, canManage, onChange }: { id: string; items: any[]; canManage: boolean; onChange: () => void }) {
  const [f, setF] = useState<any>({ item: 'Моторное масло', interval_h: 500 });
  const [open, setOpen] = useState(false);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    await api('POST', `/api/machines/${id}/service`, {
      ...f,
      interval_h: Number(f.interval_h),
      last_done_h: Number(f.last_done_h ?? 0),
      volume_l: f.volume_l ? Number(f.volume_l) : undefined,
    });
    setOpen(false);
    onChange();
  };
  return (
    <div className="space-y-2">
      {items.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
          <div>
            <div className="font-semibold">
              {s.item} {s.product ? <span className="font-normal text-muted-foreground">· {s.product}</span> : null}
            </div>
            <div className="text-xs text-muted-foreground">
              каждые {fmt(s.interval_h, 0)} ч · следующая при {fmt(s.due_at_h, 0)} ч{s.volume_l ? ` · ${fmt(s.volume_l, 0)} л` : ''}
            </div>
          </div>
          <div className="text-right">
            <span className={`badge ${s.status === 'overdue' ? 'bg-danger/10 text-danger' : s.status === 'soon' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}>
              {s.status === 'overdue' ? `просрочено на ${fmt(-s.remaining_h, 0)} ч` : Number.isFinite(s.remaining_h) ? `через ${fmt(s.remaining_h, 0)} ч` : 'нет моточасов'}
            </span>
            {s.due_date && <div className="text-[11px] text-muted-foreground">≈ {new Date(s.due_date).toLocaleDateString('ru-RU')}</div>}
            {canManage && (
              <button
                className="ml-2 text-xs text-primary hover:underline"
                onClick={async () => {
                  await api('POST', `/api/service/${s.id}/done`, {});
                  onChange();
                }}
              >
                выполнено
              </button>
            )}
          </div>
        </div>
      ))}
      {canManage && !open && (
        <button className="btn-ghost" onClick={() => setOpen(true)}>
          + Интервал обслуживания
        </button>
      )}
      {open && (
        <form onSubmit={add} className="grid grid-cols-2 gap-2 rounded-xl bg-muted p-3">
          <input className="input col-span-2" value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="Узел (моторное масло, гидравлика…)" />
          <input className="input" value={f.interval_h} onChange={(e) => setF({ ...f, interval_h: e.target.value })} placeholder="Интервал, ч" inputMode="numeric" />
          <input className="input" value={f.last_done_h ?? ''} onChange={(e) => setF({ ...f, last_done_h: e.target.value })} placeholder="Последняя замена, ч" inputMode="numeric" />
          <input className="input" value={f.volume_l ?? ''} onChange={(e) => setF({ ...f, volume_l: e.target.value })} placeholder="Объём, л" inputMode="decimal" />
          <input className="input" value={f.product ?? ''} onChange={(e) => setF({ ...f, product: e.target.value })} placeholder="Продукт FUCHS" />
          <button className="btn-primary col-span-2">Добавить</button>
        </form>
      )}
    </div>
  );
}

export function MachinePage({ id, me }: { id: string; me: Me }) {
  const [tick, setTick] = useState(0);
  const det = useAsync(() => api('GET', `/api/machines/${id}`), [id, tick]);
  const daily = useAsync(() => (sees(me, 'reports') ? api('GET', `/api/machines/${id}/daily?days=30`) : Promise.resolve({ days: [] })), [id, tick]);
  const gf = useAsync(() => (sees(me, 'map') ? api('GET', '/api/geofences') : Promise.resolve({ geofences: [] })), [id]);
  const m = det.data?.machine;
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const oilKey = m?.oil?.values?.oil_level_pct ? 'oil_level_pct' : m?.oil ? Object.keys(m.oil.values)[0] : null;
  const oilSeries = useAsync(() => (oilKey ? api('GET', `/api/machines/${id}/sensors?key=${oilKey}&days=30`) : Promise.resolve({ points: [] })), [id, tick, oilKey]);
  const reload = () => setTick((x) => x + 1);
  const isOwnerAdmin = me.owner_admin && m && me.org_id === m.org_id;
  if (det.error) return <ErrorLine e={det.error} />;
  if (!m) return <div className="text-muted-foreground">Загрузка…</div>;
  const days = daily.data?.days ?? [];
  const geofences = (gf.data?.geofences ?? []).filter((g: any) => g.org_id === m.org_id);
  const remove = async () => {
    if (!confirm(`Переместить «${m.name}» в корзину? В течение 30 дней машину можно восстановить вместе со всеми данными.`)) return;
    await api('DELETE', `/api/machines/${id}`);
    go('#/');
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <a href="#/" className="text-sm text-muted-foreground hover:text-primary">
            ← Парк
          </a>
          <h1 className="text-2xl font-bold">{m.name}</h1>
          <div className="text-sm text-muted-foreground">
            {CATEGORY_RU[m.category]} · {m.make ?? ''} {m.model ?? ''} {m.year ? `· ${m.year}` : ''} · {m.chassis === 'tracked' ? 'гусеничная' : 'колёсная'}
            {m.rotating_upper ? ', поворотная платформа' : ''} · {m.org_name}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Fresh f={m.freshness} t={m.last_data_t} />
          {can(me, 'machines.delete') && (
            <button className="btn-ghost h-8 px-2 text-xs text-danger" onClick={remove} title="Удалить в корзину">
              <Trash2 className="h-4 w-4" /> В корзину
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-5">
          <div className="label">Моточасы</div>
          {!sees(me, 'hours') ? (
            <Hidden block="hours" />
          ) : (
            <>
              <div className="text-3xl font-bold tabular-nums">
                {m.engine_hours ? (m.engine_hours.exact ? '' : '≈ ') + fmt(m.engine_hours.value, 1) : '—'} <span className="text-lg text-muted-foreground">ч</span>
              </div>
              {m.engine_hours && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {METHOD_RU[m.engine_hours.method]} · {new Date(m.engine_hours.t).toLocaleString('ru-RU')}
                  {!m.engine_hours.exact && m.engine_hours.last_exact && (
                    <div>
                      точное: {fmt(m.engine_hours.last_exact.value, 1)} ч ({METHOD_RU[m.engine_hours.last_exact.method]}, {new Date(m.engine_hours.last_exact.t).toLocaleDateString('ru-RU')})
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="card p-5">
          <div className="label">Пробег</div>
          {!sees(me, 'mileage') ? (
            <Hidden block="mileage" />
          ) : (
            <>
              <div className="text-3xl font-bold tabular-nums">
                {m.odometer ? fmt(m.odometer.value, 1) : '—'} <span className="text-lg text-muted-foreground">км</span>
              </div>
              {m.odometer && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {METHOD_RU[m.odometer.method] ?? m.odometer.method}
                  {m.odometer.note ? ` · ${m.odometer.note}` : ''}
                </div>
              )}
            </>
          )}
        </div>
        <div className="card p-5">
          <div className="label">Местоположение</div>
          {!sees(me, 'map') ? (
            <Hidden block="map" />
          ) : !m.location_enabled ? (
            <div className="text-sm text-muted-foreground">Выключено главным администратором владельца: координаты этой машины не принимаются.</div>
          ) : !m.location_visible ? (
            <div className="text-sm text-muted-foreground">Владелец не делится местоположением.</div>
          ) : m.position ? (
            <div>
              <div className="text-lg font-semibold tabular-nums">
                {m.position.lat.toFixed(5)}, {m.position.lon.toFixed(5)}
              </div>
              <div className="text-xs text-muted-foreground">
                {m.position.speed_kmh !== null ? `${fmt(m.position.speed_kmh, 0)} км/ч · ` : ''}
                {new Date(m.position.t).toLocaleString('ru-RU')}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Нет данных</div>
          )}
        </div>
      </div>

      {(m.engine || m.fuel || m.faults?.length || det.data.agro) && (
        <div className="grid gap-4 lg:grid-cols-3">
          {m.engine && (
            <div className="card p-5 lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Параметры двигателя (CAN J1939)</h2>
                <span className="text-[11px] text-muted-foreground">{new Date(m.engine.t).toLocaleString('ru-RU')}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {Object.entries(m.engine.values as Record<string, any>).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-border p-3" title={SENSORS[k]?.source}>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{SENSORS[k]?.label ?? k}</div>
                    <div className={`mt-1 text-xl font-semibold tabular-nums ${v.status === 'crit' ? 'text-danger' : v.status === 'warn' ? 'text-warning' : ''}`}>{fmtSensor(k, v.value)}</div>
                    <div className="text-[10px] text-muted-foreground">{SENSORS[k]?.source}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-4">
            {(m.fuel || det.data.fuel) && (
              <div className="card p-5">
                <h2 className="mb-2 font-semibold">Топливо</h2>
                {m.fuel?.values?.fuel_level_l && (
                  <div className="text-3xl font-bold tabular-nums">
                    {fmt(m.fuel.values.fuel_level_l.value, 0)} <span className="text-lg text-muted-foreground">л{m.tank_l ? ` из ${fmt(m.tank_l, 0)}` : ''}</span>
                  </div>
                )}
                {!m.fuel?.values?.fuel_level_l && m.fuel?.values?.fuel_level_pct && (
                  <div className="text-3xl font-bold tabular-nums">{fmt(m.fuel.values.fuel_level_pct.value, 0)} %</div>
                )}
                {m.fuel?.values?.fuel_rate_lph && <div className="text-xs text-muted-foreground">расход сейчас {fmt(m.fuel.values.fuel_rate_lph.value, 1)} л/ч</div>}
                {det.data.fuel && (
                  <div className="mt-2 space-y-1 text-xs">
                    <div>за 7 суток израсходовано <b className="tabular-nums">{fmt(det.data.fuel.consumed_l, 0)} л</b></div>
                    {det.data.fuel.events.slice(-5).map((e: any) => (
                      <div key={e.t_start} className={e.kind === 'drain' ? 'text-danger' : 'text-success'}>
                        {new Date(e.t_start).toLocaleString('ru-RU')}: {e.kind === 'refill' ? 'заправка' : 'возможный слив'} {fmt(e.litres, 0)} л
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {m.faults && m.faults.length > 0 && (
              <div className="card border-danger/40 p-5">
                <h2 className="mb-2 font-semibold text-danger">Активные ошибки (DM1)</h2>
                {m.faults.map((f: any) => (
                  <div key={`${f.spn}-${f.fmi}`} className="text-sm">
                    <b>SPN {f.spn} / FMI {f.fmi}</b> — {f.text}
                    {f.oc ? <span className="text-xs text-muted-foreground"> · повторов {f.oc}</span> : null}
                  </div>
                ))}
              </div>
            )}
            {det.data.agro && (
              <div className="card p-5">
                <h2 className="mb-1 font-semibold">Обработано сегодня</h2>
                <div className="text-3xl font-bold tabular-nums">{fmt(det.data.agro.area_ha, 1)} <span className="text-lg text-muted-foreground">га</span></div>
                <div className="text-xs text-muted-foreground">
                  {fmt(det.data.agro.work_km, 1)} км с орудием × ширина {fmt(det.data.agro.width_m, 1)} м · {fmt(det.data.agro.work_h, 1)} ч работы
                  {m.fuel?.values?.fuel_used_l ? '' : ''}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {sees(me, 'history') ? <MachineTimeline id={id} geofences={geofences} liveTick={tick} /> : <div className="card p-5"><Hidden block="history" /></div>}

      {sees(me, 'oil') && <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Масло</h2>
          {m.oil?.status && <span className={`badge ${STATUS_CLS[m.oil.status]}`}>{STATUS_RU[m.oil.status]}</span>}
        </div>
        {m.oil ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(m.oil.values as Record<string, any>).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border p-3" title={SENSORS[k]?.source}>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{SENSORS[k]?.label ?? k}</div>
                  <div className={`mt-1 text-xl font-semibold tabular-nums ${v.status === 'crit' ? 'text-danger' : v.status === 'warn' ? 'text-warning' : ''}`}>{fmtSensor(k, v.value)}</div>
                  <div className="text-[11px] text-muted-foreground">{new Date(v.t).toLocaleString('ru-RU')}</div>
                </div>
              ))}
            </div>
            {oilKey && (
              <div>
                <div className="label">{SENSORS[oilKey]?.label}, 30 дней</div>
                <Line points={oilSeries.data?.points ?? []} unit={SENSORS[oilKey]?.unit} />
              </div>
            )}
            {det.data.oil_level && (
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-lg bg-muted p-3">
                  <div className="text-muted-foreground">Расход масла</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {det.data.oil_level.consumption_pct_per_100h === null ? '—' : `${fmt(det.data.oil_level.consumption_pct_per_100h, 1)} % / 100 моточасов`}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {det.data.oil_level.hours ? `по ${fmt(det.data.oil_level.hours, 0)} моточасам` : 'нужно ≥ 20 моточасов и точные моточасы'}
                  </div>
                </div>
                <div className="rounded-lg bg-muted p-3 sm:col-span-2">
                  <div className="text-muted-foreground">Доливы за 30 дней: {det.data.oil_level.topups.length}</div>
                  <div className="mt-1 space-y-0.5 text-xs">
                    {det.data.oil_level.topups.slice(-4).map((t: any) => (
                      <div key={t.t} className="tabular-nums">
                        {new Date(t.t).toLocaleString('ru-RU')}: {fmt(t.from, 0)} → {fmt(t.to, 0)} %
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <OilHowTo />
        )}
      </div>}

      {sees(me, 'reports') && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="card p-5">
            <div className="label">Моточасы по дням, 30 дней</div>
            {sees(me, 'hours') ? <Bars data={days.map((d: any) => ({ label: d.day, value: d.engine_hours }))} unit="ч" color="#1f6feb" /> : <Hidden block="hours" />}
          </div>
          <div className="card p-5">
            <div className="label">Пробег по ГНСС по дням, км</div>
            {sees(me, 'mileage') ? <Bars data={days.map((d: any) => ({ label: d.day, value: d.gnss_km }))} unit="км" color="#10b981" /> : <Hidden block="mileage" />}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {can(me, 'readings.enter') && (
          <div className="card space-y-3 p-5">
            <h2 className="font-bold">Показание счётчика</h2>
            <p className="text-xs text-muted-foreground">
              Показание с панели — эталон: по нему автоматически калибруются счётчики трекера, платформы и оценка телефона.
            </p>
            <ReadingForm id={id} onDone={reload} />
          </div>
        )}
        {sees(me, 'sources') && (
          <div className="card space-y-3 p-5">
            <h2 className="font-bold">Источники данных</h2>
            <SourcesBlock id={id} sources={det.data.sources} canManage={can(me, 'sources.manage')} onChange={reload} />
          </div>
        )}
      </div>

      {sees(me, 'service') && (
        <div className="card space-y-3 p-5">
          <h2 className="font-bold">Обслуживание по моточасам</h2>
          {det.data.avg_daily_hours ? <p className="text-xs text-muted-foreground">Средняя наработка: {fmt(det.data.avg_daily_hours, 1)} ч/сутки</p> : null}
          <ServiceBlock id={id} items={det.data.service} canManage={can(me, 'service.manage')} onChange={reload} />
        </div>
      )}

      {isOwnerAdmin && (
        <div className="card space-y-3 border-warning/40 p-5">
          <h2 className="font-bold">Местоположение этой машины</h2>
          <p className="text-sm text-muted-foreground">
            Решение принимает только главный администратор владельца. Если выключить, сервер перестаёт принимать координаты этой машины: они отбрасываются при
            получении и нигде не сохраняются. Моточасы и пробег по счётчикам продолжают поступать.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={m.location_enabled ? 'btn-danger' : 'btn-primary'}
              onClick={async () => {
                await api('PATCH', `/api/machines/${id}`, { location_enabled: !m.location_enabled });
                reload();
              }}
            >
              {m.location_enabled ? 'Выключить местоположение' : 'Включить местоположение'}
            </button>
            <button
              className="btn-ghost"
              onClick={async () => {
                if (confirm('Удалить всю историю местоположений этой машины? Действие необратимо.')) {
                  await api('DELETE', `/api/machines/${id}/positions`);
                  reload();
                }
              }}
            >
              Удалить историю местоположений
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
