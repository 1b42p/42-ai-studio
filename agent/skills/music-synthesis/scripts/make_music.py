#!/usr/bin/env python3
# Зависимости (колеса PyPI, без sudo):
# pip install "numpy==2.2.6" "scipy==1.15.3" "pyloudnorm==0.2.0"
"""Синтез стереофона WAV: numpy, scipy и нормализация pyloudnorm."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import warnings
from pathlib import Path


def limit_threads() -> None:
    """Потоки библиотек — квота sandbox-vcpu, локально один."""
    count = "1"
    try:
        completed = subprocess.run(
            ["sandbox-vcpu"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
        value = int(completed.stdout.strip())
        if value >= 1:
            count = str(value)
    except (OSError, subprocess.SubprocessError, ValueError):
        count = "1"
    for name in (
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "BLIS_NUM_THREADS",
    ):
        os.environ[name] = count
    os.environ["OMP_WAIT_POLICY"] = "PASSIVE"


limit_threads()

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, lfilter

warnings.filterwarnings("ignore", category=UserWarning)

SR = 44100
PEAK_CEILING = 10 ** (-1.05 / 20)
MIN_SECONDS = 1.0
MAX_SECONDS = 180.0
MAJOR = (0, 2, 4, 5, 7, 9, 11)
MINOR = (0, 2, 3, 5, 7, 8, 10)

MOODS = {
    "calm": {
        "bpm": (70, 90),
        "default_bpm": 80,
        "scale": MAJOR,
        "roots": (48, 50, 53, 55, 57),
        "progressions": ((0, 5, 3, 4), (0, 3, 4, 5)),
        "style": "calm",
    },
    "upbeat": {
        "bpm": (100, 125),
        "default_bpm": 112,
        "scale": MAJOR,
        "roots": (50, 53, 55, 57, 60),
        "progressions": ((0, 4, 5, 3), (5, 3, 0, 4)),
        "style": "upbeat",
    },
    "dramatic": {
        "bpm": (60, 80),
        "default_bpm": 70,
        "scale": MINOR,
        "roots": (41, 43, 45, 46, 48),
        "progressions": ((0, 5, 3, 6), (0, 3, 5, 4)),
        "style": "dramatic",
    },
}


class MusicError(Exception):
    """Ошибка параметров или синтеза, которую видит вызывающий."""


def midi_hz(note: float) -> float:
    return 440.0 * 2.0 ** ((note - 69.0) / 12.0)


def degree_midi(root: int, scale: tuple[int, ...], degree: int, octave: int) -> int:
    return root + scale[degree % 7] + 12 * (degree // 7) + 12 * octave


def clamp_bpm(mood: str, bpm: float | None) -> int:
    low, high = MOODS[mood]["bpm"]
    chosen = MOODS[mood]["default_bpm"] if bpm is None else int(round(bpm))
    return max(low, min(high, chosen))


def sample_count(seconds: float) -> int:
    return int(round(seconds * SR))


def place(buffer: np.ndarray, start: int, wave: np.ndarray, pan: float) -> None:
    if wave.size == 0 or start >= buffer.shape[0]:
        return
    length = min(wave.size, buffer.shape[0] - max(start, 0))
    offset = 0 if start >= 0 else -start
    if length <= 0:
        return
    left = math.sqrt(0.5 * (1.0 - pan))
    right = math.sqrt(0.5 * (1.0 + pan))
    chunk = wave[offset : offset + length]
    begin = max(start, 0)
    buffer[begin : begin + length, 0] += chunk * left
    buffer[begin : begin + length, 1] += chunk * right


def tone(freq: float, n: int, partials: tuple[tuple[float, float], ...]) -> np.ndarray:
    if n <= 0:
        return np.zeros(0, dtype=np.float64)
    time = np.arange(n, dtype=np.float64) / SR
    wave = np.zeros(n, dtype=np.float64)
    for ratio, amp in partials:
        wave += amp * np.sin(2.0 * math.pi * freq * ratio * time)
    return wave


def shaped(wave: np.ndarray, attack: float, release: float, curve: float) -> np.ndarray:
    n = wave.size
    if n == 0:
        return wave
    envelope = np.ones(n, dtype=np.float64)
    attack_n = min(n, max(1, int(attack * SR)))
    release_n = min(n, max(1, int(release * SR)))
    envelope[:attack_n] *= np.linspace(0.0, 1.0, attack_n, endpoint=False) ** 2
    if release_n > 0:
        envelope[-release_n:] *= np.linspace(1.0, 0.0, release_n, endpoint=True) ** 2
    if curve > 0:
        envelope *= np.exp(-np.linspace(0.0, curve, n))
    envelope[0] = 0.0
    envelope[-1] = 0.0
    return wave * envelope


def add_tone(
    buffer: np.ndarray,
    start_s: float,
    duration_s: float,
    freq: float,
    amp: float,
    pan: float,
    partials: tuple[tuple[float, float], ...],
    attack: float,
    release: float,
    curve: float,
) -> None:
    n = int(duration_s * SR)
    if n < 2 or freq <= 0:
        return
    place(
        buffer,
        int(start_s * SR),
        shaped(tone(freq, n, partials), attack, release, curve) * amp,
        pan,
    )


def add_kick(buffer: np.ndarray, start_s: float, amp: float) -> None:
    n = int(0.22 * SR)
    time = np.arange(n, dtype=np.float64) / SR
    frequency = 42.0 + 130.0 * np.exp(-time * 26.0)
    phase = 2.0 * math.pi * np.cumsum(frequency) / SR
    attack = np.minimum(1.0, time / 0.003)
    wave = np.sin(phase) * np.exp(-time * 14.0) * attack
    wave[0] = 0.0
    wave[-1] = 0.0
    place(buffer, int(start_s * SR), wave * amp, 0.0)


def add_noise(
    buffer: np.ndarray,
    noise: np.ndarray,
    start_s: float,
    duration_s: float,
    amp: float,
    pan: float,
    highpass: bool,
) -> None:
    start = int(start_s * SR)
    n = int(duration_s * SR)
    if n < 2 or start >= noise.size:
        return
    n = min(n, noise.size - max(start, 0))
    if n < 2:
        return
    burst = noise[max(start, 0) : max(start, 0) + n].copy()
    time = np.arange(n, dtype=np.float64) / SR
    burst *= np.exp(-time * (28.0 if highpass else 16.0))
    burst *= np.minimum(1.0, time / 0.002)
    if highpass:
        burst = lfilter([1.0, -1.0], [1.0, -0.2], burst)
    burst[0] = 0.0
    burst[-1] = 0.0
    place(buffer, start, burst * amp, pan)


def schedule(style: str, bpm: int, seconds: float, root: int, scale: tuple[int, ...], progression: tuple[int, ...]) -> list[tuple]:
    beat = 60.0 / bpm
    bar = beat * 4.0
    events: list[tuple] = []
    bar_index = 0
    start = 0.0
    while start < seconds:
        degree = progression[bar_index % len(progression)]
        triad = tuple(degree_midi(root, scale, degree + step, 0) for step in (0, 2, 4))
        if style == "dramatic":
            events.append(("pad", start, bar + beat, triad, 0.16, True))
            events.append(("bass", start, bar * 0.92, triad[0] - 12, 0.34))
            events.append(("kick", start, 0.0, 0, 0.55))
            if bar_index % 2 == 1:
                events.append(("pluck", start + beat * 2, beat * 1.5, triad[2] - 12, 0.12))
            events.append(("hat", start + beat * 2, 0.05, 0, 0.04))
        elif style == "upbeat":
            events.append(("pad", start, bar + beat * 0.5, triad, 0.11, False))
            for step in range(4):
                when = start + beat * step
                events.append(("bass", when, beat * 0.92, triad[0] - 12 + (12 if step == 2 else 0), 0.28))
                events.append(("kick" if step % 2 == 0 else "snare", when, 0.0, 0, 0.62 if step % 2 == 0 else 0.18))
            for step in range(8):
                when = start + beat * 0.5 * step
                events.append(("pluck", when, beat * 0.45, triad[step % 3] + 12, 0.11))
                events.append(("hat", when, 0.045, 0, 0.055 if step % 2 == 0 else 0.035))
        else:
            events.append(("pad", start, bar + beat, triad, 0.18, False))
            events.append(("bass", start, beat * 3.2, triad[0] - 12, 0.26))
            events.append(("bass", start + beat * 2.5, beat * 1.4, triad[2] - 12, 0.16))
            events.append(("kick", start, 0.0, 0, 0.28))
            for step in range(4):
                when = start + beat * step
                events.append(("pluck", when, beat * 0.9, triad[step % 3] + 12, 0.08))
                events.append(("hat", when, 0.06, 0, 0.03))
        bar_index += 1
        start += bar
    return events


def render_events(events: list[tuple], n: int, noise: np.ndarray) -> np.ndarray:
    buffer = np.zeros((n, 2), dtype=np.float64)
    for event in events:
        kind = event[0]
        start = event[1]
        if start >= n / SR:
            continue
        if kind == "pad":
            _kind, _start, duration, triad, amp, low = event
            octave = -5 if low else 0
            pans = (-0.35, 0.0, 0.35)
            for index, note in enumerate(triad):
                freq = midi_hz(note + octave)
                add_tone(buffer, start, duration, freq, amp, pans[index], ((1.0, 0.82), (1.004, 0.18), (2.0, 0.08)), 0.45, 0.7, 0.0)
                add_tone(buffer, start, duration, freq * 0.997, amp * 0.45, pans[index] * 0.5, ((1.0, 1.0),), 0.5, 0.7, 0.0)
        elif kind == "bass":
            _kind, _start, duration, note, amp = event
            add_tone(buffer, start, duration, midi_hz(note), amp, 0.0, ((1.0, 0.75), (0.5, 0.45), (2.0, 0.08)), 0.03, 0.12, 1.2)
        elif kind == "pluck":
            _kind, _start, duration, note, amp = event
            add_tone(buffer, start, duration, midi_hz(note), amp, 0.15 if note % 2 == 0 else -0.15, ((1.0, 0.7), (2.0, 0.25), (3.0, 0.08)), 0.01, 0.08, 3.5)
        elif kind == "kick":
            add_kick(buffer, start, event[4])
        elif kind == "snare":
            add_noise(buffer, noise, start, 0.12, event[4], 0.05, False)
        elif kind == "hat":
            add_noise(buffer, noise, start, event[2], event[4], 0.45 if int(start * 10) % 2 == 0 else -0.45, True)
    return buffer


def room(buffer: np.ndarray, left: np.ndarray, right: np.ndarray) -> np.ndarray:
    decay = np.exp(-np.linspace(0.0, 6.5, left.size))
    wet = np.empty_like(buffer)
    for channel, impulse in ((0, left), (1, right)):
        shaped_impulse = lfilter([0.12], [1.0, -0.88], impulse * decay)
        peak = np.max(np.abs(shaped_impulse))
        if peak > 0:
            shaped_impulse /= peak
        wet[:, channel] = fftconvolve(buffer[:, channel], shaped_impulse * 0.25, mode="full")[: buffer.shape[0]]
    mixed = buffer * 0.82 + wet * 0.22
    # Однополюсный DC-blocker: на выходе остаётся сигнал без постоянной составляющей.
    return lfilter([1.0, -1.0], [1.0, -0.995], mixed, axis=0)


def apply_fades(buffer: np.ndarray) -> None:
    n = buffer.shape[0]
    duration = n / SR
    fade_in = min(1.0, duration / 3.0)
    fade_out = min(2.0, duration * 2.0 / 3.0)
    if fade_in + fade_out > duration:
        scale = duration / (fade_in + fade_out)
        fade_in *= scale
        fade_out *= scale
    gain = np.ones(n, dtype=np.float64)
    fade_in_n = int(round(fade_in * SR))
    fade_out_n = int(round(fade_out * SR))
    if fade_in_n > 0:
        gain[:fade_in_n] *= np.linspace(0.0, 1.0, fade_in_n, endpoint=False) ** 3
    if fade_out_n > 0:
        gain[-fade_out_n:] *= np.linspace(1.0, 0.0, fade_out_n, endpoint=True) ** 3
    gain[0] = 0.0
    gain[-1] = 0.0
    buffer *= gain[:, None]


def measured_lufs(audio: np.ndarray) -> float:
    import pyloudnorm

    meter = pyloudnorm.Meter(SR)
    loudness = float(meter.integrated_loudness(np.asarray(audio, dtype=np.float64)))
    if not math.isfinite(loudness):
        raise MusicError("Не удалось измерить громкость трека.")
    return loudness


def normalize(audio: np.ndarray, target: float) -> tuple[np.ndarray, float]:
    loudness = measured_lufs(audio)
    gained = audio * (10.0 ** ((target - loudness) / 20.0))
    peak = float(np.max(np.abs(gained)))
    if peak > PEAK_CEILING:
        gained *= PEAK_CEILING / peak
    return gained, measured_lufs(gained)


def synthesize(mood: str, seconds: float, bpm: int, seed: int, target_lufs: float) -> tuple[np.ndarray, float]:
    spec = MOODS[mood]
    rng = np.random.default_rng(seed)
    root = int(rng.choice(np.asarray(spec["roots"], dtype=np.int64)))
    progression = spec["progressions"][int(rng.integers(0, len(spec["progressions"])))]
    n = sample_count(seconds)
    noise = rng.standard_normal(n)
    impulse_n = int(0.45 * SR)
    left = rng.standard_normal(impulse_n)
    right = rng.standard_normal(impulse_n)
    events = schedule(spec["style"], bpm, seconds, root, spec["scale"], progression)
    mixed = render_events(events, n, noise)
    mixed = np.tanh(mixed * 1.15)
    mixed = room(mixed, left, right)
    lowpass_b, lowpass_a = butter(2, 11000 / (SR / 2))
    mixed = lfilter(lowpass_b, lowpass_a, mixed, axis=0)
    apply_fades(mixed)
    return normalize(mixed, target_lufs)


def write_wav(path: Path, audio: np.ndarray) -> np.ndarray:
    pcm = np.clip(np.round(audio * 32767.0), -32768, 32767).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(path, SR, pcm)
    return pcm


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Синтез фоновой музыки в WAV.")
    parser.add_argument("--mood", required=True)
    parser.add_argument("--seconds", required=True, type=float)
    parser.add_argument("--bpm", type=float)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--lufs", type=float, default=-18.0)
    parser.add_argument("--out", required=True)
    return parser


def validate(args: argparse.Namespace) -> tuple[str, float, int, int, float, Path]:
    mood = str(args.mood)
    if mood not in MOODS:
        names = ", ".join(MOODS)
        raise MusicError(f"Неизвестное настроение «{mood}». Доступны: {names}.")
    if not math.isfinite(args.seconds) or args.seconds < MIN_SECONDS or args.seconds > MAX_SECONDS:
        raise MusicError(f"Длительность должна быть от {MIN_SECONDS:g} до {MAX_SECONDS:g} секунд.")
    if args.bpm is not None and not math.isfinite(args.bpm):
        raise MusicError("Темп --bpm должен быть числом.")
    if not math.isfinite(args.lufs) or args.lufs < -40 or args.lufs > -8:
        raise MusicError("Целевая громкость --lufs должна быть от -40 до -8.")
    if args.seed < 0 or args.seed > 2**31 - 1:
        raise MusicError("Seed должен быть целым от 0 до 2147483647.")
    out = Path(args.out)
    if out.suffix:
        raise MusicError("Путь --out указывают без расширения: файл будет <путь>.wav.")
    return mood, float(args.seconds), clamp_bpm(mood, args.bpm), int(args.seed), float(args.lufs), Path(os.path.abspath(f"{args.out}.wav"))


def main(argv: list[str]) -> int:
    try:
        args = build_parser().parse_args(argv)
        mood, seconds, bpm, seed, target, path = validate(args)
        audio, loudness = synthesize(mood, seconds, bpm, seed, target)
        pcm = write_wav(path, audio)
        peak = int(np.max(np.abs(pcm))) if pcm.size else 0
        payload = {
            "audioPath": str(path),
            "durationMs": round(pcm.shape[0] / SR * 1000),
            "bpm": bpm,
            "mood": mood,
            "seed": seed,
            "peakDbfs": round(-math.inf if peak == 0 else 20.0 * math.log10(peak / 32768.0), 2),
            "integratedLufs": round(loudness, 2),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
        return 0
    except MusicError as error:
        sys.stderr.write(f"{error}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
