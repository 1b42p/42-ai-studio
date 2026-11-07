# /// script
# requires-python = ">=3.12"
# dependencies = ["piper-tts[alignment]==1.8.0"]
# ///
"""Озвучка Piper 1.8.0 и тайминги v1; чистые функции не импортируют Piper."""

from collections.abc import Sequence
from contextlib import contextmanager, redirect_stdout
from dataclasses import dataclass
import argparse
from importlib.metadata import PackageNotFoundError, version
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import wave


@dataclass(frozen=True)
class SourceWord:
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class Chunk:
    num_samples: int
    phonemes: Sequence[str] = ()
    alignments: Sequence[tuple[str, int]] | None = None


@dataclass(frozen=True)
class Part:
    text: str
    chunks: Sequence[Chunk]
    # Фонемизация префиксов по границам исходных слов (без последнего).
    prefix_phonemes: Sequence[Sequence[Sequence[str]]] = ()


def source_words(text: str) -> list[SourceWord]:
    """Слова — непробельные токены; отдельные знаки приклеены к соседу."""
    words: list[SourceWord] = []
    leading: list[str] = []
    leading_start = 0
    for token in re.finditer(r"\S+", text):
        value = token.group()
        if any(char.isalnum() for char in value):
            words.append(
                SourceWord(
                    " ".join([*leading, value]),
                    leading_start if leading else token.start(),
                    token.end(),
                )
            )
            leading.clear()
        elif words:
            last = words[-1]
            words[-1] = SourceWord(last.text + " " + value, last.start, token.end())
        else:
            if not leading:
                leading_start = token.start()
            leading.append(value)
    return words


def sentence_ranges(words: Sequence[SourceWord]) -> list[tuple[int, int]]:
    """Границы исходных предложений, независимо от деления espeak."""
    ranges = []
    first = 0
    for index, word in enumerate(words):
        if re.search(r"[.!?…](?=\W|$)", word.text):
            ranges.append((first, index + 1))
            first = index + 1
    if first < len(words):
        ranges.append((first, len(words)))
    return ranges


def samples_to_ms(samples: int, sample_rate: int) -> int:
    return math.floor(samples * 1000 / sample_rate + 0.5)


def proportional_samples(words: Sequence[SourceWord], total: int) -> list[int]:
    """Доля букв; для чисел без букв минимальный вес — один."""
    weights = [max(1, sum(char.isalpha() for char in word.text)) for word in words]
    denominator = sum(weights)
    cumulative = 0
    previous = 0
    lengths = []
    for weight in weights:
        cumulative += weight
        boundary = (total * cumulative + denominator // 2) // denominator
        lengths.append(boundary - previous)
        previous = boundary
    return lengths


def chunk_word_groups(part: Part) -> list[tuple[list[SourceWord], Sequence[Chunk]]]:
    """Граница допустима только при точном совпадении фонем всего префикса.

    Числа могут развернуться в несколько групп, поэтому их число здесь не
    определяет границы текста. Если одно исходное слово пересекает границу
    espeak, соседние куски остаются одной неделимой единицей.
    """
    words = source_words(part.text)
    expected = [list(chunk.phonemes) for chunk in part.chunks]
    groups = []
    first_word = first_chunk = 0
    for index, prefix in enumerate(part.prefix_phonemes[: len(words) - 1]):
        end_chunk = len(prefix)
        if (
            first_chunk < end_chunk < len(expected)
            and [list(phonemes) for phonemes in prefix] == expected[:end_chunk]
        ):
            groups.append(
                (words[first_word : index + 1], part.chunks[first_chunk:end_chunk])
            )
            first_word, first_chunk = index + 1, end_chunk
    groups.append((words[first_word:], part.chunks[first_chunk:]))
    return groups


def audio_position(
    position: int, chunks: Sequence[Chunk], silence: int, *, end: bool
) -> int:
    """Позиция в склеенном звуке → позиция с межфразовыми паузами."""
    skipped_silence = 0
    for chunk in chunks[:-1]:
        if position < chunk.num_samples or (end and position == chunk.num_samples):
            break
        position -= chunk.num_samples
        skipped_silence += silence + chunk.num_samples
    return skipped_silence + position


def build_timings(
    source: str,
    voice: str,
    language: str,
    sample_rate: int,
    parts: Sequence[Part],
    sentence_silence: float = 0.25,
) -> tuple[dict, str]:
    """Чистый расчёт файла lib/speech v1; единица времени внутри — отсчёт."""
    original_words = source_words(source)
    if not original_words:
        raise ValueError("Текст не содержит слов для озвучки.")
    if sample_rate <= 0 or not math.isfinite(sentence_silence) or sentence_silence < 0:
        raise ValueError("Некорректная частота звука или пауза между предложениями.")
    if [word.text for part in parts for word in source_words(part.text)] != [
        word.text for word in original_words
    ]:
        raise ValueError("Куски синтеза не покрывают исходный текст целиком.")
    silence_samples = math.floor(sentence_silence * sample_rate + 0.5)
    words = []
    cursor = 0
    chunk_count = 0
    mode = "alignment"
    for part in parts:
        if not source_words(part.text):
            raise ValueError("Кусок синтеза не содержит исходных слов.")
        if not part.chunks or any(chunk.num_samples <= 0 for chunk in part.chunks):
            raise ValueError("Piper вернул пустой кусок звука.")
        for tokens, chunks in chunk_word_groups(part):
            if chunk_count:
                cursor += silence_samples
            total = sum(chunk.num_samples for chunk in chunks)
            groups = group_alignment_samples(chunks[0].alignments or ())
            if len(chunks) != 1 or len(groups) != len(tokens) or sum(groups) != total:
                groups = proportional_samples(tokens, total)
                mode = "proportional"
            position = 0
            for word, samples in zip(tokens, groups, strict=True):
                start = audio_position(position, chunks, silence_samples, end=False)
                finish = audio_position(
                    position + samples, chunks, silence_samples, end=True
                )
                words.append(
                    {
                        "text": word.text,
                        "startMs": samples_to_ms(cursor + start, sample_rate),
                        "endMs": samples_to_ms(
                            cursor + max(start, finish), sample_rate
                        ),
                    }
                )
                position += samples
            cursor += total + (len(chunks) - 1) * silence_samples
            chunk_count += len(chunks)
    sentences = []
    for first, end in sentence_ranges(original_words):
        sentences.append(
            {
                "text": source[
                    original_words[first].start : original_words[end - 1].end
                ],
                "startMs": words[first]["startMs"],
                "endMs": words[end]["startMs"]
                if end < len(words)
                else words[-1]["endMs"],
            }
        )
    return {
        "version": 1,
        "voice": f"piper:{voice}",
        "language": language,
        "format": "wav",
        "durationMs": samples_to_ms(cursor, sample_rate),
        "text": source,
        "words": words,
        "sentences": sentences,
    }, mode


def group_alignment_samples(alignments: Sequence[tuple[str, int]]) -> list[int]:
    """Пробел и знаки относятся к предыдущему слову, BOS/EOS — к краям."""
    groups: list[int] = []
    pending = 0
    spoken = False
    for phoneme, samples in alignments:
        if samples < 0:
            return []
        pending += samples
        if phoneme.isspace():
            if spoken:
                groups.append(pending)
                pending = 0
            elif groups:
                groups[-1] += pending
                pending = 0
            spoken = False
        elif any(char.isalnum() for char in phoneme):
            spoken = True
    if spoken:
        groups.append(pending)
    elif groups:
        groups[-1] += pending
    return groups


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    def positive_int(value: str) -> int:
        number = int(value)
        if number <= 0:
            raise argparse.ArgumentTypeError("нужно положительное целое число")
        return number

    def finite_number(value: str, *, positive: bool) -> float:
        number = float(value)
        if not math.isfinite(number) or number < 0 or (positive and number == 0):
            raise argparse.ArgumentTypeError(
                "нужно конечное положительное число"
                if positive
                else "нужно конечное неотрицательное число"
            )
        return number

    def voice_name(value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_-]+", value):
            raise argparse.ArgumentTypeError(
                "имя голоса вида ru_RU-denis-medium, не путь"
            )
        return value

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--text-file", type=Path, required=True, help="текст сцены в UTF-8"
    )
    parser.add_argument("--voice", type=voice_name, required=True)
    parser.add_argument("--out", type=Path, required=True, help="путь без расширения")
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".cache/piper")
    parser.add_argument(
        "--threads", type=positive_int, help="по умолчанию: sandbox-vcpu"
    )
    parser.add_argument(
        "--sentence-silence",
        type=lambda v: finite_number(v, positive=False),
        default=0.25,
    )
    parser.add_argument(
        "--length-scale", type=lambda v: finite_number(v, positive=True)
    )
    return parser.parse_args(argv)


def sandbox_threads() -> int:
    try:
        result = subprocess.run(
            ["sandbox-vcpu"], check=True, capture_output=True, text=True, timeout=10
        )
        threads = int(result.stdout.strip())
        if threads > 0:
            return threads
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise RuntimeError(
            "Не удалось прочитать sandbox-vcpu; укажите --threads явно."
        ) from error
    raise RuntimeError(
        "sandbox-vcpu должен вернуть положительное число; укажите --threads явно."
    )


@contextmanager
def diagnostic_output():
    """В stdout остаётся только результат, включая вывод нативного espeak."""
    sys.stdout.flush()
    saved_stdout = os.dup(1)
    try:
        os.dup2(2, 1)
        with redirect_stdout(sys.stderr):
            yield
    finally:
        sys.stderr.flush()
        os.dup2(saved_stdout, 1)
        os.close(saved_stdout)


def synthesize(options: argparse.Namespace) -> dict:
    source_path = options.text_file.expanduser().resolve()
    source = source_path.read_text(encoding="utf-8-sig")
    original_words = source_words(source)
    if not original_words:
        raise ValueError("Файл текста пуст или не содержит букв и цифр.")
    out = options.out.expanduser().resolve()
    audio_path = Path(f"{out}.wav")
    timings_path = Path(f"{out}.words.json")
    if source_path in (audio_path, timings_path):
        raise ValueError("Выходной файл не должен заменять исходный текст.")
    data_dir = options.data_dir.expanduser().resolve()
    model_path = data_dir / f"{options.voice}.onnx"
    config_path = Path(f"{model_path}.json")
    for path in (model_path, config_path):
        if not path.is_file() or path.stat().st_size == 0:
            raise FileNotFoundError(
                f"Не найден непустой файл голоса {path}. Скачайте голос: "
                f"python3 -m piper.download_voices {options.voice} --data-dir {data_dir}"
            )
    try:
        installed_version = version("piper-tts")
    except PackageNotFoundError as error:
        raise RuntimeError(
            'Установите pip install "piper-tts[alignment]==1.8.0".'
        ) from error
    if installed_version != "1.8.0":
        raise RuntimeError(f"Нужен piper-tts 1.8.0, установлен {installed_version}.")
    threads = options.threads if options.threads is not None else sandbox_threads()

    # Тяжёлые зависимости нужны только исполняемому CLI, не чистым функциям.
    import onnxruntime
    from piper import PiperVoice, SynthesisConfig

    session_options = onnxruntime.SessionOptions

    def bounded_session_options():
        settings = session_options()
        settings.intra_op_num_threads = threads
        settings.inter_op_num_threads = 1
        return settings

    onnxruntime.SessionOptions = bounded_session_options
    try:
        voice = PiperVoice.load(
            model_path,
            config_path=config_path,
            include_alignments=True,
            download_dir=data_dir,
        )
    finally:
        onnxruntime.SessionOptions = session_options
    sample_rate = voice.config.sample_rate
    silence_samples = math.floor(options.sentence_silence * sample_rate + 0.5)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    language = config.get("language", {}).get("code", options.voice.split("-", 1)[0])
    language = str(language).replace("_", "-")
    synthesis_config = SynthesisConfig(length_scale=options.length_scale)
    parts: list[Part] = []
    out.parent.mkdir(parents=True, exist_ok=True)
    # Неполный синтез не перезаписывает прежнюю готовую озвучку.
    with tempfile.TemporaryDirectory(prefix=".piper-", dir=out.parent) as staging:
        temporary_audio = Path(staging) / "speech.wav"
        temporary_timings = Path(staging) / "speech.words.json"
        with wave.open(str(temporary_audio), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            chunk_count = 0
            # Синтез по исходным предложениям ограничивает поиск границ короткой
            # фразой; espeak всё ещё может вернуть несколько кусков на фразу.
            for first, end in sentence_ranges(original_words):
                text = source[original_words[first].start : original_words[end - 1].end]
                chunks: list[Chunk] = []
                for chunk in voice.synthesize(
                    text, syn_config=synthesis_config, include_alignments=True
                ):
                    if (
                        chunk.sample_rate != sample_rate
                        or chunk.sample_width != 2
                        or chunk.sample_channels != 1
                    ):
                        raise ValueError(
                            "Piper вернул несовместимый формат: нужен mono PCM16."
                        )
                    pcm = chunk.audio_int16_array.astype("<i2", copy=False).tobytes()
                    if not pcm or len(pcm) % 2:
                        raise ValueError("Piper вернул пустой или повреждённый PCM16.")
                    if chunk_count:
                        # Пишем ограниченными блоками даже при большой паузе.
                        remaining = silence_samples
                        while remaining:
                            block = min(remaining, 65536)
                            wav_file.writeframesraw(b"\0\0" * block)
                            remaining -= block
                    wav_file.writeframesraw(pcm)
                    alignment = getattr(chunk, "phoneme_alignments", None)
                    chunks.append(
                        Chunk(
                            len(pcm) // 2,
                            tuple(chunk.phonemes),
                            [
                                (item.phoneme, int(item.num_samples))
                                for item in alignment
                            ]
                            if alignment is not None
                            else None,
                        )
                    )
                    chunk_count += 1
                if not chunks:
                    raise ValueError(f"Piper не создал звук для фразы: {text}")
                prefixes = []
                if len(chunks) > 1:
                    for word in source_words(text)[:-1]:
                        prefixes.append(
                            [
                                phones
                                for phones in voice.phonemize(text[: word.end])
                                if phones
                            ]
                        )
                parts.append(Part(text, chunks, prefixes))
            written_samples = wav_file.getnframes()
        timings, mode = build_timings(
            source,
            options.voice,
            language,
            sample_rate,
            parts,
            options.sentence_silence,
        )
        if timings["durationMs"] != samples_to_ms(written_samples, sample_rate):
            raise ValueError("Длительность таймингов не совпадает с записанным WAV.")
        temporary_timings.write_text(
            json.dumps(timings, ensure_ascii=False, allow_nan=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_audio.replace(audio_path)
        temporary_timings.replace(timings_path)
    return {
        "audioPath": str(audio_path),
        "timingsPath": str(timings_path),
        "durationMs": timings["durationMs"],
        "words": len(timings["words"]),
        "mode": mode,
    }


def main(argv: Sequence[str] | None = None) -> int:
    options = parse_args(argv)
    try:
        with diagnostic_output():
            result = synthesize(options)
    except KeyboardInterrupt:
        print("piper_speak: Озвучка прервана.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"piper_speak: {error}", file=sys.stderr)
        return 1
    sys.stdout.reconfigure(encoding="utf-8")
    print(
        json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
