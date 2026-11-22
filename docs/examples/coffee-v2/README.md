# Реклама «На углу»

Прямая авторская ревизия по просьбе владельца: самостоятельная 3D-композиция,
а не новый запуск агента продукта. Две керамические чашки, латте-арт,
пар, предметный свет и четыре ракурса. Условия акции, мужской русский голос
и субтитры сохранены. Длительность — 20 секунд, 720×1280, 30 кадров/с.

`scene.jsx` создаёт геометрию, материалы, текстуры и движение камеры.
`film.jsx` содержит монтаж текста, озвучку и субтитры по таймингам
`narration.json`. Все визуальные ассеты процедурные; чужих фото и видео нет.
В `public/` лежат готовая озвучка и шрифты Oswald и Fira Sans;
лицензии шрифтов — рядом с этим файлом.

## Пересборка

Из корня репозитория создайте отдельный временный проект, не меняя
зависимости приложения:

```sh
SOURCE="$PWD/docs/examples/coffee-v2"
WORK="$(mktemp -d)"
cd "$WORK"
npm init -y
npm install --save-exact remotion@4.0.544 @remotion/cli@4.0.544 \
  @remotion/three@4.0.544 @remotion/fonts@4.0.544 \
  react@19.3.1 react-dom@19.3.1 three@0.187.0 @react-three/fiber@9.8.2
mkdir src public
cp "$SOURCE/"*.jsx "$SOURCE/narration.json" src/
cp "$SOURCE/public/"* public/
npx remotion render src/root.jsx Coffee coffee.mp4 \
  --gl=swangle --concurrency=2 --codec=h264 --crf=20 \
  --audio-codec=aac --audio-bitrate=128k --x264-preset=slow
```

`swangle` работает без доступа к GPU. Для проверки отдельных кадров:

```sh
npx remotion render src/root.jsx Coffee frames \
  --frames=60,180,270,330,430,555 --image-format=png --gl=swangle
```

Для изменения озвучки отредактируйте `narration.mjs` и запустите его
из корня приложения с каталогом результата:

```sh
node docs/examples/coffee-v2/narration.mjs /путь/к/coffee-film/public
```

Новый `narration.json` перенесите из `public/` в `src/` перед рендером.
После смены текста согласуйте группы субтитров и монтаж в `film.jsx`.
