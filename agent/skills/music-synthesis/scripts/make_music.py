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
# Один файл до часа: дальше те же seed, --offset и общий --total.
MAX_SECONDS = 3600.0
CHUNK_SECONDS = 15.0
# До этой длины куски собираются в один массив и громкость считает pyloudnorm целиком.
FULL_BUFFER_SECONDS = 120.0
LOOKBACK_SECONDS = 6.0
NOISE_AHEAD_SECONDS = 0.25
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
    offset = 0 if start >= 0 else -start
    if offset >= wave.size:
        return
    length = min(wave.size - offset, buffer.shape[0] - max(start, 0))
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
    place_origin: int = 0,
) -> None:
    n = int(duration_s * SR)
    if n < 2 or freq <= 0:
        return
    place(
        buffer,
        int(start_s * SR) - place_origin,
        shaped(tone(freq, n, partials), attack, release, curve) * amp,
        pan,
    )


def add_kick(buffer: np.ndarray, start_s: float, amp: float, place_origin: int = 0) -> None:
    n = int(0.22 * SR)
    time = np.arange(n, dtype=np.float64) / SR
    frequency = 42.0 + 130.0 * np.exp(-time * 26.0)
    phase = 2.0 * math.pi * np.cumsum(frequency) / SR
    attack = np.minimum(1.0, time / 0.003)
    wave = np.sin(phase) * np.exp(-time * 14.0) * attack
    wave[0] = 0.0
    wave[-1] = 0.0
    place(buffer, int(start_s * SR) - place_origin, wave * amp, 0.0)


def add_noise(
    buffer: np.ndarray,
    noise: np.ndarray,
    start_s: float,
    duration_s: float,
    amp: float,
    pan: float,
    highpass: bool,
    place_origin: int = 0,
    noise_origin: int = 0,
) -> None:
    absolute = int(start_s * SR)
    start = absolute - noise_origin
    n = int(duration_s * SR)
    if n < 2 or start >= noise.size or start < 0:
        return
    n = min(n, noise.size - start)
    if n < 2:
        return
    burst = noise[start : start + n].copy()
    time = np.arange(n, dtype=np.float64) / SR
    burst *= np.exp(-time * (28.0 if highpass else 16.0))
    burst *= np.minimum(1.0, time / 0.002)
    if highpass:
        burst = lfilter([1.0, -1.0], [1.0, -0.2], burst)
    burst[0] = 0.0
    burst[-1] = 0.0
    place(buffer, absolute - place_origin, burst * amp, pan)


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


def event_duration(event: tuple) -> float:
    kind = event[0]
    if kind == "kick":
        return 0.22
    if kind == "snare":
        return 0.12
    return float(event[2])


def render_events(
    events: list[tuple],
    buffer: np.ndarray,
    noise: np.ndarray,
    place_origin: int = 0,
    noise_origin: int = 0,
) -> None:
    window_start = place_origin / SR
    window_end = (place_origin + buffer.shape[0]) / SR
    for event in events:
        kind = event[0]
        start = event[1]
        if start >= window_end or start + event_duration(event) <= window_start:
            continue
        if kind == "pad":
            _kind, _start, duration, triad, amp, low = event
            octave = -5 if low else 0
            pans = (-0.35, 0.0, 0.35)
            for index, note in enumerate(triad):
                freq = midi_hz(note + octave)
                add_tone(buffer, start, duration, freq, amp, pans[index], ((1.0, 0.82), (1.004, 0.18), (2.0, 0.08)), 0.45, 0.7, 0.0, place_origin)
                add_tone(buffer, start, duration, freq * 0.997, amp * 0.45, pans[index] * 0.5, ((1.0, 1.0),), 0.5, 0.7, 0.0, place_origin)
        elif kind == "bass":
            _kind, _start, duration, note, amp = event
            add_tone(buffer, start, duration, midi_hz(note), amp, 0.0, ((1.0, 0.75), (0.5, 0.45), (2.0, 0.08)), 0.03, 0.12, 1.2, place_origin)
        elif kind == "pluck":
            _kind, _start, duration, note, amp = event
            add_tone(buffer, start, duration, midi_hz(note), amp, 0.15 if note % 2 == 0 else -0.15, ((1.0, 0.7), (2.0, 0.25), (3.0, 0.08)), 0.01, 0.08, 3.5, place_origin)
        elif kind == "kick":
            add_kick(buffer, start, event[4], place_origin)
        elif kind == "snare":
            add_noise(buffer, noise, start, 0.12, event[4], 0.05, False, place_origin, noise_origin)
        elif kind == "hat":
            add_noise(buffer, noise, start, event[2], event[4], 0.45 if int(start * 10) % 2 == 0 else -0.45, True, place_origin, noise_origin)


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


def premix_full(mood: str, seconds: float, bpm: int, seed: int) -> np.ndarray:
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
    buffer = np.zeros((n, 2), dtype=np.float64)
    render_events(events, buffer, noise)
    mixed = np.tanh(buffer * 1.15)
    mixed = room(mixed, left, right)
    lowpass_b, lowpass_a = butter(2, 11000 / (SR / 2))
    mixed = lfilter(lowpass_b, lowpass_a, mixed, axis=0)
    apply_fades(mixed)
    return mixed


class _NoiseTape:
    """Шум Generator по порядку, в памяти только окно куска."""

    def __init__(self, rng: np.random.Generator, total: int) -> None:
        self.rng = rng
        self.total = total
        self.generated = 0
        self.origin = 0
        self.samples = np.zeros(0, dtype=np.float64)

    def discard_until(self, index: int) -> None:
        while self.generated < index:
            step = min(int(CHUNK_SECONDS * SR), index - self.generated)
            self.rng.standard_normal(step)
            self.generated += step
        self.origin = self.generated
        self.samples = np.zeros(0, dtype=np.float64)

    def cover(self, start: int, end: int) -> np.ndarray:
        if start < self.origin:
            raise MusicError("Окно шума ушло назад.")
        self._append_until(end)
        return self.samples[start - self.origin : end - self.origin]

    def release_before(self, index: int) -> None:
        drop = min(max(0, index - self.origin), self.samples.size)
        if drop == 0:
            return
        self.samples = self.samples[drop:]
        self.origin += drop

    def finish(self) -> None:
        while self.generated < self.total:
            step = min(int(CHUNK_SECONDS * SR), self.total - self.generated)
            self.rng.standard_normal(step)
            self.generated += step
        self.samples = np.zeros(0, dtype=np.float64)
        self.origin = self.generated

    def _append_until(self, index: int) -> None:
        index = min(index, self.total)
        while self.generated < index:
            step = min(int(CHUNK_SECONDS * SR), index - self.generated)
            drawn = self.rng.standard_normal(step)
            self.samples = np.concatenate((self.samples, drawn))
            self.generated += step


def _piece(mood: str, seed: int) -> tuple[dict, np.random.Generator, int, tuple[int, ...]]:
    spec = MOODS[mood]
    rng = np.random.default_rng(seed)
    root = int(rng.choice(np.asarray(spec["roots"], dtype=np.int64)))
    progression = spec["progressions"][int(rng.integers(0, len(spec["progressions"])))]
    return spec, rng, root, progression


def _impulses(mood: str, seed: int, total_n: int) -> tuple[np.ndarray, np.ndarray]:
    _spec, rng, _root, _progression = _piece(mood, seed)
    _NoiseTape(rng, total_n).finish()
    impulse_n = int(0.45 * SR)
    left = rng.standard_normal(impulse_n)
    right = rng.standard_normal(impulse_n)
    decay = np.exp(-np.linspace(0.0, 6.5, left.size))
    shaped = []
    for impulse in (left, right):
        filtered = lfilter([0.12], [1.0, -0.88], impulse * decay)
        peak = float(np.max(np.abs(filtered)))
        if peak > 0:
            filtered = filtered / peak
        shaped.append(np.ascontiguousarray(filtered * 0.25))
    return shaped[0], shaped[1]


def _fade_slice(buffer: np.ndarray, origin: int, total_n: int) -> None:
    count = buffer.shape[0]
    duration = total_n / SR
    fade_in = min(1.0, duration / 3.0)
    fade_out = min(2.0, duration * 2.0 / 3.0)
    if fade_in + fade_out > duration:
        scale = duration / (fade_in + fade_out)
        fade_in *= scale
        fade_out *= scale
    fade_in_n = int(round(fade_in * SR))
    fade_out_n = int(round(fade_out * SR))
    index = np.arange(origin, origin + count)
    gain = np.ones(count, dtype=np.float64)
    if fade_in_n > 0:
        inside = index < fade_in_n
        ramp = np.linspace(0.0, 1.0, fade_in_n, endpoint=False) ** 3
        gain[inside] *= ramp[index[inside]]
    if fade_out_n > 0:
        start = total_n - fade_out_n
        inside = index >= start
        ramp = np.linspace(1.0, 0.0, fade_out_n, endpoint=True) ** 3
        gain[inside] *= ramp[index[inside] - start]
    gain[index == 0] = 0.0
    if total_n > 0:
        gain[index == total_n - 1] = 0.0
    buffer *= gain[:, None]


def iter_premix(
    mood: str,
    seconds: float,
    bpm: int,
    seed: int,
    offset: float,
    total: float,
):
    """Куски готового сигнала до нормализации. Память — один кусок и хвост реверберации."""
    total_n = sample_count(total)
    origin = sample_count(offset)
    count = sample_count(seconds)
    spec, rng, root, progression = _piece(mood, seed)
    impulses = _impulses(mood, seed, total_n)
    events = schedule(spec["style"], bpm, total, root, spec["scale"], progression)
    tape = _NoiseTape(rng, total_n)
    lookback = int(LOOKBACK_SECONDS * SR)
    ahead = int(NOISE_AHEAD_SECONDS * SR)
    low_b, low_a = butter(2, 11000 / (SR / 2))
    dc_b = np.array([1.0, -1.0])
    dc_a = np.array([1.0, -0.995])
    dc_zi = [np.zeros(1, dtype=np.float64), np.zeros(1, dtype=np.float64)]
    low_zi = [np.zeros(2, dtype=np.float64), np.zeros(2, dtype=np.float64)]
    carry = [np.zeros(0, dtype=np.float64), np.zeros(0, dtype=np.float64)]
    # Хвост реверберации около 0,45 с; секунда прогрева гасит и состояние фильтров.
    warmup = SR
    begin = max(0, origin - warmup)
    end = origin + count
    if begin > lookback:
        tape.discard_until(begin - lookback)
    rendered_at = begin
    while rendered_at < end:
        step = min(int(CHUNK_SECONDS * SR), end - rendered_at)
        noise_start = max(0, rendered_at - lookback)
        noise_end = min(total_n, rendered_at + step + ahead)
        noise = tape.cover(noise_start, noise_end)
        dry = np.zeros((step, 2), dtype=np.float64)
        render_events(events, dry, noise, rendered_at, noise_start)
        dry = np.tanh(dry * 1.15)
        mixed = np.empty_like(dry)
        next_carry = []
        for channel, impulse in enumerate(impulses):
            full = fftconvolve(dry[:, channel], impulse, mode="full")
            overlap = carry[channel]
            if overlap.size:
                full[: overlap.size] += overlap
            mixed[:, channel] = dry[:, channel] * 0.82 + full[:step] * 0.22
            next_carry.append(full[step:])
        carry = next_carry
        blocked = np.empty_like(mixed)
        for channel in range(2):
            blocked[:, channel], dc_zi[channel] = lfilter(dc_b, dc_a, mixed[:, channel], zi=dc_zi[channel])
        filtered = np.empty_like(blocked)
        for channel in range(2):
            filtered[:, channel], low_zi[channel] = lfilter(low_b, low_a, blocked[:, channel], zi=low_zi[channel])
        _fade_slice(filtered, rendered_at, total_n)
        skip = max(0, origin - rendered_at)
        if skip < step:
            yield filtered[skip:]
        rendered_at += step
        tape.release_before(max(0, rendered_at - lookback))


def premix_chunked(mood: str, seconds: float, bpm: int, seed: int, offset: float, total: float) -> np.ndarray:
    parts = list(iter_premix(mood, seconds, bpm, seed, offset, total))
    if not parts:
        return np.zeros((0, 2), dtype=np.float64)
    return np.concatenate(parts, axis=0)


class _BlockLoudness:
    """Та же интегральная громкость, что pyloudnorm, без копии всей дорожки."""

    def __init__(self) -> None:
        import pyloudnorm

        meter = pyloudnorm.Meter(SR)
        shelf = meter._filters["high_shelf"]
        highpass = meter._filters["high_pass"]
        self.shelf_b = np.asarray(shelf.b, dtype=np.float64)
        self.shelf_a = np.asarray(shelf.a, dtype=np.float64)
        self.high_b = np.asarray(highpass.b, dtype=np.float64)
        self.high_a = np.asarray(highpass.a, dtype=np.float64)
        self.shelf_zi = [np.zeros(2), np.zeros(2)]
        self.high_zi = [np.zeros(2), np.zeros(2)]
        self.origin = 0
        self.filtered = np.zeros((0, 2), dtype=np.float64)
        self.block = 0
        self.energy: list[tuple[float, float]] = []

    def push(self, audio: np.ndarray) -> None:
        filtered = np.empty_like(audio)
        for channel in range(2):
            shelved, self.shelf_zi[channel] = lfilter(
                self.shelf_b, self.shelf_a, audio[:, channel], zi=self.shelf_zi[channel]
            )
            filtered[:, channel], self.high_zi[channel] = lfilter(
                self.high_b, self.high_a, shelved, zi=self.high_zi[channel]
            )
        self.filtered = np.concatenate((self.filtered, filtered))
        self._emit(self.origin + self.filtered.shape[0])

    def _bounds(self, index: int) -> tuple[int, int]:
        lower = int(0.4 * (index * 0.25) * SR)
        upper = int(0.4 * (index * 0.25 + 1) * SR)
        return lower, upper

    def _emit(self, available: int) -> None:
        scale = 1.0 / (0.4 * SR)
        while True:
            lower, upper = self._bounds(self.block)
            if upper > available:
                return
            window = self.filtered[lower - self.origin : upper - self.origin]
            self.energy.append(
                (scale * float(np.sum(window[:, 0] ** 2)), scale * float(np.sum(window[:, 1] ** 2)))
            )
            self.block += 1
            next_lower, _next_upper = self._bounds(self.block)
            drop = next_lower - self.origin
            if drop > 0:
                drop = min(drop, self.filtered.shape[0])
                self.filtered = self.filtered[drop:]
                self.origin += drop

    def lufs(self, total_samples: int) -> float:
        duration = total_samples / SR
        blocks = int(np.round(((duration - 0.4) / 0.1)) + 1)
        self._emit(self.origin + self.filtered.shape[0])
        energy = self.energy[:blocks]
        if not energy:
            raise MusicError("Не удалось измерить громкость трека.")
        absolute = -70.0
        loud = []
        for left, right in energy:
            power = left + right
            loud.append(-math.inf if power <= 0 else -0.691 + 10.0 * math.log10(power))
        gated = [index for index, level in enumerate(loud) if level >= absolute]
        if not gated:
            raise MusicError("Не удалось измерить громкость трека.")
        averages = [
            float(np.mean([energy[index][channel] for index in gated]))
            for channel in range(2)
        ]
        relative = -0.691 + 10.0 * math.log10(sum(averages)) - 10.0
        gated = [index for index, level in enumerate(loud) if level > relative and level > absolute]
        if not gated:
            raise MusicError("Не удалось измерить громкость трека.")
        averages = [
            float(np.mean([energy[index][channel] for index in gated]))
            for channel in range(2)
        ]
        power = sum(averages)
        if power <= 0:
            raise MusicError("Не удалось измерить громкость трека.")
        return -0.691 + 10.0 * math.log10(power)


def _gain(loudness: float, peak: float, target: float) -> float:
    gain = 10.0 ** ((target - loudness) / 20.0)
    if peak * gain > PEAK_CEILING:
        gain *= PEAK_CEILING / (peak * gain)
    return gain


def synthesize(
    mood: str,
    seconds: float,
    bpm: int,
    seed: int,
    target_lufs: float,
    offset: float = 0.0,
    total: float | None = None,
) -> tuple[np.ndarray, float]:
    span = seconds if total is None else total
    fits = offset == 0.0 and span == seconds and seconds <= FULL_BUFFER_SECONDS
    if fits:
        return normalize(premix_full(mood, seconds, bpm, seed), target_lufs)
    audio = premix_chunked(mood, seconds, bpm, seed, offset, span)
    return normalize(audio, target_lufs)


def synthesize_streaming(
    mood: str,
    seconds: float,
    bpm: int,
    seed: int,
    target_lufs: float,
    offset: float,
    total: float,
    path: Path,
) -> tuple[int, float]:
    """Длинная дорожка: два прохода по кускам, на диске только готовый WAV."""
    meter = _BlockLoudness()
    peak = 0.0
    count = 0
    for chunk in iter_premix(mood, seconds, bpm, seed, offset, total):
        meter.push(chunk)
        peak = max(peak, float(np.max(np.abs(chunk))))
        count += chunk.shape[0]
    loudness = meter.lufs(count)
    gain = _gain(loudness, peak, target_lufs)
    path.parent.mkdir(parents=True, exist_ok=True)
    measured = _BlockLoudness()
    peak_pcm = 0
    import wave

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        for chunk in iter_premix(mood, seconds, bpm, seed, offset, total):
            gained = chunk * gain
            measured.push(gained)
            pcm = np.clip(np.round(gained * 32767.0), -32768, 32767).astype("<i2")
            if pcm.size:
                peak_pcm = max(peak_pcm, int(np.max(np.abs(pcm))))
            handle.writeframes(pcm.tobytes())
    return peak_pcm, measured.lufs(count)


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
    parser.add_argument("--offset", type=float, default=0.0)
    parser.add_argument("--total", type=float)
    parser.add_argument("--out", required=True)
    return parser


def validate(args: argparse.Namespace) -> tuple[str, float, int, int, float, float, float, Path]:
    mood = str(args.mood)
    if mood not in MOODS:
        names = ", ".join(MOODS)
        raise MusicError(f"Неизвестное настроение «{mood}». Доступны: {names}.")
    if not math.isfinite(args.seconds) or args.seconds < MIN_SECONDS or args.seconds > MAX_SECONDS:
        raise MusicError(
            f"Длительность одного файла — от {MIN_SECONDS:g} до {MAX_SECONDS:g} с. "
            "Длиннее часа соберите частями: тот же seed, --offset и общий --total."
        )
    offset = float(args.offset)
    total = float(args.seconds) + offset if args.total is None else float(args.total)
    if not math.isfinite(offset) or offset < 0 or not math.isfinite(total) or total < offset + float(args.seconds) or total > MAX_SECONDS:
        raise MusicError("Окно --offset и --total должно лежать внутри одного часа и покрывать --seconds.")
    if args.bpm is not None and not math.isfinite(args.bpm):
        raise MusicError("Темп --bpm должен быть числом.")
    if not math.isfinite(args.lufs) or args.lufs < -40 or args.lufs > -8:
        raise MusicError("Целевая громкость --lufs должна быть от -40 до -8.")
    if args.seed < 0 or args.seed > 2**31 - 1:
        raise MusicError("Seed должен быть целым от 0 до 2147483647.")
    out = Path(args.out)
    if out.suffix:
        raise MusicError("Путь --out указывают без расширения: файл будет <путь>.wav.")
    return (
        mood,
        float(args.seconds),
        clamp_bpm(mood, args.bpm),
        int(args.seed),
        float(args.lufs),
        offset,
        total,
        Path(os.path.abspath(f"{args.out}.wav")),
    )


def main(argv: list[str]) -> int:
    try:
        args = build_parser().parse_args(argv)
        mood, seconds, bpm, seed, target, offset, total, path = validate(args)
        fits = offset == 0.0 and total == seconds and seconds <= FULL_BUFFER_SECONDS
        if fits:
            audio, loudness = synthesize(mood, seconds, bpm, seed, target, offset, total)
            pcm = write_wav(path, audio)
            frames = int(pcm.shape[0])
            peak = int(np.max(np.abs(pcm))) if pcm.size else 0
        else:
            peak, loudness = synthesize_streaming(mood, seconds, bpm, seed, target, offset, total, path)
            frames = sample_count(seconds)
        payload = {
            "audioPath": str(path),
            "durationMs": round(frames / SR * 1000),
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
