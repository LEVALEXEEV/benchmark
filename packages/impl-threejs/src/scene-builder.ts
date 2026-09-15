import * as THREE from 'three';
import type {
  CameraSpec,
  GeometrySpec,
  LightSpec,
  MaterialSpec,
  ObjectSpec,
  SceneSpec,
} from '@bench/scene-spec';

function makeGeometry(g: GeometrySpec): THREE.BufferGeometry {
  switch (g.type) {
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(g.radius, g.tube, g.tubularSegments, g.radialSegments, g.p, g.q);
    case 'box':
      return new THREE.BoxGeometry(g.width, g.height, g.depth);
  }
}

function makeMaterial(m: MaterialSpec): THREE.Material {
  switch (m.type) {
    case 'standard':
      return new THREE.MeshStandardMaterial({ color: m.color, metalness: m.metalness, roughness: m.roughness });
    case 'basic':
      return new THREE.MeshBasicMaterial({ color: m.color });
  }
}

function makeObject(spec: ObjectSpec): THREE.Mesh {
  const mesh = new THREE.Mesh(makeGeometry(spec.geometry), makeMaterial(spec.material));
  mesh.position.set(...spec.position);
  mesh.rotation.set(...spec.rotation);
  mesh.scale.setScalar(spec.scale);
  mesh.castShadow = spec.castShadow;
  mesh.receiveShadow = spec.receiveShadow;
  mesh.userData.id = spec.id;
  return mesh;
}

function addLight(scene: THREE.Scene, spec: LightSpec): void {
  switch (spec.type) {
    case 'ambient':
      scene.add(new THREE.AmbientLight(spec.color, spec.intensity));
      return;
    case 'directional': {
      const l = new THREE.DirectionalLight(spec.color, spec.intensity);
      l.position.set(...spec.position);
      l.castShadow = spec.castShadow;
      l.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
      const c = l.shadow.camera;
      c.near = 0.5;
      c.far = 200;
      c.left = -60;
      c.right = 60;
      c.top = 60;
      c.bottom = -60;
      scene.add(l);
      return;
    }
    case 'point': {
      const l = new THREE.PointLight(spec.color, spec.intensity, spec.distance);
      l.position.set(...spec.position);
      scene.add(l);
      return;
    }
  }
}

/**
 * Рендерер с явными параметрами из спецификации. Значения совпадают с тем,
 * что R3F-реализация передаёт в <Canvas> (flat, alpha:false, shadows:'percentage'),
 * и проверяются снимком паритета.
 */
export function createRenderer(spec: SceneSpec, renderScale: number, host: HTMLElement): THREE.WebGLRenderer {
  const r = spec.renderer;
  const renderer = new THREE.WebGLRenderer({
    antialias: r.antialias,
    alpha: r.alpha,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(r.pixelRatio * renderScale);
  renderer.setSize(r.width, r.height);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = r.shadowMap;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  host.appendChild(renderer.domElement);
  return renderer;
}

export function createCamera(spec: SceneSpec): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    spec.camera.fov,
    spec.renderer.width / spec.renderer.height,
    spec.camera.near,
    spec.camera.far
  );
  applyCameraSpec(camera, spec.camera);
  return camera;
}

export function applyCameraSpec(camera: THREE.PerspectiveCamera, cam: CameraSpec): void {
  camera.near = cam.near;
  camera.far = cam.far;
  camera.fov = cam.fov;
  camera.position.set(...cam.position);
  camera.lookAt(...cam.lookAt);
  camera.updateProjectionMatrix();
}

export interface AnimatedMesh {
  readonly spec: ObjectSpec;
  readonly mesh: THREE.Mesh;
}

export interface BuiltContent {
  readonly scene: THREE.Scene;
  readonly animated: readonly AnimatedMesh[];
  /** меши объектов спецификации — цели raycast (S4) */
  readonly meshes: readonly THREE.Mesh[];
  dispose(): void;
}

/** содержимое сцены отдельно от рендерера — S5 меняет его, не пересоздавая контекст */
export function buildContent(spec: SceneSpec): BuiltContent {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(spec.renderer.clearColor);
  for (const light of spec.lights) addLight(scene, light);

  const disposables: { dispose(): void }[] = [];
  if (spec.floor) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.floor.size, spec.floor.size),
      new THREE.MeshStandardMaterial({ color: spec.floor.color, roughness: 0.9, metalness: 0.0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = spec.floor.receiveShadow;
    scene.add(floor);
    disposables.push(floor.geometry, floor.material);
  }

  const animated: AnimatedMesh[] = [];
  const meshes: THREE.Mesh[] = [];
  for (const objSpec of spec.objects) {
    const mesh = makeObject(objSpec);
    scene.add(mesh);
    disposables.push(mesh.geometry, mesh.material as THREE.Material);
    meshes.push(mesh);
    if (objSpec.animation) animated.push({ spec: objSpec, mesh });
  }

  return {
    scene,
    animated,
    meshes,
    dispose() {
      for (const d of disposables) d.dispose();
      scene.clear();
    },
  };
}
