/**
 * Transparent 1440×1200 posters and optional background proofs.
 * node scripts/landing/finale-render.mjs [--proof-dir /tmp/opencode/finale]
 * Uses an isolated ephemeral HTTP server, never the running application.
 */
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const directory = path.dirname(fileURLToPath(import.meta.url));
const threeDirectory = path.dirname(fileURLToPath(import.meta.resolve("three")));
const addons = path.resolve(threeDirectory, "../examples/jsm");
const proofIndex = process.argv.indexOf("--proof-dir");
const proofDirectory = proofIndex < 0 ? null : process.argv[proofIndex + 1];
if (proofIndex >= 0 && !proofDirectory) throw new Error("--proof-dir requires a directory");
if (proofDirectory) await mkdir(proofDirectory, { recursive: true });
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/three.module.js","three/addons/":"/addons/"}}</script>
</head><body><script type="module">
import * as THREE from "three";
import {GLTFLoader} from "/addons/loaders/GLTFLoader.js";
import {createKineticEnvironment} from "/kinetic-sculpture.mjs";
import {assembleFinaleStage} from "/finale-sculpture.mjs";
const theme=new URLSearchParams(location.search).get("theme");
const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(2);
renderer.setSize(1440,1200);
document.body.append(renderer.domElement);
const environment=createKineticEnvironment(renderer,theme);
const gltf=await new GLTFLoader().loadAsync("/finale-"+theme+".glb");
const sculpture=gltf.scene.getObjectByName("Final-Cut");
const stage=assembleFinaleStage(renderer,theme,sculpture,environment.texture);
renderer.render(stage.scene,stage.camera);
window.ready=true;
</script></body></html>`;

const allowed = {
  "/kinetic-sculpture.mjs": path.resolve(directory, "../../lib/landing/kinetic-sculpture.mjs"),
  "/finale-sculpture.mjs": path.resolve(directory, "../../lib/landing/finale-sculpture.mjs"),
  "/three/three.module.js": path.join(threeDirectory, "three.module.js"),
  "/three/three.core.js": path.join(threeDirectory, "three.core.js"),
  "/addons/utils/BufferGeometryUtils.js": path.join(addons, "utils/BufferGeometryUtils.js"),
  "/addons/loaders/GLTFLoader.js": path.join(addons, "loaders/GLTFLoader.js"),
  "/finale-light.glb": path.resolve(directory, "../../public/landing/finale-light.glb"),
  "/finale-dark.glb": path.resolve(directory, "../../public/landing/finale-dark.glb"),
};
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  try {
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    } else if (allowed[pathname]) {
      response.setHeader("Content-Type", pathname.endsWith(".glb")
        ? "model/gltf-binary" : "text/javascript; charset=utf-8");
      response.end(await readFile(allowed[pathname]));
    } else response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
  }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  for (const theme of ["light", "dark"]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.waitForFunction(() => window.ready === true);
    if (errors.length) throw errors[0];
    const pixels = await page.screenshot({ omitBackground: true });
    const output = path.resolve(directory, `../../public/landing/finale-${theme}.webp`);
    await sharp(pixels).webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(output);
    const { size } = await stat(output);
    if (size > 250 * 1024) throw new Error(`${theme} poster exceeds 250 KiB`);
    if (proofDirectory) {
      await sharp(output).flatten({ background: theme === "light" ? "#cb3200" : "#9f2d00" })
        .png().toFile(path.join(proofDirectory, `finale-${theme}-primary.png`));
      await sharp(output).resize(390, 325)
        .flatten({ background: theme === "light" ? "#cb3200" : "#9f2d00" })
        .png().toFile(path.join(proofDirectory, `finale-${theme}-phone.png`));
    }
    console.log(`${output}: 1440×1200, ${Math.round(size / 1024)} KiB, transparent`);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
