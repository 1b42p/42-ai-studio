import React, { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const ease = Easing.inOut(Easing.cubic);
const range = (time, start, end, from, to) => interpolate(time, [start, end], [from, to], {
  extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease,
});

function texture(paint, size = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paint(canvas.getContext("2d"), size);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

function coffeeTexture() {
  return texture((ctx, size) => {
    const c = size / 2;
    const gradient = ctx.createRadialGradient(c * 0.8, c * 0.7, 20, c, c, c);
    gradient.addColorStop(0, "#d49a59");
    gradient.addColorStop(0.7, "#b27539");
    gradient.addColorStop(0.95, "#79421f");
    gradient.addColorStop(1, "#3f2117");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    let seed = 731;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 16000; i++) {
      const x = random() * size;
      const y = random() * size;
      ctx.fillStyle = i % 3 ? `rgba(255,224,174,${random() * 0.22})` : "rgba(73,33,14,0.18)";
      ctx.beginPath();
      ctx.arc(x, y, 0.5 + random() * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.translate(c, c + 45);
    ctx.rotate(-0.15);
    ctx.shadowColor = "#f7e1bc";
    ctx.shadowBlur = 4;
    for (let i = 0; i < 6; i++) {
      const width = 243 - i * 25;
      const y = 130 - i * 55;
      ctx.fillStyle = i % 2 ? "#eedcb9" : "#fff0cf";
      ctx.beginPath();
      ctx.moveTo(0, y + 95);
      ctx.bezierCurveTo(-width * 1.1, y + 10, -width, y - 94, -width * 0.45, y - 35);
      ctx.bezierCurveTo(-width * 0.15, y - 10, -14, y + 12, 0, y + 26);
      ctx.bezierCurveTo(45, y - 28, width * 0.8, y - 76, width, y - 30);
      ctx.bezierCurveTo(width * 1.15, y + 10, width * 0.65, y + 40, 0, y + 95);
      ctx.fill();
    }
    ctx.fillStyle = "#fff0ce";
    ctx.beginPath();
    ctx.moveTo(0, -215);
    ctx.bezierCurveTo(-92, -315, -150, -193, 0, -100);
    ctx.bezierCurveTo(155, -185, 95, -307, 0, -215);
    ctx.fill();
    ctx.strokeStyle = "#ffefd1";
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(10, -265);
    ctx.quadraticCurveTo(-18, 0, 0, 242);
    ctx.stroke();
  });
}

function porcelainTexture() {
  return texture((ctx, size) => {
    ctx.fillStyle = "#eee7d9";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 9000; i++) {
      const x = ((i * 157.83) % size);
      const y = ((i * 73.17) % size);
      ctx.fillStyle = i % 3 ? "rgba(94,67,44,0.10)" : "rgba(255,255,255,0.16)";
      ctx.fillRect(x, y, 1.4, 1.4);
    }
  }, 512);
}

function addMesh(group, geometry, material, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function lathe(points) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 112);
}

function cup(color, map, glaze) {
  const group = new THREE.Group();
  const ceramic = new THREE.MeshPhysicalMaterial({
    color, map: glaze, roughness: 0.22, metalness: 0,
    clearcoat: 0.65, clearcoatRoughness: 0.15, envMapIntensity: 0.9,
  });
  const inner = ceramic.clone();
  inner.color.set("#fff5df");
  addMesh(group, lathe([
    [0, 0.12], [0.53, 0.12], [0.62, 0.18], [0.67, 0.26],
    [0.78, 0.46], [0.91, 0.79], [1.01, 1.16], [1.025, 1.31],
    [1.014, 1.35], [0.974, 1.35], [0.966, 1.30], [0.93, 1.11],
    [0.83, 0.77], [0.70, 0.44], [0.56, 0.26], [0, 0.26],
  ]), ceramic);
  addMesh(group, new THREE.TorusGeometry(0.999, 0.026, 16, 112), inner, [0, 1.33, 0], [Math.PI / 2, 0, 0]);
  const handle = new THREE.CubicBezierCurve3(
    new THREE.Vector3(0.98, 1.19, 0),
    new THREE.Vector3(1.94, 1.55, 0),
    new THREE.Vector3(1.72, 0.26, 0),
    new THREE.Vector3(0.75, 0.41, 0),
  );
  addMesh(group, new THREE.TubeGeometry(handle, 64, 0.085, 16, false), ceramic);
  const saucer = addMesh(group, lathe([
    [0, 0.015], [0.6, 0.015], [0.8, 0.035], [1.32, 0.10], [1.48, 0.18],
    [1.49, 0.22], [1.44, 0.235], [1.15, 0.15], [0.73, 0.105], [0, 0.10],
  ]), ceramic);
  saucer.scale.set(0.88, 1, 0.88);
  const coffee = new THREE.MeshPhysicalMaterial({ map, roughness: 0.4, metalness: 0, clearcoat: 0.2 });
  addMesh(group, new THREE.CircleGeometry(0.969, 112), coffee, [0, 1.294, 0], [-Math.PI / 2, 0, 0]);
  const foot = addMesh(group, new THREE.TorusGeometry(0.55, 0.025, 12, 80), ceramic, [0, 0.13, 0], [Math.PI / 2, 0, 0]);
  foot.receiveShadow = false;
  return group;
}

function steamMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { time: { value: 0 }, strength: { value: 0.16 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float time;
      uniform float strength;
      void main() {
        float y=vUv.y;
        float bend=sin(y*10.-time*1.5)*.10+sin(y*17.+time*.7)*.035;
        float width=.026+y*.13;
        float x=vUv.x-.5-bend;
        float alpha=exp(-x*x/(width*width))*sin(y*3.14159)*strength;
        alpha*=.65+.35*sin(y*25.-time*2.5);
        gl_FragColor=vec4(.95,.86,.71,alpha);
      }
    `,
  });
}

function createWorld() {
  const world = new THREE.Group();
  const coffee = coffeeTexture();
  const glaze = porcelainTexture();
  const first = cup("#fff2d8", coffee, glaze);
  const second = cup("#c57b58", coffee, glaze);
  world.add(first, second);
  const tableMap = texture((ctx, size) => {
    ctx.fillStyle = "#a87956";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 1800; i++) {
      const y = (i * 17.87) % size;
      ctx.strokeStyle = `rgba(67,35,18,${0.025 + (i % 5) * 0.008})`;
      ctx.lineWidth = 0.4 + (i % 4) * 0.3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.3, y + Math.sin(i) * 10, size * 0.7, y - 7, size, y + 3);
      ctx.stroke();
    }
  });
  tableMap.wrapS = tableMap.wrapT = THREE.RepeatWrapping;
  tableMap.repeat.set(20, 20);
  const floor = new THREE.MeshStandardMaterial({ color: "#b18c73", map: tableMap, roughness: 0.92 });
  addMesh(world, new THREE.PlaneGeometry(200, 200), floor, [0, -0.01, 0], [-Math.PI / 2, 0, 0]);
  const metal = new THREE.MeshPhysicalMaterial({ color: "#d5b187", roughness: 0.24, metalness: 0.95 });
  const spoon = new THREE.Group();
  const bowl = addMesh(spoon, new THREE.SphereGeometry(0.18, 24, 16), metal, [0, 0.09, 0]);
  bowl.scale.set(0.8, 0.12, 1.25);
  const stem = addMesh(spoon, new THREE.CapsuleGeometry(0.035, 0.9, 6, 12), metal, [0, 0.075, 0.6], [Math.PI / 2, 0, 0]);
  stem.scale.x = 0.75;
  spoon.position.set(-2.0, 0.01, 0.8);
  spoon.rotation.y = -0.45;
  world.add(spoon);
  const beanMaterial = new THREE.MeshStandardMaterial({ color: "#35190e", roughness: 0.53 });
  for (let i = 0; i < 13; i++) {
    const angle = i * 2.39;
    const radius = 2.0 + (i % 4) * 0.29;
    const bean = addMesh(world, new THREE.SphereGeometry(0.1, 16, 12), beanMaterial,
      [Math.cos(angle) * radius, 0.06, Math.sin(angle) * radius - 0.4]);
    bean.scale.set(0.8, 0.62, 1.35);
    bean.rotation.y = angle;
  }
  const steam = [];
  for (const owner of [first, second]) {
    for (let i = 0; i < 3; i++) {
      const material = steamMaterial();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.3), material);
      mesh.position.set((i - 1) * 0.24, 2.3, (i - 1) * 0.12);
      owner.add(mesh);
      steam.push(mesh);
    }
  }
  const key = new THREE.DirectionalLight("#ffe2bb", 4.5);
  key.position.set(-4, 7, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 22 });
  key.shadow.normalBias = 0.018;
  key.shadow.bias = -0.0001;
  world.add(key);
  const fill = new THREE.DirectionalLight("#e3e9ff", 1.3);
  fill.position.set(4, 4, 5);
  world.add(fill);
  const rim = new THREE.DirectionalLight("#ffb76d", 2.0);
  rim.position.set(1, 4, -5);
  world.add(rim);
  world.add(new THREE.HemisphereLight("#f9e8d2", "#29180e", 1.0));
  const shade = new THREE.MeshBasicMaterial({
    color: "#321e18", transparent: true, opacity: 0.12, depthWrite: false,
  });
  for (let i = 0; i < 9; i++) {
    const slat = addMesh(world, new THREE.PlaneGeometry(0.35, 200), shade,
      [-9 + i * 2.15, 0.003, 0], [-Math.PI / 2, 0, -0.55]);
    slat.castShadow = false;
  }
  return { world, first, second, steam, coffee, glaze, tableMap };
}

function World() {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const { camera, gl, scene } = useThree();
  const objects = useMemo(createWorld, []);
  const environment = useMemo(() => {
    const generator = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = generator.fromScene(room, 0.05);
    room.dispose();
    generator.dispose();
    return target;
  }, [gl]);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.5;
  scene.background = new THREE.Color("#41251b");
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 0.85;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;

  const pair = range(t, 3.6, 5.6, 0, 1);
  objects.first.position.set(-1.28 * pair, 0, 0.30 * pair);
  objects.first.rotation.y = -0.55 + 0.1 * Math.sin(t * 0.18);
  objects.second.position.set(range(t, 4.0, 6.3, 5.1, 1.28), 0, -0.55);
  objects.second.rotation.y = 2.8 + range(t, 4.0, 6.3, -0.6, 0);
  objects.second.visible = t > 3.8;
  for (const [index, steam] of objects.steam.entries()) {
    steam.material.uniforms.time.value = t + index * 1.2;
    steam.quaternion.copy(camera.quaternion);
  }
  let position;
  let target;
  if (t < 3.8) {
    position = [range(t, 0, 3.8, 0.35, -0.5), range(t, 0, 3.8, 5.6, 4.6), range(t, 0, 3.8, 3.7, 5.5)];
    target = [0, 1.55, 0];
  } else if (t < 9.0) {
    position = [range(t, 3.8, 9.0, -1.4, 0.9), range(t, 3.8, 6.3, 5.1, 7.8), range(t, 3.8, 6.3, 6.6, 10.6)];
    target = [0.1, 1.6, 0];
  } else if (t < 12.0) {
    position = [range(t, 9, 12, -1.4, -0.2), 12.0, range(t, 9, 12, 1.6, 3.2)];
    target = [0, 1.6, 0];
  } else {
    position = [range(t, 12, 20.5, -2.2, 2.0), range(t, 12, 20.5, 7.4, 6.8), 11.0];
    target = [0, 1.65, 0];
  }
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.fov = 38;
  camera.updateProjectionMatrix();
  useEffect(() => () => {
    const geometries = new Set();
    const materials = new Set();
    objects.world.traverse((node) => {
      if (node.geometry) geometries.add(node.geometry);
      if (node.material) materials.add(node.material);
      if (node.isLight && node.shadow) node.shadow.dispose();
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    objects.coffee.dispose();
    objects.glaze.dispose();
    objects.tableMap.dispose();
    environment.dispose();
  }, [objects, environment]);
  return <primitive object={objects.world} dispose={null} />;
}

export function CoffeeScene() {
  const { width, height } = useVideoConfig();
  return (
    <ThreeCanvas
      width={width}
      height={height}
      shadows
      camera={{ fov: 38, near: 0.1, far: 220, position: [0, 5, 6] }}
      gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      <World />
    </ThreeCanvas>
  );
}
