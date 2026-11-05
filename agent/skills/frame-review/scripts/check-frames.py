import argparse
import json
from pathlib import Path

from PIL import Image


def check(path: Path) -> dict:
    with Image.open(path) as image:
        if max(image.size) > 8000:
            raise ValueError("Уменьшите кадр до 8000 пикселей по стороне")
        extrema = image.convert("RGB").getextrema()
    suspect = "uniform" if all(high - low <= 2 for low, high in extrema) else None
    if suspect is None and max(high for _, high in extrema) <= 8:
        suspect = "near_black"
    return {"path": str(path), "extrema": extrema, "suspect": suspect}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Поиск однотонных и почти чёрных опорных кадров"
    )
    parser.add_argument("frames", nargs="+", type=Path)
    paths = parser.parse_args().frames
    failed = False
    unreadable = False
    for path in paths:
        try:
            result = check(path)
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            result = {"path": str(path), "error": str(error)}
            unreadable = True
        failed |= result.get("suspect") is not None
        print(json.dumps(result, ensure_ascii=False))
    if unreadable:
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
