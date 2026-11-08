# /// script
# requires-python = ">=3.12"
# dependencies = ["reportlab==4.4.10", "python-pptx==1.0.2", "openpyxl==3.1.5", "pillow==12.2.0"]
# ///
"""uv run tests/fixtures/documents/make_fixtures.py (нужен soffice для кэша формул)."""

import datetime as dt
import shutil
import subprocess
import tempfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parent
FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


def make_pdf(image):
    pdfmetrics.registerFont(TTFont("Russian", str(FONT)))
    document = canvas.Canvas(str(ROOT / "text.pdf"), pagesize=(600, 800), invariant=1)
    document.setFont("Russian", 18)
    document.drawString(50, 750, "Продажи по городам")
    document.setFont("Russian", 12)
    rows = [("Город", "Выручка, ₽"), ("Москва", "13 010,1"), ("Казань", "20 500,2")]
    for i, row in enumerate(rows):
        y = 650 - 30 * i
        document.drawString(60, y, row[0])
        document.drawString(230, y, row[1])
    for y in (670, 640, 610, 580):
        document.line(50, y, 400, y)
    for x in (50, 220, 400):
        document.line(x, 580, x, 670)
    # Частично за рамкой страницы — регрессия crop(bbox).
    document.drawImage(str(image), 550, 350, width=100, height=100)
    document.save()

    scan = canvas.Canvas(str(ROOT / "scan.pdf"), pagesize=(600, 800), invariant=1)
    page = Image.new("RGB", (600, 800), "#f5f2e9")
    draw = ImageDraw.Draw(page)
    draw.text((40, 60), "Скан: продажи по городам", fill="black", font=ImageFont.truetype(str(FONT), 28))
    draw.text((40, 120), "Москва — 13 010,1 ₽", fill="black", font=ImageFont.truetype(str(FONT), 24))
    scan.drawImage(ImageReader(page), 0, 0, width=600, height=800)
    scan.save()


def make_pptx(image):
    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = "Продажи по городам"
    frame = slide.placeholders[1].text_frame
    frame.text = "Сравнение выручки"
    paragraph = frame.add_paragraph()
    paragraph.text, paragraph.level = "Без округления исходных данных", 1
    slide.notes_slide.notes_text_frame.text = "В Казани выручка выше, чем в Москве."
    table = slide.shapes.add_table(3, 2, Inches(0.4), Inches(3), Inches(4), Inches(1.3)).table
    for cells, values in zip(table.rows, [("Город", "Выручка"), ("Москва", "13 010,1"), ("Казань", "20 500,2")]):
        for cell, value in zip(cells.cells, values):
            cell.text = value
    group = slide.shapes.add_group_shape()
    group.shapes.add_picture(str(image), Inches(5), Inches(0.5), Inches(1), Inches(1))
    chart = CategoryChartData()
    chart.categories = ["Москва", "Казань"]
    chart.add_series("Выручка", [13010.1, 20500.2])
    slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(4.5), Inches(2), Inches(4), Inches(3), chart)
    hidden = deck.slides.add_slide(deck.slide_layouts[5])
    hidden._element.set("show", "0")
    hidden.shapes.title.text = "Внутренние расчёты"
    deck.save(ROOT / "deck.pptx")


def make_xlsx():
    book = Workbook()
    sheet = book.active
    sheet.title = "Продажи"
    for row in [("Город", "Выручка", "Дата"), ("Москва", 13010.1, dt.date(2026, 10, 1)),
                ("Казань", 20500.2, dt.date(2026, 10, 2)), ("Итого", "=SUM(B2:B3)", None)]:
        sheet.append(row)
    hidden = book.create_sheet("Расчёты")
    hidden.append(["Показатель", "Значение"])
    hidden.append(["Рост", "=2+3"])
    hidden.sheet_state = "hidden"
    chart = BarChart()
    chart.add_data(Reference(sheet, min_col=2, min_row=1, max_row=3), titles_from_data=True)
    chart.set_categories(Reference(sheet, min_col=1, min_row=2, max_row=3))
    sheet.add_chart(chart, "E2")
    book.save(ROOT / "book-nocache.xlsx")
    office = shutil.which("libreoffice") or shutil.which("soffice")
    if not office:
        raise RuntimeError("Для book-values.xlsx нужен LibreOffice/soffice: кэш не подделывается.")
    with tempfile.TemporaryDirectory() as folder:
        subprocess.run([office, "-env:UserInstallation=file://" + folder + "/profile", "--headless",
                        "--convert-to", "xlsx", "--outdir", folder, str(ROOT / "book-nocache.xlsx")],
                       check=True, capture_output=True, timeout=90)
        shutil.copyfile(Path(folder) / "book-nocache.xlsx", ROOT / "book-values.xlsx")


def main():
    with tempfile.TemporaryDirectory() as folder:
        image = Path(folder) / "image.png"
        picture = Image.new("RGB", (100, 100), "#207a65")
        ImageDraw.Draw(picture).rectangle((20, 20, 80, 80), fill="#fcce56")
        picture.save(image)
        make_pdf(image)
        make_pptx(image)
    make_xlsx()
    (ROOT / "ru-excel.csv").write_bytes(
        ('Город;Население, тыс.;Доля;Дата\r\nМосква;13 010,1;25%;01.10.2026\r\n'
         'Казань;1 318,6;5%;02/10/2026\r\n').encode("windows-1251"))
    (ROOT / "bom.csv").write_text('Город,Значение\nМосква,13010.1234567890123456789\nКазань,20500.2\n', encoding="utf-8-sig")
    (ROOT / "not-a-book.xlsx").write_text("Это текст, а не архив XLSX.", encoding="utf-8")
    (ROOT / "old.xls").write_bytes(bytes.fromhex("D0CF11E0A1B11AE1") + b"legacy")
    print("Созданы PDF, PPTX, XLSX (LibreOffice и без кэша), CSV и отрицательные примеры.")


if __name__ == "__main__":
    main()
