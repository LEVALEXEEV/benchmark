import type {
  Camera,
  Color,
  Light,
  Material,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';

/**
 * Снимок паритета: всё, что должно совпадать у реализаций при одинаковой
 * спецификации и одинаковом t. harness сравнивает снимки всех вариантов с
 * three.js ДО замеров и прерывает серию при расхождении.
 *
 * Зачем: в НИР2 R3F незаметно рендерил другую сцену (ACES tone mapping,
 * камера смотрела в (0,0,0) вместо lookAt из спецификации).
 * Такие расхождения ловятся только автоматической проверкой.
 */
export interface ParitySnapshot {
  readonly kind: 'parity';
  readonly renderer: {
    readonly calls: number;
    readonly triangles: number;
    readonly geometries: number;
    readonly textures: number;
    readonly programs: number;
    readonly pixelRatio: number;
    readonly clearAlpha: number;
    readonly toneMapping: number;
    readonly outputColorSpace: string;
    readonly shadowMapEnabled: boolean;
    readonly shadowMapType: number;
    readonly contextAttributes: WebGLContextAttributes | null;
    readonly drawingBuffer: readonly [number, number];
    readonly canvasCss: readonly [number, number];
  };
  readonly camera: string;
  readonly background: string;
  readonly typeCounts: Readonly<Record<string, number>>;
  readonly lights: readonly string[];
  readonly meshCount: number;
  readonly meshDigest: string;
  /** отсортированные дескрипторы мешей — для диагностики расхождений */
  readonly meshes: readonly string[];
  readonly image: {
    readonly width: number;
    readonly height: number;
    readonly hash: string;
    readonly block: number;
    /** средние RGB блоков block×block, base64 */
    readonly blocksB64: string;
  };
}

function r(x: number, digits = 5): string {
  const s = x.toFixed(digits);
  // -0.00000 и 0.00000 — одно и то же значение
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

function hex(c: Color | undefined): string {
  return c ? c.getHexString() : '-';
}

function mat(m: readonly number[], digits: number): string {
  return m.map((x) => r(x, digits)).join(',');
}

export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fnv1aBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function describeMaterial(m: Material): string {
  const a = m as Material & {
    color?: Color;
    emissive?: Color;
    metalness?: number;
    roughness?: number;
    wireframe?: boolean;
    flatShading?: boolean;
  };
  return [
    m.type,
    hex(a.color),
    hex(a.emissive),
    a.metalness === undefined ? '-' : r(a.metalness),
    a.roughness === undefined ? '-' : r(a.roughness),
    m.side,
    m.transparent,
    r(m.opacity),
    m.toneMapped,
    m.depthTest,
    m.depthWrite,
    m.vertexColors,
    a.wireframe ?? '-',
    a.flatShading ?? '-',
  ].join('/');
}

function describeMesh(mesh: Mesh): string {
  const g = mesh.geometry as Mesh['geometry'] & { parameters?: Record<string, number> };
  const params = g.parameters
    ? Object.entries(g.parameters)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? r(v) : String(v)}`)
        .join(';')
    : '';
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return [
    g.type,
    params,
    g.attributes.position?.count ?? 0,
    g.index?.count ?? 0,
    materials.map(describeMaterial).join('+'),
    mat(mesh.matrixWorld.elements, 4),
    mesh.castShadow,
    mesh.receiveShadow,
    mesh.visible,
    mesh.frustumCulled,
    mesh.renderOrder,
    mesh.layers.mask,
  ].join('|');
}

function describeLight(light: Light): string {
  const l = light as Light & {
    distance?: number;
    decay?: number;
    castShadow: boolean;
    shadow?: {
      mapSize: { x: number; y: number };
      bias: number;
      normalBias: number;
      radius: number;
      camera: Camera & Record<string, number>;
    };
    target?: Object3D;
  };
  const wp = l.getWorldPosition(l.position.clone());
  const parts: string[] = [
    l.type,
    hex(l.color),
    r(l.intensity),
    `${r(wp.x)},${r(wp.y)},${r(wp.z)}`,
    String(l.castShadow),
    l.distance === undefined ? '-' : r(l.distance),
    l.decay === undefined ? '-' : r(l.decay),
  ];
  if (l.castShadow && l.shadow) {
    const c = l.shadow.camera;
    parts.push(
      `map=${l.shadow.mapSize.x}x${l.shadow.mapSize.y}`,
      `bias=${r(l.shadow.bias)},${r(l.shadow.normalBias)},${r(l.shadow.radius)}`,
      ['left', 'right', 'top', 'bottom', 'near', 'far']
        .map((k) => (typeof c[k] === 'number' ? r(c[k]) : '-'))
        .join(',')
    );
  }
  if (l.target) {
    const tp = l.target.getWorldPosition(l.position.clone());
    parts.push(`target=${r(tp.x)},${r(tp.y)},${r(tp.z)}`);
  }
  return parts.join('|');
}

function describeCamera(camera: Camera): string {
  const c = camera as PerspectiveCamera;
  return [
    camera.type,
    r(c.fov ?? NaN),
    r(c.aspect ?? NaN),
    r(c.near ?? NaN),
    r(c.far ?? NaN),
    r(c.zoom ?? NaN),
    mat(camera.matrixWorld.elements, 4),
    mat(camera.projectionMatrix.elements, 5),
  ].join('|');
}

const BLOCK = 8;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Должен вызываться сразу после renderer.render() в том же таске: без
 * preserveDrawingBuffer буфер кадра читаем только до композитинга.
 */
export function takeParitySnapshot(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera
): ParitySnapshot {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

  const bw = Math.floor(w / BLOCK);
  const bh = Math.floor(h / BLOCK);
  const blocks = new Uint8Array(bw * bh * 3);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
        for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
          const i = (y * w + x) * 4;
          sr += px[i]!;
          sg += px[i + 1]!;
          sb += px[i + 2]!;
        }
      }
      const o = (by * bw + bx) * 3;
      const n = BLOCK * BLOCK;
      blocks[o] = Math.round(sr / n);
      blocks[o + 1] = Math.round(sg / n);
      blocks[o + 2] = Math.round(sb / n);
    }
  }

  const typeCounts: Record<string, number> = {};
  const meshes: string[] = [];
  const lights: string[] = [];
  scene.traverse((obj) => {
    typeCounts[obj.type] = (typeCounts[obj.type] ?? 0) + 1;
    if ((obj as Mesh).isMesh) meshes.push(describeMesh(obj as Mesh));
    if ((obj as Light).isLight) lights.push(describeLight(obj as Light));
  });
  meshes.sort();
  lights.sort();

  const bg = scene.background as Color | null;
  const canvas = renderer.domElement;
  const info = renderer.info;
  return {
    kind: 'parity',
    renderer: {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? -1,
      pixelRatio: renderer.getPixelRatio(),
      clearAlpha: renderer.getClearAlpha(),
      toneMapping: renderer.toneMapping,
      outputColorSpace: renderer.outputColorSpace,
      shadowMapEnabled: renderer.shadowMap.enabled,
      shadowMapType: renderer.shadowMap.type,
      contextAttributes: gl.getContextAttributes(),
      drawingBuffer: [w, h],
      canvasCss: [canvas.clientWidth, canvas.clientHeight],
    },
    camera: describeCamera(camera),
    background: bg && (bg as Color).isColor ? bg.getHexString() : String(bg),
    typeCounts,
    lights,
    meshCount: meshes.length,
    meshDigest: fnv1a(meshes.join('\n')),
    meshes,
    image: { width: w, height: h, hash: fnv1aBytes(px), block: BLOCK, blocksB64: toBase64(blocks) },
  };
}

export function countMeshes(scene: Object3D): number {
  let n = 0;
  scene.traverse((o) => {
    if ((o as Mesh).isMesh) n++;
  });
  return n;
}

export interface ParityTarget {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: Camera;
}

/** кадров до готовности: даёт R3F-state применить setState, а шейдерам — скомпилироваться */
const PARITY_MIN_FRAMES = 30;

/**
 * Режим паритета, общий для обеих реализаций: замеры не ведутся; когда сцена
 * полна и отрисовано PARITY_MIN_FRAMES кадров, статус становится
 * 'parity-ready', и harness может запросить снимок через __BENCH_CTRL__.
 */
export function enableParityMode(
  runtime: {
    addProbe(p: { endRender?(now: number): void }): () => void;
    setStatus(s: 'parity-ready'): void;
    afterNextRender(cb: (now: number) => void): void;
    setControl(c: { snapshot: () => Promise<unknown> }): void;
  },
  getTarget: () => ParityTarget | null,
  isComplete: () => boolean
): void {
  let frames = 0;
  let ready = false;
  runtime.addProbe({
    endRender() {
      if (ready) return;
      frames++;
      if (frames >= PARITY_MIN_FRAMES && isComplete()) {
        ready = true;
        runtime.setStatus('parity-ready');
      }
    },
  });
  runtime.setControl({
    snapshot: () =>
      new Promise((resolve, reject) => {
        runtime.afterNextRender(() => {
          const t = getTarget();
          if (!t) return reject(new Error('parity: рендерер ещё не создан'));
          try {
            resolve(takeParitySnapshot(t.renderer, t.scene, t.camera));
          } catch (e) {
            reject(e);
          }
        });
      }),
  });
}
