from pathlib import Path
import runpy
import unittest


CHECK = runpy.run_path(
    str(
        Path(__file__).resolve().parents[2]
        / "agent/skills/frame-review/scripts/check-layout.py"
    )
)["check"]


def layout():
    return {
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "durationInFrames": 900,
        "targetSeconds": 30,
        "text": [
            {
                "label": "Заголовок",
                "kind": "headline",
                "fontSize": 152,
                "x": 160,
                "y": 200,
                "width": 890,
                "height": 330,
            },
            {
                "label": "Субтитры",
                "kind": "body",
                "fontSize": 80,
                "x": 184,
                "y": 710,
                "width": 1552,
                "height": 185,
            },
        ],
    }


class CheckLayoutTest(unittest.TestCase):
    def test_safe_layout_and_exact_duration(self):
        self.assertEqual(CHECK(layout()), {"durationSeconds": 30, "errors": []})

    def test_reports_independent_layout_and_duration_defects(self):
        draft = layout()
        draft["durationInFrames"] = 860
        draft["text"][0].update(fontSize=76, x=112)
        draft["text"][1].update(fontSize=46, y=843)
        errors = CHECK(draft)["errors"]
        for expected in ("28.667", "кегль 76", "слева 112", "кегль 46", "снизу 52"):
            self.assertTrue(any(expected in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
