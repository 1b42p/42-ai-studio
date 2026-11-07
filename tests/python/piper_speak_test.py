# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Чистые функции Piper: без установки Piper, ONNX и голоса."""

import importlib.util
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "agent/skills/voiceover/scripts/piper_speak.py"
)
spec = importlib.util.spec_from_file_location("piper_speak", SCRIPT)
piper_speak = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = piper_speak
spec.loader.exec_module(piper_speak)


class AlignmentTests(unittest.TestCase):
    def test_import_needs_no_piper_or_onnx_packages(self):
        self.assertFalse({"piper", "onnx", "onnxruntime"} & sys.modules.keys())

    def test_spaces_split_words_and_markers_and_punctuation_keep_their_samples(self):
        self.assertEqual(
            piper_speak.group_alignment_samples(
                [
                    ("^", 100),
                    ("p", 200),
                    (",", 30),
                    (" ", 70),
                    ("—", 20),
                    (" ", 30),
                    ("m", 300),
                    (".", 50),
                    ("$", 200),
                ]
            ),
            [450, 550],
        )

    def test_timings_keep_utf8_punctuation_and_the_v1_speech_contract(self):
        source = "  « Привет ! — мир.  "
        timings, mode = piper_speak.build_timings(
            source,
            "ru_RU-denis-medium",
            "ru-RU",
            1000,
            [
                piper_speak.Part(
                    source,
                    [
                        piper_speak.Chunk(
                            1000,
                            alignments=[
                                ("^", 100),
                                ("p", 300),
                                (" ", 100),
                                ("m", 400),
                                ("$", 100),
                            ],
                        )
                    ],
                )
            ],
        )
        self.assertEqual(
            json.loads(json.dumps(timings, ensure_ascii=False)),
            {
                "version": 1,
                "voice": "piper:ru_RU-denis-medium",
                "language": "ru-RU",
                "format": "wav",
                "text": source,
                "durationMs": 1000,
                "words": [
                    {"text": "« Привет ! —", "startMs": 0, "endMs": 500},
                    {"text": "мир.", "startMs": 500, "endMs": 1000},
                ],
                "sentences": [
                    {"text": "« Привет ! —", "startMs": 0, "endMs": 500},
                    {"text": "мир.", "startMs": 500, "endMs": 1000},
                ],
            },
        )
        self.assertEqual(mode, "alignment")

    def test_mismatched_groups_use_letter_weights_within_the_chunk(self):
        # 15 групп на 11 слов: числа раскрылись в несколько произносимых слов.
        source = (
            "Сегодня 24 октября 2026 года, полная цена — 1500 рублей (скидка 15%). Всё."
        )
        expanded = [("x", 100), (" ", 0)] * 15
        timings, mode = piper_speak.build_timings(
            source,
            "ru_RU-denis-medium",
            "ru-RU",
            1000,
            [
                piper_speak.Part(
                    source[:-5], [piper_speak.Chunk(1500, alignments=expanded)]
                ),
                piper_speak.Part(
                    "Всё.",
                    [
                        piper_speak.Chunk(
                            500,
                            alignments=[("^", 100), ("f", 300), ("$", 100)],
                        )
                    ],
                ),
            ],
        )
        self.assertEqual(mode, "proportional")
        self.assertEqual(len(timings["words"]), 12)
        self.assertEqual(
            timings["words"][0], {"text": "Сегодня", "startMs": 0, "endMs": 239}
        )
        self.assertEqual(timings["words"][6]["text"], "цена —")
        self.assertEqual(timings["words"][-2]["endMs"], 1500)
        self.assertEqual(
            timings["words"][-1], {"text": "Всё.", "startMs": 1750, "endMs": 2250}
        )
        self.assertEqual(timings["sentences"][0]["endMs"], 1750)
        self.assertEqual(timings["durationMs"], 2250)

    def test_espeak_extra_chunk_and_number_expansion_do_not_steal_next_words(self):
        first = tuple("u xx xx o,")
        second = tuple("f h.")
        source = "Уже 24 октября, всё хорошо."
        timings, mode = piper_speak.build_timings(
            source,
            "ru_RU-denis-medium",
            "ru-RU",
            1000,
            [
                piper_speak.Part(
                    source,
                    [
                        piper_speak.Chunk(1000, first, [("x", 250), (" ", 0)] * 4),
                        piper_speak.Chunk(
                            600, second, [("f", 200), (" ", 100), ("h", 300)]
                        ),
                    ],
                    prefix_phonemes=[
                        [tuple("u.")],
                        [tuple("u xx xx.")],
                        [first],
                        [first, tuple("f.")],
                    ],
                )
            ],
        )
        self.assertEqual(mode, "proportional")
        self.assertEqual(
            timings["words"],
            [
                {"text": "Уже", "startMs": 0, "endMs": 273},
                {"text": "24", "startMs": 273, "endMs": 364},
                {"text": "октября,", "startMs": 364, "endMs": 1000},
                {"text": "всё", "startMs": 1250, "endMs": 1550},
                {"text": "хорошо.", "startMs": 1550, "endMs": 1850},
            ],
        )
        self.assertEqual(
            timings["sentences"],
            [
                {"text": source, "startMs": 0, "endMs": 1850},
            ],
        )


class ChunkMappingTests(unittest.TestCase):
    def test_punctuation_only_audio_cannot_hide_an_unmapped_chunk(self):
        with self.assertRaisesRegex(ValueError, "слов"):
            piper_speak.build_timings(
                "Привет.",
                "ru_RU-denis-medium",
                "ru-RU",
                1000,
                [
                    piper_speak.Part("—", [piper_speak.Chunk(100)]),
                    piper_speak.Part("Привет.", [piper_speak.Chunk(100)]),
                ],
            )

    def test_source_sentences_ignore_decimal_and_date_dots_and_keep_an_unfinished_tail(
        self,
    ):
        text = "Цена 1.5 рубля.\nДата 24.10.2026! «Да?» Финал без точки"
        words = piper_speak.source_words(text)
        ranges = piper_speak.sentence_ranges(words)
        self.assertEqual(ranges, [(0, 3), (3, 5), (5, 6), (6, 9)])
        self.assertEqual(
            [text[words[first].start : words[end - 1].end] for first, end in ranges],
            [
                "Цена 1.5 рубля.",
                "Дата 24.10.2026!",
                "«Да?»",
                "Финал без точки",
            ],
        )

    def test_espeak_can_merge_original_sentences_without_merging_their_timing_spans(
        self,
    ):
        source = "Раз. Два! Три?"
        timings, mode = piper_speak.build_timings(
            source,
            "ru_RU-denis-medium",
            "ru-RU",
            1000,
            [
                piper_speak.Part(
                    source,
                    [
                        piper_speak.Chunk(
                            600,
                            alignments=[
                                ("r", 100),
                                (" ", 0),
                                ("d", 200),
                                (" ", 0),
                                ("t", 300),
                            ],
                        )
                    ],
                )
            ],
            sentence_silence=0.1,
        )
        self.assertEqual(mode, "alignment")
        self.assertEqual(
            timings["sentences"],
            [
                {"text": "Раз.", "startMs": 0, "endMs": 100},
                {"text": "Два!", "startMs": 100, "endMs": 300},
                {"text": "Три?", "startMs": 300, "endMs": 600},
            ],
        )
        self.assertEqual(timings["durationMs"], 600)

    def test_custom_pause_and_sample_rate_do_not_add_a_trailing_pause(self):
        timings, mode = piper_speak.build_timings(
            "Раз. Два! Три?",
            "ru_RU-denis-medium",
            "ru-RU",
            22050,
            [
                piper_speak.Part(
                    word, [piper_speak.Chunk(2205, alignments=[("x", 2205)])]
                )
                for word in ("Раз.", "Два!", "Три?")
            ],
            sentence_silence=0.1,
        )
        self.assertEqual(mode, "alignment")
        self.assertEqual(
            timings["sentences"],
            [
                {"text": "Раз.", "startMs": 0, "endMs": 200},
                {"text": "Два!", "startMs": 200, "endMs": 400},
                {"text": "Три?", "startMs": 400, "endMs": 500},
            ],
        )
        self.assertEqual(timings["durationMs"], 500)

    def test_one_source_word_can_span_two_espeak_chunks_without_losing_the_tail(self):
        first, second, third = tuple("p!"), tuple("k."), tuple("d.")
        source = "Привет!Пока. Дальше."
        timings, mode = piper_speak.build_timings(
            source,
            "ru_RU-denis-medium",
            "ru-RU",
            1000,
            [
                piper_speak.Part(
                    source,
                    [
                        piper_speak.Chunk(200, first, [("p", 200)]),
                        piper_speak.Chunk(300, second, [("k", 300)]),
                        piper_speak.Chunk(400, third, [("d", 400)]),
                    ],
                    prefix_phonemes=[[first, second]],
                )
            ],
        )
        self.assertEqual(mode, "proportional")
        self.assertEqual(
            timings["words"],
            [
                {"text": "Привет!Пока.", "startMs": 0, "endMs": 750},
                {"text": "Дальше.", "startMs": 1000, "endMs": 1400},
            ],
        )
        self.assertEqual(timings["durationMs"], 1400)

    def test_missing_or_invalid_alignment_stays_inside_its_own_audio(self):
        for alignment in (None, [("a", 2000)], [("a", -1)]):
            with self.subTest(alignment=alignment):
                timings, mode = piper_speak.build_timings(
                    "Я — тут.",
                    "ru_RU-denis-medium",
                    "ru-RU",
                    1000,
                    [
                        piper_speak.Part(
                            "Я — тут.", [piper_speak.Chunk(1000, alignments=alignment)]
                        )
                    ],
                )
                self.assertEqual(mode, "proportional")
                self.assertEqual(
                    timings["words"],
                    [
                        {"text": "Я —", "startMs": 0, "endMs": 250},
                        {"text": "тут.", "startMs": 250, "endMs": 1000},
                    ],
                )

    def test_unmatched_phoneme_prefixes_keep_every_word_and_all_inserted_pauses(self):
        timings, mode = piper_speak.build_timings(
            "А Б В.",
            "ru_RU-denis-medium",
            "ru-RU",
            1000,
            [
                piper_speak.Part(
                    "А Б В.",
                    [
                        piper_speak.Chunk(600, tuple("a.")),
                        piper_speak.Chunk(300, tuple("b v.")),
                    ],
                    prefix_phonemes=[[tuple("different.")], [tuple("also different.")]],
                )
            ],
        )
        self.assertEqual(mode, "proportional")
        self.assertEqual(
            timings["words"],
            [
                {"text": "А", "startMs": 0, "endMs": 300},
                {"text": "Б", "startMs": 300, "endMs": 600},
                {"text": "В.", "startMs": 850, "endMs": 1150},
            ],
        )

    def test_incomplete_source_coverage_and_empty_audio_are_errors(self):
        for part in (
            piper_speak.Part("Пока.", [piper_speak.Chunk(100)]),
            piper_speak.Part("Привет.", []),
            piper_speak.Part("Привет.", [piper_speak.Chunk(0)]),
        ):
            with self.subTest(part=part), self.assertRaises(ValueError):
                piper_speak.build_timings(
                    "Привет.", "ru_RU-denis-medium", "ru-RU", 1000, [part]
                )


class OptionsTests(unittest.TestCase):
    def test_publication_keeps_existing_audio_and_timings_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staged_audio, staged_timings = root / "new.wav", root / "new.json"
            staged_audio.write_bytes(b"new audio")
            staged_timings.write_text('{"durationMs":2000}', encoding="utf-8")
            audio, timings = root / "scene.wav", root / "scene.words.json"
            for existing in (audio, timings):
                existing.write_bytes(b"previous result")
                with self.assertRaises(FileExistsError):
                    piper_speak.publish_outputs(
                        staged_audio, staged_timings, audio, timings
                    )
                self.assertEqual(existing.read_bytes(), b"previous result")
                other = timings if existing == audio else audio
                self.assertFalse(other.exists())
                existing.unlink()
            piper_speak.publish_outputs(staged_audio, staged_timings, audio, timings)
            self.assertEqual(audio.read_bytes(), b"new audio")
            self.assertEqual(timings.read_text(encoding="utf-8"), '{"durationMs":2000}')

    def test_cli_defaults_and_invalid_limits(self):
        required = [
            "--text-file",
            "сцена.txt",
            "--voice",
            "ru_RU-denis-medium",
            "--out",
            "звук",
        ]
        options = piper_speak.parse_args(required)
        self.assertEqual(options.sentence_silence, 0.25)
        self.assertIsNone(options.threads)
        self.assertIsNone(options.length_scale)
        self.assertEqual(options.data_dir, Path.home() / ".cache/piper")
        for extra in (
            ["--threads", "0"],
            ["--threads", "1.5"],
            ["--sentence-silence", "-1"],
            ["--sentence-silence", "nan"],
            ["--sentence-silence", "inf"],
            ["--length-scale", "0"],
            ["--length-scale", "nan"],
            ["--voice", "../voice"],
        ):
            with (
                self.subTest(extra=extra),
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as error,
            ):
                piper_speak.parse_args([*required, *extra])
            self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
