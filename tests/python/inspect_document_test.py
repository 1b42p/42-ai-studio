"""Контракт чтения реальных документов; вызывается из test:http без приложения."""

import ast
import contextlib
import csv
import hashlib
import importlib.util
import io
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "agent/skills/reading-documents/scripts/inspect_document.py"
FIXTURES = ROOT / "tests/fixtures/documents"
spec = importlib.util.spec_from_file_location("inspect_document", SCRIPT)
document = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = document
spec.loader.exec_module(document)


class DocumentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.out = self.folder / "out"

    def inspect(self, name, *options, code=0):
        source = Path(name)
        if not source.is_absolute():
            source = FIXTURES / source
        before = hashlib.sha256(source.read_bytes()).digest()
        stdout = io.StringIO()
        # Любая попытка открыть сетевое соединение ломает проверку.
        with contextlib.redirect_stdout(stdout), patch("socket.socket.connect", side_effect=AssertionError("network")):
            actual = document.main([str(source), "--out", str(self.out), *options])
        self.assertEqual(actual, code, stdout.getvalue())
        self.assertLessEqual(len(stdout.getvalue().splitlines()), 80)
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)
        return stdout.getvalue()

    def overview(self):
        return (self.out / "overview.md").read_text()

    def rows(self, name):
        with (self.out / "tables" / name).open(newline="") as stream:
            return list(csv.reader(stream))

    def write_csv(self, text, encoding="utf-8"):
        path = self.folder / "data.csv"
        path.write_text(text, encoding=encoding, newline="")
        return path

    def test_pdf_text_table_image_and_cropped_bbox(self):
        self.inspect("text.pdf", "--pages-png")
        self.assertIn("Страница 1", self.overview())
        self.assertIn("Продажи по городам", self.overview())
        self.assertEqual(self.rows("p1-1.csv"), [["Город", "Выручка, ₽"], ["Москва", "13010.1"], ["Казань", "20500.2"]])
        from PIL import Image
        with Image.open(self.out / "images/p1-1.png") as image:
            self.assertIn(image.width, (104, 105))  # 50 points, clipped to page, 150 dpi.
        with Image.open(self.out / "pages/1.png") as page:
            self.assertIn(page.width, (833, 834))  # 600 points at 100 dpi.

    def test_scan_has_no_text_layer(self):
        summary = self.inspect("scan.pdf", "--pages-png")
        self.assertIn("нет текстового слоя: стр. 1", summary)
        self.assertIn("нет текстового слоя", self.overview())
        self.assertTrue((self.out / "pages/1.png").is_file())

    def test_pptx_notes_hidden_slide_chart_and_group_image(self):
        self.inspect("deck.pptx")
        text = self.overview()
        for expected in ["Слайд 2 — скрыт", "Макет:", "  - Без округления", "Заметки докладчика", "В Казани выручка выше", "COLUMN_CLUSTERED"]:
            self.assertIn(expected, text)
        self.assertEqual(self.rows("s1-2.csv"), [["Категория", "Выручка"], ["Москва", "13010.1"], ["Казань", "20500.2"]])
        self.assertTrue((self.out / "images/s1-1.png").is_file())

    def test_xlsx_libreoffice_cached_values_and_chart(self):
        self.inspect("book-values.xlsx")
        self.assertEqual(self.overview().count("Формул без сохранённого значения: 0."), 2)
        self.assertIn("Расчёты — скрыт", self.overview())
        self.assertIn("barChart", self.overview())
        self.assertRegex(self.overview(), r"Продажи'?!.?\$?B\$?2:\$?B\$?3")
        self.assertEqual(self.rows("Продажи.csv")[-1][1], "33510.3")
        self.assertTrue(self.rows("Продажи.csv")[1][2].startswith("2026-10-01"))
        self.assertEqual(self.rows("Расчёты.csv")[1][1], "5")

    def test_xlsx_missing_formula_values_remain_empty(self):
        summary = self.inspect("book-nocache.xlsx")
        self.assertEqual(self.overview().count("Формул без сохранённого значения: 1."), 2)
        self.assertEqual(summary.count("формул без значения: 1"), 2)
        self.assertEqual(self.rows("Продажи.csv")[-1][1], "")
        self.assertEqual(self.rows("Расчёты.csv")[1][1], "")

    def test_xlsx_preserves_raw_numeric_precision(self):
        path = self.folder / "precise.xlsx"
        with ZipFile(FIXTURES / "book-nocache.xlsx") as source, ZipFile(path, "w", ZIP_DEFLATED) as dest:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename == "xl/worksheets/sheet1.xml":
                    data = data.replace(b"13010.1", b"13010.1234567890123456789")
                dest.writestr(info, data)
        self.inspect(path)
        self.assertEqual(self.rows("Продажи.csv")[1][1], "13010.1234567890123456789")

    def test_scatter_chart_keeps_both_axes(self):
        from pptx import Presentation
        from pptx.chart.data import XyChartData
        from pptx.enum.chart import XL_CHART_TYPE
        from pptx.util import Inches
        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[5])
        chart = XyChartData()
        series = chart.add_series("Точки")
        series.add_data_point(10.125, 20.250)
        series.add_data_point(15.625, 25.875)
        slide.shapes.add_chart(XL_CHART_TYPE.XY_SCATTER, Inches(1), Inches(1), Inches(4), Inches(3), chart)
        path = self.folder / "scatter.pptx"
        deck.save(path)
        self.inspect(path)
        self.assertEqual(self.rows("s1-1.csv"), [["X", "Y"], ["10.125", "20.25"], ["15.625", "25.875"]])

    def test_russian_excel_csv(self):
        summary = self.inspect("ru-excel.csv")
        self.assertIn("кодировка: windows-1251, разделитель: ;", summary)
        self.assertIn("--encoding", summary)
        self.assertEqual(self.rows("data.csv"), [["Город", "Население, тыс.", "Доля", "Дата"],
                         ["Москва", "13010.1", "25", "2026-10-01"], ["Казань", "1318.6", "5", "2026-10-02"]])
        self.assertIn("убраны суффиксы %", self.overview())
        self.assertIn("Десятичный знак источника: ,", self.overview())

    def test_bom_and_precision(self):
        self.inspect("bom.csv")
        self.assertEqual(self.rows("data.csv")[0][0], "Город")
        self.assertEqual(self.rows("data.csv")[1][1], "13010.1234567890123456789")

    def test_non_numeric_columns_are_preserved(self):
        text = 'Код;Телефон;Описание;Скобки;Смешанный;Число\n0012;8 800 555 35 35;1,5 млн;(5);2;−13\u202f010,100€\n0013;8 800 555 35 36;2 млн;(6);неизвестно;+20\u00a0500,200$\n'
        self.inspect(self.write_csv(text))
        self.assertEqual(self.rows("data.csv")[1], ["0012", "8 800 555 35 35", "1,5 млн", "(5)", "2", "-13010.100"])
        self.assertEqual(self.rows("data.csv")[2][-1], "+20500.200")
        self.assertIn("убраны суффиксы $, €", self.overview())

    def test_empty_values_and_russian_dates(self):
        self.inspect(self.write_csv("Дата;Значение;Пусто\n31.12.2025;0,000;\n01/02/2026;;\n2026-03-01;2 345,6789₽;\n"))
        self.assertEqual(self.rows("data.csv")[1:], [["2025-12-31", "0.000", ""], ["2026-02-01", "", ""], ["2026-03-01", "2345.6789", ""]])

    def test_csv_quoted_multiline_record_and_delimiter_tie(self):
        self.inspect(self.write_csv('Название;Число, ед.\n"Строка\nпродолжение";"1,25"\nКазань;"2,50"\n'))
        self.assertEqual(self.rows("data.csv")[1], ["Строка\nпродолжение", "1.25"])

    def test_single_column(self):
        self.inspect(self.write_csv('Описание\n"Две\nстроки"\nМосква\n'))
        self.assertEqual(self.rows("data.csv"), [["Описание"], ["Две\nстроки"], ["Москва"]])

    def test_delimiter_preference(self):
        self.inspect(self.write_csv("A;B,C\nx;y,z\n"))
        self.assertEqual(self.rows("data.csv"), [["A", "B,C"], ["x", "y,z"]])

    def test_encoding_and_delimiter_overrides(self):
        path = self.write_csv("Город|Число\nМосква|13,1\n", "koi8-r")
        summary = self.inspect(path, "--encoding", "koi8-r", "--delimiter", "|")
        self.assertIn("кодировка: koi8-r, разделитель: |", summary)
        self.assertEqual(self.rows("data.csv")[1], ["Москва", "13.1"])

    def test_encoding_candidates(self):
        text = "Город;Население, тыс.;Примечание\nМосква;13 010,1;Население города\nКазань;1 318,6;Численность населения\n"
        for encoding in ["cp1251", "koi8-r", "cp866", "utf-8"]:
            with self.subTest(encoding=encoding):
                self.out = self.folder / encoding
                self.inspect(self.write_csv(text, encoding))
                self.assertEqual(self.rows("data.csv")[1][0], "Москва")

    def test_streamed_table_preview_is_limited_but_csv_complete(self):
        self.inspect(self.write_csv("N;Число\n" + "".join(f"{i};{i},123456789\n" for i in range(101))))
        self.assertEqual(len(self.rows("data.csv")), 102)
        self.assertEqual(self.rows("data.csv")[-1], ["100", "100.123456789"])
        self.assertIn("Показаны первые 30 строк", self.overview())
        self.assertNotIn("| 100 |", self.overview())

    def test_sheet_names_collisions_and_full_stream(self):
        from openpyxl import Workbook
        path = self.folder / "names.xlsx"
        book = Workbook(write_only=True)
        for name in ["Лист а", "Лист_а", "Лист-а"]:
            sheet = book.create_sheet(name)
            sheet.append(["Имя", "Число"])
            for i in range(100):
                sheet.append(["Москва", f"{i},2500"])
        book.save(path)
        self.inspect(path)
        self.assertEqual(sorted(p.name for p in (self.out / "tables").iterdir()), ["Лист_а-2.csv", "Лист_а-3.csv", "Лист_а.csv"])
        self.assertEqual(len(self.rows("Лист_а.csv")), 101)
        self.assertEqual(self.rows("Лист_а.csv")[-1][1], "99.2500")

    def test_bad_formats_and_ole_password(self):
        for name in ["not-a-book.xlsx", "old.xls"]:
            with self.subTest(name=name):
                self.inspect(name, code=2)
        for suffix in ["xlsx", "pptx"]:
            path = self.folder / f"protected.{suffix}"
            path.write_bytes(document.OLE + b"encrypted package")
            summary = self.inspect(path, code=3)
            self.assertIn("паролем", summary)
            self.assertIn("Пересохрани", summary.splitlines()[-1])

    def test_pdf_password_and_corruption_are_different(self):
        from reportlab.pdfgen import canvas
        from reportlab.lib.pdfencrypt import StandardEncryption
        path = self.folder / "password.pdf"
        pdf = canvas.Canvas(str(path), encrypt=StandardEncryption("secret"))
        pdf.drawString(10, 10, "Secret")
        pdf.save()
        self.assertIn("паролем", self.inspect(path, code=3))
        self.out = self.folder / "broken-out"
        path.write_bytes(b"%PDF-1.7\nnot a PDF")
        self.inspect(path, code=2)

    def test_zip_bomb_rejected_before_library_load(self):
        for suffix in ["xlsx", "pptx"]:
            path = self.folder / f"bomb.{suffix}"
            with ZipFile(path, "w", compression=ZIP_DEFLATED) as archive:
                archive.writestr("padding", b"0" * (2 * 1024 * 1024))
            summary = self.inspect(path, code=2)
            self.assertTrue(summary.startswith("файл распаковывается в слишком большой объём"))

    def test_page_limits_selection_and_summary_cap(self):
        from reportlab.pdfgen import canvas
        path = self.folder / "many.pdf"
        pdf = canvas.Canvas(str(path))
        for i in range(205):
            if i in [0, 2, 4, 5, 6]:
                pdf.drawString(20, 20, f"Page {i + 1}")
            pdf.showPage()
        pdf.save()
        summary = self.inspect(path)
        self.assertIn("прочитано 200 из 205", summary)
        self.assertNotIn("## Страница 201", self.overview())
        self.assertIn("Остальные предупреждения", summary)
        self.out = self.folder / "selection"
        summary = self.inspect(path, "--pages", "1,3,5-7", "--max-pages", "4")
        self.assertEqual(re.findall(r"## Страница (\d+)", self.overview()), ["1", "3", "5", "6"])
        self.assertIn("прочитано 4 из 5", summary)

    def test_bad_pages(self):
        for selection in ["0", "2-1", "1,999", "-2", "1,,2"]:
            self.out = self.folder / re.sub(r"\W", "_", selection)
            self.inspect("text.pdf", "--pages", selection, code=2)

    def test_large_pdf_image_switches_to_jpeg(self):
        import random
        from PIL import Image
        out = document.Output(self.out, FIXTURES / "text.pdf")
        noise = Image.frombytes("RGB", (1100, 1100), random.Random(21).randbytes(1100 * 1100 * 3))
        name = document.save_pdf_image(out, noise, "images/noise")
        self.assertEqual(name, "images/noise.jpg")
        self.assertFalse((self.out / "images/noise.png").exists())
        self.assertLess((self.out / name).stat().st_size, 3 * document.MIB)
        self.assertIn("качества 85", out.warnings[0])

    def test_output_does_not_overwrite_source_or_previous_results(self):
        path = self.write_csv("N;Число\nМосква;13,1\n")
        self.inspect(path)
        self.inspect(path, code=2)
        original = path.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(document.main([str(path), "--out", str(self.folder)]), 2)
        self.assertEqual(path.read_bytes(), original)

    def test_script_has_no_network_or_heavy_imports(self):
        tree = ast.parse(SCRIPT.read_text())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                names.add((node.module or "").split(".")[0])
        self.assertFalse(names & {"socket", "urllib", "http", "requests", "pandas", "numpy"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
