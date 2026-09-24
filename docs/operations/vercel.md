# Vercel: состояние, безопасная проверка и переход на Git-деплой

Срез **23.09.2026 UTC**; это инструкция для будущей авторизованной работы, **не**
запрос на изменение production. Источник текущего состояния — read-only MCP
Vercel (`list_projects`, `get_project`, `list_deployments`, `get_deployment`,
`list_project_domains`, `filter_project_envs` с `decrypt:false`) и публичные GET
`https://itles.vercel.app/`, `/api/health`, `/api/setup/status`. Значения переменных
не сохранялись. Номера MCP-серверов пересматривать по [skill](../../.agents/skills/mcp-servers/SKILL.md).

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

Выполнено с явного согласия владельца; значения секретов не выводились.

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

1. **Перед изменением.** Сверить выбранный владельцем GitHub
   `somemateria/biildfe4`, назначенную ветку по умолчанию, целевой PR/коммит
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
   связать GitHub с `somemateria/biildfe4`; указать согласованную production
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
   отправлять модельные данные в production. Проверить ссылку на файлы релиза
   нового GitHub и адаптивный интерфейс в браузере.
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
