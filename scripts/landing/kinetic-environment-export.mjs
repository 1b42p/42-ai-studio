/**
 * Bake the original local studio's complete r180 PMREM, including HDR and all LODs.
 * Run: node scripts/landing/kinetic-environment-export.mjs
 * Requires the project's existing Playwright Chromium; no running app is needed.
 * KPM1: 16-byte LE header (magic, Three revision, width, height), RGBA binary16 LE,
 * bottom row first, gzip. The browser loads these exact /landing/*.bin.gz files.
 * Regenerate both files when changing the studio or upgrading Three.js.
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { REVISION } from "three";

if (REVISION !== "180") throw new Error("The CubeUV asset format is pinned to Three.js r180.");

const routes = new Map([
  ["/three.module.js", new URL("../../node_modules/three/build/three.module.js", import.meta.url)],
  ["/three.core.js", new URL("../../node_modules/three/build/three.core.js", import.meta.url)],
  ["/sculpture.mjs", new URL("../../lib/landing/kinetic-sculpture.mjs", import.meta.url)],
]);
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<script type="importmap">{"imports":{"three":"/three.module.js"}}</script>`);
      return;
    }
    const path = routes.get(request.url);
    if (!path) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path));
  } catch {
    response.writeHead(500).end();
  }
});

let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const theme of ["light", "dark"]) {
    const { width, height, base64 } = await page.evaluate(async (theme) => {
      const THREE = await import("three");
      const { createKineticEnvironment } = await import("/sculpture.mjs");
      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
      let target;
      try {
        target = createKineticEnvironment(renderer, theme);
        const { width, height } = target;
        const pixels = new Uint16Array(width * height * 4);
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
        if (!pixels.some((value) => value > 0x3c00 && value < 0x7c00)) {
          throw new Error("PMREM readback lost HDR values.");
        }
        const bytes = new Uint8Array(pixels.length * 2);
        const view = new DataView(bytes.buffer);
        pixels.forEach((value, index) => view.setUint16(index * 2, value, true));
        const chunks = [];
        for (let start = 0; start < bytes.length; start += 32768) {
          chunks.push(String.fromCharCode(...bytes.subarray(start, start + 32768)));
        }
        return { width, height, base64: btoa(chunks.join("")) };
      } finally {
        target?.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
      }
    }, theme);
    const header = Buffer.alloc(16);
    header.write("KPM1");
    header.writeUInt32LE(Number(REVISION), 4);
    header.writeUInt32LE(width, 8);
    header.writeUInt32LE(height, 12);
    const raw = Buffer.concat([header, Buffer.from(base64, "base64")]);
    const gzip = gzipSync(raw, { level: 9 });
    const name = `kinetic-${theme}-pmrem-r180.bin.gz`;
    await writeFile(new URL(`../../public/landing/${name}`, import.meta.url), gzip);
    console.log(`${name}: ${width}×${height}, ${raw.length} → ${gzip.length} bytes, sha256 ${createHash("sha256").update(gzip).digest("hex")}`);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
