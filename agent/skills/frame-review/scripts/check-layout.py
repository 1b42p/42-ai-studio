#!/usr/bin/env python3
"""Check a composition's declared text boxes and running time before rendering."""

import argparse
import json
import math
import sys
from pathlib import Path


def number(value, name, *, minimum=1):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"{name}: ожидалось конечное число")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name}: ожидалось число ≥ {minimum}")
    return value


def check(layout):
    width = number(layout["width"], "width")
    height = number(layout["height"], "height")
    fps = number(layout["fps"], "fps")
    frames = number(layout["durationInFrames"], "durationInFrames")
    if int(frames) != frames:
        raise ValueError("durationInFrames: нужен целый номер")
    scale = width / 1080
    horizontal = math.ceil(80 * scale)
    vertical = math.ceil(100 * scale)
    titles = {"headline": math.ceil(84 * scale), "body": math.ceil(44 * scale)}
    duration = frames / fps
    errors = []
    if "targetSeconds" in layout:
        target = number(layout["targetSeconds"], "targetSeconds")
        tolerance = number(
            layout.get("toleranceSeconds", 1), "toleranceSeconds", minimum=0
        )
        if abs(duration - target) > tolerance + 1e-9:
            errors.append(
                f"Длительность {duration:.3f} с вне {target:g} ± {tolerance:g} с"
            )

    boxes = layout["text"]
    if not isinstance(boxes, list) or not boxes:
        raise ValueError("text: ожидался непустой список")
    for box in boxes:
        name = box["label"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("label: нужна непустая строка")
        kind = box["kind"]
        if kind not in titles:
            raise ValueError(f"{name}: kind должен быть headline или body")
        size = number(box["fontSize"], f"{name}.fontSize")
        x = number(box["x"], f"{name}.x", minimum=None)
        y = number(box["y"], f"{name}.y", minimum=None)
        right = width - x - number(box["width"], f"{name}.width")
        bottom = height - y - number(box["height"], f"{name}.height")
        if size < titles[kind]:
            errors.append(f"{name}: кегль {size:g} < {titles[kind]} px")
        for side, gap, minimum in (
            ("слева", x, horizontal),
            ("справа", right, horizontal),
            ("сверху", y, vertical),
            ("снизу", bottom, vertical),
        ):
            if gap < minimum:
                errors.append(f"{name}: отступ {side} {gap:g} < {minimum} px")
    return {"durationSeconds": duration, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("layout", type=Path)
    args = parser.parse_args()
    try:
        result = check(json.loads(args.layout.read_text(encoding="utf-8")))
    except (OSError, OverflowError, TypeError, ValueError, KeyError) as error:
        print(f"Некорректные данные: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return int(bool(result["errors"]))


if __name__ == "__main__":
    sys.exit(main())
