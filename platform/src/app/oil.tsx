import { SENSORS, type Status } from '../../server/domain/sensors';
import { fmt } from './api';

export const STATUS_CLS: Record<string, string> = {
  crit: 'bg-danger/10 text-danger',
  warn: 'bg-warning/10 text-warning',
  ok: 'bg-success/10 text-success',
};
export const STATUS_RU: Record<string, string> = { crit: 'критично', warn: 'внимание', ok: 'норма' };

export function fmtSensor(key: string, v: number | null | undefined): string {
  const d = SENSORS[key];
  if (v === null || v === undefined || !d) return '—';
  if (key === 'oil_level_low') return v > 0.5 ? 'да' : 'нет';
  return `${fmt(v, d.digits)}${d.unit ? ' ' + d.unit : ''}`;
}

export function StatusDot({ s }: { s: Status | null | undefined }) {
  const c = s === 'crit' ? 'bg-danger' : s === 'warn' ? 'bg-warning' : s === 'ok' ? 'bg-success' : 'bg-muted-foreground/50';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${c}`} />;
}

/** Minimal SVG line chart for sensor series ([t, value][]). */
export function Line({ points, height = 140, unit = '' }: { points: Array<[number, number]>; height?: number; unit?: string }) {
  if (points.length < 2) return <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>нет данных за период</div>;
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = (hi - lo || 1) * 0.1;
  const y = (v: number) => 100 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * 100;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' ');
  // Same rule as Bars: on a narrow card the series keeps a readable width and scrolls horizontally
  // instead of compressing; on wide cards the svg stretches to full width as before.
  const MIN_W = 480;
  return (
    <div className="overflow-x-auto pb-1">
      <div className="relative" style={{ height, minWidth: MIN_W }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
          <path d={`${d} L100,100 L0,100 Z`} fill="var(--primary)" opacity="0.08" />
          <path d={d} fill="none" stroke="var(--primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="absolute right-1 top-0 text-[10px] text-muted-foreground">
          {fmt(hi, 1)} {unit}
        </div>
        <div className="absolute bottom-0 right-1 text-[10px] text-muted-foreground">
          {fmt(lo, 1)} {unit}
        </div>
      </div>
    </div>
  );
}

export function OilHowTo() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>Данных с датчиков масла пока нет. Подключить можно тремя способами:</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          <b className="text-foreground">CAN двигателя — без новых датчиков.</b> Электронные двигатели обычно передают уровень (J1939 SPN 98), давление (SPN 100) и температуру масла (SPN
          175). Трекер с CAN (Galileosky, Навтелеком) читает их в режиме FMS/сканера CAN.
        </li>
        <li>
          <b className="text-foreground">Сигнализатор или датчик уровня.</b> Резистивный датчик — на аналоговый вход трекера с тарировкой; токовый сигнализатор вроде СУЖ (≈35 мА в воздухе,
          ≈45 мА в жидкости) — через шунт на аналоговый вход с порогом, получается «ниже минимума»; J1939-датчик (например, Rochester T-LL415) — на CAN.
        </li>
        <li>
          <b className="text-foreground">Датчик состояния масла</b> (вода, вязкость, частицы износа) с Modbus RTU или J1939 — на RS-485/CAN трекера. Навтелеком опрашивает Modbus штатно
          (до 32 параметров), Galileosky — через алгоритм обмена RS-485 в пользовательские теги.
        </li>
      </ol>
    </div>
  );
}
