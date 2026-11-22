/**
 * Rebuild the matching 1920×1080 posters from the original Three.js stage.
 * Run from the repository: node scripts/landing/kinetic-render.mjs
 * Uses the project's existing Playwright and Sharp; does not touch the app server.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const directory = path.dirname(fileURLToPath(import.meta.url));
const threeDirectory = path.dirname(fileURLToPath(import.meta.resolve("three")));
const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script>
</head><body><script type="module">
import * as THREE from "three";
import { createKineticStage } from "/kinetic-sculpture.mjs";
const theme = new URLSearchParams(location.search).get("theme");
const renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(2);
renderer.setSize(1920,1080);
document.body.append(renderer.domElement);
const {scene,camera}=createKineticStage(renderer,theme);
renderer.render(scene,camera);
window.ready=true;
</script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const allowed = {
    "/kinetic-sculpture.mjs": path.resolve(directory, "../../lib/landing/kinetic-sculpture.mjs"),
    "/three/three.module.js": path.join(threeDirectory, "three.module.js"),
    "/three/three.core.js": path.join(threeDirectory, "three.core.js"),
  };
  try {
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    } else if (allowed[pathname]) {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(await readFile(allowed[pathname]));
    } else {
      response.writeHead(404).end();
    }
  } catch {
    response.writeHead(500).end();
  }
});

let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => { throw error; });
  for (const theme of ["light", "dark"]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.waitForFunction(() => window.ready === true);
    const pixels = await page.screenshot();
    const output = path.resolve(directory, `../../public/landing/kinetic-${theme}.webp`);
    await sharp(pixels).webp({ quality: 88, effort: 6 }).toFile(output);
    const { width, height } = await sharp(output).metadata();
    const { size } = await stat(output);
    if (size > 250 * 1024) throw new Error(`${theme} poster exceeds 250 KiB`);
    console.log(`${output}: ${width}×${height}, ${Math.round(size / 1024)} KiB`);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
