import { useEffect, useRef, useState } from 'react';
import { api, ago } from '../api';
import { ErrorLine } from '../ui';
import { EngineDetector } from './engine';
import * as outbox from './queue';
import { robustDistance, type Fix } from '../../../server/domain/odometry';
import { haversineM as haversine } from '../../../server/domain/geo';
import { fixTime, locationProvider, type GeoFix, type GeoProvider } from './geo';

const DEV_KEY = 'itles_device_token';
const CFG_KEY = 'itles_device_cfg';
const HOURS_KEY = 'itles_device_hours';
const ODO_KEY = 'itles_device_odo';

interface Cfg {
  source_id: string;
  machine: { id: string; name: string; category: string; chassis: 'wheeled' | 'tracked'; rotating_upper: boolean };
  location_enabled: boolean;
}

interface Diag {
  provider: string;
  permission: string;
  fixes: number;
  lastFix: number | null;
  lastAcc: number | null;
  lastError: string | null;
  clockFixed: number;
  queued: number;
  sentPositions: number;
  lastReply: string | null;
  rejected: Record<string, number>;
}

const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
const isAndroid = /Android/.test(navigator.userAgent);

function Pair({ onDone }: { onDone: () => void }) {
  const initial = /code=(\d{6})/.exec(location.hash)?.[1] ?? '';
  const [code, setCode] = useState(initial);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const r = await api('POST', '/api/devices/enroll', { code }, null);
      localStorage.setItem(DEV_KEY, r.token);
      localStorage.setItem(CFG_KEY, JSON.stringify(r.config));
      history.replaceState(null, '', location.pathname + '#/cab');
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dark flex min-h-full items-center justify-center bg-background p-4 text-foreground">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-7 text-center">
        <h1 className="text-xl font-bold">Телефон в кабине</h1>
        <p className="text-sm text-muted-foreground">Введите 6 цифр со страницы машины в кабинете ITles («Источники данных» → «+ Телефон (ссылка)»).</p>
        <input
          className="input text-center font-mono text-3xl tracking-[0.4em]"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
        <ErrorLine e={err} />
        <button className="btn-primary w-full" disabled={code.length !== 6 || busy}>
          {busy ? 'Подключаем…' : 'Подключить'}
        </button>
        <a href="#/" className="block text-xs text-muted-foreground">
          ← Кабинет
        </a>
      </form>
    </div>
  );
}

function Help({ denied }: { denied: boolean }) {
  return (
    <div className={`space-y-2 rounded-2xl border p-4 text-sm ${denied ? 'border-danger/50 bg-danger/5' : 'border-border bg-card'}`}>
      {denied && <div className="font-semibold text-danger">Телефон не разрешил геопозицию этому сайту.</div>}
      {isIos ? (
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Настройки → Конфиденциальность и безопасность → Службы геолокации: <b>вкл</b>.</li>
          <li>Там же → «Сайты Safari»: <b>«При использовании приложения»</b> и <b>«Точная геопозиция» — вкл</b>.</li>
          <li>В Safari нажмите «аА» слева от адреса → «Настройки веб-сайта» → Геопозиция: <b>«Разрешить»</b>. Обновите страницу.</li>
          <li>Нужна передача при заблокированном экране — установите бесплатный <b>Traccar Client</b> из App Store и возьмите настройки на странице машины («+ Traccar Client»).</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Включите «Местоположение» в шторке телефона.</li>
          <li>Chrome: значок слева от адреса → «Разрешения» → Местоположение: <b>«Разрешить»</b>. Обновите страницу.</li>
          <li>
            Для работы в фоне установите{' '}
            <a className="underline" href="https://github.com/raulwulff6769/framework-lab/releases/download/android-2026.09.24/itles-android.apk">
              приложение ITles для Android
            </a>{' '}
            (фоновая служба) или Traccar Client из Google Play.
          </li>
        </ol>
      )}
    </div>
  );
}

export function Cab() {
  const [token, setToken] = useState(() => localStorage.getItem(DEV_KEY));
  const [cfg, setCfg] = useState<Cfg | null>(() => JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null'));
  const [active, setActive] = useState(false);
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [gpsErr, setGpsErr] = useState<{ code: number; message: string } | null>(null);
  const [queued, setQueued] = useState(0);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const [engine, setEngine] = useState(false);
  const [hours, setHours] = useState(() => Number(localStorage.getItem(HOURS_KEY) ?? 0));
  const [reading, setReading] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [diag, setDiag] = useState<Diag>({ provider: '', permission: 'неизвестно', fixes: 0, lastFix: null, lastAcc: null, lastError: null, clockFixed: 0, queued: 0, sentPositions: 0, lastReply: null, rejected: {} });
  const upd = (p: Partial<Diag> | ((d: Diag) => Partial<Diag>)) => setDiag((d) => ({ ...d, ...(typeof p === 'function' ? p(d) : p) }));
  const det = useRef(new EngineDetector());
  const runStart = useRef<number | null>(null);
  const lastSent = useRef<{ t: number; lat: number; lon: number } | null>(null);
  const odoBuf = useRef<Fix[]>([]);
  const provider = useRef<GeoProvider | null>(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRef = useRef<() => Promise<void>>(async () => {});

  const queue = async (rec: unknown, urgent = false) => {
    await outbox.push(rec);
    setQueued(await outbox.count());
    if (urgent) return void syncRef.current();
    if (!soon.current) soon.current = setTimeout(() => { soon.current = null; syncRef.current(); }, 3000);
  };

  const addHours = (until: number) => {
    if (runStart.current === null) return;
    const h = Number(localStorage.getItem(HOURS_KEY) ?? 0) + (until - runStart.current) / 3600e3;
    runStart.current = until;
    localStorage.setItem(HOURS_KEY, String(h));
    setHours(h);
    return h;
  };

  const syncing = useRef(false);
  const sync = async () => {
    if (!token || syncing.current) return;
    syncing.current = true;
    try {
      for (let round = 0; round < 5; round++) {
        const batch = await outbox.peek(500);
        if (!batch.length) break;
        const r = await api('POST', '/api/ingest', { records: batch.map((b) => b.rec) }, token);
        await outbox.remove(batch.map((b) => b.key));
        const rej: Record<string, number> = {};
        for (const x of r.rejected ?? []) rej[x.reason] = (rej[x.reason] ?? 0) + 1;
        upd((d) => ({
          sentPositions: d.sentPositions + (r.positions ?? 0),
          lastReply: `принято точек ${r.positions}, счётчиков ${r.counters}, дублей ${r.duplicates}${r.location_dropped ? `, координаты отброшены (выключены владельцем) ${r.location_dropped}` : ''}`,
          rejected: Object.keys(rej).length ? rej : d.rejected,
        }));
        if (r.config) {
          localStorage.setItem(CFG_KEY, JSON.stringify(r.config));
          setCfg(r.config);
        }
      }
      if (!(await outbox.count())) {
        const c = await api('GET', '/api/devices/me', undefined, token);
        localStorage.setItem(CFG_KEY, JSON.stringify(c));
        setCfg(c);
      }
      const pending: any[] = JSON.parse(localStorage.getItem('itles_pending_readings') ?? '[]');
      const left: any[] = [];
      for (const rec of pending) {
        try {
          await api('POST', '/api/devices/reading', rec, token);
        } catch (e: any) {
          if (e.status === 0 || e.status >= 500) left.push(rec);
        }
      }
      localStorage.setItem('itles_pending_readings', JSON.stringify(left));
      setLastSync(Date.now());
      setSyncErr(null);
    } catch (e: any) {
      setSyncErr(e.status === 0 ? 'нет связи — данные копятся в телефоне' : e.message);
      if (e.status === 401) {
        localStorage.removeItem(DEV_KEY);
        setToken(null);
      }
    } finally {
      syncing.current = false;
      const n = await outbox.count();
      setQueued(n);
      upd({ queued: n });
    }
  };
  syncRef.current = sync;

  const onFix = async (p: GeoFix) => {
    const { t, corrected } = fixTime(p.time);
    setFix(p);
    setGpsErr(null);
    upd((d) => ({ fixes: d.fixes + 1, lastFix: Date.now(), lastAcc: p.accuracy, clockFixed: d.clockFixed + (corrected ? 1 : 0), lastError: null }));
    const c = cfgRef.current;
    const speed = p.speed !== null && p.speed >= 0 ? p.speed * 3.6 : null;
    const f: Fix = { t, lat: p.latitude, lon: p.longitude, speedKmh: speed, accM: p.accuracy ?? undefined };
    if (c && !c.location_enabled) {
      // coordinates never leave the phone: distance is computed here with the same algorithm
      odoBuf.current.push(f);
      if (odoBuf.current.length >= 600) {
        const km = robustDistance(odoBuf.current, { chassis: c.machine.chassis, rotatingUpper: c.machine.rotating_upper, category: c.machine.category }).km;
        const odo = Number(localStorage.getItem(ODO_KEY) ?? 0) + km;
        localStorage.setItem(ODO_KEY, String(odo));
        odoBuf.current = [odoBuf.current.at(-1)!];
        await queue({ t, odometer_km: odo, odometer_method: 'device' });
      }
      return;
    }
    const prev = lastSent.current;
    // some phones report no Doppler speed: then displacement decides
    const moved = prev ? haversine(prev.lat, prev.lon, f.lat, f.lon) >= Math.max(20, 2 * (p.accuracy ?? 10)) : true;
    const moving = (speed ?? 0) >= 1.5 || moved;
    const due = !prev || t - prev.t >= (moving ? 5_000 : 60_000);
    if (!due) return;
    lastSent.current = { t, lat: f.lat, lon: f.lon };
    await queue(
      { t, lat: f.lat, lon: f.lon, speed_kmh: speed, course: p.bearing, alt: p.altitude, acc_m: p.accuracy },
      !prev, // the very first point goes out immediately so the dispatcher sees the phone at once
    );
  };

  const startLocation = () => {
    provider.current?.stop();
    const prov = locationProvider();
    provider.current = prov;
    upd({ provider: prov.name });
    prov.start(onFix, (e) => {
      setGpsErr(e);
      upd({ lastError: `${e.code}: ${e.message}` });
    });
  };

  useEffect(() => {
    if (!token || !active) return;
    let wake: any = null;
    const lockScreen = async () => {
      try {
        wake = await (navigator as any).wakeLock?.request('screen');
      } catch {
        // not supported: the phone must stay on the charger with screen timeout off
      }
    };
    lockScreen();
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      lockScreen();
      // iOS suspends the page in the background and does not always resume the watch
      if (!provider.current?.background) startLocation();
      syncRef.current();
    };
    document.addEventListener('visibilitychange', onVis);
    const d = det.current;
    d.onChange = async (running, t) => {
      setEngine(running);
      if (running) runStart.current = t;
      const h = running ? Number(localStorage.getItem(HOURS_KEY) ?? 0) : addHours(t);
      if (!running) runStart.current = null;
      await queue({ t, engine_hours: h, engine_hours_method: 'device' });
    };
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (a && a.x !== null && a.y !== null && a.z !== null) d.sample(a.x, a.y, a.z, Date.now());
    };
    addEventListener('devicemotion', onMotion);
    const hoursTimer = setInterval(async () => {
      if (det.current.running) {
        const h = addHours(Date.now());
        await queue({ t: Date.now(), engine_hours: h, engine_hours_method: 'device' });
      }
    }, 5 * 60_000);
    const syncTimer = setInterval(() => syncRef.current(), 20_000);
    const permTimer = setInterval(async () => {
      try {
        const st = await (navigator as any).permissions?.query({ name: 'geolocation' });
        if (st) upd({ permission: st.state === 'granted' ? 'разрешено' : st.state === 'denied' ? 'запрещено' : 'спросит' });
      } catch {
        upd({ permission: 'браузер не сообщает' });
      }
    }, 5000);
    syncRef.current();
    return () => {
      removeEventListener('devicemotion', onMotion);
      provider.current?.stop();
      provider.current = null;
      clearInterval(hoursTimer);
      clearInterval(syncTimer);
      clearInterval(permTimer);
      document.removeEventListener('visibilitychange', onVis);
      wake?.release?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, active]);

  if (!token || !cfg) return <Pair onDone={() => { setToken(localStorage.getItem(DEV_KEY)); setCfg(JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null')); }} />;

  const start = () => {
    // inside the tap: iOS shows the location prompt and allows the motion prompt only from a user gesture
    startLocation();
    const DM: any = (window as any).DeviceMotionEvent;
    if (DM?.requestPermission) DM.requestPermission().catch(() => {});
    setActive(true);
  };
  const stop = () => {
    provider.current?.stop();
    setActive(false);
    syncRef.current();
  };
  const checkNow = () => {
    upd({ lastError: null });
    navigator.geolocation?.getCurrentPosition(
      (p) => onFix({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, altitude: p.coords.altitude, speed: p.coords.speed, bearing: Number.isFinite(p.coords.heading ?? NaN) ? p.coords.heading : null, time: p.timestamp }),
      (e) => {
        setGpsErr({ code: e.code, message: e.message });
        upd({ lastError: `${e.code}: ${e.message}` });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  };
  const sendReading = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(reading.replace(',', '.'));
    const rec = { id: crypto.randomUUID(), metric: 'engine_hours', value, t: new Date().toISOString() };
    try {
      await api('POST', '/api/devices/reading', rec, token);
      setMsg('Показание сохранено на сервере');
    } catch (err: any) {
      if (err.status === 0) {
        // keep it until coverage returns; the id makes the retry idempotent
        const pending = JSON.parse(localStorage.getItem('itles_pending_readings') ?? '[]');
        localStorage.setItem('itles_pending_readings', JSON.stringify([...pending, rec]));
        setMsg('Нет связи: показание сохранено в телефоне и будет отправлено позже');
      } else setMsg(err.message);
    }
    setReading('');
  };

  const acc = fix?.accuracy ?? null;
  const denied = gpsErr?.code === 1;
  const coarse = acc !== null && acc > 500;
  return (
    <div className="dark min-h-full bg-background p-4 text-foreground">
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Телефон в кабине</div>
            <div className="text-lg font-bold">{cfg.machine.name}</div>
          </div>
          <a href="#/" className="text-xs text-muted-foreground">
            кабинет
          </a>
        </div>
        {!active ? (
          <button onClick={start} className="w-full rounded-2xl bg-primary py-6 text-xl font-bold text-primary-foreground">
            Начать работу
          </button>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">ГНСС</div>
                <div className={`text-2xl font-bold ${gpsErr ? 'text-danger' : fix ? 'text-success' : ''}`}>{gpsErr ? 'нет' : acc !== null ? `±${Math.round(acc)} м` : 'ищем…'}</div>
                <div className="text-xs text-muted-foreground">
                  {gpsErr
                    ? gpsErr.code === 1
                      ? 'нет разрешения на геопозицию'
                      : gpsErr.code === 3
                        ? 'нет сигнала: выйдите на открытое место'
                        : 'геопозиция недоступна'
                    : fix
                      ? `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`
                      : 'разрешите геопозицию, если телефон спросит'}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">Отправка</div>
                <div className="text-2xl font-bold">{diag.sentPositions}</div>
                <div className="text-xs text-muted-foreground">{syncErr ?? (queued ? `в очереди ${queued}` : `точек принято · ${ago(lastSync)}`)}</div>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">Двигатель</div>
                <div className={`text-2xl font-bold ${engine ? 'text-success' : 'text-foreground'}`}>{engine ? 'работает' : 'остановлен'}</div>
                <div className="text-xs text-muted-foreground">вибрация {det.current.lastRms.toFixed(3)}</div>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">Работа двигателя (оценка)</div>
                <div className="text-2xl font-bold">≈ {hours.toFixed(1)} ч</div>
                <div className="text-xs text-muted-foreground">калибруется по счётчику</div>
              </div>
            </div>
            {!cfg.location_enabled && <div className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">Местоположение этой машины выключено владельцем: координаты не отправляются, телефон считает только пробег.</div>}
            {coarse && <div className="rounded-xl bg-warning/10 p-3 text-xs text-warning">Погрешность больше 500 м: похоже, выключена «Точная геопозиция» для сайтов Safari/браузера.</div>}
            {Object.keys(diag.rejected).length > 0 && (
              <div className="rounded-xl bg-danger/10 p-3 text-xs text-danger">Сервер отклонил записи: {Object.entries(diag.rejected).map(([k, v]) => `${k} × ${v}`).join(', ')}</div>
            )}
            <button onClick={stop} className="w-full rounded-xl border border-border py-2 text-sm text-muted-foreground">
              Остановить
            </button>
          </>
        )}
        {(denied || !active) && <Help denied={denied} />}
        <form onSubmit={sendReading} className="space-y-2 rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold">Показание счётчика моточасов</div>
          <input className="input text-lg" inputMode="decimal" placeholder="например 4521,4" value={reading} onChange={(e) => setReading(e.target.value)} required />
          <button className="w-full rounded-xl bg-primary py-3 font-semibold text-primary-foreground">Отправить</button>
          {msg && <div className="text-sm text-foreground">{msg}</div>}
        </form>
        <div className="rounded-2xl border border-border bg-card p-4 text-xs">
          <button className="w-full text-left font-semibold" onClick={() => setShowDiag(!showDiag)}>
            Диагностика {showDiag ? '▲' : '▼'}
          </button>
          {showDiag && (
            <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
              <div>защищённое соединение (HTTPS): {window.isSecureContext ? 'да' : 'НЕТ — геопозиция не будет работать'}</div>
              <div>источник координат: {diag.provider || (navigator.geolocation ? 'браузер' : 'НЕТ API геопозиции')}</div>
              <div>разрешение: {diag.permission}</div>
              <div>точек от телефона: {diag.fixes}{diag.lastFix ? `, последняя ${ago(diag.lastFix)}` : ''}{diag.lastAcc !== null ? `, ±${Math.round(diag.lastAcc)} м` : ''}</div>
              <div>время точек исправлено по часам телефона: {diag.clockFixed}</div>
              <div>последняя ошибка: {diag.lastError ?? 'нет'}</div>
              <div>очередь: {queued} · принято сервером точек: {diag.sentPositions}</div>
              <div>ответ сервера: {diag.lastReply ?? '—'}</div>
              <div>устройство: {isIos ? 'iPhone/iPad' : isAndroid ? 'Android' : 'другое'} · {navigator.userAgent.slice(0, 80)}</div>
              <div className="flex gap-2 pt-1 font-sans">
                <button className="btn-ghost px-2 py-1 text-xs" onClick={checkNow}>
                  Проверить геопозицию сейчас
                </button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => syncRef.current()}>
                  Отправить очередь
                </button>
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {provider.current?.background
            ? 'Фоновая служба Android передаёт координаты и при выключенном экране. Без связи точки копятся и уходят автоматически.'
            : 'Браузер передаёт координаты, только пока эта страница открыта и экран включён. Держите телефон на зарядке. Для фона: iPhone — Traccar Client, Android — приложение ITles или Traccar Client.'}
        </p>
      </div>
    </div>
  );
}

export type { Cfg };
