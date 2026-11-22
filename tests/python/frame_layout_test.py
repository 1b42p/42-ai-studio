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

    def test_overlaps_only_when_both_boxes_can_be_visible(self):
        draft = layout()
        draft["text"][0].update(group="scene-2", width=1100)
        draft["protected"] = [
            {
                "label": "Фигура",
                "group": "scene-2",
                "x": 1140,
                "y": 180,
                "width": 560,
                "height": 490,
            },
            {
                "label": "Другая сцена",
                "group": "scene-3",
                "x": 300,
                "y": 200,
                "width": 300,
                "height": 300,
            },
        ]
        self.assertEqual(CHECK(draft)["errors"], ["Заголовок перекрывает «Фигура»"])
        draft["text"][0]["width"] = 980
        self.assertEqual(CHECK(draft)["errors"], [])


if __name__ == "__main__":
    unittest.main()
