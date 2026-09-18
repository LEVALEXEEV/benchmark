import type { SceneSpec, ObjectSpec, LightSpec } from '../types.js';
import { mulberry32, randRange } from '../prng.js';

const OBJECT_COUNT = 3000;
const SPREAD = 40;
/** размер карты теней directional-света по умолчанию */
const SHADOW_MAP_SIZE = 2048;
const SEED = 42;

const PALETTE = [0xff5c7c, 0x6ec1e4, 0xf5d76e, 0x9b59b6, 0x2ecc71, 0xe67e22];

function buildObjects(count: number): ObjectSpec[] {
  const rng = mulberry32(SEED);
  const objects: ObjectSpec[] = [];

  for (let i = 0; i < count; i++) {
    const colorIndex = Math.floor(rng() * PALETTE.length);
    objects.push({
      id: `obj_${i}`,
      geometry: {
        type: 'torusKnot',
        radius: 0.6,
        tube: 0.22,
        tubularSegments: 128,
        radialSegments: 32,
        p: 2,
        q: 3,
      },
      material: {
        type: 'standard',
        color: PALETTE[colorIndex]!,
        metalness: randRange(rng, 0.2, 0.9),
        roughness: randRange(rng, 0.15, 0.7),
      },
      position: [
        randRange(rng, -SPREAD, SPREAD),
        randRange(rng, 0.5, 12),
        randRange(rng, -SPREAD, SPREAD),
      ],
      rotation: [
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
      ],
      scale: randRange(rng, 0.7, 1.4),
      castShadow: true,
      receiveShadow: true,
    });
  }

  return objects;
}

function lights(shadowMapSize: number): LightSpec[] {
  return [
    { type: 'ambient', color: 0xffffff, intensity: 0.25 },
    {
      type: 'directional',
      color: 0xffffff,
      intensity: 1.2,
      position: [30, 40, 20],
      castShadow: true,
      shadowMapSize,
    },
    {
      type: 'point',
      color: 0xff8866,
      intensity: 80,
      position: [-20, 15, -10],
      distance: 80,
    },
  ];
}

/**
 * S1 — сцена, где кадр определяется стоимостью рендера, а не обновлений.
 *
 * Состояние статично, анимируется только камера: работа фреймворка за кадр
 * близка к нулю. Поэтому S1 служит контрольным условием (различий между
 * реализациями ожидать неоткуда) и опорой для H1.
 *
 * Нагрузка раскладывается по трём осям, каждая регулируется отдельно:
 *   - заливка пикселей — renderScale и размер карты теней (shadowMapSize);
 *   - вершины — detailScale (сегменты TorusKnot);
 *   - число draw calls — count (каждый объект рисуется дважды: тень + кадр).
 * Это нужно, потому что замеры показали: исходная сцена почти не зависит от
 * разрешения, то есть «GPU-bound» в ней означает вершины и draw calls, а не
 * заливку. Точки свипа задаются в harness.
 */
export interface S1Options {
  readonly count?: number;
  readonly shadowMapSize?: number;
}

export function makeS1Scene(opts: S1Options = {}): SceneSpec {
  const count = opts.count ?? OBJECT_COUNT;
  const shadowMapSize = opts.shadowMapSize ?? SHADOW_MAP_SIZE;
  return {
    id: 's1-gpu-bound',
    description: 'Render-dominated static scene with shadows and PBR materials',
    renderer: {
      width: 1280,
      height: 720,
      pixelRatio: 1,
      antialias: true,
      alpha: false,
      toneMapping: 'none',
      outputColorSpace: 'srgb',
      shadowMap: true,
      shadowType: 'pcf',
      clearColor: 0x1a1f2e,
    },
    camera: {
      fov: 50,
      near: 0.1,
      far: 500,
      position: [0, 18, 55],
      lookAt: [0, 6, 0],
      autoRotateSpeed: 0.15,
    },
    lights: lights(shadowMapSize),
    floor: {
      size: 200,
      color: 0x2a3142,
      receiveShadow: true,
    },
    objects: buildObjects(count),
  };
}

export const S1_GPU_BOUND: SceneSpec = makeS1Scene();
