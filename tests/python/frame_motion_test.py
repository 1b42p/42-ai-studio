# /// script
# dependencies = ["numpy==2.2.6", "pillow==11.3.0"]
# ///
"""Render the motion reference in Chromium; run with uv and --remotion-project."""

import argparse
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image


REFERENCE = (
    Path(__file__).resolve().parents[2]
    / "agent/skills/frame-review/references/exercise-motion.tsx"
)
FRAMES = (53, 54, 66, 84, 102, 114, 115)
ENTRY = """
import {AbsoluteFill, Composition, Sequence, registerRoot, useCurrentFrame} from 'remotion';
import {Reach, Squat} from './exercise-motion';

function Scene({rigid}: {rigid: boolean}) {
  const frame = useCurrentFrame();
  const interval = rigid ? {startFrame: 400, endFrame: 460} : {startFrame: 30, endFrame: 90};
  return (
    <AbsoluteFill style={{background: '#f8faf4'}}>
      <Sequence from={24} layout="none">
        <AbsoluteFill style={{
          flexDirection: 'row',
          transform: rigid ? `translateY(${Math.round(8 * Math.sin(frame / 3))}px)` : undefined,
        }}>
          <div style={{width: 320, height: 320}}><Reach {...interval} /></div>
          <div style={{width: 320, height: 320}}><Squat {...interval} /></div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
}

registerRoot(() => <Composition id="Motion" component={Scene} defaultProps={{rigid: false}}
  width={640} height={320} fps={30} durationInFrames={130} />);
"""


def landmark_y(frame, box, color, *, edge=None):
    x0, y0, x1, y1 = box
    pixels = frame[y0:y1, x0:x1]
    ys, xs = np.where(np.max(np.abs(pixels - color), axis=2) <= 5)
    if not len(ys):
        raise AssertionError(f"Нет видимых пикселей опоры или сустава: {box}")
    if edge:
        return int(edge(ys)) + y0
    # The wrist is at the far end of the left arm, even when it points down.
    distances = (xs + x0 - 144) ** 2 + (ys + y0 - 142) ** 2
    return int(ys[np.argmax(distances)]) + y0


def observe(directory):
    reach, squat, feet = [], [], []
    for index in FRAMES:
        with Image.open(directory / f"element-{index:03}.png") as image:
            frame = np.asarray(image.convert("RGB"), dtype=np.int16)
        wrist = landmark_y(frame, (0, 30, 144, 258), (184, 100, 72))
        hip = landmark_y(frame, (410, 120, 475, 224), (56, 109, 85), edge=max)
        reach_foot = landmark_y(frame, (110, 263, 135, 305), (32, 60, 49), edge=max)
        squat_foot = landmark_y(frame, (471, 263, 505, 305), (32, 60, 49), edge=max)
        reach.append(reach_foot - wrist)
        squat.append(squat_foot - hip)
        feet.append((reach_foot, squat_foot))
    return reach, squat, feet


def progresses(gaps):
    start, on_cue, moving, peak, returning, end, after = gaps
    span = peak - start
    return (
        start == on_cue == end == after
        and span > 40
        and 0.2 * span < moving - start < 0.8 * span
        and 0.2 * span < returning - start < 0.8 * span
    )


def render(project, browser):
    with TemporaryDirectory(prefix="frame-motion-") as temp:
        work = Path(temp)
        (work / "node_modules").symlink_to(
            project / "node_modules", target_is_directory=True
        )
        (work / "index.tsx").write_text(ENTRY, encoding="utf-8")
        shutil.copyfile(REFERENCE, work / "exercise-motion.tsx")
        for scenario in ("motion", "rigid"):
            args = [
                "./node_modules/.bin/remotion",
                "render",
                "index.tsx",
                "Motion",
                scenario,
                "--frames=" + ",".join(map(str, FRAMES)),
                "--image-format=png",
                "--concurrency=2",
                "--log=error",
                '--props={"rigid":true}'
                if scenario == "rigid"
                else '--props={"rigid":false}',
            ]
            if browser:
                args.append(f"--browser-executable={browser}")
            subprocess.run(args, cwd=work, check=True)
            reach, squat, feet = observe(work / scenario)
            print(
                f"{scenario}: кисть–стопа {reach}, таз–стопа {squat}, опора {feet}",
                flush=True,
            )
            if scenario == "motion":
                assert progresses(reach), (
                    "Кисть не проходит видимые фазы относительно стопы"
                )
                assert progresses([-gap for gap in squat]), (
                    "Таз не проходит видимые фазы относительно стопы"
                )
                assert len(set(feet)) == 1, "Стопы смещаются"
            else:
                assert len(set(feet)) > 1, (
                    "Отрицательный контроль должен смещать фигуру"
                )
                assert max(reach) - min(reach) <= 1 and max(squat) - min(squat) <= 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remotion-project", type=Path, default=Path("/opt/remotion"))
    parser.add_argument("--browser-executable", type=Path)
    settings = parser.parse_args()
    render(settings.remotion_project.resolve(), settings.browser_executable)
