**Обновление 27.09.2026, 07:xx UTC:** production `itles.vercel.app` + `prosvet.bond` READY, бандл `landing-Du5YNVtQ.js` (совпал с локальной сборкой ветки `work/kyzikos`, коммит 76b68e3). Деплой prebuilt через `vercel deploy --prebuilt --prod` (Build Output API v3 из `.vercel/output`). Изменение: на телефоне (portrait) камера сцены «Нет сети — данные ждут» плавно ведётся вправо к мачте, пока едет точка, — столб и досыл к нему теперь в кадре (проверено скриншотами 390×844). Desktop-раскладка не тронута (pan только при L.portrait). БД не менялась.

# Vercel: состояние, безопасная проверка и переход на Git-деплой

**Обновление 26.09.2026, 05:40 UTC:** production `itles.vercel.app` READY из
`Diaz179/ITl@739671e` (PR #2: лендинг-фильм из сцен; только фронтенд). Тот же bootstrap:
`build.sh` прошлого выпуска, изменён только SHA архива. Бандлы (`landing-D8yV6uLO.js`,
`app-DLTjxXZa.js` и др.) совпали с локальной сборкой того же архива. Health 200 (`db=pg`),
setup `needs_setup=false`, `/api/connectors` без авторизации 401, домены эмуляторов 200.
Кандидат на мгновенный откат — деплой 26.09 01:43 UTC. БД не менялась.

**Обновление 26.09.2026, 01:43 UTC:** production `itles.vercel.app` READY из
`Diaz179/ITl@a45ca6be1aa0` (PR #2: лендинг-фильм, палитра, значки; только фронтенд).
Тот же bootstrap через MCP `create_deployment`: `build.sh` предыдущего выпуска, изменён
только SHA архива `codeload.github.com/Diaz179/ITl`. Архив собран локально заранее: имена
бандлов (`landing-JBgsmrgJ.js`, `app-kRjCAOkK.js` и др.) совпали с production. После выпуска
health 200 (`db=pg`), setup `needs_setup=false`, `/api/connectors` без авторизации 401,
домены эмуляторов 200, `favicon.ico` 200. Кандидат на мгновенный откат — деплой
25.09 22:39 UTC. БД не менялась.

**Обновление 25.09.2026, 22:39 UTC:** production `itles.vercel.app` READY из
`Diaz179/ITl@2a18962fa858` (редизайн «Отсчёт», только фронтенд). Bootstrap-деплой через
MCP `create_deployment` с тем же `build.sh`; архив скачивается с
`codeload.github.com/Diaz179/ITl`. Перед выпуском архив собран локально: хеши бандлов
совпали. После выпуска health 200 (`db=pg`), setup `needs_setup=false`, `/api/connectors`
без авторизации 401, домены эмуляторов 200. Прежний READY-деплой (14:59 UTC) остаётся
кандидатом на мгновенный откат. БД не менялась.

**Обновление 25.09.2026, 14:59 UTC:** production `itles.vercel.app` READY из
`mikhailsilva/horisont@581699f9a85c` (АвтоГРАФ,
пакеты 0.3.3). Перед обновлением сделана приватная копия PG18; миграция схемы
5 → 6 прошла транзакционно, количества машин, пользователей, источников,
коннекторов и позиций не изменились. Публичные health/setup ответили 200,
закрытый endpoint коннекторов без авторизации — 401; JS-бандлы совпадают
с локальной сборкой. Строка `version=0.3.0` в health осталась прежней.
Деплой по-прежнему bootstrap (Git-интеграции нет); при следующей ручной сборке
использовать `corepack pnpm` после `corepack prepare pnpm@10.26.0`: голый
`pnpm` в окружении Vercel использовал несовместимую версию и отверг lockfile.
Быстрый откат кода — promotion прежнего READY-деплоя; восстанавливать данные
из резервной копии без отдельной оценки нельзя.

**Обновление 25.09.2026, 06:24 UTC:** production `itles.vercel.app` имеет статус READY,
собран из `mikhailsilva/horisont@ea46170` (карта, организации, Traccar, пакеты 0.3.2).
Health 200; `/app/` содержит `app-BLyq6uc0.js`, скачивание указывает на новый релиз.
`/api/traccar-demo/api/devices` без токена возвращает 401. Версия в health `0.3.0`
осталась прежней и не является идентификатором коммита. БД и VPS не изменялись.

В bootstrap-деплое из архива перед `mkdir source` нужно очищать **только рабочие
каталоги этой сборки** `source` и `.vercel/output`: Vercel восстанавливает их из
кэша предыдущего запуска. Первая попытка 25.09 остановилась на `File exists`;
повторная с очисткой этих генерируемых каталогов завершилась READY. Исходники
скачивались из архива закреплённого коммита, pnpm закреплён на 10.26.0.
Ниже — исторический срез и общая процедура, а не текущая версия production.

Срез **23.09.2026 UTC**; это инструкция для будущей авторизованной работы, **не**
запрос на изменение production. Источник текущего состояния — read-only MCP
Vercel (`list_projects`, `get_project`, `list_deployments`, `get_deployment`,
`list_project_domains`, `filter_project_envs` с `decrypt:false`) и публичные GET
`https://itles.vercel.app/`, `/api/health`, `/api/setup/status`. Значения переменных
не сохранялись. Номера MCP-серверов пересматривать по [skill](../../.agents/skills/mcp-servers/SKILL.md).

> **Перенос 25.09.2026.** Рабочий репозиторий — [`mikhailsilva/horisont`](https://github.com/mikhailsilva/horisont):
> дерево исходников с изменениями PR #5 импортировано из `raulwulff6769/framework-lab`
> через squash-слияние [PR #1](https://github.com/mikhailsilva/horisont/pull/1). Исходные
> Git-предки не входят в ветку по умолчанию; полная история доступна по
> [архивному тегу `archive/framework-lab-pr5-2026.09.25`](https://github.com/mikhailsilva/horisont/tree/archive/framework-lab-pr5-2026.09.25)
> в том же репозитории (дерево совпадает с импортом).
> Действующий production это не затронуло: по последней проверке 24.09
> `itles.vercel.app` обслуживает выпуск, собранный из framework-lab по закреплённому SHA.
> Исторические APK и Windows ZIP перенесены отдельными prerelease без пересборки;
> production-базу и деплой Vercel перенос не затронул. Безопасная проверка нового кода — локальная сборка
> `pnpm --dir platform build:vercel`, локальное превью и изолированный Preview
> с синтетическими данными (шаги 3–4 раздела «Процедура изменения» ниже).

## Текущее, не обещание будущей доступности

- Существующий проект **`itles`** в Vercel: канонический домен `itles.vercel.app`
  публичен, deployment URLs и preview прикрыты Vercel SSO. Последний deployment
  в статусе `READY`, production, создан **12:28 UTC**, регион `iad1`.
- На дату проверки три публичных GET дали HTTP 200. `/api/health` вернул
  `ok=true`, `db=pg`, `version=0.2.0`; `/api/setup/status` сообщил
  `needs_setup=false`. Это только короткий smoke-test БД, не вход пользователя,
  не проверка безопасности или качества данных. `version` — строка из API,
  не идентификатор установленного Git-коммита/релиза.
- В проекте обнаружены ключи **`DATABASE_URL`, `SETUP_KEY`, `APP_SECRET`,
  `GATEWAY_TOKEN`, `CRON_SECRET`** для production и preview. Исторический дизайн
  называет Neon PostgreSQL в `us-east-1` и SSL verify-full; свежий health
  подтвердил PostgreSQL, но **не** провайдера, версию БД, регион и TLS-настройку.
- Связанный Git-проект в прочитанном контексте Vercel отсутствует; последний
  deployment не содержит Git SHA. Исторически архив коммита старого GitHub
  собирался вручную; точное происхождение живого артефакта сейчас не
  подтверждено. `itles-web` и `itles-probe` — отдельные проекты, не менять их
  вместо `itles`.

## 24.09.2026: выпуск из framework-lab

Историческая запись: источником тогда был `raulwulff6769/framework-lab`; с 25.09
этот код (включая PR #5) есть в основной ветке `mikhailsilva/horisont`, а исходная
история доступна по архивному тегу выше, не как предки основной ветки. Production
остаётся на закреплённом SHA выпуска 24.09. Выполнено с явного
согласия владельца; значения секретов не выводились.

1. Резервная копия: `pg_dump` **18.6** (сервер Neon — PostgreSQL 18.6; клиент 16 отказывается) в формате custom и plain,
   хранится только в песочнице агента. Долговременный откат данных — восстановление Neon на момент
   времени в пределах окна тарифа.
2. Миграция схемы 3 → 4 проверена на копии: дамп восстановлен в локальный PostgreSQL 18,
   `scripts/db-migrate.ts --demo` прошёл, число позиций, счётчиков, показаний, машин, пользователей и
   источников совпало с продом, ключевые API нового кода ответили 200.
3. Боевая база: `DATABASE_URL=<unpooled> npx tsx scripts/db-migrate.ts --demo --gateway-key-file <файл 600>` —
   схема, демо-тенант и ключ шлюза стенда в одной транзакции.
4. Деплой: `create_deployment` MCP Vercel в существующий проект `itles` (target `production`) с двумя
   файлами — `package.json` (`build: sh build.sh`) и `build.sh`, который скачивает архив
   `codeload.github.com/raulwulff6769/framework-lab/tar.gz/<SHA>` и выполняет
   `pnpm install --frozen-lockfile && pnpm build:vercel`. Та же сборка перед этим повторена локально.
   SHA — голова PR #4; адрес деплоя и SHA фиксируются в описании PR.
5. Проверка: `/api/health` → `version=0.3.0`, `/api/setup/status` → `needs_setup=false`, `/api/demo` → 11 учёток,
   cron и `/api/stand/report` без ключей → 403/401; вход под демо-учётками и страницы — в браузере.

Откат кода: в Vercel повысить предыдущий production-деплой (Instant Rollback). Код v3 на схеме v4
работает: его SQL только `create … if not exists`, новые столбцы имеют значения по умолчанию; роли
`superadmin/analyst/…` старый интерфейс покажет как обычных пользователей.


## Код и границы инфраструктуры

`platform/scripts/build-vercel.mjs` выдаёт Build Output API **v3** в
`platform/.vercel/output`: статический интерфейс, Node-функцию на `/api/*`
(`nodejs22.x`) и cron GET `/api/cron/daily` в 03:00 UTC. Последний требует
`Authorization: Bearer` из `CRON_SECRET`. `platform/server/db.ts` использует
PostgreSQL pool (до 3 соединений на экземпляр); для serverless нужен
проверенный pooled endpoint. Vercel обрабатывает HTTP, **не** TCP-пакеты
трекеров: `gateway/` размещается отдельно на контролируемом сервере и
пересылает по HTTPS на `/api/ingest`.

## Процедура изменения (только с согласия владельца)

1. **Перед изменением.** Сверить выбранный владельцем GitHub — актуальный рабочий
   репозиторий [`mikhailsilva/horisont`](https://github.com/mikhailsilva/horisont), —
   назначенную ветку по умолчанию, целевой PR/коммит
   (если PR возможен) и состояние `itles` через действующий MCP; проверить
   доступность canonical domain, статистику ошибок, список переменных **только
   по именам** и области production/preview. Не отправлять в issue значения
   конфигурации или ответы из MCP. Проверить доступ к резервной копии Neon и
   возможность восстановления **на отдельной тестовой базе**, прежде чем
   допускать миграции схемы; rollback кода не откатывает данные.
2. **Секреты.** Если старые строки подключения/пароли ещё совпадают с
   переданными в частном архиве чата, заменить у владельца Neon/приложения,
   обновить защищённые переменные Vercel для нужных областей, отозвать старые,
   проверить health. `SETUP_KEY` после завершённого первичного setup требует
   отдельного решения о хранении: POST setup дополнительно запрещает повторную
   инициализацию при наличии организаций. Не считывать и не публиковать значения.
3. **Сборка и привязка.** Локально `pnpm --dir platform install --frozen-lockfile`,
   `pnpm --dir platform typecheck`, `pnpm --dir platform test`,
   `pnpm --dir platform build:vercel`. В настройках **существующего** проекта
   связать GitHub с актуальным рабочим репозиторием
   [`mikhailsilva/horisont`](https://github.com/mikhailsilva/horisont) (не с upstream
   `framework-lab`); указать согласованную production
   branch **только после её появления и проверки**, корневую директорию
   **`platform/`**. Сверить команду сборки и поведение
   Build Output API на **Preview**; новый корневой `package.json` предназначен
   для локального Preview и не должен менять корень Vercel. Не копировать
   `DATABASE_URL` между production и preview, если это даёт превью запись в
   боевую БД: выделить отдельную БД/ветку Neon и синтетические данные.
4. **Проверка превью.** Убедиться, что сборка привязана к ожидаемому SHA,
   HTTPS/SSO работает, `GET /api/health` даёт ожидаемый драйвер, тестовый
   setup/login/API выполняются **только в изолированной среде**, геолокация
   отключается до сохранения и cron не выдаёт данные без авторизации.
   Повторить сценарий `scripts/gateway_e2e.py` **локально**; он не должен
   отправлять модельные данные в production. Проверить ссылки на файлы релизов —
   сборки 24.09 (`android-2026.09.24`, `desktop-2026.09.24`) указывают на
   исторические prerelease в `mikhailsilva/horisont`, а не на текущую сборку, — и адаптивный
   интерфейс в браузере.
5. **Production и откат.** Только после разрешения владельца перенести
   проверенный коммит, зафиксировать SHA, ID deployment и timestamp без
   секретов. Сделать публичные GET health/landing, затем согласованный
   тестовый вход и метрики ошибок/очереди; не выводить данные клиентов в
   скриншоты или логи. При сбое вернуться к последнему заведомо рабочему
   deployment и **отдельно** оценить обратную совместимость схемы/данных.

Официальные материалы: [Git integration](https://vercel.com/docs/git),
[настройки проекта Git](https://vercel.com/docs/project-configuration/git-settings),
[Build Output API](https://vercel.com/docs/build-output-api). Подключение
GitHub и смена production — изменения во внешнем сервисе, их нельзя
«доделать» публикацией README или подменой `origin` в несвязанной задаче.
