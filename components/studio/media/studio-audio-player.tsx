"use client";

import { LoaderCircleIcon, PauseIcon, PlayIcon } from "lucide-react";

import {
  AudioPlayer,
  AudioPlayerPlay,
  AudioPlayerRate,
  AudioPlayerSeek,
  AudioPlayerTime,
  useAudioPlayerContext,
} from "@/components/ui/audio-player";

/** Кнопка воспроизведения: русская подпись и индикатор загрузки. */
function PlayControl() {
  const player = useAudioPlayerContext();
  return (
    <AudioPlayerPlay aria-label={player.playing ? "Пауза" : "Воспроизвести"}>
      {({ playing, loading }) =>
        loading ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : playing ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )
      }
    </AudioPlayerPlay>
  );
}

/** Скорость: подпись по умолчанию английская, поэтому берём состояние плеера. */
function RateControl() {
  const player = useAudioPlayerContext();
  return <AudioPlayerRate aria-label={`Скорость ${player.playbackRate}×`} />;
}

/**
 * Плеер аудио из `@audiocn/audio-player` (#8): части собираются в общий ряд,
 * подписи русские. Элемент `<audio>` хук создаёт отсоединённым, в дерево
 * страницы он не попадает.
 */
export function StudioAudioPlayer({
  src,
  onError,
}: {
  src: string | undefined;
  onError?: () => void;
}) {
  return (
    <AudioPlayer
      className="w-full flex-wrap items-center gap-2"
      onError={onError}
      preload="metadata"
      src={src}
    >
      <PlayControl />
      <AudioPlayerTime />
      <AudioPlayerSeek />
      <AudioPlayerTime type="duration" />
      <RateControl />
    </AudioPlayer>
  );
}
