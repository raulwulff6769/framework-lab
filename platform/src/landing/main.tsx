import { createRoot } from 'react-dom/client';
import '../styles.css';
import { ThemeToggle } from '../app/main-toggle';

const REL = 'https://github.com/clutteredcal/ITles/releases/download/v0.3.0';
const DOWNLOADS = [
  { os: 'Android', file: `${REL}/ITles.apk`, note: 'Кабинет и режим «Телефон в кабине». Файл APK, Android 7+.' },
  { os: 'Windows', file: `${REL}/ITles-Windows-x64.zip`, note: 'Windows 10/11 x64: распакуйте и запустите ITles.exe.' },
  { os: 'iPhone / iPad', file: './app/', note: 'Safari → «Поделиться» → «На экран Домой».' },
  { os: 'Веб-кабинет', file: './app/', note: 'Любой браузер, без установки.' },
];

const METRICS = [
  ['Масло', 'уровень, температура, давление, вода и состояние; доливы и расход на 100 моточасов'],
  ['Моточасы', 'из блока двигателя, трекера или по счётчику; у каждого значения видны источник и время'],
  ['Пробег', 'CAN-одометр или устойчивая одометрия ГНСС, корректная и для гусеничной техники'],
  ['Местоположение', 'векторная карта и треки; владелец может отключить сбор координат для любой машины'],
];

const PATHS = [
  ['Трекер уже стоит', 'С 01.01.2025 у лесозаготовительной техники он обязателен (ст. 96.3 ЛК РФ). Подключаем платформу Wialon, Traccar или ISO 15143-3 в два клика либо добавляем наш сервер вторым адресом в трекере.', 'без затрат'],
  ['Датчики масла', 'Многие электронные двигатели уже передают уровень, давление и температуру масла по CAN J1939 — трекер с CAN читает их без новых датчиков. Состояние масла и воду в нём добавляют датчики с Modbus RTU или J1939.', 'CAN / Modbus'],
  ['Ничего не установлено', 'Телефон в кабине: код из 6 цифр — и местоположение, пробег и работа двигателя пишутся даже без связи. Моточасы — по фото счётчика.', 'без затрат'],
];

const ACCURACY = [
  ['Потери точек трекер → сервер', '0 из 5 425 (Galileosky, EGTS, Wialon IPS, архивы после зон без связи)'],
  ['Повторная отправка архива', '0 дублей'],
  ['Моточасы из ЭБУ (J1939 SPN 247)', 'в модельном прогоне: шаг 0,05 ч; сверка с реальной панелью ещё нужна'],
  ['Пробег грузовика и трактора по ГНСС', '−0,3 … −0,7 %'],
  ['Гусеничный экскаватор с поворотной платформой', '+0,6 % (простое суммирование: +906 %)'],
  ['Ложный пробег на стоянке 72 ч под пологом леса', '≤ 0,16 км (простое суммирование: до 59 км)'],
];

const FAQ = [
  ['Нужно ли покупать оборудование?', 'Нет, если в машине есть трекер (для лесозаготовительной техники он обязателен) или можно оставить в кабине телефон. Датчики состояния масла докупаются только тем, кому нужен анализ масла на ходу.'],
  ['Что если в лесу нет связи?', 'Данные копятся в памяти трекера или телефона и досылаются при выезде в зону сети, пока не исчерпан объём архива. У каждой машины видна свежесть данных; там, где связи нет, онлайн-обновлений не бывает.'],
  ['Собираете ли вы персональные данные?', 'Для входа достаточно логина: имена, телефоны и почта водителей не нужны. Владелец может запретить приём координат; правовой режим геоданных нужно оценить до реального пилота.'],
  ['Какие датчики масла подходят?', 'Уровень, давление и температура — из CAN двигателя (J1939 SPN 98/100/175) или датчиками уровня; вода и состояние масла — датчиками с Modbus RTU или J1939 через RS-485/CAN трекера.'],
];

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="relative overflow-hidden border-b border-border">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_70%_0%,color-mix(in_oklab,var(--primary)_22%,transparent),transparent)]" />
        <nav className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-2.5 font-semibold">
            <img src="./favicon.svg" alt="" className="h-8 w-8 rounded-lg" /> ITles
          </div>
          <div className="flex items-center gap-2 text-sm">
            <a href="#download" className="hidden rounded-lg px-3 py-2 text-muted-foreground hover:text-foreground sm:inline">
              Скачать
            </a>
            <ThemeToggle />
            <a href="./app/" className="btn-primary">
              Войти
            </a>
          </div>
        </nav>
        <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-12 md:pt-20">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Для владельцев техники · дистрибьюторов · FUCHS
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight md:text-6xl">
            Масло, моточасы и местоположение <span className="text-primary">любой спецтехники</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
            Харвестеры, тракторы, экскаваторы, самосвалы, лесовозы. Данные берутся из того, что уже есть в машине: трекер, CAN-шина двигателя, платформа мониторинга, телефон.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="./app/" className="btn-primary px-5 py-2.5 text-base">
              Открыть кабинет
            </a>
            <a href="#download" className="btn-ghost px-5 py-2.5 text-base">
              Скачать приложение
            </a>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
        {METRICS.map(([t, d], i) => (
          <div key={t} className={`card p-5 ${i === 0 ? 'border-primary/40' : ''}`}>
            <div className={`text-base font-semibold ${i === 0 ? 'text-primary' : ''}`}>{t}</div>
            <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{d}</div>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-14">
        <h2 className="text-2xl font-semibold tracking-tight">Как подключить машину</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {PATHS.map(([t, d, tag]) => (
            <div key={t} className="card p-6">
              <span className="badge bg-primary/10 text-primary">{tag}</span>
              <h3 className="mt-3 text-lg font-semibold">{t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-14">
        <h2 className="text-2xl font-semibold tracking-tight">Проверка точности на модельном стенде</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Симулированные машины передают данные реальными протоколами трекеров по TCP через шлюз в платформу. Цифры пробега и стоянки получены на синтетических маршрутах, не на смонтированной машине. Отчёты — в репозитории проекта (docs/evidence).
        </p>
        <div className="card mt-6 overflow-hidden">
          <table className="w-full text-left text-sm">
            <tbody>
              {ACCURACY.map(([k, v]) => (
                <tr key={k} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 font-medium">{k}</td>
                  <td className="px-5 py-3 text-muted-foreground">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="download" className="border-y border-border bg-card">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <h2 className="text-2xl font-semibold tracking-tight">Скачать</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            APK и Windows ZIP — прежние сборки v0.3.0 из <a className="underline" href="https://github.com/clutteredcal/ITles/releases/tag/v0.3.0">другой копии ITles</a>. Они не собраны из текущего коммита <a className="underline" href="https://github.com/somemateria/biildfe4">исходников ITles</a>.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-4">
            {DOWNLOADS.map((d) => (
              <a key={d.os} href={d.file} className="rounded-xl border border-border p-5 transition-colors hover:border-primary/50 hover:bg-accent">
                <div className="font-semibold">{d.os}</div>
                <div className="mt-2 text-sm text-muted-foreground">{d.note}</div>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-2xl font-semibold tracking-tight">Вопросы</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {FAQ.map(([q, a]) => (
            <div key={q} className="card p-5">
              <div className="font-medium">{q}</div>
              <div className="mt-2 text-sm text-muted-foreground">{a}</div>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} ITles · мониторинг спецтехники</span>
          <span>Карта: OpenFreeMap © OpenMapTiles, данные © OpenStreetMap</span>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('landing')!).render(<Landing />);
