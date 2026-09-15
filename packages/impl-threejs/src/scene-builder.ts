import * as THREE from 'three';
import type {
  SceneSpec,
  ObjectSpec,
  LightSpec,
  GeometrySpec,
  MaterialSpec,
} from '@bench/scene-spec';

function makeGeometry(g: GeometrySpec): THREE.BufferGeometry {
  switch (g.type) {
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(
        g.radius,
        g.tube,
        g.tubularSegments,
        g.radialSegments,
        g.p,
        g.q
      );
    case 'box':
      return new THREE.BoxGeometry(g.width, g.height, g.depth);
  }
}

function makeMaterial(m: MaterialSpec): THREE.Material {
  switch (m.type) {
    case 'standard':
      return new THREE.MeshStandardMaterial({
        color: m.color,
        metalness: m.metalness,
        roughness: m.roughness,
      });
    case 'basic':
      return new THREE.MeshBasicMaterial({ color: m.color });
  }
}

function makeObject(spec: ObjectSpec): THREE.Mesh {
  const geom = makeGeometry(spec.geometry);
  const mat = makeMaterial(spec.material);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(...spec.position);
  mesh.rotation.set(...spec.rotation);
  mesh.scale.setScalar(spec.scale);
  mesh.castShadow = spec.castShadow;
  mesh.receiveShadow = spec.receiveShadow;
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
      if (spec.castShadow) {
        l.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
        l.shadow.camera.near = 0.5;
        l.shadow.camera.far = 200;
        const c = l.shadow.camera as THREE.OrthographicCamera;
        c.left = -60;
        c.right = 60;
        c.top = 60;
        c.bottom = -60;
      }
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

export interface AnimatedMesh {
  readonly spec: ObjectSpec;
  readonly mesh: THREE.Mesh;
}

export interface PickableMesh {
  readonly id: string;
  readonly mesh: THREE.Mesh;
}

export interface BuiltScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly animated: readonly AnimatedMesh[];
  /** все меши объектов сцены с их id — цели для raycast (S4) */
  readonly pickables: readonly PickableMesh[];
  readonly disposables: readonly { dispose(): void }[];
}

export function buildScene(spec: SceneSpec, host: HTMLElement): BuiltScene {
  const renderer = new THREE.WebGLRenderer({
    antialias: spec.renderer.antialias,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(spec.renderer.pixelRatio);
  renderer.setSize(spec.renderer.width, spec.renderer.height);
  renderer.setClearColor(spec.renderer.clearColor);
  renderer.shadowMap.enabled = spec.renderer.shadowMap;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(spec.renderer.clearColor);

  const camera = new THREE.PerspectiveCamera(
    spec.camera.fov,
    spec.renderer.width / spec.renderer.height,
    spec.camera.near,
    spec.camera.far
  );
  camera.position.set(...spec.camera.position);
  camera.lookAt(...spec.camera.lookAt);

  for (const light of spec.lights) addLight(scene, light);

  if (spec.floor) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.floor.size, spec.floor.size),
      new THREE.MeshStandardMaterial({ color: spec.floor.color, roughness: 0.9, metalness: 0.0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = spec.floor.receiveShadow;
    scene.add(floor);
  }

  const disposables: { dispose(): void }[] = [];
  const animated: AnimatedMesh[] = [];
  const pickables: PickableMesh[] = [];
  for (const objSpec of spec.objects) {
    const mesh = makeObject(objSpec);
    mesh.userData.id = objSpec.id;
    scene.add(mesh);
    disposables.push(mesh.geometry);
    disposables.push(mesh.material as THREE.Material);
    pickables.push({ id: objSpec.id, mesh });
    if (objSpec.animation) {
      animated.push({ spec: objSpec, mesh });
    }
  }
  disposables.push(renderer);

  return { scene, camera, renderer, animated, pickables, disposables };
}
