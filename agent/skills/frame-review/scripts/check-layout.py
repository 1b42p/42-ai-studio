#!/usr/bin/env python3
"""Check a composition's declared text boxes and running time before rendering."""

import argparse
import json
import math
import sys
from itertools import combinations
from pathlib import Path


def number(value, name, *, minimum=1):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"{name}: ожидалось конечное число")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name}: ожидалось число ≥ {minimum}")
    return value


def rectangle(box):
    name = box["label"]
    if not isinstance(name, str) or not name.strip():
        raise ValueError("label: нужна непустая строка")
    group = box.get("group", "")
    if not isinstance(group, str):
        raise ValueError(f"{name}: group должен быть строкой")
    x = number(box["x"], f"{name}.x", minimum=None)
    y = number(box["y"], f"{name}.y", minimum=None)
    right = x + number(box["width"], f"{name}.width")
    bottom = y + number(box["height"], f"{name}.height")
    return name, group, x, y, right, bottom


def overlap(first, second):
    _, a_group, ax, ay, ar, ab = first
    _, b_group, bx, by, br, bb = second
    return (
        a_group == b_group and max(ax, bx) < min(ar, br) and max(ay, by) < min(ab, bb)
    )


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
    protected = layout.get("protected", [])
    if not isinstance(protected, list):
        raise ValueError("protected: ожидался список")
    text_rects = []
    for box in boxes:
        rect = rectangle(box)
        text_rects.append(rect)
        name, _, x, y, right, bottom = rect
        kind = box["kind"]
        if kind not in titles:
            raise ValueError(f"{name}: kind должен быть headline или body")
        size = number(box["fontSize"], f"{name}.fontSize")
        if size < titles[kind]:
            errors.append(f"{name}: кегль {size:g} < {titles[kind]} px")
        for side, gap, minimum in (
            ("слева", x, horizontal),
            ("справа", width - right, horizontal),
            ("сверху", y, vertical),
            ("снизу", height - bottom, vertical),
        ):
            if gap < minimum:
                errors.append(f"{name}: отступ {side} {gap:g} < {minimum} px")
    protected_rects = [rectangle(box) for box in protected]
    pairs = list(combinations(text_rects, 2))
    pairs.extend((text, region) for text in text_rects for region in protected_rects)
    for first, second in pairs:
        if overlap(first, second):
            errors.append(f"{first[0]} перекрывает «{second[0]}»")
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
