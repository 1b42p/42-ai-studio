"""Bounded-memory stereo BS.1770 measurement using pyloudnorm's K filters.

Filter definitions and gates follow pyloudnorm 0.2.0:
https://github.com/csteinmetz1/pyloudnorm/blob/v0.2.0/pyloudnorm/meter.py
https://github.com/csteinmetz1/pyloudnorm/blob/v0.2.0/pyloudnorm/iirfilter.py

Unlike Meter.integrated_loudness(), this never copies the entire recording.
Only complete 400 ms windows are measured, at 100 ms intervals; an incomplete
trailing window is discarded. Energy records live on disk, not in a growing
Python list. Stereo channel weights are both 1.0.
"""

from __future__ import annotations

import math
import struct
import tempfile
from collections import deque
from collections.abc import Iterable
from pathlib import Path
from typing import BinaryIO

import numpy as np
from pyloudnorm import IIRfilter
from scipy.signal import lfilter


def _gated_mean(energies: BinaryIO, threshold: float, *, inclusive: bool) -> float:
    energies.seek(0)
    total = 0.0
    count = 0
    while raw := energies.read(8192 * 8):
        values = np.frombuffer(raw, dtype="<f8")
        kept = values[values >= threshold if inclusive else values > threshold]
        total += float(np.sum(kept))
        count += kept.size
    if count == 0:
        raise ValueError("Не удалось измерить громкость: трек тихий или пустой.")
    return total / count


def streaming_lufs(
    blocks: Iterable[np.ndarray], rate: int, *, directory: Path | None = None
) -> float:
    """Measure float stereo blocks in [-1, 1], preserving IIR state across reads.

    Public IIRfilter.b/a generate the same coefficients as Meter's default
    K-weighting. Using two biquads avoids relying on Meter._filters. The integer
    100 ms hop is exact at the music format's 44100 Hz sample rate.
    """
    if rate <= 0 or rate % 10:
        raise ValueError("Частота измерителя должна быть кратна 10 Гц.")
    hop = rate // 10
    stages = (
        IIRfilter(4.0, 1 / math.sqrt(2), 1500.0, rate, "high_shelf"),
        IIRfilter(0.0, 0.5, 38.0, rate, "high_pass"),
    )
    coefficients = [(stage.b, stage.a) for stage in stages]
    states = [np.zeros((2, 2), dtype=np.float64) for _ in stages]
    recent: deque[float] = deque(maxlen=4)
    pending_energy = 0.0
    pending_frames = 0
    with tempfile.TemporaryFile(dir=directory) as energies:
        for source in blocks:
            if source.ndim != 2 or source.shape[1] != 2:
                raise ValueError("Измеритель ожидает стереоаудио.")
            # Also bound working memory if a caller passes one large array.
            for offset in range(0, source.shape[0], rate):
                audio = np.asarray(source[offset : offset + rate], dtype=np.float64)
                if not np.isfinite(audio).all():
                    raise ValueError("В аудио найдены нечисловые значения.")
                for index, (b, a) in enumerate(coefficients):
                    audio, states[index] = lfilter(
                        b, a, audio, axis=0, zi=states[index]
                    )
                begin = 0
                while begin < audio.shape[0]:
                    count = min(hop - pending_frames, audio.shape[0] - begin)
                    piece = audio[begin : begin + count]
                    pending_energy += float(np.sum(piece * piece))
                    pending_frames += count
                    begin += count
                    if pending_frames == hop:
                        recent.append(pending_energy)
                        pending_frames = 0
                        pending_energy = 0.0
                        if len(recent) == 4:
                            energies.write(struct.pack("<d", sum(recent) / (4 * hop)))
        # Equations 5--7: absolute gate -70 LUFS, relative gate 10 LU below
        # the absolute-gated mean. Work in energy, not averages of decibels.
        absolute = 10.0 ** ((-70.0 + 0.691) / 10.0)
        relative = 0.1 * _gated_mean(energies, absolute, inclusive=True)
        mean = _gated_mean(energies, max(absolute, relative), inclusive=False)
        return -0.691 + 10.0 * math.log10(mean)
