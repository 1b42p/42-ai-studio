#!/usr/bin/env python3
"""Локальное чтение PDF, PPTX, XLSX и CSV. Python 3.12; сеть не используется."""

import argparse
import codecs
import csv
import datetime as dt
import itertools
import re
import sys
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from zipfile import ZipFile


MIB = 1024 * 1024
OLE = bytes.fromhex("D0CF11E0A1B11AE1")
SPACES = " \u00a0\u202f"
NUMBER = re.compile(
    r"^(?P<sign>[+\-−]?)(?P<int>\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)"
    r"(?P<decimal>[.,]\d+)?\s*(?P<unit>[%₽$€])?$"
)
DATE = re.compile(r"^(\d{2})[./](\d{2})[./](\d{4})$")


class DocumentError(Exception):
    def __init__(self, reason, code=2):
        super().__init__(reason)
        self.code = code


@contextmanager
def closing(iterator):
    try:
        yield iterator
    finally:
        if hasattr(iterator, "close"):
            iterator.close()


def scalar(value):
    if value is None:
        return ""
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def exact_number(text):
    value = Decimal(text)
    if not value.is_finite() or abs(value.as_tuple().exponent) > 10_000:
        raise DocumentError("повреждённое число: недопустимый порядок в XML")
    return format(value, "f")


def number(value):
    """Строковое преобразование: точность и значащие дробные нули сохранены."""
    text = scalar(value).strip()
    match = NUMBER.fullmatch(text)
    if not match:
        return None
    integer = re.sub(f"[{SPACES}]", "", match["int"])
    # Коды и артикулы с ведущими нулями остаются текстом.
    if len(integer) > 1 and integer.startswith("0"):
        return None
    return (match["sign"].replace("−", "-") + integer +
            (match["decimal"] or "").replace(",", "."), match["unit"])


def date(value):
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return scalar(value)
    text = scalar(value)
    match = DATE.fullmatch(text)
    try:
        if match:
            day, month, year = map(int, match.groups())
            return dt.date(year, month, day).isoformat()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            dt.date.fromisoformat(text)
            return text
    except ValueError:
        pass
    return None


@dataclass
class Column:
    numeric: bool = True
    dates: bool = True
    seen: bool = False
    units: set = field(default_factory=set)
    decimals: set = field(default_factory=set)

    def observe(self, value):
        if value is None or scalar(value) == "":
            return
        self.seen = True
        parsed = number(value)
        self.numeric &= parsed is not None
        self.dates &= date(value) is not None
        if parsed:
            if parsed[1]:
                self.units.add(parsed[1])
            decimal = NUMBER.fullmatch(scalar(value).strip())["decimal"]
            if decimal:
                self.decimals.add(decimal[0])

    @property
    def kind(self):
        return "число" if self.seen and self.numeric else (
            "дата" if self.seen and self.dates else "текст")

    def convert(self, value):
        if value is None or scalar(value) == "":
            return ""
        if self.kind == "число":
            return number(value)[0]
        if self.kind == "дата":
            return date(value)
        return scalar(value)


def markdown(rows):
    if not rows:
        return "Пустая таблица.\n"
    width = max(map(len, rows))
    def row(values):
        cells = [scalar(v).replace("|", "\\|").replace("\n", "<br>") for v in values]
        return "| " + " | ".join(cells + [""] * (width - len(cells))) + " |\n"
    return row(rows[0]) + row(["---"] * width) + "".join(row(r) for r in rows[1:])


class Output:
    def __init__(self, root, source):
        self.root = root
        self.source = source
        self.warnings = []
        self.files = []
        self.summary = []
        self.overview = None

    def path(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        self.files.append(name)
        return path

    def write(self, text):
        self.overview.write(text + "\n")

    def warn(self, text):
        self.warnings.append(text)

    def table(self, name, rows_factory):
        """Два потоковых прохода; в памяти только типы столбцов и 30 строк."""
        columns = []
        count = 0
        with closing(rows_factory()) as rows:
            for index, row in enumerate(rows):
                count += 1
                while len(columns) < len(row):
                    columns.append(Column())
                if index:
                    for col, value in zip(columns, row):
                        col.observe(value)
        preview = []
        with self.path(name).open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            with closing(rows_factory()) as rows:
                for index, row in enumerate(rows):
                    values = [scalar(v) if index == 0 else col.convert(v)
                              for col, v in zip(columns, row)]
                    values.extend([""] * (len(columns) - len(values)))
                    writer.writerow(values)
                    if index < 30:
                        preview.append(values)
        self.write(f"Таблица: `{name}`; строк с заголовком: {count}, столбцов: {len(columns)}.")
        self.write(markdown(preview))
        if count > 30:
            self.write("Показаны первые 30 строк; CSV содержит таблицу целиком.")
        for i, col in enumerate(columns, 1):
            if col.numeric and col.units:
                self.write(f"Столбец {i}: убраны суффиксы {', '.join(sorted(col.units))}; "
                           "проценты сохранены в процентных пунктах (25% → 25).")
        return count, columns

    def finish(self):
        if self.warnings:
            self.write("\n## Предупреждения\n")
            for warning in self.warnings:
                self.write(f"- {warning}")
        self.overview.close()
        # Имена файлов/предупреждения могут содержать пользовательские переводы строк.
        clean = lambda s: str(s).replace("\n", " ").replace("\r", " ")
        lines = [*self.summary, f"Размер: {self.source.stat().st_size} байт",
                 f"Результаты: {self.root}", "Полный текст: overview.md", "Созданные файлы:"]
        lines.extend(self.files[:30])
        if len(self.files) > 30:
            lines.append(f"… ещё {len(self.files) - 30} файлов; список — в каталоге результатов.")
        room = 79 - len(lines)
        lines.extend(f"Предупреждение: {s}" for s in self.warnings[:max(0, room)])
        if len(self.warnings) > max(0, room):
            lines.append("Остальные предупреждения — в overview.md.")
        print("\n".join(clean(line) for line in lines))


def select_pages(spec, total, limit):
    if not spec:
        return list(range(1, min(total, limit) + 1)), total
    selected = set()
    for item in spec.split(","):
        if not re.fullmatch(r"[1-9]\d*(?:-[1-9]\d*)?", item):
            raise DocumentError("неверный список страниц: нужен 1-20 или 1,3,5-7")
        ends = list(map(int, item.split("-")))
        first, last = ends[0], ends[-1]
        if first > last or last > total:
            raise DocumentError(f"страницы вне диапазона 1–{total}")
        selected.update(range(first, last + 1))
    pages = sorted(selected)
    return pages[:limit], len(pages)


def save_pdf_image(out, image, name):
    path = out.path(name + ".png")
    image.save(path, format="PNG")
    if path.stat().st_size > 3 * MIB:
        path.unlink()
        out.files.remove(name + ".png")
        path = out.path(name + ".jpg")
        image.convert("RGB").save(path, format="JPEG", quality=85)
        out.warn(f"{name}: PNG больше 3 МиБ, сохранён JPEG качества 85")
    if path.stat().st_size > 3 * MIB or max(image.size) > 8000:
        out.warn(f"{path.name}: для read_file нужно уменьшить или разбить изображение "
                 "(предел 3 МиБ и 8000 пикселей)")
    return path.relative_to(out.root).as_posix()


def inspect_pdf(path, out, args):
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect
    from pdfplumber.utils.exceptions import PdfminerException

    try:
        with pdfplumber.open(path) as pdf:
            pages, requested = select_pages(args.pages, len(pdf.pages), args.max_pages)
            out.summary.append(f"PDF; страниц: {len(pdf.pages)}, обработано: {len(pages)}")
            if len(pages) < requested:
                out.warn(f"прочитано {len(pages)} из {requested} страниц; "
                         f"осталось {requested - len(pages)}, продолжи с --pages")
            for n in pages:
                page = pdf.pages[n - 1]
                text = page.extract_text() or ""
                out.write(f"\n## Страница {n}\n\n{text}")
                if not text.strip():
                    out.write("нет текстового слоя")
                    out.warn(f"нет текстового слоя: стр. {n}")
                for k, table in enumerate(page.extract_tables(), 1):
                    out.table(f"tables/p{n}-{k}.csv", lambda t=table: iter(t))
                for k, img in enumerate(page.images, 1):
                    bbox = (max(img["x0"], page.bbox[0]), max(img["top"], page.bbox[1]),
                            min(img["x1"], page.bbox[2]), min(img["bottom"], page.bbox[3]))
                    if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
                        out.warn(f"стр. {n}, картинка {k}: полностью вне страницы")
                        continue
                    cropped = page.crop(bbox).to_image(resolution=150).original
                    name = save_pdf_image(out, cropped, f"images/p{n}-{k}")
                    out.write(f"Картинка: `{name}` (150 dpi).")
                if args.pages_png:
                    name = save_pdf_image(out, page.to_image(resolution=100).original, f"pages/{n}")
                    out.write(f"Страница целиком: `{name}` (100 dpi).")
                page.close()
    except PdfminerException as error:
        if error.args and isinstance(error.args[0], PDFPasswordIncorrect):
            raise DocumentError("файл PDF защищён паролем", 3) from error
        raise DocumentError("повреждённый PDF: не удалось прочитать структуру") from error


def validate_archive(path, kind):
    with path.open("rb") as stream:
        if stream.read(8) == OLE:
            raise DocumentError(f"файл {kind.upper()} защищён паролем (контейнер OLE)", 3)
    with ZipFile(path) as archive:
        size = sum(info.file_size for info in archive.infolist())
        if size > 512 * MIB or size > 200 * path.stat().st_size:
            raise DocumentError("файл распаковывается в слишком большой объём")
        required = "ppt/presentation.xml" if kind == "pptx" else "xl/workbook.xml"
        if required not in archive.namelist() or "[Content_Types].xml" not in archive.namelist():
            raise DocumentError(f"содержимое не соответствует формату {kind.upper()}")


def inspect_pptx(path, out):
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    presentation = Presentation(path)
    out.summary.append(f"PPTX; слайдов: {len(presentation.slides)}")
    out.write(f"Размер слайда: {presentation.slide_width} × {presentation.slide_height} EMU.")
    for n, slide in enumerate(presentation.slides, 1):
        hidden = slide._element.get("show") in ("0", "false", "off")
        out.write(f"\n## Слайд {n}{' — скрыт' if hidden else ''}\n")
        out.write(f"Макет: {slide.slide_layout.name}")
        if slide.shapes.title is not None:
            out.write(f"Заголовок: {slide.shapes.title.text}")
        counters = {"table": 0, "image": 0}

        def table(rows):
            counters["table"] += 1
            out.table(f"tables/s{n}-{counters['table']}.csv", lambda: iter(rows))

        def shapes(items):
            for shape in items:
                if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                    shapes(shape.shapes)
                elif shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    counters["image"] += 1
                    image = shape.image
                    name = f"images/s{n}-{counters['image']}.{image.ext}"
                    out.path(name).write_bytes(image.blob)
                    out.write(f"Картинка: `{name}`.")
                if shape.has_text_frame:
                    for paragraph in shape.text_frame.paragraphs:
                        if paragraph.text:
                            out.write("  " * paragraph.level + f"- {paragraph.text}")
                if shape.has_table:
                    table([[cell.text for cell in row.cells] for row in shape.table.rows])
                if shape.has_chart:
                    chart = shape.chart
                    out.write(f"Диаграмма: {chart.chart_type}.")
                    for plot in chart.plots:
                        if plot._element.tag.rsplit("}", 1)[-1] not in ("scatterChart", "bubbleChart"):
                            categories = [c.label for c in plot.categories]
                            series = list(plot.series)
                            numbers = [chart_values(s, "val") for s in series]
                            table([["Категория", *[s.name for s in series]],
                                   *[[c, *[v[i] if i < len(v) else None
                                           for v in numbers]] for i, c in enumerate(categories)]])
                        else:
                            # Точечные и пузырьковые диаграммы имеют X/Y вместо категорий.
                            for series in plot.series:
                                out.write(f"Ряд: {series.name}")
                                values = [chart_values(series, "xVal"), chart_values(series, "yVal")]
                                if plot._element.tag.rsplit("}", 1)[-1] == "bubbleChart":
                                    values.append(chart_values(series, "bubbleSize"))
                                labels = ["X", "Y", "Размер"][:len(values)]
                                table([labels, *list(itertools.zip_longest(*values))])
                if shape.shape_type in (MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT,
                                         MSO_SHAPE_TYPE.LINKED_OLE_OBJECT) or shape._element.xpath(".//a:graphicData[@uri='http://schemas.openxmlformats.org/drawingml/2006/diagram']"):
                    out.warn(f"слайд {n}: SmartArt или встроенный объект требует ручной проверки")
        shapes(slide.shapes)
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame
            if notes is not None and notes.text.strip():
                out.write(f"\n### Заметки докладчика\n\n{notes.text}")


def chart_values(series, axis):
    # series.values преобразует к float. Сырой OOXML-кэш сохраняет все цифры.
    points = series._element.xpath(f"./c:{axis}//c:pt")
    values = {int(pt.get("idx")): pt.findtext("{http://schemas.openxmlformats.org/drawingml/2006/chart}v")
              for pt in points}
    counts = series._element.xpath(f"./c:{axis}//c:ptCount/@val")
    count = int(counts[0]) if counts else max(values, default=-1) + 1
    # Индексы из недоверенного файла не должны выделять гигантский список.
    if count > 1_048_576 or max(values, default=-1) >= count:
        raise DocumentError("повреждённая диаграмма: неверное число точек")
    return [exact_number(values[i]) if values.get(i) is not None else None
            for i in range(count)]


def sheet_filename(name, used):
    base = "".join(c if c.isalnum() else "_" for c in name)[:40] or "лист"
    candidate, index = base, 1
    while candidate.casefold() in used:
        index += 1
        suffix = f"-{index}"
        candidate = base[:40 - len(suffix)] + suffix
    used.add(candidate.casefold())
    return candidate + ".csv"


def xlsx_raw_numbers(path, sheet_path):
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with ZipFile(path) as archive, archive.open(sheet_path) as stream:
        events = ET.iterparse(stream, events=("start", "end"))
        next(events)
        sheet_data = None
        for event, row in events:
            if event == "start" and row.tag == namespace + "sheetData":
                sheet_data = row
            if event == "end" and row.tag == namespace + "row":
                values = {}
                for cell in row:
                    if cell.get("t", "n") == "n":
                        raw = cell.findtext(namespace + "v")
                        if raw is not None and raw.strip():
                            values[cell.get("r")] = exact_number(raw)
                yield int(row.get("r")), values
                row.clear()
                if sheet_data is not None:
                    sheet_data.clear()


def xlsx_rows(path, sheet):
    # openpyxl отвечает за типы/даты/пустоты, сырой числовой XML — за точность.
    # _worksheet_path — путь части архива в openpyxl 3.1.5, не данные листа в памяти.
    with closing(xlsx_raw_numbers(path, sheet._worksheet_path)) as raw_rows:
        raw = next(raw_rows, None)
        for index, cells in enumerate(sheet.iter_rows(), 1):
            while raw and raw[0] < index:
                raw = next(raw_rows, None)
            numbers = raw[1] if raw and raw[0] == index else {}
            yield [numbers.get(cell.coordinate, cell.value)
                   if cell.data_type == "n" and cell.value is not None else cell.value
                   for cell in cells]


def inspect_xlsx(path, out):
    from openpyxl import load_workbook

    values = load_workbook(path, data_only=True, read_only=True)
    try:
        formulas = load_workbook(path, data_only=False, read_only=True)
        try:
            out.summary.append(f"XLSX; листов: {len(values.sheetnames)}")
            used = set()
            for sheet in values:
                formula_sheet = formulas[sheet.title]
                # Некоторые программы записывают неверный dimension (например A1).
                # Читаем фактические строки, сохраняя read_only.
                sheet.reset_dimensions()
                formula_sheet.reset_dimensions()
                out.write(f"\n## Лист: {sheet.title}{' — скрыт' if sheet.sheet_state != 'visible' else ''}\n")
                missing = 0
                for cached, original in zip(sheet.iter_rows(), formula_sheet.iter_rows()):
                    missing += sum(f.data_type == "f" and c.value is None for c, f in zip(cached, original))
                out.write(f"Формул без сохранённого значения: {missing}.")
                if missing:
                    out.warn(f"лист {sheet.title}: формул без значения: {missing}; "
                             "нужен пересчёт в Excel или LibreOffice, пустоты не равны нулю")
                name = sheet_filename(sheet.title, used)
                count, columns = out.table(f"tables/{name}", lambda s=sheet: xlsx_rows(path, s))
                out.write(f"Размер: {count} строк × {len(columns)} столбцов.")
        finally:
            formulas.close()
    finally:
        values.close()
    # ReadOnlyWorksheet не предоставляет диаграммы. Читаем XML частей, не _charts.
    with ZipFile(path) as archive:
        namespaces = {"c": "http://schemas.openxmlformats.org/drawingml/2006/chart"}
        for name in sorted(archive.namelist()):
            if re.fullmatch(r"xl/charts/chart\d+\.xml", name):
                chart = ET.fromstring(archive.read(name))
                types = [el.tag.rsplit("}", 1)[-1] for el in chart.iter()
                         if el.tag.rsplit("}", 1)[-1].endswith("Chart")]
                ranges = [el.text for el in chart.findall(".//c:f", namespaces)]
                out.write(f"\nДиаграмма `{name}`: {', '.join(types)}; диапазоны: {', '.join(ranges)}.")
                out.write("Числа берутся из CSV соответствующих листов, не из кэша диаграммы.")


def russian_score(text):
    """У кандидатов одни байты дают разные буквы: оцениваем слова, а не цифры."""
    words = re.findall(r"[^\W\d_]+", text)
    letters = "".join(words)
    if not letters:
        return 0
    cyrillic = [c for c in letters if "а" <= c.lower() <= "я" or c.lower() == "ё"]
    # Частотные буквы и биграммы различают cp1251, koi8-r и cp866 даже при
    # полностью кириллической ошибочной раскодировке.
    frequent = sum(c.lower() in "оеаинтсрвлкмдпу" for c in cyrillic)
    pairs = sum(len(re.findall(r"ст|но|то|на|ен|ов|ни|ра|во|ко|ро|по|пр|ре|го|ос|ли|не|ло|та|ел|од|те|ва|ор|ан|ти|ве", w.lower())) for w in words)
    bad_case = sum(c.isupper() for word in words for c in word[1:])
    return (2 * len(cyrillic) + frequent + pairs - 2 * bad_case) / len(letters)


def csv_encoding(path, override):
    if override:
        codecs.lookup(override)
        return override
    with path.open("rb") as stream:
        sample = stream.read(128 * 1024)
    if sample.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    # Инкрементальный декодер допускает незавершённый символ на границе выборки.
    try:
        codecs.getincrementaldecoder("utf-8")().decode(sample, final=path.stat().st_size <= len(sample))
        return "utf-8"
    except UnicodeDecodeError:
        pass
    from charset_normalizer import from_bytes
    allowed = ("cp1251", "koi8_r", "cp866")
    matches = from_bytes(sample, cp_isolation=list(allowed))
    preferred = matches.best().encoding if matches.best() else None
    candidates = []
    for encoding in allowed:
        try:
            decoded = sample.decode(encoding)
            candidates.append((russian_score(decoded), encoding == preferred, encoding))
        except UnicodeDecodeError:
            continue
    if not candidates:
        raise DocumentError("не удалось определить кодировку CSV; укажи --encoding")
    encoding = max(candidates)[2]
    return "windows-1251" if encoding == "cp1251" else encoding.replace("_", "-")


def csv_rows(path, encoding, delimiter):
    with path.open(encoding=encoding, newline="") as stream:
        for row in csv.reader(stream, delimiter=delimiter, strict=True):
            if row:
                yield row


def csv_delimiter(path, encoding, override):
    if override:
        if len(override) != 1 or override in "\r\n\0":
            raise DocumentError("разделитель --delimiter должен быть одним символом")
        return override
    for delimiter in (";", "\t", "|", ","):
        try:
            with closing(csv_rows(path, encoding, delimiter)) as rows:
                sample = list(itertools.islice(rows, 50))
            sizes = {len(row) for row in sample}
            if len(sizes) == 1 and next(iter(sizes)) > 1:
                return delimiter
        except csv.Error:
            continue
    return None


def single_column_rows(path, encoding):
    yield from csv_rows(path, encoding, "\x1f")


def inspect_csv(path, out, args):
    encoding = csv_encoding(path, args.encoding)
    delimiter = csv_delimiter(path, encoding, args.delimiter)
    display = "табуляция" if delimiter == "\t" else delimiter or "один столбец"
    out.summary.append("CSV")
    out.warn(f"кодировка: {encoding}, разделитель: {display}")
    out.write(f"Кодировка: {encoding}; разделитель: {display}.")
    if path.stat().st_size < 200 and not args.encoding:
        out.warn("кодировка определена неуверенно: файл короче 200 байт; "
                 "переопредели --encoding windows-1251 (или нужной кодировкой)")
    factory = (lambda: csv_rows(path, encoding, delimiter)) if delimiter else (
        lambda: single_column_rows(path, encoding))
    count, columns = out.table("tables/data.csv", factory)
    out.summary.append(f"Строк с заголовком: {count}, столбцов: {len(columns)}")
    decimal_signs = sorted(set().union(*(col.decimals for col in columns if col.numeric)))
    out.write(f"Десятичный знак источника: {' и '.join(decimal_signs) or 'не найден'}; "
              "в нормализованных числах — точка. Числа не округлялись.")
    out.write("Типы столбцов: " + ", ".join(f"{n}: {col.kind}" for n, col in enumerate(columns, 1)))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--pages", help="PDF: 1-20 или 1,3,5-7")
    parser.add_argument("--max-pages", type=int, default=200)
    parser.add_argument("--pages-png", action="store_true")
    parser.add_argument("--encoding", help="Переопределение кодировки CSV")
    parser.add_argument("--delimiter", help="Переопределение разделителя CSV")
    args = parser.parse_args(argv)
    kind = args.file.suffix.lower().lstrip(".")
    out = None
    try:
        if kind not in ("pdf", "pptx", "xlsx", "csv"):
            raise DocumentError(f"неподдерживаемый формат .{kind or '(без расширения)'}")
        if not args.file.is_file():
            raise DocumentError("файл не найден или недоступен")
        if args.max_pages < 1:
            raise DocumentError("--max-pages должен быть положительным числом")
        if kind != "pdf" and (args.pages or args.pages_png):
            raise DocumentError("--pages и --pages-png применяются только к PDF")
        if kind != "csv" and (args.encoding or args.delimiter):
            raise DocumentError("--encoding и --delimiter применяются только к CSV")
        if kind in ("pptx", "xlsx"):
            validate_archive(args.file, kind)
        root = (args.out or Path("/workspace/source") / f"{args.file.stem}-{kind}").resolve()
        if args.file.resolve().is_relative_to(root):
            raise DocumentError("каталог результатов содержит исходный файл; выбери другой --out")
        if root.exists() and any(root.iterdir()):
            raise DocumentError("каталог результатов не пуст; выбери новый --out, исходник сохранён")
        out = Output(root, args.file)
        out.overview = out.path("overview.md").open("w", encoding="utf-8")
        out.write(f"# Источник: {args.file.name}\n")
        if kind == "pdf":
            inspect_pdf(args.file, out, args)
        elif kind == "pptx":
            inspect_pptx(args.file, out)
        elif kind == "xlsx":
            inspect_xlsx(args.file, out)
        else:
            inspect_csv(args.file, out, args)
        out.finish()
        return 0
    except Exception as error:
        if out and out.overview and not out.overview.closed:
            out.overview.close()
        if isinstance(error, DocumentError):
            reason, code = str(error), error.code
        elif isinstance(error, ImportError):
            reason, code = "не установлены зависимости; выполни pip install из навыка reading-documents", 2
        else:
            reason, code = "повреждённый файл или содержимое не соответствует расширению", 2
        print(reason)
        print("Неполные результаты не используй." if out else "Чтение не выполнено.")
        formats = {"pdf": "PDF с текстовым слоем", "pptx": "PPTX", "xlsx": "XLSX", "csv": "CSV UTF-8"}
        target = formats.get(kind, {"xls": "XLSX", "ppt": "PPTX", "doc": "PDF с текстовым слоем"}.get(kind, "PDF, PPTX, XLSX или CSV UTF-8"))
        print(f"Пересохрани в {target} без пароля; при ошибке параметров исправь их и выбери новый --out.")
        return code


if __name__ == "__main__":
    sys.exit(main())
