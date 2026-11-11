# Замеры синтеза музыки

Песочница образа #14: 2 vCPU, 4 ГБ, Python 3.12, Remotion 4.0.538.
Пик памяти — `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss` отдельного
запускателя. Время синтеза не включает `pip install` и импорт: они в своих столбцах.
Владелец прослушал три файла A по 45 с на −24 LUFS, те же настроения на −18 LUFS
и ролики сведения. Музыка подходит. На обоих уровнях она гораздо тише озвучки.
Громкость по умолчанию остаётся −18 LUFS с озвучкой и −16 без неё: изменить её
можно просьбой агенту. B и D не прослушаны.

## Фильтры `npx remotion ffmpeg -filters`

Команда из `/opt/remotion`. Полный список сборки (50 строк):

```text
 ... acopy             A->A       (null)
 T.C adelay            A->A       (null)
 ... aformat           A->A       (null)
 ... amerge            N->A       (null)
 ..C amix              N->A       (null)
 ... anull             A->A       (null)
 T.. apad              A->A       (null)
 ... aresample         A->A       (null)
 ..C asetpts           A->A       (null)
 ... asetrate          A->A       (null)
 ..C atempo            A->A       (null)
 ... atrim             A->A       (null)
 ... loudnorm          A->A       (null)
 ... pan               A->A       (null)
 ... silencedetect     A->A       (null)
 T.C volume            A->A       (null)
 ... anullsrc          |->A       (null)
 ... sine              |->A       (null)
 TS. colorspace        V->V       (null)
 ... copy              V->V       (null)
 ..C crop              V->V       (null)
 T.. fieldorder        V->V       (null)
 ... format            V->V       (null)
 TS. hflip             V->V       (null)
 ... null              V->V       (null)
 ... palettegen        V->V       (null)
 ... paletteuse        VV->V      (null)
 TSC rotate            V->V       (null)
 ..C scale             V->V       (null)
 ... split             V->N       (null)
 ... tinterlace        V->V       (null)
 .S. tonemap           V->V       (null)
 .S. transpose         V->V       (null)
 ... trim              V->V       (null)
 T.. vflip             V->V       (null)
 .SC zscale            V->V       (null)
 ... nullsrc           |->V       (null)
 ..C concat            N->N       (null)
 ... abuffer           |->A       (null)
 ... buffer            |->V       (null)
 ... abuffersink       A->|       (null)
 ... buffersink        V->|       (null)
```

`aevalsrc`, `anoisesrc`, `afade` и `ebur128` в списке нет. `sine`, `amix`,
`volume`, `adelay`, `apad`, `atrim`, `loudnorm` и `silencedetect` есть.
У `-f null` нет видеокодека: `loudnorm=print_format=json` по mp4 идёт с `-vn`.

## Кандидаты

| | A. numpy/scipy | B. MIDI и сэмплер | C. pedalboard | D. фильтры ffmpeg | E. Tone.js |
| --- | --- | --- | --- | --- | --- |
| Установка | `numpy==2.2.6` `scipy==1.15.3` `pyloudnorm==0.2.0`, PyPI | `mido==1.3.3` `midiutil==1.2.1`; `tinysoundfont==0.3.7` через `pip install --no-deps` | `pedalboard==0.9.26`, PyPI | ничего | не запускался |
| Диск и время установки | 204 МиБ, 5,8 с | MIDI 1,6 МиБ за 2,5 с; tinysoundfont 0,5 МиБ за 0,6 с; SoundFont 307 КиБ с GitHub | 21,5 МиБ, 0,9 с | 0 | — |
| Белый список | PyPI, да | PyPI и GitHub, да. fluidsynth через apt не ставился | PyPI, да | да | — |
| Импорт | 0,8 с, 104 МиБ | tinysoundfont импортируется без pyaudio | `ImportError: libatomic.so.1` | — | — |
| 60 с на 2 vCPU | 1,9 с без импорта | 0,035 с одна нота, 69 МиБ | нет: пакет не импортируется | 0,9 с три синуса, 136 МиБ | — |
| Пик | 350 МиБ | 69 МиБ | — | 136 МиБ | — |
| Код | общий скрипт 420 строк, расписание трёх настроений около 40 строк | аранжировка не писалась | — | одна команда | — |
| Оценка | подходит, тише озвучки | не прослушано | не звучит | не прослушано | — |
| Годится | да: одна команда pip, 1,9 с, 350 МиБ; края и скачок проверяет тест того же скрипта | библиотека быстрая, но готового трека нет | нет | нет | не нужен |

Выбран A. Повторный прогон `calm` 45 с с seed 1 дал тот же файл.
`calm` 45 с: 1,9 с вместе с импортом, пик 305 МиБ, JSON
`peakDbfs` −10,67 и `integratedLufs` −24,0. `upbeat` и `dramatic` на 60 с —
2,3 с / 346 МиБ и 2,4 с / 346 МиБ. Повтор той же команды на 45 с дал
`upbeat` `peakDbfs` −6,58 и `dramatic` `peakDbfs` −9,05, оба `integratedLufs`
−24,0 и `durationMs` 45000. Скачок соседних отсчётов одного канала
(не больше 0,5 полной шкалы) и края тише −60 dBFS проверяет
`tests/music/test_make_music.py` на этом скрипте.

B.render 60 с стерео одной ноты SoundFont `VintageDreamsWaves-v2.sf2`
(`https://github.com/FluidSynth/fluidsynth`, пик 0,90) уложился в бюджет,
но настроения на нём нет. C ставится и падает на отсутствующем `libatomic.so.1`,
поэтому в скрипт не входит. D собирает ровный аккорд `sine`+`amix`+`volume`+`adelay`,
а выражение `volume=if(lt(t\,1)\,t\,1)` не меняет громкость во времени:
RMS начала, середины и конца совпали. Без `afade` края остаются тоном, это не подложка.
E не запускался: A уже внутри 30 с и 1 ГиБ.

## Ручной замер сведения

Замер снят после правки DC-blocker: фильтр оставляет сигнал без постоянной
составляющей. Прослушивание владельца относится к файлам до этой правки.

Ролик 24 с, 30 к/с, Remotion 4.0.538. Голос `ru-RU-SvetlanaNeural`:
файл −21,06 LUFS, множитель `<Audio>` 1,247. Формула от файла дала 1,791,
стереорендер с ним был −12,85 LUFS. Музыка `calm`, seed 1, `--lufs -18`.
Речь сдвинута на 10 кадров. Замер — `npx remotion ffmpeg -vn -af loudnorm=print_format=json`.

| Дорожка | Окно | input_i | input_tp |
| --- | --- | --- | --- |
| только голос | весь ролик | −15,99 | −1,73 |
| только голос | 2–16 с | −15,76 | −1,73 |
| музыка с приглушением | 2–16 с | −25,75 | −15,83 |
| музыка с приглушением | 17,95–21,9 с | −17,94 | −7,83 |
| смесь | весь ролик | −16,79 | −1,19 |

Под речью музыка тише голоса на 10,0 дБ. Вне речи −17,94 при цели −18.
Пик смеси −1,19 dBTP.

`upbeat` без озвучки, seed 1, `--lufs -16`: JSON `integratedLufs` −16,24 и
`peakDbfs` −1,05. Рендер дал `input_i` −16,39 и `input_tp` −1,06. Видео и звук
по `ffprobe` длятся 24,000 с.
