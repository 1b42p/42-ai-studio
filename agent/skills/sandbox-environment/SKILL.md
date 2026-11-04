---
name: sandbox-environment
description: Перед Remotion, установкой пакетов, сетью и озвучкой в песочнице. Ресурсы, рендер, шаблон /opt/remotion, белый список сети.
---

# Среда песочницы

## Ресурсы

По умолчанию 2 vCPU и 4 ГБ. Для рендера 1080p нужно минимум 3 ГБ: на 2 ГБ рендер завершается кодом 137. Свободное место смотри командой `df -h /workspace`. Образ лежит в нижнем слое диска и почти не занимает записываемый слой: `du -sh /opt/remotion` — 588 МиБ, браузер в `node_modules/.remotion` — 236 МиБ. На проверенной песочнице `df` показал overlay 5,0G и около 656 КиБ занято. Число vCPU даёт `sandbox-vcpu`. `nproc` показывает ядра хоста, а не квоту песочницы.

## Скорость

Ролик 30 с, 1080p, 30 к/с на 2 vCPU и 4 ГБ рендерится около 65 с; эталон из репозитория на той же квоте занял 71 с при пике 1,92 ГиБ. Remotion по умолчанию берёт половину vCPU. Рендер дольше 30 с запускай фоновым заданием `bash`: в ответе `status: "running"` и каталог `outputDirectory`, прогресс читай оттуда.

## Нехватка памяти

Если рендер завершился кодом 137, повтори его с `--disallow-parallel-encoding` и `--concurrency=1`. Если памяти всё ещё не хватает, упрости композицию. На эталоне 2 vCPU / 4 ГБ эти флаги дали те же 1,92 ГиБ пика и 100 с вместо 71 с: пик не снизился.

## Потоки

Python-библиотеку со своими потоками (ONNX Runtime у Piper, numpy, scipy) ограничь значением `sandbox-vcpu`. Без этого Piper работает в 10–15 раз медленнее: при двух потоках пять минут звука занимают около 20 с.

## Сеть

Из песочницы доступны PyPI, npm, GitHub, Hugging Face и часть белого списка Daytona. Недоступны YouTube, TikTok, Twitch, Google, DuckDuckGo, Wikipedia, `example.com`, `remotion.dev`, `remotion.media` и `cdn.jsdelivr.net`: соединение сбрасывается, браузер оттуда заново не скачать. Страницы и ролики оттуда бери серверными инструментами `web_search`, `read_page` и `download_video`.

Код ответа хоста смотри командой `curl -sS -o /dev/null -w '%{http_code}'` и записывай фактический результат. Код ответа не выдумывай. Замер `https://<хост>/` с ожиданием не дольше 20 с:

| Хост | Код |
| --- | --- |
| registry.npmjs.org | 200 |
| pypi.org | 200 |
| files.pythonhosted.org | 404 на `/`, пакеты pip качаются |
| huggingface.co | 200 |
| github.com | 200 |
| fonts.googleapis.com | 404 на `/`, CSS шрифта — 200 |
| fonts.gstatic.com | 404 на `/`, файл woff2 — 200 |
| deb.debian.org | 200 |
| storage.googleapis.com | 400 |
| unpkg.com | 302 |
| cdn.jsdelivr.net | сброс соединения |
| remotion.media | сброс соединения |
| www.remotion.dev | сброс соединения |
| plsduol1ca-dsn.algolia.net | сброс соединения |
| www.youtube.com | сброс соединения |

## Remotion

Новый проект создавай копированием шаблона. `mkdir -p /workspace/<имя>`, скопируй из `/opt/remotion` файлы `package.json`, `tsconfig.json`, `remotion.config.ts` и каталог `src`, затем сделай ссылку `ln -s /opt/remotion/node_modules /workspace/<имя>/node_modules`. Chrome Headless Shell лежит в `/opt/remotion/node_modules/.remotion` и в новый проект не скачивается. `npx create-video` не запускай. Studio не открывай. Результат проверяй кадрами `npx remotion still` и `npx remotion render … --frames=…`, затем полным рендером.

Пакет, которого нет в шаблоне, ставь в шаблон: `cd /opt/remotion && npx remotion add <пакет>`. В каталоге `/workspace/<имя>` не запускай `npx remotion add`, `npm install` и `npm i <пакет>`: без lockfile установка падает, а `npm` заменяет ссылку `node_modules` каталогом без браузера, и следующий рендер пойдёт за браузером на `remotion.media`.

`ffmpeg` и `ffprobe` вызывай только как `npx remotion ffmpeg` и `npx remotion ffprobe`. Шрифты бери из образа, из `@remotion/google-fonts` (хосты `fonts.googleapis.com` и `fonts.gstatic.com`) или пакетом `@fontsource/*` из npm.

## Приоритет

Если официальный навык Remotion расходится с этим навыком, действует этот навык. Для проверочных кадров действует `frame-review`. Ссылки официальных навыков на «Remotion Best Practices» пропускай: каталога `remotion-best-practices` нет. Перед разметкой прочитай `remotion-interactivity/timeline-structure.md`: навык установлен, и ссылки `remotion-markup` на него открываются. Транскрибацию Whisper из `transcribe-captions.md` и пакет `@remotion/whisper-webgpu` не выполняй: субтитры строятся из таймингов озвучки. Нужные навыки загружай по именам: `remotion-create`, `remotion-docs`, `remotion-markup`, `remotion-multimedia`, `remotion-render`, `remotion-captions`, `remotion-interactivity`.

## Документация

Страницу Remotion читай серверным `read_page` по адресу `https://www.remotion.dev/docs/<страница>.md`. Имя страницы ищи `web_search`. Если поиск отвечает, что ключ не задан, открой тем же `read_page` путеводитель `https://www.remotion.dev/llms.txt` и `https://www.remotion.dev/sitemap.xml`. Если адрес с суффиксом `.md` отвечает 404, читай ту же страницу без `.md`. Запрос к Algolia из `remotion-docs` и `curl` на `remotion.dev` не используй. Файл `basic-captions.tsx` бери тем же способом: `https://www.remotion.dev/elements/captions/basic-captions.md`.

## Python

Пакеты ставь командой `pip install`: интерпретатор не помечен как управляемый системой, отдельное окружение не нужно. Piper и документы готовь по навыкам `voiceover` и `reading-documents`. `apt-get install` доступен, когда `id -u` печатает 0. Тяжёлые пакеты вроде LibreOffice занимают диск.

## Готовый файл

Файл для пользователя вставляй Markdown-ссылкой на путь в песочнице. Результаты рендера клади в `/workspace/<имя>/out/` и убирай лишнее.
