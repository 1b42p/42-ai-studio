# Неизменяемая спецификация проекта
Весь утверждённый видеоряд нарисован кодом src: крупные русские фразы на тёмном фоне и готовые подсвечиваемые субтитры. Отдельных файлов графики нет и не требуется. Оформление, тексты, субтитры и исходники менять нельзя.
Main: 1920×1080, 30 кадров/с, 600 кадров. Четыре сцены по 150 кадров. Звук начинается через 10 кадров, исходное аудио 4166 мс, затем около 0,5 с паузы.
scene-01: Откройте шторы и впустите мягкий утренний свет.; голос ru-RU-SvetlanaNeural, rate=0; public/voice/scene-01.mp3 и .words.json.
scene-02: Налейте стакан воды и сделайте небольшой глоток.; голос ru-RU-SvetlanaNeural, rate=0; public/voice/scene-02.mp3 и .words.json.
scene-03: Потянитесь без спешки и спокойно расправьте плечи.; голос ru-RU-SvetlanaNeural, rate=0; public/voice/scene-03.mp3 и .words.json.
scene-04: Выберите одно простое дело для начала дня.; голос ru-RU-SvetlanaNeural, rate=0; public/voice/scene-04.mp3 и .words.json.
В проекте могут находиться эталонные/кэшированные медиа. Для ЭТОГО задания обязательно заново вызвать speak для всех сцен и make_music.py, затем заново проверить кадры, отдельно отрендерить обе дорожки и финал. Наличие файла не подтверждает выполнение этого задания.
Музыка: calm, 80 bpm, seed 1, -18 LUFS, 20 секунд; --out /workspace/calm-bed/public/music/bg БЕЗ расширения.
src/BackgroundMusic.tsx и src/ducking.ts уже подключены. Их повторное копирование из идентичных шаблонов допустимо, правки кода и графики не нужны.
Контрольная выборка: 0,100,150,300,450,599; out/frames-1/element-000.jpeg … element-599.jpeg. Проверить пиксели, затем прочитать все шесть JPEG. Эта выборка соответствует неизменяемому исходнику, включая субтитры. Не заменяйте номера другой выборкой.
SPEC.md — неизменяемый входной документ, не журнал. Результаты и фактические измерения записывайте в NOTES.md полным актуальным снимком: newString без oldString, overwrite: true. Это write-only журнал данного контракта: его read-back и поиск/замена старого текста не поддерживаются; исходный план и номера кадров берите из SPEC.md.
Проверка ресурсов проекта из его каталога: pwd; ls src; test -s src/index.ts; test -s src/Root.tsx; test -s package.json; test -d node_modules. Составные операции, полный вывод которых не записан, выполняйте отдельными вызовами.
Процедура сведения — music-synthesis/references/mixing.md. Режим audioMode выключает только соседнюю дорожку, сохраняя общий gain, speech, ducking и длительность; mix — по умолчанию. fixtureVisualOnly разрешён исключительно сборщику эталонных изображений вне оценки, не включайте его в этом задании.
Примеры раздельных рендеров и измерений из каталога проекта:
npx remotion render src/index.ts Main out/voice-only.wav --props='{"audioMode":"voice-only"}'
npx remotion render src/index.ts Main out/music-only.wav --props='{"audioMode":"music-only"}'
npx remotion ffmpeg -i out/voice-only.wav -vn -af loudnorm=print_format=json -f null -
npx remotion ffmpeg -ss 1 -t 2 -i out/voice-only.wav -vn -af loudnorm=print_format=json -f null -
npx remotion ffmpeg -ss 1 -t 2 -i out/music-only.wav -vn -af loudnorm=print_format=json -f null -
npx remotion ffmpeg -i out/music-only.wav -vn -filter_complex "[0:a]atrim=start=4.91:end=5.12,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=9.91:end=10.12,asetpts=PTS-STARTPTS[b];[0:a]atrim=start=14.91:end=15.12,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1,loudnorm=print_format=json" -f null -
Окно 1–3 с внутри речи. Три чистых промежутка 4.91–5.12, 9.91–10.12, 14.91–15.12 с находятся вне речи и переходов и объединяются для loudnorm (>400 мс).
После успешных раздельных замеров: npx remotion render src/index.ts Main out/final.mp4; отдельно test -s/stat, ffprobe (json либо default), loudnorm смеси с -vn. Только затем готовность и ссылка.
