import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { Coffee } from "../fixtures/questions/Coffee";

const browserFlag = process.argv.indexOf("--browser");
const executablePath = browserFlag < 0 ? undefined : process.argv[browserFlag + 1];
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const frames = [];
try {
  for (const corrected of [false, true]) {
    for (const [index, fraction] of [0, 1 / 12, 1 / 3 - 1 / 3600, 1 / 3, 1 / 2, 2 / 3, 5 / 6, 3599 / 3600].entries()) {
      const frame = Math.round(fraction * 3600);
      const scene = Math.min(2, Math.floor(frame / 1200));
      await page.setContent("<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0\">" +
        renderToStaticMarkup(<Coffee scene={scene} frame={frame} title={corrected ? "Утро начинается с кофе" : undefined} />) + "</body></html>");
      const image = await page.screenshot({ type: "jpeg", quality: 80 });
      const base64 = image.toString("base64");
      const extrema = await page.evaluate(async (value) => {
        const image = new Image();
        image.src = "data:image/jpeg;base64," + value;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const extrema = [[255, 0], [255, 0], [255, 0]];
        for (let offset = 0; offset < pixels.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
          extrema[channel][0] = Math.min(extrema[channel][0], pixels[offset + channel]);
          extrema[channel][1] = Math.max(extrema[channel][1], pixels[offset + channel]);
        }
        return extrema;
      }, base64);
      frames.push({ index, corrected, path: `/workspace/questions-fixtures/${corrected ? "corrected" : "original"}-${index}.jpeg`, width: 1920, height: 1080, size: image.length, base64, extrema });
    }
  }
  writeFileSync("evals/fixtures/questions/frames.json", JSON.stringify({ frames }) + "\n");
  console.log("Recorded", frames.length, "matching composition frames");
} finally {
  await browser.close();
}
