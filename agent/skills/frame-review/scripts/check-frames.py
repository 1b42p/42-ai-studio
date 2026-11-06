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
        print(
            "Проверка не завершена. Исправьте чтение файлов и повторите проверку до просмотра кадров."
        )
        return 2
    if failed:
        print(
            "Найдены пустые или почти чёрные кадры. Исправьте композицию, перерендерите эти кадры "
            "в новый каталог и повторите проверку. Просмотр через read_file и полный рендер "
            "допустимы только после кода 0."
        )
        return 1
    print(
        "Пустые кадры не обнаружены. Теперь обязателен визуальный просмотр всех выбранных кадров через read_file."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
