/**
 * 42 AI Studio — Light / Cut.
 * Original, deterministic geometry. No downloaded textures or models.
 *
 * Rebuild geometry: node scripts/landing/kinetic-export.mjs
 * Browser/bundler API: createKineticSculpture(theme), createKineticStage(renderer, theme).
 * Native framing: 16:9, perspective 32°, position [0, 0.4, 21], target [0, 0, 0].
 * Do not center/normalize the sculpture: its negative space is intentional.
 */
import * as THREE from "three";
import { poseSculpturePart, sculpturePhase } from "./sculpture-motion.mjs";

export const kineticCamera = {
  position: [0, 0.4, 21],
  target: [0, 0, 0],
  fov: 32,
  near: 0.1,
  far: 100,
};

const palettes = {
  dark: {
    background: "#100d0c",
    orange: "#f07824",
    bronze: "#9c5b36",
    pearl: "#e9d7c5",
    edge: "#ffc48b",
    fill: 0.18,
    exposure: 1.15,
  },
  light: {
    background: "#f7f3ed",
    orange: "#f07824",
    bronze: "#986044",
    pearl: "#d1bc9e",
    edge: "#d69661",
    fill: 0.3,
    exposure: 0.95,
  },
};

// The strip bends through an editorial S, then folds back on itself.
// Each layer has a distinct sweep, not concentric toruses or a logo.
const paths = [
  {
    name: "01-orange-cut",
    color: "orange",
    width: 2.12,
    twist: 0.2,
    points: [
      [-12, -7.2, 0.8], [-5, -4.6, 1.4], [0.4, -3.8, 2.8],
      [5.7, -2.3, 2.3], [7.4, 0.1, 0.2], [6.5, 3.4, -0.2],
      [4.2, 4.3, 1.1], [2.6, 2.5, 2.3], [3.9, 0.6, 3.2],
      [7.4, -0.9, 3.8], [12, -0.5, 4.5],
    ],
  },
  {
    name: "02-pearl-splice",
    color: "pearl",
    width: 1.5,
    twist: 1.1,
    points: [
      [-11, -7.3, -0.1], [-4, -5.1, 0.1], [2, -3.6, -0.8],
      [5.6, -0.3, -1.7], [4.9, 3.7, -2.0], [6.1, 5.8, -2.4],
      [8.4, 5.2, -1.2], [10.1, 2.7, 0.3], [9.7, 0.0, 2.7],
      [7.2, -2.1, 4.6], [3.3, -5.7, 5.2], [-1, -10, 5.4],
    ],
  },
  {
    name: "03-bronze-memory",
    color: "bronze",
    width: 2.15,
    twist: -0.6,
    points: [
      [-9, -7, -2], [-2, -4.9, -2], [4, -3.1, -2.5],
      [8.3, -0.2, -3], [8.7, 3.5, -2.7], [6.3, 6.2, -2.1],
      [3.5, 5.0, -2], [2.9, 2.9, -1.4], [4.6, 1.5, -0.9],
      [8.4, 1.6, -0.5], [16, 5.5, -0.2],
    ],
  },
  {
    name: "04-orange-foreground",
    color: "orange",
    width: 0.85,
    twist: 1.7,
    points: [
      [-10, -8, 3], [-4, -6, 3.7], [2, -4.3, 4],
      [7, -3.0, 4.2], [10, -0.8, 3.8], [11.3, 2.3, 2.8],
      [10.4, 6, 1.4],
    ],
  },
];

function stripGeometry(path, width, twist, edgeOnly = false) {
  const lengthSegments = 432;
  // Two outer rails, two perforation lanes, and a wide uninterrupted emulsion.
  const lanes = [-0.5, -0.466, -0.409, -0.37, -0.25, 0, 0.25, 0.37, 0.409, 0.466, 0.5];
  const curve = new THREE.CatmullRomCurve3(
    path.map((point) => new THREE.Vector3(...point)), false, "centripetal", 0.5,
  );
  const positions = [];
  const indices = [];
  const uvs = [];
  const up = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i <= lengthSegments; i++) {
    const u = i / lengthSegments;
    const center = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u);
    const lateral = new THREE.Vector3().crossVectors(up, tangent).normalize();
    const binormal = new THREE.Vector3().crossVectors(tangent, lateral).normalize();
    const angle = twist + 1.15 * Math.sin(u * Math.PI * 2.2 - 0.5)
      + 0.4 * Math.sin(u * Math.PI * 5);
    const across = lateral.multiplyScalar(Math.cos(angle))
      .addScaledVector(binormal, Math.sin(angle));
    const normal = new THREE.Vector3().crossVectors(tangent, across).normalize();
    for (const v of lanes) {
      // A subtle cupped cross section gives the strips a polished, physical edge.
      const p = center.clone().addScaledVector(across, width * v)
        .addScaledVector(normal, 0.09 * Math.pow(v * 2, 2));
      positions.push(p.x, p.y, p.z);
      uvs.push(u * 20, v + 0.5);
    }
  }
  for (let i = 0; i < lengthSegments; i++) {
    for (let j = 0; j < lanes.length - 1; j++) {
      const perforation = j === 1 || j === 8;
      const hole = perforation && i % 6 < 4;
      const edge = j === 0 || j === 9;
      if (hole || (edgeOnly ? !edge : edge)) continue;
      const a = i * lanes.length + j;
      const b = a + lanes.length;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // Compact unused lanes from the separate rails/emulsion meshes.
  const remap = new Map();
  const compactPositions = [];
  const compactUvs = [];
  const compactIndices = indices.map((oldIndex) => {
    if (!remap.has(oldIndex)) {
      remap.set(oldIndex, remap.size);
      compactPositions.push(...positions.slice(oldIndex * 3, oldIndex * 3 + 3));
      compactUvs.push(...uvs.slice(oldIndex * 2, oldIndex * 2 + 2));
    }
    return remap.get(oldIndex);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(compactPositions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(compactUvs, 2));
  geometry.setIndex(compactIndices);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute("normal");
  for (let i = 0; i < normals.count; i++) {
    if (normals.getX(i) === 0 && normals.getY(i) === 0 && normals.getZ(i) === 0) {
      normals.setXYZ(i, 0, 0, 1);
    }
  }
  geometry.computeBoundingSphere();
  return geometry;
}

export function createKineticSculpture(theme = "dark") {
  const p = palettes[theme] ?? palettes.dark;
  const group = new THREE.Group();
  group.name = "Light-Cut";
  group.position.x = -0.8;
  const materials = {};
  for (const color of ["orange", "bronze", "pearl"]) {
    materials[color] = new THREE.MeshPhysicalMaterial({
      name: `kinetic-${theme}-${color}`,
      color: p[color],
      metalness: color === "pearl" ? 0.35 : 0.68,
      roughness: color === "pearl" ? 0.29 : 0.33,
      clearcoat: 0.65,
      clearcoatRoughness: 0.22,
      side: THREE.DoubleSide,
      iridescence: color === "pearl" ? 0.14 : 0,
      iridescenceThicknessRange: [160, 240],
    });
  }
  const edgeMaterial = new THREE.MeshStandardMaterial({
    name: `kinetic-${theme}-cut-edges`,
    color: p.edge,
    metalness: 0.8,
    roughness: 0.24,
    side: THREE.DoubleSide,
  });
  paths.forEach((path, index) => {
    // Separate physical sheets: no interpenetrating ribbons at the close crop.
    const depth = [0.5, -2.5, -5.0, 5.6][index];
    const points = path.points.map(([x, y, z]) => [
      x, y, depth + z * (index === 0 ? 0.85 : 0.08),
    ]);
    const ribbon = new THREE.Group();
    ribbon.name = path.name;
    ribbon.userData.motionPhase = index * 1.1;
    const face = new THREE.Mesh(
      stripGeometry(points, path.width, path.twist),
      materials[path.color],
    );
    const edges = new THREE.Mesh(
      stripGeometry(points, path.width, path.twist, true), edgeMaterial,
    );
    face.castShadow = face.receiveShadow = true;
    edges.castShadow = edges.receiveShadow = true;
    ribbon.add(face, edges);
    group.add(ribbon);
  });
  return group;
}

/**
 * Studio reflections are generated locally, not fetched from an HDR CDN.
 * Caller owns environmentTarget and must dispose it when unmounting.
 */
export function createKineticEnvironment(renderer, theme = "dark") {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(theme === "light" ? "#51433b" : "#292321");
  function softbox(position, size, color, intensity) {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(...size),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      }),
    );
    panel.position.set(...position);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  }
  softbox([-5, 7, 5], [6, 10], "#fff4df", 5);
  softbox([7, 4, 2], [2, 11], "#fff8ee", 7);
  softbox([0, -6, 3], [12, 1.2], "#ffb174", 4);
  softbox([8, 0, -6], [5, 10], "#ff6a1e", theme === "light" ? 2 : 5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentTarget = pmrem.fromScene(studio, 0.035);
  pmrem.dispose();
  studio.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
  return environmentTarget;
}

/** Shared by the procedural exporter and the GLB-backed browser scene. */
export function assembleKineticStage(renderer, theme, sculpture, environment) {
  const p = palettes[theme] ?? palettes.dark;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(p.background);
  scene.environment = environment;
  const camera = new THREE.PerspectiveCamera(
    kineticCamera.fov, 16 / 9, kineticCamera.near, kineticCamera.far,
  );
  camera.position.set(...kineticCamera.position);
  camera.lookAt(...kineticCamera.target);
  scene.add(sculpture);
  scene.add(new THREE.HemisphereLight("#fff2df", "#6b301d", p.fill));
  for (const [position, color, intensity] of [
    [[-4, 7, 8], "#fff0d8", 3.5],
    [[8, 2, 4], "#ffb27b", 2],
    [[3, -4, 5], "#ffffff", 0.7],
  ]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...position);
    scene.add(light);
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = p.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return { scene, camera, sculpture };
}

export function createKineticStage(renderer, theme = "dark") {
  const environmentTarget = createKineticEnvironment(renderer, theme);
  return {
    ...assembleKineticStage(renderer, theme, createKineticSculpture(theme), environmentTarget.texture),
    environmentTarget,
  };
}

export function animateKineticSculpture(sculpture, seconds) {
  // A shared sweep carries the sheets through the softboxes. The nearer cuts
  // lead and the pearl/bronze returns follow, revealing their separate planes.
  // All motion closes in 16 seconds; the original editorial crop stays fixed.
  const phase = sculpturePhase(seconds, 16);
  const sweep = Math.sin(phase);
  const open = 1 - Math.cos(phase);
  sculpture.children.forEach((ribbon, index) => {
    const depth = [0.5, -2.5, -5.0, 5.6][index];
    const lead = [1, -0.55, -0.85, 1.3][index];
    const follow = Math.sin(phase * 2) * 0.16;
    poseSculpturePart(ribbon, [4, 0, depth], [
      0.025 * sweep + 0.009 * lead * open,
      0.105 * sweep + 0.018 * lead * open,
      0.025 * lead * sweep + 0.008 * open,
    ], [
      0.34 * lead * sweep + 0.12 * lead * open,
      0.18 * lead * (sweep + follow),
      0.12 * lead * open,
    ]);
  });
}
