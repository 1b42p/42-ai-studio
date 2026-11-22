# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pdfplumber==0.11.10",
#   "python-pptx==1.0.2",
#   "openpyxl==3.1.5",
#   "charset-normalizer==3.5.2",
# ]
# ///

import json
from base64 import b64encode
from pathlib import Path
from shutil import copyfile
from struct import unpack
from subprocess import run
from sys import executable
from tempfile import TemporaryDirectory


root = Path(__file__).resolve().parents[2]
fixtures = root / "tests/fixtures/documents"
extractor = root / "agent/skills/reading-documents/scripts/inspect_document.py"
sources = {
    "data.csv": "ru-excel.csv",
    "report.pdf": "text.pdf",
    "deck.pptx": "deck.pptx",
}

recordings = {}


def png_record(path):
    data = path.read_bytes()
    width, height = unpack(">II", data[16:24])
    return {
        "base64": b64encode(data).decode("ascii"),
        "size": len(data),
        "width": width,
        "height": height,
    }


with TemporaryDirectory(prefix="studio-document-fixtures-") as temporary:
    inputs = Path(temporary) / "inputs"
    inputs.mkdir()
    for name, source in sources.items():
        fixture = inputs / name
        copyfile(fixtures / source, fixture)
        output = Path(temporary) / name
        result = run(
            [executable, str(extractor), str(fixture), "--out", str(output)],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        recordings[name] = {
            "stdout": result.stdout.replace(str(output), "{output}"),
            "files": {
                file.relative_to(output).as_posix(): file.read_text(encoding="utf-8")
                for file in sorted(output.rglob("*"))
                if file.suffix in {".md", ".csv"}
            },
            "images": {
                file.relative_to(output).as_posix(): png_record(file)
                for file in sorted(output.glob("images/*.png"))
            },
        }

print(json.dumps(recordings, ensure_ascii=False, indent=2))
