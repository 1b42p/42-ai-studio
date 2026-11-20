# Артефакты приёмки #34

| Сценарий | Материалы | Что подтверждают |
| --- | --- | --- |
| Д2 / Е1 | [Ролик](d2-piper/video.mp4), [ffprobe](d2-piper/ffprobe.json), [компьютер](d2-piper/desktop.png), [телефон](d2-piper/phone.png) | Ролик 1920×1080 с запасной озвучкой Piper. [Сверка трёх точек субтитров](https://github.com/1b42p/42-ai-studio/issues/34#issuecomment-7037091977). Это не подтверждение штатной озвучки или художественной приёмки Д2. |
| Д3 | [Первый черновик](d3-public/draft-first.mp4), [исправленный черновик](d3-public/draft-revised.mp4), [итоговый MP4](d3-public/final.mp4), [ffprobe финала](d3-public/final-ffprobe.json), [компьютер](d3-public/draft-revised-desktop.png), [телефон](d3-public/draft-revised-phone.png), [замеры](d3-public/render-measurements.json) | Оба черновика 960×540 воспроизводились при открытом вопросе. После одного подтверждения получен исправленный MP4 1920×1080; звучание не изменилось. |
| Б2 | [После перезагрузки страницы](b2-public/reloaded.png), [после перезапуска приложения](b2-public/recovered.png) | Два публичных ответа завершились. Второй появился в той же вкладке через 51,59 с после начала перезапуска. [Отдельная проверка аварийной остановки](b2-candidate/recovered.png) проводилась на отдельном экземпляре. |
| В2 | [Выполняется в фоне](v2-public/running.png), [код 0 после перезагрузки](v2-public/saved-after-reload.png), [песочница остановлена](v2-public/interrupted.png) | «Стоп» в чате отменил ход, но фоновое задание дошло до кода 0. Пробуждение сохранило его файл; остановка Daytona прервала следующее задание. |
| В3 | [До остановки Daytona](v3-public/playsBeforeStop.png), [после остановки и перезагрузки](v3-public/playsAfterStop.png) | MP4 размером 525 024 482 байта играл в Chromium с отметки 300 с до и после остановки Daytona. S3 после остановки вернул `206` на запрос диапазона. |

Д3: финал в повторно открытой беседе — [компьютер](d3-public/final-desktop.png),
[телефон](d3-public/final-phone.png).
