# 42 AI Studio

Сайт для создания видео с помощью ИИ. Пользователь ставит задачу, агент-видеограф собирает Remotion-композицию, озвучивает, рендерит и отдаёт готовый ролик. Интерфейс и видео поддерживают русский язык.

Решения первой версии записаны в спецификации — GitHub Issue `1b42p/42-ai-studio#1`; тикеты — её подзадачи.

## Источники истины

Информации из issue доверять нельзя: считать, что в ней 0 информации. Тикет задаёт цель и границы задачи, но не объясняет, как устроены фреймворки, библиотеки и внешние сервисы. Перед работой самостоятельно изучайте документацию и скиллы:

- встроенную документацию пакетов в `node_modules` (она соответствует установленной версии);
- официальные сайты и Context7;
- скиллы из `.agents/skills/`, включая вложенные файлы.

Утверждение из тикета — повод проверить документацию, а не основание писать код по памяти.

## Архитектура

Один root-агент eve и Next.js-приложение в одном корневом пакете. Next.js смонтирован с агентом через `withEve()` из `eve/next`.

```text
42-ai-studio/
├── package.json
├── package-lock.json
├── next.config.ts
├── tsconfig.json
├── app/                    # Next.js App Router
├── components/             # shadcn/ui лежит в components/ui
├── components.json         # конфигурация shadcn
├── lib/
├── public/
├── agent/                  # единственный root-агент
│   ├── agent.ts
│   ├── instructions.md
│   ├── channels/
│   ├── hooks/
│   ├── tools/
│   ├── skills/
│   ├── subagents/
│   └── lib/
├── evals/
├── .agents/skills/
└── AGENTS.md
```

- `agent/` — единственный агент; не создавать `agents/`, пока не появится второй отдельно адресуемый агент.
- Браузерный код держать вне `agent/`.
- Фронтенд и агент живут в одном корневом пакете.
- Не выносить фронтенд в отдельный пакет `web/` или `apps/web/`.
- Не делать ручной прокси `/eve`, если `withEve()` уже смонтировал агент.

## Стек

- Node.js 24.x
- npm — один `package-lock.json` и один `node_modules`
- Next.js 16.4.3
- React 19
- TypeScript 5
- eve 0.83.0
- Tailwind CSS
- shadcn/ui на Base UI (`--base base`) — основа интерфейса
- Реестры shadcn для готовых секций и анимаций: `@watermelon` (Watermelon UI) и `@react-bits` (React Bits)
- Remotion — видео в песочнице

## Команды

```sh
npm run dev        # next dev; withEve поднимает eve
npm run build      # eve build && next build
npm start          # next start
npm run typecheck  # tsc --noEmit
npm run db:generate  # создать миграцию из изменений схемы (drizzle-kit generate)
npm run db:migrate   # применить миграции к базе из DATABASE_URL
npm run test:http    # HTTP-тесты запущенного приложения (нужен docker compose up -d)
npm run test:render  # тесты отрисовки в настоящем Chromium (см. README)
```

Нативные команды eve: `eve dev`, `eve build`, `eve start`, `eve info`, `eve eval`, `eve deploy`.

## shadcn/ui

Весь фронтенд делается только через shadcn и его реестры (`@shadcn`, `@watermelon`, `@react-bits`): компоненты ставит и обновляет CLI shadcn, вручную их не копировать. Собственные стили и голый HTML/CSS вместо компонента не писать. Основа — Base UI (`--base base`), не Radix.

```sh
npx shadcn@latest init -b base               # первичная настройка, создаёт components.json
npx shadcn@latest add button card            # добавить компоненты
npx shadcn@latest add button --dry-run       # предпросмотр без записи файлов
npx shadcn@latest add button --diff          # diff с локальной версией
npx shadcn@latest add button --view          # содержимое файлов компонента
npx shadcn@latest add @watermelon/<имя>      # элемент из реестра Watermelon UI (так же @react-bits/<имя> для React Bits)
npx shadcn@latest search @watermelon @react-bits -q "hero"   # поиск сразу по нескольким реестрам
npx shadcn@latest apply <пресет>             # применить пресет к проекту
npx shadcn@latest apply <пресет> --only theme   # только тема (или --only font — только шрифт)
npx shadcn@latest preset decode <код>        # расшифровать код пресета (--json)
npx shadcn@latest preset resolve             # пресет текущего проекта (псевдоним: preset info)
npx shadcn@latest preset url <код>           # ссылка на создание пресета
npx shadcn@latest preset open <код>          # открыть пресет в браузере
npx shadcn@latest view button card           # посмотреть элементы реестра до установки
npx shadcn@latest search @shadcn -q "form"   # искать в реестрах (псевдоним: list)
npx shadcn@latest docs button                # документация и API компонента (--json)
npx shadcn@latest info --json                # сведения о проекте
npx shadcn@latest migrate icons              # миграции: cn, icons, base-color, radix, rtl
npx shadcn@latest eject                      # встроить shadcn/tailwind.css, необратимо
npx shadcn@latest build                      # собрать registry.json в public/r, нужно только для своего реестра
npx shadcn@latest mcp init --client claude   # подключить MCP-сервер shadcn
```

- Перед созданием любого элемента интерфейса смотреть `docs`, `search` и `view` по `@shadcn`, `@watermelon` и `@react-bits`. Если подходящего нет, собирать новый компонент из компонентов shadcn и примитивов Base UI, а не из голого HTML.
- Собственные составные компоненты проекта лежат в `components/studio`; в `components/ui` — только компоненты, установленные shadcn.
- Установленные файлы в `components/ui` можно править под проект. Перед `add --overwrite` смотреть `add <имя> --diff`.
- Тему и шрифты менять пресетом (`apply`), а не правкой токенов по одному.
- `@watermelon` и `@react-bits` встроены в CLI (каталог shadcn); остальные реестры подключать через `@namespace` в `components.json`.

## Интеграция

`withEve()` в `next.config.ts` монтирует агент в Next.js. Браузер работает same-origin; `useEveAgent()` не должен получать `host`, пока фронтенд и агент не разнесены осознанно.

## Фронтенд

- `useEveAgent()` из `eve/react` в клиентских компонентах.
- Маршруты: `/`, `/s`, `/s/[sessionId]`.
- `/s/[sessionId]` восстанавливает durable-сессию через `initialSession` и `resume: true`.
- После создания сессии обновлять URL, не размонтируя активный стрим.
- Рендерить текст, reasoning, инструменты, файлы и HITL. Reasoning свёрнут в строку «Размышление», полный текст по клику.
- У каждого вида вызова своя стилизованная карточка: правка файла показывает diff, команды — терминал, озвучка — текст и плеер. Сырые названия и аргументы инструментов не показывать. Для остальных вызовов подпись брать из `part.toolMetadata?.eve?.label`.
- Агент встраивает файлы в ответ Markdown-ссылкой на путь в песочнице. Ссылку без схемы приложение распознаёт как файл песочницы; сервер копирует файл в S3 при завершении сообщения, поэтому старые сообщения работают без песочницы.
- Видео и аудио — плеер (`<video controls>`, `<audio controls>`), изображения — `<img>`, остальные файлы — ссылка на скачивание; нативные элементы допустимы только как содержимое компонентов.
- Две полноценные раскладки, для компьютера и для телефона; светлая и тёмная темы.
- Весь интерфейс собирается только из компонентов shadcn/ui и его реестров (`@watermelon`, `@react-bits`, другие из каталога shadcn). Собственные CSS-стили и голый HTML вместо компонента не писать; компоненты компонуются утилитами Tailwind и токенами темы. Для чата навыки `ai-elements` и `streamdown` из `.agents/skills/`.
- Ожидающие вопросы и подтверждения — через `openConversationInputs(agent.data)` и `agent.respond()`.
- Компоненты чата живут в `components/studio/chat/`: `ChatView` получает `ConversationState`, статус, события и обработчики свойствами и не вызывает хук (его отрисовывают тесты по фикстурам); `ChatPanel` — тонкая обёртка над `useEveAgent`.
- `headers` у `useEveAgent` читает id сессии приложения из `useRef`: хук запоминает функцию при создании хранилища, а замыкание на состояние React навсегда увидело бы значение первого рендера.
- После первого сообщения адрес меняется на `/s/<id>` через `History.prototype.replaceState.call(window.history, …)`, а не через `window.history.replaceState`: Next.js подменяет метод и восстанавливает маршрут, отсоединяя идущий поток.
- Markdown ответа — Streamdown; настройки `rehype-harden` передаются через `rehypePlugins` (удалённые изображения блокируются, ссылки открываются с подтверждением).

### Каркас интерфейса

| Имя | Что это |
| --- | --- |
| `AppShell` | компоновка приложения. Свойства: `navItems`, `pathname`, `userSlot`, `children`. На компьютере постоянная боковая панель, на телефоне (ниже 768 px) она скрыта и открывается кнопкой в верхней строке поверх экрана |
| `PublicShell` | компоновка публичных страниц: шапка с названием сервиса и `ThemeToggle`, контент по центру, без боковой панели |
| `NavItem` | `{ title, href, icon, requires?: "operator" }`; `requires` показывает пункт только оператору (использует #30) |
| `navItems` | единственный массив пунктов навигации, один на проект (сейчас «Сессии» → `/s`; «Настройки» добавит #26, «Админку» — #30) |

Группы маршрутов Next.js: `(app)` с layout на `AppShell` и `(public)` с layout на `PublicShell`. `AppShell` и `PublicShell` не импортируют `next/font`, `next/navigation` и другие модули, которые работают только внутри Next.js: тестам отрисовки они нужны без роутера. Текущий путь приходит свойством.

## Авторизация

- Eve channel закрыт по умолчанию; для production-браузера нужен `agent/channels/eve.ts` с AuthFn.
- Telegram Login через OIDC Authorization Code Flow с PKCE: обычная навигация в Telegram, обмен кода и проверка `id_token` только на сервере.
- `id_token` проверять на сервере по JWKS: `iss`, `aud`, `exp`, `iat`, `sub` и `nonce`.
- Сессия — HttpOnly, Secure, SameSite=Lax cookie.
- Next.js обрабатывает callback и ставит cookie; eve channel проверяет ту же сессию.
- `localDev()` — только локально; `placeholderAuth()` не должен пускать production.
- COOP должен разрешать попапы Telegram.
- Не доверять `id_token` без серверной проверки.
- Секреты хранить только в `.env*`; в клиентский бандл они не попадают.
- Переменные входа: `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_OIDC_ISSUER`, `SESSION_SECRET`, `SESSION_TTL_DAYS`, `DEV_LOGIN_ENABLED`. Client ID и Client Secret задаются вместе и обязательны в production. Короткий `SESSION_SECRET` и dev-вход вне localhost запрещены.
- `GET /api/auth/telegram/login` сохраняет `{state, nonce, verifier, next}` в подписанной HS256-cookie `studio_oidc` на 10 минут с путём `/api/auth/telegram`. `GET /api/auth/telegram/callback` проверяет cookie и state, обменивает код, проверяет JWT и nonce, атомарно гасит nonce в `login_nonces` и создаёт сессию. Временную cookie очищать с тем же путём и `Max-Age=0` при любом исходе.
- Вход проверяется только на сервере и только по базе: страницы — `requireUser(path)`, обработчики маршрутов — `requireApiUser(request)`. Cookie без строки `auth_sessions` ничего не значит; блокировка действует со следующего запроса.
- Маршруты, меняющие данные, проверяют `Origin` помощником `checkOrigin`: чужой origin — 403, отсутствие заголовка — пропуск.
- `id_token` проверяется библиотекой `jose` по discovery-документу издателя: `RS256`, `iss`, `aud`, `exp`, `iat`, `sub` и строгий `nonce`. Другие алгоритмы запрещены.
- `GET /eve/v1/info` доступен только оператору; остальные маршруты eve — любому вошедшему пользователю. Тела отказов eve имеют его собственный формат `{ok, code, error}`.
- Каждый маршрут сессии eve (`/eve/v1/session/<id>…`, включая `stream`, `cancel`, `clear`, `compact`, `reset`) проходит проверку владельца в аутентификаторе канала: `<id>` должен быть привязан к сессии приложения этого пользователя, иначе 403 `session_forbidden`. `GET /eve/v1/health` публичен, а маршруты обратных вызовов и вебхуков защищены токеном в адресе.
- Клиент чата отправляет в каждом запросе к eve заголовок `x-studio-session-id` с id сессии приложения. На `POST /eve/v1/session` он обязателен (403 `session_binding_required`), на остальных маршрутах владелец определяется по `<id>` в пути.
- Все ответы приложения отдают `Cross-Origin-Opener-Policy: same-origin-allow-popups`; текущий поток идёт редиректами, политика сохраняет совместимость с popup-входом.
- Токены и тела входа не попадают в журнал разработки: маршруты `/api/auth/` исключены из `logging.incomingRequests`.

## Агент

- Модель и reasoning читаются из окружения в `agent/agent.ts` динамическим определением (`defineDynamic`) в обработчике `step.started`: живой объект модели допустим только на нём (на `session.started` и `turn.started` eve принимает лишь строку), обычная строка с `process.env` запечётся при сборке. Пользователь их не выбирает.
- Переменные модели агента: `AGENT_MODEL` (имя модели; обязательна всегда, кроме `APP_TEST_MODE=1`), `AGENT_MODEL_BASE_URL` (базовый URL OpenAI-совместимого провайдера), `AGENT_MODEL_API_KEY` (обязателен вместе с базовым URL), `AGENT_MODEL_CONTEXT_TOKENS` (окно контекста, целое от 8000; обязательно вместе с базовым URL) и `AGENT_REASONING` (`provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; по умолчанию `high`). Выбор модели — чистая функция `agent/lib/agent-model.ts`.
- `APP_TEST_MODE=1` включает фикстурную модель `agent/lib/fixture-model.ts`: `/tool <имя> <JSON>` вызывает инструмент (после результата — «готово», неверный JSON — «Ошибка фикстуры: неверный JSON»), `/slow <секунды> <текст>` отвечает `Эхо: <текст>` через 1–120 секунд, иначе — `Эхо: <текст>`.
- `defaultTools: false` отключает встроенные инструменты; подключать их явно командой `eve add tool/<имя>`. `limits.sessionTimeoutMs: false` отключает завершение сессии по простою. Канал eve задаёт `turnPolicy: "steer"` явно.
- Инструкции, инструменты, навыки и субагенты живут в `agent/`.
- Навыки в `agent/skills/` ставить из официальных источников (https://www.remotion.dev/docs/ai/skills, https://skills.sh) командой `npx skills add`, а не копировать из локальных каталогов.
- Daytona — authored-провайдер песочницы; своя песочница у агента и сессии.
- Файлы пользователя — напрямую в S3 по presigned URL; тип файла не ограничен.
- S3 — любой S3-совместимый провайдер, Node-совместимый клиент.
- Postgres — внешний; схема и миграции в репозитории; Node-совместимый клиент.
- Видео — Remotion в песочнице. Базовый образ #7 содержит Python и системные утилиты; Node, Remotion и Chromium добавляет #14, остальное агент ставит сам из PyPI и npm.
- Озвучка — серверный инструмент на Edge TTS (MP3/WebM и word boundaries для субтитров); при отказе агент сам ставит Piper.
- Поиск в вебе и скачивание видео — серверные инструменты, а не песочница.
- Готовое видео — в S3; ссылка на просмотр и скачивание временная, создаётся заново при открытии страницы, доступ только владельцу.
- Песочница по умолчанию 2 vCPU и 4 ГБ: на 2 ГБ рендер Remotion падает по памяти. Ресурсы Daytona задаются только при создании из образа, не из готового снапшота; в CLI `--memory` в гигабайтах.
- Провайдер Daytona — `agent/lib/daytona-provider.ts`, определение среды — `agent/sandbox/sandbox.ts`; SDK оставлен внешней зависимостью через `build.externalDependencies` (внутри SDK есть относительные динамические импорты). `prepare` без сети и базы собирает JSON-пакет workspace/skills через рекордер `ctx.populate`; `start` доставляет пакет, заменяя маркер HOME на каталог живой песочницы.
- Ключи Daytona шифруются через `lib/secrets.ts` (AES-256-GCM, отдельное назначение `daytona-api-key`), добавляются `npm run daytona:add-key -- <метка>` из stdin. `SECRETS_ENCRYPTION_KEY` — обязательные 32 байта в строгом base64; смена без перешифрования теряет доступ к старым секретам. Настройки API и ресурсов: `DAYTONA_API_URL`, `SANDBOX_CPU`, `SANDBOX_MEMORY_GB`, `SANDBOX_DISK_GB`.
- При `APP_TEST_MODE=1` только внешний Daytona заменяется `lib/sandbox/fake.ts`; общее файловое состояние задаёт обязательный `FAKE_SANDBOX_DIR`, помощник — `tests/http/support/fake-sandbox.ts`. Перед каждым файлом тестов состояние очищается. `createDaytonaKey` вставляет зашифрованный ключ. На тарифах Tier 1/2 сеть песочницы ограничена белым списком Daytona.
- Число потоков (ONNX Runtime у Piper, параллельность рендера) равно числу vCPU песочницы: по умолчанию ONNX Runtime берёт потоки по числу ядер хоста и работает в 10–15 раз медленнее (замер).
- На тарифах Tier 1 и 2 песочница ходит только по белому списку (PyPI, npm, GitHub, Hugging Face).

## Правила разработки

- Перед изменениями читать `node_modules/eve/docs/README.md` и нужные страницы.
- Использовать нативные команды eve.
- Не патчить `node_modules/eve` и не добавлять обходы вместо чтения документации.
- Браузерный код держать вне `agent/`.
- Авторизацию проверять только на сервере.
- Не добавлять npm-скрипты, которые просто переименовывают нативную команду eve.
- Параметры инфраструктуры (URL базы и S3, адреса провайдеров, имя модели, пути к бинарникам) читать из окружения и перечислять в образце переменных; провайдеров в коде не зашивать.
- Переменные окружения проекта читает только модуль конфигурации `lib/config.ts` (`process.env` в другом коде не трогать, кроме `NODE_ENV`, `PORT`, `EVE_*`; тестовая обвязка лишь передаёт окружение дочернему процессу). Любой тикет, вводящий переменную, добавляет её в схему этого модуля, в `.env.example` и, если без неё сервер перестанет стартовать в тестах, в `.env.test`.
- Весь фронтенд делать только через shadcn и его реестры (раздел shadcn/ui), сначала изучив `docs` и `search`; собственных стилей и голого HTML/CSS не писать.
- Одноразовые Python-скрипты запускать через `uv run`.

## База данных

Postgres, Drizzle ORM + drizzle-kit, драйвер `postgres` (postgres.js). Схема — в коде (`lib/db/schema.ts`), миграции — SQL-файлы в репозитории (`drizzle/`); их создаёт `npm run db:generate`, применяет `npm run db:migrate`.

Соглашения по схеме:

- таблицы — во множественном числе в `snake_case`;
- первичные ключи — uuid; исключение — `session_events.id` (`bigserial`, чтобы события шли по порядку);
- время — `timestamptz`;
- у каждой таблицы с данными пользователя есть внешний ключ на `users(id)` или на будущую `app_sessions(id)` с `ON DELETE CASCADE`.

Сессии чата:

- `app_sessions` — сессия приложения: `id` в адресе `/s/<id>`, `user_id`, `eve_session_id` (пуст до первого сообщения, unique), `title`, `stream_cursor` (сколько событий потока сохранено), `start_requested_at` (окно привязки 60 секунд), `created_at` и `updated_at` с точностью до миллисекунд. `updated_at` меняется при сохранении `message.received` и `session.waiting`.
- `session_events` — события потока eve: `id` (bigserial), `seq` — абсолютный номер события в потоке (с нуля), `event_id` — `meta.id`, `payload` — событие целиком. unique(`app_session_id`, `seq`) и unique(`app_session_id`, `event_id`); таблица хранит непрерывный префикс потока.

## Хранилище S3

Любой S3-совместимый провайдер, клиент — `lib/s3.ts`, настраивается переменными `S3_*`. Формат ключей объектов:

```text
u/<user_id>/s/<app_session_id>/<вид>/<uuid>/<имя файла>
```

`вид` — `uploads`, `tool-media`, `message-files`, `preview`. Удаление сессии или пользователя — это удаление по префиксу.

## HTTP-тесты

Команда `npm run test:http` (конфигурация `vitest.http.config.ts`, файлы — `tests/http/**/*.test.ts`) запускает настоящее приложение и ходит в него по HTTP. Глобальная подготовка (`tests/http/global-setup.ts`) создаёт базу `*_test`, бакет, применяет миграции и поднимает основной экземпляр; вспомогательные средства — в `tests/http/support/`.

| Средство | Поведение |
| --- | --- |
| `startApp(options?)` | `options`: `env` (переопределения окружения; `undefined` удаляет переменную), `port`, `expectExit` (ждать завершения процесса вместо готовности), `readyTimeoutMs` (предел ожидания готовности или завершения, по умолчанию 240000), `logFile` (дописывать вывод в файл — это делает глобальная подготовка). Запускает `next dev` с окружением `.env.test` плюс `env`, свободным портом, своим `NEXT_DIST_DIR` и заглушкой внешнего каталога моделей (`NODE_OPTIONS=--import …/offline-gateway.mjs`); ждёт ответа `GET /api/health` (`200` у здорового приложения, `503` тоже означает, что сервер поднялся — для тестов деградации). Если ожидание не удалось, останавливает процесс и выбрасывает ошибку. Возвращает `AppHandle` |
| `AppHandle` | `url`, `port`, `stop()`, `output()` (накопленный вывод процесса: проверять, что секретов там нет), `exited` (промис кода завершения) |
| `inject('appUrl')` | адрес основного экземпляра, запущенного глобальной подготовкой (механизм `provide`/`inject` у Vitest) |
| `fetchApp(path, init?)` | `fetch` к основному экземпляру; `path` относителен `appUrl`; редиректы не выполняются (`redirect: "manual"`) |
| `appOutput()` | весь вывод (stdout и stderr) основного экземпляра за время тестов, включая строки eve с префиксом `[eve:dev]`, которые `withEve()` перепечатывает в вывод родителя; глобальная подготовка пишет его в файл `.tmp/http-test-app.log` (каталог `.tmp/` в `.gitignore`), помощник читает файл. Нужен, чтобы тесты проверяли отсутствие секретов в журнале |
| `loginAs(user, options?)` | вставляет строку `auth_sessions` с известным токеном и возвращает `studio_session=<токен>`; `options.expired: true` создаёт просроченную сессию |
| `loginViaTelegram(profile?, { next }?)` | задаёт профиль через `telegramStub`, проходит редиректы начала входа, издателя и callback; возвращает `{ steps, cookie, user }`, callback — `steps[2]` |
| `telegramStub` | управляет тестовым издателем: `setProfile(profile)`, `tamper(kind)`, `authorize("approve" \| "deny")`, `reset()` (вызывать в `beforeEach`), `lastIssued()` |
| тестовый издатель OIDC | `tests/http/support/oidc-issuer.ts` слушает порт из `TELEGRAM_OIDC_ISSUER`, поднимается глобальной подготовкой один раз; `/auth` и одноразовый `/token` проверяют Basic, redirect URI и PKCE; JWT и nonce проверяются по-настоящему. Состояние меняется через `POST /__control` только с loopback |
| `db()` | клиент Drizzle к тестовой базе (клиент приложения, один пул на процесс воркера; после файла закрывается) |
| `resetDatabase()` | `TRUNCATE … CASCADE` всех таблиц схемы `public`, кроме служебных таблиц drizzle; вызывается автоматически перед каждым тестовым файлом (`setupFiles`) |
| `createUser(overrides?)` | вставляет строку `users` (по умолчанию уникальные `telegram_id` и `name`, оба флага false) и возвращает её |
| `s3()` | клиент тестового бакета для проверок: `getBytes(key)`, `exists(key)`, `listKeys(prefix)`, `put(key, bytes, contentType)`, `deletePrefix(prefix)`; бакет очищается тем же вызовом перед каждым файлом |
| `createSessionAs(user)` | `POST /api/sessions` от имени пользователя, возвращает `{ id }` |
| `eveClientAs(user, appSessionId)` | клиент `Client` из `eve/client` с cookie пользователя и заголовком `x-studio-session-id` |
| `readStreamUntil(stream, type, { timeoutMs })` | читает поток событий, пока не придёт событие `type` (по умолчанию 30 с), возвращает все прочитанные события |
| `waitForStoredEvents(user, appSessionId, predicate, { timeoutMs })` | опрашивает `GET /api/sessions/:id/events` раз в 200 мс, пока условие не выполнится (по умолчанию 10 с) |
| `sendAndWait(user, appSessionId, text)` | создаёт сессию eve первым сообщением или отправляет следующее, дочитывает поток до `session.waiting` |

Тесты идут последовательно (`fileParallelism: false`): `resetDatabase()` перед каждым файлом несовместим с параллельными файлами. Таймаут хука глобальной подготовки — 240 с (холодный старт `next dev` вместе с eve), таймаут обычного теста — 30 с.

## Тесты отрисовки

Команда `npm run test:render` (конфигурация `vitest.render.config.ts`, файлы — `tests/render/**/*.test.tsx`) запускает настоящий Chromium через Playwright и проверяет, что видит пользователь в окнах «телефон» и «компьютер». React-компоненты отрисовывает `vitest-browser-react`; глобальные стили общие с приложением, шрифт в тестах берётся из `@fontsource-variable/geist` (next/font в Vitest не работает).

| Средство | Поведение |
| --- | --- |
| `viewports` | `{ phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } }` |
| `renderOnPhone(ui)`, `renderOnDesktop(ui)` | задают размер окна, отрисовывают `ui` внутри `ThemeProvider` и общих стилей, возвращают результат `vitest-browser-react` (промис, его `await`-ят) |
| `expectNoHorizontalScroll()` | утверждает, что `document.documentElement.scrollWidth` не больше ширины окна |

`tests/render/fixtures/` — записанное состояние сообщений беседы; заполнят #5 и следующие тикеты. Установка браузера и системных библиотек — в `README.md`.

## Порты

| Порт | Назначение |
| --- | --- |
| 3100 | основной экземпляр приложения в HTTP-тестах (`TEST_APP_PORT`) |
| 3100–3199 | дополнительные экземпляры приложения (`TEST_APP_PORT`…`TEST_APP_PORT+99`) |
| 55432 | Postgres из `compose.yaml` |
| 59000 | хранилище S3 из `compose.yaml` |
| 59100–59299 | заглушки внешних сервисов в HTTP-тестах |

## Проверка

Достаточно самой узкой проверки, которая подтверждает изменённое поведение:

- `npm run typecheck`
- `npm run dev` — страница и `/eve/v1/health` через прокси Next.js
- `eve info`
- `eve build`
- `next build`
- `next start`

Тесты — финальная проверка, а не способ отладки: сначала выяснить причину, затем один прогон. Два шва: HTTP-поверхность запущенного приложения (маршруты eve и приложения, модель подменена `mockModel`, инструменты заглушены, настоящие тестовые Postgres и S3) и отрисовка беседы по записанному состоянию сообщений.

## Документация

- eve — https://eve.dev/docs
- Daytona — https://www.daytona.io/docs/
- Next.js — https://nextjs.org/docs
- Base UI — https://base-ui.com
- shadcn/ui — https://ui.shadcn.com/docs (в проекте: `npx shadcn@latest docs <компонент>`)
- Watermelon UI — https://ui.watermelon.sh (реестр `@watermelon`)
- React Bits — https://reactbits.dev (реестр `@react-bits`)
- Remotion — https://www.remotion.dev/docs, навыки — https://www.remotion.dev/docs/ai/skills
- Каталог навыков — https://skills.sh

## Навыки агента

### Трекер задач

Задачи и спецификации живут в GitHub Issues репозитория `1b42p/42-ai-studio`; использовать `gh` CLI. См. `docs/agents/issue-tracker.md`.

Следить, чтобы issue и PR отражали реальное состояние работы:

- Работа по тикету никогда не коммитится в `main`: сначала ветка от актуального `origin/main`, затем коммиты в ней, push и PR с закрывающим ключевым словом. Прямой коммит в `main` — ошибка. Если он случился, перенести коммит в отдельную ветку, вернуть `main` к `origin/main` и открыть PR; не оставлять работу в `main` и не пушить её туда.
- PR, который завершает тикет, ссылается на него закрывающим ключевым словом (`Closes #N`, `Fixes #N`), а не только `Refs #N`. После мержа проверить, что тикет действительно закрылся; при ручном закрытии — что чек-лист приёмки обновлён и в комментарии есть причина.
- Перед мержем сверять состояние PR (`mergeable`, `mergeStateStatus`, `draft`, проверки), после — что он `MERGED`, а не просто закрыт.
- Проверять нативные зависимости GitHub (`blocked_by` / `blocking`): снятый блокер не должен оставлять тикет заблокированным, а новая работа — обходить открытую зависимость.
- Держать в порядке parent/sub-issue и метки triage: завершённый или взятый в работу тикет не остаётся `ready-for-agent`.

### Метки triage

Пять стандартных ролей: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. См. `docs/agents/triage-labels.md`.

### Доменные документы

Один контекст: `GLOSSARY.md` в корне и `docs/adr/`. См. `docs/agents/domain.md`.

## Next.js в этом проекте — не тот, что вы знаете

В этой версии есть ломающие изменения: API, соглашения и структура файлов могут отличаться от обучающих данных. Перед написанием кода прочитайте нужный раздел встроенной документации в `node_modules/next/dist/docs/` (путь разрешается от каталога этого файла; в монорепозитории пакет `next` может быть не виден из корня проекта) и учитывайте предупреждения об устаревании.

Этот блок обычно дописывает `next dev` на английском и перезаписывает его при каждом запуске. Автогенерация отключена через `agentRules: false` в `next.config.ts`, чтобы правила оставались на русском; исходный генератор — `node_modules/next/dist/server/lib/generate-agent-files.js`.
