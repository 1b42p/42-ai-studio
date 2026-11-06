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
- Карточка `bash` с результатом `running` опрашивает `GET /api/sessions/<id>/jobs/<jobId>` через `useBashJob` (`components/studio/chat/use-bash-job.ts`): сразу, затем 2, 5 и 10 секунд по времени показа; скрытая вкладка приостанавливает опрос, ошибки повторяются с удвоением до 30 секунд. Один опрос на пару «сессия, задание» общий для всех карточек страницы. `appSessionId` проходит `ChatPanel → ChatView → ToolCard`; карточки копий агента (#12) используют корневую сессию.
- Карточка копии агента (`components/studio/chat/agent-copy-card.tsx`) выбирается по `part.toolMetadata?.eve?.name === "agent"`: у встроенной копии `toolName` — `eve:subagent:agent`, поэтому по нему карточку не выбрать. Вся строка — `SheetTrigger` > `TraceLine`; панель показывает ход копии из `data.agents[sessionId].observation.conversation` теми же компонентами (`MessageRow`), файлы — текстом пути. Чат вызывает `useEveAgent({ followSubagents: true })`; выбранная копия — состояние компонента, идентификатор в адрес не попадает.
- На компьютере панель копии не модальная и без затемнения (`Sheet` с `modal={false}` и `disablePointerDismissal`, `SheetContent` с `overlay={false}` и `size="panel"`); об открытии она сообщает `ChatView` через `onCopyPanelChange`, и лента освобождает 480 пикселей (`md:pr-[480px]`). На телефоне панель модальная и во весь экран.
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
- Поток копии агента — отдельное правило: корневая сессия пользователя — обычные правила #5; копия из `agent_sessions` — только `GET …/stream` (сообщения, `cancel`, `clear`, `compact`, `reset` отвечают 403 `session_forbidden`: они ломают задачу корня); известная чужая сессия — 403 сразу; неизвестный идентификатор потока ждёт строку копии до 3 секунд (опрос 200 мс), только если у пользователя есть сохранённые события за последние 5 минут; `POST` с неизвестным идентификатором отказывает сразу. Ожидание привязки корня в 10 секунд включается только пока `eve_session_id` сессии приложения пуст.
- Клиент чата отправляет в каждом запросе к eve заголовок `x-studio-session-id` с id сессии приложения. На `POST /eve/v1/session` он обязателен (403 `session_binding_required`), на остальных маршрутах владелец определяется по `<id>` в пути.
- Все ответы приложения отдают `Cross-Origin-Opener-Policy: same-origin-allow-popups`; текущий поток идёт редиректами, политика сохраняет совместимость с popup-входом.
- Токены и тела входа не попадают в журнал разработки: маршруты `/api/auth/` исключены из `logging.incomingRequests`.

## Агент

- Модель и reasoning читаются из окружения в `agent/agent.ts` динамическим определением (`defineDynamic`) в обработчике `step.started`: живой объект модели допустим только на нём (на `session.started` и `turn.started` eve принимает лишь строку), обычная строка с `process.env` запечётся при сборке. Пользователь их не выбирает.
- Переменные модели агента: `AGENT_MODEL` (имя модели; обязательна всегда, кроме `APP_TEST_MODE=1`), `AGENT_MODEL_BASE_URL` (базовый URL OpenAI-совместимого провайдера), `AGENT_MODEL_API_KEY` (обязателен вместе с базовым URL), `AGENT_MODEL_CONTEXT_TOKENS` (окно контекста, целое от 8000; обязательно вместе с базовым URL) и `AGENT_REASONING` (`provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; по умолчанию `high`). Выбор модели — чистая функция `agent/lib/agent-model.ts`.
- `APP_TEST_MODE=1` включает фикстурную модель `agent/lib/fixture-model.ts`: `/tool <имя> <JSON>` вызывает инструмент (после результата — «готово», неверный JSON — «Ошибка фикстуры: неверный JSON»), `/slow <секунды> <текст>` отвечает `Эхо: <текст>` через 1–120 секунд, иначе — `Эхо: <текст>`. Результат задачи (`<task_result>`) и заметку `[Tasks]` eve дописывает от имени пользователя, поэтому последнее сообщение ищется по `userMessages`, а не по роли; обёртку копии (`Caller message:`) модель снимает, чтобы копия отвечала на саму задачу.
- `defaultTools: false` отключает встроенные инструменты; подключать их явно командой `eve add tool/<имя>`. `limits.sessionTimeoutMs: false` отключает завершение сессии по простою. Канал eve задаёт `turnPolicy: "steer"` явно.
- `agent/tools/agent.ts` подключает встроенный инструмент `agent` — копию корневого агента: та же модель, инструкции, инструменты и песочница (ключ песочницы — идентификатор корня), но своя история. Копия не может вызывать `agent`; одновременно работает не больше 32 задач. В `agent/instructions.md` записано правило: копии — только для независимой работы с непересекающимися файлами, и в `message` кладётся всё, что копии нужно.
- Инструкции, инструменты, навыки и субагенты живут в `agent/`.
- `agent/instructions.md` — не больше 200 строк для всех тикетов вместе: здесь стабильные правила, процедуры — в навыках. Перед изменением инструкций, навыков и этого файла читать `.agents/skills/writing-for-agents/SKILL.md`, для навыков также `SKILL-MECHANICS.md`. Каждый тикет, вводящий инструмент, добавляет ему отдельную строку назначения в раздел «Инструменты» инструкций; сохранять рабочие правила уже подключённых инструментов.
- Видеограф ведёт проект `/workspace/<имя>/` и `NOTES.md` по `agent/skills/frame-review/references/notes-template.md`. Перед полным рендером и после правки композиции обязателен навык `frame-review`: 4–8 кадров за проход, единый предел трёх проходов исправлений, успешная повторная проверка после упрощения. Рендер выполняет только корневой агент, один за раз; правки остаются в том же проекте, видео получают суффиксы версий.
- `read_page` (`agent/tools/read_page.ts`) читает страницу на сервере приложения: документация Remotion и обычные сайты из песочницы недоступны. HTML выделяется Readability и переводится в Markdown в `worker_threads` (`lib/web/page-extraction.ts`); воркер — eval-строка, зависимости разрешаются от пакета приложения и перечислены в `build.externalDependencies`. Разобранные страницы кэшируются на 10 минут (20 записей), продолжение — `offset` из `nextOffset`, единицы UTF-16. Режим `page` сохраняет меню; при >20 000 DOM-элементов Readability пропускается. `web_search` (`agent/tools/web_search.ts`) ходит в Tavily (`TAVILY_API_KEY`, `TAVILY_API_URL`); без ключа сервер стартует, а инструмент отвечает, что поиск не настроен. Ключ в ответы и журнал не пишется.
- Запросы к адресам от пользователя и из поисковой выдачи — только через общий `lib/web/safe-fetch.ts`: `parseOutboundUrl`, `isBlockedIp`, `createSafeAgent`, `safeFetch`, нейтральный `SafeFetchError.reason`. Таблицы адресов — в `lib/web/public-url.ts`, собственных проверок в потребителях не создавать. Политика передаётся параметром; `read_page` разрешает http/https, стандартные порты, 5 перенаправлений, 30 с и 5 МиБ после распаковки. DNS проверяется до запроса и внутри `connect.lookup`, всегда `fetch` и `Agent` из одной версии `undici`, явный dispatcher без прокси окружения. `allowHosts` и `resolveDns` — только параметры тестов, не переменные окружения.
- Карточки `web_search` и `read_page` — строки `Trace` в `components/studio/chat/web-search-card.tsx` и `read-page-card.tsx`, выбираются в `ToolCard`; ссылки только http/https, открываются в новой вкладке с `noopener noreferrer`. Сырые аргументы и фрагменты поиска карточки не показывают.
- Новую карточку инструмента добавлять в сопоставление `ToolCard` и проверять по записанным состояниям на телефоне и компьютере: выполнение, результат, недоступность медиа и обычный немедийный вызов. Активность оформлять через `Trace`, файлы — через `Attachment`, увеличенное изображение — через `Dialog`; исходный JSON не показывать. Медиа публиковать через `publishToolMedia`, читать через `/api/media/:id` и `useMediaRetry`, чтобы история работала без песочницы; ошибка публикации не должна лишать модель исходного результата инструмента.
- Правки файлов — серверный инструмент `agent/tools/edit_file.ts` (`edit_file`): точная замена UTF-8 или создание без `oldString`, предел 256 КиБ, выход `{ path, created, replacements, oldContent, newContent, linesAdded, linesRemoved }` в поток; модели — `toModelOutput` без содержимого. `write_file` не подключается. Карточка — `components/studio/chat/edit-file-card.tsx`; подсчёт строк и diff — `lib/edit-file/` (`diff` 9.x). Фиктивный `readFile` на каталоге бросает `EISDIR`.
- Навыки в `agent/skills/` ставить из официальных источников (https://www.remotion.dev/docs/ai/skills, https://skills.sh) командой `npx skills add`, а не копировать из локальных каталогов. Навыки Remotion — из тега, совпадающего с `ARG REMOTION_VERSION` в Dockerfile: `npx skills add https://github.com/remotion-dev/remotion/tree/v4.0.538/packages/skills --skill remotion-create remotion-docs remotion-markup remotion-multimedia remotion-render remotion-captions remotion-interactivity --subagent root -y`. Копии в `.agents/skills/remotion-*` и ссылки в `.claude/skills/remotion-*` не оставлять.
- Daytona — authored-провайдер песочницы; своя песочница у агента и сессии.
- Файлы пользователя — напрямую в S3 по presigned URL; тип файла не ограничен.
- S3 — любой S3-совместимый провайдер, Node-совместимый клиент.
- Postgres — внешний; схема и миграции в репозитории; Node-совместимый клиент.
- Видео — Remotion в песочнице. Образ описывает `agent/sandbox/Dockerfile`: Python 3.12, Node 24 (NodeSource `setup_24.x`), библиотеки Chrome, шрифты кириллицы и эмодзи, шаблон Remotion 4.0.538 в `/opt/remotion` с Chrome Headless Shell (`npx remotion browser ensure` при сборке). Команды образа — `sandbox-vcpu` (квота vCPU) и `sandbox-selfcheck` (версии, браузер, русский шрифт, кадр `Main`, не дольше 60 с). Новый проект — копия шаблона и ссылка `node_modules` на `/opt/remotion/node_modules`. Проверка: собрать песочницу из этого Dockerfile (`daytona create --dockerfile agent/sandbox/Dockerfile --cpu 2 --memory 4`) и выполнить `sandbox-selfcheck`. Остальное агент ставит сам из PyPI и npm.
- Озвучка — серверные инструменты `speak` и `list_voices` (`agent/tools/`, `@andresaya/edge-tts` 1.9.1). Формат только `audio-24khz-96kbitrate-mono-mp3`: длительность считается по размеру файла и 96 кбит/с. `speak` пишет в песочницу `<путь>.mp3` и `<путь>.words.json` (версия 1: слова и предложения в миллисекундах от начала файла, знаки препинания возвращены к единицам речи сервиса, `sentences[].endMs` включает паузу до следующего предложения) и публикует только аудио через `publishToolMedia` (строка `tool_call_media`, объект S3 вида `tool-media`). Между вызовами `speak` одной сессии — пауза 6 с, иначе сервис часто отвечает 429; внутри вызова до трёх попыток с паузами 1 с и 4 с. Адреса сервиса — необязательные `EDGE_TTS_WSS_URL` и `EDGE_TTS_VOICES_URL` (пусто — адреса библиотеки). При окончательном `speak_unavailable` и повторном `speak_rate_limited` агент сам ставит Piper в песочнице (`piper-tts` 1.8.0, русский голос medium) и озвучивает им; потоки ONNX равны квоте vCPU песочницы, а не `nproc`. Остальные ошибки `speak` так не заменяются.
- Поиск в вебе и скачивание видео — серверные инструменты, а не песочница.
- Готовое видео — в S3; ссылка на просмотр и скачивание временная, создаётся заново при открытии страницы, доступ только владельцу.
- Песочница по умолчанию 2 vCPU и 4 ГБ: на 2 ГБ рендер Remotion падает по памяти. Ресурсы Daytona задаются только при создании из образа, не из готового снапшота; в CLI `--memory` в гигабайтах.
- Провайдер Daytona — `agent/lib/daytona-provider.ts`, определение среды — `agent/sandbox/sandbox.ts`; SDK оставлен внешней зависимостью через `build.externalDependencies` (внутри SDK есть относительные динамические импорты). `prepare` без сети и базы собирает JSON-пакет workspace/skills через рекордер `ctx.populate`; `start` доставляет пакет, заменяя маркер HOME на каталог живой песочницы.
- Ключ Daytona **не переменная окружения**: его нет и не может быть в `.env`. Ключи лежат в таблице `daytona_keys` зашифрованными (AES-256-GCM через `lib/secrets.ts`, отдельное назначение `daytona-api-key`) и добавляются командой `npm run daytona:add-key -- <метка>` из stdin. Есть ли рабочий ключ, показывает только база: `select count(*) from daytona_keys where enabled and deleted_at is null` по `DATABASE_URL`; пустой `.env` в этом вопросе ничего не значит. `SECRETS_ENCRYPTION_KEY` — обязательные 32 байта в строгом base64; смена без перешифрования теряет доступ к старым секретам. В окружении живут только адрес API и ресурсы: `DAYTONA_API_URL`, `SANDBOX_CPU`, `SANDBOX_MEMORY_GB`, `SANDBOX_DISK_GB`.
- Пул ключей — `agent/lib/daytona-key-pool.ts`: `refreshUsage` (кэш 30 с, `force`), `pickKey`, `exhaustPool`, `markKeyUnauthorized`, `disableKey`, `enableKey`, `deleteKey`; форма `usage` и правила — в README. Использование читается до рекомендательной блокировки `pg_advisory_xact_lock` на пул, под блокировкой — только решение и резерв строки `sandboxes`; сетевой запрос внутри блокировки сериализовал бы все старты по таймауту Daytona. Блокировка старта держится на отдельном пуле соединений (`getLockSqlClient` в `lib/db/client.ts`): иначе десять одновременных стартов займут весь общий пул и будут ждать собственных запросов. Ключи одной организации (`usage.organizationId`) — один пул, представитель — первый по `created_at`; `unauthorized` исключает ключ, `forbidden`/`unavailable`/`unexpected` без прежних чисел — нет. Отказ Daytona по квоте (`400`, сообщение «Total … limit exceeded») ставит пулу `exhausted_until` на 60 секунд, `401` при создании исключает ключ; нехватка места — `capacity_exhausted`, отсутствие ключей — `no_daytona_key`.
- `sandboxes.starting_since` и `starting_kind` (`create`, `wake`, `restore`) — резерв квоты: строка в `starting` моложе 5 минут занимает место, создание и восстановление — vCPU/память/диск, пробуждение остановленной — только vCPU и память (диск уже занят ею и входит в использование Daytona). `daytona_keys.exhausted_until` хранится отдельным столбцом, чтобы `refreshUsage` не затирал отметку.
- Удаление ключа — `deleted_at` + `enabled = false`, затем удаление его машин; `api_key_encrypted` заменяется маркером `deleted` только когда не осталось неудалённых песочниц, иначе операцию повторяют. Сорвавшееся удаление машины записывается в `pending_sandbox_deletions` (`daytona_key_id`, `daytona_sandbox_id`, уникальность пары): сессия может уйти на другую песочницу и потерять старый id в `sandboxes`, но повторный `deleteKey` найдёт машину по этой записи и удалит её. После удаления `resume` бросает `SandboxSessionGoneError`, и `start` создаёт новую пустую песочницу на другом ключе; переписка, события и файлы живут в базе и S3.
- После ручных прогонов с настоящим Daytona удаляй созданные песочницы: `npm run daytona:cleanup -- <appSessionId>` или `-- --all`. Команда создаёт клиент на каждый рабочий ключ (ключ видит только свою организацию), обходит их и дедуплицирует машины по id; отказ одного ключа не мешает остальным. Остановленная и архивная машина продолжают занимать лимиты аккаунта, а удаление строки `sandboxes` или пользователя машину не удаляет. Каждая машина помечена меткой `studio_session` с id сессии приложения (`agent/lib/daytona-backend.ts`) — по ней скрипт и находит машины.
- При `APP_TEST_MODE=1` только внешний Daytona заменяется `lib/sandbox/fake.ts`; общее файловое состояние задаёт обязательный `FAKE_SANDBOX_DIR`, помощник — `tests/http/support/fake-sandbox.ts`. Перед каждым файлом тестов состояние очищается. `createDaytonaKey` вставляет зашифрованный ключ. `fakeSandbox.setQuota`, `setOrganization`, `failUsage`, `archive`, `usageCalls` и `counters().createAttempts` задают квоту, общую организацию, отказ и архив; фиктивные `/api-keys/current` и `/organizations/{id}/usage` отвечают в форме Daytona, использование считается по состояниям (запущенная — всё, остановленная — диск, архивная — ничего). На тарифах Tier 1/2 сеть песочницы ограничена белым списком Daytona.
- Число потоков (ONNX Runtime у Piper, параллельность рендера) равно числу vCPU песочницы: по умолчанию ONNX Runtime берёт потоки по числу ядер хоста и работает в 10–15 раз медленнее (замер).
- На тарифах Tier 1 и 2 песочница ходит только по белому списку (PyPI, npm, GitHub, Hugging Face).
- `bash` ждёт команду 30 секунд, затем возвращает `status: "running"` с `outputDirectory` `/tmp/.eve/jobs/<8 hex>/`; команда живёт в песочнице своей группой процессов и пишет `stdout`, `stderr`, `pid` и `exit`. Строку `bash_jobs` создаёт идемпотентный синхронизатор событий (`lib/sessions/events.ts`) по `action.result`, а не отдельный хук: сбой записи не оставляет задание без строки, следующий проход её досоздаёт. Синхронизатор работает только для корневой сессии; для копии агента (#12) строку пишет хук по тому же `action.result` в сессию приложения корня (`ctx.session.parent.rootSessionId`), потому что поток копии в поток корня не попадает. Карточка в панели копии опрашивает задание по корневой сессии.
- `GET /api/sessions/:id/jobs/:jobId` (`app/api/sessions/[id]/jobs/[jobId]/route.ts`) требует вход и сессию пользователя, принимает только `^[0-9a-f]{8}$` (иначе `400`), отдаёт `bash_jobs` или читает каталог задания методом `readJobDirectory` слоя песочницы: настоящий — `lib/sandbox/job-directory.ts` одной командой с `tail -c`, `wc -c`, `cat pid` и `kill -0 -- -$(cat pid)`, фиктивный — `lib/sandbox/fake-store.ts`. Хвост каждого потока — не больше 64 КиБ, первая неполная строка отбрасывается. Остановленную, заархивированную или удалённую песочницу маршрут не будит: незавершённое задание становится `interrupted`, завершённое отдаётся с `source: "saved"`. `503` — Daytona недоступна, ключ удалён или песочница `gone`. Ответ кэшируется в процессе на секунду, одновременные запросы делят одно чтение.
- «Стоп» (`agent.cancel()`) не останавливает песочницу и не убивает фоновые процессы: команда, уже вернувшая `running`, продолжается, карточка опрашивает её при любом состоянии хода. Задание, остановленное моделью через `kill`, завершается с кодом 143 и показывается как `completed`.

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
- Не «честно отмечать» недоделанное. Если что-то не сделано, не проверено или не сходится — это надо доделать и проверить, а не писать оговорку в README, PR или отчёте. Если работа упирается во внешний блокер (нет ключа, доступа, ответа владельца), блокер называется прямо и задача остаётся открытой, а не закрывается оговоркой.
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
- `media` — объект S3 пользователя и сессии (`kind`: `upload`, `tool_media`, `message_file`, `preview`); `message_files` — файл ответа агента с состоянием `copying`/`ready`/`missing` и причиной, unique(`app_session_id`, `message_id`, `sandbox_path`); `tool_call_media` — медиа вызова инструмента, unique(`app_session_id`, `call_id`, `sandbox_path`). Внешние ключи на `users`, `app_sessions` и `media` — с `ON DELETE CASCADE`.
- `bash_jobs` — фоновая команда `bash`: `job_id` (8 hex), `status` (`running`/`completed`/`interrupted`), `exit_code`, хвосты `stdout_tail`/`stderr_tail` и полные размеры потоков, `created_at`/`updated_at`; unique(`app_session_id`, `job_id`), внешний ключ на `app_sessions` с `ON DELETE CASCADE`. Строки завершённых заданий остаются, чтобы старые сессии показывали итог при остановленной песочнице.
- `agent_sessions` — сессия копии агента: `app_session_id` (внешний ключ с `ON DELETE CASCADE`), `eve_session_id` (unique), `task_id` (может быть пустым), `call_id` вызова, открывшего копию, `name`, `created_at`. Строку вставляет синхронизатор событий в той же транзакции, что и событие `agent.started` (`ON CONFLICT DO NOTHING`); по ней канал проверяет владельца потока копии. Поток копии в `session_events` не сохраняется: он живёт в eve, пока жива сессия копии, а с `limits.sessionTimeoutMs: false` сессия не истекает по простою, поэтому ход копии доступен и спустя недели (данные запуска удаляются только с завершением сессии).

## Хранилище S3

Любой S3-совместимый провайдер, клиент — `lib/s3.ts`, настраивается переменными `S3_*`. Формат ключей объектов:

```text
u/<user_id>/s/<app_session_id>/<вид>/<uuid>/<имя файла>
```

`вид` — `uploads`, `tool-media`, `message-files`, `preview`. Удаление сессии или пользователя — это удаление по префиксу.

## Файлы в ответе агента

- Ссылку на файл агент вставляет путём без схемы (`[ролик](out/final.mp4)`); общая с браузером функция разбора — `lib/media/sandbox-path.ts`. Файлом считается только путь строго внутри `/workspace/`; относительные считаются от корня, запрос и фрагмент отбрасываются, процентное кодирование раскрывается один раз, обратная косая черта и управляющие символы отвергаются.
- Хук `agent/hooks/message-files.ts` на `message.completed` копирует файлы в S3 (`message-files`), ждёт не дольше 30 секунд и доделывает остальное в фоне. Строки `message_files` идемпотентны по паре «сообщение, путь»; `message_id` — `<turnId>:<stepIndex>`, не больше 20 уникальных ссылок на сообщение. Предел размера — `MEDIA_COPY_MAX_BYTES` (по умолчанию 2 ГиБ).
- Копирование — `lib/media/copy.ts`: `realpath` и `LC_ALL=C stat -c '%F|%s'` в песочнице, затем поток в S3 через `@aws-sdk/lib-storage`. Путь символической ссылки проверяется повторно.
- Маршруты: `GET /api/media/:id` (302 на подписанную ссылку S3 на 15 минут; `?download=1` и невстраиваемые типы — вложение) и `GET /api/sessions/:id/files`. Оба не запускают песочницу.
- Streamdown: remark-плагин `lib/media/remark-sandbox-files.ts` заменяет путь на `/__sandbox-file/<закодированный путь>` (отвергнутый — `/__sandbox-file-rejected`) до `remark-rehype`; компоненты `a` и `img` в `components/studio/chat/chat-markdown.tsx` рисуют файл, остальные адреса отдают штатным компонентам. `rehype-harden` разрешает изображения только по этим адресам. Блочные карточки требует переопределённый `p`.
- Медиа вызовов инструментов: `publishToolMedia` (`lib/media/publish-tool-media.ts`) и таблица `tool_call_media` — общий помощник для карточек #13, #15, #20; повторный шаг с тем же `callId` не создаёт вторую строку. Карточки файлов ответа перезапрашивают ссылку через `useMediaRetry` один раз (`?retry=1`), после второй ошибки — скачивание.

## Загрузка файлов пользователя

- `POST /api/uploads` создаёт строку `media` (`kind='upload'`) и подписанную ссылку на загрузку. Тело — `{appSessionId, name, contentType, sizeBytes}`. Ответ `201 {id, uploadUrl, method: "PUT", headers: {"Content-Type"}, expiresAt, fileUrl}`; ссылка живёт 15 минут (`UPLOAD_URL_TTL_SECONDS`), `Content-Type` входит в подпись (`presignUpload` с `signableHeaders`), поэтому `PUT` с другим типом хранилище отвергает (`403`). `Content-Type` нормализуется: нижний регистр, без параметров после `;`, пустой → `application/octet-stream`, шаблон `^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`, до 127 знаков. Ошибки: `400 invalid_request` «Укажите имя, тип и размер файла.», `401`, `403` (Origin/блокировка), `404` «Сессия не найдена.», `413 too_large` «Файл «{имя}» больше допустимых {предел}.». Предел печатает `formatUploadLimit` (`lib/uploads/limits.ts`): ГиБ/МиБ/КиБ/Б, одна цифра после запятой, нулевая дробь отбрасывается.
- Ключ объекта — `u/<user_id>/s/<app_session_id>/uploads/<id строки media>/<очищенное имя>` (`lib/uploads/keys.ts`). Очистка (`lib/uploads/name.ts`): `/`, `\`, управляющие символы и `..` → `_`, пустое имя → `file`; в ключе имя усекается до 180 байт с сохранением расширения и по границе UTF-8, `original_name` — до 255 символов.
- Предел одного файла — `UPLOAD_MAX_BYTES`: по умолчанию `268435456` (256 МиБ; eve держит файл в памяти целиком, пик примерно в пять раз больше), не больше `5368709120` (одиночный `PUT` в S3 ограничен 5 ГБ). Схема конфигурации отвергает большее значение при старте, называя переменную. Канал eve читает только её (`readUploadMaxBytes`), потому что модуль канала исполняется и при `eve build`, когда `.env` может не быть. В `.env.test` стоит `1048576`, поэтому «слишком большой» проверяется килобайтами, а 30 МиБ доставляются отдельным сервером eve с поднятым пределом.
- Канал eve (`agent/channels/eve.ts`) задаёт `uploadPolicy.maxBytes` и `fetchFile: fetchUserAttachment` (`agent/lib/attachment-fetch.ts`). `fetchFile` узнаёт свой адрес по `APP_URL` и шаблону `/api/media/<uuid>` (`lib/media/media-url.ts`) и никогда не возвращает `null`: произвольный адрес и чужой файл — «Файл недоступен. Попросите пользователя прикрепить его заново.», объекта нет — «Файл не был загружен до конца…», размер из `HeadObject` не равен заявленному или больше предела — «Размер файла не совпал с заявленным или превышает предел.», `session.auth.current === null` — «Не удалось определить пользователя…». Связь eve-сессии с сессией приложения не проверяется: в первом сообщении её может ещё не быть.
- Первое сообщение с вложением: eve раскладывает файлы в песочницу до того, как хук сохранения запишет привязку, поэтому `boundSession` в `agent/lib/daytona-provider.ts` берёт сессию приложения из `session.auth.initiator.attributes.appSessionId`, если строка ещё свободна или уже привязана к этой сессии eve; иначе ждёт привязку в базе. Без этого первое сообщение с файлом не дожидалось песочницы.
- Клиент: `useAttachments` (`components/studio/chat/use-attachments.ts`) — не больше трёх параллельных загрузок через `XMLHttpRequest` (нужен прогресс), ошибка блокирует отправку до «Повторить» или «Убрать», «Убрать» прерывает `abort()`. Адрес загрузки запрашивается сразу при добавлении; на странице `/s` перед первой загрузкой создаётся сессия приложения. Общие тексты пределов — `lib/uploads/limits.ts` (10 файлов, 4 ГиБ). Скрепка, перетаскивание на беседу и вставка из буфера живут в `ChatComposer`/`ChatView`; безымянное изображение из буфера называется «Снимок экрана ГГГГ-ММ-ДД ЧЧ-ММ-СС.png» по местному времени. Отправка недоступна, пока идёт загрузка или есть ошибка; сообщение может состоять из одних файлов, файловые части идут вместе с текстом.
- Лента: файловые части `message.received` рисуются `Attachment` под текстом (`components/studio/chat/message-attachments.tsx`). Размера в ленте нет (у файла по ссылке eve его не передаёт), у изображения миниатюра `/api/media/<uuid>` (хост не важен), нажатие скачивает `?download=1`.
- S3 из браузера: подпись строится на `S3_ENDPOINT`, поэтому он должен быть доступен браузеру, а у бакета нужны CORS-правила (источник `APP_URL`, метод `PUT`, заголовок `Content-Type`). У хранилища из `compose.yaml` (`pgsty/silo`) правило не нужно: `MINIO_API_CORS_ALLOW_ORIGIN` по умолчанию `*`.

## Оценки настоящей модели

`evals/web/` проверяет четыре веб-сценария по три раза; `node evals/support/two-of-three.mjs web --url http://localhost:3000` принимает каждый сценарий только при двух успешных случаях из трёх. Инструкции запуска — в README, раздел «Локальные оценки поведения агента». Раннер использует штатные подмены всех инструментов и отказывает, если появился непокрытый инструмент. `APP_EVAL_MODE=1` и `EVE_EVAL_AUTH_TOKEN` открывают отдельного eval-принципала только на localhost вне production; ему недоступны пользовательские корни и копии, хуки не пишут его события и файлы в пользовательскую базу. Судья настраивается `EVAL_JUDGE_MODEL` в процессе `eve eval`, отдельно от модели агента.

- Оценки запускать против приложения: в окружении приложения задать `APP_EVAL_MODE=1`, `EVE_EVAL_AUTH_TOKEN` и настоящую `AGENT_MODEL*`, затем `npm run dev`; в окружении раннера — тот же токен и доступ к модели судьи. Команда: `npx eve eval --url http://localhost:3000`; список: `npx eve eval --list`. Без `--url` eve поднимает отдельный сервер без Next.js. `APP_TEST_MODE` для этих оценок не включать.
- Новый инструмент добавлять в подмены всех сценариев, которые могут его вызвать; использовать реальные схемы ответов и ставить специфичные `match` перед безусловным правилом. Подмены не заменяют HTTP-проверку публикации медиа и доступа владельца. Оценки видеографа должны проверять уточнения до работы, просмотр кадров до полного рендера, правку существующего проекта с новым именем файла и честную неудачу; каждый сценарий — минимум два успеха из трёх, через общий `two-of-three.mjs`.
- Исключение для файловых инструментов в `evals/video/`: выделенный локальный экземпляр с `APP_VIDEO_EVAL_SANDBOX=1` принимает только eval-токен и использует Docker из `agent/sandbox/Dockerfile` вместо Daytona. Файлы, Node.js, кадры и MP4 настоящие; внешние инструменты подменены. В отрицательном сценарии сеть закрыта, поставляемые FFmpeg получают инъекцию ошибки, но рендер кадров работает. Исход кодирования подтверждается отдельно от общего exitCode shell-цепочки. Параметр `x-studio-video-eval: render-failure` передавать и при создании сессии, и в первом сообщении: инициатор закрепляется при инициализации, заголовки создания не становятся заголовками последующих запросов. Ошибки провайдера изображений не считать успешным просмотром.

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
| `edgeTtsStub` | тестовый Edge TTS (`tests/http/support/edge-tts.ts`): `setMode(mode, count?)`, `calls()` (рукопожатия, тексты, запросы списка голосов), `reset()` в `beforeEach`. Режимы: `ok`, `rate_limit`, `fail`, `no_boundaries`, `close_1007`, `forbidden`. Сервер `tests/http/support/edge-tts-server.ts` поднимает глобальная подготовка; `HEAD /` отдаёт корректный `Date`, чтобы библиотека не повторяла рукопожатие из-за часов |
| `tavilyStub` | тестовый Tavily (`tests/http/support/tavily.ts`): `setMode(mode, count?, retryAfter?)`, `calls()` (тела и заголовки запросов), `reset()` в `beforeEach`. Сервер `tavily-server.ts` на `59102` поднимает глобальная подготовка. Режимы: `ok`, `empty`, `non_json`, `invalid_payload`, `400`, `401`, `422`, `429`, `432`, `433`, `500` |
| тестовый издатель OIDC | `tests/http/support/oidc-issuer.ts` слушает порт из `TELEGRAM_OIDC_ISSUER`, поднимается глобальной подготовкой один раз; `/auth` и одноразовый `/token` проверяют Basic, redirect URI и PKCE; JWT и nonce проверяются по-настоящему. Состояние меняется через `POST /__control` только с loopback |
| `db()` | клиент Drizzle к тестовой базе (клиент приложения, один пул на процесс воркера; после файла закрывается) |
| `resetDatabase()` | `TRUNCATE … CASCADE` всех таблиц схемы `public`, кроме служебных таблиц drizzle; вызывается автоматически перед каждым тестовым файлом (`setupFiles`). `TRUNCATE` повторяется, если Postgres выбрал его жертвой взаимной блокировки с записью события хода из процесса eve |
| `createUser(overrides?)` | вставляет строку `users` (по умолчанию уникальные `telegram_id` и `name`, оба флага false) и возвращает её |
| `s3()` | клиент тестового бакета для проверок: `getBytes(key)`, `exists(key)`, `listKeys(prefix)`, `put(key, bytes, contentType)`, `deletePrefix(prefix)`; бакет очищается тем же вызовом перед каждым файлом |
| `createSessionAs(user)` | `POST /api/sessions` от имени пользователя, возвращает `{ id }` |
| `eveClientAs(user, appSessionId)` | клиент `Client` из `eve/client` с cookie пользователя и заголовком `x-studio-session-id` |
| `readStreamUntil(stream, type, { timeoutMs })` | читает поток событий, пока не придёт событие `type` (по умолчанию 30 с), возвращает все прочитанные события |
| `waitForStoredEvents(user, appSessionId, predicate, { timeoutMs })` | опрашивает `GET /api/sessions/:id/events` раз в 200 мс, пока условие не выполнится (по умолчанию 10 с) |
| `sendAndWait(user, appSessionId, text)` | создаёт сессию eve первым сообщением или отправляет следующее, дочитывает поток до `session.waiting`; только текст |
| `sendWithFiles(user, appSessionId, text, mediaIds)` | то же с файловыми частями (#9): имя и тип берутся из строк `media`, `data` — `fileUrl` (`<APP_URL>/api/media/<id>`); `sendContentAndWait` принимает готовое содержимое |

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
| 59101 | тестовый сервер Edge TTS (`EDGE_TTS_WSS_URL`, `EDGE_TTS_VOICES_URL`) |
| 59102 | тестовый сервер Tavily (`TAVILY_API_URL`) |

## Проверка

Достаточно самой узкой проверки, которая подтверждает изменённое поведение:

- `npm run typecheck`
- `npm run dev` — страница и `/eve/v1/health` через прокси Next.js
- `eve info`
- `eve build`
- `next build`
- `next start`

Тесты — финальная проверка, а не способ отладки: сначала выяснить причину, затем один прогон. Два шва: HTTP-поверхность запущенного приложения (маршруты eve и приложения, модель подменена `mockModel`, инструменты заглушены, настоящие тестовые Postgres и S3) и отрисовка беседы по записанному состоянию сообщений.

## Документация репозитория

`README.md` описывает продукт, запуск и настройку — то, что нужно пользователю и посетителю репозитория. Это не дневник работы: замеров на машине разработчика, пересказа хода проверок, отметок «прогон остановлен» или «вживую не воспроизводили», дат личных экспериментов и черновиков там быть не должно. Такие заметки остаются в PR, issue или комментариях к коммитам. Устойчивое ограничение описывается как факт и следствие для настройки, без истории его получения. Исключение — замер, который тикет прямо требует записать в README: в README попадают числа и то, на какое поведение они влияют, а как и когда их снимали — в PR и issue. `AGENTS.md` — рабочие инструкции агентам, в нём такие подробности уместны.

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

- Работа по тикету никогда не коммитится в `main`: сначала ветка от актуального `origin/main`, затем коммиты в ней и push. Прямой коммит в `main` — ошибка. Если он случился, перенести коммит в отдельную ветку, вернуть `main` к `origin/main` и открыть PR; не оставлять работу в `main` и не пушить её туда.
- PR открывается **только** когда выполнен **каждый** пункт приёмки тикета: код, тесты, замеры, документация и ручные прогоны. Пункт, который «сделает владелец позже», — невыполненный: значит, тикет открыт и PR нет. Пока хоть один пункт не закрыт, работа остаётся в ветке без PR; отчёт об этом говорит прямо, а не выдаёт невыполненное за отложенное.
- Если PR всё же открыт раньше времени, закрыть его и открыть заново (не переоткрывать старый) после выполнения всех пунктов.
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
