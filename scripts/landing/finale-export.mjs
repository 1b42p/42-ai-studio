/** Rebuild GLBs: node scripts/landing/finale-export.mjs */
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { writeFile } from "node:fs/promises";
import { createFinaleSculpture } from "../../lib/landing/finale-sculpture.mjs";

globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};

for (const theme of ["light", "dark"]) {
  const scene = new THREE.Scene();
  scene.add(createFinaleSculpture(theme));
  const output = await new GLTFExporter().parseAsync(scene, {
    binary: true,
    copyright: "42 AI Studio — original Final / Cut procedural sculpture",
  });
  if (output.byteLength > 700 * 1024) throw new Error(`${theme} GLB exceeds 700 KiB`);
  await writeFile(new URL(`../../public/landing/finale-${theme}.glb`, import.meta.url),
    Buffer.from(output));
  console.log(`finale-${theme}.glb: ${Math.round(output.byteLength / 1024)} KiB`);
}
