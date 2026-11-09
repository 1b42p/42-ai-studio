# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "numpy==2.2.6",
#   "scipy==1.15.3",
#   "pyloudnorm==0.2.0",
# ]
# ///
"""Контракт make_music.py: WAV, громкость, края и seed.

Громкость измеряет системный ffmpeg `loudnorm` — тот же фильтр, что включает
сборка Remotion. В корневом пакете бинарника Remotion нет, pyloudnorm
для проверки не используется.
"""

import array
import hashlib
import json
import math
import re
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "agent/skills/music-synthesis/scripts/make_music.py"
)


def run_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def read_wav(path: Path) -> tuple[int, array.array]:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 2:
            raise AssertionError(f"ожидалось стерео, каналов {handle.getnchannels()}")
        if handle.getframerate() != 44100:
            raise AssertionError(f"ожидалось 44100 Гц, получено {handle.getframerate()}")
        if handle.getsampwidth() != 2:
            raise AssertionError(f"ожидалось 16 бит, получено {handle.getsampwidth() * 8}")
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
    completed = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-af",
            "loudnorm=print_format=json",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    found = None
    for match in re.finditer(r"\{[^{}]+\}", completed.stderr):
        if "input_i" in match.group(0):
            found = match.group(0)
    if found is None:
        raise AssertionError(completed.stderr[-800:])
    return float(json.loads(found)["input_i"])


class MakeMusicTests(unittest.TestCase):
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
                abs(samples[index] - samples[index - 2]) for index in range(2, len(samples))
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
            digest = lambda path: hashlib.sha256(path.with_suffix(".wav").read_bytes()).hexdigest()
            self.assertEqual(digest(first), digest(second))
            self.assertNotEqual(digest(first), digest(third))
            self.assertAlmostEqual(loudness_lufs(first.with_suffix(".wav")), -18, delta=2)

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
                digests.append(hashlib.sha256(out.with_suffix(".wav").read_bytes()).hexdigest())
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


if __name__ == "__main__":
    unittest.main()
