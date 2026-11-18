# Исходник демонстрации «Видео по ссылкам»

Видео — настоящая съёмка Земли с МКС, NASA Johnson, **View of Planet Earth** из выпуска **4K Video from the ISS, April 2016** (29 апреля 2016, NASA SVS № 30771).

- Первичная публикация и титр правообладателя: https://svs.gsfc.nasa.gov/30771
- Исходный MP4: https://svs.gsfc.nasa.gov/vis/a030000/a030700/a030771/ISS_View_of_Planet_Earth_720p.mp4
- Правила использования: https://www.nasa.gov/nasa-brand-center/images-and-media/

NASA указывает, что её видео обычно не охраняется авторским правом в США, допускает использование на веб-страницах и коммерческое использование без подразумеваемого одобрения. На странице этого материала указан источник **NASA Johnson**, без отдельного стороннего copyright. Выбранный отрезок не содержит людей, эмблем, титров и водяных знаков. Подпись источника сохранена в демонстрации. Это демонстрационный материал, а не свидетельство участия или одобрения NASA.

Локальный файл — 12,000–16,500 секунды оригинала: 4,5 секунды без звука, разворот на 180° для горизонта в верхней части изображения. H.264, yuv420p, 640 × 360, 24 кадра/с, faststart. Три WebP — первые кадры интервалов 0–1,5, 1,5–3 и 3–4,5 секунды этого же файла; они используются и в выборе, и в композиции.

## Воспроизведение подготовки

Из корня репозитория, с установленными curl и FFmpeg:

```sh
curl --fail --location \
  https://svs.gsfc.nasa.gov/vis/a030000/a030700/a030771/ISS_View_of_Planet_Earth_720p.mp4 \
  --output /tmp/iss-earth-original.mp4

ffmpeg -ss 12 -i /tmp/iss-earth-original.mp4 -t 4.5 -an \
  -vf 'hflip,vflip,scale=640:360,fps=24' \
  -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -movflags +faststart \
  public/studio-design/film-source-v1.mp4

ffmpeg -ss 0 -i public/studio-design/film-source-v1.mp4 \
  -frames:v 1 -vf scale=320:180 -c:v libwebp -quality 78 \
  public/studio-design/film-frame-v1-1.webp
ffmpeg -ss 1.5 -i public/studio-design/film-source-v1.mp4 \
  -frames:v 1 -vf scale=320:180 -c:v libwebp -quality 78 \
  public/studio-design/film-frame-v1-2.webp
ffmpeg -ss 3 -i public/studio-design/film-source-v1.mp4 \
  -frames:v 1 -vf scale=320:180 -c:v libwebp -quality 78 \
  public/studio-design/film-frame-v1-3.webp
```

SHA-256 исходного MP4: `1f765decabd2028d72a4497274a0694a121e2cb0d9881d75b795dab16f837874`.
