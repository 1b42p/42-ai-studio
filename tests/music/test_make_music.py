# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "numpy==2.2.6",
#   "scipy==1.15.3",
#   "pyloudnorm==0.2.0",
# ]
# ///
"""Контракт make_music.py: WAV, громкость, края и seed.

Громкость независимо измеряет `remotion ffmpeg` версии 4.0.538.
MUSIC_REMOTION_PROJECT указывает каталог композиции с установленными пакетами
remotion, @remotion/cli и @remotion/renderer этой версии (в песочнице
/opt/remotion). Локальный проект можно подготовить вне корневого пакета:
`npm install --prefix /tmp/opencode/music-remotion --no-save remotion@4.0.538
@remotion/cli@4.0.538 @remotion/renderer@4.0.538`.
Системный ffmpeg и pyloudnorm для независимой проверки не используются.
"""

import array
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import unittest
import wave
from functools import lru_cache
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "agent/skills/music-synthesis/scripts/make_music.py"
)
REMOTION_VERSION = "4.0.538"


@lru_cache(maxsize=1)
def remotion_ffmpeg() -> tuple[Path, Path]:
    project = Path(os.environ.get("MUSIC_REMOTION_PROJECT", "/opt/remotion")).resolve()
    try:
        packages = {}
        for name in ("remotion", "@remotion/cli", "@remotion/renderer"):
            package = project / "node_modules" / name
            manifest = json.loads((package / "package.json").read_text())
            if manifest.get("version") != REMOTION_VERSION:
                raise AssertionError(
                    f"{name}: ожидалась версия {REMOTION_VERSION}, "
                    f"установлена {manifest.get('version')} в {package}"
                )
            packages[name] = (package, manifest)
        package, manifest = packages["@remotion/cli"]
        entry = manifest["bin"]
        if isinstance(entry, dict):
            entry = entry["remotion"]
        cli = package / entry
        if not cli.is_file():
            raise FileNotFoundError(cli)
        return project, cli
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise AssertionError(
            f"Подготовьте проект Remotion {REMOTION_VERSION} и задайте "
            f"MUSIC_REMOTION_PROJECT (сейчас {project}); "
            "команда установки приведена в начале тестового файла. "
            f"Причина: {error}"
        ) from error


def run_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def read_wav(path: Path) -> tuple[int, array.array]:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 2:
            raise AssertionError(f"ожидалось стерео, каналов {handle.getnchannels()}")
        if handle.getframerate() != 44100:
            raise AssertionError(
                f"ожидалось 44100 Гц, получено {handle.getframerate()}"
            )
        if handle.getsampwidth() != 2:
            raise AssertionError(
                f"ожидалось 16 бит, получено {handle.getsampwidth() * 8}"
            )
        frames = handle.getnframes()
        raw = handle.readframes(frames)
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return frames, samples


def dbfs(peak: int) -> float:
    if peak <= 0:
        return -math.inf
    return 20 * math.log10(peak / 32768)


def loudness_lufs(path: Path) -> float:
    project, cli = remotion_ffmpeg()
    completed = subprocess.run(
        [
            "node",
            str(cli),
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-vn",
            "-af",
            "loudnorm=print_format=json",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=False,
        cwd=project,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"Remotion {REMOTION_VERSION} ffmpeg завершился с кодом "
            f"{completed.returncode}: {completed.stderr[-2000:]}"
        )
    found = None
    for match in re.finditer(r"\{[^{}]+\}", completed.stderr):
        if "input_i" in match.group(0):
            found = match.group(0)
    if found is None:
        raise AssertionError(completed.stderr[-800:])
    return float(json.loads(found)["input_i"])


def load_music_module(name: str):
    # Loading by path keeps the deployed standalone scripts out of the root
    # package and avoids needing a Python package/install step for these tests.
    spec = importlib.util.spec_from_file_location(name, SCRIPT.with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def file_digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


class MakeMusicTests(unittest.TestCase):
    def test_parts_are_bounded_and_crossfades_do_not_introduce_gaps_or_overshoot(
        self,
    ) -> None:
        import numpy as np

        music = load_music_module("make_music")
        calls = []

        def constant_part(mood, seconds, bpm, seed, target, *, fades):
            self.assertFalse(fades)
            calls.append((seconds, seed))
            return np.full((round(seconds * music.SR), 2), 0.2), -24.0

        # A small sample rate is enough to check the partition arithmetic;
        # the full-rate integration cases below exercise the actual synthesis.
        with (
            patch.object(music, "SR", 100),
            patch.object(music, "synthesize", side_effect=constant_part),
        ):
            blocks = list(music.long_music_blocks("dramatic", 60100, 60, 4, -24))
            self.assertTrue(all(block.shape[0] <= 100 for block in blocks))
            audio = np.concatenate(blocks)
            self.assertEqual(audio.shape, (60100, 2))
            self.assertTrue(np.allclose(audio[100:-200], 0.2))
            self.assertLessEqual(float(np.max(audio)), 0.2 + 1e-15)
            self.assertEqual(float(np.max(audio[0])), 0.0)
            self.assertEqual(float(np.max(audio[-1])), 0.0)
        self.assertTrue(all(seconds <= 64 for seconds, _seed in calls))
        self.assertEqual(len({seed for _seconds, seed in calls}), len(calls))

    def test_long_tracks_have_exact_duration_real_loudness_and_no_silent_joins(
        self,
    ) -> None:
        import numpy as np

        seconds = 181.375
        for mood, bpm in (("calm", 80), ("upbeat", 125), ("dramatic", 60)):
            with self.subTest(mood=mood), tempfile.TemporaryDirectory() as directory:
                out = Path(directory) / "long"
                completed = run_script(
                    "--mood",
                    mood,
                    "--bpm",
                    str(bpm),
                    "--seconds",
                    str(seconds),
                    "--seed",
                    "7",
                    "--lufs",
                    "-24",
                    "--out",
                    str(out),
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(completed.stderr, "")
                self.assertEqual(len(completed.stdout.splitlines()), 1)
                payload = json.loads(completed.stdout)
                path = out.with_suffix(".wav")
                self.assertEqual(payload["durationMs"], round(seconds * 1000))
                self.assertEqual(payload["bpm"], bpm)
                self.assertEqual(payload["seed"], 7)
                peak = 0
                jump = 0
                previous = None
                with wave.open(str(path), "rb") as handle:
                    self.assertEqual(handle.getparams()[:3], (2, 2, 44100))
                    frames = handle.getnframes()
                    self.assertEqual(frames, round(seconds * 44100))
                    while raw := handle.readframes(44100):
                        pcm = (
                            np.frombuffer(raw, dtype="<i2")
                            .reshape(-1, 2)
                            .astype(np.int32)
                        )
                        peak = max(peak, int(np.max(np.abs(pcm))))
                        jump = max(jump, int(np.max(np.abs(np.diff(pcm, axis=0)))))
                        if previous is not None:
                            jump = max(jump, int(np.max(np.abs(pcm[0] - previous))))
                        previous = pcm[-1].copy()
                    edge = round(0.010 * 44100)
                    for position in (0, frames - edge):
                        handle.setpos(position)
                        pcm = np.frombuffer(
                            handle.readframes(edge), dtype="<i2"
                        ).astype(np.int32)
                        self.assertLess(dbfs(int(np.max(np.abs(pcm)))), -60)
                    bar_frames = round(240 / bpm * 44100)
                    # Phrase starts and overlap ends must not turn into local
                    # fade-to-silence/fade-from-silence boundaries.
                    for start in range(15 * bar_frames, frames, 15 * bar_frames):
                        for position in (
                            start,
                            min(start + bar_frames, frames - 44100),
                        ):
                            handle.setpos(position - 22050)
                            audio = np.frombuffer(
                                handle.readframes(44100), dtype="<i2"
                            ).astype(np.float64)
                            rms = float(np.sqrt(np.mean((audio / 32768) ** 2)))
                            self.assertGreater(20 * math.log10(max(rms, 1e-15)), -55)
                self.assertLessEqual(dbfs(peak), -1)
                self.assertLessEqual(jump, 0.5 * 32768)
                self.assertAlmostEqual(payload["peakDbfs"], dbfs(peak), delta=0.01)
                measured = loudness_lufs(path)
                self.assertAlmostEqual(measured, -24, delta=2)
                self.assertAlmostEqual(payload["integratedLufs"], measured, delta=0.2)
                self.assertEqual(list(Path(directory).glob(".music-*")), [])

    def test_long_seed_is_repeatable_and_lufs_changes_do_not_change_duration(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for index, seed, target in (
                (0, 4, -24),
                (1, 4, -24),
                (2, 5, -24),
                (3, 4, -30),
            ):
                out = Path(directory) / str(index)
                completed = run_script(
                    "--mood",
                    "upbeat",
                    "--seconds",
                    "181.01",
                    "--seed",
                    str(seed),
                    "--lufs",
                    str(target),
                    "--out",
                    str(out),
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                payload = json.loads(completed.stdout)
                self.assertEqual(payload["durationMs"], 181010)
                self.assertAlmostEqual(payload["integratedLufs"], target, delta=0.2)
                paths.append(out.with_suffix(".wav"))
            self.assertEqual(file_digest(paths[0]), file_digest(paths[1]))
            self.assertNotEqual(file_digest(paths[0]), file_digest(paths[2]))
            self.assertNotEqual(file_digest(paths[0]), file_digest(paths[3]))

    def test_long_writer_failure_preserves_destination_and_removes_temporaries(
        self,
    ) -> None:
        music = load_music_module("make_music")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "existing.wav"
            path.write_bytes(b"existing file")
            with patch.object(
                music, "long_music_blocks", side_effect=OSError("disk full")
            ):
                # The standalone import resolves its sibling helper normally;
                # path-loading the module in this test needs the same search path.
                with patch.object(sys, "path", [str(SCRIPT.parent), *sys.path]):
                    with self.assertRaisesRegex(OSError, "disk full"):
                        music.write_long_wav(path, "calm", 181, 80, 1, -24)
            self.assertEqual(path.read_bytes(), b"existing file")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_duration_is_bounded_by_riff_not_three_minutes(self) -> None:
        for duration in ("nan", "inf", "-1", "30000"):
            with (
                self.subTest(duration=duration),
                tempfile.TemporaryDirectory() as directory,
            ):
                completed = run_script(
                    "--mood",
                    "calm",
                    "--seconds",
                    duration,
                    "--out",
                    str(Path(directory) / "bad"),
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(completed.stdout, "")
                self.assertNotIn("Traceback", completed.stderr)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_calm_track_matches_duration_level_and_edges(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "calm"
            completed = run_script(
                "--mood",
                "calm",
                "--seconds",
                "5",
                "--seed",
                "1",
                "--lufs",
                "-24",
                "--out",
                str(out),
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stderr, "")
            payload = json.loads(completed.stdout)
            self.assertEqual(
                list(payload),
                [
                    "audioPath",
                    "durationMs",
                    "bpm",
                    "mood",
                    "seed",
                    "peakDbfs",
                    "integratedLufs",
                ],
            )
            self.assertEqual(payload["audioPath"], str(out.with_suffix(".wav")))
            self.assertEqual(payload["mood"], "calm")
            self.assertEqual(payload["seed"], 1)
            self.assertEqual(payload["bpm"], 80)
            frames, samples = read_wav(out.with_suffix(".wav"))
            self.assertAlmostEqual(frames / 44100 * 1000, 5000, delta=20)
            self.assertEqual(payload["durationMs"], round(frames / 44100 * 1000))
            self.assertLessEqual(dbfs(max(abs(sample) for sample in samples)), -1)
            self.assertAlmostEqual(loudness_lufs(out.with_suffix(".wav")), -24, delta=2)
            edge = int(0.010 * 44100) * 2
            self.assertLess(dbfs(max(abs(sample) for sample in samples[:edge])), -60)
            self.assertLess(dbfs(max(abs(sample) for sample in samples[-edge:])), -60)
            peak_jump = max(
                abs(samples[index] - samples[index - 2])
                for index in range(2, len(samples))
            )
            self.assertLessEqual(peak_jump, 0.5 * 32768)

    def test_seed_repeats_the_file_and_another_seed_changes_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "a"
            second = Path(directory) / "b"
            third = Path(directory) / "c"
            for out, seed in ((first, "4"), (second, "4"), (third, "5")):
                completed = run_script(
                    "--mood",
                    "upbeat",
                    "--seconds",
                    "4",
                    "--seed",
                    seed,
                    "--lufs",
                    "-18",
                    "--out",
                    str(out),
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
            digest = lambda path: hashlib.sha256(
                path.with_suffix(".wav").read_bytes()
            ).hexdigest()
            self.assertEqual(digest(first), digest(second))
            self.assertNotEqual(digest(first), digest(third))
            self.assertAlmostEqual(
                loudness_lufs(first.with_suffix(".wav")), -18, delta=2
            )

    def test_bpm_outside_the_mood_moves_to_the_nearest_edge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            slow = Path(directory) / "slow"
            fast = Path(directory) / "fast"
            dramatic = Path(directory) / "dramatic"
            cases = (
                (slow, "calm", "40", 70),
                (fast, "calm", "200", 90),
                (dramatic, "dramatic", "120", 80),
            )
            for out, mood, bpm, expected in cases:
                completed = run_script(
                    "--mood",
                    mood,
                    "--seconds",
                    "4",
                    "--bpm",
                    bpm,
                    "--seed",
                    "1",
                    "--out",
                    str(out),
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(json.loads(completed.stdout)["bpm"], expected)
                frames, _samples = read_wav(out.with_suffix(".wav"))
                self.assertAlmostEqual(frames / 44100 * 1000, 4000, delta=20)

    def test_upbeat_and_dramatic_are_separate_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            digests = []
            for mood, bpm in (("upbeat", 112), ("dramatic", 70)):
                out = Path(directory) / mood
                completed = run_script(
                    "--mood",
                    mood,
                    "--seconds",
                    "4",
                    "--seed",
                    "2",
                    "--out",
                    str(out),
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                payload = json.loads(completed.stdout)
                self.assertEqual(payload["mood"], mood)
                self.assertEqual(payload["bpm"], bpm)
                frames, samples = read_wav(out.with_suffix(".wav"))
                self.assertAlmostEqual(frames / 44100 * 1000, 4000, delta=20)
                self.assertLessEqual(dbfs(max(abs(sample) for sample in samples)), -1)
                digests.append(
                    hashlib.sha256(out.with_suffix(".wav").read_bytes()).hexdigest()
                )
            self.assertNotEqual(digests[0], digests[1])

    def test_bad_mood_exits_with_a_message(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            completed = run_script(
                "--mood",
                "jazz",
                "--seconds",
                "4",
                "--out",
                str(Path(directory) / "bad"),
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("настроен", completed.stderr.casefold())
            self.assertEqual(completed.stdout, "")


class StreamingLoudnessTests(unittest.TestCase):
    def test_matches_pinned_meter_and_is_independent_of_read_boundaries(self) -> None:
        import numpy as np
        import pyloudnorm

        streaming = load_music_module("streaming_loudness")
        rate = 44100
        rng = np.random.default_rng(24)
        audio = rng.standard_normal((rate * 6, 2)) * 0.02
        # Silence and multiple levels exercise both absolute and relative gates.
        audio[:rate] = 0
        audio[rate : 2 * rate] *= 1e-5
        audio[3 * rate : 4 * rate] *= 0.1
        expected = pyloudnorm.Meter(rate).integrated_loudness(audio)
        for block_size in (997, 4410, 44100, 100003):
            with self.subTest(block_size=block_size):
                blocks = (
                    audio[start : start + block_size]
                    for start in range(0, len(audio), block_size)
                )
                actual = streaming.streaming_lufs(blocks, rate)
                # pyloudnorm's float window indexes can differ by one sample.
                self.assertAlmostEqual(actual, expected, delta=0.001)

    def test_silence_is_an_understandable_error(self) -> None:
        import numpy as np

        streaming = load_music_module("streaming_loudness")
        with self.assertRaisesRegex(ValueError, "тихий или пустой"):
            streaming.streaming_lufs(iter([np.zeros((44100, 2))]), 44100)


if __name__ == "__main__":
    unittest.main()
