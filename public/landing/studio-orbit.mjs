/**
 * Original 42 AI Studio sculpture. Rebuild: node public/landing/studio-orbit.mjs
 * Geometry only; no downloaded models, textures, fonts, or environments.
 */
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { writeFile } from "node:fs/promises";

// GLTFExporter's browser Blob reader, backed by Node's native Blob.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};

const scene = new THREE.Scene();
scene.name = "42 AI Studio — motion atelier";
const sculpture = new THREE.Group();
scene.add(sculpture);
const materials = {
  orange: new THREE.MeshPhysicalMaterial({
    name: "warm-orange-enamel",
    color: "#ff651c",
    metalness: 0.36,
    roughness: 0.24,
    clearcoat: 1,
    clearcoatRoughness: 0.18,
  }),
  chrome: new THREE.MeshStandardMaterial({
    name: "brushed-silver",
    color: "#e0e2e5",
    metalness: 0.88,
    roughness: 0.2,
  }),
  graphite: new THREE.MeshStandardMaterial({
    name: "graphite-film",
    color: "#252932",
    metalness: 0.4,
    roughness: 0.35,
  }),
  porcelain: new THREE.MeshStandardMaterial({
    name: "porcelain",
    color: "#fff4e8",
    metalness: 0.12,
    roughness: 0.34,
  }),
  amber: new THREE.MeshStandardMaterial({
    name: "amber-highlight",
    color: "#ffb763",
    metalness: 0.2,
    roughness: 0.3,
  }),
};

function mesh(geometry, material, parent = sculpture) {
  const object = new THREE.Mesh(geometry, material);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

function box(w, h, d, radius, material, parent) {
  return mesh(new RoundedBoxGeometry(w, h, d, 1, radius), material, parent);
}

function playShape(size) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.68 * size, -0.91 * size);
  shape.quadraticCurveTo(-0.85 * size, -1.01 * size, -0.85 * size, -0.79 * size);
  shape.lineTo(-0.85 * size, 0.79 * size);
  shape.quadraticCurveTo(-0.85 * size, 1.01 * size, -0.68 * size, 0.91 * size);
  shape.lineTo(0.86 * size, 0.12 * size);
  shape.quadraticCurveTo(1.08 * size, 0, 0.86 * size, -0.12 * size);
  shape.closePath();
  return shape;
}

const play = new THREE.Group();
play.name = "sculpted-play";
play.position.set(0.1, 0.15, 0.4);
play.rotation.set(-0.08, -0.3, -0.13);
sculpture.add(play);
const silver = mesh(
  new THREE.ExtrudeGeometry(playShape(1.17), {
    depth: 0.48, bevelEnabled: true, bevelThickness: 0.12,
    bevelSize: 0.1, bevelSegments: 6, curveSegments: 20,
  }),
  materials.chrome,
  play,
);
silver.position.z = -0.27;
const enamel = mesh(
  new THREE.ExtrudeGeometry(playShape(1.06), {
    depth: 0.4, bevelEnabled: true, bevelThickness: 0.11,
    bevelSize: 0.09, bevelSegments: 6, curveSegments: 20,
  }),
  materials.orange,
  play,
);
enamel.position.z = 0.02;

// A continuous, spatial film loop. Its frame surfaces follow the same path.
const start = -Math.PI * 0.92;
const end = Math.PI * 0.99;
function point(t, edge = 0) {
  return new THREE.Vector3(
    2.65 * Math.cos(t),
    1.4 * Math.sin(t) + edge,
    -0.55 + 1.25 * Math.sin(t + 0.6),
  );
}

const film = new THREE.Group();
film.name = "spatial-cinema-ribbon";
film.rotation.z = -0.2;
sculpture.add(film);

for (const edge of [-0.49, 0.49]) {
  const curve = new THREE.CatmullRomCurve3(
    Array.from({ length: 100 }, (_, i) => point(start + (end - start) * i / 99, edge)),
  );
  mesh(new THREE.TubeGeometry(curve, 160, 0.026, 6, false), materials.chrome, film);
}

const panelCount = 13;
for (let i = 0; i < panelCount; i++) {
  const t0 = start + (end - start) * i / panelCount;
  const t1 = start + (end - start) * (i + 1) / panelCount;
  const mid = (t0 + t1) / 2;
  const position = point(mid);
  const tangent = point(mid + 0.01).sub(point(mid - 0.01)).normalize();
  const panel = new THREE.Group();
  panel.name = `film-frame-${i + 1}`;
  panel.position.copy(position);
  // Keep each portrait of motion upright as the film passes around the sculpture.
  panel.rotation.y = -Math.atan2(tangent.z, Math.abs(tangent.x) + 0.4) * 0.6;
  panel.rotation.z = Math.atan2(tangent.y, tangent.x) + (tangent.x < 0 ? Math.PI : 0);
  film.add(panel);
  const width = point(t1).distanceTo(point(t0)) + 0.065;
  box(width, 0.94, 0.055, 0.035, materials.graphite, panel);
  const screen = box(width - 0.1, 0.64, 0.025, 0.025,
    i % 3 === 0 ? materials.orange : materials.porcelain, panel);
  screen.position.z = 0.045;

  // Original graphic studies: waveform, horizon, editorial motion bars.
  const ink = i % 3 === 0 ? materials.porcelain : materials.orange;
  if (i % 3 === 1) {
    for (let n = 0; n < 9; n++) {
      const bar = box(0.035, 0.1 + 0.32 * Math.abs(Math.sin(n * 1.7 + i)),
        0.02, 0.012, ink, panel);
      bar.position.set((n - 4) * (width - 0.2) / 10, 0, 0.075);
    }
  } else if (i % 3 === 2) {
    const disc = mesh(new THREE.CircleGeometry(0.16, 32), ink, panel);
    disc.position.set(-width * 0.14, 0.08, 0.075);
    const horizon = box(width - 0.2, 0.08, 0.022, 0.012, materials.graphite, panel);
    horizon.position.set(0, -0.18, 0.08);
  } else {
    for (let n = 0; n < 3; n++) {
      const bar = box((width - 0.22) * (1 - n * 0.18), 0.055,
        0.022, 0.015, ink, panel);
      bar.position.set(-n * 0.025, 0.13 - n * 0.13, 0.075);
    }
  }
  for (const y of [-0.4, 0.4]) {
    for (let n = 0; n < 4; n++) {
      const hole = box(0.055, 0.055, 0.012, 0.008, materials.porcelain, panel);
      hole.position.set((n - 1.5) * (width - 0.14) / 4, y, 0.035);
    }
  }
}

// Two orbital editing tracks, deliberately offset rather than generic spheres.
for (const [radius, thickness, shift] of [[3.07, 0.018, -0.1], [3.22, 0.009, 0.1]]) {
  const points = Array.from({ length: 121 }, (_, i) => {
    const t = -2.9 + i / 120 * 4.65;
    return new THREE.Vector3(radius * Math.cos(t), 0.78 * Math.sin(t) - 0.1,
      0.8 * Math.sin(t) - 0.9 + shift);
  });
  const orbit = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),
    120, thickness, 5, false), materials.orange);
  orbit.rotation.z = 0.4;
}

// A timeline shuttle and two floating edit marks, not decorative random particles.
const shuttle = new THREE.Group();
shuttle.position.set(2.26, -0.58, 0.2);
shuttle.rotation.set(0.1, -0.15, -0.23);
sculpture.add(shuttle);
box(0.72, 0.46, 0.15, 0.09, materials.chrome, shuttle);
for (let i = 0; i < 3; i++) {
  const marker = box(0.065, 0.2, 0.03, 0.02, materials.orange, shuttle);
  marker.position.set(-0.16 + i * 0.16, 0, 0.095);
}
const tick = box(0.11, 0.52, 0.11, 0.04, materials.orange);
tick.position.set(-2.15, 1.48, 0.3);
tick.rotation.z = -0.5;
const tick2 = box(0.11, 0.27, 0.11, 0.04, materials.chrome);
tick2.position.set(-1.92, 1.68, 0.3);
tick2.rotation.z = -0.5;

// Merge equal-material meshes: retain sculpture detail without hundreds of draw calls.
scene.updateMatrixWorld(true);
const buckets = new Map();
sculpture.traverse((object) => {
  if (!object.isMesh) return;
  const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
  if (geometry.index) geometry.setIndex(geometry.index.clone());
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const bucket = buckets.get(object.material) ?? [];
  bucket.push(nonIndexed);
  buckets.set(object.material, bucket);
});
scene.remove(sculpture);
for (const [material, geometries] of buckets) {
  const merged = new THREE.Mesh(mergeVertices(mergeGeometries(geometries)), material);
  merged.name = material.name;
  scene.add(merged);
}
const output = await new GLTFExporter().parseAsync(scene, {
  binary: true,
  copyright: "42 AI Studio — original procedural sculpture",
});
await writeFile(new URL("./studio-orbit.glb", import.meta.url), Buffer.from(output));
console.log(`studio-orbit.glb: ${(output.byteLength / 1024).toFixed(0)} KiB`);
