# 42 AI Studio

Сайт для создания видео с помощью ИИ. Пользователь ставит задачу, агент-видеограф
собирает Remotion-композицию, озвучивает, рендерит и отдаёт готовый ролик.

## Запуск с нуля

```bash
cp .env.example .env        # значения-заглушки, секретов в образце нет
docker compose up -d        # Postgres и хранилище, бакеты studio-dev и studio-test
npm install
npm run db:migrate          # применяет миграции к базе из DATABASE_URL
npm run dev
```

Проверить, что всё поднялось:

```bash
curl -i http://localhost:3000/api/health     # {"status":"ok","checks":{"database":"ok","storage":"ok"}}
curl -i http://localhost:3000/eve/v1/health  # {"ok":true,...}
```

`GET /api/health` отвечает `503`, если недоступна база или хранилище; тексты
ошибок при этом уходят только в журнал сервера.

### Как вручную увидеть отказ хранилища

```bash
S3_ENDPOINT=http://localhost:1 npm run dev
curl -i http://localhost:3000/api/health
# {"status":"error","checks":{"database":"ok","storage":"error"}}
```

## Состояние eve

Каталог `.eve/.workflow-data` хранит состояние запусков eve (сессии, потоки,
очереди). Это требование eve: в рабочей среде каталог должен лежать на
постоянном диске и переживать перезапуск процесса, иначе durable-сессии и
идущие ходы теряются. В разработке он создаётся сам.

Не запускайте `npm run dev` и `npm run test:http` одновременно: `withEve()`
держит один dev-сервер eve на корень проекта, и экземпляр тестов делит его с
разработкой — проверки входа в тестах начинают отвечать 401. Остановите один
из процессов перед запуском другого.

## Модель агента

Модель задаётся переменными `AGENT_MODEL` и `AGENT_REASONING`; без
`AGENT_MODEL` (и без `APP_TEST_MODE=1`) сервер не стартует. Для
OpenAI-совместимого провайдера задайте `AGENT_MODEL_BASE_URL`,
`AGENT_MODEL_API_KEY` и `AGENT_MODEL_CONTEXT_TOKENS`; для AI Gateway достаточно
`AGENT_MODEL` и ключа `AI_GATEWAY_API_KEY`, который читает сам AI SDK.

## Вход через Telegram

Отдельных учётных записей нет: пользователь входит через Telegram, при первом входе
создаётся строка `users`. Вход использует Telegram OpenID Connect: браузер
переходит на страницу Telegram, сервер обменивает код на `id_token` и проверяет его.

1. Создайте бота в [@BotFather](https://t.me/botfather) и откройте у него **Login Widget**.
2. Если показана **Switch to OpenID Connect Login**, включите этот режим:
   он навсегда отключает старый Login Widget у этого бота.
3. Зарегистрируйте публичный HTTPS-адрес приложения (`APP_URL`):
   - **Trusted Origins**: `<APP_URL>`;
   - **Redirect URIs**: `<APP_URL>/api/auth/telegram/callback`.

   В интерфейсе с общим списком **Allowed URLs** добавьте оба адреса туда.
   `localhost` BotFather не принимает: для локальной проверки используйте HTTPS-туннель.
4. Скопируйте **Client ID** и **Client Secret** в `TELEGRAM_CLIENT_ID` и
   `TELEGRAM_CLIENT_SECRET`. Client Secret — отдельное значение, не токен бота;
   он хранится только на сервере.
5. Не меняйте алгоритм подписи `id_token`: сервер проверяет `RS256`.
6. Задайте `SESSION_SECRET` длиной не короче 32 символов:
   `openssl rand -base64 48`.

Поток: `GET /api/auth/telegram/login` создаёт `state`, одноразовый `nonce` и PKCE,
сохраняет их в подписанной HttpOnly-cookie на 10 минут и направляет в Telegram.
`GET /api/auth/telegram/callback` проверяет cookie и `state`, обменивает код,
проверяет подпись по JWKS, `iss`, `aud`, `exp`, `iat`, `sub` и `nonce`,
гасит nonce и создаёт сессию. Временная cookie удаляется и при успехе, и при отказе.

Для локальной разработки без Telegram включите `DEV_LOGIN_ENABLED=1` (только
`localhost`, `127.0.0.1` или `[::1]`) и откройте
`/api/auth/dev-login?telegramId=777&name=Разработчик`. Параметр `operator=1`
делает пользователя оператором.

`GET /eve/v1/health` публичен; остальные маршруты eve требуют cookie сессии,
а `GET /eve/v1/info` доступен только оператору.

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run dev` | разработка (`next dev`) |
| `npm run build` | сборка: `eve build` и `next build` |
| `npm start` | production-запуск (сначала нужен `npm run build`) |
| `npm run db:generate` | создать миграцию из изменений схемы |
| `npm run db:migrate` | применить миграции к базе из `DATABASE_URL` |
| `npm run test:http` | HTTP-тесты запущенного приложения |
| `npm run test:render` | тесты отрисовки в настоящем Chromium |

`npm run build` секретов не требует: проверка переменных окружения
пропускается на фазе сборки. При `npm start` сначала выполняйте
`npm run build` — он делает `eve build`, и eve при этом слушает порт `4274`
(`EVE_NEXT_PRODUCTION_PORT`).

## Тесты

```bash
docker compose up -d
npm run test:http
```

Тесты запускают настоящее приложение и ходят в него по HTTP: глобальная
подготовка создаёт базу `*_test`, бакет, применяет миграции и поднимает
основной экземпляр `next dev` на `TEST_APP_PORT`, отдельные тесты поднимают
свои экземпляры через `startApp()`. Работать тесты могут только с базой,
имя которой оканчивается на `_test`.

Два `next dev` на один проект не мешают друг другу: каждый экземпляр получает
свой `NEXT_DIST_DIR` (`.next-test-<порт>`), поэтому блокировка `.next/dev/lock`
не конфликтует. При этом `withEve()` держит один dev-сервер eve на корень
проекта (состояние в `.eve/`) — второй экземпляр делит процесс eve с первым,
изоляции окружения eve нет. Тестам, которым нужно другое окружение eve,
понадобится остановить основной экземпляр и вынести их в отдельные файлы.

### Тесты отрисовки

```bash
npx playwright install chromium   # один раз: браузер для Vitest Browser Mode
npm run test:render
```

Тесты открывают настоящий Chromium (безголовый) и проверяют интерфейс в окнах
390×844 и 1280×800. База и Docker для них не нужны.

На EndeavourOS установщик Playwright предупреждает, что система не
поддерживается официально, и ставит сборку для Ubuntu. Если Chromium не
запускается из-за нехватки системных библиотек, `npx playwright install-deps`
не поможет: он вызывает `apt-get`, которого на EndeavourOS нет. Посмотреть
недостающие библиотеки:

```bash
ldd ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | grep "not found"
```

и поставить их через pacman, например:

```bash
sudo pacman -S --needed alsa-lib at-spi2-core dbus expat glib2 libdrm libxkbcommon \
  libxcomposite libxdamage libxfixes libxrandr mesa nspr nss
```

## Документация

- [eve](https://eve.dev/docs) — агент и его инструменты.
- [Remotion](https://www.remotion.dev/docs) — сборка и рендер видео.
- Структура проекта, команды и соглашения — в [`AGENTS.md`](AGENTS.md).
