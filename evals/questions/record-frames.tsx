import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Coffee } from "../fixtures/questions/Coffee";
import {
  frameDirectory, frameName, framePasses, questionDurations, questionProjectPath, questionProps,
  questionSources, reviewFrames, sha256, snapshotBinding,
  type PropsVersion, type QuestionFrame, type QuestionSnapshot,
} from "./media-fixture";

const browserFlag = process.argv.indexOf("--browser");
const executablePath = browserFlag < 0 ? undefined : process.argv[browserFlag + 1];
const samplesFlag = process.argv.indexOf("--samples");
const samples = samplesFlag < 0 ? undefined : process.argv[samplesFlag + 1];
const require = createRequire(import.meta.url);
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const frames: QuestionFrame[] = [];
const snapshots: QuestionSnapshot[] = [];
type Bounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
try {
  if (samples) mkdirSync(samples, { recursive: true });
  for (const seconds of questionDurations) for (const version of [1, 2] as PropsVersion[]) {
    const sourceSha256 = sha256(JSON.stringify(questionSources(seconds)));
    const propsSha256 = sha256(questionProps(version));
    const rendered: Omit<QuestionFrame, "pass" | "path">[] = [];
    for (const frame of reviewFrames(seconds)) {
      const scene = Math.min(2, Math.floor(frame / (seconds * 10)));
      const { title } = JSON.parse(questionProps(version)) as { title: string };
      await page.setContent("<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0\">" +
        renderToStaticMarkup(<Coffee scene={scene} frame={frame} title={title} />) + "</body></html>");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const layout = await page.evaluate(() => {
        const text = [...document.querySelectorAll("div")].filter(element =>
          [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()));
        return { drawing: document.querySelector("svg")!.getBoundingClientRect().toJSON() as Bounds,
          text: text.map(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return { content: element.textContent, fontSize: parseFloat(getComputedStyle(element).fontSize),
              box: element.getBoundingClientRect().toJSON() as Bounds,
              scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
              scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
              lines: [...range.getClientRects()].map(rect => rect.toJSON() as Bounds) };
          }) };
      });
      if (layout.text.length !== 2) throw new Error("Ожидались заголовок и пояснение.");
      const ratio = 1920 / 1080;
      for (const [index, text] of layout.text.entries()) {
        const minimum = (index === 0 ? 84 : 44) * ratio;
        const box = text.box;
        if (text.fontSize < minimum || box.left < 80 * ratio || box.right > 1920 - 80 * ratio ||
          box.top < 100 * ratio || box.bottom > 1080 - 100 * ratio ||
          text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight) {
          throw new Error(`Небезопасная типографика: ${JSON.stringify(text)}`);
        }
      }
      const overlaps = (a: Bounds, b: Bounds) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      if (layout.text[0].lines.some(title => layout.text[1].lines.some(body => overlaps(title, body))) ||
        layout.text.some(text => text.lines.some(line => overlaps(line, layout.drawing)))) {
        throw new Error("Текст пересекается с пояснением или иллюстрацией.");
      }
      const image = await page.screenshot({ type: "jpeg", quality: 90, animations: "disabled" });
      const base64 = image.toString("base64");
      const decoded = await page.evaluate(async (value) => {
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
        return { width: image.width, height: image.height, extrema };
      }, base64);
      rendered.push({ seconds, version, frame, scene, composition: "Main", sourceSha256, propsSha256,
        ...decoded, size: image.length, sha256: sha256(image), base64 });
      if (samples && [0, seconds * 10, seconds * 15].includes(frame)) {
        writeFileSync(join(samples, `${seconds}s-v${version}-${frameName(seconds, frame)}`), image);
      }
    }
    const recorded = framePasses(version).flatMap(pass => rendered.map(frame => ({
      ...frame, pass, path: `${questionProjectPath(seconds)}/${frameDirectory(version, pass)}/${frameName(seconds, frame.frame)}`,
    })));
    frames.push(...recorded);
    snapshots.push({ seconds, version, composition: "Main", sourceSha256, propsSha256,
      fingerprint: sha256(JSON.stringify(snapshotBinding(seconds, version, recorded))) });
  }
  const recording = { schemaVersion: 2, renderer: {
    kind: "react-dom/server+playwright", react: require("react/package.json").version,
    reactDom: require("react-dom/package.json").version, playwright: require("playwright/package.json").version,
    browser: browser.version(), jpegQuality: 90,
  }, snapshots, frames };
  writeFileSync(new URL("../fixtures/questions/frames.json", import.meta.url), JSON.stringify(recording) + "\n");
  console.log(JSON.stringify({ frames: frames.length, snapshots, renderer: recording.renderer }, null, 2));
} finally {
  await browser.close();
}
