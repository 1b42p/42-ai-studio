import {
  BufferGeometry,
  CubeUVReflectionMapping,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Material,
  Mesh,
  Object3D,
  REVISION,
  RGBAFormat,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { sculptureCompositions, type SculptureComposition } from "./sculpture-config";

export function disposeKineticModel(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

async function fetchAsset(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Kinetic asset unavailable: ${response.status}`);
  return response;
}

async function loadEnvironment(theme: "light" | "dark", signal: AbortSignal) {
  const response = await fetchAsset(`/landing/kinetic-${theme}-pmrem-r180.bin.gz`, signal);
  const payload = await response.arrayBuffer();
  signal.throwIfAborted();
  const signature = new Uint8Array(payload, 0, Math.min(2, payload.byteLength));
  // Static hosts may send Content-Encoding and let fetch decode the same archive.
  const bytes = signature[0] === 0x1f && signature[1] === 0x8b
    ? await new Response(
      new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip"), { signal }),
    ).arrayBuffer()
    : payload;
  signal.throwIfAborted();
  if (bytes.byteLength < 16) throw new Error("Invalid kinetic environment.");
  const header = new DataView(bytes);
  const width = header.getUint32(8, true);
  const height = header.getUint32(12, true);
  if (
    header.getUint32(0, true) !== 0x314d504b ||
    header.getUint32(4, true) !== Number(REVISION) ||
    width !== 768 || height !== 1024 ||
    bytes.byteLength !== 16 + width * height * 8
  ) {
    throw new Error("Incompatible kinetic PMREM. Regenerate it with the installed Three.js.");
  }
  return new Uint16Array(bytes, 16);
}

export async function loadKineticAssets(
  theme: "light" | "dark",
  signal: AbortSignal,
  composition: SculptureComposition = "hero",
) {
  const definition = sculptureCompositions[composition];
  const [modelBytes, environmentPixels] = await Promise.all([
    fetchAsset(`/landing/${definition.asset}-${theme}.glb`, signal).then((response) => response.arrayBuffer()),
    loadEnvironment(theme, signal),
  ]);
  signal.throwIfAborted();
  const model = await new GLTFLoader().parseAsync(modelBytes, "/landing/");
  let environment: DataTexture | undefined;
  try {
    // GLTF parsing is not abortable. A late completion still owns resources to dispose.
    signal.throwIfAborted();
    const sculpture = model.scene.getObjectByName(definition.root);
    // glTF transform nodes are Object3D, not necessarily Three.Group.
    if (
      !(sculpture instanceof Object3D) ||
      sculpture.children.length === 0 ||
      (composition === "hero" && sculpture.children.length !== 4)
    ) {
      throw new Error(`Missing ${definition.root} sculpture hierarchy.`);
    }
    environment = new DataTexture(environmentPixels, 768, 1024, RGBAFormat, HalfFloatType);
    environment.mapping = CubeUVReflectionMapping;
    environment.colorSpace = LinearSRGBColorSpace;
    environment.minFilter = environment.magFilter = LinearFilter;
    environment.generateMipmaps = false;
    environment.flipY = false;
    environment.needsUpdate = true;
    return { model: model.scene, sculpture, environment };
  } catch (error) {
    environment?.dispose();
    disposeKineticModel(model.scene);
    throw error;
  }
}

/** A real task boundary, also cancellable while waiting in a background tab. */
export function kineticYield(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 0);
    signal.addEventListener("abort", abort, { once: true });
  });
}
