/**
 * Final / Cut — an exposed film gate, folded from one cinematic ribbon.
 * Original deterministic geometry; no textures or remote resources.
 * Rebuild: node scripts/landing/finale-export.mjs
 *          node scripts/landing/finale-render.mjs
 */
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { assembleKineticStage } from "./kinetic-sculpture.mjs";

export const finaleCamera = {
  position: [0, 0.5, 17],
  target: [0, -0.1, 0],
  fov: 34,
  near: 0.1,
  far: 100,
  aspect: 6 / 5,
};

function roundedPath(width, height, radius, Path = THREE.Shape) {
  const p = new Path();
  const x = -width / 2;
  const y = -height / 2;
  p.moveTo(x + radius, y);
  p.lineTo(-x - radius, y);
  p.quadraticCurveTo(-x, y, -x, y + radius);
  p.lineTo(-x, -y - radius);
  p.quadraticCurveTo(-x, -y, -x - radius, -y);
  p.lineTo(x + radius, -y);
  p.quadraticCurveTo(x, -y, x, -y - radius);
  p.lineTo(x, y + radius);
  p.quadraticCurveTo(x, y, x + radius, y);
  return p;
}

function gateGeometry(width, height, innerWidth, innerHeight, depth, perforated) {
  const shape = roundedPath(width, height, 0.6);
  shape.holes.push(roundedPath(innerWidth, innerHeight, 0.37, THREE.Path));
  if (perforated) {
    for (const y of [-height / 2 + 0.24, height / 2 - 0.24]) {
      for (let i = 0; i < 14; i++) {
        const hole = roundedPath(0.29, 0.13, 0.025, THREE.Path);
        // Transform control points rather than tessellating curved cut-outs twice.
        for (const curve of hole.curves) {
          for (const key of ["v0", "v1", "v2"]) {
            if (curve[key]) curve[key].add(new THREE.Vector2((i - 6.5) * 0.43, y));
          }
        }
        shape.holes.push(hole);
      }
    }
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments: 8,
    bevelEnabled: true,
    bevelThickness: perforated ? 0.035 : 0.09,
    bevelSize: perforated ? 0.035 : 0.09,
    bevelSegments: 3,
  });
  // Weld in the undeformed domain: averaging normals after bending would make
  // the sparse, irregular cap triangulation visible in specular reflections.
  // The cap has an exact normal, independent of its neighbouring bevel faces.
  geometry.deleteAttribute("uv");
  geometry.deleteAttribute("normal");
  const smooth = mergeVertices(geometry);
  smooth.computeVertexNormals();
  const positions = smooth.getAttribute("position");
  const normals = smooth.getAttribute("normal");
  const bevelThickness = perforated ? 0.035 : 0.09;
  const normal = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i) / (width / 2);
    const y = positions.getY(i) / (height / 2);
    const z = positions.getZ(i);
    normal.fromBufferAttribute(normals, i);
    if (Math.abs(z + bevelThickness) < 1e-5) normal.set(0, 0, -1);
    if (Math.abs(z - depth - bevelThickness) < 1e-5) normal.set(0, 0, 1);
    // Inverse-transpose Jacobian of [X, Y, Z + f(X,Y)], applied to both
    // the analytic cap normals and the smoothly welded undeformed bevels.
    const dx = (0.56 * x + 0.10 * Math.PI * Math.cos(x * Math.PI)) / (width / 2);
    const dy = 0.26 * y / (height / 2);
    normal.set(normal.x - dx * normal.z, normal.y - dy * normal.z, normal.z).normalize();
    normals.setXYZ(i, normal.x, normal.y, normal.z);
    positions.setZ(i, z + 0.28 * x * x + 0.13 * y * y
      + 0.10 * Math.sin(x * Math.PI));
  }
  return smooth;
}

/**
 * A closed, perforated sheet. Boundary faces include the inside walls of every
 * sprocket hole, so the film remains physical even at a grazing viewing angle.
 */
function foldedFilmGeometry() {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-5.1, -2.4, 1.8),
    new THREE.Vector3(-3.65, -3.05, 2.1),
    new THREE.Vector3(-1.8, -3.0, 2.25),
    new THREE.Vector3(0.2, -2.6, 2.0),
    new THREE.Vector3(2.5, -2.8, 1.65),
    new THREE.Vector3(3.9, -2.7, 1.0),
    new THREE.Vector3(4.4, -1.5, 0.2),
    new THREE.Vector3(4.45, 0.5, -0.55),
    new THREE.Vector3(4.2, 2.0, -0.8),
  ], false, "centripetal");
  const count = 192;
  const lanes = [-0.5, -0.455, -0.355, 0.355, 0.455, 0.5];
  const cells = [];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < lanes.length - 1; j++) {
      if ((j === 1 || j === 3) && i % 8 < 5) continue;
      cells.push([i, j]);
    }
  }
  const positions = [];
  const indices = [];
  const edgeMap = new Map();
  const points = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const p = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u);
    const across = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
    across.applyAxisAngle(tangent, -0.38 + 1.0 * Math.sin(u * Math.PI));
    const normal = new THREE.Vector3().crossVectors(tangent, across).normalize();
    for (const lane of lanes) {
      points.push(p.clone().addScaledVector(across, lane * 1.02)
        .addScaledVector(normal, lane * lane * 0.14));
      for (const side of [-1, 1]) {
        const v = points.at(-1).clone().addScaledVector(normal, side * 0.035);
        positions.push(v.x, v.y, v.z);
      }
    }
  }
  function boundary(a, b) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edgeMap.has(key)) edgeMap.delete(key);
    else edgeMap.set(key, [a, b]);
  }
  for (const [i, j] of cells) {
    const a = i * lanes.length + j;
    const b = a + lanes.length;
    const polygon = [a, b, b + 1, a + 1];
    for (const side of [0, 1]) {
      const q = polygon.map((v) => v * 2 + side);
      if (side === 0) q.reverse();
      indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }
    polygon.forEach((v, n) => boundary(v, polygon[(n + 1) % 4]));
  }
  for (const [a, b] of edgeMap.values()) {
    const start = positions.length / 3;
    for (const index of [a * 2, a * 2 + 1, b * 2 + 1, b * 2]) {
      positions.push(...positions.slice(index * 3, index * 3 + 3));
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function createFinaleSculpture(theme = "dark") {
  const dark = theme !== "light";
  const physical = (name, color, metalness, roughness, extras = {}) =>
    new THREE.MeshPhysicalMaterial({
      name: `finale-${theme}-${name}`,
      color, metalness, roughness,
      clearcoat: 0.75,
      clearcoatRoughness: 0.18,
      envMapIntensity: dark ? 1.3 : 1.1,
      ...extras,
    });
  const pearl = physical("pearl", dark ? "#fff0d5" : "#e9dfcc", 0.42, 0.24, {
    iridescence: 0.22,
    iridescenceThicknessRange: [180, 280],
  });
  const bronze = physical("bronze", dark ? "#cd9766" : "#aa7047", 0.79, 0.26);
  const orange = physical("orange", dark ? "#ff9d38" : "#f48025", 0.65, 0.24);
  const root = new THREE.Group();
  root.name = "Final-Cut";
  root.rotation.set(0.16, -0.39, -0.12);
  root.userData = { kind: "finale", motionPhase: 0, nativeAspect: finaleCamera.aspect };
  function part(name, geometry, material, position, kind, phase) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { kind, motionPhase: phase, restPosition: [...position] };
    root.add(mesh);
    return mesh;
  }
  // The pearl face and bronze return share their actual through-perforations.
  const gate = gateGeometry(7.2, 4.9, 5.75, 3.25, 0.7, true);
  part("Pearl-emulsion", gate, [pearl, bronze], [0, 0, 0], "gate", 0);
  // A recessed amber light well: broad bevel catches a continuous softbox.
  part("Amber-light-well", gateGeometry(6.0, 3.5, 5.55, 3.05, 0.38, false),
    orange, [0, 0, -0.39], "light-well", 0.8);
  part("Unspooling-last-take", foldedFilmGeometry(), orange,
    [0, 0, 0], "film", 1.6);
  return root;
}

export function assembleFinaleStage(renderer, theme, sculpture, environment) {
  sculpture.traverse((part) => {
    if (part.isMesh) part.castShadow = part.receiveShadow = true;
  });
  const stage = assembleKineticStage(renderer, theme, sculpture, environment);
  stage.scene.background = null;
  renderer.setClearColor(0x000000, 0);
  renderer.toneMappingExposure = theme === "light" ? 1.05 : 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const key = stage.scene.children.find((child) => child.isDirectionalLight);
  if (key) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -7, right: 7, top: 6, bottom: -6 });
    key.shadow.normalBias = 0.035;
    key.shadow.bias = -0.0003;
    key.shadow.radius = 4;
  }
  const camera = new THREE.PerspectiveCamera(
    finaleCamera.fov, finaleCamera.aspect, finaleCamera.near, finaleCamera.far,
  );
  camera.position.set(...finaleCamera.position);
  camera.lookAt(...finaleCamera.target);
  return { scene: stage.scene, camera, sculpture };
}

export function animateFinaleSculpture(sculpture, seconds) {
  sculpture.traverse((part) => {
    const { kind, motionPhase = 0, restPosition } = part.userData;
    if (kind !== "film" || !restPosition) return;
    const offset = Math.sin(seconds * 0.23 + motionPhase) - Math.sin(motionPhase);
    part.position.y = restPosition[1] + offset * 0.026;
    part.rotation.z = offset * 0.003;
  });
}
