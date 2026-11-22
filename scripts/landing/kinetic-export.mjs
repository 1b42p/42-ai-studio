/** Rebuild GLBs: node scripts/landing/kinetic-export.mjs */
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { writeFile } from "node:fs/promises";
import { createKineticSculpture } from "../../lib/landing/kinetic-sculpture.mjs";

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
  scene.add(createKineticSculpture(theme));
  const output = await new GLTFExporter().parseAsync(scene, {
    binary: true,
    copyright: "42 AI Studio — original Light / Cut procedural sculpture",
  });
  await writeFile(new URL(`../../public/landing/kinetic-${theme}.glb`, import.meta.url), Buffer.from(output));
  console.log(`kinetic-${theme}.glb: ${Math.round(output.byteLength / 1024)} KiB`);
}
